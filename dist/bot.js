"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const discord_js_1 = require("discord.js");
const providers_1 = require("./providers");
const config_1 = require("./config");
const cache_1 = require("./cache");
const context_1 = require("./context");
const discord_utils_1 = require("./discord-utils");
// ---------- Bot-to-Bot Exchange Tracking ----------
// Track consecutive bot messages per channel to prevent infinite loops
const consecutiveBotMessages = new Map();
const MAX_CONSECUTIVE_BOT_EXCHANGES = 3;
// ---------- Channel Processing Locks ----------
// Prevent duplicate responses when bot is tagged multiple times quickly
// Key format: "botId:channelId"
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
    const channel = message.channel;
    if (allowedRootChannels.size === 0) {
        return true;
    }
    if ((0, context_1.isThreadChannel)(channel)) {
        return isChannelAllowed(channel.parentId);
    }
    return isChannelAllowed(channel.id);
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
    // Check bot-to-bot exchange limit
    const channelId = message.channel.id;
    const currentCount = consecutiveBotMessages.get(channelId) || 0;
    if (currentCount >= MAX_CONSECUTIVE_BOT_EXCHANGES) {
        console.log(`[${client.user.username}] Skipping response in ${channelId} - bot exchange limit reached (${currentCount}/${MAX_CONSECUTIVE_BOT_EXCHANGES})`);
        return false;
    }
    return true;
}
function getBotCanonicalName(client) {
    return (client.user?.username ??
        client.user?.globalName ??
        client.user?.tag ??
        'Bot');
}
function hasTyping(channel) {
    return (!!channel &&
        typeof channel.sendTyping === 'function');
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
    return (!!channel && typeof channel.send === 'function');
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
        : '';
    const prefillCommand = resolved.cliSimMode
        ? '<cmd>cat untitled.txt</cmd>'
        : '';
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
            // Track bot-to-bot exchanges
            if (isInScope(message)) {
                const channelId = message.channel.id;
                if (message.author.bot) {
                    // Bot message: increment counter
                    const current = consecutiveBotMessages.get(channelId) || 0;
                    consecutiveBotMessages.set(channelId, current + 1);
                }
                else {
                    // Human message: reset counter
                    consecutiveBotMessages.set(channelId, 0);
                }
            }
            if (!shouldRespond(message, client))
                return;
            const channelId = message.channel.id;
            const botDisplayName = getBotCanonicalName(client);
            // Check if this bot is already processing this channel
            const lockKey = `${client.user?.id}:${channelId}`;
            if (processingChannels.has(lockKey)) {
                console.log(`[${config.name}] Already processing ${channelId}, skipping duplicate`);
                return;
            }
            // Acquire lock
            processingChannels.add(lockKey);
            try {
                const conversationData = await (0, context_1.buildConversationContext)({
                    channel: message.channel,
                    maxContextTokens: resolved.maxContextTokens,
                    client,
                    botDisplayName,
                });
                stopTyping = startTypingIndicator(message.channel);
                const imageBlocks = (0, context_1.getImageBlocksFromAttachments)(message.attachments);
                const aiReply = await aiProvider.send({
                    conversationData,
                    botDisplayName,
                    imageBlocks,
                });
                const replyText = aiReply.text;
                stopTyping();
                stopTyping = null;
                const formattedReplyText = (0, discord_utils_1.convertOutputMentions)(replyText, message.channel, client);
                const replyChunks = (0, discord_utils_1.chunkReplyText)(formattedReplyText);
                let lastSent = null;
                if (replyChunks.length > 0) {
                    const [firstChunk, ...restChunks] = replyChunks;
                    lastSent = await message.reply(firstChunk);
                    for (const chunk of restChunks) {
                        if (hasSend(message.channel)) {
                            lastSent = await message.channel.send(chunk);
                        }
                        else {
                            lastSent = await message.reply(chunk);
                        }
                    }
                }
                console.log(`[${config.name}] Replied in channel ${channelId} to ${message.author.tag} (${replyText.length} chars, ${replyChunks.length} chunk${replyChunks.length === 1 ? '' : 's'})`);
            }
            finally {
                // Release lock
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
    // Load conversation cache for stable prompt caching
    (0, cache_1.loadCache)();
    console.log('Starting multi-bot system with configuration:', {
        mainChannelIds: config_1.globalConfig.mainChannelIds.length > 0
            ? config_1.globalConfig.mainChannelIds
            : ['(unset)'],
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
}
main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
});
