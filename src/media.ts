import { writeFileSync, renameSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join, extname } from 'node:path';
import { UPLOADS_DIR, TELEGRAM_BOT_TOKEN } from './config.js';
import { logger } from './logger.js';

// ── File Download ──────────────────────────────────────────────────────

const DOWNLOAD_TIMEOUT_MS = 30_000;
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

export async function downloadTelegramFile(fileId: string): Promise<string> {
  // Step 1: Get file path from Telegram API
  const infoRes = await safeFetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`,
    DOWNLOAD_TIMEOUT_MS,
  );

  if (!infoRes.ok) {
    throw new Error(`Telegram getFile failed (${infoRes.status})`);
  }

  const info = (await infoRes.json()) as {
    ok: boolean;
    result: { file_path: string; file_size?: number };
  };

  if (!info.ok || !info.result.file_path) {
    throw new Error('Telegram getFile returned invalid response');
  }

  // Step 2: Check file size before downloading
  if (info.result.file_size !== undefined && info.result.file_size > MAX_FILE_SIZE_BYTES) {
    throw new Error(
      `File too large (${(info.result.file_size / 1024 / 1024).toFixed(1)} MB). Max: ${MAX_FILE_SIZE_BYTES / 1024 / 1024} MB`,
    );
  }

  // Step 3: Download the actual file
  const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${info.result.file_path}`;
  const fileRes = await safeFetch(fileUrl, DOWNLOAD_TIMEOUT_MS);

  if (!fileRes.ok) {
    throw new Error(`Telegram file download failed (${fileRes.status})`);
  }

  const buffer = Buffer.from(await fileRes.arrayBuffer());

  // Double-check actual size (file_size from API may be absent or inaccurate)
  if (buffer.length > MAX_FILE_SIZE_BYTES) {
    throw new Error(
      `Downloaded file too large (${(buffer.length / 1024 / 1024).toFixed(1)} MB). Max: ${MAX_FILE_SIZE_BYTES / 1024 / 1024} MB`,
    );
  }

  // Step 4: Save to uploads directory
  mkdirSync(UPLOADS_DIR, { recursive: true });
  const ext = extname(info.result.file_path) || '.bin';
  const filename = `${Date.now()}-${fileId.slice(0, 8)}${ext}`;
  const localPath = join(UPLOADS_DIR, filename);
  writeFileSync(localPath, buffer);

  logger.debug({ fileId, localPath, size: buffer.length }, 'Downloaded Telegram file');
  return localPath;
}

// ── Voice File Handling ────────────────────────────────────────────────
//
// Telegram voice notes use .oga (Ogg with Opus codec).
// Groq Whisper expects .ogg. Same format, different extension.

export function renameOgaToOgg(filePath: string): string {
  if (filePath.endsWith('.oga')) {
    const newPath = filePath.replace(/\.oga$/, '.ogg');
    renameSync(filePath, newPath);
    return newPath;
  }
  return filePath;
}

// ── Prompt Builders ────────────────────────────────────────────────────

export function buildPhotoMessage(caption: string | undefined, localPath: string): string {
  const parts = ['[User sent a photo]'];
  if (caption) parts.push(`Caption: ${caption}`);
  parts.push(`Saved to: ${localPath}`);
  return parts.join('\n');
}

export function buildDocumentMessage(
  fileName: string | undefined,
  caption: string | undefined,
  localPath: string,
): string {
  const parts = [`[User sent a document: ${fileName ?? 'unknown'}]`];
  if (caption) parts.push(`Caption: ${caption}`);
  parts.push(`Saved to: ${localPath}`);
  return parts.join('\n');
}

// ── Cleanup ────────────────────────────────────────────────────────────

const MAX_UPLOAD_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

export function cleanupOldUploads(): number {
  try {
    mkdirSync(UPLOADS_DIR, { recursive: true });
    const files = readdirSync(UPLOADS_DIR);
    const now = Date.now();
    let removed = 0;

    for (const file of files) {
      const filePath = join(UPLOADS_DIR, file);
      const stat = statSync(filePath);
      if (now - stat.mtimeMs > MAX_UPLOAD_AGE_MS) {
        unlinkSync(filePath);
        removed++;
      }
    }

    if (removed > 0) {
      logger.info({ removed }, 'Cleaned up old uploads');
    }
    return removed;
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up uploads');
    return 0;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

/** Fetch with timeout that redacts bot token from any error messages */
async function safeFetch(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } catch (err) {
    // Redact bot token from error messages to prevent leaking to logs
    if (err instanceof Error) {
      err.message = redactToken(err.message);
      if (err.stack) {
        err.stack = redactToken(err.stack);
      }
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function redactToken(text: string): string {
  if (!TELEGRAM_BOT_TOKEN) return text;
  return text.replaceAll(TELEGRAM_BOT_TOKEN, '[REDACTED]');
}
