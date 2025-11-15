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

// ---------- In-memory conversation cache ----------
type CachedMessage = SimpleMessage & {
  messageId?: string;
  authorId: string;
  createdAt: number;
};

const channelHistories = new Map<string, CachedMessage[]>();
const bootstrappedChannels = new Set<string>();
const channelBootstrapPromises = new Map<string, Promise<void>>();

function ensureChannelHistory(channelId: string): CachedMessage[] {
  let history = channelHistories.get(channelId);
  if (!history) {
    history = [];
    channelHistories.set(channelId, history);
  }
  return history;
}

function hasCachedMessage(channelId: string, messageId?: string): boolean {
  if (!messageId) return false;
  const history = channelHistories.get(channelId);
  if (!history) return false;
  return history.some((entry) => entry.messageId === messageId);
}

function appendCachedMessage(channelId: string, entry: CachedMessage): void {
  if (entry.messageId && hasCachedMessage(channelId, entry.messageId)) {
    return;
  }
  const history = ensureChannelHistory(channelId);
  history.push(entry);
  trimHistoryToLimit(history);
}

function prependCachedMessages(
  channelId: string,
  entries: CachedMessage[],
): void {
  if (entries.length === 0) return;
  const history = ensureChannelHistory(channelId);
  const historyIds = new Set(
    history.map((entry) => entry.messageId).filter(Boolean) as string[],
  );
  const deduped = entries.filter((entry) => {
    if (!entry.messageId) return true;
    return !historyIds.has(entry.messageId);
  });
  if (deduped.length === 0) {
    return;
  }
  history.unshift(...deduped);
  trimHistoryToLimit(history);
}

function trimHistoryToLimit(history: CachedMessage[]): void {
  if (history.length <= MESSAGE_CACHE_LIMIT) {
    return;
  }
  const excess = history.length - MESSAGE_CACHE_LIMIT;
  history.splice(0, excess);
}

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
  maxContextTokens: MAX_CONTEXT_TOKENS,
  approxCharsPerToken: APPROX_CHARS_PER_TOKEN,
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
  const history = channelHistories.get(channelId);
  if (!history || history.length === 0) {
    return [];
  }
  const messages = history.map((entry) => ({
    role: entry.role,
    content: entry.content,
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

async function ensureChannelBootstrapped(
  channelId: string | null | undefined,
): Promise<void> {
  if (!channelId) return;
  if (bootstrappedChannels.has(channelId)) {
    return;
  }

  const existing = channelBootstrapPromises.get(channelId);
  if (existing) {
    await existing;
    return;
  }

  const bootstrapPromise = bootstrapChannelHistory(channelId)
    .then(() => {
      bootstrappedChannels.add(channelId);
    })
    .finally(() => {
      channelBootstrapPromises.delete(channelId);
    });

  channelBootstrapPromises.set(channelId, bootstrapPromise);
  await bootstrapPromise;
}

async function bootstrapChannelHistory(channelId: string): Promise<void> {
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) {
      console.warn(
        `Unable to bootstrap history: channel ${channelId} is not text-based or could not be fetched.`,
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

    if (sortedMessages.length === 0) {
      console.log(`No historical messages to bootstrap for ${channelId}.`);
      return;
    }

    const cachedEntries: CachedMessage[] = sortedMessages.map((msg) => {
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

      return {
        role,
        authorId: msg.author.id,
        content: formatAuthoredContent(authorName, storedContent),
        messageId: msg.id,
        createdAt: msg.createdTimestamp ?? Date.now(),
      };
    });

    prependCachedMessages(channelId, cachedEntries);
    console.log(
      `Bootstrapped ${cachedEntries.length} historical message${
        cachedEntries.length === 1 ? '' : 's'
      } for channel ${channelId}`,
    );
  } catch (err) {
    console.error(`Failed to bootstrap message history for ${channelId}:`, err);
    throw err;
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
  if (MAIN_CHANNEL_ID) {
    try {
      await ensureChannelBootstrapped(MAIN_CHANNEL_ID);
    } catch (err) {
      console.error('Main channel bootstrap failed:', err);
    }
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
      appendCachedMessage(channelId, {
        role: 'user',
        authorId: message.author.id,
        content: storedUserContent,
        messageId: message.id,
        createdAt: message.createdTimestamp ?? Date.now(),
      });
    }

    if (!shouldRespond(message)) return;

    try {
      await ensureChannelBootstrapped(channelId);
    } catch (err) {
      console.warn(
        `Failed to bootstrap history for channel ${channelId}, continuing with limited context.`,
        err,
      );
    }

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
      appendCachedMessage(channelId, {
        role: 'assistant',
        authorId: lastSent.author.id,
        content: formatAuthoredContent(botDisplayName, firstChunk),
        messageId: lastSent.id,
        createdAt: lastSent.createdTimestamp ?? Date.now(),
      });

      for (const chunk of restChunks) {
        if (hasSend(message.channel)) {
          lastSent = await message.channel.send(chunk);
        } else {
          lastSent = await message.reply(chunk);
        }
        appendCachedMessage(channelId, {
          role: 'assistant',
          authorId: lastSent.author.id,
          content: formatAuthoredContent(botDisplayName, chunk),
          messageId: lastSent.id,
          createdAt: lastSent.createdTimestamp ?? Date.now(),
        });
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
