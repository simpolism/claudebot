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
        this.maxContextTokens = options.maxContextTokens;
        this.approxCharsPerToken = options.approxCharsPerToken;
        this.client = new sdk_1.default({
            apiKey: process.env.ANTHROPIC_API_KEY,
            defaultHeaders: {
                'anthropic-beta': 'prompt-caching-2024-07-31',
            },
        });
    }
    async send(params) {
        const { conversationData, botDisplayName, imageBlocks } = params;
        const { cachedBlocks, tail } = conversationData;
        const trimmedSystemPrompt = this.systemPrompt.trim();
        const systemBlocks = trimmedSystemPrompt
            ? [
                {
                    type: 'text',
                    text: trimmedSystemPrompt,
                    cache_control: {
                        type: 'ephemeral',
                        ttl: '1h',
                    },
                },
            ]
            : undefined;
        // Build speaker list from both cached blocks and tail
        const allText = [...cachedBlocks, ...tail.map((m) => m.content)].join('\n');
        const trackedSpeakers = extractSpeakersFromText(allText, botDisplayName);
        const guard = new FragmentationGuard(buildFragmentationRegex(trackedSpeakers));
        const commandBlocks = this.prefillCommand
            ? [
                {
                    type: 'text',
                    text: this.prefillCommand,
                },
            ]
            : [];
        // Build conversation blocks with stable caching
        const conversationBlocks = [];
        // Cached blocks - these should hit the cache
        for (const blockText of cachedBlocks) {
            conversationBlocks.push({
                type: 'text',
                text: blockText + '\n',
                cache_control: {
                    type: 'ephemeral',
                    ttl: '1h',
                },
            });
        }
        // Tail - fresh messages, no cache
        if (tail.length > 0) {
            const tailText = tail.map((m) => m.content).join('\n');
            conversationBlocks.push({
                type: 'text',
                text: tailText,
            });
        }
        if (imageBlocks.length > 0) {
            conversationBlocks.push(...imageBlocks);
        }
        const messagesPayload = [];
        if (commandBlocks.length > 0) {
            messagesPayload.push({
                role: 'user',
                content: commandBlocks,
            });
        }
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
        const { conversationData, botDisplayName, imageBlocks } = params;
        const { cachedBlocks, tail } = conversationData;
        const transcriptText = buildTranscriptFromData(cachedBlocks, tail);
        const allText = [...cachedBlocks, ...tail.map((m) => m.content)].join('\n');
        const trackedSpeakers = extractSpeakersFromText(allText, botDisplayName);
        const guard = new FragmentationGuard(buildFragmentationRegex(trackedSpeakers));
        const trimmedSystemPrompt = this.systemPrompt.trim();
        const messages = [];
        if (trimmedSystemPrompt?.length > 0) {
            messages.push({
                role: 'system',
                content: trimmedSystemPrompt,
            });
        }
        const trimmedPrefillCommand = this.prefillCommand.trim();
        if (trimmedPrefillCommand?.length > 0) {
            messages.push({
                role: 'user',
                content: trimmedPrefillCommand,
            });
        }
        messages.push({
            role: 'assistant',
            content: transcriptText + `\n\n${botDisplayName}:`,
        });
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
        let match;
        while ((match = this.regex.exec(currentText))) {
            const matchIndex = match.index;
            if (matchIndex === 0) {
                continue;
            }
            this.truncated = true;
            this.truncatedSpeaker = match[1]?.trim();
            return currentText.slice(0, matchIndex).trimEnd();
        }
        return currentText;
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
function buildTranscriptFromData(cachedBlocks, tail) {
    const parts = [...cachedBlocks];
    if (tail.length > 0) {
        parts.push(tail.map((m) => m.content).join('\n'));
    }
    return parts.join('\n').trim();
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
function extractSpeakersFromText(text, botDisplayName) {
    const normalizedBot = botDisplayName.toLowerCase();
    const names = new Set();
    // Match "Name:" at the start of lines
    const lines = text.split('\n');
    for (const line of lines) {
        const colonIndex = line.indexOf(':');
        if (colonIndex === -1)
            continue;
        const name = line.slice(0, colonIndex).trim();
        if (!name)
            continue;
        if (name.toLowerCase() === normalizedBot)
            continue;
        names.add(name);
    }
    return [...names];
}
function buildFragmentationRegex(names) {
    if (names.length === 0)
        return null;
    const escapedNames = names.map(escapeRegExp).join('|');
    return new RegExp(`(?:^|[\\r\\n])\\s*(?:<?\\s*)?(${escapedNames})\\s*>?:`, 'gi');
}
function isAbortError(error) {
    return error instanceof Error && error.name === 'AbortError';
}
