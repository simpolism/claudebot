"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.startDebugServer = startDebugServer;
const http = __importStar(require("http"));
const message_store_1 = require("./message-store");
const config_1 = require("./config");
const bot_1 = require("./bot");
const DEBUG_PORT = parseInt(process.env.DEBUG_PORT || '3847', 10);
function estimateTokens(text) {
    return Math.ceil(text.length / Math.max(config_1.globalConfig.approxCharsPerToken, 1));
}
function estimateMessageTokens(authorName, content) {
    return estimateTokens(`${authorName}: ${content}`) + 4;
}
function getChannelDebugInfo(channelId) {
    const messages = (0, message_store_1.getChannelMessages)(channelId);
    const boundaries = (0, message_store_1.getBlockBoundaries)(channelId);
    // Find where tail starts
    let tailStartIdx = 0;
    if (boundaries.length > 0) {
        const lastBoundary = boundaries[boundaries.length - 1];
        const lastBoundaryIdx = messages.findIndex((m) => m.id === lastBoundary?.lastMessageId);
        if (lastBoundaryIdx !== -1) {
            tailStartIdx = lastBoundaryIdx + 1;
        }
    }
    // Build block info
    const blockInfo = boundaries.map((boundary, idx) => {
        const firstIdx = messages.findIndex((m) => m.id === boundary.firstMessageId);
        const lastIdx = messages.findIndex((m) => m.id === boundary.lastMessageId);
        const blockMessageCount = firstIdx !== -1 && lastIdx !== -1 ? lastIdx - firstIdx + 1 : 0;
        const firstMsg = messages.find((m) => m.id === boundary.firstMessageId);
        const lastMsg = messages.find((m) => m.id === boundary.lastMessageId);
        return {
            index: idx,
            firstMessageId: boundary.firstMessageId,
            lastMessageId: boundary.lastMessageId,
            tokenCount: boundary.tokenCount,
            messageCount: blockMessageCount,
            firstMessage: firstMsg ? `${firstMsg.authorName}: ${firstMsg.content.slice(0, 100)}...` : 'NOT FOUND',
            lastMessage: lastMsg ? `${lastMsg.authorName}: ${lastMsg.content.slice(0, 100)}...` : 'NOT FOUND',
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
function getBotInstance(botName) {
    return bot_1.botInstances.find((inst) => inst.config.name.toLowerCase() === botName.toLowerCase() || inst.client.user?.username?.toLowerCase() === botName.toLowerCase());
}
function buildTranscriptText(blocks, tail) {
    const parts = [...blocks];
    if (tail.length > 0) {
        parts.push(tail.map((m) => m.content).join('\n'));
    }
    return parts.join('\n').trim();
}
function buildPayloadPreview(channelId, botName) {
    const instance = getBotInstance(botName);
    if (!instance) {
        return { error: `Bot "${botName}" not found. Available bots: ${bot_1.botInstances.map((i) => i.config.name).join(', ')}` };
    }
    if (!instance.client.user) {
        return { error: `Bot "${botName}" is not logged in yet` };
    }
    const botUserId = instance.client.user.id;
    const botDisplayName = instance.client.user.username ?? instance.client.user.globalName ?? instance.client.user.tag ?? 'Bot';
    const resolved = (0, config_1.resolveConfig)(instance.config);
    const contextResult = (0, message_store_1.getContext)(channelId, resolved.maxContextTokens, botUserId, botDisplayName);
    // Convert to SimpleMessage format (as done in context.ts)
    const tail = contextResult.tail.map((content) => ({
        role: content.startsWith(`${botDisplayName}:`) ? 'assistant' : 'user',
        content,
    }));
    const transcript = {
        blocks: contextResult.blocks,
        tail,
        totalTokens: contextResult.totalTokens,
    };
    // Build provider-specific payload preview
    let apiPayload;
    if (resolved.provider === 'anthropic') {
        apiPayload = buildAnthropicPayloadPreview(transcript, botDisplayName, resolved);
    }
    else if (resolved.provider === 'openai') {
        apiPayload = buildOpenAIPayloadPreview(transcript, botDisplayName, resolved, instance.config.supportsImageBlocks ?? false);
    }
    else if (resolved.provider === 'gemini') {
        apiPayload = buildGeminiPayloadPreview(transcript, botDisplayName, resolved);
    }
    else {
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
function buildAnthropicPayloadPreview(transcript, botDisplayName, config) {
    const systemBlocks = config.systemPrompt?.trim()
        ? [
            {
                type: 'text',
                text: config.systemPrompt.trim(),
                cache_control: { type: 'ephemeral', ttl: '1h' },
            },
        ]
        : undefined;
    const conversationBlocks = [];
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
function buildOpenAIPayloadPreview(transcript, botDisplayName, config, supportsImageBlocks) {
    const transcriptText = buildTranscriptText(transcript.blocks, transcript.tail);
    const messages = [];
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
    }
    else {
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
function buildGeminiPayloadPreview(transcript, botDisplayName, config) {
    const transcriptText = buildTranscriptText(transcript.blocks, transcript.tail);
    const contents = [
        { role: 'user', parts: [{ text: transcriptText }] },
        { role: 'model', parts: [{ text: `${botDisplayName}:` }] },
    ];
    const responseModalities = config.geminiOutputMode === 'image' ? ['Image'] : config.geminiOutputMode === 'text' ? ['Text'] : ['Text', 'Image'];
    return {
        model: config.model,
        contents,
        config: {
            responseModalities,
            systemInstruction: config.systemPrompt?.trim() || undefined,
        },
        _note: 'This shows the exact structure sent to Gemini API (images not included in preview)',
    };
}
function handleRequest(req, res) {
    const url = new URL(req.url || '/', `http://localhost:${DEBUG_PORT}`);
    res.setHeader('Content-Type', 'application/json');
    try {
        if (url.pathname === '/stats') {
            const stats = (0, message_store_1.getStats)();
            res.writeHead(200);
            res.end(JSON.stringify(stats, null, 2));
        }
        else if (url.pathname === '/channels') {
            const channelIds = config_1.globalConfig.mainChannelIds;
            const channelInfos = channelIds.map(getChannelDebugInfo);
            res.writeHead(200);
            res.end(JSON.stringify(channelInfos, null, 2));
        }
        else if (url.pathname === '/channel') {
            const channelId = url.searchParams.get('id');
            if (!channelId) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Missing id parameter' }));
                return;
            }
            const info = getChannelDebugInfo(channelId);
            res.writeHead(200);
            res.end(JSON.stringify(info, null, 2));
        }
        else if (url.pathname === '/messages') {
            const channelId = url.searchParams.get('id');
            const limit = parseInt(url.searchParams.get('limit') || '50', 10);
            if (!channelId) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Missing id parameter' }));
                return;
            }
            const messages = (0, message_store_1.getChannelMessages)(channelId);
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
        }
        else if (url.pathname === '/boundaries') {
            const channelId = url.searchParams.get('id');
            if (!channelId) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Missing id parameter' }));
                return;
            }
            const boundaries = (0, message_store_1.getBlockBoundaries)(channelId);
            res.writeHead(200);
            res.end(JSON.stringify(boundaries, null, 2));
        }
        else if (url.pathname === '/health') {
            res.writeHead(200);
            res.end(JSON.stringify({ status: 'ok', timestamp: Date.now() }));
        }
        else if (url.pathname === '/bots') {
            const bots = bot_1.botInstances.map((inst) => ({
                name: inst.config.name,
                provider: inst.config.provider,
                model: inst.config.model,
                discordUserId: inst.client.user?.id ?? null,
                discordUsername: inst.client.user?.username ?? null,
                loggedIn: !!inst.client.user,
                maxContextTokens: (0, config_1.resolveConfig)(inst.config).maxContextTokens,
            }));
            res.writeHead(200);
            res.end(JSON.stringify(bots, null, 2));
        }
        else if (url.pathname === '/payload') {
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
        }
        else if (url.pathname === '/transcript') {
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
            const transcriptText = buildTranscriptText(preview.transcript.blocks, preview.transcript.tail);
            res.writeHead(200);
            res.end(transcriptText + `\n${preview.botName}:`);
        }
        else {
            res.writeHead(200);
            res.end(JSON.stringify({
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
            }));
        }
    }
    catch (err) {
        console.error('[debug-server] Error handling request:', err);
        res.writeHead(500);
        res.end(JSON.stringify({ error: String(err) }));
    }
}
function startDebugServer() {
    const server = http.createServer(handleRequest);
    server.listen(DEBUG_PORT, '127.0.0.1', () => {
        console.log(`[debug-server] Running on http://127.0.0.1:${DEBUG_PORT}`);
    });
}
