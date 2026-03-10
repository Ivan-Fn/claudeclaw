import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { readEnvFile, PROJECT_ROOT } from './env.js';

const env = readEnvFile();

// Runtime environment detection
export const IS_DOCKER = env['DEVCONTAINER'] === 'true' || existsSync('/.dockerenv');

// Telegram
export const TELEGRAM_BOT_TOKEN = env['TELEGRAM_BOT_TOKEN'] ?? '';
export const ALLOWED_CHAT_IDS = (env['ALLOWED_CHAT_IDS'] ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => /^-?\d+$/.test(s));

// Claude
export const CLAUDE_SYSTEM_PROMPT_APPEND =
  env['CLAUDE_SYSTEM_PROMPT_APPEND'] ?? '';
export const ANTHROPIC_API_KEY = env['ANTHROPIC_API_KEY'] ?? '';

// Voice
export const GROQ_API_KEY = env['GROQ_API_KEY'] ?? '';
export const ELEVENLABS_API_KEY = env['ELEVENLABS_API_KEY'] ?? '';
export const ELEVENLABS_VOICE_ID = env['ELEVENLABS_VOICE_ID'] ?? '';

// Bot identity (used for DB, PID, logs, and display name)
export const BOT_NAME = env['BOT_NAME']?.trim() || 'master-agent';
export const BOT_DISPLAY_NAME = env['BOT_DISPLAY_NAME']?.trim() || 'Master Agent';

// Paths
export { PROJECT_ROOT };
export const STORE_DIR = join(PROJECT_ROOT, 'store');
export const DB_PATH = join(STORE_DIR, `${BOT_NAME}.db`);
export const UPLOADS_DIR = join(PROJECT_ROOT, 'workspace', 'uploads');
export const PID_FILE = join(STORE_DIR, `${BOT_NAME}.pid`);

// Message debounce: buffer rapid messages before sending to Claude
export const MESSAGE_DEBOUNCE_MS = Number(env['MESSAGE_DEBOUNCE_MS']) || 3_000;

// Timeouts & limits
export const MAX_MESSAGE_LENGTH = 4096;
export const TYPING_REFRESH_MS = 4_000;
export const AGENT_TIMEOUT_MS = Number(env['AGENT_TIMEOUT_MS']) || 5 * 60 * 1000;
export const MAX_TURNS = 50;
export const MAX_TIMEOUT_RETRIES = Number(env['MAX_TIMEOUT_RETRIES']) || 3;
export const MAX_RESUME_ATTEMPTS = Number(env['MAX_RESUME_ATTEMPTS']) || 2;
export const MAX_MESSAGES_PER_MINUTE = 10;

// Memory
export const MEMORY_DECAY_FACTOR = 0.98;
export const MEMORY_MIN_SALIENCE = 0.1;

// Scheduler
export const SCHEDULER_POLL_MS = 60_000;

// Agent working directory (defaults to PROJECT_ROOT)
// Set to override where Claude Code sessions run (e.g., a different project root)
export const AGENT_CWD = env['AGENT_CWD']?.trim() || PROJECT_ROOT;

// Send restart notification (default: true = all allowed chats)
// Values: 'true' (all), 'false' (none), or comma-separated chat IDs (e.g., '85308772,12345')
const notifyVal = (env['NOTIFY_ON_RESTART'] ?? 'true').trim();
export const NOTIFY_ON_RESTART = notifyVal !== 'false';
export const NOTIFY_ON_RESTART_IDS: string[] =
  notifyVal === 'true' || notifyVal === 'false'
    ? []  // empty = use ALLOWED_CHAT_IDS (when true) or skip (when false)
    : notifyVal.split(',').map((s) => s.trim()).filter(Boolean);

// Claude settings sources: comma-separated list (default: 'user,project')
// Set to 'project' to only load project-level settings (no user MCP servers, etc.)
export const SETTINGS_SOURCES = (env['SETTINGS_SOURCES'] ?? 'user,project')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean) as ('user' | 'project')[];

// Extra env vars to forward to Claude agent subprocess (comma-separated keys)
// Example: AGENT_FORWARD_ENV=CLOUDFLARE_API_TOKEN,CLOUDFLARE_ACCOUNT_ID
export const AGENT_FORWARD_ENV = (env['AGENT_FORWARD_ENV'] ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Custom /start message (overrides the default "BOT_DISPLAY_NAME online..." greeting)
export const BOT_START_MESSAGE = env['BOT_START_MESSAGE']?.trim() || '';

// MCP servers to pass directly to the Claude Agent SDK (JSON string)
// Format: {"server-name": {"command": "...", "args": [...], "env": {...}}}
// This is the reliable way to make MCP tools available to the agent.
export const AGENT_MCP_SERVERS: Record<string, { command: string; args?: string[]; env?: Record<string, string> }> = (() => {
  const raw = env['AGENT_MCP_SERVERS']?.trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
  } catch {
    return {};
  }
})();

// Main agent model (e.g., 'claude-opus-4-6', 'claude-sonnet-4-6')
// Leave unset to use the CLI default model.
export const AGENT_MODEL = env['AGENT_MODEL']?.trim() || '';

// Subagent definitions for multi-model routing.
// The main agent delegates tasks to subagents running on cheaper/faster models.
// Defaults are provided below; override via AGENT_SUBAGENTS env var (JSON string).
export interface SubagentDefinition {
  description: string;
  prompt: string;
  model?: 'sonnet' | 'opus' | 'haiku' | 'inherit';
  tools?: string[];
  disallowedTools?: string[];
  maxTurns?: number;
}

const DEFAULT_SUBAGENTS: Record<string, SubagentDefinition> = {
  'general-purpose': {
    description: 'General-purpose agent for most tasks: checking email, calendar, simple Q&A, web searches, single-file edits, formatting, routine operations, and any task that does not require deep multi-step reasoning or complex multi-file code changes. Use this agent by default unless the task clearly requires complex reasoning.',
    prompt: 'Execute the task. Be concise and direct.',
    model: 'sonnet',
  },
};

// Set AGENT_SUBAGENTS to override defaults, or '{}' to disable subagents entirely.
export const AGENT_SUBAGENTS: Record<string, SubagentDefinition> = (() => {
  const raw = env['AGENT_SUBAGENTS']?.trim();
  if (!raw) return DEFAULT_SUBAGENTS;
  try {
    return JSON.parse(raw) as Record<string, SubagentDefinition>;
  } catch {
    return DEFAULT_SUBAGENTS;
  }
})();

// Daily cost limit in USD (0 = unlimited)
export const AGENT_DAILY_COST_LIMIT_USD = Number(env['AGENT_DAILY_COST_LIMIT_USD']) || 0;

// Slack
export const SLACK_BOT_TOKEN = env['SLACK_BOT_TOKEN'] ?? '';
export const SLACK_APP_TOKEN = env['SLACK_APP_TOKEN'] ?? '';
export const SLACK_ALLOWED_CHANNEL_IDS = (env['SLACK_ALLOWED_CHANNEL_IDS'] ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
export const SLACK_ALLOWED_USER_IDS = (env['SLACK_ALLOWED_USER_IDS'] ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// n8n integration
export const N8N_BASE_URL = (env['N8N_BASE_URL'] ?? '').trim().replace(/\/+$/, '');
export const N8N_API_KEY = env['N8N_API_KEY'] ?? '';

// Dashboard
export const DASHBOARD_PORT = Number(env['DASHBOARD_PORT']) || 3141;
export const DASHBOARD_TOKEN = env['DASHBOARD_TOKEN'] ?? '';

// Shared HiveMind DB path (cross-agent activity log)
// In Docker: /shared/hivemind.db (bind-mounted from host)
// On host: set SHARED_HIVEMIND_DB to point at the shared file
// If unset, HiveMind falls back to the local bot DB.
export const SHARED_HIVEMIND_DB = env['SHARED_HIVEMIND_DB']?.trim() || '';
