import 'dotenv/config';
import Database from 'better-sqlite3';

type Role = 'user' | 'assistant';

type CachedMessage = {
  role: Role;
  content: string;
  created_at: number;
};

type SimpleMessage = {
  role: Role;
  content: string;
};

const MESSAGE_CACHE_LIMIT = parseInt(process.env.MESSAGE_CACHE_LIMIT || '500', 10);
const MAX_CONTEXT_TOKENS = parseInt(process.env.MAX_CONTEXT_TOKENS || '180000', 10);
const APPROX_CHARS_PER_TOKEN = parseFloat(process.env.APPROX_CHARS_PER_TOKEN || '4');

const args = process.argv.slice(2);
const channelId = args[0];
const showRaw = args.includes('--raw');

if (!channelId) {
  console.error('Usage: npx ts-node scripts/inspect-context.ts <channel_id> [--raw]');
  process.exit(1);
}

const db = new Database('claude-cache.sqlite');

function fetchMessages(id: string): CachedMessage[] {
  const stmt = db.prepare(
    `
      SELECT role, content, created_at
      FROM messages
      WHERE channel_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `,
  );
  const rows = stmt.all(id, MESSAGE_CACHE_LIMIT) as CachedMessage[];
  rows.reverse();
  return rows;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / Math.max(APPROX_CHARS_PER_TOKEN, 1));
}

function trimConversation(messages: SimpleMessage[]): SimpleMessage[] {
  let totalTokens = 0;
  const trimmed: SimpleMessage[] = [];

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    const messageTokens = estimateTokens(message.content) + 4;

    if (trimmed.length > 0 && totalTokens + messageTokens > MAX_CONTEXT_TOKENS) {
      break;
    }

    totalTokens += messageTokens;
    trimmed.push(message);
  }

  return trimmed.reverse();
}

function summarize(messages: SimpleMessage[]): void {
  let totalTokens = 0;
  console.log(`Context window for channel/thread ${channelId}`);
  console.log(`Messages included: ${messages.length}`);
  console.log('---');
  messages.forEach((message, index) => {
    const estimated = estimateTokens(message.content) + 4;
    totalTokens += estimated;
    console.log(`[${index + 1}] ${message.role.toUpperCase()} (${estimated} tokens est.)`);
    console.log(message.content);
    console.log('---');
  });
  console.log(`Estimated tokens (including padding): ${totalTokens}`);
}

const cached = fetchMessages(channelId);
if (cached.length === 0) {
  console.log(`No cached messages for channel ${channelId}.`);
  process.exit(0);
}

const transformed: SimpleMessage[] = cached.map((message) => ({
  role: message.role,
  content: message.content,
}));

const windowMessages = showRaw ? transformed : trimConversation(transformed);

if (!showRaw && windowMessages.length !== transformed.length) {
  console.log(
    `Trimmed ${transformed.length - windowMessages.length} older message(s) to satisfy MAX_CONTEXT_TOKENS=${MAX_CONTEXT_TOKENS}.`,
  );
}

summarize(windowMessages);
