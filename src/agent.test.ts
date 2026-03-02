import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the SDK before importing agent
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

// Mock config to avoid reading .env
vi.mock('./config.js', () => ({
  PROJECT_ROOT: '/tmp/test',
  AGENT_CWD: '/tmp/test',
  CLAUDE_SYSTEM_PROMPT_APPEND: '',
  MAX_TURNS: 50,
  AGENT_TIMEOUT_MS: 5000,
  AGENT_DAILY_COST_LIMIT_USD: 0,
}));

// Mock env to avoid reading .env file
vi.mock('./env.js', () => ({
  readEnvFile: () => ({}),
  PROJECT_ROOT: '/tmp/test',
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { runAgent } from './agent.js';
import { query } from '@anthropic-ai/claude-agent-sdk';

const mockQuery = vi.mocked(query);

function createMockMessages(messages: Array<Record<string, unknown>>) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const msg of messages) {
        yield msg;
      }
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runAgent', () => {
  it('returns result on success', async () => {
    mockQuery.mockReturnValue(createMockMessages([
      {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-123',
        model: 'claude-sonnet',
        tools: ['read', 'write'],
      },
      {
        type: 'result',
        subtype: 'success',
        result: 'Hello from Claude',
        total_cost_usd: 0.005,
        num_turns: 2,
      },
    ]) as ReturnType<typeof query>);

    const result = await runAgent({ message: 'Hello' });

    expect(result.text).toBe('Hello from Claude');
    expect(result.sessionId).toBe('sess-123');
    expect(result.costUsd).toBe(0.005);
    expect(result.numTurns).toBe(2);
    expect(result.error).toBeUndefined();
  });

  it('resumes session when sessionId provided', async () => {
    mockQuery.mockReturnValue(createMockMessages([
      { type: 'system', subtype: 'init', session_id: 'sess-456', model: 'claude', tools: [] },
      { type: 'result', subtype: 'success', result: 'OK', total_cost_usd: 0, num_turns: 1 },
    ]) as ReturnType<typeof query>);

    await runAgent({ message: 'Follow up', sessionId: 'sess-existing' });

    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ resume: 'sess-existing' }),
      }),
    );
  });

  it('handles error_max_turns', async () => {
    mockQuery.mockReturnValue(createMockMessages([
      { type: 'system', subtype: 'init', session_id: 's1', model: 'claude', tools: [] },
      {
        type: 'result',
        subtype: 'error_max_turns',
        errors: [],
        total_cost_usd: 0.1,
        num_turns: 50,
      },
    ]) as ReturnType<typeof query>);

    const result = await runAgent({ message: 'Complex task' });

    expect(result.error).toBe('error_max_turns');
    expect(result.text).toContain('turn limit');
  });

  it('handles error_during_execution', async () => {
    mockQuery.mockReturnValue(createMockMessages([
      { type: 'system', subtype: 'init', session_id: 's1', model: 'claude', tools: [] },
      {
        type: 'result',
        subtype: 'error_during_execution',
        errors: ['File not found', 'Permission denied'],
        total_cost_usd: 0.01,
        num_turns: 3,
      },
    ]) as ReturnType<typeof query>);

    const result = await runAgent({ message: 'Failing task' });

    expect(result.error).toBe('error_during_execution');
    expect(result.text).toContain('File not found');
    expect(result.text).toContain('Permission denied');
  });

  it('handles error_max_budget_usd', async () => {
    mockQuery.mockReturnValue(createMockMessages([
      { type: 'system', subtype: 'init', session_id: 's1', model: 'claude', tools: [] },
      {
        type: 'result',
        subtype: 'error_max_budget_usd',
        errors: [],
        total_cost_usd: 5.0,
        num_turns: 10,
      },
    ]) as ReturnType<typeof query>);

    const result = await runAgent({ message: 'Expensive task' });

    expect(result.error).toBe('error_max_budget_usd');
    expect(result.text).toContain('Budget limit');
  });

  it('handles authentication_failed assistant error', async () => {
    mockQuery.mockReturnValue(createMockMessages([
      { type: 'system', subtype: 'init', session_id: 's1', model: 'claude', tools: [] },
      { type: 'assistant', error: 'authentication_failed', message: {}, parent_tool_use_id: null },
      { type: 'result', subtype: 'success', result: '', total_cost_usd: 0, num_turns: 0 },
    ]) as ReturnType<typeof query>);

    const result = await runAgent({ message: 'test' });

    expect(result.error).toBe('authentication_failed');
  });

  it('handles auth_status error', async () => {
    mockQuery.mockReturnValue(createMockMessages([
      { type: 'auth_status', error: 'Token expired', isAuthenticating: false, output: [] },
      { type: 'result', subtype: 'success', result: '', total_cost_usd: 0, num_turns: 0 },
    ]) as ReturnType<typeof query>);

    const result = await runAgent({ message: 'test' });

    expect(result.error).toContain('auth');
  });

  it('returns cancelled when abortSignal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await runAgent({
      message: 'test',
      abortSignal: controller.signal,
    });

    expect(result.error).toBe('cancelled');
    expect(result.text).toContain('cancelled');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('returns timeout when agent takes too long', async () => {
    // Create a generator that respects abort (like the real SDK does)
    mockQuery.mockImplementation((params: { options?: { abortController?: AbortController } }) => {
      const ac = params.options?.abortController;
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'system', subtype: 'init', session_id: 's1', model: 'claude', tools: [] };
          // Wait for abort signal (timeout will fire at 5s)
          await new Promise<void>((resolve, reject) => {
            if (ac?.signal.aborted) { reject(new Error('aborted')); return; }
            ac?.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          });
        },
      } as ReturnType<typeof query>;
    });

    const result = await runAgent({ message: 'slow task' });

    expect(result.error).toBe('timeout');
    expect(result.text).toContain('timed out');
  }, 10_000);

  it('returns default text when no result message received', async () => {
    mockQuery.mockReturnValue(createMockMessages([
      { type: 'system', subtype: 'init', session_id: 's1', model: 'claude', tools: [] },
    ]) as ReturnType<typeof query>);

    const result = await runAgent({ message: 'test' });

    expect(result.text).toBe('No response from agent.');
  });

  it('calls onTyping callback for each message', async () => {
    const onTyping = vi.fn();

    mockQuery.mockReturnValue(createMockMessages([
      { type: 'system', subtype: 'init', session_id: 's1', model: 'claude', tools: [] },
      { type: 'assistant', message: {}, parent_tool_use_id: null },
      { type: 'result', subtype: 'success', result: 'Done', total_cost_usd: 0, num_turns: 1 },
    ]) as ReturnType<typeof query>);

    await runAgent({ message: 'test', onTyping });

    expect(onTyping).toHaveBeenCalledTimes(3);
  });

  it('measures duration', async () => {
    mockQuery.mockReturnValue(createMockMessages([
      { type: 'system', subtype: 'init', session_id: 's1', model: 'claude', tools: [] },
      { type: 'result', subtype: 'success', result: 'Done', total_cost_usd: 0, num_turns: 1 },
    ]) as ReturnType<typeof query>);

    const result = await runAgent({ message: 'test' });

    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});
