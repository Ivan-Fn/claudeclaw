import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config.js', () => ({
  GEMINI_API_KEY: 'test-gemini-key',
  GEMINI_IMAGE_MODEL: 'gemini-2.5-flash-image',
}));

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock the GoogleGenAI class
const mockGenerateContent = vi.fn();
vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn().mockImplementation(() => ({
    models: {
      generateContent: mockGenerateContent,
    },
  })),
  Modality: {
    TEXT: 'TEXT',
    IMAGE: 'IMAGE',
  },
}));

import { isGeminiConfigured, generateImage } from './gemini.js';

// ── isGeminiConfigured ────────────────────────────────────────────────

describe('isGeminiConfigured', () => {
  it('returns true when GEMINI_API_KEY is set', () => {
    expect(isGeminiConfigured()).toBe(true);
  });
});

// ── generateImage ─────────────────────────────────────────────────────

describe('generateImage', () => {
  beforeEach(() => {
    mockGenerateContent.mockReset();
  });

  it('returns image buffer on successful generation', async () => {
    const fakeBase64 = Buffer.from('fake-png-data').toString('base64');
    mockGenerateContent.mockResolvedValue({
      candidates: [{
        content: {
          parts: [
            { text: 'Here is your image' },
            { inlineData: { data: fakeBase64, mimeType: 'image/png' } },
          ],
        },
      }],
    });

    const result = await generateImage('a cat in space');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.imageBuffer).toEqual(Buffer.from('fake-png-data'));
      expect(result.mimeType).toBe('image/png');
      expect(result.text).toBe('Here is your image');
    }
  });

  it('returns text-only response when no image is generated', async () => {
    mockGenerateContent.mockResolvedValue({
      candidates: [{
        content: {
          parts: [
            { text: 'I cannot generate that image, but here is a description...' },
          ],
        },
      }],
    });

    const result = await generateImage('something');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('I cannot generate that image');
    }
  });

  it('handles safety filter block via promptFeedback', async () => {
    mockGenerateContent.mockResolvedValue({
      promptFeedback: { blockReason: 'SAFETY' },
      candidates: [],
    });

    const result = await generateImage('blocked prompt');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('safety filters');
    }
  });

  it('handles empty candidates', async () => {
    mockGenerateContent.mockResolvedValue({
      candidates: [],
    });

    const result = await generateImage('test');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('No response');
    }
  });

  it('handles null parts', async () => {
    mockGenerateContent.mockResolvedValue({
      candidates: [{ content: { parts: null } }],
    });

    const result = await generateImage('test');
    expect(result.ok).toBe(false);
  });

  it('rejects prompts exceeding max length', async () => {
    const longPrompt = 'x'.repeat(2001);
    const result = await generateImage(longPrompt);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('too long');
    }
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });

  it('handles API errors with redacted key', async () => {
    mockGenerateContent.mockRejectedValue(
      new Error('Invalid API key: test-gemini-key is not valid'),
    );

    const result = await generateImage('test');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).not.toContain('test-gemini-key');
      expect(result.error).toContain('[REDACTED]');
    }
  });

  it('handles rate limit errors', async () => {
    mockGenerateContent.mockRejectedValue(
      new Error('429 Too Many Requests: rate limit exceeded'),
    );

    const result = await generateImage('test');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('rate limit');
    }
  });

  it('handles safety exception errors', async () => {
    mockGenerateContent.mockRejectedValue(
      new Error('Content was blocked due to safety concerns'),
    );

    const result = await generateImage('test');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('safety filters');
    }
  });

  it('returns first image when multiple images are returned', async () => {
    const img1 = Buffer.from('image-1').toString('base64');
    const img2 = Buffer.from('image-2').toString('base64');
    mockGenerateContent.mockResolvedValue({
      candidates: [{
        content: {
          parts: [
            { inlineData: { data: img1, mimeType: 'image/png' } },
            { inlineData: { data: img2, mimeType: 'image/png' } },
          ],
        },
      }],
    });

    const result = await generateImage('two images');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.imageBuffer).toEqual(Buffer.from('image-1'));
    }
  });

  it('uses correct mime type from response', async () => {
    const fakeBase64 = Buffer.from('jpeg-data').toString('base64');
    mockGenerateContent.mockResolvedValue({
      candidates: [{
        content: {
          parts: [
            { inlineData: { data: fakeBase64, mimeType: 'image/jpeg' } },
          ],
        },
      }],
    });

    const result = await generateImage('test');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.mimeType).toBe('image/jpeg');
    }
  });
});
