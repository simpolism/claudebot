import * as http from 'http';
import {
  getChannelMessages,
  getBlockBoundaries,
  getStats,
  StoredMessage,
  BlockBoundary,
  getContext,
} from './message-store';
import { globalConfig, resolveConfig } from './config';
import { botInstances, BotInstance } from './bot';
import { SimpleMessage } from './types';

const DEBUG_PORT = parseInt(process.env.DEBUG_PORT || '3847', 10);

interface ChannelDebugInfo {
  channelId: string;
  messageCount: number;
  blockCount: number;
  blocks: Array<{
    index: number;
    firstMessageId: string;
    lastMessageId: string;
    tokenCount: number;
    messageCount: number;
    firstMessage?: string;
    lastMessage?: string;
  }>;
  tailMessageCount: number;
  tailTokenEstimate: number;
  recentTailMessages: Array<{
    id: string;
    author: string;
    content: string;
    timestamp: number;
  }>;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / Math.max(globalConfig.approxCharsPerToken, 1));
}

function estimateMessageTokens(authorName: string, content: string): number {
  return estimateTokens(`${authorName}: ${content}`) + 4;
}

function getChannelDebugInfo(channelId: string): ChannelDebugInfo {
  const messages = getChannelMessages(channelId);
  const boundaries = getBlockBoundaries(channelId);

  // Find where tail starts
  let tailStartIdx = 0;
  if (boundaries.length > 0) {
    const lastBoundary = boundaries[boundaries.length - 1];
    const lastBoundaryIdx = messages.findIndex(
      (m) => m.id === lastBoundary?.lastMessageId,
    );
    if (lastBoundaryIdx !== -1) {
      tailStartIdx = lastBoundaryIdx + 1;
    }
  }

  // Build block info
  const blockInfo = boundaries.map((boundary, idx) => {
    const firstIdx = messages.findIndex((m) => m.id === boundary.firstMessageId);
    const lastIdx = messages.findIndex((m) => m.id === boundary.lastMessageId);
    const blockMessageCount =
      firstIdx !== -1 && lastIdx !== -1 ? lastIdx - firstIdx + 1 : 0;

    const firstMsg = messages.find((m) => m.id === boundary.firstMessageId);
    const lastMsg = messages.find((m) => m.id === boundary.lastMessageId);

    return {
      index: idx,
      firstMessageId: boundary.firstMessageId,
      lastMessageId: boundary.lastMessageId,
      tokenCount: boundary.tokenCount,
      messageCount: blockMessageCount,
      firstMessage: firstMsg
        ? `${firstMsg.authorName}: ${firstMsg.content.slice(0, 100)}...`
        : 'NOT FOUND',
      lastMessage: lastMsg
        ? `${lastMsg.authorName}: ${lastMsg.content.slice(0, 100)}...`
        : 'NOT FOUND',
    };
  });

  // Get tail info
  const tailMessages = messages.slice(tailStartIdx);
  let tailTokens = 0;
  for (const msg of tailMessages) {
    tailTokens += estimateMessageTokens(msg.authorName, msg.content);
  }

  const recentTail = tailMessages.slice(-10).map((msg) => ({
    id: msg.id,
    author: msg.authorName,
    content: msg.content.slice(0, 200) + (msg.content.length > 200 ? '...' : ''),
    timestamp: msg.timestamp,
  }));

  return {
    channelId,
    messageCount: messages.length,
    blockCount: boundaries.length,
    blocks: blockInfo,
    tailMessageCount: tailMessages.length,
    tailTokenEstimate: tailTokens,
    recentTailMessages: recentTail,
  };
}

// ---------- Per-Bot Payload Preview ----------

interface BotPayloadPreview {
  botName: string;
  botUserId: string;
  provider: string;
  model: string;
  channelId: string;
  maxContextTokens: number;
  transcript: {
    blocks: string[];
    tail: SimpleMessage[];
    totalTokens: number;
  };
  apiPayload: unknown;
}

function getBotInstance(botName: string): BotInstance | undefined {
  return botInstances.find(
    (inst) =>
      inst.config.name.toLowerCase() === botName.toLowerCase() ||
      inst.client.user?.username?.toLowerCase() === botName.toLowerCase(),
  );
}

function buildTranscriptText(blocks: string[], tail: SimpleMessage[]): string {
  const parts: string[] = [...blocks];
  if (tail.length > 0) {
    parts.push(tail.map((m) => m.content).join('\n'));
  }
  return parts.join('\n').trim();
}

function buildPayloadPreview(
  channelId: string,
  botName: string,
): BotPayloadPreview | { error: string } {
  const instance = getBotInstance(botName);
  if (!instance) {
    return {
      error: `Bot "${botName}" not found. Available bots: ${botInstances.map((i) => i.config.name).join(', ')}`,
    };
  }

  if (!instance.client.user) {
    return { error: `Bot "${botName}" is not logged in yet` };
  }

  const botUserId = instance.client.user.id;
  const botDisplayName =
    instance.client.user.username ??
    instance.client.user.globalName ??
    instance.client.user.tag ??
    'Bot';
  const resolved = resolveConfig(instance.config);

  // Note: Debug server shows channel context, not thread context
  // To support threads, would need to detect thread and pass threadId/parentChannelId
  const contextResult = getContext(
    channelId,
    resolved.maxContextTokens,
    botUserId,
    botDisplayName,
    null,
    undefined,
  );

  // Convert to SimpleMessage format (as done in context.ts)
  const tail: SimpleMessage[] = contextResult.tail.map((content) => ({
    role: content.startsWith(`${botDisplayName}:`) ? 'assistant' : 'user',
    content,
  }));

  const transcript = {
    blocks: contextResult.blocks,
    tail,
    totalTokens: contextResult.totalTokens,
  };

  // Build provider-specific payload preview
  let apiPayload: unknown;

  if (resolved.provider === 'anthropic') {
    apiPayload = buildAnthropicPayloadPreview(transcript, botDisplayName, resolved);
  } else if (resolved.provider === 'openai') {
    apiPayload = buildOpenAIPayloadPreview(
      transcript,
      botDisplayName,
      resolved,
      instance.config.supportsImageBlocks ?? false,
    );
  } else if (resolved.provider === 'gemini') {
    apiPayload = buildGeminiPayloadPreview(transcript, botDisplayName, resolved);
  } else {
    apiPayload = { error: `Unknown provider: ${resolved.provider}` };
  }

  return {
    botName: instance.config.name,
    botUserId,
    provider: resolved.provider,
    model: resolved.model,
    channelId,
    maxContextTokens: resolved.maxContextTokens,
    transcript,
    apiPayload,
  };
}

function buildAnthropicPayloadPreview(
  transcript: { blocks: string[]; tail: SimpleMessage[] },
  botDisplayName: string,
  config: ReturnType<typeof resolveConfig>,
): unknown {
  const systemBlocks = config.systemPrompt?.trim()
    ? [
        {
          type: 'text',
          text: config.systemPrompt.trim(),
          cache_control: { type: 'ephemeral', ttl: '1h' },
        },
      ]
    : undefined;

  const conversationBlocks: unknown[] = [];

  // Cached blocks with cache_control
  for (const blockText of transcript.blocks) {
    conversationBlocks.push({
      type: 'text',
      text: blockText + '\n',
      cache_control: { type: 'ephemeral', ttl: '1h' },
    });
  }

  // Tail (uncached)
  if (transcript.tail.length > 0) {
    const tailText = transcript.tail.map((m) => m.content).join('\n');
    conversationBlocks.push({
      type: 'text',
      text: tailText,
    });
  }

  const messages = [
    {
      role: 'user',
      content: conversationBlocks,
    },
    {
      role: 'assistant',
      content: [{ type: 'text', text: `${botDisplayName}:` }],
    },
  ];

  return {
    model: config.model,
    max_tokens: config.maxTokens,
    temperature: config.temperature,
    system: systemBlocks,
    messages,
    _note: 'This shows the exact structure sent to Anthropic API',
  };
}

function buildOpenAIPayloadPreview(
  transcript: { blocks: string[]; tail: SimpleMessage[] },
  botDisplayName: string,
  config: ReturnType<typeof resolveConfig>,
  supportsImageBlocks: boolean,
): unknown {
  const transcriptText = buildTranscriptText(transcript.blocks, transcript.tail);
  const messages: unknown[] = [];

  if (config.systemPrompt?.trim()) {
    messages.push({
      role: 'system',
      content: config.systemPrompt.trim(),
    });
  }

  if (supportsImageBlocks) {
    // When images supported, transcript in user role
    messages.push({
      role: 'user',
      content: [{ type: 'text', text: transcriptText }],
    });
    messages.push({
      role: 'assistant',
      content: `${botDisplayName}:`,
    });
  } else {
    // Transcript as assistant prefill
    messages.push({
      role: 'assistant',
      content: transcriptText + `\n${botDisplayName}:`,
    });
  }

  return {
    model: config.model,
    temperature: config.temperature,
    max_tokens: config.maxTokens,
    stream: true,
    messages,
    _note: 'This shows the exact structure sent to OpenAI-compatible API',
  };
}

function buildGeminiPayloadPreview(
  transcript: { blocks: string[]; tail: SimpleMessage[] },
  botDisplayName: string,
  config: ReturnType<typeof resolveConfig>,
): unknown {
  const transcriptText = buildTranscriptText(transcript.blocks, transcript.tail);

  const contents = [
    { role: 'user', parts: [{ text: transcriptText }] },
    { role: 'model', parts: [{ text: `${botDisplayName}:` }] },
  ];

  const responseModalities =
    config.geminiOutputMode === 'image'
      ? ['Image']
      : config.geminiOutputMode === 'text'
        ? ['Text']
        : ['Text', 'Image'];

  return {
    model: config.model,
    contents,
    config: {
      responseModalities,
      systemInstruction: config.systemPrompt?.trim() || undefined,
    },
    _note:
      'This shows the exact structure sent to Gemini API (images not included in preview)',
  };
}

function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = new URL(req.url || '/', `http://localhost:${DEBUG_PORT}`);

  res.setHeader('Content-Type', 'application/json');

  try {
    if (url.pathname === '/stats') {
      const stats = getStats();
      res.writeHead(200);
      res.end(JSON.stringify(stats, null, 2));
    } else if (url.pathname === '/channels') {
      const channelIds = globalConfig.mainChannelIds;
      const channelInfos = channelIds.map(getChannelDebugInfo);
      res.writeHead(200);
      res.end(JSON.stringify(channelInfos, null, 2));
    } else if (url.pathname === '/channel') {
      const channelId = url.searchParams.get('id');
      if (!channelId) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Missing id parameter' }));
        return;
      }
      const info = getChannelDebugInfo(channelId);
      res.writeHead(200);
      res.end(JSON.stringify(info, null, 2));
    } else if (url.pathname === '/messages') {
      const channelId = url.searchParams.get('id');
      const limit = parseInt(url.searchParams.get('limit') || '50', 10);
      if (!channelId) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Missing id parameter' }));
        return;
      }
      const messages = getChannelMessages(channelId);
      const recent = messages.slice(-limit).map((msg) => ({
        id: msg.id,
        author: msg.authorName,
        authorId: msg.authorId,
        content: msg.content,
        timestamp: msg.timestamp,
        time: new Date(msg.timestamp).toISOString(),
      }));
      res.writeHead(200);
      res.end(JSON.stringify(recent, null, 2));
    } else if (url.pathname === '/boundaries') {
      const channelId = url.searchParams.get('id');
      if (!channelId) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Missing id parameter' }));
        return;
      }
      const boundaries = getBlockBoundaries(channelId);
      res.writeHead(200);
      res.end(JSON.stringify(boundaries, null, 2));
    } else if (url.pathname === '/health') {
      res.writeHead(200);
      res.end(JSON.stringify({ status: 'ok', timestamp: Date.now() }));
    } else if (url.pathname === '/bots') {
      const bots = botInstances.map((inst) => ({
        name: inst.config.name,
        provider: inst.config.provider,
        model: inst.config.model,
        discordUserId: inst.client.user?.id ?? null,
        discordUsername: inst.client.user?.username ?? null,
        loggedIn: !!inst.client.user,
        maxContextTokens: resolveConfig(inst.config).maxContextTokens,
      }));
      res.writeHead(200);
      res.end(JSON.stringify(bots, null, 2));
    } else if (url.pathname === '/payload') {
      const channelId = url.searchParams.get('id');
      const botName = url.searchParams.get('bot');
      if (!channelId) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Missing id parameter (channel ID)' }));
        return;
      }
      if (!botName) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Missing bot parameter (bot name)' }));
        return;
      }
      const preview = buildPayloadPreview(channelId, botName);
      res.writeHead(200);
      res.end(JSON.stringify(preview, null, 2));
    } else if (url.pathname === '/transcript') {
      const channelId = url.searchParams.get('id');
      const botName = url.searchParams.get('bot');
      if (!channelId) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Missing id parameter (channel ID)' }));
        return;
      }
      if (!botName) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Missing bot parameter (bot name)' }));
        return;
      }
      const preview = buildPayloadPreview(channelId, botName);
      if ('error' in preview) {
        res.writeHead(400);
        res.end(JSON.stringify(preview));
        return;
      }
      // Return just the formatted transcript text as plain text
      res.setHeader('Content-Type', 'text/plain');
      const transcriptText = buildTranscriptText(
        preview.transcript.blocks,
        preview.transcript.tail,
      );
      res.writeHead(200);
      res.end(transcriptText + `\n${preview.botName}:`);
    } else {
      res.writeHead(200);
      res.end(
        JSON.stringify({
          endpoints: [
            'GET /stats - Overall statistics',
            'GET /channels - Info for all configured channels',
            'GET /channel?id=<channelId> - Detailed info for specific channel',
            'GET /messages?id=<channelId>&limit=50 - Recent messages',
            'GET /boundaries?id=<channelId> - Raw block boundaries',
            'GET /bots - List all configured bots',
            'GET /payload?id=<channelId>&bot=<botName> - Exact API payload for bot',
            'GET /transcript?id=<channelId>&bot=<botName> - Plain text transcript as bot sees it',
            'GET /health - Health check',
          ],
        }),
      );
    }
  } catch (err) {
    console.error('[debug-server] Error handling request:', err);
    res.writeHead(500);
    res.end(JSON.stringify({ error: String(err) }));
  }
}

export function startDebugServer(): void {
  const server = http.createServer(handleRequest);
  server.listen(DEBUG_PORT, '127.0.0.1', () => {
    console.log(`[debug-server] Running on http://127.0.0.1:${DEBUG_PORT}`);
  });
}
