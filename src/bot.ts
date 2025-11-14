import 'dotenv/config';
import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Message,
  Partials,
  PrivateThreadChannel,
  PublicThreadChannel,
} from 'discord.js';
import Anthropic from '@anthropic-ai/sdk';
import Database from 'better-sqlite3';

// ---------- Config ----------
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const MAIN_CHANNEL_ID = process.env.MAIN_CHANNEL_ID; // text channel id
const CLAUDE_MODEL =
  process.env.CLAUDE_MODEL || 'claude-haiku-4-5';
const MESSAGE_CACHE_LIMIT = parseInt(
  process.env.MESSAGE_CACHE_LIMIT || '500',
  10,
);
const MAX_CONTEXT_TOKENS = parseInt(
  process.env.MAX_CONTEXT_TOKENS || '180000',
  10,
);
const APPROX_CHARS_PER_TOKEN = parseFloat(
  process.env.APPROX_CHARS_PER_TOKEN || '4',
);
const DISCORD_MESSAGE_LIMIT = 2000;
const MAX_TOKENS = parseInt(process.env.MAX_TOKENS || '1024', 10);
const TEMPERATURE = parseFloat(process.env.TEMPERATURE || '1');
const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT || '';

// ---------- SQLite setup (file-based cache) ----------
const db = new Database('claude-cache.sqlite');
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
  author_id TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_channel_created_at
  ON messages(channel_id, created_at);
`);

const insertMessageStmt = db.prepare<
  [channelId: string, role: string, authorId: string, content: string, createdAt: number]
>(`
  INSERT INTO messages (channel_id, role, author_id, content, created_at)
  VALUES (?, ?, ?, ?, ?)
`);

const getRecentMessagesStmt = db.prepare<[channelId: string, limit: number]>(`
  SELECT role, content
  FROM messages
  WHERE channel_id = ?
  ORDER BY created_at DESC
  LIMIT ?
`);

const pruneOldMessagesStmt = db.prepare<[channelId: string, offset: number]>(`
  DELETE FROM messages
  WHERE id IN (
    SELECT id FROM messages
    WHERE channel_id = ?
    ORDER BY created_at DESC
    LIMIT -1 OFFSET ?
  )
`);

function saveMessage(
  channelId: string,
  role: 'user' | 'assistant',
  authorId: string,
  content: string,
) {
  insertMessageStmt.run(channelId, role, authorId, content, Date.now());
  // keep only last N per channel/thread
  pruneOldMessagesStmt.run(channelId, MESSAGE_CACHE_LIMIT);
}

type SimpleMessage = {
  role: 'user' | 'assistant';
  content: string;
};

// ---------- Anthropic (Claude) client with prompt caching beta ----------
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  // enable prompt-caching beta globally for this client 
  defaultHeaders: {
    'anthropic-beta': 'prompt-caching-2024-07-31',
  },
});

// ---------- Discord client ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

type TextThreadChannel = PublicThreadChannel | PrivateThreadChannel;

function isThreadChannel(
  channel: Message['channel'],
): channel is TextThreadChannel {
  return (
    channel.type === ChannelType.PublicThread ||
    channel.type === ChannelType.PrivateThread ||
    channel.type === ChannelType.AnnouncementThread
  );
}

// In-scope = main channel OR threads under that channel
function isInScope(message: Message): boolean {
  const channel = message.channel;

  if (!MAIN_CHANNEL_ID) {
    // if not set, respond anywhere (probably not what you want in production)
    return true;
  }

  if (isThreadChannel(channel)) {
    return channel.parentId === MAIN_CHANNEL_ID;
  }

  return channel.id === MAIN_CHANNEL_ID;
}

// We now *only* respond when explicitly mentioned, even in threads
function shouldRespond(message: Message): boolean {
  if (!isInScope(message)) return false;
  if (message.author.bot) return false;
  if (!client.user) return false;

  return message.mentions.has(client.user);
}

// Build conversation from cached messages for this channel/thread
function buildConversation(channelId: string): SimpleMessage[] {
  const rows = getRecentMessagesStmt.all(channelId, MESSAGE_CACHE_LIMIT) as {
    role: 'user' | 'assistant';
    content: string;
  }[];

  // DB returns newest first; reverse to oldest-first
  rows.reverse();

  const messages = rows.map((row) => ({
    role: row.role,
    content: row.content,
  }));

  return trimConversation(messages);
}

// Call Claude with Anthropic prompt caching on the system prompt
async function callClaude(conversation: SimpleMessage[]): Promise<string> {
  const response = await anthropic.messages.create(
    {
      model: CLAUDE_MODEL,
      max_tokens: MAX_TOKENS,
      temperature: TEMPERATURE,
      // SYSTEM_PROMPT can be long; we mark it cacheable
      system: [
        {
          type: 'text' as const,
          text: SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' as const },
        },
      ],
      messages: conversation.map((msg) => ({
        role: msg.role,
        content: msg.content,
      })),
    },
  );

  const text =
    (response.content || [])
      .map((block: any) => block.text ?? '')
      .join('\n')
      .trim() || '(no response text)';

  return text;
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

    if (
      trimmed.length > 0 &&
      totalTokens + messageTokens > MAX_CONTEXT_TOKENS
    ) {
      break;
    }

    totalTokens += messageTokens;
    trimmed.push(message);
  }

  return trimmed.reverse();
}

function chunkReplyText(text: string): string[] {
  if (text.length <= DISCORD_MESSAGE_LIMIT) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= DISCORD_MESSAGE_LIMIT) {
      chunks.push(remaining);
      break;
    }

    let sliceEnd = DISCORD_MESSAGE_LIMIT;
    const newlineIndex = remaining.lastIndexOf('\n', sliceEnd);
    const spaceIndex = remaining.lastIndexOf(' ', sliceEnd);
    const breakIndex = Math.max(newlineIndex, spaceIndex);

    if (breakIndex > sliceEnd * 0.5) {
      sliceEnd = breakIndex;
    }

    const chunk = remaining.slice(0, sliceEnd).trimEnd();
    chunks.push(chunk);
    remaining = remaining.slice(sliceEnd).trimStart();
  }

  return chunks;
}

// ---------- Events ----------
client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag}`);
});

client.on(Events.MessageCreate, async (message) => {
  try {
    if (!shouldRespond(message)) return;

    const channelId = message.channel.id;
    const userContent = message.content || '(empty message)';

    // Save user message for this channel/thread context
    saveMessage(channelId, 'user', message.author.id, userContent);

    // Build conversation (recent history + this new message)
    const conversation = buildConversation(channelId);

    // Call Claude
    const replyText = await callClaude(conversation);

    // Send reply (chunked to satisfy Discord's message length limit)
    const replyChunks = chunkReplyText(replyText);
    let lastSent: Message | null = null;
    for (const chunk of replyChunks) {
      lastSent = await message.reply(chunk);
      saveMessage(channelId, 'assistant', lastSent.author.id, chunk);
    }

    console.log(
      `Replied in channel ${channelId} to ${message.author.tag} (${replyText.length} chars, ${replyChunks.length} chunk${
        replyChunks.length === 1 ? '' : 's'
      })`,
    );
  } catch (err) {
    console.error('Error handling message:', err);
    try {
      await message.reply(
        "Sorry, I hit an error talking to Claude. Check the bot logs / Anthropic config.",
      );
    } catch {
      // ignore
    }
  }
});

// ---------- Start ----------
if (!DISCORD_TOKEN) {
  console.error('Missing DISCORD_TOKEN in .env');
  process.exit(1);
}

client.login(DISCORD_TOKEN).catch((err) => {
  console.error('Failed to login to Discord:', err);
  process.exit(1);
});
