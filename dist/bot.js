"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const discord_js_1 = require("discord.js");
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const providers_1 = require("./providers");
// ---------- Config ----------
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const MAIN_CHANNEL_ID = process.env.MAIN_CHANNEL_ID; // text channel id
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-4-5';
const MESSAGE_CACHE_LIMIT = parseInt(process.env.MESSAGE_CACHE_LIMIT || '500', 10);
const BOOTSTRAP_MESSAGE_LIMIT = parseInt(process.env.BOOTSTRAP_MESSAGE_LIMIT || `${MESSAGE_CACHE_LIMIT}`, 10);
const MAX_CONTEXT_TOKENS = parseInt(process.env.MAX_CONTEXT_TOKENS || '180000', 10);
const APPROX_CHARS_PER_TOKEN = parseFloat(process.env.APPROX_CHARS_PER_TOKEN || '4');
const DISCORD_MESSAGE_LIMIT = 2000;
const MAX_TOKENS = parseInt(process.env.MAX_TOKENS || '1024', 10);
const TEMPERATURE = parseFloat(process.env.TEMPERATURE || '1');
const DEFAULT_SYSTEM_PROMPT = 'The assistant is in CLI simulation mode, and responds to the user\'s CLI commands only with the output of the command.';
const PREFILL_COMMAND = '<cmd>cat untitled.txt</cmd>';
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT && process.env.SYSTEM_PROMPT.trim().length > 0
    ? process.env.SYSTEM_PROMPT
    : DEFAULT_SYSTEM_PROMPT;
const AI_PROVIDER = (process.env.AI_PROVIDER || 'anthropic').toLowerCase();
const OPENAI_MODEL = process.env.OPENAI_MODEL ||
    process.env.MOONSHOT_MODEL ||
    'moonshot-v1-128k';
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL ||
    process.env.MOONSHOT_BASE_URL ||
    'https://api.moonshot.ai/v1';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.MOONSHOT_API_KEY || '';
// ---------- SQLite setup (file-based cache) ----------
const db = new better_sqlite3_1.default('claude-cache.sqlite');
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
  author_id TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_channel_created_at
  ON messages(channel_id, created_at);
`);
const insertMessageStmt = db.prepare(`
  INSERT INTO messages (channel_id, role, author_id, content, created_at)
  VALUES (?, ?, ?, ?, ?)
`);
const getRecentMessagesStmt = db.prepare(`
  SELECT role, content
  FROM messages
  WHERE channel_id = ?
  ORDER BY created_at DESC
  LIMIT ?
`);
const pruneOldMessagesStmt = db.prepare(`
  DELETE FROM messages
  WHERE id IN (
    SELECT id FROM messages
    WHERE channel_id = ?
    ORDER BY created_at DESC
    LIMIT -1 OFFSET ?
  )
`);
const countMessagesStmt = db.prepare(`
  SELECT COUNT(*) as count FROM messages
`);
function saveMessage(channelId, role, authorId, content, createdAt) {
    insertMessageStmt.run(channelId, role, authorId, content, createdAt ?? Date.now());
    // keep only last N per channel/thread
    pruneOldMessagesStmt.run(channelId, MESSAGE_CACHE_LIMIT);
}
// ---------- Discord client ----------
const client = new discord_js_1.Client({
    intents: [
        discord_js_1.GatewayIntentBits.Guilds,
        discord_js_1.GatewayIntentBits.GuildMessages,
        discord_js_1.GatewayIntentBits.MessageContent,
    ],
    partials: [discord_js_1.Partials.Channel, discord_js_1.Partials.Message],
});
const aiProvider = (0, providers_1.createAIProvider)({
    provider: AI_PROVIDER,
    systemPrompt: SYSTEM_PROMPT,
    prefillCommand: PREFILL_COMMAND,
    temperature: TEMPERATURE,
    maxTokens: MAX_TOKENS,
    anthropicModel: CLAUDE_MODEL,
    openaiModel: OPENAI_MODEL,
    openaiBaseURL: OPENAI_BASE_URL,
    openaiApiKey: OPENAI_API_KEY,
});
function isThreadChannel(channel) {
    return (channel.type === discord_js_1.ChannelType.PublicThread ||
        channel.type === discord_js_1.ChannelType.PrivateThread ||
        channel.type === discord_js_1.ChannelType.AnnouncementThread);
}
// In-scope = main channel OR threads under that channel
function isInScope(message) {
    const channel = message.channel;
    if (!MAIN_CHANNEL_ID) {
        // if not set, respond anywhere (probably not what you want in production)
        return true;
    }
    if (isThreadChannel(channel)) {
        return channel.parentId === MAIN_CHANNEL_ID;
    }
    return channel.id === MAIN_CHANNEL_ID;
}
// We now *only* respond when explicitly mentioned, even in threads
function shouldRespond(message) {
    if (!isInScope(message))
        return false;
    if (message.author.bot)
        return false;
    if (!client.user)
        return false;
    return message.mentions.has(client.user);
}
// Build conversation from cached messages for this channel/thread
function buildConversation(channelId) {
    const rows = getRecentMessagesStmt.all(channelId, MESSAGE_CACHE_LIMIT);
    // DB returns newest first; reverse to oldest-first
    rows.reverse();
    const messages = rows.map((row) => ({
        role: row.role,
        content: row.content,
    }));
    return trimConversation(messages);
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
        if (trimmed.length > 0 &&
            totalTokens + messageTokens > MAX_CONTEXT_TOKENS) {
            break;
        }
        totalTokens += messageTokens;
        trimmed.push(message);
    }
    return trimmed.reverse();
}
function chunkReplyText(text) {
    if (text.length <= DISCORD_MESSAGE_LIMIT) {
        return [text];
    }
    const chunks = [];
    let remaining = text;
    while (remaining.length > 0) {
        if (remaining.length <= DISCORD_MESSAGE_LIMIT) {
            chunks.push(remaining);
            break;
        }
        let sliceEnd = DISCORD_MESSAGE_LIMIT;
        const newlineIndex = remaining.lastIndexOf('\n', sliceEnd);
        const spaceIndex = remaining.lastIndexOf(' ', sliceEnd);
        const breakIndex = Math.max(newlineIndex, spaceIndex);
        if (breakIndex > sliceEnd * 0.5) {
            sliceEnd = breakIndex;
        }
        const chunk = remaining.slice(0, sliceEnd).trimEnd();
        chunks.push(chunk);
        remaining = remaining.slice(sliceEnd).trimStart();
    }
    return chunks;
}
function isImageAttachment(attachment) {
    const contentType = attachment.contentType ?? '';
    return contentType.startsWith('image/') && Boolean(attachment.url);
}
function buildAttachmentSummary(attachments) {
    const lines = [];
    attachments.forEach((attachment) => {
        if (!isImageAttachment(attachment))
            return;
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
function getImageBlocksFromAttachments(attachments) {
    const blocks = [];
    attachments.forEach((attachment) => {
        if (!isImageAttachment(attachment))
            return;
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
function getUserGlobalName(message) {
    return (message.author.globalName ??
        message.author.username ??
        message.author.tag);
}
function getBotGlobalName() {
    return (client.user?.globalName ??
        client.user?.username ??
        client.user?.tag ??
        'Claude Bot');
}
function formatAuthoredContent(authorName, content) {
    const normalized = content.trim();
    const finalContent = normalized.length ? normalized : '(empty message)';
    return `${authorName}: ${finalContent}`;
}
async function bootstrapHistory() {
    const result = countMessagesStmt.get();
    const count = result?.count ?? 0;
    if (count > 0) {
        return;
    }
    if (!MAIN_CHANNEL_ID) {
        console.warn('Cannot bootstrap history: MAIN_CHANNEL_ID is unset.');
        return;
    }
    try {
        const channel = await client.channels.fetch(MAIN_CHANNEL_ID);
        if (!channel || !channel.isTextBased()) {
            console.warn(`Unable to bootstrap history: channel ${MAIN_CHANNEL_ID} is not text-based or could not be fetched.`);
            return;
        }
        const collectedMessages = [];
        let lastId;
        while (collectedMessages.length < BOOTSTRAP_MESSAGE_LIMIT) {
            const remaining = BOOTSTRAP_MESSAGE_LIMIT - collectedMessages.length;
            const fetchLimit = Math.min(remaining, 100);
            const fetched = await channel.messages.fetch({
                limit: fetchLimit,
                before: lastId,
            });
            if (fetched.size === 0) {
                break;
            }
            const newMessages = [...fetched.values()];
            collectedMessages.push(...newMessages);
            lastId = newMessages[newMessages.length - 1]?.id;
        }
        const sortedMessages = collectedMessages
            .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
            .slice(-BOOTSTRAP_MESSAGE_LIMIT);
        console.log(`Bootstrapping ${sortedMessages.length} historical message${sortedMessages.length === 1 ? '' : 's'} from channel ${MAIN_CHANNEL_ID}`);
        for (const msg of sortedMessages) {
            const isAssistant = Boolean(client.user) && msg.author.id === client.user?.id;
            const role = isAssistant ? 'assistant' : 'user';
            const attachmentSummary = buildAttachmentSummary(msg.attachments);
            const messageContent = msg.content || '(empty message)';
            const storedContent = attachmentSummary
                ? `${messageContent}\n${attachmentSummary}`
                : messageContent;
            const authorName = isAssistant
                ? getBotGlobalName()
                : getUserGlobalName(msg);
            saveMessage(msg.channel.id, role, msg.author.id, formatAuthoredContent(authorName, storedContent), msg.createdTimestamp);
        }
    }
    catch (err) {
        console.error('Failed to bootstrap message history:', err);
    }
}
function hasTyping(channel) {
    return !!channel && typeof channel.sendTyping === 'function';
}
function startTypingIndicator(channel) {
    if (!hasTyping(channel)) {
        return () => { };
    }
    const textChannel = channel;
    let active = true;
    let timeout = null;
    const scheduleNext = () => {
        if (!active)
            return;
        timeout = setTimeout(() => {
            void sendTyping();
        }, 9000);
    };
    const sendTyping = async () => {
        if (!active)
            return;
        try {
            await textChannel.sendTyping();
        }
        catch (err) {
            console.warn('Failed to send typing indicator:', err);
            active = false;
            return;
        }
        scheduleNext();
    };
    void sendTyping();
    return () => {
        active = false;
        if (timeout) {
            clearTimeout(timeout);
            timeout = null;
        }
    };
}
function hasSend(channel) {
    return !!channel && typeof channel.send === 'function';
}
// ---------- Events ----------
client.once(discord_js_1.Events.ClientReady, async (c) => {
    console.log(`Logged in as ${c.user.tag}`);
    try {
        await bootstrapHistory();
    }
    catch (err) {
        console.error('Bootstrap history failed:', err);
    }
});
client.on(discord_js_1.Events.MessageCreate, async (message) => {
    let stopTyping = null;
    try {
        const channelId = message.channel.id;
        const userContent = message.content || '(empty message)';
        const canCacheUserMessage = isInScope(message) && !message.author.bot;
        const attachmentSummary = buildAttachmentSummary(message.attachments);
        const userDisplayName = getUserGlobalName(message);
        const storedUserContent = formatAuthoredContent(userDisplayName, attachmentSummary ? `${userContent}\n${attachmentSummary}` : userContent);
        if (canCacheUserMessage) {
            saveMessage(channelId, 'user', message.author.id, storedUserContent, message.createdTimestamp);
        }
        if (!shouldRespond(message))
            return;
        const botDisplayName = getBotGlobalName();
        // Save user message for this channel/thread context
        // (already cached above when canCacheUserMessage true)
        // Build conversation (recent history + this new message)
        const conversation = buildConversation(channelId);
        // Call Claude
        stopTyping = startTypingIndicator(message.channel);
        const imageBlocks = getImageBlocksFromAttachments(message.attachments);
        const claudeReply = await aiProvider.send({
            conversation,
            botDisplayName,
            imageBlocks,
        });
        const replyText = claudeReply.text;
        stopTyping();
        stopTyping = null;
        // Send reply (chunked to satisfy Discord's message length limit)
        const replyChunks = chunkReplyText(replyText);
        let lastSent = null;
        if (replyChunks.length > 0) {
            const [firstChunk, ...restChunks] = replyChunks;
            lastSent = await message.reply(firstChunk);
            saveMessage(channelId, 'assistant', lastSent.author.id, formatAuthoredContent(botDisplayName, firstChunk), lastSent.createdTimestamp);
            for (const chunk of restChunks) {
                if (hasSend(message.channel)) {
                    lastSent = await message.channel.send(chunk);
                }
                else {
                    lastSent = await message.reply(chunk);
                }
                saveMessage(channelId, 'assistant', lastSent.author.id, formatAuthoredContent(botDisplayName, chunk), lastSent.createdTimestamp);
            }
        }
        console.log(`Replied in channel ${channelId} to ${message.author.tag} (${replyText.length} chars, ${replyChunks.length} chunk${replyChunks.length === 1 ? '' : 's'})`);
    }
    catch (err) {
        console.error('Error handling message:', err);
        try {
            await message.reply("Sorry, I hit an error talking to Claude. Check the bot logs / Anthropic config.");
        }
        catch {
            // ignore
        }
    }
    finally {
        stopTyping?.();
    }
});
// ---------- Start ----------
if (!DISCORD_TOKEN) {
    console.error('Missing DISCORD_TOKEN in .env');
    process.exit(1);
}
client.login(DISCORD_TOKEN).catch((err) => {
    console.error('Failed to login to Discord:', err);
    process.exit(1);
});
