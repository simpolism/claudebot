import * as fs from 'fs';
import * as path from 'path';

// Cached block structure - stores exact text for byte-perfect cache hits
interface CachedBlock {
  text: string;
  lastMessageId: string;
  tokenCount: number;
}

interface ChannelCache {
  blocks: CachedBlock[];
}

interface CacheStore {
  channels: Record<string, ChannelCache>;
}

const CACHE_FILE = 'conversation-cache.json';
const DEFAULT_TOKENS_PER_BLOCK = 30000; // ~30k tokens per cached block

let cacheStore: CacheStore = { channels: {} };

// Load cache from disk on startup
export function loadCache(): void {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const data = fs.readFileSync(CACHE_FILE, 'utf-8');
      cacheStore = JSON.parse(data);
      console.log(
        `Loaded cache with ${Object.keys(cacheStore.channels).length} channel(s)`,
      );
    } else {
      console.log('No cache file found, starting fresh');
    }
  } catch (err) {
    console.warn('Failed to load cache file, starting fresh:', err);
    cacheStore = { channels: {} };
  }
}

// Save cache to disk
function saveCache(): void {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cacheStore, null, 2));
  } catch (err) {
    console.error('Failed to save cache file:', err);
  }
}

// Get cached blocks for a channel
export function getCachedBlocks(channelId: string): CachedBlock[] {
  return cacheStore.channels[channelId]?.blocks || [];
}

// Get the last message ID we have cached for a channel
export function getLastCachedMessageId(channelId: string): string | null {
  const blocks = getCachedBlocks(channelId);
  if (blocks.length === 0) return null;
  return blocks[blocks.length - 1].lastMessageId;
}

// Add new messages to cache, potentially creating new blocks
export function updateCache(
  channelId: string,
  newMessages: Array<{ id: string; formattedText: string; tokens: number }>,
  tokensPerBlock: number = DEFAULT_TOKENS_PER_BLOCK,
): void {
  if (newMessages.length === 0) return;

  if (!cacheStore.channels[channelId]) {
    cacheStore.channels[channelId] = { blocks: [] };
  }

  const channelCache = cacheStore.channels[channelId];

  // Accumulate new messages into text
  let accumulatedText = '';
  let accumulatedTokens = 0;
  let lastMessageId = '';

  for (const msg of newMessages) {
    accumulatedText += msg.formattedText + '\n';
    accumulatedTokens += msg.tokens;
    lastMessageId = msg.id;

    // When we hit the token threshold, create a new cached block
    if (accumulatedTokens >= tokensPerBlock) {
      channelCache.blocks.push({
        text: accumulatedText.trimEnd(),
        lastMessageId,
        tokenCount: accumulatedTokens,
      });
      console.log(
        `Created new cache block for channel ${channelId} (~${accumulatedTokens} tokens)`,
      );
      accumulatedText = '';
      accumulatedTokens = 0;
    }
  }

  // Don't cache the remaining tail - it will be the "fresh" part
  // Only save if we created new blocks
  if (
    channelCache.blocks.length > 0 &&
    newMessages.length > 0 &&
    accumulatedTokens < tokensPerBlock
  ) {
    saveCache();
  }
}

// Clear cache for a channel (if needed)
export function clearChannelCache(channelId: string): void {
  delete cacheStore.channels[channelId];
  saveCache();
}

// Get total cached tokens for a channel
export function getCachedTokenCount(channelId: string): number {
  const blocks = getCachedBlocks(channelId);
  return blocks.reduce((sum, block) => sum + block.tokenCount, 0);
}
