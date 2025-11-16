"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const discord_js_1 = require("discord.js");
const providers_1 = require("./providers");
const config_1 = require("./config");
const cache_1 = require("./cache");
// ---------- Bot-to-Bot Exchange Tracking ----------
// Track consecutive bot messages per channel to prevent infinite loops
const consecutiveBotMessages = new Map();
const MAX_CONSECUTIVE_BOT_EXCHANGES = 3;
// ---------- Channel Processing Locks ----------
// Prevent duplicate responses when bot is tagged multiple times quickly
// Key format: "botId:channelId"
const processingChannels = new Set();
// Keep fetching a small slice of uncached history even if cached blocks consume
// the configured budget. `maxContextTokens` is a soft cap (e.g. 100k vs 200k window)
// so slight overflow is OK if it keeps the current mention visible.
const TAIL_FETCH_RATIO = 0.1;
const MIN_TAIL_FETCH_TOKENS = 2000;
function getTailFetchBudget(threadBudget) {
    if (threadBudget <= 0) {
        return Math.max(1, MIN_TAIL_FETCH_TOKENS);
    }
    const ratioBudget = Math.floor(threadBudget * TAIL_FETCH_RATIO);
    const minBudget = Math.max(MIN_TAIL_FETCH_TOKENS, 1);
    return Math.min(Math.max(ratioBudget, minBudget), threadBudget);
}
function isThreadChannel(channel) {
    return (channel.type === discord_js_1.ChannelType.PublicThread ||
        channel.type === discord_js_1.ChannelType.PrivateThread ||
        channel.type === discord_js_1.ChannelType.AnnouncementThread);
}
function isInScope(message) {
    const channel = message.channel;
    if (!config_1.globalConfig.mainChannelId) {
        return true;
    }
    if (isThreadChannel(channel)) {
        return channel.parentId === config_1.globalConfig.mainChannelId;
    }
    return channel.id === config_1.globalConfig.mainChannelId;
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
function estimateTokens(text) {
    return Math.ceil(text.length / Math.max(config_1.globalConfig.approxCharsPerToken, 1));
}
function getUserCanonicalName(message) {
    return (message.author.username ??
        message.author.globalName ??
        message.author.tag);
}
function getBotCanonicalName(client) {
    return (client.user?.username ??
        client.user?.globalName ??
        client.user?.tag ??
        'Bot');
}
function formatAuthoredContent(authorName, content) {
    const normalized = content.trim();
    const finalContent = normalized.length ? normalized : '(empty message)';
    return `${authorName}: ${finalContent}`;
}
const USER_MENTION_REGEX = /<@!?(\d+)>/g;
function formatMentionName(user) {
    return user.username ?? user.globalName ?? user.tag;
}
function replaceUserMentions(content, message, client) {
    if (!content)
        return content;
    return content.replace(USER_MENTION_REGEX, (match, userId) => {
        const mentionedUser = message.mentions.users.get(userId) ??
            client.users.cache.get(userId) ??
            null;
        if (!mentionedUser) {
            return match;
        }
        return `@${formatMentionName(mentionedUser)}`;
    });
}
function isImageAttachment(attachment) {
    const contentType = attachment.contentType ?? '';
    return contentType.startsWith('image/') && Boolean(attachment.url);
}
function buildAttachmentSummary(attachments) {
    const lines = [];
    attachments.forEach((attachment) => {
        if (!isImageAttachment(attachment))
            return;
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
function getImageBlocksFromAttachments(attachments) {
    const blocks = [];
    attachments.forEach((attachment) => {
        if (!isImageAttachment(attachment))
            return;
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
// Fetch messages after a given message ID
async function fetchMessagesAfter(channel, afterMessageId, tokenBudget, client) {
    if (!channel.isTextBased()) {
        return [];
    }
    const messages = [];
    let totalTokens = 0;
    // Fetch all messages we need
    const allFetched = [];
    let lastId;
    while (totalTokens < tokenBudget) {
        const fetched = await channel.messages.fetch({
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
        const isAssistant = Boolean(client.user) && msg.author.id === client.user?.id;
        const role = isAssistant ? 'assistant' : 'user';
        const attachmentSummary = buildAttachmentSummary(msg.attachments);
        const messageContent = replaceUserMentions(msg.content || '(empty message)', msg, client);
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
async function fetchConversationFromDiscord(channel, maxContextTokens, client) {
    if (!channel.isTextBased()) {
        return { cachedBlocks: [], tail: [] };
    }
    // Check if this is a thread - if so, include parent channel context
    let parentCachedBlocks = [];
    let parentContextTokens = 0;
    const PARENT_CONTEXT_RATIO = 0.5; // Allocate 50% of budget to parent context (cached blocks are cheap!)
    if (isThreadChannel(channel) && channel.parent && channel.parent.isTextBased()) {
        const parentChannelId = channel.parent.id;
        const parentBudget = Math.floor(maxContextTokens * PARENT_CONTEXT_RATIO);
        // Reuse parent's cached blocks (these will hit Anthropic's cache)
        const existingParentBlocks = (0, cache_1.getCachedBlocks)(parentChannelId);
        for (const block of existingParentBlocks) {
            if (parentContextTokens + block.tokenCount <= parentBudget) {
                parentCachedBlocks.push(block.text);
                parentContextTokens += block.tokenCount;
            }
            else {
                break;
            }
        }
        if (parentCachedBlocks.length > 0) {
            console.log(`[${getBotCanonicalName(client)}] Thread detected, using ${parentCachedBlocks.length} parent cached blocks (~${parentContextTokens} tokens)`);
        }
    }
    // Adjust budget for thread messages
    const threadBudget = maxContextTokens - parentContextTokens;
    const channelId = channel.id;
    // Get existing cached blocks
    const existingCachedBlocks = (0, cache_1.getCachedBlocks)(channelId);
    const lastCachedMessageId = (0, cache_1.getLastCachedMessageId)(channelId);
    // Calculate token budget used by cached blocks
    const cachedTokens = existingCachedBlocks.reduce((sum, block) => sum + block.tokenCount, 0);
    const tailFetchBudgetTarget = getTailFetchBudget(threadBudget);
    const remainingBudget = threadBudget - cachedTokens;
    // Always fetch at least a small tail even when cached blocks already fill the budget.
    // The token budget is a soft limit (e.g. 100k within Claude's 200k window) so slight
    // overflow is acceptable if it keeps the latest uncached messages in view.
    const fetchBudget = Math.max(remainingBudget, tailFetchBudgetTarget);
    // Fetch new messages after the last cached one
    const newMessages = await fetchMessagesAfter(channel, lastCachedMessageId, fetchBudget, client);
    // Update cache if we have significant new messages
    // (This will create new cached blocks if needed)
    if (newMessages.length > 0) {
        (0, cache_1.updateCache)(channelId, newMessages);
    }
    // Get potentially updated cached blocks
    const finalCachedBlocks = (0, cache_1.getCachedBlocks)(channelId);
    const finalLastCachedId = (0, cache_1.getLastCachedMessageId)(channelId);
    // Build the tail (messages after the last cached block)
    const tail = [];
    for (const msg of newMessages) {
        // Only include messages that aren't part of a cached block
        // Compare as BigInt since Discord snowflakes are numeric
        if (finalLastCachedId &&
            BigInt(msg.id) <= BigInt(finalLastCachedId)) {
            continue;
        }
        tail.push({
            role: msg.role,
            content: msg.formattedText,
        });
    }
    // Combine parent context with thread context
    const allCachedBlocks = [
        ...parentCachedBlocks,
        ...finalCachedBlocks.map((block) => block.text),
    ];
    const totalCachedTokens = parentContextTokens +
        finalCachedBlocks.reduce((sum, block) => sum + block.tokenCount, 0);
    const tailTokens = tail.reduce((sum, msg) => sum + estimateTokens(msg.content) + 4, 0);
    const contextType = parentCachedBlocks.length > 0 ? 'Thread' : 'Channel';
    console.log(`[${getBotCanonicalName(client)}] ${contextType} conversation: ${allCachedBlocks.length} cached blocks (~${totalCachedTokens} tokens) + ${tail.length} tail messages (~${tailTokens} tokens)`);
    return {
        cachedBlocks: allCachedBlocks,
        tail,
    };
}
// ---------- Response Formatting ----------
function chunkReplyText(text) {
    if (text.length <= config_1.globalConfig.discordMessageLimit) {
        return [text];
    }
    const chunks = [];
    let remaining = text;
    while (remaining.length > 0) {
        if (remaining.length <= config_1.globalConfig.discordMessageLimit) {
            chunks.push(remaining);
            break;
        }
        let sliceEnd = config_1.globalConfig.discordMessageLimit;
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
function convertOutputMentions(text, channel, client) {
    if (!channel.isTextBased())
        return text;
    const usernameToId = new Map();
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
                const conversationData = await fetchConversationFromDiscord(message.channel, resolved.maxContextTokens, client);
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
                const formattedReplyText = convertOutputMentions(replyText, message.channel, client);
                const replyChunks = chunkReplyText(formattedReplyText);
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
        mainChannelId: config_1.globalConfig.mainChannelId || '(unset)',
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
