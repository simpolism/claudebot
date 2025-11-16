import 'dotenv/config';
import { Client, Events, GatewayIntentBits, Message, Partials } from 'discord.js';
import { createAIProvider, AIProvider } from './providers';
import { activeBotConfigs, globalConfig, resolveConfig, BotConfig } from './config';
import { loadCache } from './cache';
import {
  buildConversationContext,
  getImageBlocksFromAttachments,
  isThreadChannel,
} from './context';
import { chunkReplyText, convertOutputMentions } from './discord-utils';

// ---------- Types ----------
interface BotInstance {
  config: BotConfig;
  client: Client;
  aiProvider: AIProvider;
}

// ---------- Bot-to-Bot Exchange Tracking ----------
// Track consecutive bot messages per channel to prevent infinite loops
const consecutiveBotMessages = new Map<string, number>();
const MAX_CONSECUTIVE_BOT_EXCHANGES = 3;

// ---------- Channel Processing Locks ----------
// Prevent duplicate responses when bot is tagged multiple times quickly
// Key format: "botId:channelId"
const processingChannels = new Set<string>();

const allowedRootChannels = new Set(globalConfig.mainChannelIds);

function isChannelAllowed(channelId: string | null | undefined): boolean {
  if (allowedRootChannels.size === 0) {
    return true;
  }
  if (!channelId) {
    return false;
  }
  return allowedRootChannels.has(channelId);
}

// ---------- Utility Functions ----------

function isInScope(message: Message): boolean {
  const channel = message.channel;

  if (allowedRootChannels.size === 0) {
    return true;
  }

  if (isThreadChannel(channel)) {
    return isChannelAllowed(channel.parentId);
  }

  return isChannelAllowed(channel.id);
}

function shouldRespond(message: Message, client: Client): boolean {
  if (!isInScope(message)) return false;
  if (message.author.bot) return false;
  if (!client.user) return false;

  if (!message.mentions.has(client.user)) return false;

  // Check bot-to-bot exchange limit
  const channelId = message.channel.id;
  const currentCount = consecutiveBotMessages.get(channelId) || 0;
  if (currentCount >= MAX_CONSECUTIVE_BOT_EXCHANGES) {
    console.log(
      `[${client.user.username}] Skipping response in ${channelId} - bot exchange limit reached (${currentCount}/${MAX_CONSECUTIVE_BOT_EXCHANGES})`,
    );
    return false;
  }

  return true;
}

function getBotCanonicalName(client: Client): string {
  return client.user?.username ?? client.user?.globalName ?? client.user?.tag ?? 'Bot';
}

// ---------- Typing Indicator ----------
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

  const prefillCommand = resolved.cliSimMode ? '<cmd>cat untitled.txt</cmd>' : '';

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
    supportsImageBlocks: Boolean(botConfig.supportsImageBlocks),
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
      // Track bot-to-bot exchanges
      if (isInScope(message)) {
        const channelId = message.channel.id;
        if (message.author.bot) {
          // Bot message: increment counter
          const current = consecutiveBotMessages.get(channelId) || 0;
          consecutiveBotMessages.set(channelId, current + 1);
        } else {
          // Human message: reset counter
          consecutiveBotMessages.set(channelId, 0);
        }
      }

      if (!shouldRespond(message, client)) return;

      const channelId = message.channel.id;
      const botDisplayName = getBotCanonicalName(client);

      // Check if this bot is already processing this channel
      const lockKey = `${client.user?.id}:${channelId}`;
      if (processingChannels.has(lockKey)) {
        console.log(
          `[${config.name}] Already processing ${channelId}, skipping duplicate`,
        );
        return;
      }

      // Acquire lock
      processingChannels.add(lockKey);

      try {
        const conversationData = await buildConversationContext({
          channel: message.channel,
          maxContextTokens: resolved.maxContextTokens,
          client,
          botDisplayName,
        });

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
        if (replyChunks.length > 0) {
          const [firstChunk, ...restChunks] = replyChunks;
          await message.reply(firstChunk);

          for (const chunk of restChunks) {
            if (hasSend(message.channel)) {
              await message.channel.send(chunk);
            } else {
              await message.reply(chunk);
            }
          }
        }

        console.log(
          `[${config.name}] Replied in channel ${channelId} to ${message.author.tag} (${replyText.length} chars, ${replyChunks.length} chunk${
            replyChunks.length === 1 ? '' : 's'
          })`,
        );
      } finally {
        // Release lock
        processingChannels.delete(lockKey);
      }
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
    mainChannelIds:
      globalConfig.mainChannelIds.length > 0 ? globalConfig.mainChannelIds : ['(unset)'],
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
