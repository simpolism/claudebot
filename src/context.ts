import { Attachment, Client, Message } from 'discord.js';
import {
  getContext,
  appendMessage,
  getBlockBoundaries,
  lazyLoadThread,
} from './message-store';
import { ConversationData, ImageBlock, SimpleMessage } from './types';

// ---------- Context Building ----------

export async function buildConversationContext(params: {
  channel: Message['channel'];
  maxContextTokens: number;
  client: Client;
  botDisplayName: string;
}): Promise<ConversationData> {
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
    await lazyLoadThread(threadId, parentChannelId, client);
  }

  const channelResult = getContext(
    channel.id,
    maxContextTokens,
    botUserId,
    botDisplayName,
    threadId,
    parentChannelId ?? undefined,
  );

  // Convert tail strings to SimpleMessage format
  const tail: SimpleMessage[] = channelResult.tail.map((content) => ({
    role: content.startsWith(`${botDisplayName}:`) ? 'assistant' : 'user',
    content,
  }));

  // Determine context type for logging
  let contextType = 'Channel';
  if (isThread) {
    contextType = channelResult.blocks.length > 0 ? 'Thread (with parent blocks)' : 'Thread (reset)';
  }
  console.log(
    `[${botDisplayName}] ${contextType} conversation: ${channelResult.blocks.length} cached blocks (~${channelResult.totalTokens} tokens) + ${tail.length} tail messages`,
  );

  return {
    cachedBlocks: channelResult.blocks,
    tail,
  };
}

// ---------- Image Handling ----------

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

function isImageAttachment(attachment: Attachment): boolean {
  const contentType = attachment.contentType ?? '';
  return contentType.startsWith('image/') && Boolean(attachment.url);
}

// ---------- Re-export for convenience ----------

export { appendMessage, getBlockBoundaries };
export { getChannelSpeakers } from './message-store';
