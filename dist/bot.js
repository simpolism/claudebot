"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.botInstances = void 0;
require("dotenv/config");
const discord_js_1 = require("discord.js");
const providers_1 = require("./providers");
const config_1 = require("./config");
const message_store_1 = require("./message-store");
const context_1 = require("./context");
const discord_utils_1 = require("./discord-utils");
const debug_server_1 = require("./debug-server");
const database_1 = require("./database");
// Export bot instances for debug server access
exports.botInstances = [];
// ---------- Bot-to-Bot Exchange Tracking ----------
const consecutiveBotMessages = new Map();
const MAX_CONSECUTIVE_BOT_EXCHANGES = 3;
// ---------- Channel Processing Locks ----------
const processingChannels = new Set();
// Queue for pending messages when channel is busy
const messageQueues = new Map();
// Track reset messages that have been reacted to (to prevent duplicate reactions)
const reactedResetMessages = new Set();
const allowedRootChannels = new Set(config_1.globalConfig.mainChannelIds);
function isChannelAllowed(channelId) {
    if (allowedRootChannels.size === 0) {
        return true;
    }
    if (!channelId) {
        return false;
    }
    return allowedRootChannels.has(channelId);
}
// ---------- Utility Functions ----------
function isInScope(message) {
    // For threads, check if the parent channel is allowed
    // For regular channels, check the channel itself
    if (message.channel.isThread()) {
        const parentId = message.channel.parentId;
        return isChannelAllowed(parentId);
    }
    return isChannelAllowed(message.channel.id);
}
function shouldRespond(message, client) {
    if (!isInScope(message))
        return false;
    if (!client.user)
        return false;
    if (!message.mentions.has(client.user))
        return false;
    // Don't respond to own messages
    if (message.author.id === client.user.id)
        return false;
    // For bot-to-bot: require explicit @mention in content, not just reply
    if (message.author.bot) {
        const mentionPattern = new RegExp(`<@!?${client.user.id}>`);
        if (!mentionPattern.test(message.content)) {
            console.log(`[${client.user.username}] Skipping bot message ${message.id} - mentioned via reply only, not explicit tag`);
            return false;
        }
    }
    const channelId = message.channel.id;
    const currentCount = consecutiveBotMessages.get(channelId) || 0;
    if (currentCount >= MAX_CONSECUTIVE_BOT_EXCHANGES) {
        console.log(`[${client.user.username}] Skipping response in ${channelId} - bot exchange limit reached (${currentCount}/${MAX_CONSECUTIVE_BOT_EXCHANGES})`);
        return false;
    }
    return true;
}
function getBotCanonicalName(client) {
    return client.user?.username ?? client.user?.globalName ?? client.user?.tag ?? 'Bot';
}
function hasTyping(channel) {
    return !!channel && typeof channel.sendTyping === 'function';
}
function startTypingIndicator(channel) {
    if (!hasTyping(channel)) {
        return () => { };
    }
    const textChannel = channel;
    let active = true;
    let timeout = null;
    const scheduleNext = () => {
        if (!active)
            return;
        timeout = setTimeout(() => {
            void sendTyping();
        }, 9000);
    };
    const sendTyping = async () => {
        if (!active)
            return;
        try {
            await textChannel.sendTyping();
        }
        catch (err) {
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
function hasSend(channel) {
    return !!channel && typeof channel.send === 'function';
}
// ---------- Bot Instance Setup ----------
function createBotInstance(botConfig) {
    const resolved = (0, config_1.resolveConfig)(botConfig);
    const client = new discord_js_1.Client({
        intents: [
            discord_js_1.GatewayIntentBits.Guilds,
            discord_js_1.GatewayIntentBits.GuildMessages,
            discord_js_1.GatewayIntentBits.MessageContent,
        ],
        partials: [discord_js_1.Partials.Channel, discord_js_1.Partials.Message],
    });
    const systemPrompt = resolved.cliSimMode
        ? "The assistant is in CLI simulation mode, and responds to the user's CLI commands only with the output of the command."
        : resolved.systemPrompt || '';
    const prefillCommand = resolved.cliSimMode ? '<cmd>cat untitled.txt</cmd>' : '';
    const aiProvider = (0, providers_1.createAIProvider)({
        provider: resolved.provider,
        systemPrompt,
        prefillCommand,
        temperature: resolved.temperature,
        maxTokens: resolved.maxTokens,
        maxContextTokens: resolved.maxContextTokens,
        approxCharsPerToken: config_1.globalConfig.approxCharsPerToken,
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
function setupBotEvents(instance) {
    const { config, client, aiProvider } = instance;
    const resolved = (0, config_1.resolveConfig)(config);
    client.once(discord_js_1.Events.ClientReady, (c) => {
        console.log(`[${config.name}] Logged in as ${c.user.tag}`);
    });
    client.on(discord_js_1.Events.MessageCreate, async (message) => {
        // Check for /reset command first
        const content = message.content.trim();
        const isResetCommand = content === '/reset' || content.startsWith('/reset ');
        // ALWAYS append messages to in-memory store (for all in-scope messages)
        // Skip Discord's automatic thread starter messages so they never affect context
        if (isInScope(message) && message.type !== discord_js_1.MessageType.ThreadStarterMessage) {
            (0, message_store_1.appendMessage)(message);
            // Track bot-to-bot exchanges: reset counter on human messages
            const channelId = message.channel.id;
            if (!message.author.bot) {
                consecutiveBotMessages.set(channelId, 0);
            }
            // Note: counter is incremented when bot RESPONDS to another bot, not on every bot message
        }
        // Handle /reset command (thread-only)
        // Supports per-bot reset: /reset (all bots) or /reset @Bot1 @Bot2 (specific bots)
        if (isResetCommand) {
            // Only handle in-scope messages
            if (!isInScope(message)) {
                return;
            }
            // Ignore bot's own messages
            if (client.user && message.author.id === client.user.id) {
                return;
            }
            if (!message.channel.isThread()) {
                // Only first bot reacts
                if (!reactedResetMessages.has(message.id)) {
                    reactedResetMessages.add(message.id);
                    await message.react('⚠️');
                }
                return;
            }
            const threadId = message.channel.id;
            const parentChannelId = message.channel.parentId;
            if (!parentChannelId) {
                // Only first bot reacts
                if (!reactedResetMessages.has(message.id)) {
                    reactedResetMessages.add(message.id);
                    await message.react('⚠️');
                }
                return;
            }
            // Check if specific bots were mentioned
            const botMentions = message.mentions.users.filter((user) => user.bot);
            const isGlobalReset = botMentions.size === 0;
            const shouldResetThisBot = isGlobalReset || (client.user && message.mentions.has(client.user));
            try {
                if (shouldResetThisBot) {
                    // Determine botId: null for global reset, client.user.id for per-bot reset
                    const botId = isGlobalReset ? null : client.user?.id;
                    (0, message_store_1.clearThread)(threadId, parentChannelId, message.id, botId);
                    // Only first bot to process (for global) or first mentioned bot reacts with success
                    if (!reactedResetMessages.has(message.id)) {
                        reactedResetMessages.add(message.id);
                        await message.react('✅');
                    }
                    const resetType = isGlobalReset ? 'global' : 'per-bot';
                    console.log(`[${config.name}] Cleared thread history for ${threadId} (${resetType})`);
                }
            }
            catch (err) {
                console.error(`[${config.name}] Failed to clear thread:`, err);
                // Only first bot reacts with error
                if (!reactedResetMessages.has(message.id)) {
                    reactedResetMessages.add(message.id);
                    await message.react('⚠️');
                }
            }
            return;
        }
        if (!shouldRespond(message, client))
            return;
        const channelId = message.channel.id;
        const lockKey = `${client.user?.id}:${channelId}`;
        // Queue message if already processing
        if (processingChannels.has(lockKey)) {
            if (!messageQueues.has(lockKey)) {
                messageQueues.set(lockKey, []);
            }
            messageQueues.get(lockKey).push(message);
            console.log(`[${config.name}] Queued message ${message.id} in ${channelId} (queue size: ${messageQueues.get(lockKey).length})`);
            return;
        }
        processingChannels.add(lockKey);
        // Process this message and any queued messages
        const processMessage = async (msg) => {
            let stopTyping = null;
            const receiveTime = Date.now();
            const botDisplayName = getBotCanonicalName(client);
            console.log(`[${config.name}] Processing mention ${msg.id} in ${channelId} at ${new Date(receiveTime).toISOString()}`);
            try {
                const contextStart = Date.now();
                const conversationData = await (0, context_1.buildConversationContext)({
                    channel: msg.channel,
                    maxContextTokens: resolved.maxContextTokens,
                    client,
                    botDisplayName,
                });
                const contextDuration = Date.now() - contextStart;
                console.log(`[${config.name}] Context built for ${msg.id} in ${contextDuration}ms`);
                stopTyping = startTypingIndicator(msg.channel);
                const imageBlocks = (0, context_1.getImageBlocksFromAttachments)(msg.attachments);
                // For threads, use parent channel's speakers since thread inherits parent blocks
                const speakerChannelId = msg.channel.isThread()
                    ? (msg.channel.parentId ?? channelId)
                    : channelId;
                const otherSpeakers = (0, context_1.getChannelSpeakers)(speakerChannelId, client.user?.id);
                const guardSpeakers = Array.from(new Set([...otherSpeakers, botDisplayName])); // Include bot name so guard catches self fragments
                const providerStart = Date.now();
                const aiReply = await aiProvider.send({
                    conversationData,
                    botDisplayName,
                    imageBlocks,
                    otherSpeakers: guardSpeakers,
                });
                const providerDuration = Date.now() - providerStart;
                console.log(`[${config.name}] Provider responded for ${msg.id} in ${providerDuration}ms`);
                const replyText = aiReply.text;
                stopTyping();
                stopTyping = null;
                const formattedReplyText = (0, discord_utils_1.convertOutputMentions)(replyText, msg.channel, client);
                const replyChunks = (0, discord_utils_1.chunkReplyText)(formattedReplyText);
                const sentMessages = [];
                // Handle image attachment if present
                const imageAttachment = aiReply.imageData
                    ? new discord_js_1.AttachmentBuilder(aiReply.imageData, { name: 'generated.png' })
                    : undefined;
                console.log(`[${config.name}] Response: ${replyText.length} chars, ${replyChunks.length} chunks, ` +
                    `imageData: ${aiReply.imageData ? `${aiReply.imageData.length} bytes` : 'none'}`);
                if (replyChunks.length > 0) {
                    const [firstChunk, ...restChunks] = replyChunks;
                    if (restChunks.length === 0) {
                        // Single chunk - attach image here if present
                        const firstSent = await msg.reply({
                            content: firstChunk,
                            files: imageAttachment ? [imageAttachment] : undefined,
                        });
                        sentMessages.push(firstSent);
                    }
                    else {
                        // Multiple chunks - image goes on last chunk
                        const firstSent = await msg.reply(firstChunk);
                        sentMessages.push(firstSent);
                        for (let i = 0; i < restChunks.length; i++) {
                            const chunk = restChunks[i];
                            const isLastChunk = i === restChunks.length - 1;
                            // Attach image to last message if present
                            const files = isLastChunk && imageAttachment ? [imageAttachment] : undefined;
                            if (hasSend(msg.channel)) {
                                const sent = await msg.channel.send({ content: chunk, files });
                                sentMessages.push(sent);
                            }
                            else {
                                const sent = await msg.reply({ content: chunk, files });
                                sentMessages.push(sent);
                            }
                        }
                    }
                }
                else if (imageAttachment) {
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
                    const stored = {
                        id: sentMsg.id,
                        channelId: sentMsg.channel.id,
                        threadId,
                        parentChannelId,
                        authorId: sentMsg.author.id,
                        authorName: botDisplayName, // Use canonical name for consistency
                        content,
                        timestamp: sentMsg.createdTimestamp,
                    };
                    (0, message_store_1.appendStoredMessage)(stored);
                }
                // Track bot-to-bot exchange: increment counter if we responded to another bot
                if (msg.author.bot) {
                    const current = consecutiveBotMessages.get(channelId) || 0;
                    consecutiveBotMessages.set(channelId, current + 1);
                    console.log(`[${config.name}] Bot-to-bot exchange count: ${current + 1}/${MAX_CONSECUTIVE_BOT_EXCHANGES}`);
                }
                const totalDuration = Date.now() - receiveTime;
                console.log(`[${config.name}] Replied in channel ${channelId} to ${msg.author.tag} (${replyText.length} chars, ${replyChunks.length} chunk${replyChunks.length === 1 ? '' : 's'}) in ${totalDuration}ms`);
            }
            catch (err) {
                console.error(`[${config.name}] Error handling message ${msg.id}:`, err);
                try {
                    await msg.react('⚠️');
                }
                catch {
                    // ignore
                }
            }
            finally {
                stopTyping?.();
            }
        };
        try {
            // Process current message
            await processMessage(message);
            // Process any queued messages
            while (messageQueues.has(lockKey) && messageQueues.get(lockKey).length > 0) {
                const nextMessage = messageQueues.get(lockKey).shift();
                console.log(`[${config.name}] Processing queued message ${nextMessage.id} (${messageQueues.get(lockKey).length} remaining)`);
                await processMessage(nextMessage);
            }
        }
        finally {
            processingChannels.delete(lockKey);
            messageQueues.delete(lockKey);
        }
    });
}
// ---------- Main ----------
async function main() {
    // Start debug server for inspecting in-memory state
    (0, debug_server_1.startDebugServer)();
    console.log('[Database] Initializing SQLite storage');
    (0, database_1.initializeDatabase)();
    const stats = (0, database_1.getDatabaseStats)();
    console.log('[Database] Current state:', stats);
    console.log('Starting multi-bot system with configuration:', {
        mainChannelIds: config_1.globalConfig.mainChannelIds.length > 0 ? config_1.globalConfig.mainChannelIds : ['(unset)'],
        maxContextTokens: config_1.globalConfig.maxContextTokens,
        maxTokens: config_1.globalConfig.maxTokens,
        temperature: config_1.globalConfig.temperature,
        bots: config_1.activeBotConfigs.map((c) => ({
            name: c.name,
            provider: c.provider,
            model: c.model,
        })),
    });
    if (config_1.activeBotConfigs.length === 0) {
        console.error('No bots configured with valid tokens. Exiting.');
        process.exit(1);
    }
    const instances = [];
    for (const config of config_1.activeBotConfigs) {
        const instance = createBotInstance(config);
        setupBotEvents(instance);
        instances.push(instance);
        exports.botInstances.push(instance); // Also export for debug server
    }
    // Login all bots
    const loginPromises = instances.map(async (instance) => {
        try {
            await instance.client.login(instance.config.discordToken);
            console.log(`[${instance.config.name}] Login successful`);
        }
        catch (err) {
            console.error(`[${instance.config.name}] Failed to login:`, err);
            throw err;
        }
    });
    try {
        await Promise.all(loginPromises);
        console.log('All bots logged in successfully');
    }
    catch (err) {
        console.error('One or more bots failed to login. Exiting.');
        process.exit(1);
    }
    // Load history for configured channels (after login so we have access)
    if (config_1.globalConfig.mainChannelIds.length > 0 && instances.length > 0) {
        const firstInstance = instances[0];
        if (firstInstance) {
            console.log('Loading channel history...');
            await (0, message_store_1.loadHistoryFromDiscord)(config_1.globalConfig.mainChannelIds, firstInstance.client, config_1.globalConfig.maxContextTokens);
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
    (0, database_1.closeDatabase)();
    process.exit(0);
});
process.on('SIGTERM', () => {
    console.log('\nReceived SIGTERM, shutting down gracefully...');
    (0, database_1.closeDatabase)();
    process.exit(0);
});
