// ── Slack Formatting ──────────────────────────────────────────────────
//
// Convert Claude's Markdown output to Slack mrkdwn format.
// Slack mrkdwn is simpler than Telegram HTML but has its own quirks.

export function formatForSlack(text: string): string {
  // Step 1: Extract code blocks as placeholders (preserve as-is for Slack)
  const codeBlocks: string[] = [];
  let processed = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, _lang: string, code: string) => {
    // Slack doesn't support language-specific highlighting in mrkdwn
    codeBlocks.push('```' + code + '```');
    return `\x00CB${codeBlocks.length - 1}\x00`;
  });

  // Also handle code blocks without trailing newline
  processed = processed.replace(/```(\w*)([\s\S]*?)```/g, (_match, _lang: string, code: string) => {
    codeBlocks.push('```' + code.trim() + '```');
    return `\x00CB${codeBlocks.length - 1}\x00`;
  });

  // Step 2: Extract inline code as placeholders
  const inlineCodes: string[] = [];
  processed = processed.replace(/`([^`\n]+)`/g, (_match, code: string) => {
    inlineCodes.push(`\`${code}\``);
    return `\x00IC${inlineCodes.length - 1}\x00`;
  });

  // Step 3: Horizontal rules -> remove
  processed = processed.replace(/^\s*[-*_]{3,}\s*$/gm, '');

  // Step 4: Headings -> *bold*
  processed = processed.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');

  // Step 5: Bold: **...** or __...__ -> *...*
  processed = processed.replace(/\*\*(.+?)\*\*/g, '*$1*');
  processed = processed.replace(/__(.+?)__/g, '*$1*');

  // Step 6: Italic: single *...* or _..._ -> _..._
  processed = processed.replace(/(?<![*_])\*([^*\n]+)\*(?![*_])/g, '_$1_');
  // _..._ is already Slack italic, leave as-is

  // Step 7: Strikethrough: ~~...~~ -> ~...~
  processed = processed.replace(/~~(.+?)~~/g, '~$1~');

  // Step 8: Links: [text](url) -> <url|text>
  processed = processed.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<$2|$1>',
  );

  // Step 9: Checkboxes
  processed = processed.replace(/^(\s*)- \[ \]/gm, '$1☐');
  processed = processed.replace(/^(\s*)- \[x\]/gim, '$1☑');

  // Step 10: Restore inline code placeholders
  processed = processed.replace(/\x00IC(\d+)\x00/g, (_match, idx: string) => {
    return inlineCodes[Number(idx)] ?? '';
  });

  // Step 11: Restore code block placeholders
  processed = processed.replace(/\x00CB(\d+)\x00/g, (_match, idx: string) => {
    return codeBlocks[Number(idx)] ?? '';
  });

  // Step 12: Collapse 3+ consecutive blank lines
  processed = processed.replace(/\n{3,}/g, '\n\n');

  return processed;
}
