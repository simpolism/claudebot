import 'dotenv/config';
import {
  Attachment,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Message,
  Partials,
  PrivateThreadChannel,
  PublicThreadChannel,
} from 'discord.js';
import Database from 'better-sqlite3';
import { createAIProvider } from './providers';
import { ImageBlock, SimpleMessage } from './types';

// ---------- Config ----------
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const MAIN_CHANNEL_ID = process.env.MAIN_CHANNEL_ID; // text channel id
const CLAUDE_MODEL =
  process.env.CLAUDE_MODEL || 'claude-haiku-4-5';
const MESSAGE_CACHE_LIMIT = parseInt(
  process.env.MESSAGE_CACHE_LIMIT || '500',
  10,
);
const BOOTSTRAP_MESSAGE_LIMIT = parseInt(
  process.env.BOOTSTRAP_MESSAGE_LIMIT || `${MESSAGE_CACHE_LIMIT}`,
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
const CLI_SIM_MODE = parseBooleanFlag(process.env.CLI_SIM_MODE);
const DEFAULT_SYSTEM_PROMPT =
  'The assistant is in CLI simulation mode, and responds to the user\'s CLI commands only with the output of the command.';
const SYSTEM_PROMPT = CLI_SIM_MODE ? DEFAULT_SYSTEM_PROMPT : '';
const PREFILL_COMMAND = CLI_SIM_MODE ? '<cmd>cat untitled.txt</cmd>' : '';
const AI_PROVIDER = (process.env.AI_PROVIDER || 'anthropic').toLowerCase();
const OPENAI_MODEL =
  process.env.OPENAI_MODEL || 'moonshotai/kimi-k2-instruct-0905';
const OPENAI_BASE_URL =
  process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

const STARTUP_CONFIG = {
  mainChannelId: MAIN_CHANNEL_ID || '(unset)',
  aiProvider: AI_PROVIDER,
  claudeModel: CLAUDE_MODEL,
  openaiModel: OPENAI_MODEL,
  openaiBaseURL: OPENAI_BASE_URL,
  messageCacheLimit: MESSAGE_CACHE_LIMIT,
  bootstrapMessageLimit: BOOTSTRAP_MESSAGE_LIMIT,
  maxContextTokens: MAX_CONTEXT_TOKENS,
  maxTokens: MAX_TOKENS,
  temperature: TEMPERATURE,
  cliSimulationMode: CLI_SIM_MODE,
  systemPrompt: `"${SYSTEM_PROMPT}"`,
  prefillCommand: `"${PREFILL_COMMAND}"`,
};

console.log('Starting bot with configuration:', STARTUP_CONFIG);

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

const countMessagesStmt = db.prepare<[], { count: number }>(`
  SELECT COUNT(*) as count FROM messages
`);

function parseBooleanFlag(value: string | undefined): boolean {
  if (!value) return false;
  switch (value.trim().toLowerCase()) {
    case '1':
    case 'true':
    case 'yes':
    case 'on':
      return true;
    default:
      return false;
  }
}

function saveMessage(
  channelId: string,
  role: 'user' | 'assistant',
  authorId: string,
  content: string,
  createdAt?: number,
) {
  insertMessageStmt.run(
    channelId,
    role,
    authorId,
    content,
    createdAt ?? Date.now(),
  );
  // keep only last N per channel/thread
  pruneOldMessagesStmt.run(channelId, MESSAGE_CACHE_LIMIT);
}

// ---------- Discord client ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

const aiProvider = createAIProvider({
  provider: AI_PROVIDER,
  systemPrompt: SYSTEM_PROMPT,
  prefillCommand: PREFILL_COMMAND,
  temperature: TEMPERATURE,
  maxTokens: MAX_TOKENS,
  anthropicModel: CLAUDE_MODEL,
  openaiModel: OPENAI_MODEL,
  openaiBaseURL: OPENAI_BASE_URL,
  openaiApiKey: OPENAI_API_KEY,
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

function isImageAttachment(attachment: Attachment): boolean {
  const contentType = attachment.contentType ?? '';
  return contentType.startsWith('image/') && Boolean(attachment.url);
}

function buildAttachmentSummary(
  attachments: Message['attachments'],
): string | null {
  const lines: string[] = [];

  attachments.forEach((attachment) => {
    if (!isImageAttachment(attachment)) return;

    const descriptorParts = [
      attachment.name || 'image',
      attachment.contentType || 'image',
    ];

    if (attachment.size) {
      const sizeKB = (attachment.size / 1024).toFixed(1);
      descriptorParts.push(`${sizeKB}KB`);
    }

    lines.push(`[Image: ${descriptorParts.join(' • ')}] ${attachment.url}`);
  });

  return lines.length ? lines.join('\n') : null;
}

function getImageBlocksFromAttachments(
  attachments: Message['attachments'],
): ImageBlock[] {
  const blocks: ImageBlock[] = [];

  attachments.forEach((attachment) => {
    if (!isImageAttachment(attachment)) return;

    blocks.push({
      type: 'image',
      source: {
        type: 'url',
        url: attachment.url,
      },
    });
  });

  return blocks;
}

function getUserCanonicalName(message: Message): string {
  return (
    message.author.username ??
    message.author.globalName ??
    message.author.tag
  );
}

function getBotCanonicalName(): string {
  return (
    client.user?.username ??
    client.user?.globalName ??
    client.user?.tag ??
    'Claude Bot'
  );
}

function formatAuthoredContent(authorName: string, content: string): string {
  const normalized = content.trim();
  const finalContent = normalized.length ? normalized : '(empty message)';
  return `${authorName}: ${finalContent}`;
}

const USER_MENTION_REGEX = /<@!?(\d+)>/g;

function formatMentionName(user: Message['author']): string {
  return (
    user.username ??
    user.globalName ??
    user.tag
  );
}

function replaceUserMentions(content: string, message: Message): string {
  if (!content) return content;
  return content.replace(USER_MENTION_REGEX, (match, userId) => {
    const mentionedUser =
      message.mentions.users.get(userId) ??
      client.users.cache.get(userId) ??
      null;
    if (!mentionedUser) {
      return match;
    }
    return `@${formatMentionName(mentionedUser)}`;
  });
}

async function bootstrapHistory(): Promise<void> {
  const result = countMessagesStmt.get();
  const count = result?.count ?? 0;
  if (count > 0) {
    return;
  }

  if (!MAIN_CHANNEL_ID) {
    console.warn('Cannot bootstrap history: MAIN_CHANNEL_ID is unset.');
    return;
  }

  try {
    const channel = await client.channels.fetch(MAIN_CHANNEL_ID);
    if (!channel || !channel.isTextBased()) {
      console.warn(
        `Unable to bootstrap history: channel ${MAIN_CHANNEL_ID} is not text-based or could not be fetched.`,
      );
      return;
    }

    const collectedMessages: Message[] = [];
    let lastId: string | undefined;
    while (collectedMessages.length < BOOTSTRAP_MESSAGE_LIMIT) {
      const remaining = BOOTSTRAP_MESSAGE_LIMIT - collectedMessages.length;
      const fetchLimit = Math.min(remaining, 100);
      const fetched = await channel.messages.fetch({
        limit: fetchLimit,
        before: lastId,
      });

      if (fetched.size === 0) {
        break;
      }

      const newMessages = [...fetched.values()];
      collectedMessages.push(...newMessages);
      lastId = newMessages[newMessages.length - 1]?.id;
    }

    const sortedMessages = collectedMessages
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
      .slice(-BOOTSTRAP_MESSAGE_LIMIT);

    console.log(
      `Bootstrapping ${sortedMessages.length} historical message${
        sortedMessages.length === 1 ? '' : 's'
      } from channel ${MAIN_CHANNEL_ID}`,
    );

    for (const msg of sortedMessages) {
      const isAssistant =
        Boolean(client.user) && msg.author.id === client.user?.id;
      const role: 'user' | 'assistant' = isAssistant ? 'assistant' : 'user';
      const attachmentSummary = buildAttachmentSummary(msg.attachments);
      const messageContent = replaceUserMentions(
        msg.content || '(empty message)',
        msg,
      );
      const storedContent = attachmentSummary
        ? `${messageContent}\n${attachmentSummary}`
        : messageContent;
      const authorName = isAssistant
        ? getBotCanonicalName()
        : getUserCanonicalName(msg);

      saveMessage(
        msg.channel.id,
        role,
        msg.author.id,
        formatAuthoredContent(authorName, storedContent),
        msg.createdTimestamp,
      );
    }
  } catch (err) {
    console.error('Failed to bootstrap message history:', err);
  }
}

type TypingCapableChannel = Message['channel'] & {
  sendTyping: () => Promise<void>;
};

function hasTyping(channel: Message['channel']): channel is TypingCapableChannel {
  return !!channel && typeof (channel as TypingCapableChannel).sendTyping === 'function';
}

function startTypingIndicator(channel: Message['channel']): () => void {
  if (!hasTyping(channel)) {
    return () => {};
  }

  const textChannel: TypingCapableChannel = channel;
  let active = true;
  let timeout: NodeJS.Timeout | null = null;

  const scheduleNext = () => {
    if (!active) return;
    timeout = setTimeout(() => {
      void sendTyping();
    }, 9000);
  };

  const sendTyping = async () => {
    if (!active) return;
    try {
      await textChannel.sendTyping();
    } catch (err) {
      console.warn('Failed to send typing indicator:', err);
      active = false;
      return;
    }
    scheduleNext();
  };

  void sendTyping();

  return () => {
    active = false;
    if (timeout) {
      clearTimeout(timeout);
      timeout = null;
    }
  };
}

type SendCapableChannel = Message['channel'] & {
  send: (content: string) => Promise<Message>;
};

function hasSend(channel: Message['channel']): channel is SendCapableChannel {
  return !!channel && typeof (channel as SendCapableChannel).send === 'function';
}

// ---------- Events ----------
client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag}`);
  try {
    await bootstrapHistory();
  } catch (err) {
    console.error('Bootstrap history failed:', err);
  }
});

client.on(Events.MessageCreate, async (message) => {
  let stopTyping: (() => void) | null = null;
  try {
    const channelId = message.channel.id;
    const userContent = message.content || '(empty message)';
    const canCacheUserMessage = isInScope(message) && !message.author.bot;
    const attachmentSummary = buildAttachmentSummary(message.attachments);
    const userDisplayName = getUserCanonicalName(message);
    const normalizedUserText = replaceUserMentions(userContent, message);
    const storedUserContent = formatAuthoredContent(
      userDisplayName,
      attachmentSummary
        ? `${normalizedUserText}\n${attachmentSummary}`
        : normalizedUserText,
    );

    if (canCacheUserMessage) {
      saveMessage(
        channelId,
        'user',
        message.author.id,
        storedUserContent,
        message.createdTimestamp,
      );
    }

    if (!shouldRespond(message)) return;

    const botDisplayName = getBotCanonicalName();
    // Save user message for this channel/thread context
    // (already cached above when canCacheUserMessage true)

    // Build conversation (recent history + this new message)
    const conversation = buildConversation(channelId);

    // Call Claude
    stopTyping = startTypingIndicator(message.channel);
    const imageBlocks = getImageBlocksFromAttachments(message.attachments);
    const claudeReply = await aiProvider.send({
      conversation,
      botDisplayName,
      imageBlocks,
    });
    const replyText = claudeReply.text;
    stopTyping();
    stopTyping = null;

    // Send reply (chunked to satisfy Discord's message length limit)
    const replyChunks = chunkReplyText(replyText);
    let lastSent: Message | null = null;
    if (replyChunks.length > 0) {
      const [firstChunk, ...restChunks] = replyChunks;
      lastSent = await message.reply(firstChunk);
      saveMessage(
        channelId,
        'assistant',
        lastSent.author.id,
        formatAuthoredContent(botDisplayName, firstChunk),
        lastSent.createdTimestamp,
      );

      for (const chunk of restChunks) {
        if (hasSend(message.channel)) {
          lastSent = await message.channel.send(chunk);
        } else {
          lastSent = await message.reply(chunk);
        }
        saveMessage(
          channelId,
          'assistant',
          lastSent.author.id,
          formatAuthoredContent(botDisplayName, chunk),
          lastSent.createdTimestamp,
        );
      }
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
        "Sorry, I hit an error. Check the bot logs.",
      );
    } catch {
      // ignore
    }
  } finally {
    stopTyping?.();
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
