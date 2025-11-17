"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GUARANTEED_TAIL_TOKENS = void 0;
exports.isThreadChannel = isThreadChannel;
exports.buildConversationContext = buildConversationContext;
exports.getImageBlocksFromAttachments = getImageBlocksFromAttachments;
exports.clearTailCache = clearTailCache;
const discord_js_1 = require("discord.js");
const config_1 = require("./config");
const cache_1 = require("./cache");
exports.GUARANTEED_TAIL_TOKENS = 8000;
const USER_MENTION_REGEX = /<@!?(\d+)>/g;
const tailCache = new Map();
const defaultCacheAccess = {
    getCachedBlocks: cache_1.getCachedBlocks,
    getLastCachedMessageId: cache_1.getLastCachedMessageId,
    updateCache: cache_1.updateCache,
};
function isThreadChannel(channel) {
    return (channel.type === discord_js_1.ChannelType.PublicThread ||
        channel.type === discord_js_1.ChannelType.PrivateThread ||
        channel.type === discord_js_1.ChannelType.AnnouncementThread);
}
async function buildConversationContext(params) {
    const { channel, maxContextTokens, client, botDisplayName, cacheAccess = defaultCacheAccess, fetchMessages = fetchMessagesAfter, } = params;
    if (!channel.isTextBased()) {
        return { cachedBlocks: [], tail: [] };
    }
    // Check if this is a thread - if so, include parent channel context
    const parentCachedBlocks = [];
    let parentContextTokens = 0;
    const PARENT_CONTEXT_RATIO = 0.5; // Allocate 50% of budget to parent context (cached blocks are cheap!)
    if (isThreadChannel(channel) && channel.parent && channel.parent.isTextBased()) {
        const parentChannelId = channel.parent.id;
        const parentBudget = Math.floor(maxContextTokens * PARENT_CONTEXT_RATIO);
        // Reuse parent's cached blocks (these will hit Anthropic's cache)
        const existingParentBlocks = cacheAccess.getCachedBlocks(parentChannelId);
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
            console.log(`[${botDisplayName}] Thread detected, using ${parentCachedBlocks.length} parent cached blocks (~${parentContextTokens} tokens)`);
        }
    }
    // Adjust budget for thread messages
    const threadBudget = maxContextTokens - parentContextTokens;
    const channelId = channel.id;
    // Get existing cached blocks
    const existingCachedBlocks = cacheAccess.getCachedBlocks(channelId);
    const lastCachedMessageId = cacheAccess.getLastCachedMessageId(channelId);
    const existingTailState = tailCache.get(channelId);
    const effectiveAfterId = existingTailState?.lastFetchedId ?? lastCachedMessageId;
    // Calculate token budget used by cached blocks
    const cachedTokens = existingCachedBlocks.reduce((sum, block) => sum + block.tokenCount, 0);
    const remainingBudget = threadBudget - cachedTokens;
    // Always fetch at least a small tail even when cached blocks already fill the budget.
    // The token budget is a soft limit (e.g. 100k within Claude's 200k window) so slight
    // overflow is acceptable if it keeps the latest uncached messages in view.
    const fetchBudget = Math.max(remainingBudget, exports.GUARANTEED_TAIL_TOKENS);
    console.log(`[${botDisplayName}] Fetching Discord history for ${channelId} after ${effectiveAfterId ?? 'beginning'} with budget ${fetchBudget} tokens`);
    // Fetch new messages after the last cached one
    const newMessages = await fetchMessages(channel, effectiveAfterId, fetchBudget, client);
    if (newMessages.length > 0) {
        cacheAccess.updateCache(channelId, newMessages);
    }
    const finalCachedBlocks = cacheAccess.getCachedBlocks(channelId);
    const finalLastCachedId = cacheAccess.getLastCachedMessageId(channelId);
    const filteredExisting = existingTailState?.messages.filter((msg) => {
        if (!finalLastCachedId)
            return true;
        return BigInt(msg.id) > BigInt(finalLastCachedId);
    }) ?? [];
    const freshTailEntries = [];
    for (const msg of newMessages) {
        if (finalLastCachedId && BigInt(msg.id) <= BigInt(finalLastCachedId)) {
            continue;
        }
        freshTailEntries.push({
            id: msg.id,
            role: msg.role,
            content: msg.formattedText,
            tokens: msg.tokens,
        });
    }
    const combinedTail = [...filteredExisting, ...freshTailEntries];
    const channelCachedTokens = finalCachedBlocks.reduce((sum, block) => sum + block.tokenCount, 0);
    const maxTailTokens = Math.max(threadBudget - channelCachedTokens, exports.GUARANTEED_TAIL_TOKENS);
    let combinedTokenCount = combinedTail.reduce((sum, msg) => sum + msg.tokens, 0);
    while (combinedTokenCount > maxTailTokens && combinedTail.length > 0) {
        const removed = combinedTail.shift();
        if (removed) {
            combinedTokenCount -= removed.tokens;
        }
    }
    const lastFetchedId = combinedTail.length > 0
        ? combinedTail[combinedTail.length - 1].id
        : existingTailState?.lastFetchedId ?? finalLastCachedId ?? null;
    tailCache.set(channelId, {
        messages: combinedTail,
        lastFetchedId,
    });
    const tail = combinedTail.map((msg) => ({
        role: msg.role,
        content: msg.content,
    }));
    const allCachedBlocks = [
        ...parentCachedBlocks,
        ...finalCachedBlocks.map((block) => block.text),
    ];
    const totalCachedTokens = parentContextTokens + channelCachedTokens;
    const tailTokens = combinedTokenCount;
    const contextType = parentCachedBlocks.length > 0 ? 'Thread' : 'Channel';
    console.log(`[${botDisplayName}] ${contextType} conversation: ${allCachedBlocks.length} cached blocks (~${totalCachedTokens} tokens) + ${tail.length} tail messages (~${tailTokens} tokens)`);
    return {
        cachedBlocks: allCachedBlocks,
        tail,
    };
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
function getBotCanonicalName(client) {
    return client.user?.username ?? client.user?.globalName ?? client.user?.tag ?? 'Bot';
}
function estimateTokens(text) {
    return Math.ceil(text.length / Math.max(config_1.globalConfig.approxCharsPerToken, 1));
}
function getUserCanonicalName(message) {
    return message.author.username ?? message.author.globalName ?? message.author.tag;
}
function formatAuthoredContent(authorName, content) {
    const normalized = content.trim();
    const finalContent = normalized.length ? normalized : '(empty message)';
    return `${authorName}: ${finalContent}`;
}
function formatMentionName(user) {
    return user.username ?? user.globalName ?? user.tag;
}
function replaceUserMentions(content, message, client) {
    if (!content)
        return content;
    return content.replace(USER_MENTION_REGEX, (match, userId) => {
        const mentionedUser = message.mentions.users.get(userId) ?? client.users.cache.get(userId) ?? null;
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
function clearTailCache(channelId) {
    if (channelId) {
        tailCache.delete(channelId);
        return;
    }
    tailCache.clear();
}
