import {
  getDb,
  insertMemory,
  searchMemories,
  getRecentMemories,
  touchMemory,
  decayAllMemories,
  getMemoryStats,
  logConversationTurn,
  pruneConversationLog,
} from './db.js';
import { logger } from './logger.js';

const MAX_MEMORIES_PER_CHAT = 200;

// ── Context Builder ────────────────────────────────────────────────────
//
// Before each agent call, we build a memory context string that is
// prepended to the user's message. This gives the agent awareness of
// prior knowledge without requiring full conversation replay.

const SEARCH_LIMIT = 3;
const RECENT_LIMIT = 5;

export function buildMemoryContext(chatId: string, userMessage: string): string {
  const searchResults = searchMemories(chatId, userMessage, SEARCH_LIMIT);
  const recentMemories = getRecentMemories(chatId, RECENT_LIMIT);

  // Deduplicate: recent may overlap with search results
  const seen = new Set(searchResults.map((m) => m.id));
  const uniqueRecent = recentMemories.filter((m) => !seen.has(m.id));

  // Touch accessed memories to boost salience
  for (const m of searchResults) {
    touchMemory(m.id, 0.1);
  }

  const parts: string[] = [];

  if (searchResults.length > 0) {
    parts.push('## Relevant Memories');
    for (const m of searchResults) {
      parts.push(`- [${m.sector}] ${m.content}`);
    }
  }

  if (uniqueRecent.length > 0) {
    parts.push('## Recent Memories');
    for (const m of uniqueRecent) {
      parts.push(`- [${m.sector}] ${m.content}`);
    }
  }

  if (parts.length === 0) return '';

  return `<memory-context>\n${parts.join('\n')}\n</memory-context>\n\n`;
}

// ── Save Conversation Turn ─────────────────────────────────────────────
//
// After each exchange, we decide whether to save the user's message
// and/or the agent's response as memories.
// Also logs both sides to conversation_log for /respin support.

export function saveConversationTurn(
  chatId: string,
  userMessage: string,
  agentResponse: string,
  sessionId?: string,
): void {
  // Always log full conversation to conversation_log (for /respin)
  logConversationTurn(chatId, 'user', userMessage, sessionId);
  logConversationTurn(chatId, 'assistant', agentResponse, sessionId);

  // Save user message as episodic memory (short-lived, decays)
  if (userMessage.length > 20 && !userMessage.startsWith('/')) {
    insertMemory(chatId, truncate(userMessage, 500), 'episodic');
  }

  // Check if the agent response contains facts worth saving as semantic memory
  const semanticFacts = extractSemanticFacts(agentResponse);
  for (const fact of semanticFacts) {
    insertMemory(chatId, fact, 'semantic');
  }

  // Prune if over cap
  pruneExcessMemories(chatId);
}

// ── Semantic Fact Detection ────────────────────────────────────────────
//
// Simple heuristic: lines that look like they contain durable knowledge.
// This is intentionally conservative -- we'd rather miss some facts
// than pollute memory with noise.

const SEMANTIC_PATTERNS = [
  /(?:remember|note|important|key fact|fyi|for reference):\s*(.+)/i,
  /(?:your|the) (?:name|email|phone|address|birthday|preference) (?:is|are)\s+(.+)/i,
  /(?:i (?:always|prefer|like|use|want|need))\s+(.+)/i,
  /(?:don't forget|keep in mind|worth noting):\s*(.+)/i,
];

function extractSemanticFacts(text: string): string[] {
  const facts: string[] = [];
  const lines = text.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length < 10 || trimmed.length > 500) continue;

    for (const pattern of SEMANTIC_PATTERNS) {
      const match = pattern.exec(trimmed);
      if (match?.[1]) {
        facts.push(truncate(match[1].trim(), 300));
        break;
      }
    }
  }

  return facts;
}

// ── Memory Pruning ─────────────────────────────────────────────────────

function pruneExcessMemories(chatId: string): void {
  const stats = getMemoryStats(chatId);
  if (stats.total <= MAX_MEMORIES_PER_CHAT) return;

  const excess = stats.total - MAX_MEMORIES_PER_CHAT;
  const result = getDb()
    .prepare(
      `DELETE FROM memories WHERE id IN (
        SELECT id FROM memories WHERE chat_id = ?
        ORDER BY salience ASC, accessed_at ASC
        LIMIT ?
      )`,
    )
    .run(chatId, excess);
  logger.info({ chatId, pruned: result.changes }, 'Pruned excess memories');
}

// ── Decay Sweep ────────────────────────────────────────────────────────

export function runDecaySweep(): void {
  const { decayed, deleted } = decayAllMemories();
  if (decayed > 0 || deleted > 0) {
    logger.info({ decayed, deleted }, 'Memory decay sweep completed');
  }
  // Also prune old conversation log entries to prevent unbounded growth
  pruneConversationLog(500);
}

// ── Utilities ──────────────────────────────────────────────────────────

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}

export { getMemoryStats };
