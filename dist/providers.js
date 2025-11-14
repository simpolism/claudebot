"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAIProvider = createAIProvider;
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const error_1 = require("@anthropic-ai/sdk/error");
const openai_1 = __importDefault(require("openai"));
function createAIProvider(options) {
    const normalized = options.provider.toLowerCase();
    if (normalized === 'openai') {
        return new OpenAIProvider(options);
    }
    return new AnthropicProvider(options);
}
class AnthropicProvider {
    constructor(options) {
        this.systemPrompt = options.systemPrompt;
        this.prefillCommand = options.prefillCommand;
        this.temperature = options.temperature;
        this.maxTokens = options.maxTokens;
        this.model = options.anthropicModel;
        this.client = new sdk_1.default({
            apiKey: process.env.ANTHROPIC_API_KEY,
            defaultHeaders: {
                'anthropic-beta': 'prompt-caching-2024-07-31',
            },
        });
    }
    async send(params) {
        const { conversation, botDisplayName, imageBlocks } = params;
        const transcriptText = buildTranscript(conversation);
        const trimmedSystemPrompt = this.systemPrompt.trim();
        const systemBlocks = trimmedSystemPrompt
            ? [
                {
                    type: 'text',
                    text: trimmedSystemPrompt,
                    cache_control: { type: 'ephemeral' },
                },
            ]
            : undefined;
        const trackedSpeakers = getTrackedUserNames(conversation, botDisplayName);
        const guard = new FragmentationGuard(buildFragmentationRegex(trackedSpeakers));
        const commandBlocks = [
            {
                type: 'text',
                text: this.prefillCommand,
            },
        ];
        const conversationBlocks = [];
        if (transcriptText) {
            conversationBlocks.push({
                type: 'text',
                text: transcriptText,
            });
        }
        if (imageBlocks.length > 0) {
            conversationBlocks.push(...imageBlocks);
        }
        const messagesPayload = [
            {
                role: 'user',
                content: commandBlocks,
            },
        ];
        if (conversationBlocks.length > 0) {
            messagesPayload.push({
                role: 'user',
                content: conversationBlocks,
            });
        }
        messagesPayload.push({
            role: 'assistant',
            content: [
                {
                    type: 'text',
                    text: `${botDisplayName}:`,
                },
            ],
        });
        const stream = this.client.messages.stream({
            model: this.model,
            max_tokens: this.maxTokens,
            temperature: this.temperature,
            system: systemBlocks,
            messages: messagesPayload,
        });
        let aggregatedText = '';
        let abortedByGuard = false;
        stream.on('text', (delta) => {
            if (guard.truncated)
                return;
            aggregatedText += delta;
            const checked = guard.inspect(aggregatedText);
            if (checked !== aggregatedText) {
                aggregatedText = checked;
                abortedByGuard = true;
                stream.controller.abort();
            }
        });
        try {
            await stream.finalMessage();
        }
        catch (err) {
            if (!(abortedByGuard && err instanceof error_1.APIUserAbortError)) {
                throw err;
            }
        }
        return finalizeResponse(aggregatedText, guard);
    }
}
class OpenAIProvider {
    constructor(options) {
        const apiKey = options.openaiApiKey;
        if (!apiKey) {
            throw new Error('Missing OPENAI_API_KEY for OpenAI-compatible provider.');
        }
        this.systemPrompt = options.systemPrompt;
        this.prefillCommand = options.prefillCommand;
        this.temperature = options.temperature;
        this.maxTokens = options.maxTokens;
        this.model = options.openaiModel;
        this.client = new openai_1.default({
            apiKey,
            baseURL: options.openaiBaseURL,
        });
    }
    async send(params) {
        const { conversation, botDisplayName, imageBlocks } = params;
        const transcriptText = buildTranscript(conversation);
        const trackedSpeakers = getTrackedUserNames(conversation, botDisplayName);
        const guard = new FragmentationGuard(buildFragmentationRegex(trackedSpeakers));
        const trimmedSystemPrompt = this.systemPrompt.trim();
        const messages = [];
        if (trimmedSystemPrompt) {
            messages.push({
                role: 'system',
                content: trimmedSystemPrompt,
            });
        }
        const commandContent = [
            {
                type: 'text',
                text: this.prefillCommand,
            },
        ];
        messages.push({
            role: 'user',
            content: commandContent,
        });
        const conversationParts = buildOpenAIConversationParts(transcriptText, imageBlocks, botDisplayName);
        if (conversationParts.length > 0) {
            messages.push({
                role: 'user',
                content: conversationParts,
            });
        }
        const stream = await this.client.chat.completions.create({
            model: this.model,
            temperature: this.temperature,
            max_tokens: this.maxTokens,
            stream: true,
            messages,
        });
        let aggregatedText = '';
        let abortedByGuard = false;
        try {
            for await (const chunk of stream) {
                if (guard.truncated)
                    break;
                const deltaText = extractOpenAIDelta(chunk);
                if (!deltaText)
                    continue;
                aggregatedText += deltaText;
                const checked = guard.inspect(aggregatedText);
                if (checked !== aggregatedText) {
                    aggregatedText = checked;
                    abortedByGuard = true;
                    stream.controller.abort();
                    break;
                }
            }
        }
        catch (err) {
            if (!(abortedByGuard && isAbortError(err))) {
                throw err;
            }
        }
        return finalizeResponse(aggregatedText, guard);
    }
}
class FragmentationGuard {
    constructor(regex) {
        this.truncated = false;
        this.regex = regex;
    }
    inspect(currentText) {
        if (!this.regex || this.truncated) {
            return currentText;
        }
        this.regex.lastIndex = 0;
        const match = this.regex.exec(currentText);
        if (!match)
            return currentText;
        this.truncated = true;
        this.truncatedSpeaker = match[1]?.trim();
        return currentText.slice(0, match.index).trimEnd();
    }
}
function finalizeResponse(text, guard) {
    const trimmed = text.trim() || '(no response text)';
    if (guard.truncated && guard.truncatedSpeaker) {
        console.warn(`AI output truncated after detecting speaker "${guard.truncatedSpeaker}".`);
    }
    return {
        text: trimmed,
        truncated: guard.truncated,
        truncatedSpeaker: guard.truncatedSpeaker,
    };
}
function buildTranscript(conversation) {
    return conversation
        .map((msg) => msg.content)
        .join('\n')
        .trim();
}
function buildOpenAIConversationParts(transcriptText, imageBlocks, botDisplayName) {
    const parts = [];
    if (transcriptText) {
        parts.push({
            type: 'text',
            text: transcriptText,
        });
    }
    imageBlocks.forEach((block) => {
        parts.push({
            type: 'image_url',
            image_url: {
                url: block.source.url,
            },
        });
    });
    parts.push({
        type: 'text',
        text: `${botDisplayName}:`,
    });
    return parts;
}
function extractOpenAIDelta(chunk) {
    if (!chunk?.choices?.length)
        return '';
    return chunk.choices
        .map((choice) => {
        const delta = choice.delta;
        const content = delta?.content;
        if (typeof content === 'string') {
            return content;
        }
        if (Array.isArray(content)) {
            return content
                .map((part) => {
                if (part == null)
                    return '';
                if (typeof part === 'string')
                    return part;
                if (typeof part.text === 'string' && part.type === 'text') {
                    return part.text;
                }
                return '';
            })
                .join('');
        }
        return '';
    })
        .join('');
}
function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function extractAuthorName(content) {
    const colonIndex = content.indexOf(':');
    if (colonIndex === -1) {
        return null;
    }
    return content.slice(0, colonIndex).trim();
}
function getTrackedUserNames(conversation, botDisplayName) {
    const normalizedBot = botDisplayName.toLowerCase();
    const names = new Set();
    conversation.forEach((message) => {
        if (message.role !== 'user')
            return;
        const authorName = extractAuthorName(message.content);
        if (!authorName)
            return;
        if (authorName.toLowerCase() === normalizedBot)
            return;
        names.add(authorName);
    });
    return [...names];
}
function buildFragmentationRegex(names) {
    if (names.length === 0)
        return null;
    const escapedNames = names.map(escapeRegExp).join('|');
    return new RegExp(`(?:^|[\\r\\n])\\s*(?:<?\\s*)?(${escapedNames})\\s*>?:`, 'i');
}
function isAbortError(error) {
    return error instanceof Error && error.name === 'AbortError';
}
