import { readFileSync } from 'node:fs';
import { GROQ_API_KEY, ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID } from './config.js';
import { logger } from './logger.js';

// ── Capabilities ───────────────────────────────────────────────────────

export function voiceCapabilities(): { stt: boolean; tts: boolean } {
  return {
    stt: GROQ_API_KEY.length > 0,
    tts: ELEVENLABS_API_KEY.length > 0 && ELEVENLABS_VOICE_ID.length > 0,
  };
}

// ── STT: Groq Whisper ──────────────────────────────────────────────────

const STT_TIMEOUT_MS = 30_000;

export async function transcribeAudio(filePath: string): Promise<string> {
  if (!GROQ_API_KEY) throw new Error('GROQ_API_KEY not configured');

  const fileData = readFileSync(filePath);
  const blob = new Blob([fileData], { type: 'audio/ogg' });

  const form = new FormData();
  form.append('file', blob, 'audio.ogg');
  form.append('model', 'whisper-large-v3');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), STT_TIMEOUT_MS);

  try {
    const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
      body: form,
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Groq STT failed (${res.status}): ${body}`);
    }

    const data = (await res.json()) as { text: string };
    logger.debug({ chars: data.text.length }, 'STT transcription complete');
    return data.text;
  } finally {
    clearTimeout(timeout);
  }
}

// ── TTS: ElevenLabs ────────────────────────────────────────────────────

const TTS_TIMEOUT_MS = 30_000;
const TTS_MAX_CHARS = 5000;

export async function synthesizeSpeech(text: string): Promise<Buffer> {
  if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID) {
    throw new Error('ElevenLabs API key or voice ID not configured');
  }

  const truncated = text.length > TTS_MAX_CHARS
    ? text.slice(0, TTS_MAX_CHARS - 3) + '...'
    : text;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TTS_TIMEOUT_MS);

  try {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': ELEVENLABS_API_KEY,
          'Content-Type': 'application/json',
          Accept: 'audio/ogg',
        },
        body: JSON.stringify({
          text: truncated,
          model_id: 'eleven_multilingual_v2',
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
          },
        }),
        signal: controller.signal,
      },
    );

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`ElevenLabs TTS failed (${res.status}): ${body}`);
    }

    const arrayBuf = await res.arrayBuffer();
    logger.debug({ bytes: arrayBuf.byteLength }, 'TTS synthesis complete');
    return Buffer.from(arrayBuf);
  } finally {
    clearTimeout(timeout);
  }
}
