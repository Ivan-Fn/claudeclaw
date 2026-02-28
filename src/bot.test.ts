import { describe, it, expect } from 'vitest';
import { formatForTelegram, splitMessage } from './bot.js';

describe('formatForTelegram', () => {
  it('escapes HTML entities', () => {
    expect(formatForTelegram('a < b > c & d')).toBe('a &lt; b &gt; c &amp; d');
  });

  it('converts bold markdown', () => {
    expect(formatForTelegram('**bold text**')).toBe('<b>bold text</b>');
  });

  it('converts italic markdown', () => {
    expect(formatForTelegram('*italic text*')).toBe('<i>italic text</i>');
  });

  it('converts inline code', () => {
    expect(formatForTelegram('use `npm install`')).toBe('use <code>npm install</code>');
  });

  it('converts code blocks with language', () => {
    const input = '```js\nconsole.log("hi")\n```';
    const output = formatForTelegram(input);
    expect(output).toContain('<pre><code class="language-js">');
    expect(output).toContain('console.log');
    expect(output).toContain('</code></pre>');
  });

  it('converts code blocks without language', () => {
    const input = '```\nplain code\n```';
    const output = formatForTelegram(input);
    expect(output).toContain('<pre>');
    expect(output).not.toContain('<code');
  });

  it('escapes HTML inside code blocks', () => {
    const input = '```\n<div>test</div>\n```';
    const output = formatForTelegram(input);
    expect(output).toContain('&lt;div&gt;');
  });

  it('does not transform markdown inside code blocks', () => {
    const input = '```\n**not bold** and *not italic*\n```';
    const output = formatForTelegram(input);
    expect(output).not.toContain('<b>');
    expect(output).not.toContain('<i>');
  });

  it('handles mixed formatting', () => {
    const input = '**bold** and *italic* and `code`';
    const output = formatForTelegram(input);
    expect(output).toContain('<b>bold</b>');
    expect(output).toContain('<i>italic</i>');
    expect(output).toContain('<code>code</code>');
  });

  it('converts headings to bold', () => {
    expect(formatForTelegram('# Heading 1')).toBe('<b>Heading 1</b>');
    expect(formatForTelegram('## Heading 2')).toBe('<b>Heading 2</b>');
    expect(formatForTelegram('### Sub Heading')).toBe('<b>Sub Heading</b>');
  });

  it('converts strikethrough', () => {
    expect(formatForTelegram('~~deleted~~')).toBe('<s>deleted</s>');
  });

  it('converts links', () => {
    const output = formatForTelegram('[Click here](https://example.com)');
    expect(output).toBe('<a href="https://example.com">Click here</a>');
  });

  it('converts checkboxes', () => {
    const input = '- [ ] Todo\n- [x] Done';
    const output = formatForTelegram(input);
    expect(output).toContain('☐ Todo');
    expect(output).toContain('☑ Done');
  });

  it('strips horizontal rules', () => {
    const input = 'Before\n---\nAfter';
    const output = formatForTelegram(input);
    expect(output).not.toContain('---');
    expect(output).toContain('Before');
    expect(output).toContain('After');
  });

  it('handles plain text without changes', () => {
    expect(formatForTelegram('Hello world')).toBe('Hello world');
  });
});

describe('splitMessage', () => {
  it('returns single chunk for short messages', () => {
    expect(splitMessage('hello', 100)).toEqual(['hello']);
  });

  it('splits at newline boundaries', () => {
    const text = 'Line 1\nLine 2\nLine 3';
    const chunks = splitMessage(text, 14);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(14);
    }
  });

  it('splits long lines at space boundaries', () => {
    const text = 'word1 word2 word3 word4 word5 word6';
    const chunks = splitMessage(text, 15);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(15);
    }
  });

  it('force-splits when no good boundary exists', () => {
    const text = 'a'.repeat(100);
    const chunks = splitMessage(text, 30);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('handles empty string', () => {
    expect(splitMessage('', 100)).toEqual(['']);
  });
});
