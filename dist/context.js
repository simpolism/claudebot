"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getBlockBoundaries = exports.appendMessage = void 0;
exports.isThreadChannel = isThreadChannel;
exports.buildConversationContext = buildConversationContext;
exports.getImageBlocksFromAttachments = getImageBlocksFromAttachments;
const discord_js_1 = require("discord.js");
const message_store_1 = require("./message-store");
Object.defineProperty(exports, "appendMessage", { enumerable: true, get: function () { return message_store_1.appendMessage; } });
Object.defineProperty(exports, "getBlockBoundaries", { enumerable: true, get: function () { return message_store_1.getBlockBoundaries; } });
// ---------- Thread Detection ----------
function isThreadChannel(channel) {
    return (channel.type === discord_js_1.ChannelType.PublicThread ||
        channel.type === discord_js_1.ChannelType.PrivateThread ||
        channel.type === discord_js_1.ChannelType.AnnouncementThread);
}
// ---------- Context Building ----------
function buildConversationContext(params) {
    const { channel, maxContextTokens, client, botDisplayName } = params;
    if (!channel.isTextBased() || !client.user) {
        return { cachedBlocks: [], tail: [] };
    }
    const botUserId = client.user.id;
    // Handle threads: include parent context first
    let parentBlocks = [];
    let parentTokens = 0;
    if (isThreadChannel(channel) && channel.parent && channel.parent.isTextBased()) {
        const parentResult = (0, message_store_1.getContext)(channel.parent.id, maxContextTokens, botUserId, botDisplayName);
        parentBlocks = parentResult.blocks;
        parentTokens = parentResult.totalTokens;
        console.log(`[${botDisplayName}] Thread detected, including ${parentBlocks.length} parent blocks (~${parentTokens} tokens)`);
    }
    // Get context for current channel/thread
    const remainingBudget = maxContextTokens - parentTokens;
    const channelResult = (0, message_store_1.getContext)(channel.id, remainingBudget, botUserId, botDisplayName);
    // Combine parent blocks + channel blocks
    const allBlocks = [...parentBlocks, ...channelResult.blocks];
    const totalBlockTokens = parentTokens + channelResult.totalTokens - tailTokensFromResult(channelResult);
    // Convert tail strings to SimpleMessage format
    const tail = channelResult.tail.map((content) => ({
        role: content.startsWith(`${botDisplayName}:`) ? 'assistant' : 'user',
        content,
    }));
    const contextType = parentBlocks.length > 0 ? 'Thread' : 'Channel';
    console.log(`[${botDisplayName}] ${contextType} conversation: ${allBlocks.length} cached blocks (~${totalBlockTokens} tokens) + ${tail.length} tail messages`);
    return {
        cachedBlocks: allBlocks,
        tail,
    };
}
function tailTokensFromResult(result) {
    // Estimate tail tokens by subtracting block tokens from total
    let blockTokens = 0;
    for (const block of result.blocks) {
        blockTokens += Math.ceil(block.length / 4); // rough estimate
    }
    return result.totalTokens - blockTokens;
}
// ---------- Image Handling ----------
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
function isImageAttachment(attachment) {
    const contentType = attachment.contentType ?? '';
    return contentType.startsWith('image/') && Boolean(attachment.url);
}
