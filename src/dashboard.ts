// ── Dashboard Server ──────────────────────────────────────────────────
//
// Lightweight monitoring dashboard served via Hono.
// - REST API for querying bot metrics (cost, sessions, memory, tasks, hive mind)
// - Static HTML served from dashboard.html
// - Token-based auth via query parameter or Authorization header

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { DASHBOARD_PORT, DASHBOARD_TOKEN, BOT_DISPLAY_NAME, PROJECT_ROOT } from './config.js';
import { logger } from './logger.js';
import {
  getSession,
  getRecentConversation,
  getRecentMemories,
  getCostSummary,
  getCostByModel,
  getSessionTokenUsage,
  listTasks,
  getActiveRequests,
  getHiveMindEntries,
  getModelOverride,
} from './db.js';
import { getMemoryStats } from './memory.js';
import { getLastUsage } from './bot.js';

// ── HTML Cache ────────────────────────────────────────────────────────

let cachedHtml: string | undefined;

function getDashboardHtml(): string {
  if (!cachedHtml) {
    cachedHtml = readFileSync(join(PROJECT_ROOT, 'src', 'dashboard.html'), 'utf-8');
  }
  return cachedHtml;
}

// ── App ───────────────────────────────────────────────────────────────

const app = new Hono();

// Auth middleware
app.use('*', async (c, next) => {
  if (!DASHBOARD_TOKEN) {
    // No token configured -- allow all access (local dev)
    return next();
  }

  const queryToken = c.req.query('token');
  const headerToken = c.req.header('Authorization')?.replace('Bearer ', '');
  const token = queryToken || headerToken;

  if (token !== DASHBOARD_TOKEN) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  return next();
});

// ── Routes ────────────────────────────────────────────────────────────

app.get('/', (c) => {
  return c.html(getDashboardHtml());
});

app.get('/api/info', (c) => {
  return c.json({
    name: BOT_DISPLAY_NAME,
    pid: process.pid,
    uptime: process.uptime(),
    nodeVersion: process.version,
  });
});

app.get('/api/health', (c) => {
  const chatId = c.req.query('chatId') ?? '';
  if (!chatId) return c.json({ error: 'chatId required' }, 400);

  const sessionId = getSession(chatId);
  const memStats = getMemoryStats(chatId);
  const usage = getLastUsage(chatId);
  const modelOverride = getModelOverride(chatId);
  const activeReqs = getActiveRequests();
  const isProcessing = activeReqs.some(r => r.chat_id === chatId);

  let sessionSummary = null;
  if (sessionId) {
    sessionSummary = getSessionTokenUsage(sessionId);
  }

  return c.json({
    sessionId: sessionId ?? null,
    sessionSummary,
    memoryStats: memStats,
    modelOverride: modelOverride ?? null,
    isProcessing,
    context: usage ? {
      lastCacheRead: usage.lastCallCacheRead,
      pct: Math.round((usage.lastCallCacheRead / 200_000) * 100),
      didCompact: usage.didCompact,
    } : null,
  });
});

app.get('/api/tokens', (c) => {
  const chatId = c.req.query('chatId') ?? '';
  if (!chatId) return c.json({ error: 'chatId required' }, 400);

  const now = Math.floor(Date.now() / 1000);
  const day = getCostSummary(chatId, now - 86400);
  const week = getCostSummary(chatId, now - 7 * 86400);
  const month = getCostSummary(chatId, now - 30 * 86400);
  const byModel = getCostByModel(chatId, now - 30 * 86400);

  return c.json({ day, week, month, byModel });
});

app.get('/api/memories', (c) => {
  const chatId = c.req.query('chatId') ?? '';
  if (!chatId) return c.json({ error: 'chatId required' }, 400);

  const limit = Number(c.req.query('limit')) || 20;
  const stats = getMemoryStats(chatId);
  const recent = getRecentMemories(chatId, limit);

  return c.json({ stats, recent });
});

app.get('/api/conversation', (c) => {
  const chatId = c.req.query('chatId') ?? '';
  if (!chatId) return c.json({ error: 'chatId required' }, 400);

  const limit = Number(c.req.query('limit')) || 20;
  const turns = getRecentConversation(chatId, limit);

  return c.json({ turns });
});

app.get('/api/tasks', (c) => {
  const chatId = c.req.query('chatId');
  const tasks = listTasks(chatId ?? undefined);
  return c.json({ tasks });
});

app.get('/api/active-requests', (c) => {
  const requests = getActiveRequests();
  return c.json({ requests });
});

app.get('/api/hive-mind', (c) => {
  const agentId = c.req.query('agent');
  const limit = Number(c.req.query('limit')) || 20;
  const entries = getHiveMindEntries(limit, agentId ?? undefined);
  return c.json({ entries });
});

// ── Server Lifecycle ──────────────────────────────────────────────────

let server: ReturnType<typeof serve> | undefined;

export function startDashboard(): void {
  if (!DASHBOARD_PORT) return;

  server = serve({ fetch: app.fetch, port: DASHBOARD_PORT }, () => {
    logger.info({ port: DASHBOARD_PORT }, 'Dashboard server running');
  });
}

export function stopDashboard(): void {
  if (server) {
    server.close();
    server = undefined;
  }
}
