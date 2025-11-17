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
// Export bot instances for debug server access
exports.botInstances = [];
// ---------- Bot-to-Bot Exchange Tracking ----------
const consecutiveBotMessages = new Map();
const MAX_CONSECUTIVE_BOT_EXCHANGES = 3;
// ---------- Channel Processing Locks ----------
const processingChannels = new Set();
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
    // Only allow exact channel matches (no threads)
    return isChannelAllowed(message.channel.id);
}
function shouldRespond(message, client) {
    if (!isInScope(message))
        return false;
    if (message.author.bot)
        return false;
    if (!client.user)
        return false;
    if (!message.mentions.has(client.user))
        return false;
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
        let stopTyping = null;
        try {
            // ALWAYS append messages to in-memory store (for all in-scope messages)
            if (isInScope(message)) {
                (0, message_store_1.appendMessage)(message);
                // Track bot-to-bot exchanges
                const channelId = message.channel.id;
                if (message.author.bot) {
                    const current = consecutiveBotMessages.get(channelId) || 0;
                    consecutiveBotMessages.set(channelId, current + 1);
                }
                else {
                    consecutiveBotMessages.set(channelId, 0);
                }
            }
            if (!shouldRespond(message, client))
                return;
            const channelId = message.channel.id;
            const botDisplayName = getBotCanonicalName(client);
            const lockKey = `${client.user?.id}:${channelId}`;
            if (processingChannels.has(lockKey)) {
                console.log(`[${config.name}] Already processing ${channelId}, skipping duplicate`);
                return;
            }
            processingChannels.add(lockKey);
            const receiveTime = Date.now();
            console.log(`[${config.name}] Received mention ${message.id} in ${channelId} at ${new Date(receiveTime).toISOString()}`);
            try {
                const contextStart = Date.now();
                const conversationData = (0, context_1.buildConversationContext)({
                    channel: message.channel,
                    maxContextTokens: resolved.maxContextTokens,
                    client,
                    botDisplayName,
                });
                const contextDuration = Date.now() - contextStart;
                console.log(`[${config.name}] Context built for ${message.id} in ${contextDuration}ms`);
                stopTyping = startTypingIndicator(message.channel);
                const imageBlocks = (0, context_1.getImageBlocksFromAttachments)(message.attachments);
                const otherSpeakers = (0, context_1.getChannelSpeakers)(channelId, client.user?.id);
                const guardSpeakers = Array.from(new Set([...otherSpeakers, botDisplayName])); // Include bot name so guard catches self fragments
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
                const formattedReplyText = (0, discord_utils_1.convertOutputMentions)(replyText, message.channel, client);
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
                        const firstSent = await message.reply({
                            content: firstChunk,
                            files: imageAttachment ? [imageAttachment] : undefined,
                        });
                        sentMessages.push(firstSent);
                    }
                    else {
                        // Multiple chunks - image goes on last chunk
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
                            }
                            else {
                                const sent = await message.reply({ content: chunk, files });
                                sentMessages.push(sent);
                            }
                        }
                    }
                }
                else if (imageAttachment) {
                    // Image only, no text
                    const firstSent = await message.reply({
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
                            content = content ? content + '\n' + imageUrls.join('\n') : imageUrls.join('\n');
                        }
                    }
                    // Fallback if truly empty
                    if (!content) {
                        content = '(empty message)';
                    }
                    const stored = {
                        id: sentMsg.id,
                        channelId: sentMsg.channel.id,
                        authorId: sentMsg.author.id,
                        authorName: botDisplayName, // Use canonical name for consistency
                        content,
                        timestamp: sentMsg.createdTimestamp,
                    };
                    (0, message_store_1.appendStoredMessage)(stored);
                }
                const totalDuration = Date.now() - receiveTime;
                console.log(`[${config.name}] Replied in channel ${channelId} to ${message.author.tag} (${replyText.length} chars, ${replyChunks.length} chunk${replyChunks.length === 1 ? '' : 's'}) in ${totalDuration}ms`);
            }
            finally {
                processingChannels.delete(lockKey);
            }
        }
        catch (err) {
            console.error(`[${config.name}] Error handling message:`, err);
            try {
                await message.reply('Sorry, I hit an error. Check the bot logs.');
            }
            catch {
                // ignore
            }
        }
        finally {
            stopTyping?.();
        }
    });
}
// ---------- Main ----------
async function main() {
    // Start debug server for inspecting in-memory state
    (0, debug_server_1.startDebugServer)();
    // Load block boundaries from disk (for Anthropic cache consistency)
    (0, message_store_1.loadBoundariesFromDisk)();
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
