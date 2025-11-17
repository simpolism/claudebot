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
exports.appendMessage = appendMessage;
exports.getChannelMessages = getChannelMessages;
exports.getBlockBoundaries = getBlockBoundaries;
exports.getContext = getContext;
exports.loadBoundariesFromDisk = loadBoundariesFromDisk;
exports.saveBoundariesToDisk = saveBoundariesToDisk;
exports.loadHistoryFromDiscord = loadHistoryFromDiscord;
exports.clearChannel = clearChannel;
exports.clearAll = clearAll;
exports.getStats = getStats;
const fs = __importStar(require("fs"));
const config_1 = require("./config");
// ---------- Constants ----------
const BOUNDARY_FILE = 'conversation-cache.json';
const DEFAULT_TOKENS_PER_BLOCK = 30000;
// ---------- In-Memory Storage ----------
const messagesByChannel = new Map();
const blockBoundaries = new Map();
// ---------- Message Management ----------
function appendMessage(message) {
    const channelId = message.channel.id;
    if (!messagesByChannel.has(channelId)) {
        messagesByChannel.set(channelId, []);
    }
    if (!blockBoundaries.has(channelId)) {
        blockBoundaries.set(channelId, []);
    }
    const stored = {
        id: message.id,
        channelId,
        authorId: message.author.id,
        authorName: message.author.username ?? message.author.globalName ?? message.author.tag,
        content: message.content || '(empty message)',
        timestamp: message.createdTimestamp,
    };
    messagesByChannel.get(channelId).push(stored);
    checkAndFreezeBlocks(channelId);
}
function getChannelMessages(channelId) {
    return messagesByChannel.get(channelId) ?? [];
}
function getBlockBoundaries(channelId) {
    return blockBoundaries.get(channelId) ?? [];
}
function getContext(channelId, maxTokens, botUserId, botDisplayName) {
    const messages = messagesByChannel.get(channelId) ?? [];
    const boundaries = blockBoundaries.get(channelId) ?? [];
    // Build frozen blocks
    const blocks = [];
    let blocksTokenCount = 0;
    let lastBlockEndIdx = -1;
    for (const boundary of boundaries) {
        const blockMessages = getMessagesInRange(messages, boundary.firstMessageId, boundary.lastMessageId);
        const blockText = formatMessages(blockMessages, botUserId, botDisplayName);
        blocks.push(blockText);
        blocksTokenCount += boundary.tokenCount;
        // Track where this block ends in the array
        const endIdx = messages.findIndex((m) => m.id === boundary.lastMessageId);
        if (endIdx !== -1) {
            lastBlockEndIdx = endIdx;
        }
    }
    // Build tail (messages after last frozen block)
    const tailMessages = messages.slice(lastBlockEndIdx + 1);
    const tailFormatted = [];
    let tailTokenCount = 0;
    for (const msg of tailMessages) {
        const formatted = formatMessage(msg, botUserId, botDisplayName);
        const tokens = estimateTokens(formatted);
        tailFormatted.push(formatted);
        tailTokenCount += tokens;
    }
    // Trim if over budget (remove oldest blocks first, then oldest tail)
    let totalTokens = blocksTokenCount + tailTokenCount;
    const finalBlocks = [...blocks];
    const finalTail = [...tailFormatted];
    while (totalTokens > maxTokens && finalBlocks.length > 0) {
        const removedBlock = finalBlocks.shift();
        if (removedBlock) {
            totalTokens -= estimateTokens(removedBlock);
        }
    }
    while (totalTokens > maxTokens && finalTail.length > 0) {
        const removedMsg = finalTail.shift();
        if (removedMsg) {
            totalTokens -= estimateTokens(removedMsg);
        }
    }
    return {
        blocks: finalBlocks,
        tail: finalTail,
        totalTokens,
    };
}
function getMessagesInRange(messages, firstId, lastId) {
    const result = [];
    let inRange = false;
    for (const msg of messages) {
        if (msg.id === firstId) {
            inRange = true;
        }
        if (inRange) {
            result.push(msg);
        }
        if (msg.id === lastId) {
            break;
        }
    }
    return result;
}
function formatMessage(msg, botUserId, botDisplayName) {
    const authorName = msg.authorId === botUserId ? botDisplayName : msg.authorName;
    return `${authorName}: ${msg.content.trim() || '(empty message)'}`;
}
function formatMessages(messages, botUserId, botDisplayName) {
    return messages.map((m) => formatMessage(m, botUserId, botDisplayName)).join('\n');
}
function estimateTokens(text) {
    return Math.ceil(text.length / Math.max(config_1.globalConfig.approxCharsPerToken, 1));
}
// ---------- Block Freezing ----------
function checkAndFreezeBlocks(channelId) {
    const messages = messagesByChannel.get(channelId);
    const boundaries = blockBoundaries.get(channelId);
    if (!messages || !boundaries)
        return;
    // Find where tail starts
    let tailStartIdx = 0;
    if (boundaries.length > 0) {
        const lastBoundary = boundaries[boundaries.length - 1];
        const lastBoundaryIdx = messages.findIndex((m) => m.id === lastBoundary.lastMessageId);
        if (lastBoundaryIdx !== -1) {
            tailStartIdx = lastBoundaryIdx + 1;
        }
    }
    // Accumulate tail tokens
    let accumulatedTokens = 0;
    let blockStartIdx = tailStartIdx;
    for (let i = tailStartIdx; i < messages.length; i++) {
        const msg = messages[i];
        if (!msg)
            continue;
        const msgText = `${msg.authorName}: ${msg.content}`;
        const tokens = estimateTokens(msgText) + 4; // +4 for overhead
        accumulatedTokens += tokens;
        // Freeze block when threshold reached
        if (accumulatedTokens >= DEFAULT_TOKENS_PER_BLOCK) {
            const firstMsg = messages[blockStartIdx];
            const lastMsg = messages[i];
            if (firstMsg && lastMsg) {
                boundaries.push({
                    firstMessageId: firstMsg.id,
                    lastMessageId: lastMsg.id,
                    tokenCount: accumulatedTokens,
                });
                console.log(`Frozen new block for ${channelId} (~${accumulatedTokens} tokens)`);
                saveBoundariesToDisk();
            }
            // Reset for next potential block
            accumulatedTokens = 0;
            blockStartIdx = i + 1;
        }
    }
}
function freezeBlocksFromHistory(channelId) {
    const messages = messagesByChannel.get(channelId);
    const boundaries = blockBoundaries.get(channelId);
    if (!messages || !boundaries)
        return;
    // Find where we need to start (after any existing boundaries)
    let startIdx = 0;
    if (boundaries.length > 0) {
        const lastBoundary = boundaries[boundaries.length - 1];
        const lastBoundaryIdx = messages.findIndex((m) => m.id === lastBoundary.lastMessageId);
        if (lastBoundaryIdx !== -1) {
            startIdx = lastBoundaryIdx + 1;
        }
    }
    // Freeze all complete blocks from history
    let accumulatedTokens = 0;
    let blockStartIdx = startIdx;
    let blocksCreated = 0;
    for (let i = startIdx; i < messages.length; i++) {
        const msg = messages[i];
        if (!msg)
            continue;
        const msgText = `${msg.authorName}: ${msg.content}`;
        const tokens = estimateTokens(msgText) + 4;
        accumulatedTokens += tokens;
        if (accumulatedTokens >= DEFAULT_TOKENS_PER_BLOCK) {
            const firstMsg = messages[blockStartIdx];
            const lastMsg = messages[i];
            if (firstMsg && lastMsg) {
                boundaries.push({
                    firstMessageId: firstMsg.id,
                    lastMessageId: lastMsg.id,
                    tokenCount: accumulatedTokens,
                });
                blocksCreated++;
            }
            accumulatedTokens = 0;
            blockStartIdx = i + 1;
        }
    }
    if (blocksCreated > 0) {
        console.log(`Frozen ${blocksCreated} blocks from history for ${channelId}`);
        saveBoundariesToDisk();
    }
}
// ---------- Disk Persistence (Boundaries Only) ----------
function loadBoundariesFromDisk() {
    try {
        if (fs.existsSync(BOUNDARY_FILE)) {
            const data = fs.readFileSync(BOUNDARY_FILE, 'utf-8');
            const parsed = JSON.parse(data);
            for (const [channelId, boundaries] of Object.entries(parsed.channels || {})) {
                blockBoundaries.set(channelId, boundaries);
            }
            console.log(`Loaded block boundaries for ${blockBoundaries.size} channel(s)`);
        }
        else {
            console.log('No boundary file found, starting fresh');
        }
    }
    catch (err) {
        console.warn('Failed to load boundaries, starting fresh:', err);
    }
}
function saveBoundariesToDisk() {
    try {
        const store = {
            channels: Object.fromEntries(blockBoundaries.entries()),
        };
        fs.writeFileSync(BOUNDARY_FILE, JSON.stringify(store, null, 2));
    }
    catch (err) {
        console.error('Failed to save boundaries:', err);
    }
}
// ---------- Startup: Load History from Discord ----------
async function loadHistoryFromDiscord(channelIds, client, maxTokensPerChannel) {
    console.log(`Loading history for ${channelIds.length} channel(s)...`);
    for (const channelId of channelIds) {
        try {
            const channel = await client.channels.fetch(channelId);
            if (!channel || !channel.isTextBased()) {
                console.warn(`Channel ${channelId} not found or not text-based`);
                continue;
            }
            const startTime = Date.now();
            const messages = await fetchChannelHistory(channel, maxTokensPerChannel);
            // Initialize storage for this channel
            messagesByChannel.set(channelId, messages);
            if (!blockBoundaries.has(channelId)) {
                blockBoundaries.set(channelId, []);
            }
            // Rebuild blocks according to saved boundaries
            rebuildBlocksFromBoundaries(channelId);
            // Freeze any new blocks from loaded history
            freezeBlocksFromHistory(channelId);
            const duration = Date.now() - startTime;
            const boundaries = blockBoundaries.get(channelId) ?? [];
            console.log(`Loaded ${messages.length} messages for ${channelId} in ${duration}ms (${boundaries.length} frozen blocks)`);
        }
        catch (err) {
            console.error(`Failed to load history for ${channelId}:`, err);
        }
    }
}
async function fetchChannelHistory(channel, maxTokens) {
    const messages = [];
    let totalTokens = 0;
    let beforeCursor = undefined;
    // Fetch backward from most recent
    while (totalTokens < maxTokens) {
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
            const stored = {
                id: msg.id,
                channelId: channel.id,
                authorId: msg.author.id,
                authorName: msg.author.username ?? msg.author.globalName ?? msg.author.tag,
                content: msg.content || '(empty message)',
                timestamp: msg.createdTimestamp,
            };
            const tokens = estimateTokens(`${stored.authorName}: ${stored.content}`) + 4;
            batch.push(stored);
            batchTokens += tokens;
        }
        // Prepend batch (older messages first)
        messages.unshift(...batch);
        totalTokens += batchTokens;
        // Move cursor to oldest message
        beforeCursor = sorted[0]?.id;
        if (fetched.size < 100)
            break;
    }
    // Trim oldest if over budget
    while (totalTokens > maxTokens && messages.length > 0) {
        const removed = messages.shift();
        if (removed) {
            totalTokens -= estimateTokens(`${removed.authorName}: ${removed.content}`) + 4;
        }
    }
    return messages;
}
function rebuildBlocksFromBoundaries(channelId) {
    const messages = messagesByChannel.get(channelId);
    const boundaries = blockBoundaries.get(channelId);
    if (!messages || !boundaries || boundaries.length === 0)
        return;
    // Verify boundaries match loaded messages
    // If messages don't contain boundary IDs, boundaries are stale
    const validBoundaries = [];
    for (const boundary of boundaries) {
        const hasFirst = messages.some((m) => m.id === boundary.firstMessageId);
        const hasLast = messages.some((m) => m.id === boundary.lastMessageId);
        if (hasFirst && hasLast) {
            validBoundaries.push(boundary);
        }
        else {
            console.warn(`Boundary ${boundary.firstMessageId}-${boundary.lastMessageId} not found in loaded messages, skipping`);
        }
    }
    blockBoundaries.set(channelId, validBoundaries);
    if (validBoundaries.length !== boundaries.length) {
        saveBoundariesToDisk();
    }
}
// ---------- Utilities ----------
function clearChannel(channelId) {
    messagesByChannel.delete(channelId);
    blockBoundaries.delete(channelId);
}
function clearAll() {
    messagesByChannel.clear();
    blockBoundaries.clear();
}
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
