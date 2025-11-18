import { Client, Message, Collection } from 'discord.js';
import * as fs from 'fs';
import { globalConfig, getMaxBotContextTokens } from './config';
import * as db from './database';

// ---------- Types ----------

export interface StoredMessage {
  rowId?: number; // Database row ID (undefined until inserted)
  id: string; // Discord message ID
  channelId: string;
  threadId: string | null;
  parentChannelId: string;
  authorId: string;
  authorName: string;
  content: string;
  timestamp: number;
}

export interface BlockBoundary {
  firstMessageId: string; // Keep for JSON backward compatibility
  lastMessageId: string; // Keep for JSON backward compatibility
  firstRowId?: number; // For DB-backed boundaries
  lastRowId?: number; // For DB-backed boundaries
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
const messageIdsByChannel = new Map<string, Set<string>>(); // O(1) deduplication
const blockBoundaries = new Map<string, BlockBoundary[]>();
const hydratedChannels = new Map<string, boolean>(); // Track lazy-loaded threads

// ---------- Helper Functions ----------

function ensureChannelInitialized(channelId: string): void {
  if (!messagesByChannel.has(channelId)) {
    messagesByChannel.set(channelId, []);
  }
  if (!messageIdsByChannel.has(channelId)) {
    messageIdsByChannel.set(channelId, new Set());
  }
  if (!blockBoundaries.has(channelId)) {
    blockBoundaries.set(channelId, []);
  }
}

function estimateMessageTokens(authorName: string, content: string): number {
  return estimateTokens(`${authorName}: ${content}`) + 4; // +4 for message overhead
}

function messageToStored(message: Message): StoredMessage {
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
    authorName:
      message.author.username ?? message.author.globalName ?? message.author.tag,
    content,
    timestamp: message.createdTimestamp,
  };
}

// ---------- Message Management ----------

export function appendStoredMessage(stored: StoredMessage): void {
  const channelId = stored.channelId;
  ensureChannelInitialized(channelId);

  const messageIds = messageIdsByChannel.get(channelId)!;

  // O(1) deduplication
  if (messageIds.has(stored.id)) {
    return;
  }

  messageIds.add(stored.id);

  // Write to database first if feature flag enabled (to get row_id)
  if (globalConfig.useDatabaseStorage) {
    try {
      const rowId = db.insertMessage({
        ...stored,
        createdAt: Date.now(),
      });

      // Update stored message with row_id
      if (rowId !== null) {
        stored.rowId = rowId;
      }
    } catch (err) {
      console.error('[Database] Failed to insert message:', err);
    }
  }

  messagesByChannel.get(channelId)!.push(stored);

  checkAndFreezeBlocks(channelId);
}

export function appendMessage(message: Message): void {
  appendStoredMessage(messageToStored(message));
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
  threadId?: string | null,
  parentChannelId?: string,
): ContextResult {
  // For threads: use parent's blocks + thread's tail
  // For channels: use channel's blocks + tail
  const isThreadContext = threadId != null && parentChannelId != null;

  const boundaryChannelId = isThreadContext ? parentChannelId : channelId;
  const messageChannelId = channelId; // Always get messages from the actual channel/thread

  const messages = messagesByChannel.get(messageChannelId) ?? [];
  const boundaries = blockBoundaries.get(boundaryChannelId) ?? [];

  // First, check if we need to evict blocks globally (based on LARGEST bot context)
  const globalMaxTokens = getMaxBotContextTokens();
  checkAndEvictGlobally(boundaryChannelId, globalMaxTokens);

  // Re-fetch after potential eviction
  const currentMessages = messagesByChannel.get(messageChannelId) ?? [];
  const currentBoundaries = blockBoundaries.get(boundaryChannelId) ?? [];

  // Build frozen blocks with their stored token counts
  // For threads: these are the parent's cached blocks
  const blockData: Array<{ text: string; tokens: number }> = [];

  if (isThreadContext) {
    // For threads: Get parent channel messages to build parent blocks
    const parentMessages = messagesByChannel.get(parentChannelId) ?? [];
    for (const boundary of currentBoundaries) {
      const blockMessages = getMessagesInRange(
        parentMessages,
        boundary.firstMessageId,
        boundary.lastMessageId,
      );
      const blockText = formatMessages(blockMessages, botUserId, botDisplayName);
      blockData.push({ text: blockText, tokens: boundary.tokenCount });
    }
  } else {
    // For regular channels: Use channel's own blocks
    for (const boundary of currentBoundaries) {
      const blockMessages = getMessagesInRange(
        currentMessages,
        boundary.firstMessageId,
        boundary.lastMessageId,
      );
      const blockText = formatMessages(blockMessages, botUserId, botDisplayName);
      blockData.push({ text: blockText, tokens: boundary.tokenCount });
    }
  }

  // Build tail (messages after last frozen block)
  // For threads: all thread messages (threads don't have their own blocks yet)
  // For channels: messages after last block
  const tailMessages = isThreadContext
    ? currentMessages
    : currentMessages.slice(
        currentBoundaries.length > 0
          ? currentMessages.findIndex(
              (m) =>
                m.id === currentBoundaries[currentBoundaries.length - 1]?.lastMessageId,
            ) + 1
          : 0,
      );

  const tailData: Array<{ text: string; tokens: number }> = [];

  for (const msg of tailMessages) {
    const formatted = formatMessage(msg, botUserId, botDisplayName);
    const authorName = msg.authorId === botUserId ? botDisplayName : msg.authorName;
    const tokens = estimateMessageTokens(authorName, msg.content);
    tailData.push({ text: formatted, tokens });
  }

  // Calculate totals
  let totalTokens =
    blockData.reduce((sum, b) => sum + b.tokens, 0) +
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
    console.log(
      `[getContext] Trimmed ${trimmedBlocks} blocks and ${trimmedTailMessages} tail messages for ${botDisplayName}'s ${maxTokens} token budget (global max: ${globalMaxTokens})`,
    );
  }

  return {
    blocks: finalBlockData.map((b) => b.text),
    tail: finalTailData.map((t) => t.text),
    totalTokens,
  };
}

// Check if global state exceeds the largest bot's context and evict if needed
function checkAndEvictGlobally(channelId: string, globalMaxTokens: number): void {
  const messages = messagesByChannel.get(channelId) ?? [];
  const boundaries = blockBoundaries.get(channelId) ?? [];

  if (boundaries.length === 0) return;

  // Calculate total tokens across all blocks + tail
  const totalBlockTokens = boundaries.reduce((sum, b) => sum + b.tokenCount, 0);

  // Find tail start
  const lastBoundary = boundaries[boundaries.length - 1];
  const lastBoundaryIdx = messages.findIndex((m) => m.id === lastBoundary.lastMessageId);
  const tailMessages =
    lastBoundaryIdx !== -1 ? messages.slice(lastBoundaryIdx + 1) : messages;

  let tailTokens = 0;
  for (const msg of tailMessages) {
    tailTokens += estimateMessageTokens(msg.authorName, msg.content);
  }

  const totalTokens = totalBlockTokens + tailTokens;

  // Evict oldest blocks if over global max
  let blocksToEvict = 0;
  let tokensAfterEviction = totalTokens;

  for (const boundary of boundaries) {
    if (tokensAfterEviction <= globalMaxTokens) break;
    tokensAfterEviction -= boundary.tokenCount;
    blocksToEvict++;
  }

  if (blocksToEvict > 0) {
    console.log(
      `[checkAndEvictGlobally] Total ${totalTokens} tokens exceeds global max ${globalMaxTokens}, evicting ${blocksToEvict} oldest blocks`,
    );
    cleanupEvictedBlocks(channelId, blocksToEvict);
  }
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
    console.error(
      `[getMessagesInRange] CRITICAL: firstId ${firstId} not found in ${messages.length} messages!`,
    );
  }
  if (!foundLast) {
    console.error(
      `[getMessagesInRange] CRITICAL: lastId ${lastId} not found in ${messages.length} messages!`,
    );
  }
  if (result.length === 0 && (foundFirst || foundLast)) {
    console.error(
      `[getMessagesInRange] WARNING: Empty result despite finding boundary IDs`,
    );
  }

  return result;
}

function formatMessage(
  msg: StoredMessage,
  botUserId: string,
  botDisplayName: string,
): string {
  const authorName = msg.authorId === botUserId ? botDisplayName : msg.authorName;
  return `${authorName}: ${msg.content.trim() || '(empty message)'}`;
}

function formatMessages(
  messages: StoredMessage[],
  botUserId: string,
  botDisplayName: string,
): string {
  return messages.map((m) => formatMessage(m, botUserId, botDisplayName)).join('\n');
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / Math.max(globalConfig.approxCharsPerToken, 1));
}

// ---------- Block Eviction Cleanup ----------

function cleanupEvictedBlocks(channelId: string, numEvicted: number): void {
  const boundaries = blockBoundaries.get(channelId);
  const messages = messagesByChannel.get(channelId);
  const messageIds = messageIdsByChannel.get(channelId);

  if (!boundaries || numEvicted <= 0) return;

  // Remove oldest boundaries
  const evictedBoundaries = boundaries.splice(0, numEvicted);

  console.log(
    `[cleanupEvictedBlocks] Removed ${evictedBoundaries.length} oldest blocks from ${channelId}`,
  );

  // Also trim messages that are no longer referenced
  if (messages && messageIds && evictedBoundaries.length > 0) {
    const lastEvictedBoundary = evictedBoundaries[evictedBoundaries.length - 1];
    if (lastEvictedBoundary) {
      const lastEvictedIdx = messages.findIndex(
        (m) => m.id === lastEvictedBoundary.lastMessageId,
      );
      if (lastEvictedIdx !== -1) {
        // Remove all messages up to and including the last evicted block
        const removedMessages = messages.splice(0, lastEvictedIdx + 1);

        // Update the deduplication set
        for (const msg of removedMessages) {
          messageIds.delete(msg.id);
        }

        console.log(
          `[cleanupEvictedBlocks] Trimmed ${removedMessages.length} messages from memory for ${channelId}`,
        );
      }
    }
  }

  // Persist updated boundaries to disk
  saveBoundariesToDisk();
}

// ---------- Block Freezing ----------

interface FreezeOptions {
  persistAfterEach?: boolean; // Save to disk after each block (for runtime)
  verbose?: boolean; // Detailed logging (for runtime)
  source?: string; // Label for logs
}

function freezeBlocks(channelId: string, options: FreezeOptions = {}): number {
  const { persistAfterEach = false, verbose = false, source = 'freezeBlocks' } = options;

  const messages = messagesByChannel.get(channelId);
  const boundaries = blockBoundaries.get(channelId);

  if (!messages || !boundaries) return 0;

  // Find where tail starts (after last frozen block)
  let tailStartIdx = 0;
  if (boundaries.length > 0) {
    const lastBoundary = boundaries[boundaries.length - 1];
    const lastBoundaryIdx = messages.findIndex(
      (m) => m.id === lastBoundary.lastMessageId,
    );
    if (lastBoundaryIdx !== -1) {
      tailStartIdx = lastBoundaryIdx + 1;
    } else if (verbose) {
      console.error(
        `[${source}] CRITICAL: lastBoundary.lastMessageId ${lastBoundary.lastMessageId} not found in messages!`,
      );
    }
  }

  // Accumulate tail tokens and freeze when threshold reached
  let accumulatedTokens = 0;
  let blockStartIdx = tailStartIdx;
  let messagesInBlock = 0;
  let blocksCreated = 0;

  for (let i = tailStartIdx; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg) continue;
    const tokens = estimateMessageTokens(msg.authorName, msg.content);
    accumulatedTokens += tokens;
    messagesInBlock++;

    // Freeze block when threshold reached
    if (accumulatedTokens >= DEFAULT_TOKENS_PER_BLOCK) {
      const firstMsg = messages[blockStartIdx];
      const lastMsg = messages[i];
      if (firstMsg && lastMsg) {
        const boundary: BlockBoundary = {
          firstMessageId: firstMsg.id,
          lastMessageId: lastMsg.id,
          firstRowId: firstMsg.rowId,
          lastRowId: lastMsg.rowId,
          tokenCount: accumulatedTokens,
        };
        boundaries.push(boundary);

        // Write to database in parallel if feature flag enabled
        if (globalConfig.useDatabaseStorage) {
          try {
            // Detect if this is a thread (messages have threadId set)
            const isThread = firstMsg.threadId != null;
            const threadIdForDb = isThread ? firstMsg.threadId : null;

            db.insertBlockBoundary({
              channelId,
              threadId: threadIdForDb,
              firstMessageId: boundary.firstMessageId,
              lastMessageId: boundary.lastMessageId,
              firstRowId: boundary.firstRowId,
              lastRowId: boundary.lastRowId,
              tokenCount: boundary.tokenCount,
              createdAt: Date.now(),
            });
          } catch (err) {
            console.error('[Database] Failed to insert block boundary:', err);
          }
        }

        blocksCreated++;

        if (verbose) {
          console.log(
            `[${source}] Frozen block #${boundaries.length} for ${channelId}: ` +
              `${messagesInBlock} messages, ~${accumulatedTokens} tokens, ` +
              `IDs ${firstMsg.id}..${lastMsg.id}`,
          );

          const totalBlockTokens = boundaries.reduce((sum, b) => sum + b.tokenCount, 0);
          const remainingTail = messages.length - i - 1;
          console.log(
            `[${source}] State: ${boundaries.length} blocks (~${totalBlockTokens} tokens), ` +
              `${remainingTail} messages in tail`,
          );
        }

        if (persistAfterEach) {
          saveBoundariesToDisk();
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

function checkAndFreezeBlocks(channelId: string): void {
  freezeBlocks(channelId, {
    persistAfterEach: true,
    verbose: true,
    source: 'checkAndFreezeBlocks',
  });
}

function freezeBlocksFromHistory(channelId: string): void {
  const blocksCreated = freezeBlocks(channelId, {
    persistAfterEach: false,
    verbose: false,
    source: 'freezeBlocksFromHistory',
  });

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

      // Get oldest boundary message ID to ensure we fetch back far enough for cache consistency
      const existingBoundaries = blockBoundaries.get(channelId) ?? [];
      const oldestBoundaryMessageId =
        existingBoundaries.length > 0 ? existingBoundaries[0].firstMessageId : undefined;

      if (oldestBoundaryMessageId) {
        console.log(
          `[loadHistoryFromDiscord] ${channelId} has ${existingBoundaries.length} saved boundaries, ensuring fetch includes message ${oldestBoundaryMessageId}`,
        );
      }

      const messages = await fetchChannelHistory(
        channel,
        maxTokensPerChannel,
        oldestBoundaryMessageId,
      );

      // Initialize storage for this channel
      messagesByChannel.set(channelId, messages);
      messageIdsByChannel.set(channelId, new Set(messages.map((m) => m.id)));
      if (!blockBoundaries.has(channelId)) {
        blockBoundaries.set(channelId, []);
      }

      // Batch insert to database if feature flag enabled
      if (globalConfig.useDatabaseStorage && messages.length > 0) {
        try {
          const dbMessages = messages.map((m) => ({
            ...m,
            createdAt: Date.now(),
          }));
          db.insertMessages(dbMessages);
          console.log(`[Database] Inserted ${messages.length} messages for ${channelId}`);
        } catch (err) {
          console.error('[Database] Failed to batch insert messages:', err);
        }
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

/**
 * Lazy-load a thread from the database on first access.
 * Handles reset boundaries and backfills missing messages from Discord.
 */
export async function lazyLoadThread(
  threadId: string,
  parentChannelId: string,
  client: Client,
): Promise<void> {
  // Check if already hydrated
  if (hydratedChannels.get(threadId)) {
    return;
  }

  // Mark as hydrated (even if empty, to avoid repeated attempts)
  hydratedChannels.set(threadId, true);

  if (!globalConfig.useDatabaseStorage) {
    // Without database, threads start empty
    console.log(`[LazyLoad] Thread ${threadId} starting empty (no database)`);
    ensureChannelInitialized(threadId);
    return;
  }

  console.log(`[LazyLoad] Loading thread ${threadId} from database...`);

  try {
    // Check if thread was reset
    const resetInfo = db.getThreadResetInfo(threadId);

    let messages: StoredMessage[] = [];
    let boundaries: BlockBoundary[] = [];

    if (resetInfo) {
      // Thread was reset - only load messages after reset boundary
      console.log(
        `[LazyLoad] Thread ${threadId} was reset at row_id ${resetInfo.lastResetRowId}`,
      );
      messages = db.getMessagesAfterRow(threadId, resetInfo.lastResetRowId, threadId);
      boundaries = []; // No boundaries - fresh start after reset
    } else {
      // No reset - load everything from database
      messages = db.getMessages(threadId, threadId);
      boundaries = db.getBoundaries(threadId, threadId);
    }

    // Initialize in-memory storage
    ensureChannelInitialized(threadId);
    messagesByChannel.set(threadId, messages);
    messageIdsByChannel.set(threadId, new Set(messages.map((m) => m.id)));
    blockBoundaries.set(threadId, boundaries);

    console.log(
      `[LazyLoad] Loaded ${messages.length} messages and ${boundaries.length} boundaries from DB`,
    );

    // Backfill any messages missed during downtime from Discord
    const backfilled = await backfillThreadFromDiscord(threadId, client);
    if (backfilled > 0) {
      console.log(`[LazyLoad] Backfilled ${backfilled} messages from Discord`);
    }

    // Freeze blocks if enough unfrozen messages accumulated
    freezeBlocksFromHistory(threadId);
  } catch (err) {
    console.error(`[LazyLoad] Failed to load thread ${threadId}:`, err);
    // Ensure initialized even on error
    ensureChannelInitialized(threadId);
  }
}

/**
 * Backfill messages from Discord that were sent during downtime.
 * Respects reset boundaries to avoid re-fetching cleared messages.
 * Returns number of messages backfilled.
 */
async function backfillThreadFromDiscord(
  threadId: string,
  client: Client,
): Promise<number> {
  try {
    // Get the last message we have in memory
    const messages = messagesByChannel.get(threadId) ?? [];

    if (messages.length === 0) {
      // Check if thread was reset - if so, only fetch messages AFTER reset
      if (globalConfig.useDatabaseStorage) {
        const resetInfo = db.getThreadResetInfo(threadId);
        if (resetInfo?.lastResetDiscordMessageId) {
          console.log(
            `[Backfill] Thread ${threadId} was reset, fetching only post-reset messages after Discord ID ${resetInfo.lastResetDiscordMessageId}`,
          );

          const channel = await client.channels.fetch(threadId);
          if (!channel || !channel.isTextBased()) {
            return 0;
          }

          // Fetch messages AFTER the reset boundary
          const newMessages: StoredMessage[] = [];
          let afterCursor: string = resetInfo.lastResetDiscordMessageId;

          while (true) {
            const fetched = await channel.messages.fetch({
              limit: 100,
              after: afterCursor,
            });

            if (fetched.size === 0) break;

            const sorted = [...fetched.values()].sort((a, b) =>
              BigInt(a.id) < BigInt(b.id) ? -1 : 1,
            );

            for (const msg of sorted) {
              const stored = messageToStored(msg);
              newMessages.push(stored);
              afterCursor = msg.id;
            }

            if (fetched.size < 100) break;
          }

          // Store post-reset messages
          for (const msg of newMessages) {
            appendStoredMessage(msg);
          }

          console.log(`[Backfill] Fetched ${newMessages.length} post-reset messages`);
          return newMessages.length;
        }
      }

      // No reset - fetch full history (new thread)
      console.log(
        `[Backfill] Thread ${threadId} has no messages, fetching full history from Discord`,
      );
      const channel = await client.channels.fetch(threadId);
      if (!channel || !channel.isTextBased()) {
        return 0;
      }

      const fetchedMessages = await fetchChannelHistory(
        channel,
        globalConfig.maxContextTokens,
      );

      // Store all fetched messages
      for (const msg of fetchedMessages) {
        appendStoredMessage(msg);
      }

      return fetchedMessages.length;
    }

    // Get the latest message ID from our store
    const lastMessage = messages[messages.length - 1];
    if (!lastMessage) return 0;

    const lastDiscordId = lastMessage.id;

    // Fetch messages after this ID from Discord
    const channel = await client.channels.fetch(threadId);
    if (!channel || !channel.isTextBased()) {
      return 0;
    }

    const newMessages: StoredMessage[] = [];
    let afterCursor: string = lastDiscordId;

    // Fetch forward from last known message
    while (true) {
      const fetched = await channel.messages.fetch({
        limit: 100,
        after: afterCursor,
      });

      if (fetched.size === 0) break;

      // Sort oldest to newest
      const sorted = [...fetched.values()].sort((a, b) =>
        BigInt(a.id) < BigInt(b.id) ? -1 : 1,
      );

      for (const msg of sorted) {
        const stored = messageToStored(msg);
        newMessages.push(stored);
        afterCursor = msg.id;
      }

      if (fetched.size < 100) break; // No more messages
    }

    // Store all new messages
    for (const msg of newMessages) {
      appendStoredMessage(msg);
    }

    return newMessages.length;
  } catch (err) {
    console.error(`[Backfill] Failed to backfill thread ${threadId}:`, err);
    return 0;
  }
}

async function fetchChannelHistory(
  channel: Message['channel'] & { isTextBased(): boolean },
  maxTokens: number,
  mustIncludeMessageId?: string,
): Promise<StoredMessage[]> {
  const messages: StoredMessage[] = [];
  let totalTokens = 0;
  let beforeCursor: string | undefined = undefined;
  let foundRequiredMessage = !mustIncludeMessageId; // If no requirement, consider it found

  // Fetch backward from most recent
  // Continue until: (hit token limit AND found required message) OR no more messages
  while (!foundRequiredMessage || totalTokens < maxTokens) {
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
      const stored = messageToStored(msg);
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

    if (fetched.size < 100) break;
  }

  if (mustIncludeMessageId && !foundRequiredMessage) {
    console.warn(
      `[fetchChannelHistory] Required message ${mustIncludeMessageId} not found in history. ` +
        `Boundaries may be invalidated.`,
    );
  }

  // Trim oldest if over budget, but NEVER trim past the required message
  while (totalTokens > maxTokens && messages.length > 0) {
    const oldestMessage = messages[0];
    if (!oldestMessage) break;

    // Don't trim if this is the required message or we haven't passed it yet
    if (mustIncludeMessageId && oldestMessage.id === mustIncludeMessageId) {
      console.log(
        `[fetchChannelHistory] Stopping trim at required message ${mustIncludeMessageId} to preserve cache boundaries`,
      );
      break;
    }

    const removed = messages.shift();
    if (removed) {
      totalTokens -= estimateMessageTokens(removed.authorName, removed.content);
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
  messageIdsByChannel.delete(channelId);
  blockBoundaries.delete(channelId);

  // Also clear from database if enabled
  if (globalConfig.useDatabaseStorage) {
    try {
      db.clearChannel(channelId);
    } catch (err) {
      console.error('[Database] Failed to clear channel:', err);
    }
  }
}

/**
 * Clear a thread's history (both in-memory and database).
 * Records reset metadata to prevent reloading pre-reset messages after downtime.
 */
export function clearThread(threadId: string, parentChannelId: string): void {
  // Get last message info BEFORE clearing (for reset tracking)
  let lastDiscordMessageId: string | null = null;
  const messages = messagesByChannel.get(threadId);
  if (messages && messages.length > 0) {
    const lastMessage = messages[messages.length - 1];
    lastDiscordMessageId = lastMessage?.id ?? null;
  }

  // Clear in-memory (currently stored by thread's channelId)
  messagesByChannel.delete(threadId);
  messageIdsByChannel.delete(threadId);
  blockBoundaries.delete(threadId);
  hydratedChannels.delete(threadId); // Clear hydration flag

  // Clear from database and record reset if enabled
  if (globalConfig.useDatabaseStorage) {
    try {
      // Get the last row_id BEFORE clearing (for reset tracking)
      const lastRowId = db.getLastRowId(threadId, threadId);

      // Record reset metadata BEFORE clearing (with both row_id and Discord message ID)
      if (lastRowId !== null) {
        db.recordThreadReset(threadId, lastRowId, lastDiscordMessageId);
        console.log(
          `[Reset] Recorded reset boundary for thread ${threadId} at row_id ${lastRowId}, Discord msg ${lastDiscordMessageId}`,
        );
      }

      // Now clear messages and boundaries
      // FIX: Use threadId for channelId parameter (not parentChannelId)
      // For threads, channel_id in DB equals the thread's own ID
      db.clearThread(threadId, threadId);
    } catch (err) {
      console.error('[Database] Failed to clear thread:', err);
    }
  }
}

export function clearAll(): void {
  messagesByChannel.clear();
  messageIdsByChannel.clear();
  blockBoundaries.clear();
}

export function getStats(): {
  channels: number;
  totalMessages: number;
  totalBlocks: number;
} {
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
    // Defensive check: only add if authorName is defined
    if (msg.authorName) {
      speakers.add(msg.authorName);
    }
  }

  return [...speakers];
}
