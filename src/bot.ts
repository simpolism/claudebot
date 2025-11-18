import 'dotenv/config';
import {
  Client,
  Events,
  GatewayIntentBits,
  Message,
  Partials,
  AttachmentBuilder,
} from 'discord.js';
import { createAIProvider, AIProvider } from './providers';
import { activeBotConfigs, globalConfig, resolveConfig, BotConfig } from './config';
import {
  loadBoundariesFromDisk,
  loadHistoryFromDiscord,
  appendMessage,
  appendStoredMessage,
  StoredMessage,
  clearThread,
} from './message-store';
import {
  buildConversationContext,
  getImageBlocksFromAttachments,
  getChannelSpeakers,
} from './context';
import { chunkReplyText, convertOutputMentions } from './discord-utils';
import { startDebugServer } from './debug-server';
import { initializeDatabase, closeDatabase, getDatabaseStats } from './database';

// ---------- Types ----------
export interface BotInstance {
  config: BotConfig;
  client: Client;
  aiProvider: AIProvider;
}

// Export bot instances for debug server access
export const botInstances: BotInstance[] = [];

// ---------- Bot-to-Bot Exchange Tracking ----------
const consecutiveBotMessages = new Map<string, number>();
const MAX_CONSECUTIVE_BOT_EXCHANGES = 3;

// ---------- Channel Processing Locks ----------
const processingChannels = new Set<string>();

// Queue for pending messages when channel is busy
const messageQueues = new Map<string, Message[]>();

// Track reset messages that have been replied to (to prevent duplicate replies)
const repliedResetMessages = new Set<string>();

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
  // For threads, check if the parent channel is allowed
  // For regular channels, check the channel itself
  if (message.channel.isThread()) {
    const parentId = message.channel.parentId;
    return isChannelAllowed(parentId);
  }
  return isChannelAllowed(message.channel.id);
}

function shouldRespond(message: Message, client: Client): boolean {
  if (!isInScope(message)) return false;
  if (!client.user) return false;
  if (!message.mentions.has(client.user)) return false;

  // Don't respond to own messages
  if (message.author.id === client.user.id) return false;

  // For bot-to-bot: require explicit @mention in content, not just reply
  if (message.author.bot) {
    const mentionPattern = new RegExp(`<@!?${client.user.id}>`);
    if (!mentionPattern.test(message.content)) {
      console.log(
        `[${client.user.username}] Skipping bot message ${message.id} - mentioned via reply only, not explicit tag`,
      );
      return false;
    }
  }

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
  send: (
    content: string | { content: string; files?: AttachmentBuilder[] },
  ) => Promise<Message>;
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
    : resolved.systemPrompt || '';

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
    useUserAssistantPrefill: Boolean(botConfig.useUserAssistantPrefill),
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
    // Check for /reset command first
    const content = message.content.trim();
    const isResetCommand = content === '/reset' || content.startsWith('/reset ');

    // ALWAYS append messages to in-memory store (for all in-scope messages)
    if (isInScope(message)) {
      appendMessage(message);

      // Track bot-to-bot exchanges: reset counter on human messages
      const channelId = message.channel.id;
      if (!message.author.bot) {
        consecutiveBotMessages.set(channelId, 0);
      }
      // Note: counter is incremented when bot RESPONDS to another bot, not on every bot message
    }

    // Handle /reset command (thread-only)
    if (isResetCommand) {
      // Check if bot was mentioned or if it should respond
      // Use same logic as shouldRespond to determine which bot handles it
      if (!shouldRespond(message, client)) {
        return; // This bot wasn't mentioned/shouldn't respond
      }

      if (!message.channel.isThread()) {
        // Only reply if no other bot has replied yet
        if (!repliedResetMessages.has(message.id)) {
          repliedResetMessages.add(message.id);
          await message.reply(
            '❌ The `/reset` command only works in threads. Use threads to isolate conversations.',
          );
        }
        return;
      }

      const threadId = message.channel.id;
      const parentChannelId = message.channel.parentId;

      if (!parentChannelId) {
        // Only reply if no other bot has replied yet
        if (!repliedResetMessages.has(message.id)) {
          repliedResetMessages.add(message.id);
          await message.reply('❌ Could not determine parent channel for this thread.');
        }
        return;
      }

      try {
        // Pass the /reset message ID to clearThread so it can set the correct boundary
        clearThread(threadId, parentChannelId, message.id);
        // Only reply if no other bot has replied yet
        if (!repliedResetMessages.has(message.id)) {
          repliedResetMessages.add(message.id);
          await message.reply('✅ Thread history cleared. Starting fresh conversation! 🔄');
        }
        console.log(`[${config.name}] Cleared thread history for ${threadId}`);
      } catch (err) {
        console.error(`[${config.name}] Failed to clear thread:`, err);
        // Only reply if no other bot has replied yet
        if (!repliedResetMessages.has(message.id)) {
          repliedResetMessages.add(message.id);
          await message.reply('❌ Failed to clear thread history. Please try again.');
        }
      }
      return;
    }

    if (!shouldRespond(message, client)) return;

    const channelId = message.channel.id;
    const lockKey = `${client.user?.id}:${channelId}`;

    // Queue message if already processing
    if (processingChannels.has(lockKey)) {
      if (!messageQueues.has(lockKey)) {
        messageQueues.set(lockKey, []);
      }
      messageQueues.get(lockKey)!.push(message);
      console.log(
        `[${config.name}] Queued message ${message.id} in ${channelId} (queue size: ${messageQueues.get(lockKey)!.length})`,
      );
      return;
    }

    processingChannels.add(lockKey);

    // Process this message and any queued messages
    const processMessage = async (msg: Message) => {
      let stopTyping: (() => void) | null = null;
      const receiveTime = Date.now();
      const botDisplayName = getBotCanonicalName(client);

      console.log(
        `[${config.name}] Processing mention ${msg.id} in ${channelId} at ${new Date(receiveTime).toISOString()}`,
      );

      try {
        const contextStart = Date.now();
        const conversationData = await buildConversationContext({
          channel: msg.channel,
          maxContextTokens: resolved.maxContextTokens,
          client,
          botDisplayName,
        });
        const contextDuration = Date.now() - contextStart;
        console.log(
          `[${config.name}] Context built for ${msg.id} in ${contextDuration}ms`,
        );

        stopTyping = startTypingIndicator(msg.channel);
        const imageBlocks = getImageBlocksFromAttachments(msg.attachments);
        // For threads, use parent channel's speakers since thread inherits parent blocks
        const speakerChannelId = msg.channel.isThread()
          ? (msg.channel.parentId ?? channelId)
          : channelId;
        const otherSpeakers = getChannelSpeakers(speakerChannelId, client.user?.id);
        const guardSpeakers = Array.from(new Set([...otherSpeakers, botDisplayName])); // Include bot name so guard catches self fragments
        const providerStart = Date.now();
        const aiReply = await aiProvider.send({
          conversationData,
          botDisplayName,
          imageBlocks,
          otherSpeakers: guardSpeakers,
        });

        const providerDuration = Date.now() - providerStart;
        console.log(
          `[${config.name}] Provider responded for ${msg.id} in ${providerDuration}ms`,
        );
        const replyText = aiReply.text;
        stopTyping();
        stopTyping = null;

        const formattedReplyText = convertOutputMentions(replyText, msg.channel, client);

        const replyChunks = chunkReplyText(formattedReplyText);
        const sentMessages: Message[] = [];

        // Handle image attachment if present
        const imageAttachment = aiReply.imageData
          ? new AttachmentBuilder(aiReply.imageData, { name: 'generated.png' })
          : undefined;

        console.log(
          `[${config.name}] Response: ${replyText.length} chars, ${replyChunks.length} chunks, ` +
            `imageData: ${aiReply.imageData ? `${aiReply.imageData.length} bytes` : 'none'}`,
        );

        if (replyChunks.length > 0) {
          const [firstChunk, ...restChunks] = replyChunks;

          if (restChunks.length === 0) {
            // Single chunk - attach image here if present
            const firstSent = await msg.reply({
              content: firstChunk,
              files: imageAttachment ? [imageAttachment] : undefined,
            });
            sentMessages.push(firstSent);
          } else {
            // Multiple chunks - image goes on last chunk
            const firstSent = await msg.reply(firstChunk);
            sentMessages.push(firstSent);

            for (let i = 0; i < restChunks.length; i++) {
              const chunk = restChunks[i];
              const isLastChunk = i === restChunks.length - 1;
              // Attach image to last message if present
              const files =
                isLastChunk && imageAttachment ? [imageAttachment] : undefined;

              if (hasSend(msg.channel)) {
                const sent = await msg.channel.send({ content: chunk, files });
                sentMessages.push(sent);
              } else {
                const sent = await msg.reply({ content: chunk, files });
                sentMessages.push(sent);
              }
            }
          }
        } else if (imageAttachment) {
          // Image only, no text
          const firstSent = await msg.reply({
            content: '',
            files: [imageAttachment],
          });
          sentMessages.push(firstSent);
        }

        // Append bot's own replies to the message store
        for (const sentMsg of sentMessages) {
          let content = sentMsg.content || '';

          // Append image URLs from attachments for vision context
          if (sentMsg.attachments.size > 0) {
            const imageUrls = [...sentMsg.attachments.values()]
              .filter((a) => a.contentType?.startsWith('image/'))
              .map((a) => `![image](${a.url})`);
            if (imageUrls.length > 0) {
              // If no text content, just use image markers; otherwise append with newline
              content = content
                ? content + '\n' + imageUrls.join('\n')
                : imageUrls.join('\n');
            }
          }

          // Fallback if truly empty
          if (!content) {
            content = '(empty message)';
          }

          // Detect if this is a thread message
          const isThread = sentMsg.channel.isThread();
          const threadId = isThread ? sentMsg.channel.id : null;
          const parentChannelId = isThread
            ? (sentMsg.channel.parentId ?? sentMsg.channel.id)
            : sentMsg.channel.id;

          const stored: StoredMessage = {
            id: sentMsg.id,
            channelId: sentMsg.channel.id,
            threadId,
            parentChannelId,
            authorId: sentMsg.author.id,
            authorName: botDisplayName, // Use canonical name for consistency
            content,
            timestamp: sentMsg.createdTimestamp,
          };
          appendStoredMessage(stored);
        }

        // Track bot-to-bot exchange: increment counter if we responded to another bot
        if (msg.author.bot) {
          const current = consecutiveBotMessages.get(channelId) || 0;
          consecutiveBotMessages.set(channelId, current + 1);
          console.log(
            `[${config.name}] Bot-to-bot exchange count: ${current + 1}/${MAX_CONSECUTIVE_BOT_EXCHANGES}`,
          );
        }

        const totalDuration = Date.now() - receiveTime;
        console.log(
          `[${config.name}] Replied in channel ${channelId} to ${msg.author.tag} (${replyText.length} chars, ${replyChunks.length} chunk${
            replyChunks.length === 1 ? '' : 's'
          }) in ${totalDuration}ms`,
        );
      } catch (err) {
        console.error(`[${config.name}] Error handling message ${msg.id}:`, err);
        try {
          await msg.reply('Sorry, I hit an error. Check the bot logs.');
        } catch {
          // ignore
        }
      } finally {
        stopTyping?.();
      }
    };

    try {
      // Process current message
      await processMessage(message);

      // Process any queued messages
      while (messageQueues.has(lockKey) && messageQueues.get(lockKey)!.length > 0) {
        const nextMessage = messageQueues.get(lockKey)!.shift()!;
        console.log(
          `[${config.name}] Processing queued message ${nextMessage.id} (${messageQueues.get(lockKey)!.length} remaining)`,
        );
        await processMessage(nextMessage);
      }
    } finally {
      processingChannels.delete(lockKey);
      messageQueues.delete(lockKey);
    }
  });
}

// ---------- Main ----------
async function main(): Promise<void> {
  // Start debug server for inspecting in-memory state
  startDebugServer();

  // Initialize database if feature flag is enabled
  if (globalConfig.useDatabaseStorage) {
    console.log('[Database] Initializing SQLite storage (USE_DATABASE_STORAGE=true)');
    initializeDatabase();
    const stats = getDatabaseStats();
    console.log('[Database] Current state:', stats);
  }

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
    botInstances.push(instance); // Also export for debug server
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

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nReceived SIGINT, shutting down gracefully...');
  if (globalConfig.useDatabaseStorage) {
    closeDatabase();
  }
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\nReceived SIGTERM, shutting down gracefully...');
  if (globalConfig.useDatabaseStorage) {
    closeDatabase();
  }
  process.exit(0);
});
