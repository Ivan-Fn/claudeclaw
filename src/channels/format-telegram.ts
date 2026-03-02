// ── Telegram Formatting ────────────────────────────────────────────────
//
// Convert Claude's Markdown output to Telegram HTML.
// Strategy: extract code blocks AND inline code as placeholders first,
// then transform inline formatting, then restore. This prevents markdown
// patterns inside code from being transformed.

export function formatForTelegram(text: string): string {
  // Step 1: Extract code blocks as placeholders
  const codeBlocks: string[] = [];
  let processed = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, lang: string, code: string) => {
    const escaped = escapeHtml(code);
    const block = lang
      ? `<pre><code class="language-${lang}">${escaped}</code></pre>`
      : `<pre>${escaped}</pre>`;
    codeBlocks.push(block);
    return `\x00CB${codeBlocks.length - 1}\x00`;
  });

  // Also handle code blocks without trailing newline: ```lang code```
  processed = processed.replace(/```(\w*)([\s\S]*?)```/g, (_match, lang: string, code: string) => {
    const escaped = escapeHtml(code.trim());
    const block = lang
      ? `<pre><code class="language-${lang}">${escaped}</code></pre>`
      : `<pre>${escaped}</pre>`;
    codeBlocks.push(block);
    return `\x00CB${codeBlocks.length - 1}\x00`;
  });

  // Step 2: Escape HTML in remaining text
  processed = escapeHtml(processed);

  // Step 3: Extract inline code as placeholders (after escaping, before other transforms)
  const inlineCodes: string[] = [];
  processed = processed.replace(/`([^`\n]+)`/g, (_match, code: string) => {
    inlineCodes.push(`<code>${code}</code>`);
    return `\x00IC${inlineCodes.length - 1}\x00`;
  });

  // Step 4: Horizontal rules (---, ***, ___) -> remove
  processed = processed.replace(/^\s*[-*_]{3,}\s*$/gm, '');

  // Step 5: Headings: # Heading -> <b>Heading</b>
  processed = processed.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');

  // Step 6: Bold: **...** or __...__ -> <b>...</b>
  processed = processed.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  processed = processed.replace(/__(.+?)__/g, '<b>$1</b>');

  // Step 7: Italic: *...* or _..._ -> <i>...</i>
  processed = processed.replace(/(?<![*_])\*([^*\n]+)\*(?![*_])/g, '<i>$1</i>');
  processed = processed.replace(/(?<![*_])_([^_\n]+)_(?![*_])/g, '<i>$1</i>');

  // Step 8: Strikethrough: ~~...~~ -> <s>...</s>
  processed = processed.replace(/~~(.+?)~~/g, '<s>$1</s>');

  // Step 9: Links: [text](url) -> <a href="url">text</a>
  processed = processed.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2">$1</a>',
  );

  // Step 10: Checkboxes: - [ ] / - [x] -> symbols
  processed = processed.replace(/^(\s*)- \[ \]/gm, '$1☐');
  processed = processed.replace(/^(\s*)- \[x\]/gim, '$1☑');

  // Step 11: Restore inline code placeholders
  processed = processed.replace(/\x00IC(\d+)\x00/g, (_match, idx: string) => {
    return inlineCodes[Number(idx)] ?? '';
  });

  // Step 12: Restore code block placeholders
  processed = processed.replace(/\x00CB(\d+)\x00/g, (_match, idx: string) => {
    return codeBlocks[Number(idx)] ?? '';
  });

  // Step 13: Collapse 3+ consecutive blank lines
  processed = processed.replace(/\n{3,}/g, '\n\n');

  return processed;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ── Message Splitting ──────────────────────────────────────────────────

export function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    // Try to split at newline
    let splitIdx = remaining.lastIndexOf('\n', maxLen);
    if (splitIdx < maxLen * 0.3) {
      // Newline too far back, try space
      splitIdx = remaining.lastIndexOf(' ', maxLen);
    }
    if (splitIdx < maxLen * 0.3) {
      // No good split point, force split
      splitIdx = maxLen;
    }

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }

  return chunks;
}
