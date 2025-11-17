import {
  Attachment,
  ChannelType,
  Client,
  Collection,
  Message,
  PrivateThreadChannel,
  PublicThreadChannel,
} from 'discord.js';
import { globalConfig } from './config';
import {
  getCachedBlocks,
  getLastCachedMessageId,
  updateCache,
  type CachedBlock,
} from './cache';
import { ConversationData, ImageBlock, SimpleMessage } from './types';

export const GUARANTEED_TAIL_TOKENS = 8000;
const USER_MENTION_REGEX = /<@!?(\d+)>/g;

type TailMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  tokens: number;
};

type TailCacheEntry = {
  messages: TailMessage[];
  lastFetchedId: string | null;
};

const tailCache = new Map<string, TailCacheEntry>();

async function hydrateCachedBlockTexts(
  channel: Message['channel'],
  client: Client,
  blocks: CachedBlock[],
): Promise<void> {
  if (!channel.isTextBased()) return;
  for (const block of blocks) {
    if (block.text) continue;
    if (!block.firstMessageId || !block.lastMessageId) {
      console.warn(
        `Skipping hydration for block missing boundaries in channel ${channel.id}`,
      );
      continue;
    }
    const hydrated = await fetchBlockTextRange(
      channel,
      block.firstMessageId,
      block.lastMessageId,
      client,
    );
    if (hydrated) {
      block.text = hydrated;
    }
  }
}

async function fetchBlockTextRange(
  channel: Message['channel'],
  firstMessageId: string,
  lastMessageId: string,
  client: Client,
): Promise<string | null> {
  if (!channel.isTextBased()) {
    return null;
  }

  let firstMessage: Message | null = null;
  try {
    firstMessage = await channel.messages.fetch(firstMessageId);
  } catch {
    console.warn(
      `Failed to fetch first message ${firstMessageId} for cached block in ${channel.id}`,
    );
    return null;
  }

  const collected: Message[] = [firstMessage];
  let cursor = firstMessageId;
  const target = BigInt(lastMessageId);
  let reachedEnd = BigInt(firstMessageId) >= target;

  while (!reachedEnd) {
    const fetched: Collection<string, Message> = await channel.messages.fetch({
      limit: 100,
      after: cursor,
    });
    if (fetched.size === 0) {
      break;
    }

    const sorted = [...fetched.values()].sort((a, b) =>
      BigInt(a.id) < BigInt(b.id) ? -1 : 1,
    );

    for (const msg of sorted) {
      collected.push(msg);
      cursor = msg.id;
      if (BigInt(msg.id) >= target) {
        reachedEnd = true;
        break;
      }
    }

    if (fetched.size < 100) {
      break;
    }
  }

  const formatted = collected
    .filter((msg) => {
      const id = BigInt(msg.id);
      return id >= BigInt(firstMessageId) && id <= target;
    })
    .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))
    .map((msg) => {
      const isAssistant = Boolean(client.user) && msg.author.id === client.user?.id;
      const attachmentSummary = buildAttachmentSummary(msg.attachments);
      const messageContent = replaceUserMentions(
        msg.content || '(empty message)',
        msg,
        client,
      );
      const storedContent = attachmentSummary
        ? `${messageContent}\n${attachmentSummary}`
        : messageContent;
      const authorName = isAssistant
        ? getBotCanonicalName(client)
        : getUserCanonicalName(msg);
      return formatAuthoredContent(authorName, storedContent);
    })
    .join('\n')
    .trim();

  return formatted.length > 0 ? formatted : null;
}

export type TextThreadChannel = PublicThreadChannel | PrivateThreadChannel;

type CacheAccess = {
  getCachedBlocks: typeof getCachedBlocks;
  getLastCachedMessageId: typeof getLastCachedMessageId;
  updateCache: typeof updateCache;
};

type MessageFetcher = typeof fetchMessagesAfter;

const defaultCacheAccess: CacheAccess = {
  getCachedBlocks,
  getLastCachedMessageId,
  updateCache,
};

export function isThreadChannel(
  channel: Message['channel'],
): channel is TextThreadChannel {
  return (
    channel.type === ChannelType.PublicThread ||
    channel.type === ChannelType.PrivateThread ||
    channel.type === ChannelType.AnnouncementThread
  );
}

export async function buildConversationContext(params: {
  channel: Message['channel'];
  maxContextTokens: number;
  client: Client;
  botDisplayName: string;
  cacheAccess?: CacheAccess;
  fetchMessages?: MessageFetcher;
}): Promise<ConversationData> {
  const {
    channel,
    maxContextTokens,
    client,
    botDisplayName,
    cacheAccess = defaultCacheAccess,
    fetchMessages = fetchMessagesAfter,
  } = params;

  if (!channel.isTextBased()) {
    return { cachedBlocks: [], tail: [] };
  }

  // Check if this is a thread - if so, include parent channel context
  const parentCachedBlocks: string[] = [];
  let parentContextTokens = 0;
  const PARENT_CONTEXT_RATIO = 0.5; // Allocate 50% of budget to parent context (cached blocks are cheap!)

  if (isThreadChannel(channel) && channel.parent && channel.parent.isTextBased()) {
    const parentChannelId = channel.parent.id;
    const parentBudget = Math.floor(maxContextTokens * PARENT_CONTEXT_RATIO);

    // Reuse parent's cached blocks (these will hit Anthropic's cache)
    const existingParentBlocks = cacheAccess.getCachedBlocks(parentChannelId);
    await hydrateCachedBlockTexts(channel.parent, client, existingParentBlocks);

    for (const block of existingParentBlocks) {
      if (!block.text) {
        continue;
      }
      if (parentContextTokens + block.tokenCount <= parentBudget) {
        parentCachedBlocks.push(block.text);
        parentContextTokens += block.tokenCount;
      } else {
        break;
      }
    }

    if (parentCachedBlocks.length > 0) {
      console.log(
        `[${botDisplayName}] Thread detected, using ${parentCachedBlocks.length} parent cached blocks (~${parentContextTokens} tokens)`,
      );
    }
  }

  // Adjust budget for thread messages
  const threadBudget = maxContextTokens - parentContextTokens;
  const channelId = channel.id;

  // Get existing cached blocks
  const existingCachedBlocks = cacheAccess.getCachedBlocks(channelId);
  await hydrateCachedBlockTexts(channel, client, existingCachedBlocks);
  const lastCachedMessageId = cacheAccess.getLastCachedMessageId(channelId);
  const existingTailState = tailCache.get(channelId);
  const effectiveAfterId = existingTailState?.lastFetchedId ?? lastCachedMessageId;

  // Calculate token budget used by cached blocks
  const cachedTokens = existingCachedBlocks.reduce(
    (sum, block) => sum + block.tokenCount,
    0,
  );
  // Fetch up to the full thread budget every time so we hydrate cached blocks
  // quickly and keep a deep tail.
  const fetchBudget = Math.max(threadBudget, GUARANTEED_TAIL_TOKENS);

  console.log(
    `[${botDisplayName}] Fetching Discord history for ${channelId} after ${
      effectiveAfterId ?? 'beginning'
    } with budget ${fetchBudget} tokens`,
  );

  // Fetch new messages after the last cached one
  const newMessages = await fetchMessages(
    channel,
    effectiveAfterId,
    fetchBudget,
    client,
  );

  if (newMessages.length > 0) {
    cacheAccess.updateCache(channelId, newMessages);
  }

  const finalCachedBlocks = cacheAccess.getCachedBlocks(channelId);
  const finalLastCachedId = cacheAccess.getLastCachedMessageId(channelId);

  const filteredExisting =
    existingTailState?.messages.filter((msg) => {
      if (!finalLastCachedId) return true;
      return BigInt(msg.id) > BigInt(finalLastCachedId);
    }) ?? [];

  const freshTailEntries: TailMessage[] = [];
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
  const channelCachedTokens = finalCachedBlocks.reduce(
    (sum, block) => sum + block.tokenCount,
    0,
  );
  const maxTailTokens = Math.max(threadBudget - channelCachedTokens, GUARANTEED_TAIL_TOKENS);
  let combinedTokenCount = combinedTail.reduce((sum, msg) => sum + msg.tokens, 0);
  while (combinedTokenCount > maxTailTokens && combinedTail.length > 0) {
    const removed = combinedTail.shift();
    if (removed) {
      combinedTokenCount -= removed.tokens;
    }
  }

  const lastFetchedId =
    combinedTail.length > 0
      ? combinedTail[combinedTail.length - 1].id
      : existingTailState?.lastFetchedId ?? finalLastCachedId ?? null;
  tailCache.set(channelId, {
    messages: combinedTail,
    lastFetchedId,
  });

  const tail: SimpleMessage[] = combinedTail.map((msg) => ({
    role: msg.role,
    content: msg.content,
  }));

  const channelCachedTexts = finalCachedBlocks.flatMap((block) =>
    block.text ? [block.text] : [],
  );
  const allCachedBlocks = [...parentCachedBlocks, ...channelCachedTexts];

  const totalCachedTokens = parentContextTokens + channelCachedTokens;
  const tailTokens = combinedTokenCount;

  const contextType = parentCachedBlocks.length > 0 ? 'Thread' : 'Channel';
  console.log(
    `[${botDisplayName}] ${contextType} conversation: ${allCachedBlocks.length} cached blocks (~${totalCachedTokens} tokens) + ${tail.length} tail messages (~${tailTokens} tokens)`,
  );

  return {
    cachedBlocks: allCachedBlocks,
    tail,
  };
}

export function getImageBlocksFromAttachments(
  attachments: Message['attachments'],
): ImageBlock[] {
  const blocks: ImageBlock[] = [];

  attachments.forEach((attachment) => {
    if (!isImageAttachment(attachment)) return;

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

interface FetchedMessage {
  id: string;
  formattedText: string;
  tokens: number;
  role: 'user' | 'assistant';
}

async function fetchMessagesAfter(
  channel: Message['channel'],
  afterMessageId: string | null,
  tokenBudget: number,
  client: Client,
): Promise<FetchedMessage[]> {
  if (!channel.isTextBased()) {
    return [];
  }

  const messages: FetchedMessage[] = [];
  let totalTokens = 0;

  let fetchCursor: string | undefined = afterMessageId ?? undefined;

  while (totalTokens < tokenBudget) {
    const fetched: Collection<string, Message> = await channel.messages.fetch({
      limit: 100,
      after: fetchCursor,
    });

    if (fetched.size === 0) {
      break;
    }

    const sorted = [...fetched.values()].sort((a, b) =>
      BigInt(a.id) < BigInt(b.id) ? -1 : 1,
    );

    for (const msg of sorted) {
      const isAssistant = Boolean(client.user) && msg.author.id === client.user?.id;
      const role: 'user' | 'assistant' = isAssistant ? 'assistant' : 'user';
      const attachmentSummary = buildAttachmentSummary(msg.attachments);
      const messageContent = replaceUserMentions(
        msg.content || '(empty message)',
        msg,
        client,
      );
      const storedContent = attachmentSummary
        ? `${messageContent}\n${attachmentSummary}`
        : messageContent;
      const authorName = isAssistant
        ? getBotCanonicalName(client)
        : getUserCanonicalName(msg);

      const formattedText = formatAuthoredContent(authorName, storedContent);
      const tokens = estimateTokens(formattedText) + 4;

      if (totalTokens + tokens > tokenBudget) {
        return messages;
      }

      messages.push({
        id: msg.id,
        formattedText,
        tokens,
        role,
      });
      totalTokens += tokens;
      fetchCursor = msg.id;
    }

    if (fetched.size < 100) {
      break;
    }
  }

  return messages;
}

function getBotCanonicalName(client: Client): string {
  return client.user?.username ?? client.user?.globalName ?? client.user?.tag ?? 'Bot';
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / Math.max(globalConfig.approxCharsPerToken, 1));
}

function getUserCanonicalName(message: Message): string {
  return message.author.username ?? message.author.globalName ?? message.author.tag;
}

function formatAuthoredContent(authorName: string, content: string): string {
  const normalized = content.trim();
  const finalContent = normalized.length ? normalized : '(empty message)';
  return `${authorName}: ${finalContent}`;
}

function formatMentionName(user: Message['author']): string {
  return user.username ?? user.globalName ?? user.tag;
}

function replaceUserMentions(content: string, message: Message, client: Client): string {
  if (!content) return content;
  return content.replace(USER_MENTION_REGEX, (match, userId) => {
    const mentionedUser =
      message.mentions.users.get(userId) ?? client.users.cache.get(userId) ?? null;
    if (!mentionedUser) {
      return match;
    }
    return `@${formatMentionName(mentionedUser)}`;
  });
}

function isImageAttachment(attachment: Attachment): boolean {
  const contentType = attachment.contentType ?? '';
  return contentType.startsWith('image/') && Boolean(attachment.url);
}

function buildAttachmentSummary(attachments: Message['attachments']): string | null {
  const lines: string[] = [];

  attachments.forEach((attachment) => {
    if (!isImageAttachment(attachment)) return;

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

export function clearTailCache(channelId?: string): void {
  if (channelId) {
    tailCache.delete(channelId);
    return;
  }
  tailCache.clear();
}
