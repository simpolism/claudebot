#!/usr/bin/env node
require('dotenv/config');
const { REST, Routes } = require('discord.js');

const MESSAGE_CACHE_LIMIT = parseInt(process.env.MESSAGE_CACHE_LIMIT || '500', 10);
const MAX_CONTEXT_TOKENS = parseInt(process.env.MAX_CONTEXT_TOKENS || '180000', 10);
const APPROX_CHARS_PER_TOKEN = parseFloat(process.env.APPROX_CHARS_PER_TOKEN || '4');
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;

const args = process.argv.slice(2);
const channelId = args.find((arg) => !arg.startsWith('--'));
const showRaw = args.includes('--raw');
const plainOutput = args.includes('--plain');

if (!channelId) {
  console.error('Usage: node scripts/inspect-context.cjs <channel_id> [--raw] [--plain]');
  process.exit(1);
}

if (!DISCORD_TOKEN) {
  console.error('DISCORD_TOKEN is required to inspect channel history.');
  process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

const USER_ROUTE = '/users/@me';
const USER_MENTION_REGEX = /<@!?(\d+)>/g;

async function fetchBotUser() {
  return rest.get(USER_ROUTE);
}

async function fetchChannelMessages(id, limit) {
  const messages = [];
  let before;
  while (messages.length < limit) {
    const remaining = Math.min(100, limit - messages.length);
    const query = { limit: remaining };
    if (before) {
      query.before = before;
    }

    const batch = await rest.get(Routes.channelMessages(id), { query });
    if (!Array.isArray(batch) || batch.length === 0) {
      break;
    }

    messages.push(...batch);
    before = batch[batch.length - 1]?.id;
  }

  return messages.reverse();
}

function estimateTokens(text) {
  return Math.ceil(text.length / Math.max(APPROX_CHARS_PER_TOKEN, 1));
}

function trimConversation(messages) {
  let totalTokens = 0;
  const trimmed = [];

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    const messageTokens = estimateTokens(message.content) + 4;

    if (trimmed.length > 0 && totalTokens + messageTokens > MAX_CONTEXT_TOKENS) {
      break;
    }

    totalTokens += messageTokens;
    trimmed.push(message);
  }

  return trimmed.reverse();
}

function formatAuthoredContent(authorName, content) {
  const normalized = content.trim();
  const finalContent = normalized.length ? normalized : '(empty message)';
  return `${authorName}: ${finalContent}`;
}

function replaceMentions(content, mentions) {
  if (!content) return '(empty message)';
  const mentionMap = new Map((mentions || []).map((user) => [user.id, user]));
  return content.replace(USER_MENTION_REGEX, (match, userId) => {
    const mentioned = mentionMap.get(userId);
    if (!mentioned) {
      return match;
    }
    return `@${mentioned.global_name || mentioned.username || mentioned.id}`;
  });
}

function buildAttachmentSummary(attachments) {
  const summaries = [];
  (attachments || []).forEach((attachment) => {
    const contentType = attachment.content_type || '';
    if (!contentType.startsWith('image/')) {
      return;
    }
    const parts = [
      attachment.filename || 'image',
      contentType,
    ];
    if (attachment.size != null) {
      const sizeKB = (attachment.size / 1024).toFixed(1);
      parts.push(`${sizeKB}KB`);
    }
    const url = attachment.url || attachment.proxy_url;
    if (url) {
      summaries.push(`[Image: ${parts.join(' • ')}] ${url}`);
    }
  });
  return summaries.length ? summaries.join('\n') : null;
}

function summarize(messages) {
  let totalTokens = 0;
  console.log(`Context window for channel/thread ${channelId}`);
  console.log(`Messages included: ${messages.length}`);
  console.log('---');
  messages.forEach((message, index) => {
    const estimated = estimateTokens(message.content) + 4;
    totalTokens += estimated;
    console.log(`[${index + 1}] ${message.role.toUpperCase()} (${estimated} tokens est.)`);
    console.log(message.content);
    console.log('---');
  });
  console.log(`Estimated tokens (including padding): ${totalTokens}`);
}

function formatAuthorName(author) {
  return (
    author.global_name ||
    author.username ||
    `${author.username}#${author.discriminator}` ||
    author.id
  );
}

(async () => {
  try {
    const botUser = await fetchBotUser();
    const rawMessages = await fetchChannelMessages(channelId, MESSAGE_CACHE_LIMIT);
    if (rawMessages.length === 0) {
      console.log(`No messages found for channel ${channelId}.`);
      return;
    }

    const normalized = rawMessages.map((message) => {
      const role = message.author?.id === botUser.id ? 'assistant' : 'user';
      const authorName = message.author ? formatAuthorName(message.author) : 'Unknown';
      const normalizedContent = replaceMentions(message.content || '(empty message)', message.mentions);
      const attachmentSummary = buildAttachmentSummary(message.attachments);
      const combinedContent = attachmentSummary
        ? `${normalizedContent}\n${attachmentSummary}`
        : normalizedContent;

      return {
        role,
        content: formatAuthoredContent(authorName, combinedContent),
        created_at: Date.parse(message.timestamp) || Date.now(),
      };
    });

    const windowMessages = showRaw ? normalized : trimConversation(normalized);

    if (!showRaw && windowMessages.length !== normalized.length && !plainOutput) {
      console.log(
        `Trimmed ${normalized.length - windowMessages.length} older message(s) to satisfy MAX_CONTEXT_TOKENS=${MAX_CONTEXT_TOKENS}.`,
      );
    }

    if (plainOutput) {
      windowMessages.forEach((message) => {
        console.log(message.content);
        console.log('');
      });
    } else {
      summarize(windowMessages);
    }
  } catch (err) {
    console.error('Failed to inspect channel context:', err);
    process.exit(1);
  }
})();
