import { GoogleGenAI, Modality } from '@google/genai';
import { logger } from '../logger.js';
import { GEMINI_API_KEY, GEMINI_IMAGE_MODEL } from '../config.js';

const MAX_PROMPT_LENGTH = 2000;

export type GeminiImageResult =
  | { ok: true; imageBuffer: Buffer; mimeType: string; text?: string }
  | { ok: false; error: string };

/** Check if Gemini image generation is configured. */
export function isGeminiConfigured(): boolean {
  return GEMINI_API_KEY.length > 0;
}

/** Redact API key fragments from error messages. */
function redactKey(message: string): string {
  if (!GEMINI_API_KEY) return message;
  return message.replaceAll(GEMINI_API_KEY, '[REDACTED]');
}

/**
 * Generate an image using the Gemini API.
 * Uses native Gemini image generation via generateContent with IMAGE modality.
 */
export async function generateImage(prompt: string): Promise<GeminiImageResult> {
  if (!isGeminiConfigured()) {
    return { ok: false, error: 'Gemini not configured. Set GEMINI_API_KEY in .env' };
  }

  if (prompt.length > MAX_PROMPT_LENGTH) {
    return { ok: false, error: `Prompt too long (${prompt.length} chars, max ${MAX_PROMPT_LENGTH})` };
  }

  const startTime = Date.now();
  const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

  try {
    const response = await ai.models.generateContent({
      model: GEMINI_IMAGE_MODEL,
      contents: prompt,
      config: {
        responseModalities: [Modality.TEXT, Modality.IMAGE],
      },
    });

    const durationMs = Date.now() - startTime;

    // Check for prompt blocking (safety filters)
    if (response.promptFeedback?.blockReason) {
      const reason = response.promptFeedback.blockReason;
      logger.warn({ reason, promptLength: prompt.length, durationMs }, 'Gemini prompt blocked');
      return { ok: false, error: 'Prompt was blocked by safety filters. Try rephrasing.' };
    }

    // Extract parts from the first candidate
    const parts = response.candidates?.[0]?.content?.parts;
    if (!parts || parts.length === 0) {
      logger.warn({ promptLength: prompt.length, durationMs }, 'Gemini returned empty response');
      return { ok: false, error: 'No response from Gemini. Try a different prompt.' };
    }

    // Find the first image part and collect text parts
    let imageBuffer: Buffer | undefined;
    let mimeType = 'image/png';
    const textParts: string[] = [];

    for (const part of parts) {
      if (part.inlineData?.data) {
        if (!imageBuffer) {
          imageBuffer = Buffer.from(part.inlineData.data, 'base64');
          mimeType = part.inlineData.mimeType ?? 'image/png';
        }
      } else if (part.text) {
        textParts.push(part.text);
      }
    }

    const joinedText = textParts.join('\n').trim();

    if (imageBuffer) {
      logger.info(
        { promptLength: prompt.length, durationMs, imageSize: imageBuffer.length, model: GEMINI_IMAGE_MODEL },
        'Gemini image generated',
      );
      const result: GeminiImageResult = { ok: true, imageBuffer, mimeType };
      if (joinedText) result.text = joinedText;
      return result;
    }

    // Text-only response (Gemini decided not to generate an image)
    if (joinedText) {
      logger.info({ promptLength: prompt.length, durationMs }, 'Gemini returned text only');
      return { ok: false, error: joinedText };
    }

    return { ok: false, error: 'Gemini did not return an image. Try a different prompt.' };
  } catch (err) {
    const durationMs = Date.now() - startTime;

    const rawMsg = err instanceof Error ? err.message : String(err);
    const safeMsg = redactKey(rawMsg);

    // Surface rate limit errors clearly
    if (safeMsg.includes('429') || safeMsg.toLowerCase().includes('rate limit')) {
      logger.warn({ durationMs }, 'Gemini rate limited');
      return { ok: false, error: 'Gemini rate limit hit. Wait a moment and try again.' };
    }

    // Safety filter errors from the API
    if (safeMsg.toLowerCase().includes('safety') || safeMsg.toLowerCase().includes('blocked')) {
      logger.warn({ durationMs }, 'Gemini safety filter');
      return { ok: false, error: 'Prompt was blocked by safety filters. Try rephrasing.' };
    }

    logger.error({ err: safeMsg, durationMs, promptLength: prompt.length }, 'Gemini image generation failed');
    return { ok: false, error: `Gemini error: ${safeMsg.slice(0, 200)}` };
  }
}
