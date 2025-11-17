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
exports.loadCache = loadCache;
exports.getCachedBlocks = getCachedBlocks;
exports.getLastCachedMessageId = getLastCachedMessageId;
exports.updateCache = updateCache;
exports.clearChannelCache = clearChannelCache;
exports.getCachedTokenCount = getCachedTokenCount;
const fs = __importStar(require("fs"));
const CACHE_FILE = 'conversation-cache.json';
const DEFAULT_TOKENS_PER_BLOCK = 30000; // ~30k tokens per cached block
let cacheStore = { channels: {} };
// Load cache from disk on startup
function loadCache() {
    try {
        if (fs.existsSync(CACHE_FILE)) {
            const data = fs.readFileSync(CACHE_FILE, 'utf-8');
            const parsed = JSON.parse(data);
            cacheStore = {
                channels: Object.fromEntries(Object.entries(parsed.channels || {}).map(([channelId, channelCache]) => {
                    const blocks = channelCache.blocks?.map((block) => ({
                        text: block.text,
                        firstMessageId: block.firstMessageId || block.lastMessageId,
                        lastMessageId: block.lastMessageId,
                        tokenCount: block.tokenCount,
                    })) || [];
                    return [channelId, { blocks }];
                })),
            };
            console.log(`Loaded cache with ${Object.keys(cacheStore.channels).length} channel(s)`);
        }
        else {
            console.log('No cache file found, starting fresh');
        }
    }
    catch (err) {
        console.warn('Failed to load cache file, starting fresh:', err);
        cacheStore = { channels: {} };
    }
}
// Save cache to disk
function saveCache() {
    try {
        const serializable = {
            channels: Object.fromEntries(Object.entries(cacheStore.channels).map(([channelId, channelCache]) => [
                channelId,
                {
                    blocks: channelCache.blocks.map((block) => ({
                        firstMessageId: block.firstMessageId,
                        lastMessageId: block.lastMessageId,
                        tokenCount: block.tokenCount,
                    })),
                },
            ])),
        };
        fs.writeFileSync(CACHE_FILE, JSON.stringify(serializable, null, 2));
    }
    catch (err) {
        console.error('Failed to save cache file:', err);
    }
}
// Get cached blocks for a channel
function getCachedBlocks(channelId) {
    return cacheStore.channels[channelId]?.blocks || [];
}
// Get the last message ID we have cached for a channel
function getLastCachedMessageId(channelId) {
    const blocks = getCachedBlocks(channelId);
    if (blocks.length === 0)
        return null;
    return blocks[blocks.length - 1].lastMessageId;
}
// Add new messages to cache, potentially creating new blocks
function updateCache(channelId, newMessages, tokensPerBlock = DEFAULT_TOKENS_PER_BLOCK) {
    if (newMessages.length === 0)
        return;
    if (!cacheStore.channels[channelId]) {
        cacheStore.channels[channelId] = { blocks: [] };
    }
    const channelCache = cacheStore.channels[channelId];
    // Accumulate new messages into text
    let accumulatedText = '';
    let accumulatedTokens = 0;
    let lastMessageId = '';
    let blockStartId = null;
    let createdBlock = false;
    for (const msg of newMessages) {
        if (!blockStartId) {
            blockStartId = msg.id;
        }
        accumulatedText += msg.formattedText + '\n';
        accumulatedTokens += msg.tokens;
        lastMessageId = msg.id;
        // When we hit the token threshold, create a new cached block
        if (accumulatedTokens >= tokensPerBlock) {
            const firstMessageId = blockStartId ?? lastMessageId;
            channelCache.blocks.push({
                text: accumulatedText.trimEnd(),
                firstMessageId,
                lastMessageId,
                tokenCount: accumulatedTokens,
            });
            console.log(`Created new cache block for channel ${channelId} (~${accumulatedTokens} tokens)`);
            createdBlock = true;
            accumulatedText = '';
            accumulatedTokens = 0;
            blockStartId = null;
        }
    }
    // Don't cache the remaining tail - it will be the "fresh" part
    // Only save if we created new blocks
    if (createdBlock) {
        saveCache();
    }
}
// Clear cache for a channel (if needed)
function clearChannelCache(channelId) {
    delete cacheStore.channels[channelId];
    saveCache();
}
// Get total cached tokens for a channel
function getCachedTokenCount(channelId) {
    const blocks = getCachedBlocks(channelId);
    return blocks.reduce((sum, block) => sum + block.tokenCount, 0);
}
