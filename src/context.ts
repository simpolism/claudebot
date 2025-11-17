import { Attachment, ChannelType, Client, Message } from 'discord.js';
import { getContext, appendMessage, getBlockBoundaries } from './message-store';
import { ConversationData, ImageBlock, SimpleMessage } from './types';

// ---------- Thread Detection ----------

export function isThreadChannel(
  channel: Message['channel'],
): channel is Message['channel'] & { parentId: string; parent: NonNullable<Message['channel']> } {
  return (
    channel.type === ChannelType.PublicThread ||
    channel.type === ChannelType.PrivateThread ||
    channel.type === ChannelType.AnnouncementThread
  );
}

// ---------- Context Building ----------

export function buildConversationContext(params: {
  channel: Message['channel'];
  maxContextTokens: number;
  client: Client;
  botDisplayName: string;
}): ConversationData {
  const { channel, maxContextTokens, client, botDisplayName } = params;

  if (!channel.isTextBased() || !client.user) {
    return { cachedBlocks: [], tail: [] };
  }

  const botUserId = client.user.id;

  // Handle threads: include parent context first
  let parentBlocks: string[] = [];
  let parentTokens = 0;

  if (isThreadChannel(channel) && channel.parent && channel.parent.isTextBased()) {
    const parentResult = getContext(
      channel.parent.id,
      maxContextTokens,
      botUserId,
      botDisplayName,
    );
    parentBlocks = parentResult.blocks;
    parentTokens = parentResult.totalTokens;

    console.log(
      `[${botDisplayName}] Thread detected, including ${parentBlocks.length} parent blocks (~${parentTokens} tokens)`,
    );
  }

  // Get context for current channel/thread
  const remainingBudget = maxContextTokens - parentTokens;
  const channelResult = getContext(channel.id, remainingBudget, botUserId, botDisplayName);

  // Combine parent blocks + channel blocks
  const allBlocks = [...parentBlocks, ...channelResult.blocks];
  const totalBlockTokens = parentTokens + channelResult.totalTokens - tailTokensFromResult(channelResult);

  // Convert tail strings to SimpleMessage format
  const tail: SimpleMessage[] = channelResult.tail.map((content) => ({
    role: content.startsWith(`${botDisplayName}:`) ? 'assistant' : 'user',
    content,
  }));

  const contextType = parentBlocks.length > 0 ? 'Thread' : 'Channel';
  console.log(
    `[${botDisplayName}] ${contextType} conversation: ${allBlocks.length} cached blocks (~${totalBlockTokens} tokens) + ${tail.length} tail messages`,
  );

  return {
    cachedBlocks: allBlocks,
    tail,
  };
}

function tailTokensFromResult(result: { blocks: string[]; tail: string[]; totalTokens: number }): number {
  // Estimate tail tokens by subtracting block tokens from total
  let blockTokens = 0;
  for (const block of result.blocks) {
    blockTokens += Math.ceil(block.length / 4); // rough estimate
  }
  return result.totalTokens - blockTokens;
}

// ---------- Image Handling ----------

export function getImageBlocksFromAttachments(attachments: Message['attachments']): ImageBlock[] {
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
