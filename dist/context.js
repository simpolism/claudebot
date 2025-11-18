"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getChannelSpeakers = exports.getBlockBoundaries = exports.appendMessage = void 0;
exports.buildConversationContext = buildConversationContext;
exports.getImageBlocksFromAttachments = getImageBlocksFromAttachments;
const message_store_1 = require("./message-store");
Object.defineProperty(exports, "appendMessage", { enumerable: true, get: function () { return message_store_1.appendMessage; } });
Object.defineProperty(exports, "getBlockBoundaries", { enumerable: true, get: function () { return message_store_1.getBlockBoundaries; } });
// ---------- Context Building ----------
async function buildConversationContext(params) {
    const { channel, maxContextTokens, client, botDisplayName } = params;
    if (!channel.isTextBased() || !client.user) {
        return { cachedBlocks: [], tail: [] };
    }
    const botUserId = client.user.id;
    // Detect if this is a thread
    const isThread = channel.isThread();
    const threadId = isThread ? channel.id : null;
    const parentChannelId = isThread ? channel.parentId : undefined;
    // Lazy-load thread from database if needed
    if (isThread && threadId && parentChannelId) {
        await (0, message_store_1.lazyLoadThread)(threadId, parentChannelId, client);
    }
    const channelResult = (0, message_store_1.getContext)(channel.id, maxContextTokens, botUserId, botDisplayName, threadId, parentChannelId ?? undefined);
    // Convert tail strings to SimpleMessage format
    const tail = channelResult.tail.map((content) => ({
        role: content.startsWith(`${botDisplayName}:`) ? 'assistant' : 'user',
        content,
    }));
    // Determine context type for logging
    let contextType = 'Channel';
    if (isThread) {
        contextType = channelResult.blocks.length > 0 ? 'Thread (with parent blocks)' : 'Thread (reset)';
    }
    console.log(`[${botDisplayName}] ${contextType} conversation: ${channelResult.blocks.length} cached blocks (~${channelResult.totalTokens} tokens) + ${tail.length} tail messages`);
    return {
        cachedBlocks: channelResult.blocks,
        tail,
    };
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
var message_store_2 = require("./message-store");
Object.defineProperty(exports, "getChannelSpeakers", { enumerable: true, get: function () { return message_store_2.getChannelSpeakers; } });
