import 'dotenv/config';
import { Client, Events, GatewayIntentBits, Message, Partials, AttachmentBuilder } from 'discord.js';
import { createAIProvider, AIProvider } from './providers';
import { activeBotConfigs, globalConfig, resolveConfig, BotConfig } from './config';
import { loadBoundariesFromDisk, loadHistoryFromDiscord, appendMessage, appendStoredMessage, StoredMessage } from './message-store';
import { buildConversationContext, getImageBlocksFromAttachments, getChannelSpeakers } from './context';
import { chunkReplyText, convertOutputMentions } from './discord-utils';
import { startDebugServer } from './debug-server';

// ---------- Types ----------
interface BotInstance {
  config: BotConfig;
  client: Client;
  aiProvider: AIProvider;
}

// ---------- Bot-to-Bot Exchange Tracking ----------
const consecutiveBotMessages = new Map<string, number>();
const MAX_CONSECUTIVE_BOT_EXCHANGES = 3;

// ---------- Channel Processing Locks ----------
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
  // Only allow exact channel matches (no threads)
  return isChannelAllowed(message.channel.id);
}

function shouldRespond(message: Message, client: Client): boolean {
  if (!isInScope(message)) return false;
  if (message.author.bot) return false;
  if (!client.user) return false;

  if (!message.mentions.has(client.user)) return false;

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
    geminiModel: resolved.model,
    geminiApiKey: resolved.geminiApiKey || '',
    geminiOutputMode: resolved.geminiOutputMode || 'both',
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
      // ALWAYS append messages to in-memory store (for all in-scope messages)
      if (isInScope(message)) {
        appendMessage(message);

        // Track bot-to-bot exchanges
        const channelId = message.channel.id;
        if (message.author.bot) {
          const current = consecutiveBotMessages.get(channelId) || 0;
          consecutiveBotMessages.set(channelId, current + 1);
        } else {
          consecutiveBotMessages.set(channelId, 0);
        }
      }

      if (!shouldRespond(message, client)) return;

      const channelId = message.channel.id;
      const botDisplayName = getBotCanonicalName(client);

      const lockKey = `${client.user?.id}:${channelId}`;
      if (processingChannels.has(lockKey)) {
        console.log(`[${config.name}] Already processing ${channelId}, skipping duplicate`);
        return;
      }

      processingChannels.add(lockKey);

      const receiveTime = Date.now();
      console.log(
        `[${config.name}] Received mention ${message.id} in ${channelId} at ${new Date(receiveTime).toISOString()}`,
      );

      try {
        const contextStart = Date.now();
        const conversationData = buildConversationContext({
          channel: message.channel,
          maxContextTokens: resolved.maxContextTokens,
          client,
          botDisplayName,
        });
        const contextDuration = Date.now() - contextStart;
        console.log(`[${config.name}] Context built for ${message.id} in ${contextDuration}ms`);

        stopTyping = startTypingIndicator(message.channel);
        const imageBlocks = getImageBlocksFromAttachments(message.attachments);
        const otherSpeakers = getChannelSpeakers(channelId, client.user?.id);
        const guardSpeakers = Array.from(
          new Set([...otherSpeakers, botDisplayName]),
        ); // Include bot name so guard catches self fragments
        const providerStart = Date.now();
        const aiReply = await aiProvider.send({
          conversationData,
          botDisplayName,
          imageBlocks,
          otherSpeakers: guardSpeakers,
        });
        const providerDuration = Date.now() - providerStart;
        console.log(`[${config.name}] Provider responded for ${message.id} in ${providerDuration}ms`);
        const replyText = aiReply.text;
        stopTyping();
        stopTyping = null;

        const formattedReplyText = convertOutputMentions(replyText, message.channel, client);

        const replyChunks = chunkReplyText(formattedReplyText);
        const sentMessages: Message[] = [];

        // Handle image attachment if present
        const imageAttachment = aiReply.imageData
          ? new AttachmentBuilder(aiReply.imageData, { name: 'generated.png' })
          : undefined;

        if (replyChunks.length > 0) {
          const [firstChunk, ...restChunks] = replyChunks;
          const firstSent = await message.reply(firstChunk);
          sentMessages.push(firstSent);

          for (let i = 0; i < restChunks.length; i++) {
            const chunk = restChunks[i];
            const isLastChunk = i === restChunks.length - 1;
            // Attach image to last message if present
            const files = isLastChunk && imageAttachment ? [imageAttachment] : undefined;

            if (hasSend(message.channel)) {
              const sent = await message.channel.send({ content: chunk, files });
              sentMessages.push(sent);
            } else {
              const sent = await message.reply({ content: chunk, files });
              sentMessages.push(sent);
            }
          }

          // If only one chunk and we have an image, send image separately
          if (restChunks.length === 0 && imageAttachment) {
            if (hasSend(message.channel)) {
              const sent = await message.channel.send({ content: '', files: [imageAttachment] });
              sentMessages.push(sent);
            } else {
              const sent = await message.reply({ content: '', files: [imageAttachment] });
              sentMessages.push(sent);
            }
          }
        } else if (imageAttachment) {
          // Image only, no text
          const firstSent = await message.reply({
            content: '',
            files: [imageAttachment],
          });
          sentMessages.push(firstSent);
        }

        // Append bot's own replies to the message store
        for (const sentMsg of sentMessages) {
          const stored: StoredMessage = {
            id: sentMsg.id,
            channelId: sentMsg.channel.id,
            authorId: sentMsg.author.id,
            authorName: botDisplayName, // Use canonical name for consistency
            content: sentMsg.content || '(empty message)',
            timestamp: sentMsg.createdTimestamp,
          };
          appendStoredMessage(stored);
        }

        const totalDuration = Date.now() - receiveTime;
        console.log(
          `[${config.name}] Replied in channel ${channelId} to ${message.author.tag} (${replyText.length} chars, ${replyChunks.length} chunk${
            replyChunks.length === 1 ? '' : 's'
          }) in ${totalDuration}ms`,
        );
      } finally {
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
  // Start debug server for inspecting in-memory state
  startDebugServer();

  // Load block boundaries from disk (for Anthropic cache consistency)
  loadBoundariesFromDisk();

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

  // Load history for configured channels (after login so we have access)
  if (globalConfig.mainChannelIds.length > 0 && instances.length > 0) {
    const firstInstance = instances[0];
    if (firstInstance) {
      console.log('Loading channel history...');
      await loadHistoryFromDiscord(
        globalConfig.mainChannelIds,
        firstInstance.client,
        globalConfig.maxContextTokens,
      );
    }
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
