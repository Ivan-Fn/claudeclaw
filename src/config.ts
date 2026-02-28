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

// Paths
export { PROJECT_ROOT };
export const STORE_DIR = join(PROJECT_ROOT, 'store');
export const DB_PATH = join(STORE_DIR, 'master-agent.db');
export const UPLOADS_DIR = join(PROJECT_ROOT, 'workspace', 'uploads');
export const PID_FILE = join(STORE_DIR, 'master-agent.pid');

// Timeouts & limits
export const MAX_MESSAGE_LENGTH = 4096;
export const TYPING_REFRESH_MS = 4_000;
export const AGENT_TIMEOUT_MS = Number(env['AGENT_TIMEOUT_MS']) || 5 * 60 * 1000;
export const MAX_TURNS = 50;
export const MAX_MESSAGES_PER_MINUTE = 10;

// Memory
export const MEMORY_DECAY_FACTOR = 0.98;
export const MEMORY_MIN_SALIENCE = 0.1;

// Scheduler
export const SCHEDULER_POLL_MS = 60_000;

// n8n integration
export const N8N_BASE_URL = (env['N8N_BASE_URL'] ?? '').trim().replace(/\/+$/, '');
export const N8N_API_KEY = env['N8N_API_KEY'] ?? '';

// Gemini (image generation)
export const GEMINI_API_KEY = env['GEMINI_API_KEY'] ?? '';
export const GEMINI_IMAGE_MODEL = env['GEMINI_IMAGE_MODEL'] || 'gemini-2.5-flash-image';
