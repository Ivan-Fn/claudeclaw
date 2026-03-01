import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { PROJECT_ROOT, CLAUDE_SYSTEM_PROMPT_APPEND, MAX_TURNS, AGENT_TIMEOUT_MS } from './config.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';

// ── Types ──────────────────────────────────────────────────────────────

export interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  totalCostUsd: number;
  /** True if the SDK auto-compacted context during this turn */
  didCompact: boolean;
  /** Token count before compaction (if it happened) */
  preCompactTokens: number | null;
  /**
   * The cache_read_input_tokens from the LAST API call in the turn.
   * Unlike the cumulative cacheReadInputTokens, this reflects the actual
   * context window size (cumulative overcounts on multi-step tool-use turns).
   */
  lastCallCacheRead: number;
}

export interface AgentResult {
  text: string;
  sessionId: string | undefined;
  costUsd: number;
  durationMs: number;
  numTurns: number;
  usage: UsageInfo | null;
  error?: string;
}

export interface RunAgentOptions {
  message: string;
  sessionId?: string;
  onTyping?: () => void;
  abortSignal?: AbortSignal;
  /** Extra environment variables passed to the Claude Code subprocess. */
  env?: Record<string, string>;
}

// ── Run Agent ──────────────────────────────────────────────────────────

export async function runAgent(opts: RunAgentOptions): Promise<AgentResult> {
  const { message, sessionId, onTyping, abortSignal, env: extraEnv } = opts;
  const startTime = Date.now();

  const abortController = new AbortController();

  // Link external signal to our controller
  const onAbort = () => abortController.abort();
  if (abortSignal) {
    if (abortSignal.aborted) {
      return {
        text: 'Request was cancelled.',
        sessionId,
        costUsd: 0,
        durationMs: 0,
        numTurns: 0,
        usage: null,
        error: 'cancelled',
      };
    }
    abortSignal.addEventListener('abort', onAbort, { once: true });
  }

  // Timeout
  const timeout = setTimeout(() => abortController.abort(), AGENT_TIMEOUT_MS);

  let resolvedSessionId: string | undefined = sessionId;
  let resultText = '';
  let costUsd = 0;
  let numTurns = 0;
  let error: string | undefined;

  // Usage tracking
  let didCompact = false;
  let preCompactTokens: number | null = null;
  let lastCallCacheRead = 0;
  let usage: UsageInfo | null = null;

  try {
    // Read secrets from .env without polluting process.env.
    // Pass them to the SDK subprocess via the env option.
    const env = readEnvFile();
    const sdkEnv: Record<string, string | undefined> = { ...process.env };
    if (env['CLAUDE_CODE_OAUTH_TOKEN']) {
      sdkEnv['CLAUDE_CODE_OAUTH_TOKEN'] = env['CLAUDE_CODE_OAUTH_TOKEN'];
    }
    if (env['ANTHROPIC_API_KEY']) {
      sdkEnv['ANTHROPIC_API_KEY'] = env['ANTHROPIC_API_KEY'];
    }
    if (extraEnv) {
      Object.assign(sdkEnv, extraEnv);
    }

    const systemPrompt = CLAUDE_SYSTEM_PROMPT_APPEND
      ? { type: 'preset' as const, preset: 'claude_code' as const, append: CLAUDE_SYSTEM_PROMPT_APPEND }
      : { type: 'preset' as const, preset: 'claude_code' as const };

    const resumeOpts = sessionId ? { resume: sessionId } : {};

    const q = query({
      prompt: message,
      options: {
        cwd: PROJECT_ROOT,
        ...resumeOpts,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: ['user', 'project'],
        systemPrompt,
        maxTurns: MAX_TURNS,
        abortController,
        env: sdkEnv,
      },
    });

    for await (const msg of q) {
      onTyping?.();

      handleMessage(msg, {
        setSessionId: (id) => { resolvedSessionId = id; },
        setResult: (text, cost, turns) => {
          resultText = text;
          costUsd = cost;
          numTurns = turns;
        },
        setError: (err) => { error = err; },
        onCompact: (tokens) => {
          didCompact = true;
          preCompactTokens = tokens;
        },
        onCacheRead: (tokens) => {
          lastCallCacheRead = tokens;
        },
        setUsage: (u) => { usage = u; },
      }, { didCompact, preCompactTokens, lastCallCacheRead });
    }
  } catch (err) {
    if (abortController.signal.aborted) {
      const reason = abortSignal?.aborted ? 'cancelled' : 'timeout';
      const friendlyMsg = reason === 'cancelled'
        ? 'Request was cancelled.'
        : `Agent timed out after ${Math.round(AGENT_TIMEOUT_MS / 1000)}s.`;
      error = reason;
      if (!resultText) resultText = friendlyMsg;
    } else {
      logger.error({ err }, 'Agent query threw unexpectedly');
      error = err instanceof Error ? err.message : String(err);
      if (!resultText) resultText = 'An internal error occurred. Please try again.';
    }
  } finally {
    clearTimeout(timeout);
    abortSignal?.removeEventListener('abort', onAbort);
  }

  const durationMs = Date.now() - startTime;

  logger.info({
    sessionId: resolvedSessionId,
    costUsd,
    numTurns,
    durationMs,
    error,
    didCompact,
    lastCallCacheRead,
  }, 'Agent query completed');

  const result: AgentResult = {
    text: resultText || 'No response from agent.',
    sessionId: resolvedSessionId,
    costUsd,
    durationMs,
    numTurns,
    usage,
  };
  if (error !== undefined) result.error = error;
  return result;
}

// ── Message Handler ────────────────────────────────────────────────────

interface MessageHandlers {
  setSessionId: (id: string) => void;
  setResult: (text: string, cost: number, turns: number) => void;
  setError: (error: string) => void;
  onCompact: (preTokens: number | null) => void;
  onCacheRead: (tokens: number) => void;
  setUsage: (usage: UsageInfo) => void;
}

interface UsageState {
  didCompact: boolean;
  preCompactTokens: number | null;
  lastCallCacheRead: number;
}

function handleMessage(msg: SDKMessage, handlers: MessageHandlers, usageState: UsageState): void {
  const ev = msg as Record<string, unknown>;

  switch (msg.type) {
    case 'system':
      if (msg.subtype === 'init') {
        handlers.setSessionId(msg.session_id);
        logger.debug({
          sessionId: msg.session_id,
          model: msg.model,
          tools: msg.tools.length,
        }, 'Agent session initialized');
      }
      // Detect auto-compaction (context window was getting full)
      if (ev['subtype'] === 'compact_boundary') {
        const meta = ev['compact_metadata'] as { trigger: string; pre_tokens: number } | undefined;
        handlers.onCompact(meta?.pre_tokens ?? null);
        logger.warn(
          { trigger: meta?.trigger, preCompactTokens: meta?.pre_tokens },
          'Context window compacted',
        );
      }
      break;

    case 'result':
      if (msg.subtype === 'success') {
        handlers.setResult(msg.result, msg.total_cost_usd, msg.num_turns);
      } else {
        const errorMsg = formatResultError(msg.subtype, 'errors' in msg ? msg.errors : []);
        handlers.setError(msg.subtype);
        handlers.setResult(errorMsg, msg.total_cost_usd, msg.num_turns);
      }

      // Extract usage info from result event
      const evUsage = ev['usage'] as Record<string, number> | undefined;
      if (evUsage) {
        handlers.setUsage({
          inputTokens: evUsage['input_tokens'] ?? 0,
          outputTokens: evUsage['output_tokens'] ?? 0,
          cacheReadInputTokens: evUsage['cache_read_input_tokens'] ?? 0,
          totalCostUsd: (ev['total_cost_usd'] as number) ?? 0,
          didCompact: usageState.didCompact,
          preCompactTokens: usageState.preCompactTokens,
          lastCallCacheRead: usageState.lastCallCacheRead,
        });
      }
      break;

    case 'assistant':
      if (msg.error) {
        logger.warn({ error: msg.error }, 'Assistant message error');
        handleAssistantError(msg.error, handlers);
      }
      // Track per-call cache reads from assistant message events.
      // Each assistant message represents one API call; its usage reflects
      // that single call's context size (not cumulative across the turn).
      {
        const msgUsage = (ev['message'] as Record<string, unknown>)?.['usage'] as Record<string, number> | undefined;
        const callCacheRead = msgUsage?.['cache_read_input_tokens'] ?? 0;
        if (callCacheRead > 0) {
          handlers.onCacheRead(callCacheRead);
        }
      }
      break;

    case 'auth_status':
      if (msg.error) {
        logger.error({ error: msg.error }, 'Authentication error');
        handlers.setError(`auth: ${msg.error}`);
      }
      break;

    default:
      break;
  }
}

function formatResultError(subtype: string, errors: string[]): string {
  switch (subtype) {
    case 'error_max_turns':
      return 'Task was too complex and reached the turn limit. Try breaking it into smaller steps.';
    case 'error_max_budget_usd':
      return 'Budget limit reached for this query.';
    case 'error_during_execution':
      return errors.length > 0
        ? `Errors during execution:\n${errors.join('\n')}`
        : 'An error occurred during execution.';
    case 'error_max_structured_output_retries':
      return 'Failed to produce structured output after maximum retries.';
    default:
      return `Agent error: ${subtype}`;
  }
}

function handleAssistantError(
  error: string,
  handlers: MessageHandlers,
): void {
  switch (error) {
    case 'authentication_failed':
      handlers.setError('authentication_failed');
      break;
    case 'rate_limit':
      logger.warn('Rate limited by Claude API');
      break;
    case 'billing_error':
      handlers.setError('billing_error');
      break;
    case 'server_error':
      logger.warn('Claude API server error');
      break;
    case 'max_output_tokens':
      logger.debug('Max output tokens reached (response may be truncated)');
      break;
    default:
      logger.warn({ error }, 'Unknown assistant error');
      break;
  }
}
