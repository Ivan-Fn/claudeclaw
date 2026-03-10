// ── Channel Adapter Types ─────────────────────────────────────────────
//
// Shared interface for all messaging channels (Telegram, Slack, etc.).
// Each channel implements this interface and registers with the core
// message processing pipeline.

export type ChannelId = 'telegram' | 'slack';

/** Build a composite ID that scopes DB entries per channel. */
export function compositeId(channel: ChannelId, chatId: string): string {
  return `${channel}:${chatId}`;
}

/** Extract the raw chat ID from a composite ID. */
export function rawChatId(composite: string): string {
  const idx = composite.indexOf(':');
  return idx >= 0 ? composite.slice(idx + 1) : composite;
}

/** Extract the channel from a composite ID. */
export function channelFromComposite(composite: string): ChannelId | undefined {
  const idx = composite.indexOf(':');
  if (idx < 0) return undefined;
  const ch = composite.slice(0, idx);
  if (ch === 'telegram' || ch === 'slack') return ch;
  return undefined;
}

/**
 * Interface that all messaging channels must implement.
 *
 * Channels handle platform-specific I/O (receiving messages, sending replies,
 * downloading files) while the core pipeline handles agent invocation,
 * memory, sessions, and queueing.
 */
export interface MessageChannel {
  readonly channelId: ChannelId;

  /** Start listening for messages. */
  start(): Promise<void>;

  /** Gracefully stop the channel. */
  stop(): Promise<void>;

  /** Send a plain text message. */
  send(chatId: string, text: string): Promise<void>;

  /**
   * Send a message with platform-specific formatting applied.
   * Handles long message splitting internally.
   */
  sendFormatted(chatId: string, text: string): Promise<void>;

  /**
   * Start a typing/processing indicator.
   * Returns a function to stop it. No-op for platforms without typing.
   */
  startTyping(chatId: string): () => void;

  /**
   * Download a platform-specific file to local disk.
   * Returns the local file path.
   */
  downloadFile(fileId: string): Promise<string>;

  /**
   * Send a voice/audio message. Optional -- not all platforms support this.
   * Falls back to file upload on platforms without native voice.
   */
  sendVoice?(chatId: string, audio: Buffer, filename?: string): Promise<void>;

  /**
   * Send a document/file. Optional -- not all platforms support this.
   */
  sendDocument?(chatId: string, filePath: string, caption?: string): Promise<void>;

  /**
   * Send a photo. Optional -- not all platforms support this.
   */
  sendPhoto?(chatId: string, filePath: string, caption?: string): Promise<void>;
}

/**
 * Callback signature for inbound messages from any channel.
 * The core pipeline registers this with each channel.
 */
export type InboundMessageHandler = (msg: InboundMessage) => void;

export interface InboundMessage {
  /** The channel this message came from. */
  channel: MessageChannel;
  /** Composite ID: "telegram:12345" or "slack:D1234567". */
  compositeId: string;
  /** The raw chat/channel ID on the platform. */
  chatId: string;
  /** Normalized message content (text, photo description, transcription, etc.). */
  text: string;
  /** Whether the user wants a voice response back. */
  respondWithVoice?: boolean;
  /** Whether to skip logging this turn (e.g., for /respin). */
  skipLog?: boolean;
}
