import { Client, Message, Collection } from 'discord.js';
import * as fs from 'fs';
import { globalConfig } from './config';

// ---------- Types ----------

export interface StoredMessage {
  id: string;
  channelId: string;
  authorId: string;
  authorName: string;
  content: string;
  timestamp: number;
}

export interface BlockBoundary {
  firstMessageId: string;
  lastMessageId: string;
  tokenCount: number;
}

interface BoundaryStore {
  channels: Record<string, BlockBoundary[]>;
}

// ---------- Constants ----------

const BOUNDARY_FILE = 'conversation-cache.json';
const DEFAULT_TOKENS_PER_BLOCK = 30000;

// ---------- In-Memory Storage ----------

const messagesByChannel = new Map<string, StoredMessage[]>();
const blockBoundaries = new Map<string, BlockBoundary[]>();


// ---------- Message Management ----------

export function appendMessage(message: Message): void {
  const channelId = message.channel.id;

  if (!messagesByChannel.has(channelId)) {
    messagesByChannel.set(channelId, []);
  }
  if (!blockBoundaries.has(channelId)) {
    blockBoundaries.set(channelId, []);
  }

  const messages = messagesByChannel.get(channelId)!;

  // Deduplicate: skip if message ID already exists
  if (messages.some((m) => m.id === message.id)) {
    return;
  }

  const stored: StoredMessage = {
    id: message.id,
    channelId,
    authorId: message.author.id,
    authorName: message.author.username ?? message.author.globalName ?? message.author.tag,
    content: message.content || '(empty message)',
    timestamp: message.createdTimestamp,
  };

  messages.push(stored);
  checkAndFreezeBlocks(channelId);
}

export function appendStoredMessage(stored: StoredMessage): void {
  const channelId = stored.channelId;

  if (!messagesByChannel.has(channelId)) {
    messagesByChannel.set(channelId, []);
  }
  if (!blockBoundaries.has(channelId)) {
    blockBoundaries.set(channelId, []);
  }

  const messages = messagesByChannel.get(channelId)!;

  // Deduplicate: skip if message ID already exists
  if (messages.some((m) => m.id === stored.id)) {
    return;
  }

  messages.push(stored);
  checkAndFreezeBlocks(channelId);
}

export function getChannelMessages(channelId: string): StoredMessage[] {
  return messagesByChannel.get(channelId) ?? [];
}

export function getBlockBoundaries(channelId: string): BlockBoundary[] {
  return blockBoundaries.get(channelId) ?? [];
}

// ---------- Context Building ----------

export interface ContextResult {
  blocks: string[];
  tail: string[];
  totalTokens: number;
}

export function getContext(
  channelId: string,
  maxTokens: number,
  botUserId: string,
  botDisplayName: string,
): ContextResult {
  const messages = messagesByChannel.get(channelId) ?? [];
  const boundaries = blockBoundaries.get(channelId) ?? [];

  // Build frozen blocks with their stored token counts
  const blockData: Array<{ text: string; tokens: number }> = [];
  let lastBlockEndIdx = -1;

  for (const boundary of boundaries) {
    const blockMessages = getMessagesInRange(messages, boundary.firstMessageId, boundary.lastMessageId);
    const blockText = formatMessages(blockMessages, botUserId, botDisplayName);
    blockData.push({ text: blockText, tokens: boundary.tokenCount });

    // Track where this block ends in the array
    const endIdx = messages.findIndex((m) => m.id === boundary.lastMessageId);
    if (endIdx !== -1) {
      lastBlockEndIdx = endIdx;
    }
  }

  // Build tail (messages after last frozen block)
  const tailMessages = messages.slice(lastBlockEndIdx + 1);
  const tailData: Array<{ text: string; tokens: number }> = [];

  for (const msg of tailMessages) {
    const formatted = formatMessage(msg, botUserId, botDisplayName);
    const tokens = estimateTokens(formatted) + 4; // +4 for overhead, consistent with freeze
    tailData.push({ text: formatted, tokens });
  }

  // Calculate totals
  let blocksTokenCount = blockData.reduce((sum, b) => sum + b.tokens, 0);
  let tailTokenCount = tailData.reduce((sum, t) => sum + t.tokens, 0);
  let totalTokens = blocksTokenCount + tailTokenCount;

  // Trim if over budget (remove oldest blocks first, then oldest tail)
  const finalBlockData = [...blockData];
  const finalTailData = [...tailData];
  let evictedBlocks = 0;
  let evictedTailMessages = 0;

  while (totalTokens > maxTokens && finalBlockData.length > 0) {
    const removed = finalBlockData.shift();
    if (removed) {
      totalTokens -= removed.tokens;
      evictedBlocks++;
    }
  }

  while (totalTokens > maxTokens && finalTailData.length > 0) {
    const removed = finalTailData.shift();
    if (removed) {
      totalTokens -= removed.tokens;
      evictedTailMessages++;
    }
  }

  if (evictedBlocks > 0 || evictedTailMessages > 0) {
    console.log(
      `[getContext] Evicted ${evictedBlocks} blocks and ${evictedTailMessages} tail messages to fit ${maxTokens} token budget`,
    );
  }

  return {
    blocks: finalBlockData.map((b) => b.text),
    tail: finalTailData.map((t) => t.text),
    totalTokens,
  };
}

function getMessagesInRange(
  messages: StoredMessage[],
  firstId: string,
  lastId: string,
): StoredMessage[] {
  const result: StoredMessage[] = [];
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

function formatMessage(msg: StoredMessage, botUserId: string, botDisplayName: string): string {
  const authorName = msg.authorId === botUserId ? botDisplayName : msg.authorName;
  return `${authorName}: ${msg.content.trim() || '(empty message)'}`;
}

function formatMessages(messages: StoredMessage[], botUserId: string, botDisplayName: string): string {
  return messages.map((m) => formatMessage(m, botUserId, botDisplayName)).join('\n');
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / Math.max(globalConfig.approxCharsPerToken, 1));
}

// ---------- Block Freezing ----------

function checkAndFreezeBlocks(channelId: string): void {
  const messages = messagesByChannel.get(channelId);
  const boundaries = blockBoundaries.get(channelId);

  if (!messages || !boundaries) return;

  // Find where tail starts
  let tailStartIdx = 0;
  if (boundaries.length > 0) {
    const lastBoundary = boundaries[boundaries.length - 1];
    const lastBoundaryIdx = messages.findIndex((m) => m.id === lastBoundary.lastMessageId);
    if (lastBoundaryIdx !== -1) {
      tailStartIdx = lastBoundaryIdx + 1;
    } else {
      console.error(
        `[checkAndFreezeBlocks] CRITICAL: lastBoundary.lastMessageId ${lastBoundary.lastMessageId} not found in messages!`,
      );
    }
  }

  // Accumulate tail tokens
  let accumulatedTokens = 0;
  let blockStartIdx = tailStartIdx;
  let messagesInBlock = 0;

  for (let i = tailStartIdx; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg) continue;
    const msgText = `${msg.authorName}: ${msg.content}`;
    const tokens = estimateTokens(msgText) + 4; // +4 for overhead
    accumulatedTokens += tokens;
    messagesInBlock++;

    // Freeze block when threshold reached
    if (accumulatedTokens >= DEFAULT_TOKENS_PER_BLOCK) {
      const firstMsg = messages[blockStartIdx];
      const lastMsg = messages[i];
      if (firstMsg && lastMsg) {
        const newBoundary = {
          firstMessageId: firstMsg.id,
          lastMessageId: lastMsg.id,
          tokenCount: accumulatedTokens,
        };
        boundaries.push(newBoundary);
        console.log(
          `[checkAndFreezeBlocks] Frozen block #${boundaries.length} for ${channelId}: ` +
            `${messagesInBlock} messages, ~${accumulatedTokens} tokens, ` +
            `IDs ${firstMsg.id}..${lastMsg.id}`,
        );

        // Debug: Show total state after freeze
        const totalBlockTokens = boundaries.reduce((sum, b) => sum + b.tokenCount, 0);
        const remainingTail = messages.length - i - 1;
        console.log(
          `[checkAndFreezeBlocks] State: ${boundaries.length} blocks (~${totalBlockTokens} tokens), ` +
            `${remainingTail} messages in tail`,
        );

        saveBoundariesToDisk();
      }

      // Reset for next potential block
      accumulatedTokens = 0;
      blockStartIdx = i + 1;
      messagesInBlock = 0;
    }
  }
}

function freezeBlocksFromHistory(channelId: string): void {
  const messages = messagesByChannel.get(channelId);
  const boundaries = blockBoundaries.get(channelId);

  if (!messages || !boundaries) return;

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
    if (!msg) continue;
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

export function loadBoundariesFromDisk(): void {
  try {
    if (fs.existsSync(BOUNDARY_FILE)) {
      const data = fs.readFileSync(BOUNDARY_FILE, 'utf-8');
      const parsed: BoundaryStore = JSON.parse(data);

      for (const [channelId, boundaries] of Object.entries(parsed.channels || {})) {
        blockBoundaries.set(channelId, boundaries);
      }

      console.log(`Loaded block boundaries for ${blockBoundaries.size} channel(s)`);
    } else {
      console.log('No boundary file found, starting fresh');
    }
  } catch (err) {
    console.warn('Failed to load boundaries, starting fresh:', err);
  }
}

export function saveBoundariesToDisk(): void {
  try {
    const store: BoundaryStore = {
      channels: Object.fromEntries(blockBoundaries.entries()),
    };
    fs.writeFileSync(BOUNDARY_FILE, JSON.stringify(store, null, 2));
  } catch (err) {
    console.error('Failed to save boundaries:', err);
  }
}

// ---------- Startup: Load History from Discord ----------

export async function loadHistoryFromDiscord(
  channelIds: string[],
  client: Client,
  maxTokensPerChannel: number,
): Promise<void> {
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
      console.log(
        `Loaded ${messages.length} messages for ${channelId} in ${duration}ms (${boundaries.length} frozen blocks)`,
      );
    } catch (err) {
      console.error(`Failed to load history for ${channelId}:`, err);
    }
  }
}

async function fetchChannelHistory(
  channel: Message['channel'] & { isTextBased(): boolean },
  maxTokens: number,
): Promise<StoredMessage[]> {
  const messages: StoredMessage[] = [];
  let totalTokens = 0;
  let beforeCursor: string | undefined = undefined;

  // Fetch backward from most recent
  while (totalTokens < maxTokens) {
    const fetched: Collection<string, Message> = await channel.messages.fetch({
      limit: 100,
      before: beforeCursor,
    });

    if (fetched.size === 0) break;

    const sorted = [...fetched.values()].sort((a, b) =>
      BigInt(a.id) < BigInt(b.id) ? -1 : 1,
    );

    const batch: StoredMessage[] = [];
    let batchTokens = 0;

    for (const msg of sorted) {
      const stored: StoredMessage = {
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

    if (fetched.size < 100) break;
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

function rebuildBlocksFromBoundaries(channelId: string): void {
  const messages = messagesByChannel.get(channelId);
  const boundaries = blockBoundaries.get(channelId);

  if (!messages || !boundaries || boundaries.length === 0) return;

  // Verify boundaries match loaded messages
  // If messages don't contain boundary IDs, boundaries are stale
  const validBoundaries: BlockBoundary[] = [];

  for (const boundary of boundaries) {
    const hasFirst = messages.some((m) => m.id === boundary.firstMessageId);
    const hasLast = messages.some((m) => m.id === boundary.lastMessageId);

    if (hasFirst && hasLast) {
      validBoundaries.push(boundary);
    } else {
      console.warn(
        `Boundary ${boundary.firstMessageId}-${boundary.lastMessageId} not found in loaded messages, skipping`,
      );
    }
  }

  blockBoundaries.set(channelId, validBoundaries);

  if (validBoundaries.length !== boundaries.length) {
    saveBoundariesToDisk();
  }
}

// ---------- Utilities ----------

export function clearChannel(channelId: string): void {
  messagesByChannel.delete(channelId);
  blockBoundaries.delete(channelId);
}

export function clearAll(): void {
  messagesByChannel.clear();
  blockBoundaries.clear();
}

export function getStats(): { channels: number; totalMessages: number; totalBlocks: number } {
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

export function getChannelSpeakers(channelId: string, excludeBotId?: string): string[] {
  const messages = messagesByChannel.get(channelId) ?? [];
  const speakers = new Set<string>();

  for (const msg of messages) {
    if (excludeBotId && msg.authorId === excludeBotId) continue;
    speakers.add(msg.authorName);
  }

  return [...speakers];
}
