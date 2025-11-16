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
import { createAIProvider, AIProvider } from './providers';
import { ImageBlock, SimpleMessage, ConversationData } from './types';
import {
  activeBotConfigs,
  globalConfig,
  resolveConfig,
  BotConfig,
} from './config';
import {
  loadCache,
  getCachedBlocks,
  getLastCachedMessageId,
  updateCache,
} from './cache';

// ---------- Types ----------
interface BotInstance {
  config: BotConfig;
  client: Client;
  aiProvider: AIProvider;
}

// ---------- Utility Functions ----------
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

function isInScope(message: Message): boolean {
  const channel = message.channel;

  if (!globalConfig.mainChannelId) {
    return true;
  }

  if (isThreadChannel(channel)) {
    return channel.parentId === globalConfig.mainChannelId;
  }

  return channel.id === globalConfig.mainChannelId;
}

function shouldRespond(message: Message, client: Client): boolean {
  if (!isInScope(message)) return false;
  if (message.author.bot) return false;
  if (!client.user) return false;

  return message.mentions.has(client.user);
}

function estimateTokens(text: string): number {
  return Math.ceil(
    text.length / Math.max(globalConfig.approxCharsPerToken, 1),
  );
}

function getUserCanonicalName(message: Message): string {
  return (
    message.author.username ??
    message.author.globalName ??
    message.author.tag
  );
}

function getBotCanonicalName(client: Client): string {
  return (
    client.user?.username ??
    client.user?.globalName ??
    client.user?.tag ??
    'Bot'
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

function replaceUserMentions(
  content: string,
  message: Message,
  client: Client,
): string {
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

// ---------- Discord Message Fetching ----------
interface FetchedMessage {
  id: string;
  formattedText: string;
  tokens: number;
  role: 'user' | 'assistant';
}

// Fetch messages after a given message ID
async function fetchMessagesAfter(
  channel: Message['channel'],
  afterMessageId: string | null,
  tokenBudget: number,
  client: Client,
): Promise<FetchedMessage[]> {
  if (!channel.isTextBased()) {
    return [];
  }

  const messages: FetchedMessage[] = [];
  let totalTokens = 0;

  // Fetch all messages we need
  const allFetched: Message[] = [];
  let lastId: string | undefined;

  while (totalTokens < tokenBudget) {
    const fetched: Collection<string, Message> = await channel.messages.fetch({
      limit: 100,
      before: lastId,
    });

    if (fetched.size === 0) {
      break;
    }

    let reachedCachedMessage = false;
    for (const msg of fetched.values()) {
      // If we've reached the last cached message, stop
      if (afterMessageId && msg.id === afterMessageId) {
        reachedCachedMessage = true;
        break;
      }
      allFetched.push(msg);
    }

    if (reachedCachedMessage) {
      break;
    }

    lastId = fetched.last()?.id;
  }

  // Process in chronological order (oldest first)
  allFetched.reverse();

  for (const msg of allFetched) {
    const isAssistant =
      Boolean(client.user) && msg.author.id === client.user?.id;
    const role: 'user' | 'assistant' = isAssistant ? 'assistant' : 'user';
    const attachmentSummary = buildAttachmentSummary(msg.attachments);
    const messageContent = replaceUserMentions(
      msg.content || '(empty message)',
      msg,
      client,
    );
    const storedContent = attachmentSummary
      ? `${messageContent}\n${attachmentSummary}`
      : messageContent;
    const authorName = isAssistant
      ? getBotCanonicalName(client)
      : getUserCanonicalName(msg);

    const formattedText = formatAuthoredContent(authorName, storedContent);
    const tokens = estimateTokens(formattedText) + 4;

    if (totalTokens + tokens > tokenBudget) {
      break;
    }

    messages.push({
      id: msg.id,
      formattedText,
      tokens,
      role,
    });
    totalTokens += tokens;
  }

  return messages;
}

async function fetchConversationFromDiscord(
  channel: Message['channel'],
  maxContextTokens: number,
  client: Client,
): Promise<ConversationData> {
  if (!channel.isTextBased()) {
    return { cachedBlocks: [], tail: [] };
  }

  const channelId = channel.id;

  // Get existing cached blocks
  const existingCachedBlocks = getCachedBlocks(channelId);
  const lastCachedMessageId = getLastCachedMessageId(channelId);

  // Calculate token budget used by cached blocks
  const cachedTokens = existingCachedBlocks.reduce(
    (sum, block) => sum + block.tokenCount,
    0,
  );
  const remainingBudget = maxContextTokens - cachedTokens;

  // Fetch new messages after the last cached one
  const newMessages = await fetchMessagesAfter(
    channel,
    lastCachedMessageId,
    remainingBudget,
    client,
  );

  // Update cache if we have significant new messages
  // (This will create new cached blocks if needed)
  if (newMessages.length > 0) {
    updateCache(channelId, newMessages);
  }

  // Get potentially updated cached blocks
  const finalCachedBlocks = getCachedBlocks(channelId);
  const finalLastCachedId = getLastCachedMessageId(channelId);

  // Build the tail (messages after the last cached block)
  const tail: SimpleMessage[] = [];
  for (const msg of newMessages) {
    // Only include messages that aren't part of a cached block
    // Compare as BigInt since Discord snowflakes are numeric
    if (
      finalLastCachedId &&
      BigInt(msg.id) <= BigInt(finalLastCachedId)
    ) {
      continue;
    }
    tail.push({
      role: msg.role,
      content: msg.formattedText,
    });
  }

  const cachedBlockTexts = finalCachedBlocks.map((block) => block.text);
  const totalCachedTokens = finalCachedBlocks.reduce(
    (sum, block) => sum + block.tokenCount,
    0,
  );
  const tailTokens = tail.reduce(
    (sum, msg) => sum + estimateTokens(msg.content) + 4,
    0,
  );

  console.log(
    `[${getBotCanonicalName(client)}] Conversation: ${finalCachedBlocks.length} cached blocks (~${totalCachedTokens} tokens) + ${tail.length} tail messages (~${tailTokens} tokens)`,
  );

  return {
    cachedBlocks: cachedBlockTexts,
    tail,
  };
}

// ---------- Response Formatting ----------
function chunkReplyText(text: string): string[] {
  if (text.length <= globalConfig.discordMessageLimit) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= globalConfig.discordMessageLimit) {
      chunks.push(remaining);
      break;
    }

    let sliceEnd = globalConfig.discordMessageLimit;
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

function convertOutputMentions(
  text: string,
  channel: Message['channel'],
  client: Client,
): string {
  if (!channel.isTextBased()) return text;

  const usernameToId = new Map<string, string>();

  client.users.cache.forEach((user) => {
    usernameToId.set(user.username.toLowerCase(), user.id);
    if (user.globalName) {
      usernameToId.set(user.globalName.toLowerCase(), user.id);
    }
  });

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

  return text.replace(/@(\w+)/g, (match, name) => {
    const id = usernameToId.get(name.toLowerCase());
    return id ? `<@${id}>` : match;
  });
}

// ---------- Typing Indicator ----------
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

// ---------- Bot Instance Setup ----------
function createBotInstance(botConfig: BotConfig): BotInstance {
  const resolved = resolveConfig(botConfig);

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel, Partials.Message],
  });

  const systemPrompt = resolved.cliSimMode
    ? "The assistant is in CLI simulation mode, and responds to the user's CLI commands only with the output of the command."
    : '';

  const prefillCommand = resolved.cliSimMode
    ? '<cmd>cat untitled.txt</cmd>'
    : '';

  const aiProvider = createAIProvider({
    provider: resolved.provider,
    systemPrompt,
    prefillCommand,
    temperature: resolved.temperature,
    maxTokens: resolved.maxTokens,
    maxContextTokens: resolved.maxContextTokens,
    approxCharsPerToken: globalConfig.approxCharsPerToken,
    anthropicModel: resolved.model,
    openaiModel: resolved.model,
    openaiBaseURL: resolved.openaiBaseUrl || 'https://api.openai.com/v1',
    openaiApiKey: resolved.openaiApiKey || '',
  });

  return { config: botConfig, client, aiProvider };
}

function setupBotEvents(instance: BotInstance): void {
  const { config, client, aiProvider } = instance;
  const resolved = resolveConfig(config);

  client.once(Events.ClientReady, (c) => {
    console.log(`[${config.name}] Logged in as ${c.user.tag}`);
  });

  client.on(Events.MessageCreate, async (message) => {
    let stopTyping: (() => void) | null = null;
    try {
      if (!shouldRespond(message, client)) return;

      const channelId = message.channel.id;
      const botDisplayName = getBotCanonicalName(client);

      const conversationData = await fetchConversationFromDiscord(
        message.channel,
        resolved.maxContextTokens,
        client,
      );

      stopTyping = startTypingIndicator(message.channel);
      const imageBlocks = getImageBlocksFromAttachments(message.attachments);
      const aiReply = await aiProvider.send({
        conversationData,
        botDisplayName,
        imageBlocks,
      });
      const replyText = aiReply.text;
      stopTyping();
      stopTyping = null;

      const formattedReplyText = convertOutputMentions(
        replyText,
        message.channel,
        client,
      );

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
        `[${config.name}] Replied in channel ${channelId} to ${message.author.tag} (${replyText.length} chars, ${replyChunks.length} chunk${
          replyChunks.length === 1 ? '' : 's'
        })`,
      );
    } catch (err) {
      console.error(`[${config.name}] Error handling message:`, err);
      try {
        await message.reply('Sorry, I hit an error. Check the bot logs.');
      } catch {
        // ignore
      }
    } finally {
      stopTyping?.();
    }
  });
}

// ---------- Main ----------
async function main(): Promise<void> {
  // Load conversation cache for stable prompt caching
  loadCache();

  console.log('Starting multi-bot system with configuration:', {
    mainChannelId: globalConfig.mainChannelId || '(unset)',
    maxContextTokens: globalConfig.maxContextTokens,
    maxTokens: globalConfig.maxTokens,
    temperature: globalConfig.temperature,
    bots: activeBotConfigs.map((c) => ({
      name: c.name,
      provider: c.provider,
      model: c.model,
    })),
  });

  if (activeBotConfigs.length === 0) {
    console.error('No bots configured with valid tokens. Exiting.');
    process.exit(1);
  }

  const instances: BotInstance[] = [];

  for (const config of activeBotConfigs) {
    const instance = createBotInstance(config);
    setupBotEvents(instance);
    instances.push(instance);
  }

  // Login all bots
  const loginPromises = instances.map(async (instance) => {
    try {
      await instance.client.login(instance.config.discordToken);
      console.log(`[${instance.config.name}] Login successful`);
    } catch (err) {
      console.error(`[${instance.config.name}] Failed to login:`, err);
      throw err;
    }
  });

  try {
    await Promise.all(loginPromises);
    console.log('All bots logged in successfully');
  } catch (err) {
    console.error('One or more bots failed to login. Exiting.');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
