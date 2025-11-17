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
        else {
            res.writeHead(200);
            res.end(JSON.stringify({
                endpoints: [
                    'GET /stats - Overall statistics',
                    'GET /channels - Info for all configured channels',
                    'GET /channel?id=<channelId> - Detailed info for specific channel',
                    'GET /messages?id=<channelId>&limit=50 - Recent messages',
                    'GET /boundaries?id=<channelId> - Raw block boundaries',
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
