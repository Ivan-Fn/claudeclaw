import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config.js', () => ({
  N8N_BASE_URL: 'http://localhost:5678',
  N8N_API_KEY: 'test-key',
}));

vi.mock('../logger.js', () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { callN8nWebhook, formatN8nResult, isN8nConfigured, sanitizeWebhookPath } from './n8n.js';

// ── isN8nConfigured ────────────────────────────────────────────────────

describe('isN8nConfigured', () => {
  it('returns true when N8N_BASE_URL is set', () => {
    expect(isN8nConfigured()).toBe(true);
  });
});

// ── sanitizeWebhookPath ────────────────────────────────────────────────

describe('sanitizeWebhookPath', () => {
  it('allows simple paths', () => {
    expect(sanitizeWebhookPath('gmail')).toBe('gmail');
  });

  it('allows multi-segment paths', () => {
    expect(sanitizeWebhookPath('gmail/filter')).toBe('gmail/filter');
  });

  it('allows hyphens and underscores', () => {
    expect(sanitizeWebhookPath('notion-tasks')).toBe('notion-tasks');
    expect(sanitizeWebhookPath('my_workflow')).toBe('my_workflow');
  });

  it('rejects path traversal with ..', () => {
    expect(sanitizeWebhookPath('../api/v1/workflows')).toBeNull();
    expect(sanitizeWebhookPath('gmail/../api')).toBeNull();
  });

  it('rejects single dot segments', () => {
    expect(sanitizeWebhookPath('./gmail')).toBeNull();
  });

  it('rejects empty path', () => {
    expect(sanitizeWebhookPath('')).toBeNull();
  });

  it('rejects backslashes', () => {
    expect(sanitizeWebhookPath('..\\api')).toBeNull();
  });

  it('rejects special characters', () => {
    expect(sanitizeWebhookPath('gmail?query=1')).toBeNull();
    expect(sanitizeWebhookPath('gmail#fragment')).toBeNull();
    expect(sanitizeWebhookPath('gm ail')).toBeNull();
  });

  it('strips leading slashes', () => {
    expect(sanitizeWebhookPath('/gmail')).toBe('gmail');
    expect(sanitizeWebhookPath('///gmail')).toBe('gmail');
  });

  it('encodes segments', () => {
    // Segments with valid chars pass through encodeURIComponent unchanged
    expect(sanitizeWebhookPath('gmail')).toBe('gmail');
  });
});

// ── callN8nWebhook ─────────────────────────────────────────────────────

describe('callN8nWebhook', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('calls the correct URL with POST and JSON body', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ message: 'OK' })),
    });
    vi.stubGlobal('fetch', mockFetch);

    await callN8nWebhook('gmail', { action: 'summary' });

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:5678/webhook/gmail',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'X-N8N-API-KEY': 'test-key',
        }),
        body: JSON.stringify({ action: 'summary' }),
      }),
    );
  });

  it('returns ok result with JSON response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ emails: [{ subject: 'Test' }] })),
    }));

    const result = await callN8nWebhook('gmail', {});
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ emails: [{ subject: 'Test' }] });
  });

  it('returns ok result with plain text response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('Hello world'),
    }));

    const result = await callN8nWebhook('gmail', {});
    expect(result.ok).toBe(true);
    expect(result.data).toBe('Hello world');
  });

  it('returns error on non-OK response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('Internal Server Error'),
    }));

    const result = await callN8nWebhook('gmail', {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain('500');
  });

  it('returns error on network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Connection refused')));

    const result = await callN8nWebhook('gmail', {});
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Connection refused');
  });

  it('returns timeout error on abort', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('The operation was aborted', 'AbortError')));

    const result = await callN8nWebhook('gmail', {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain('timed out');
  });

  it('rejects path traversal attempts', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    const result = await callN8nWebhook('../api/v1/workflows', {});
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Invalid webhook path');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('sends empty params as empty JSON object', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('"ok"'),
    });
    vi.stubGlobal('fetch', mockFetch);

    await callN8nWebhook('test-path');
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:5678/webhook/test-path',
      expect.objectContaining({
        body: '{}',
      }),
    );
  });
});

// ── formatN8nResult ────────────────────────────────────────────────────

describe('formatN8nResult', () => {
  it('returns error string for failed results', () => {
    const output = formatN8nResult({ ok: false, data: null, error: 'timeout' });
    expect(output).toBe('n8n error: timeout');
  });

  it('returns string data directly', () => {
    const output = formatN8nResult({ ok: true, data: 'Hello world' });
    expect(output).toBe('Hello world');
  });

  it('handles null data', () => {
    const output = formatN8nResult({ ok: true, data: null });
    expect(output).toBe('OK (no data returned)');
  });

  it('handles undefined data', () => {
    const output = formatN8nResult({ ok: true, data: undefined });
    expect(output).toBe('OK (no data returned)');
  });

  it('handles empty string data', () => {
    const output = formatN8nResult({ ok: true, data: '' });
    expect(output).toBe('OK (empty response)');
  });

  it('extracts message field from object', () => {
    const output = formatN8nResult({ ok: true, data: { message: 'You have 5 unread emails' } });
    expect(output).toBe('You have 5 unread emails');
  });

  it('extracts text field from object', () => {
    const output = formatN8nResult({ ok: true, data: { text: 'Calendar is empty' } });
    expect(output).toBe('Calendar is empty');
  });

  it('extracts result field from object', () => {
    const output = formatN8nResult({ ok: true, data: { result: 'Task created' } });
    expect(output).toBe('Task created');
  });

  it('falls back to JSON for complex objects', () => {
    const data = { emails: [{ from: 'alice', subject: 'Hi' }] };
    const output = formatN8nResult({ ok: true, data });
    expect(output).toBe(JSON.stringify(data, null, 2));
  });

  it('falls back to JSON for arrays', () => {
    const data = [1, 2, 3];
    const output = formatN8nResult({ ok: true, data });
    expect(output).toBe(JSON.stringify(data, null, 2));
  });
});
