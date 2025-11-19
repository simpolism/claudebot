"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAIProvider = createAIProvider;
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const error_1 = require("@anthropic-ai/sdk/error");
const openai_1 = __importDefault(require("openai"));
const genai_1 = require("@google/genai");
function createAIProvider(options) {
    const normalized = options.provider.toLowerCase();
    if (normalized === 'openai') {
        return new OpenAIProvider(options);
    }
    if (normalized === 'gemini') {
        return new GeminiProvider(options);
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
        this.useVerticalFormat = options.useVerticalFormat ?? false;
        this.client = new sdk_1.default({
            apiKey: process.env.ANTHROPIC_API_KEY,
            defaultHeaders: {
                'anthropic-beta': 'prompt-caching-2024-07-31',
            },
        });
    }
    async send(params) {
        const { conversationData, botDisplayName, imageBlocks, otherSpeakers } = params;
        const { cachedBlocks, tail } = conversationData;
        const trimmedSystemPrompt = this.systemPrompt.trim();
        const assistantName = botDisplayName || 'Assistant';
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
        // Use actual Discord usernames for fragmentation detection
        const guard = new FragmentationGuard(buildFragmentationRegex(otherSpeakers));
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
        // Assistant prefill with proper format
        // Anthropic rejects messages whose final content block ends with trailing whitespace,
        // so avoid a trailing newline in the assistant prefill.
        const assistantPrefill = this.useVerticalFormat
            ? `[${assistantName}]`
            : `${assistantName}:`;
        messagesPayload.push({
            role: 'assistant',
            content: [
                {
                    type: 'text',
                    text: assistantPrefill,
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
        this.supportsImageBlocks = options.supportsImageBlocks;
        this.useUserAssistantPrefill = options.useUserAssistantPrefill;
        this.usePromptCaching = options.useOpenAIEndpointOptimizations;
        this.useVerticalFormat = options.useVerticalFormat ?? false;
        this.client = new openai_1.default({
            apiKey,
            baseURL: options.openaiBaseURL,
        });
    }
    async send(params) {
        const { conversationData, botDisplayName, imageBlocks, otherSpeakers } = params;
        const { cachedBlocks, tail } = conversationData;
        const guard = new FragmentationGuard(buildFragmentationRegex(otherSpeakers));
        const trimmedSystemPrompt = this.systemPrompt.trim();
        const trimmedPrefillCommand = this.prefillCommand.trim();
        const usePromptCaching = this.usePromptCaching;
        const assistantName = botDisplayName || 'Assistant';
        // Assistant prefill with proper format
        const assistantPrefill = this.useVerticalFormat
            ? `[${assistantName}]`
            : `${assistantName}:`;
        const messages = [];
        if (trimmedSystemPrompt?.length > 0) {
            messages.push({
                role: 'system',
                content: trimmedSystemPrompt,
            });
        }
        if (trimmedPrefillCommand?.length > 0) {
            messages.push({
                role: 'user',
                content: trimmedPrefillCommand,
            });
        }
        if (usePromptCaching) {
            for (const blockText of cachedBlocks) {
                const normalized = blockText.endsWith('\n') ? blockText : `${blockText}\n`;
                messages.push({
                    role: 'user',
                    content: normalized,
                });
            }
            const tailText = tail.length > 0 ? tail.map((m) => m.content).join('\n') : '';
            const tailContentParts = [];
            if (tailText) {
                tailContentParts.push({
                    type: 'text',
                    text: tailText,
                });
            }
            if (this.supportsImageBlocks && imageBlocks.length > 0) {
                tailContentParts.push(...imageBlocks.map((block) => ({
                    type: 'image_url',
                    image_url: {
                        url: block.source.url,
                    },
                })));
            }
            if (tailContentParts.length > 0) {
                messages.push({
                    role: 'user',
                    content: tailContentParts.length === 1 && tailContentParts[0].type === 'text'
                        ? tailContentParts[0].text
                        : tailContentParts,
                });
            }
            messages.push({
                role: 'assistant',
                content: assistantPrefill,
            });
        }
        else if (this.supportsImageBlocks || this.useUserAssistantPrefill) {
            const transcriptText = buildTranscriptFromData(cachedBlocks, tail);
            // When images are supported or user/assistant prefill is requested,
            // transcript must be in user content (for image_url blocks or Anthropic-style formatting)
            const userContent = [
                {
                    type: 'text',
                    text: transcriptText,
                },
            ];
            if (imageBlocks.length > 0) {
                userContent.push(...imageBlocks.map((block) => ({
                    type: 'image_url',
                    image_url: {
                        url: block.source.url,
                    },
                })));
            }
            messages.push({
                role: 'user',
                content: userContent,
            });
            messages.push({
                role: 'assistant',
                content: assistantPrefill,
            });
        }
        else {
            const transcriptText = buildTranscriptFromData(cachedBlocks, tail);
            // Prefer transcript in assistant role with prefill appended
            // This gives the model more natural continuation behavior
            messages.push({
                role: 'assistant',
                content: transcriptText ? `${transcriptText}\n${assistantPrefill}` : assistantPrefill,
            });
        }
        const requestPayload = {
            model: this.model,
            temperature: this.temperature,
            stream: true,
            messages,
        };
        if (this.usePromptCaching) {
            requestPayload.max_completion_tokens = this.maxTokens;
            requestPayload.max_tokens = undefined;
        }
        else {
            requestPayload.max_tokens = this.maxTokens;
            requestPayload.max_completion_tokens = undefined;
        }
        const stream = await this.client.chat.completions.create(requestPayload);
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
        if (this.usePromptCaching) {
            aggregatedText = stripAssistantPrefillPrefix(aggregatedText, assistantName, this.useVerticalFormat);
        }
        return finalizeResponse(aggregatedText, guard);
    }
}
class GeminiProvider {
    constructor(options) {
        const apiKey = options.geminiApiKey;
        if (!apiKey) {
            throw new Error('Missing GOOGLE_API_KEY for Gemini provider.');
        }
        this.systemPrompt = options.systemPrompt;
        this.model = options.geminiModel;
        this.outputMode = options.geminiOutputMode || 'both';
        this.useVerticalFormat = options.useVerticalFormat ?? false;
        this.client = new genai_1.GoogleGenAI({ apiKey });
    }
    async send(params) {
        const { conversationData, botDisplayName, imageBlocks, otherSpeakers } = params;
        const { cachedBlocks, tail } = conversationData;
        const transcriptText = buildTranscriptFromData(cachedBlocks, tail);
        const guard = new FragmentationGuard(buildFragmentationRegex(otherSpeakers));
        const assistantName = botDisplayName || 'Assistant';
        // Configure response modalities based on output mode
        const responseModalities = this.outputMode === 'image'
            ? ['Image']
            : this.outputMode === 'text'
                ? ['Text']
                : ['Text', 'Image'];
        // Build interleaved content parts with images inline
        const contentParts = [];
        // Split transcript on image markers, keeping the markers
        const imagePattern = /(!\[image\]\([^\)]+\))/g;
        const segments = transcriptText.split(imagePattern);
        // Find all image markers and only fetch the last N
        const MAX_HISTORICAL_IMAGES = 4;
        const imageMarkerIndices = [];
        for (let i = 0; i < segments.length; i++) {
            if (segments[i].match(/^!\[image\]\([^\)]+\)$/)) {
                imageMarkerIndices.push(i);
            }
        }
        // Only fetch the last N images
        const imagesToFetch = new Set(imageMarkerIndices.slice(-MAX_HISTORICAL_IMAGES));
        const skippedCount = imageMarkerIndices.length - imagesToFetch.size;
        if (skippedCount > 0) {
            console.log(`[GeminiProvider] Skipping ${skippedCount} older images, fetching last ${imagesToFetch.size}`);
        }
        for (let i = 0; i < segments.length; i++) {
            const segment = segments[i];
            const imageMatch = segment.match(/^!\[image\]\(([^\)]+)\)$/);
            if (imageMatch) {
                if (imagesToFetch.has(i)) {
                    // This is one of the last N images - fetch it
                    const url = imageMatch[1];
                    try {
                        const response = await fetch(url);
                        if (response.ok) {
                            const buffer = await response.arrayBuffer();
                            const base64 = Buffer.from(buffer).toString('base64');
                            const mimeType = response.headers.get('content-type') || 'image/png';
                            contentParts.push({
                                inlineData: {
                                    mimeType,
                                    data: base64,
                                },
                            });
                        }
                        else {
                            // Failed to fetch, keep as text marker
                            contentParts.push({ text: segment });
                        }
                    }
                    catch (err) {
                        console.warn(`[GeminiProvider] Failed to fetch image ${url}:`, err);
                        // Keep as text marker on error
                        contentParts.push({ text: segment });
                    }
                }
                else {
                    // Skip older images, keep as text marker
                    contentParts.push({ text: segment });
                }
            }
            else if (segment) {
                // Regular text segment
                contentParts.push({ text: segment });
            }
        }
        // Add images from the current message attachments (if any)
        for (const imageBlock of imageBlocks) {
            // imageBlock.source.url is a data URL like "data:image/png;base64,..."
            const url = imageBlock.source.url;
            const match = url.match(/^data:([^;]+);base64,(.+)$/);
            if (match) {
                const mimeType = match[1];
                const base64Data = match[2];
                contentParts.push({
                    inlineData: {
                        mimeType,
                        data: base64Data,
                    },
                });
            }
        }
        // Build multi-turn conversation with model prefill
        const assistantPrefill = this.useVerticalFormat
            ? `[${assistantName}]`
            : `${assistantName}:`;
        const contents = [
            { role: 'user', parts: contentParts },
            { role: 'model', parts: [{ text: assistantPrefill }] },
        ];
        console.log(`[GeminiProvider] Sending ${contentParts.length} content parts to model`);
        const trimmedSystemPrompt = this.systemPrompt.trim();
        const response = await this.client.models.generateContent({
            model: this.model,
            contents,
            config: {
                responseModalities,
                systemInstruction: trimmedSystemPrompt || undefined,
            },
        });
        // Extract text and image from response parts
        let textContent = '';
        let imageData;
        const partCount = response.candidates?.[0]?.content?.parts?.length || 0;
        console.log(`[GeminiProvider] Received response with ${partCount} parts`);
        for (const part of response.candidates?.[0]?.content?.parts || []) {
            if (part.text) {
                console.log(`[GeminiProvider] Found text part: ${part.text.length} chars`);
                textContent += part.text;
            }
            if (part.inlineData) {
                // Convert base64 to Buffer
                const dataLength = part.inlineData.data?.length || 0;
                console.log(`[GeminiProvider] Found image part: ${dataLength} base64 chars, mime: ${part.inlineData.mimeType}`);
                imageData = Buffer.from(part.inlineData.data, 'base64');
            }
        }
        // Apply fragmentation guard to text (if any)
        if (textContent) {
            textContent = guard.inspect(textContent);
        }
        const finalText = textContent.trim() || (imageData ? '' : '(no response)');
        return {
            text: finalText,
            imageData,
            truncated: guard.truncated,
            truncatedSpeaker: guard.truncatedSpeaker,
        };
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
function buildFragmentationRegex(names) {
    if (names.length === 0)
        return null;
    const escapedNames = names.map(escapeRegExp).join('|');
    return new RegExp(`(?:^|[\\r\\n])\\s*(?:<?\\s*|\\[\\s*)?(${escapedNames})\\s*(?:\\]|>|:)`, 'gi');
}
function stripAssistantPrefillPrefix(text, botName, useVerticalFormat) {
    if (!text)
        return text;
    const flatPrefix = new RegExp(`^${escapeRegExp(botName)}:\\s*`, 'i');
    const verticalPrefix = new RegExp(`^\\[${escapeRegExp(botName)}\\]\\s*\\n?`, 'i');
    const cleaned = useVerticalFormat
        ? text.replace(verticalPrefix, '')
        : text.replace(flatPrefix, '');
    return cleaned.trimStart();
}
function isAbortError(error) {
    return error instanceof Error && error.name === 'AbortError';
}
