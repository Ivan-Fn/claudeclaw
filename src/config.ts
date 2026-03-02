import { join } from 'node:path';
import { readEnvFile, PROJECT_ROOT } from './env.js';

const env = readEnvFile();

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
