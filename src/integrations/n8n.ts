import { logger } from '../logger.js';
import { N8N_BASE_URL, N8N_API_KEY } from '../config.js';

const WEBHOOK_TIMEOUT_MS = 30_000;

export interface N8nWorkflowResult {
  ok: boolean;
  data: unknown;
  error?: string;
}

/** Check if n8n integration is configured. */
export function isN8nConfigured(): boolean {
  return N8N_BASE_URL.length > 0;
}

/** Validate and sanitize a webhook path to prevent SSRF / path traversal. */
export function sanitizeWebhookPath(raw: string): string | null {
  const segments = raw.split('/').filter(Boolean);
  if (segments.length === 0) return null;
  if (segments.some(s => s === '..' || s === '.' || s.includes('\\'))) return null;
  // Only allow alphanumeric, hyphens, underscores per segment
  if (segments.some(s => !/^[\w-]+$/.test(s))) return null;
  return segments.map(s => encodeURIComponent(s)).join('/');
}

/**
 * Call an n8n webhook workflow by path.
 * Expects n8n webhook URLs like: {N8N_BASE_URL}/webhook/{path}
 */
export async function callN8nWebhook(
  path: string,
  params: Record<string, unknown> = {},
): Promise<N8nWorkflowResult> {
  if (!isN8nConfigured()) {
    return { ok: false, data: null, error: 'n8n not configured (N8N_BASE_URL missing)' };
  }

  const safePath = sanitizeWebhookPath(path);
  if (!safePath) {
    return { ok: false, data: null, error: 'Invalid webhook path' };
  }

  const url = `${N8N_BASE_URL}/webhook/${safePath}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (N8N_API_KEY) {
    headers['X-N8N-API-KEY'] = N8N_API_KEY;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(params),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.warn({ url, status: res.status, body: text }, 'n8n webhook call failed');
      return { ok: false, data: null, error: `n8n returned ${res.status}: ${text.slice(0, 200)}` };
    }

    // Read body as text first, then try to parse as JSON.
    // Avoids the double-consume bug of res.json().catch(() => res.text()).
    const text = await res.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { ok: true, data };
  } catch (err) {
    clearTimeout(timeout);

    // Distinguish timeout from other network errors
    if (err instanceof DOMException && err.name === 'AbortError') {
      logger.warn({ url }, 'n8n webhook call timed out');
      return { ok: false, data: null, error: 'n8n request timed out (30s)' };
    }

    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, url }, 'n8n webhook call error');
    return { ok: false, data: null, error: msg };
  }
}

/**
 * Format n8n result data for display in Telegram.
 * Handles common response shapes from n8n workflows.
 */
export function formatN8nResult(result: N8nWorkflowResult): string {
  if (!result.ok) {
    return `n8n error: ${result.error}`;
  }

  const data = result.data;

  if (data == null) return 'OK (no data returned)';

  // String response
  if (typeof data === 'string') return data || 'OK (empty response)';

  // Object with a message/text/result field
  if (typeof data === 'object' && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>;
    if (typeof obj['message'] === 'string') return obj['message'];
    if (typeof obj['text'] === 'string') return obj['text'];
    if (typeof obj['result'] === 'string') return obj['result'];
  }

  // Fallback: pretty-print JSON
  return JSON.stringify(data, null, 2);
}
