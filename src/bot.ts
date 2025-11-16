import 'dotenv/config';
import {
  Attachment,
  ChannelType,
  Client,
  Collection,
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
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-4-5';
const MAX_CONTEXT_TOKENS = parseInt(
  process.env.MAX_CONTEXT_TOKENS || '100000',
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
  "The assistant is in CLI simulation mode, and responds to the user's CLI commands only with the output of the command.";
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
  maxContextTokens: MAX_CONTEXT_TOKENS,
  maxTokens: MAX_TOKENS,
  temperature: TEMPERATURE,
  cliSimulationMode: CLI_SIM_MODE,
  systemPrompt: `"${SYSTEM_PROMPT}"`,
  prefillCommand: `"${PREFILL_COMMAND}"`,
};

console.log('Starting bot with configuration:', STARTUP_CONFIG);

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

function estimateTokens(text: string): number {
  return Math.ceil(text.length / Math.max(APPROX_CHARS_PER_TOKEN, 1));
}

// Fetch messages from a channel until we hit a token budget
async function fetchMessagesWithTokenBudget(
  channel: Message['channel'],
  tokenBudget: number,
): Promise<{ messages: SimpleMessage[]; tokensUsed: number }> {
  if (!channel.isTextBased()) {
    return { messages: [], tokensUsed: 0 };
  }

  const messages: SimpleMessage[] = [];
  let totalTokens = 0;
  let lastId: string | undefined;

  while (totalTokens < tokenBudget) {
    const fetched: Collection<string, Message> = await channel.messages.fetch({
      limit: 100,
      before: lastId,
    });

    if (fetched.size === 0) {
      break;
    }

    for (const msg of fetched.values()) {
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

      const formattedContent = formatAuthoredContent(authorName, storedContent);
      const messageTokens = estimateTokens(formattedContent) + 4;

      if (totalTokens + messageTokens > tokenBudget) {
        break;
      }

      messages.push({
        role,
        content: formattedContent,
      });
      totalTokens += messageTokens;
    }

    if (totalTokens >= tokenBudget) {
      break;
    }

    lastId = fetched.last()?.id;
  }

  messages.reverse();
  return { messages, tokensUsed: totalTokens };
}

// Fetch messages from Discord until we hit the soft token limit
// For threads, includes parent channel context
async function fetchConversationFromDiscord(
  channel: Message['channel'],
): Promise<SimpleMessage[]> {
  if (!channel.isTextBased()) {
    return [];
  }

  let parentContext: SimpleMessage[] = [];
  let parentTokens = 0;

  // If this is a thread, fetch some parent channel context first
  if (isThreadChannel(channel) && channel.parent?.isTextBased()) {
    // Reserve up to 20% of token budget for parent context
    const parentBudget = Math.floor(MAX_CONTEXT_TOKENS * 0.2);
    const parentResult = await fetchMessagesWithTokenBudget(
      channel.parent,
      parentBudget,
    );
    parentContext = parentResult.messages;
    parentTokens = parentResult.tokensUsed;

    if (parentContext.length > 0) {
      // Add a separator to indicate transition to thread
      const separatorContent = '--- Thread started ---';
      const separatorTokens = estimateTokens(separatorContent) + 4;
      parentContext.push({
        role: 'user',
        content: separatorContent,
      });
      parentTokens += separatorTokens;

      console.log(
        `Fetched ${parentContext.length - 1} parent channel messages (~${parentTokens} tokens)`,
      );
    }
  }

  // Fetch thread/channel messages with remaining budget
  const remainingBudget = MAX_CONTEXT_TOKENS - parentTokens;
  const { messages: channelMessages, tokensUsed: channelTokens } =
    await fetchMessagesWithTokenBudget(channel, remainingBudget);

  const totalMessages = [...parentContext, ...channelMessages];
  const totalTokens = parentTokens + channelTokens;

  console.log(
    `Total conversation: ${totalMessages.length} messages (~${totalTokens} tokens)`,
  );

  return totalMessages;
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
  return user.username ?? user.globalName ?? user.tag;
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

// Convert @Username in bot output back to Discord mention format
function convertOutputMentions(
  text: string,
  channel: Message['channel'],
): string {
  if (!channel.isTextBased()) return text;

  // Build a map of usernames to user IDs
  const usernameToId = new Map<string, string>();

  // Add all users the client knows about
  client.users.cache.forEach((user) => {
    usernameToId.set(user.username.toLowerCase(), user.id);
    if (user.globalName) {
      usernameToId.set(user.globalName.toLowerCase(), user.id);
    }
  });

  // Also check guild members if available (for nicknames)
  if ('guild' in channel && channel.guild) {
    channel.guild.members.cache.forEach((member) => {
      usernameToId.set(member.user.username.toLowerCase(), member.user.id);
      if (member.nickname) {
        usernameToId.set(member.nickname.toLowerCase(), member.user.id);
      }
      if (member.user.globalName) {
        usernameToId.set(member.user.globalName.toLowerCase(), member.user.id);
      }
    });
  }

  // Replace @Username patterns with <@id>
  return text.replace(/@(\w+)/g, (match, name) => {
    const id = usernameToId.get(name.toLowerCase());
    return id ? `<@${id}>` : match;
  });
}

type TypingCapableChannel = Message['channel'] & {
  sendTyping: () => Promise<void>;
};

function hasTyping(
  channel: Message['channel'],
): channel is TypingCapableChannel {
  return (
    !!channel &&
    typeof (channel as TypingCapableChannel).sendTyping === 'function'
  );
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
  return (
    !!channel && typeof (channel as SendCapableChannel).send === 'function'
  );
}

// ---------- Events ----------
client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag}`);
});

client.on(Events.MessageCreate, async (message) => {
  let stopTyping: (() => void) | null = null;
  try {
    if (!shouldRespond(message)) return;

    const channelId = message.channel.id;
    const botDisplayName = getBotCanonicalName();

    // Fetch conversation history from Discord
    const conversation = await fetchConversationFromDiscord(message.channel);

    // Call AI provider
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

    // Convert @Username mentions in output to Discord format
    const formattedReplyText = convertOutputMentions(
      replyText,
      message.channel,
    );

    // Send reply (chunked to satisfy Discord's message length limit)
    const replyChunks = chunkReplyText(formattedReplyText);
    let lastSent: Message | null = null;
    if (replyChunks.length > 0) {
      const [firstChunk, ...restChunks] = replyChunks;
      lastSent = await message.reply(firstChunk);

      for (const chunk of restChunks) {
        if (hasSend(message.channel)) {
          lastSent = await message.channel.send(chunk);
        } else {
          lastSent = await message.reply(chunk);
        }
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
      await message.reply('Sorry, I hit an error. Check the bot logs.');
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
