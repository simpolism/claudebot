import Anthropic from '@anthropic-ai/sdk';
import { APIUserAbortError as AnthropicAbortError } from '@anthropic-ai/sdk/error';
import OpenAI from 'openai';
import type {
  ChatCompletionChunk,
  ChatCompletionContentPart,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions/completions';
import { GoogleGenAI } from '@google/genai';
import {
  ClaudeContentBlock,
  ImageBlock,
  SimpleMessage,
  AIResponse,
  ConversationData,
} from './types';

type ProviderInitOptions = {
  provider: string;
  systemPrompt: string;
  prefillCommand: string;
  temperature: number;
  maxTokens: number;
  maxContextTokens: number;
  approxCharsPerToken: number;
  anthropicModel: string;
  openaiModel: string;
  openaiBaseURL: string;
  openaiApiKey: string;
  supportsImageBlocks: boolean;
  useUserAssistantPrefill: boolean;
  geminiModel: string;
  geminiApiKey: string;
  geminiOutputMode: 'text' | 'image' | 'both';
};

type ProviderRequest = {
  conversationData: ConversationData;
  botDisplayName: string;
  imageBlocks: ImageBlock[];
  otherSpeakers: string[];
};

export interface AIProvider {
  send(params: ProviderRequest): Promise<AIResponse>;
}

export function createAIProvider(options: ProviderInitOptions): AIProvider {
  const normalized = options.provider.toLowerCase();
  if (normalized === 'openai') {
    return new OpenAIProvider(options);
  }
  if (normalized === 'gemini') {
    return new GeminiProvider(options);
  }
  return new AnthropicProvider(options);
}

class AnthropicProvider implements AIProvider {
  private client: Anthropic;
  private systemPrompt: string;
  private prefillCommand?: string;
  private temperature: number;
  private maxTokens: number;
  private model: string;
  private maxContextTokens: number;
  private approxCharsPerToken: number;

  constructor(options: ProviderInitOptions) {
    this.systemPrompt = options.systemPrompt;
    this.prefillCommand = options.prefillCommand;
    this.temperature = options.temperature;
    this.maxTokens = options.maxTokens;
    this.model = options.anthropicModel;
    this.maxContextTokens = options.maxContextTokens;
    this.approxCharsPerToken = options.approxCharsPerToken;
    this.client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      defaultHeaders: {
        'anthropic-beta': 'prompt-caching-2024-07-31',
      },
    });
  }

  async send(params: ProviderRequest): Promise<AIResponse> {
    const { conversationData, botDisplayName, imageBlocks, otherSpeakers } = params;
    const { cachedBlocks, tail } = conversationData;
    const trimmedSystemPrompt = this.systemPrompt.trim();

    const systemBlocks = trimmedSystemPrompt
      ? [
          {
            type: 'text' as const,
            text: trimmedSystemPrompt,
            cache_control: {
              type: 'ephemeral' as const,
              ttl: '1h' as const,
            },
          },
        ]
      : undefined;

    // Use actual Discord usernames for fragmentation detection
    const guard = new FragmentationGuard(buildFragmentationRegex(otherSpeakers));

    const commandBlocks: ClaudeContentBlock[] = this.prefillCommand
      ? [
          {
            type: 'text',
            text: this.prefillCommand,
          },
        ]
      : [];

    // Build conversation blocks with stable caching
    const conversationBlocks: ClaudeContentBlock[] = [];

    // Cached blocks - these should hit the cache
    for (const blockText of cachedBlocks) {
      conversationBlocks.push({
        type: 'text',
        text: blockText + '\n',
        cache_control: {
          type: 'ephemeral' as const,
          ttl: '1h' as const,
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

    const messagesPayload: {
      role: 'user' | 'assistant';
      content: ClaudeContentBlock[];
    }[] = [];

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
      if (guard.truncated) return;
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
    } catch (err) {
      if (!(abortedByGuard && err instanceof AnthropicAbortError)) {
        throw err;
      }
    }

    return finalizeResponse(aggregatedText, guard);
  }
}

class OpenAIProvider implements AIProvider {
  private client: OpenAI;
  private systemPrompt: string;
  private prefillCommand: string;
  private temperature: number;
  private maxTokens: number;
  private model: string;
  private supportsImageBlocks: boolean;
  private useUserAssistantPrefill: boolean;

  constructor(options: ProviderInitOptions) {
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
    this.client = new OpenAI({
      apiKey,
      baseURL: options.openaiBaseURL,
    });
  }

  async send(params: ProviderRequest): Promise<AIResponse> {
    const { conversationData, botDisplayName, imageBlocks, otherSpeakers } = params;
    const { cachedBlocks, tail } = conversationData;
    const transcriptText = buildTranscriptFromData(cachedBlocks, tail);
    const guard = new FragmentationGuard(buildFragmentationRegex(otherSpeakers));
    const trimmedSystemPrompt = this.systemPrompt.trim();

    const messages: ChatCompletionMessageParam[] = [];
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

    if (this.supportsImageBlocks || this.useUserAssistantPrefill) {
      // When images are supported or user/assistant prefill is requested,
      // transcript must be in user content (for image_url blocks or Anthropic-style formatting)
      const userContent: ChatCompletionContentPart[] = [
        {
          type: 'text' as const,
          text: transcriptText,
        },
      ];
      if (imageBlocks.length > 0) {
        userContent.push(
          ...imageBlocks.map((block) => ({
            type: 'image_url' as const,
            image_url: {
              url: block.source.url,
            },
          })),
        );
      }

      messages.push({
        role: 'user',
        content: userContent,
      });
      messages.push({
        role: 'assistant',
        content: botDisplayName + ':',
      });
    } else {
      // Prefer transcript in assistant role with prefill appended
      // This gives the model more natural continuation behavior
      messages.push({
        role: 'assistant',
        content: transcriptText + `\n${botDisplayName}:`,
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
        if (guard.truncated) break;
        const deltaText = extractOpenAIDelta(chunk);
        if (!deltaText) continue;
        aggregatedText += deltaText;
        const checked = guard.inspect(aggregatedText);
        if (checked !== aggregatedText) {
          aggregatedText = checked;
          abortedByGuard = true;
          stream.controller.abort();
          break;
        }
      }
    } catch (err) {
      if (!(abortedByGuard && isAbortError(err))) {
        throw err;
      }
    }

    return finalizeResponse(aggregatedText, guard);
  }
}

class GeminiProvider implements AIProvider {
  private client: GoogleGenAI;
  private systemPrompt: string;
  private model: string;
  private outputMode: 'text' | 'image' | 'both';

  constructor(options: ProviderInitOptions) {
    const apiKey = options.geminiApiKey;
    if (!apiKey) {
      throw new Error('Missing GOOGLE_API_KEY for Gemini provider.');
    }
    this.systemPrompt = options.systemPrompt;
    this.model = options.geminiModel;
    this.outputMode = options.geminiOutputMode || 'both';
    this.client = new GoogleGenAI({ apiKey });
  }

  async send(params: ProviderRequest): Promise<AIResponse> {
    const { conversationData, botDisplayName, imageBlocks, otherSpeakers } = params;
    const { cachedBlocks, tail } = conversationData;
    const transcriptText = buildTranscriptFromData(cachedBlocks, tail);
    const guard = new FragmentationGuard(buildFragmentationRegex(otherSpeakers));

    // Configure response modalities based on output mode
    const responseModalities: Array<'Text' | 'Image'> =
      this.outputMode === 'image' ? ['Image'] : this.outputMode === 'text' ? ['Text'] : ['Text', 'Image'];

    // Build interleaved content parts with images inline
    const contentParts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [];

    // Split transcript on image markers, keeping the markers
    const imagePattern = /(!\[image\]\([^\)]+\))/g;
    const segments = transcriptText.split(imagePattern);

    // Find all image markers and only fetch the last N
    const MAX_HISTORICAL_IMAGES = 1;
    const imageMarkerIndices: number[] = [];
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
            } else {
              // Failed to fetch, keep as text marker
              contentParts.push({ text: segment });
            }
          } catch (err) {
            console.warn(`[GeminiProvider] Failed to fetch image ${url}:`, err);
            // Keep as text marker on error
            contentParts.push({ text: segment });
          }
        } else {
          // Skip older images, keep as text marker
          contentParts.push({ text: segment });
        }
      } else if (segment) {
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
    const contents = [
      { role: 'user' as const, parts: contentParts },
      { role: 'model' as const, parts: [{ text: `${botDisplayName}:` }] },
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
    let imageData: Buffer | undefined;

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
        imageData = Buffer.from(part.inlineData.data as string, 'base64');
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
  truncated = false;
  truncatedSpeaker?: string;
  private readonly regex: RegExp | null;

  constructor(regex: RegExp | null) {
    this.regex = regex;
  }

  inspect(currentText: string): string {
    if (!this.regex || this.truncated) {
      return currentText;
    }

    this.regex.lastIndex = 0;
    let match: RegExpExecArray | null;
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

function finalizeResponse(text: string, guard: FragmentationGuard): AIResponse {
  const trimmed = text.trim() || '(no response text)';
  if (guard.truncated && guard.truncatedSpeaker) {
    console.warn(
      `AI output truncated after detecting speaker "${guard.truncatedSpeaker}".`,
    );
  }
  return {
    text: trimmed,
    truncated: guard.truncated,
    truncatedSpeaker: guard.truncatedSpeaker,
  };
}

function buildTranscriptFromData(cachedBlocks: string[], tail: SimpleMessage[]): string {
  const parts: string[] = [...cachedBlocks];
  if (tail.length > 0) {
    parts.push(tail.map((m) => m.content).join('\n'));
  }
  return parts.join('\n').trim();
}

function extractOpenAIDelta(chunk: ChatCompletionChunk): string {
  if (!chunk?.choices?.length) return '';
  return chunk.choices
    .map((choice) => {
      const delta = choice.delta;
      const content = delta?.content as unknown;
      if (typeof content === 'string') {
        return content;
      }
      if (Array.isArray(content)) {
        return content
          .map((part: any) => {
            if (part == null) return '';
            if (typeof part === 'string') return part;
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

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildFragmentationRegex(names: string[]): RegExp | null {
  if (names.length === 0) return null;
  const escapedNames = names.map(escapeRegExp).join('|');
  return new RegExp(`(?:^|[\\r\\n])\\s*(?:<?\\s*)?(${escapedNames})\\s*>?:`, 'gi');
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
