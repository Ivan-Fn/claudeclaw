import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = join(__dirname, '..');

let _cache: Record<string, string> | undefined;

export function readEnvFile(envPath?: string): Record<string, string> {
  if (_cache !== undefined && envPath === undefined) return _cache;

  // Start with process.env as base (Docker injects env vars here)
  const result: Record<string, string> = {};
  if (envPath === undefined) {
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) result[key] = value;
    }
  }

  // Overlay with .env file values (file takes precedence)
  // DOTENV_PATH env var allows pointing to an external .env (e.g., for multi-instance setups)
  const filePath = envPath ?? process.env['DOTENV_PATH'] ?? join(PROJECT_ROOT, '.env');
  try {
    const raw = readFileSync(filePath, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#')) continue;

      const eqIndex = trimmed.indexOf('=');
      if (eqIndex === -1) continue;

      const key = trimmed.slice(0, eqIndex).trim();
      let value = trimmed.slice(eqIndex + 1).trim();

      // Handle quoted values
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      } else {
        // Strip inline comments for unquoted values
        const commentIndex = value.indexOf(' #');
        if (commentIndex !== -1) {
          value = value.slice(0, commentIndex).trim();
        }
      }

      result[key] = value;
    }
  } catch {
    // No .env file -- process.env is sufficient (Docker mode)
  }

  if (envPath === undefined) _cache = result;
  return result;
}

/** Reset the cached env for testing purposes */
export function _resetEnvCache(): void {
  _cache = undefined;
}
