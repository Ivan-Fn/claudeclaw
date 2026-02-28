import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = join(__dirname, '..');

let _cache: Record<string, string> | undefined;

export function readEnvFile(envPath?: string): Record<string, string> {
  if (_cache !== undefined && envPath === undefined) return _cache;

  const filePath = envPath ?? join(PROJECT_ROOT, '.env');
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    const empty: Record<string, string> = {};
    if (envPath === undefined) _cache = empty;
    return empty;
  }

  const result: Record<string, string> = {};
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

  if (envPath === undefined) _cache = result;
  return result;
}

/** Reset the cached env for testing purposes */
export function _resetEnvCache(): void {
  _cache = undefined;
}
