import { App } from '@slack/bolt';
import { WebClient } from '@slack/web-api';
import {
  SLACK_BOT_TOKEN,
  SLACK_APP_TOKEN,
  SLACK_ALLOWED_CHANNEL_IDS,
  SLACK_ALLOWED_USER_IDS,
} from '../config.js';
import { logger } from '../logger.js';
import { enqueueDebounced, isRateLimited } from '../queue.js';
import { compositeId } from './types.js';
import type { MessageChannel } from './types.js';
import { formatForSlack } from './format-slack.js';
import {
  processMessage,
  cancelRequest,
} from '../bot.js';
import {
  getSession,
  clearSession,
} from '../db.js';

// Slack max message length (mrkdwn)
const SLACK_MAX_LENGTH = 4000;

// Rate limit: 1 msg/sec per channel
const SLACK_MSG_DELAY_MS = 1100;

// ── Slack Channel Adapter ─────────────────────────────────────────────

export class SlackChannel implements MessageChannel {
  readonly channelId = 'slack' as const;
  private app: App;
  private client: WebClient;

  /**
   * Active thread_ts per channel. When a message comes from a channel
   * (via @mention), we store the triggering message's ts so that
   * send/sendFormatted reply in that thread. Cleared after each response.
   */
  private activeThreads = new Map<string, string>();

  constructor() {
    if (!SLACK_BOT_TOKEN) {
      throw new Error('SLACK_BOT_TOKEN not set');
    }
    if (!SLACK_APP_TOKEN) {
      throw new Error('SLACK_APP_TOKEN not set (needed for Socket Mode)');
    }

    this.app = new App({
      token: SLACK_BOT_TOKEN,
      appToken: SLACK_APP_TOKEN,
      socketMode: true,
      // Disable built-in receiver logging (we use our own logger)
      logLevel: 'ERROR' as never,
    });

    this.client = new WebClient(SLACK_BOT_TOKEN);

    this.setupMessageHandlers();
  }

  // ── MessageChannel Interface ──────────────────────────────────────

  async start(): Promise<void> {
    await this.app.start();
    logger.info('Slack channel started (Socket Mode)');
  }

  async stop(): Promise<void> {
    await this.app.stop();
    logger.info('Slack channel stopped');
  }

  async send(chatId: string, text: string): Promise<void> {
    const threadTs = this.activeThreads.get(chatId);
    await this.client.chat.postMessage({
      channel: chatId,
      text,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });
  }

  async sendFormatted(chatId: string, text: string): Promise<void> {
    const threadTs = this.activeThreads.get(chatId);
    const chunks = splitSlackMessage(text, SLACK_MAX_LENGTH);
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      const formatted = formatForSlack(chunk);

      if (i > 0) await sleep(SLACK_MSG_DELAY_MS);

      try {
        await this.client.chat.postMessage({
          channel: chatId,
          text: formatted,
          unfurl_links: false,
          unfurl_media: false,
          ...(threadTs ? { thread_ts: threadTs } : {}),
        });
      } catch (err) {
        // On rate limit, wait and retry once
        if (isSlackRateLimit(err)) {
          const retryAfter = getRetryAfter(err);
          await sleep(retryAfter * 1000);
          try {
            await this.client.chat.postMessage({
              channel: chatId,
              text: formatted,
              unfurl_links: false,
              unfurl_media: false,
              ...(threadTs ? { thread_ts: threadTs } : {}),
            });
            continue;
          } catch {
            // Fall through to plain text
          }
        }
        // Fallback: send unformatted
        try {
          await this.client.chat.postMessage({
            channel: chatId,
            text: chunk,
            ...(threadTs ? { thread_ts: threadTs } : {}),
          });
        } catch (plainErr) {
          logger.warn({ err: plainErr }, 'Failed to send Slack message chunk');
        }
      }
    }
  }

  startTyping(_chatId: string): () => void {
    // Slack doesn't support typing indicators for bots
    return () => {};
  }

  async downloadFile(fileId: string): Promise<string> {
    // Slack file downloads require authenticated fetch
    const result = await this.client.files.info({ file: fileId });
    const file = result.file;
    if (!file?.url_private_download) {
      throw new Error(`Cannot download Slack file ${fileId}: no download URL`);
    }

    const { mkdirSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { UPLOADS_DIR } = await import('../config.js');

    mkdirSync(UPLOADS_DIR, { recursive: true });
    const ext = file.name?.split('.').pop() ?? 'bin';
    const localPath = join(UPLOADS_DIR, `slack_${fileId}.${ext}`);

    const response = await fetch(file.url_private_download, {
      headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
    });
    if (!response.ok) {
      throw new Error(`Failed to download Slack file: ${response.status}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    writeFileSync(localPath, buffer);

    return localPath;
  }

  async sendVoice(chatId: string, audio: Buffer, filename?: string): Promise<void> {
    // Slack doesn't have native voice -- upload as audio file
    await this.client.filesUploadV2({
      channel_id: chatId,
      file: audio,
      filename: filename ?? 'response.ogg',
      title: 'Voice Response',
    });
  }

  // ── Thread Management ───────────────────────────────────────────────

  /** Set the thread_ts for replies in a channel. */
  setThread(chatId: string, threadTs: string): void {
    this.activeThreads.set(chatId, threadTs);
  }

  /** Clear the active thread for a channel. */
  clearThread(chatId: string): void {
    this.activeThreads.delete(chatId);
  }

  // ── Internal: Message Handlers ──────────────────────────────────────

  private setupMessageHandlers(): void {
    // Listen for DMs (direct messages to the bot)
    this.app.message(async ({ message, say }) => {
      // Filter out bot messages, message_changed, etc.
      if (!('user' in message) || !message.user) return;
      if ('subtype' in message && message.subtype) return;

      const userId = message.user;
      const channelId = message.channel;
      const text = ('text' in message ? message.text : '') ?? '';

      // Auth: check allowed channels
      if (SLACK_ALLOWED_CHANNEL_IDS.length > 0 && !SLACK_ALLOWED_CHANNEL_IDS.includes(channelId)) {
        logger.warn({ channelId, userId }, 'Slack message from non-allowed channel');
        return;
      }

      // Auth: check allowed users
      if (SLACK_ALLOWED_USER_IDS.length > 0 && !SLACK_ALLOWED_USER_IDS.includes(userId)) {
        logger.warn({ channelId, userId }, 'Slack message from non-allowed user');
        return;
      }

      const cid = compositeId('slack', channelId);

      // Handle text commands
      if (text.startsWith('/')) {
        const handled = await this.handleCommand(cid, channelId, text, say);
        if (handled) return;
      }

      if (isRateLimited(cid)) {
        await say('Rate limit exceeded. Please wait a moment.');
        return;
      }

      // DMs: no thread needed
      enqueueDebounced(cid, text, (merged) =>
        processMessage(this, cid, channelId, merged),
      );
    });

    // Listen for @mentions in channels
    this.app.event('app_mention', async ({ event }) => {
      const userId = event.user ?? '';
      const channelId = event.channel;
      const ts = event.ts;
      // If this mention is inside an existing thread, use the thread's root ts
      const threadTs = ('thread_ts' in event ? event.thread_ts as string : undefined) ?? ts;

      // Strip the bot mention from the text: "<@U12345> hello" -> "hello"
      const rawText = event.text ?? '';
      const text = rawText.replace(/<@[A-Z0-9]+>/g, '').trim();

      if (!text || !userId) return; // Empty mention or no user, ignore

      // Auth: check allowed channels
      if (SLACK_ALLOWED_CHANNEL_IDS.length > 0 && !SLACK_ALLOWED_CHANNEL_IDS.includes(channelId)) {
        logger.warn({ channelId, userId }, 'Slack mention from non-allowed channel');
        return;
      }

      // Auth: check allowed users
      if (SLACK_ALLOWED_USER_IDS.length > 0 && !SLACK_ALLOWED_USER_IDS.includes(userId)) {
        logger.warn({ channelId, userId }, 'Slack mention from non-allowed user');
        return;
      }

      const cid = compositeId('slack', channelId);

      if (isRateLimited(cid)) {
        this.setThread(channelId, threadTs);
        await this.send(channelId, 'Rate limit exceeded. Please wait a moment.');
        this.clearThread(channelId);
        return;
      }

      // Handle text commands in mentions
      if (text.startsWith('/')) {
        this.setThread(channelId, threadTs);
        const handled = await this.handleCommand(cid, channelId, text, (msg: string) =>
          this.send(channelId, msg),
        );
        if (handled) {
          this.clearThread(channelId);
          return;
        }
        this.clearThread(channelId);
      }

      // Set thread context so replies go into the thread
      this.setThread(channelId, threadTs);

      enqueueDebounced(cid, text, (merged) =>
        processMessage(this, cid, channelId, merged),
      );
    });

    // Handle file shares (messages with files attached)
    this.app.event('message', async ({ event }) => {
      const ev = event as unknown as Record<string, unknown>;
      if (!ev['files']) return;
      if (!ev['user']) return;

      const userId = ev['user'] as string;
      const channelId = ev['channel'] as string;
      const caption = (ev['text'] as string) ?? '';

      // Auth checks
      if (SLACK_ALLOWED_CHANNEL_IDS.length > 0 && !SLACK_ALLOWED_CHANNEL_IDS.includes(channelId)) return;
      if (SLACK_ALLOWED_USER_IDS.length > 0 && !SLACK_ALLOWED_USER_IDS.includes(userId)) return;

      const cid = compositeId('slack', channelId);
      const files = ev['files'] as Array<{ id: string; name?: string; mimetype?: string }>;

      // Build a message describing the files
      const fileDescriptions = files.map((f) => {
        const name = f.name ?? 'unnamed';
        const mime = f.mimetype ?? 'unknown';
        return `[File attached: ${name} (${mime}, id: ${f.id})]`;
      }).join('\n');

      const message = caption
        ? `${caption}\n\n${fileDescriptions}`
        : fileDescriptions;

      enqueueDebounced(cid, message, (merged) =>
        processMessage(this, cid, channelId, merged),
      );
    });
  }

  // ── Internal: Text Commands ─────────────────────────────────────────

  private async handleCommand(
    cid: string,
    channelId: string,
    text: string,
    say: (msg: string) => Promise<unknown>,
  ): Promise<boolean> {
    const parts = text.split(/\s+/);
    const cmd = parts[0]!.toLowerCase();

    switch (cmd) {
      case '/newchat': {
        clearSession(cid);
        await say('Session cleared. Starting fresh.');
        logger.info({ compositeId: cid }, 'Session cleared by Slack user');
        return true;
      }
      case '/cancel': {
        if (cancelRequest(cid)) {
          await say('Cancelling current request...');
        } else {
          await say('No active request to cancel.');
        }
        return true;
      }
      case '/status': {
        const sessionId = getSession(cid);
        const uptime = formatUptime(process.uptime());
        await say(`Session: ${sessionId ? sessionId.slice(0, 8) + '...' : 'none'}\nUptime: ${uptime}`);
        return true;
      }
      default:
        // Not a known command -- let it pass through to the agent
        return false;
    }
  }
}

// ── Utilities ──────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Split text into chunks respecting Slack's max message length. */
function splitSlackMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a newline
    let splitIdx = remaining.lastIndexOf('\n', maxLength);
    if (splitIdx < maxLength * 0.3) {
      // No good newline break -- split at space
      splitIdx = remaining.lastIndexOf(' ', maxLength);
    }
    if (splitIdx < maxLength * 0.3) {
      // No good break at all -- hard split
      splitIdx = maxLength;
    }

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).replace(/^\n/, '');
  }

  return chunks;
}

function isSlackRateLimit(err: unknown): boolean {
  return err instanceof Error && err.message.includes('rate_limited');
}

function getRetryAfter(err: unknown): number {
  if (err && typeof err === 'object' && 'retryAfter' in err) {
    return Number((err as { retryAfter: number }).retryAfter) || 5;
  }
  return 5;
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(' ');
}
