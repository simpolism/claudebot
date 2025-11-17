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
import { getCachedBlocks, getLastCachedMessageId, updateCache } from './cache';
import { ConversationData, ImageBlock, SimpleMessage } from './types';

export const GUARANTEED_TAIL_TOKENS = 8000;
const USER_MENTION_REGEX = /<@!?(\d+)>/g;

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

    for (const block of existingParentBlocks) {
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
  const lastCachedMessageId = cacheAccess.getLastCachedMessageId(channelId);

  // Calculate token budget used by cached blocks
  const cachedTokens = existingCachedBlocks.reduce(
    (sum, block) => sum + block.tokenCount,
    0,
  );
  const remainingBudget = threadBudget - cachedTokens;
  // Always fetch at least a small tail even when cached blocks already fill the budget.
  // The token budget is a soft limit (e.g. 100k within Claude's 200k window) so slight
  // overflow is acceptable if it keeps the latest uncached messages in view.
  const fetchBudget = Math.max(remainingBudget, GUARANTEED_TAIL_TOKENS);

  console.log(
    `[${botDisplayName}] Fetching Discord history for ${channelId} after ${
      lastCachedMessageId ?? 'beginning'
    } with budget ${fetchBudget} tokens`,
  );

  // Fetch new messages after the last cached one
  const newMessages = await fetchMessages(
    channel,
    lastCachedMessageId,
    fetchBudget,
    client,
  );

  if (newMessages.length > 0) {
    cacheAccess.updateCache(channelId, newMessages);
  }

  const finalCachedBlocks = cacheAccess.getCachedBlocks(channelId);
  const finalLastCachedId = cacheAccess.getLastCachedMessageId(channelId);

  // Build the tail (messages after the last cached block)
  const tail: SimpleMessage[] = [];
  for (const msg of newMessages) {
    if (finalLastCachedId && BigInt(msg.id) <= BigInt(finalLastCachedId)) {
      continue;
    }
    tail.push({
      role: msg.role,
      content: msg.formattedText,
    });
  }

  const allCachedBlocks = [
    ...parentCachedBlocks,
    ...finalCachedBlocks.map((block) => block.text),
  ];

  const totalCachedTokens =
    parentContextTokens +
    finalCachedBlocks.reduce((sum, block) => sum + block.tokenCount, 0);
  const tailTokens = tail.reduce((sum, msg) => sum + estimateTokens(msg.content) + 4, 0);

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

  // Fetch all messages we need
  const allFetched: Message[] = [];
  let lastId: string | undefined;

  while (totalTokens < tokenBudget) {
    const fetched: Collection<string, Message> = await channel.messages.fetch({
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
