import Anthropic from '@anthropic-ai/sdk';
import { APIUserAbortError as AnthropicAbortError } from '@anthropic-ai/sdk/error';
import OpenAI from 'openai';
import type {
  ChatCompletionChunk,
  ChatCompletionContentPart,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions/completions';
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

    const assistantText = transcriptText + `\n\n${botDisplayName}:`;
    if (this.supportsImageBlocks) {
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
      messages.push({
        role: 'assistant',
        content: assistantText,
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
