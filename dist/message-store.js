"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.__testing = void 0;
exports.appendStoredMessage = appendStoredMessage;
exports.appendMessage = appendMessage;
exports.getChannelMessages = getChannelMessages;
exports.getBlockBoundaries = getBlockBoundaries;
exports.getContext = getContext;
exports.loadHistoryFromDiscord = loadHistoryFromDiscord;
exports.lazyLoadThread = lazyLoadThread;
exports.clearChannel = clearChannel;
exports.clearThread = clearThread;
exports.clearAll = clearAll;
exports.getStats = getStats;
exports.getChannelSpeakers = getChannelSpeakers;
const discord_js_1 = require("discord.js");
const config_1 = require("./config");
const db = __importStar(require("./database"));
// ---------- Constants ----------
const MIN_TOKENS_PER_BLOCK = 1000;
const MAX_TOKENS_PER_BLOCK = 30000;
const DEFAULT_TOKENS_PER_BLOCK = Math.max(MIN_TOKENS_PER_BLOCK, Math.min(MAX_TOKENS_PER_BLOCK, Math.floor(((0, config_1.getMaxBotContextTokens)() - 10000) / 3)));
// ---------- In-Memory Storage ----------
const messagesByChannel = new Map();
const messageIdsByChannel = new Map(); // O(1) deduplication
const blockBoundaries = new Map();
const channelThreadIds = new Map(); // Track thread_id per channel
const hydratedChannels = new Map(); // Track lazy-loaded threads
const resetThreads = new Map(); // Track per-bot thread resets: threadId -> Map<botId, resetMessageId>
const userNamesById = new Map(); // Track best-known usernames for mention normalization
const MAX_TEXT_ATTACHMENT_BYTES = 256 * 1024; // 256KB guardrail
const TEXT_ATTACHMENT_EXTENSIONS = ['.txt'];
const TEXT_ATTACHMENT_MIME_PREFIXES = ['text/plain'];
// ---------- Helper Functions ----------
/**
 * Mark a thread as reset for a specific bot (or all bots if botId is null).
 */
function markThreadReset(threadId, botId, resetMessageId) {
    if (botId && resetMessageId) {
        // Reset for specific bot - store the reset message ID
        if (!resetThreads.has(threadId)) {
            resetThreads.set(threadId, new Map());
        }
        resetThreads.get(threadId).set(botId, resetMessageId);
    }
    else {
        // Reset for ALL bots - clear everything
        resetThreads.delete(threadId);
    }
}
/**
 * Check if a thread was reset for a specific bot.
 */
function isThreadResetForBot(threadId, botId) {
    const botResets = resetThreads.get(threadId);
    return botResets ? botResets.has(botId) : false;
}
/**
 * Get the reset message ID for a specific bot in a thread.
 */
function getThreadResetMessageId(threadId, botId) {
    const botResets = resetThreads.get(threadId);
    return botResets?.get(botId) ?? null;
}
function ensureChannelInitialized(channelId) {
    if (!messagesByChannel.has(channelId)) {
        messagesByChannel.set(channelId, []);
    }
    if (!messageIdsByChannel.has(channelId)) {
        messageIdsByChannel.set(channelId, new Set());
    }
    if (!blockBoundaries.has(channelId)) {
        blockBoundaries.set(channelId, []);
    }
    if (!channelThreadIds.has(channelId)) {
        channelThreadIds.set(channelId, null);
    }
}
function rememberUserName(userId, displayName) {
    if (!userId || !displayName)
        return;
    const existing = userNamesById.get(userId);
    if (!existing || existing !== displayName) {
        userNamesById.set(userId, displayName);
    }
}
function rememberDiscordUsers(message) {
    const authorDisplay = message.author.username ?? message.author.globalName ?? message.author.tag ?? null;
    rememberUserName(message.author.id, authorDisplay);
    message.mentions?.users?.forEach((user) => {
        const mentionDisplay = user.username ?? user.globalName ?? user.tag ?? null;
        rememberUserName(user.id, mentionDisplay);
    });
}
function isTextAttachment(attachment) {
    const contentType = attachment.contentType?.toLowerCase() ?? '';
    if (TEXT_ATTACHMENT_MIME_PREFIXES.some((prefix) => contentType.startsWith(prefix))) {
        return true;
    }
    const filename = attachment.name?.toLowerCase() ?? '';
    return TEXT_ATTACHMENT_EXTENSIONS.some((ext) => filename.endsWith(ext));
}
async function fetchTextAttachment(attachment) {
    if (!attachment.url) {
        return null;
    }
    if (attachment.size && attachment.size > MAX_TEXT_ATTACHMENT_BYTES) {
        console.warn(`[Attachment] Skipping ${attachment.name ?? attachment.id} - ${attachment.size} bytes exceeds ${MAX_TEXT_ATTACHMENT_BYTES} byte limit`);
        return null;
    }
    if (typeof fetch !== 'function') {
        console.warn('[Attachment] Global fetch() unavailable; cannot download text attachment');
        return null;
    }
    try {
        const response = await fetch(attachment.url);
        if (!response.ok) {
            console.warn(`[Attachment] Failed to fetch ${attachment.name ?? attachment.id} - HTTP ${response.status}`);
            return null;
        }
        const contentLengthHeader = response.headers.get('content-length');
        if (contentLengthHeader &&
            Number(contentLengthHeader) > 0 &&
            Number(contentLengthHeader) > MAX_TEXT_ATTACHMENT_BYTES) {
            console.warn(`[Attachment] Skipping ${attachment.name ?? attachment.id} - content-length ${contentLengthHeader} exceeds limit`);
            return null;
        }
        const buffer = await response.arrayBuffer();
        if (buffer.byteLength > MAX_TEXT_ATTACHMENT_BYTES) {
            console.warn(`[Attachment] Skipping ${attachment.name ?? attachment.id} - downloaded ${buffer.byteLength} bytes exceeds limit`);
            return null;
        }
        const text = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
        return text;
    }
    catch (err) {
        console.warn(`[Attachment] Error fetching ${attachment.name ?? attachment.id}, skipping text inline`, err);
        return null;
    }
}
async function getTextAttachmentSections(message) {
    if (message.attachments.size === 0) {
        return [];
    }
    const sections = [];
    for (const attachment of message.attachments.values()) {
        if (!isTextAttachment(attachment))
            continue;
        const text = await fetchTextAttachment(attachment);
        if (!text)
            continue;
        const header = `[Attachment: ${attachment.name ?? 'file.txt'}]`;
        const normalized = text.trim() || '(empty attachment)';
        sections.push(`${header}\n${normalized}`);
    }
    return sections;
}
function estimateMessageTokens(authorName, content, useVerticalFormat = false) {
    if (useVerticalFormat) {
        // Vertical format: [Name]\nContent
        return estimateTokens(`[${authorName}]\n${content}`) + 4; // +4 for message overhead
    }
    return estimateTokens(`${authorName}: ${content}`) + 4; // +4 for message overhead
}
async function messageToStored(message) {
    let content = message.content || '';
    // Append image URLs from attachments for vision context
    if (message.attachments.size > 0) {
        const imageUrls = [...message.attachments.values()]
            .filter((a) => a.contentType?.startsWith('image/'))
            .map((a) => `![image](${a.url})`);
        if (imageUrls.length > 0) {
            // If no text content, just use image markers; otherwise append with newline
            content = content ? content + '\n' + imageUrls.join('\n') : imageUrls.join('\n');
        }
        const textSections = await getTextAttachmentSections(message);
        if (textSections.length > 0) {
            const attachmentText = textSections.join('\n');
            content = content ? `${content}\n${attachmentText}` : attachmentText;
        }
    }
    // Fallback if truly empty
    if (!content) {
        content = '(empty message)';
    }
    // Detect if this is a thread message
    const isThread = message.channel.isThread();
    const threadId = isThread ? message.channel.id : null;
    const parentChannelId = isThread
        ? (message.channel.parentId ?? message.channel.id)
        : message.channel.id;
    return {
        id: message.id,
        channelId: message.channel.id,
        threadId,
        parentChannelId,
        authorId: message.author.id,
        authorName: message.author.username ?? message.author.globalName ?? message.author.tag,
        content,
        timestamp: message.createdTimestamp,
    };
}
// ---------- Message Management ----------
function appendStoredMessage(stored) {
    const channelId = stored.channelId;
    ensureChannelInitialized(channelId);
    const messageIds = messageIdsByChannel.get(channelId);
    rememberUserName(stored.authorId, stored.authorName);
    // O(1) deduplication
    if (messageIds.has(stored.id)) {
        return;
    }
    messageIds.add(stored.id);
    // Write to database first to get row_id
    try {
        const rowId = db.insertMessage({
            ...stored,
            createdAt: Date.now(),
        });
        // Update stored message with row_id
        if (rowId !== null) {
            stored.rowId = rowId;
        }
    }
    catch (err) {
        console.error('[Database] Failed to insert message:', err);
    }
    messagesByChannel.get(channelId).push(stored);
    channelThreadIds.set(channelId, stored.threadId ?? null);
    checkAndFreezeBlocks(channelId);
}
async function appendMessage(message) {
    // Skip Discord's automatic thread starter messages (just the thread title)
    if (message.type === discord_js_1.MessageType.ThreadStarterMessage) {
        return;
    }
    rememberDiscordUsers(message);
    const stored = await messageToStored(message);
    appendStoredMessage(stored);
}
function getChannelMessages(channelId) {
    return messagesByChannel.get(channelId) ?? [];
}
function getBlockBoundaries(channelId) {
    return blockBoundaries.get(channelId) ?? [];
}
function getContext(channelId, maxTokens, botUserId, botDisplayName, threadId, parentChannelId, useVerticalFormat = false) {
    // For threads: use parent's blocks + thread's tail (unless thread was reset for this bot)
    // For channels: use channel's blocks + tail
    const isThreadContext = threadId != null && parentChannelId != null;
    const isResetThread = threadId != null && isThreadResetForBot(threadId, botUserId);
    const boundaryChannelId = isThreadContext && !isResetThread ? parentChannelId : channelId;
    const messageChannelId = channelId; // Always get messages from the actual channel/thread
    const messages = messagesByChannel.get(messageChannelId) ?? [];
    const boundaries = blockBoundaries.get(boundaryChannelId) ?? [];
    // First, check if we need to evict blocks globally (based on LARGEST bot context)
    const globalMaxTokens = (0, config_1.getMaxBotContextTokens)();
    checkAndEvictGlobally(boundaryChannelId, globalMaxTokens);
    // Re-fetch after potential eviction
    let currentMessages = messagesByChannel.get(messageChannelId) ?? [];
    const currentBoundaries = blockBoundaries.get(boundaryChannelId) ?? [];
    // Filter messages for per-bot thread resets
    if (isThreadContext && isResetThread) {
        const resetMessageId = getThreadResetMessageId(threadId, botUserId);
        if (resetMessageId) {
            const resetIndex = currentMessages.findIndex((m) => m.id === resetMessageId);
            if (resetIndex !== -1) {
                // Keep only messages AFTER the reset message
                currentMessages = currentMessages.slice(resetIndex + 1);
                console.log(`[getContext] Thread ${threadId} reset for bot ${botUserId} - filtered to ${currentMessages.length} messages after ${resetMessageId}`);
            }
        }
    }
    const parentMessages = isThreadContext && parentChannelId ? messagesByChannel.get(parentChannelId) ?? [] : [];
    // Build frozen blocks with their stored token counts
    // For threads: these are the parent's cached blocks (unless reset)
    const blockData = [];
    if (isThreadContext && !isResetThread) {
        // For threads: Get parent channel messages to build parent blocks
        for (const boundary of currentBoundaries) {
            const blockMessages = getMessagesInRange(parentMessages, boundary.firstMessageId, boundary.lastMessageId);
            const blockText = formatMessages(blockMessages, botUserId, botDisplayName, useVerticalFormat);
            blockData.push({ text: blockText, tokens: boundary.tokenCount });
        }
    }
    else {
        // For regular channels or reset threads: Use channel's own blocks
        for (const boundary of currentBoundaries) {
            const blockMessages = getMessagesInRange(currentMessages, boundary.firstMessageId, boundary.lastMessageId);
            const blockText = formatMessages(blockMessages, botUserId, botDisplayName, useVerticalFormat);
            blockData.push({ text: blockText, tokens: boundary.tokenCount });
        }
    }
    const tailData = [];
    // Include parent's tail for threads so forked contexts don't lose recent history
    if (isThreadContext && !isResetThread && parentChannelId) {
        const parentTailMessages = getTailMessagesAfterLastBoundary(parentMessages, currentBoundaries);
        tailData.push(...buildTailDataFromMessages(parentTailMessages, botUserId, botDisplayName, useVerticalFormat));
    }
    // Build tail (messages after last frozen block)
    // For threads: all thread messages (threads don't have their own blocks yet)
    // For channels: messages after last block
    const tailMessages = isThreadContext
        ? currentMessages
        : getTailMessagesAfterLastBoundary(currentMessages, currentBoundaries);
    tailData.push(...buildTailDataFromMessages(tailMessages, botUserId, botDisplayName, useVerticalFormat));
    // Calculate totals
    let totalTokens = blockData.reduce((sum, b) => sum + b.tokens, 0) +
        tailData.reduce((sum, t) => sum + t.tokens, 0);
    // Trim for THIS bot's specific budget (but don't modify global state)
    const finalBlockData = [...blockData];
    const finalTailData = [...tailData];
    let trimmedBlocks = 0;
    let trimmedTailMessages = 0;
    while (totalTokens > maxTokens && finalBlockData.length > 0) {
        const removed = finalBlockData.shift();
        if (removed) {
            totalTokens -= removed.tokens;
            trimmedBlocks++;
        }
    }
    while (totalTokens > maxTokens && finalTailData.length > 0) {
        const removed = finalTailData.shift();
        if (removed) {
            totalTokens -= removed.tokens;
            trimmedTailMessages++;
        }
    }
    if (trimmedBlocks > 0 || trimmedTailMessages > 0) {
        console.log(`[getContext] Trimmed ${trimmedBlocks} blocks and ${trimmedTailMessages} tail messages for ${botDisplayName}'s ${maxTokens} token budget (global max: ${globalMaxTokens})`);
    }
    return {
        blocks: finalBlockData.map((b) => b.text),
        tail: finalTailData.map((t) => t.text),
        totalTokens,
    };
}
// Check if global state exceeds the largest bot's context and evict if needed
function checkAndEvictGlobally(channelId, globalMaxTokens) {
    const messages = messagesByChannel.get(channelId) ?? [];
    const boundaries = blockBoundaries.get(channelId) ?? [];
    if (boundaries.length === 0)
        return;
    // Calculate total tokens across all blocks + tail
    const totalBlockTokens = boundaries.reduce((sum, b) => sum + b.tokenCount, 0);
    // Find tail start
    const lastBoundary = boundaries[boundaries.length - 1];
    const lastBoundaryIdx = messages.findIndex((m) => m.id === lastBoundary.lastMessageId);
    const tailMessages = lastBoundaryIdx !== -1 ? messages.slice(lastBoundaryIdx + 1) : messages;
    let tailTokens = 0;
    for (const msg of tailMessages) {
        tailTokens += estimateMessageTokens(msg.authorName, msg.content);
    }
    const totalTokens = totalBlockTokens + tailTokens;
    // Evict oldest blocks if over global max
    let blocksToEvict = 0;
    let tokensAfterEviction = totalTokens;
    for (const boundary of boundaries) {
        if (tokensAfterEviction <= globalMaxTokens)
            break;
        tokensAfterEviction -= boundary.tokenCount;
        blocksToEvict++;
    }
    if (blocksToEvict > 0) {
        console.log(`[checkAndEvictGlobally] Total ${totalTokens} tokens exceeds global max ${globalMaxTokens}, evicting ${blocksToEvict} oldest blocks`);
        cleanupEvictedBlocks(channelId, blocksToEvict);
    }
}
function getMessagesInRange(messages, firstId, lastId) {
    const result = [];
    let inRange = false;
    let foundFirst = false;
    let foundLast = false;
    for (const msg of messages) {
        if (msg.id === firstId) {
            inRange = true;
            foundFirst = true;
        }
        if (inRange) {
            result.push(msg);
        }
        if (msg.id === lastId) {
            foundLast = true;
            break;
        }
    }
    // Debug warnings for incomplete ranges
    if (!foundFirst) {
        console.error(`[getMessagesInRange] CRITICAL: firstId ${firstId} not found in ${messages.length} messages!`);
    }
    if (!foundLast) {
        console.error(`[getMessagesInRange] CRITICAL: lastId ${lastId} not found in ${messages.length} messages!`);
    }
    if (result.length === 0 && (foundFirst || foundLast)) {
        console.error(`[getMessagesInRange] WARNING: Empty result despite finding boundary IDs`);
    }
    return result;
}
/**
 * Check if a message is a meta-message (command or system response) that should be
 * filtered out of conversation context.
 */
function isMetaMessage(content) {
    const trimmed = content.trim();
    return (trimmed.startsWith('/reset') ||
        trimmed.includes('Thread history cleared') ||
        trimmed.includes('The `/reset` command only works in threads') ||
        trimmed.includes('Could not determine parent channel') ||
        trimmed.includes('Failed to clear thread history'));
}
// Matches Discord user mention markup: <@123456> or deprecated <@!123456>
// The !? handles the optional ! flag used in older Discord mention formats
const USER_MENTION_REGEX = /<@!?(\d+)>/g;
function normalizeMessageContent(rawContent, botUserId, botDisplayName) {
    const trimmed = rawContent.trim();
    if (!trimmed) {
        return '(empty message)';
    }
    if (!trimmed.includes('<@')) {
        return trimmed;
    }
    return trimmed.replace(USER_MENTION_REGEX, (_match, id) => {
        if (!id)
            return _match;
        if (id === botUserId) {
            return `@${botDisplayName}`;
        }
        const knownName = userNamesById.get(id);
        // Fallback to raw user ID if username not yet seen (e.g., mentioned before they spoke)
        return `@${knownName ?? id}`;
    });
}
function formatMessage(msg, botUserId, botDisplayName, useVerticalFormat = false) {
    const authorName = msg.authorId === botUserId ? botDisplayName : msg.authorName;
    const normalizedContent = normalizeMessageContent(msg.content, botUserId, botDisplayName);
    if (useVerticalFormat) {
        // Vertical format: [Name]\nContent
        return `[${authorName}]\n${normalizedContent}`;
    }
    return `${authorName}: ${normalizedContent}`;
}
function formatMessages(messages, botUserId, botDisplayName, useVerticalFormat = false) {
    // Filter out meta-messages (commands and system responses)
    const filtered = messages.filter((m) => !isMetaMessage(m.content));
    return filtered.map((m) => formatMessage(m, botUserId, botDisplayName, useVerticalFormat)).join('\n');
}
function getTailMessagesAfterLastBoundary(messages, boundaries) {
    if (boundaries.length === 0) {
        return messages;
    }
    const lastBoundary = boundaries[boundaries.length - 1];
    if (!lastBoundary) {
        return messages;
    }
    const lastBoundaryIdx = messages.findIndex((m) => m.id === lastBoundary.lastMessageId);
    return lastBoundaryIdx !== -1 ? messages.slice(lastBoundaryIdx + 1) : messages;
}
function buildTailDataFromMessages(messages, botUserId, botDisplayName, useVerticalFormat = false) {
    const tailData = [];
    for (const msg of messages) {
        if (isMetaMessage(msg.content))
            continue;
        const authorName = msg.authorId === botUserId ? botDisplayName : msg.authorName;
        const normalizedContent = normalizeMessageContent(msg.content, botUserId, botDisplayName);
        const formatted = useVerticalFormat
            ? `[${authorName}]\n${normalizedContent}`
            : `${authorName}: ${normalizedContent}`;
        const tokens = estimateMessageTokens(authorName, normalizedContent, useVerticalFormat);
        tailData.push({ text: formatted, tokens });
    }
    return tailData;
}
function estimateTokens(text) {
    return Math.ceil(text.length / Math.max(config_1.globalConfig.approxCharsPerToken, 1));
}
// ---------- Block Eviction Cleanup ----------
function cleanupEvictedBlocks(channelId, numEvicted) {
    const boundaries = blockBoundaries.get(channelId);
    const messages = messagesByChannel.get(channelId);
    const messageIds = messageIdsByChannel.get(channelId);
    if (!boundaries || numEvicted <= 0)
        return;
    // Remove oldest boundaries
    const evictedBoundaries = boundaries.splice(0, numEvicted);
    console.log(`[cleanupEvictedBlocks] Removed ${evictedBoundaries.length} oldest blocks from ${channelId}`);
    const threadIdForDb = (() => {
        if (evictedBoundaries.length > 0 && evictedBoundaries[0]) {
            return evictedBoundaries[0].threadId ?? null;
        }
        if (messages && messages.length > 0) {
            return messages[0].threadId ?? null;
        }
        return channelThreadIds.get(channelId) ?? null;
    })();
    if (evictedBoundaries.length > 0) {
        db.deleteOldestBlockBoundaries(channelId, threadIdForDb, evictedBoundaries.length);
    }
    // Also trim messages that are no longer referenced
    let maxRemovedRowId = null;
    let lastRemovedMessageId = null;
    if (messages && messageIds && evictedBoundaries.length > 0) {
        const lastEvictedBoundary = evictedBoundaries[evictedBoundaries.length - 1];
        if (lastEvictedBoundary) {
            const lastEvictedIdx = messages.findIndex((m) => m.id === lastEvictedBoundary.lastMessageId);
            if (lastEvictedIdx !== -1) {
                // Remove all messages up to and including the last evicted block
                const removedMessages = messages.splice(0, lastEvictedIdx + 1);
                // Update the deduplication set
                for (const msg of removedMessages) {
                    messageIds.delete(msg.id);
                    if (typeof msg.rowId === 'number') {
                        if (maxRemovedRowId === null || msg.rowId > maxRemovedRowId) {
                            maxRemovedRowId = msg.rowId;
                        }
                    }
                }
                if (removedMessages.length > 0) {
                    lastRemovedMessageId = removedMessages[removedMessages.length - 1].id;
                }
                console.log(`[cleanupEvictedBlocks] Trimmed ${removedMessages.length} messages from memory for ${channelId}`);
            }
        }
    }
    if (evictedBoundaries.length > 0) {
        const lastEvictedBoundary = evictedBoundaries[evictedBoundaries.length - 1];
        if (lastEvictedBoundary) {
            if (maxRemovedRowId === null && typeof lastEvictedBoundary.lastRowId === 'number') {
                maxRemovedRowId = lastEvictedBoundary.lastRowId;
            }
            if (maxRemovedRowId === null && lastRemovedMessageId) {
                maxRemovedRowId = db.getRowIdForMessageId(lastRemovedMessageId);
            }
        }
    }
    if (maxRemovedRowId !== null) {
        const deletedCount = db.deleteMessagesUpToRowId(channelId, threadIdForDb, maxRemovedRowId);
        if (deletedCount > 0) {
            console.log(`[cleanupEvictedBlocks] Deleted ${deletedCount} messages from database for ${channelId} (<= row ${maxRemovedRowId})`);
        }
    }
    else if (evictedBoundaries.length > 0) {
        console.warn(`[cleanupEvictedBlocks] Unable to resolve row_id for evicted blocks in ${channelId}; database rows may remain until next freeze`);
    }
}
function freezeBlocks(channelId, options = {}) {
    const { verbose = false, source = 'freezeBlocks' } = options;
    const messages = messagesByChannel.get(channelId);
    const boundaries = blockBoundaries.get(channelId);
    if (!messages || !boundaries)
        return 0;
    // Find where tail starts (after last frozen block)
    let tailStartIdx = 0;
    if (boundaries.length > 0) {
        const lastBoundary = boundaries[boundaries.length - 1];
        const lastBoundaryIdx = messages.findIndex((m) => m.id === lastBoundary.lastMessageId);
        if (lastBoundaryIdx !== -1) {
            tailStartIdx = lastBoundaryIdx + 1;
        }
        else if (verbose) {
            console.error(`[${source}] CRITICAL: lastBoundary.lastMessageId ${lastBoundary.lastMessageId} not found in messages!`);
        }
    }
    // Accumulate tail tokens and freeze when threshold reached
    let accumulatedTokens = 0;
    let blockStartIdx = tailStartIdx;
    let messagesInBlock = 0;
    let blocksCreated = 0;
    for (let i = tailStartIdx; i < messages.length; i++) {
        const msg = messages[i];
        if (!msg)
            continue;
        const tokens = estimateMessageTokens(msg.authorName, msg.content);
        accumulatedTokens += tokens;
        messagesInBlock++;
        // Freeze block when threshold reached
        if (accumulatedTokens >= DEFAULT_TOKENS_PER_BLOCK) {
            const firstMsg = messages[blockStartIdx];
            const lastMsg = messages[i];
            if (firstMsg && lastMsg) {
                const isThread = firstMsg.threadId != null;
                const boundaryThreadId = isThread ? firstMsg.threadId : null;
                const boundary = {
                    firstMessageId: firstMsg.id,
                    lastMessageId: lastMsg.id,
                    firstRowId: firstMsg.rowId,
                    lastRowId: lastMsg.rowId,
                    tokenCount: accumulatedTokens,
                    threadId: boundaryThreadId,
                    channelId,
                };
                boundaries.push(boundary);
                try {
                    db.insertBlockBoundary({
                        channelId,
                        threadId: boundaryThreadId,
                        firstMessageId: boundary.firstMessageId,
                        lastMessageId: boundary.lastMessageId,
                        firstRowId: boundary.firstRowId,
                        lastRowId: boundary.lastRowId,
                        tokenCount: boundary.tokenCount,
                        createdAt: Date.now(),
                    });
                }
                catch (err) {
                    console.error('[Database] Failed to insert block boundary:', err);
                }
                blocksCreated++;
                if (verbose) {
                    console.log(`[${source}] Frozen block #${boundaries.length} for ${channelId}: ` +
                        `${messagesInBlock} messages, ~${accumulatedTokens} tokens, ` +
                        `IDs ${firstMsg.id}..${lastMsg.id}`);
                    const totalBlockTokens = boundaries.reduce((sum, b) => sum + b.tokenCount, 0);
                    const remainingTail = messages.length - i - 1;
                    console.log(`[${source}] State: ${boundaries.length} blocks (~${totalBlockTokens} tokens), ` +
                        `${remainingTail} messages in tail`);
                }
            }
            // Reset for next potential block
            accumulatedTokens = 0;
            blockStartIdx = i + 1;
            messagesInBlock = 0;
        }
    }
    return blocksCreated;
}
function checkAndFreezeBlocks(channelId) {
    freezeBlocks(channelId, {
        verbose: true,
        source: 'checkAndFreezeBlocks',
    });
}
function freezeBlocksFromHistory(channelId) {
    const blocksCreated = freezeBlocks(channelId, {
        verbose: false,
        source: 'freezeBlocksFromHistory',
    });
    if (blocksCreated > 0) {
        console.log(`Frozen ${blocksCreated} blocks from history for ${channelId}`);
    }
}
function hydrateChannelFromDatabase(channelId) {
    ensureChannelInitialized(channelId);
    const existingMessages = messagesByChannel.get(channelId) ?? [];
    const dbMessages = db.getMessages(channelId, null);
    const dbMessageIds = new Set(dbMessages.map((m) => m.id));
    const newInMemoryMessages = existingMessages.filter((m) => !dbMessageIds.has(m.id));
    const mergedMessages = [...dbMessages, ...newInMemoryMessages];
    mergedMessages.sort((a, b) => a.timestamp - b.timestamp);
    messagesByChannel.set(channelId, mergedMessages);
    messageIdsByChannel.set(channelId, new Set(mergedMessages.map((m) => m.id)));
    channelThreadIds.set(channelId, null);
    for (const msg of mergedMessages) {
        rememberUserName(msg.authorId, msg.authorName);
    }
    const boundaries = db.getBoundaries(channelId, null);
    blockBoundaries.set(channelId, boundaries);
    return {
        messageCount: mergedMessages.length,
        boundaryCount: boundaries.length,
    };
}
// ---------- Startup: Load History from Discord ----------
async function loadHistoryFromDiscord(channelIds, client, maxTokensPerChannel) {
    console.log(`Loading history for ${channelIds.length} channel(s)...`);
    for (const channelId of channelIds) {
        try {
            const startTime = Date.now();
            const hydration = hydrateChannelFromDatabase(channelId);
            const channel = await client.channels.fetch(channelId);
            if (!channel || !channel.isTextBased()) {
                console.warn(`Channel ${channelId} not found or not text-based`);
                continue;
            }
            let bootstrapCount = 0;
            let backfilledCount = 0;
            let currentMessages = messagesByChannel.get(channelId) ?? [];
            if (currentMessages.length === 0) {
                console.log(`[loadHistoryFromDiscord] Channel ${channelId} empty in DB, bootstrapping from Discord history`);
                const history = await fetchChannelHistory(channel, maxTokensPerChannel);
                for (const msg of history) {
                    appendStoredMessage(msg);
                }
                bootstrapCount = history.length;
            }
            else {
                const lastMessage = currentMessages[currentMessages.length - 1];
                if (lastMessage) {
                    backfilledCount = await backfillChannelFromDiscord(channel, channelId, lastMessage.id);
                }
            }
            freezeBlocksFromHistory(channelId);
            currentMessages = messagesByChannel.get(channelId) ?? [];
            const boundaries = blockBoundaries.get(channelId) ?? [];
            const duration = Date.now() - startTime;
            console.log(`[loadHistoryFromDiscord] ${channelId}: hydrated ${hydration.messageCount} DB messages, ` +
                `bootstrapped ${bootstrapCount}, backfilled ${backfilledCount} (total ${currentMessages.length}) ` +
                `in ${duration}ms with ${boundaries.length} frozen blocks`);
        }
        catch (err) {
            console.error(`Failed to load history for ${channelId}:`, err);
        }
    }
}
/**
 * Lazy-load a thread from the database on first access.
 * Handles per-bot reset boundaries and backfills missing messages from Discord.
 */
async function lazyLoadThread(threadId, parentChannelId, client, botUserId) {
    // Check if already hydrated
    if (hydratedChannels.get(threadId)) {
        return;
    }
    // Mark as hydrated (even if empty, to avoid repeated attempts)
    hydratedChannels.set(threadId, true);
    console.log(`[LazyLoad] Loading thread ${threadId} from database for bot ${botUserId}...`);
    try {
        // IMPORTANT: Get existing in-memory messages BEFORE loading from DB
        // These may have been appended via appendMessage() before lazy load triggered
        const existingMessages = messagesByChannel.get(threadId) ?? [];
        // Check if thread was reset for this specific bot
        const resetInfo = db.getThreadResetInfo(threadId, botUserId);
        // Always load ALL messages from database (shared storage across bots)
        let dbMessages = db.getMessages(threadId, threadId);
        const boundaries = db.getBoundaries(threadId, threadId);
        if (resetInfo) {
            if (resetInfo.lastResetDiscordMessageId) {
                console.log(`[LazyLoad] Thread ${threadId} was reset for bot ${botUserId} at Discord msg ${resetInfo.lastResetDiscordMessageId}`);
                markThreadReset(threadId, botUserId, resetInfo.lastResetDiscordMessageId);
            }
            if (resetInfo.lastResetRowId) {
                const filteredCount = dbMessages.length;
                dbMessages = dbMessages.filter((msg) => {
                    if (typeof msg.rowId !== 'number')
                        return true;
                    return msg.rowId > resetInfo.lastResetRowId;
                });
                if (dbMessages.length !== filteredCount) {
                    console.log(`[LazyLoad] Filtered ${filteredCount - dbMessages.length} pre-reset messages from DB for thread ${threadId}`);
                }
            }
        }
        // Merge database messages with existing in-memory messages
        // This prevents losing tail messages that were appended before lazy load
        const dbMessageIds = new Set(dbMessages.map((m) => m.id));
        const newInMemoryMessages = existingMessages.filter((m) => !dbMessageIds.has(m.id));
        const mergedMessages = [...dbMessages, ...newInMemoryMessages];
        // Sort by timestamp to maintain chronological order
        mergedMessages.sort((a, b) => a.timestamp - b.timestamp);
        // Initialize in-memory storage with merged messages
        ensureChannelInitialized(threadId);
        messagesByChannel.set(threadId, mergedMessages);
        messageIdsByChannel.set(threadId, new Set(mergedMessages.map((m) => m.id)));
        blockBoundaries.set(threadId, boundaries);
        channelThreadIds.set(threadId, threadId);
        console.log(`[LazyLoad] Loaded ${dbMessages.length} messages from DB, merged with ${newInMemoryMessages.length} in-memory messages (total: ${mergedMessages.length})`);
        // Backfill any messages missed during downtime from Discord
        const backfilled = await backfillThreadFromDiscord(threadId, client, botUserId);
        if (backfilled > 0) {
            console.log(`[LazyLoad] Backfilled ${backfilled} messages from Discord`);
        }
        // Freeze blocks if enough unfrozen messages accumulated
        freezeBlocksFromHistory(threadId);
    }
    catch (err) {
        console.error(`[LazyLoad] Failed to load thread ${threadId}:`, err);
        // Ensure initialized even on error
        ensureChannelInitialized(threadId);
    }
}
async function backfillChannelFromDiscord(channel, channelId, afterDiscordMessageId) {
    if (!afterDiscordMessageId) {
        return 0;
    }
    try {
        const newMessages = [];
        let afterCursor = afterDiscordMessageId;
        while (true) {
            const fetched = await channel.messages.fetch({
                limit: 100,
                after: afterCursor,
            });
            if (fetched.size === 0)
                break;
            const sorted = [...fetched.values()].sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1);
            for (const msg of sorted) {
                // Skip thread starter messages so thread hydration stays byte-identical
                if (msg.type === discord_js_1.MessageType.ThreadStarterMessage) {
                    continue;
                }
                rememberDiscordUsers(msg);
                const stored = await messageToStored(msg);
                newMessages.push(stored);
                afterCursor = msg.id;
            }
            if (fetched.size < 100)
                break;
        }
        for (const msg of newMessages) {
            appendStoredMessage(msg);
        }
        if (newMessages.length > 0) {
            console.log(`[Backfill] Channel ${channelId} fetched ${newMessages.length} new messages from Discord`);
        }
        return newMessages.length;
    }
    catch (err) {
        console.error(`[Backfill] Failed to backfill channel ${channelId}:`, err);
        return 0;
    }
}
/**
 * Backfill messages from Discord that were sent during downtime.
 * Respects per-bot reset boundaries to avoid re-fetching cleared messages.
 * Returns number of messages backfilled.
 */
async function backfillThreadFromDiscord(threadId, client, botUserId) {
    try {
        // Get the last message we have in memory
        const messages = messagesByChannel.get(threadId) ?? [];
        if (messages.length === 0) {
            // Check if thread was reset for this bot - if so, only fetch messages AFTER reset
            const resetInfo = db.getThreadResetInfo(threadId, botUserId);
            if (resetInfo?.lastResetDiscordMessageId) {
                console.log(`[Backfill] Thread ${threadId} was reset for bot ${botUserId}, fetching only post-reset messages after Discord ID ${resetInfo.lastResetDiscordMessageId}`);
                const channel = await client.channels.fetch(threadId);
                if (!channel || !channel.isTextBased()) {
                    return 0;
                }
                // Fetch messages AFTER the reset boundary
                const newMessages = [];
                let afterCursor = resetInfo.lastResetDiscordMessageId;
                while (true) {
                    const fetched = await channel.messages.fetch({
                        limit: 100,
                        after: afterCursor,
                    });
                    if (fetched.size === 0)
                        break;
                    const sorted = [...fetched.values()].sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1);
                    for (const msg of sorted) {
                        if (msg.type === discord_js_1.MessageType.ThreadStarterMessage) {
                            continue;
                        }
                        rememberDiscordUsers(msg);
                        const stored = await messageToStored(msg);
                        newMessages.push(stored);
                        afterCursor = msg.id;
                    }
                    if (fetched.size < 100)
                        break;
                }
                // Store post-reset messages
                for (const msg of newMessages) {
                    appendStoredMessage(msg);
                }
                console.log(`[Backfill] Fetched ${newMessages.length} post-reset messages`);
                return newMessages.length;
            }
            // No reset - fetch full history (new thread)
            console.log(`[Backfill] Thread ${threadId} has no messages, fetching full history from Discord`);
            const channel = await client.channels.fetch(threadId);
            if (!channel || !channel.isTextBased()) {
                return 0;
            }
            const fetchedMessages = await fetchChannelHistory(channel, config_1.globalConfig.maxContextTokens);
            // Store all fetched messages
            for (const msg of fetchedMessages) {
                appendStoredMessage(msg);
            }
            return fetchedMessages.length;
        }
        // Get the latest message ID from our store
        const lastMessage = messages[messages.length - 1];
        if (!lastMessage)
            return 0;
        const lastDiscordId = lastMessage.id;
        // Fetch messages after this ID from Discord
        const channel = await client.channels.fetch(threadId);
        if (!channel || !channel.isTextBased()) {
            return 0;
        }
        const newMessages = [];
        let afterCursor = lastDiscordId;
        // Fetch forward from last known message
        while (true) {
            const fetched = await channel.messages.fetch({
                limit: 100,
                after: afterCursor,
            });
            if (fetched.size === 0)
                break;
            // Sort oldest to newest
            const sorted = [...fetched.values()].sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1);
            for (const msg of sorted) {
                if (msg.type === discord_js_1.MessageType.ThreadStarterMessage) {
                    continue;
                }
                rememberDiscordUsers(msg);
                const stored = await messageToStored(msg);
                newMessages.push(stored);
                afterCursor = msg.id;
            }
            if (fetched.size < 100)
                break; // No more messages
        }
        // Store all new messages
        for (const msg of newMessages) {
            appendStoredMessage(msg);
        }
        return newMessages.length;
    }
    catch (err) {
        console.error(`[Backfill] Failed to backfill thread ${threadId}:`, err);
        return 0;
    }
}
async function fetchChannelHistory(channel, maxTokens, mustIncludeMessageId) {
    const messages = [];
    let totalTokens = 0;
    let beforeCursor = undefined;
    let foundRequiredMessage = !mustIncludeMessageId; // If no requirement, consider it found
    // Fetch backward from most recent
    // Continue until: (hit token limit AND found required message) OR no more messages
    while (!foundRequiredMessage || totalTokens < maxTokens) {
        const fetched = await channel.messages.fetch({
            limit: 100,
            before: beforeCursor,
        });
        if (fetched.size === 0)
            break;
        const sorted = [...fetched.values()].sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1);
        const batch = [];
        let batchTokens = 0;
        for (const msg of sorted) {
            if (msg.type === discord_js_1.MessageType.ThreadStarterMessage) {
                continue;
            }
            rememberDiscordUsers(msg);
            const stored = await messageToStored(msg);
            const tokens = estimateMessageTokens(stored.authorName, stored.content);
            batch.push(stored);
            batchTokens += tokens;
            // Check if we found the required message
            if (mustIncludeMessageId && msg.id === mustIncludeMessageId) {
                foundRequiredMessage = true;
            }
        }
        // Prepend batch (older messages first)
        messages.unshift(...batch);
        totalTokens += batchTokens;
        // Move cursor to oldest message
        beforeCursor = sorted[0]?.id;
        if (fetched.size < 100)
            break;
    }
    if (mustIncludeMessageId && !foundRequiredMessage) {
        console.warn(`[fetchChannelHistory] Required message ${mustIncludeMessageId} not found in history. ` +
            `Boundaries may be invalidated.`);
    }
    // Trim oldest if over budget, but NEVER trim past the required message
    while (totalTokens > maxTokens && messages.length > 0) {
        const oldestMessage = messages[0];
        if (!oldestMessage)
            break;
        // Don't trim if this is the required message or we haven't passed it yet
        if (mustIncludeMessageId && oldestMessage.id === mustIncludeMessageId) {
            console.log(`[fetchChannelHistory] Stopping trim at required message ${mustIncludeMessageId} to preserve cache boundaries`);
            break;
        }
        const removed = messages.shift();
        if (removed) {
            totalTokens -= estimateMessageTokens(removed.authorName, removed.content);
        }
    }
    return messages;
}
// ---------- Utilities ----------
function clearChannel(channelId) {
    messagesByChannel.delete(channelId);
    messageIdsByChannel.delete(channelId);
    blockBoundaries.delete(channelId);
    channelThreadIds.delete(channelId);
    try {
        db.clearChannel(channelId);
    }
    catch (err) {
        console.error('[Database] Failed to clear channel:', err);
    }
}
/**
 * Clear a thread's history (both in-memory and database).
 * Records reset metadata to prevent reloading pre-reset messages after downtime.
 *
 * @param resetMessageId - The Discord message ID of the /reset command (used as boundary)
 * @param botId - Discord bot user ID. If provided, only resets for that bot. If null, resets for ALL bots.
 */
function clearThread(threadId, parentChannelId, resetMessageId, botId) {
    if (botId) {
        // Per-bot reset: don't clear shared storage, just mark reset for this bot
        markThreadReset(threadId, botId, resetMessageId);
        // Record in database
        try {
            const lastRowId = db.getLastRowId(threadId, threadId);
            const messageIdForReset = resetMessageId ??
                (lastRowId !== null ? db.getDiscordMessageId(lastRowId) ?? undefined : undefined);
            if (lastRowId !== null && messageIdForReset) {
                db.recordThreadReset(threadId, lastRowId, messageIdForReset, botId);
                console.log(`[Reset] Recorded reset boundary for bot ${botId} in thread ${threadId} at row_id ${lastRowId}, Discord msg ${messageIdForReset}`);
            }
        }
        catch (err) {
            console.error('[Database] Failed to record per-bot reset:', err);
        }
    }
    else {
        // Global reset: clear everything for all bots
        // Clear in-memory (currently stored by thread's channelId)
        messagesByChannel.delete(threadId);
        messageIdsByChannel.delete(threadId);
        blockBoundaries.delete(threadId);
        channelThreadIds.delete(threadId);
        hydratedChannels.delete(threadId); // Clear hydration flag
        markThreadReset(threadId, null, resetMessageId); // Clear all bot reset markers
        // Clear from database and record reset if enabled
        try {
            // Get the last row_id BEFORE clearing (for reset tracking)
            const lastRowId = db.getLastRowId(threadId, threadId);
            const messageIdForReset = resetMessageId ??
                (lastRowId !== null ? db.getDiscordMessageId(lastRowId) ?? undefined : undefined);
            // Record reset metadata BEFORE clearing (clears all bot-specific resets)
            // Use the /reset message ID as the boundary so backfill excludes it
            if (lastRowId !== null && messageIdForReset) {
                db.recordThreadReset(threadId, lastRowId, messageIdForReset, null);
                console.log(`[Reset] Recorded global reset boundary for thread ${threadId} at row_id ${lastRowId}, Discord msg ${messageIdForReset}`);
            }
            // Now clear messages and boundaries
            // For threads, channel_id in DB equals the thread's own ID
            db.clearThread(threadId, threadId);
        }
        catch (err) {
            console.error('[Database] Failed to clear thread:', err);
        }
    }
}
function clearAll() {
    messagesByChannel.clear();
    messageIdsByChannel.clear();
    blockBoundaries.clear();
    channelThreadIds.clear();
    hydratedChannels.clear();
    resetThreads.clear();
}
exports.__testing = {
    hydrateChannelFromDatabase,
};
function getStats() {
    let totalMessages = 0;
    let totalBlocks = 0;
    for (const messages of messagesByChannel.values()) {
        totalMessages += messages.length;
    }
    for (const boundaries of blockBoundaries.values()) {
        totalBlocks += boundaries.length;
    }
    return {
        channels: messagesByChannel.size,
        totalMessages,
        totalBlocks,
    };
}
function getChannelSpeakers(channelId, excludeBotId) {
    const messages = messagesByChannel.get(channelId) ?? [];
    const speakers = new Set();
    for (const msg of messages) {
        if (excludeBotId && msg.authorId === excludeBotId)
            continue;
        // Filter out meta-messages (commands and system responses)
        if (isMetaMessage(msg.content))
            continue;
        // Defensive check: only add if authorName is defined
        if (msg.authorName) {
            speakers.add(msg.authorName);
        }
    }
    return [...speakers];
}
