import Anthropic from '@anthropic-ai/sdk';
import { APIUserAbortError as AnthropicAbortError } from '@anthropic-ai/sdk/error';
import OpenAI from 'openai';
import type {
  ChatCompletionChunk,
  ChatCompletionContentPart,
  ChatCompletionContentPartText,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions/completions';
import { ClaudeContentBlock, ImageBlock, SimpleMessage, AIResponse } from './types';

type ProviderInitOptions = {
  provider: string;
  systemPrompt: string;
  prefillCommand: string;
  temperature: number;
  maxTokens: number;
  anthropicModel: string;
  openaiModel: string;
  openaiBaseURL: string;
  openaiApiKey: string;
};

type ProviderRequest = {
  conversation: SimpleMessage[];
  botDisplayName: string;
  imageBlocks: ImageBlock[];
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

  constructor(options: ProviderInitOptions) {
    this.systemPrompt = options.systemPrompt;
    this.prefillCommand = options.prefillCommand;
    this.temperature = options.temperature;
    this.maxTokens = options.maxTokens;
    this.model = options.anthropicModel;
    this.client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      defaultHeaders: {
        'anthropic-beta': 'prompt-caching-2024-07-31',
      },
    });
  }

  async send(params: ProviderRequest): Promise<AIResponse> {
    const { conversation, botDisplayName, imageBlocks } = params;
    const transcriptText = buildTranscript(conversation);
    const trimmedSystemPrompt = this.systemPrompt.trim();

    const systemBlocks = trimmedSystemPrompt
      ? [
          {
            type: 'text' as const,
            text: trimmedSystemPrompt,
            cache_control: { type: 'ephemeral' as const },
          },
        ]
      : undefined;

    const trackedSpeakers = getTrackedUserNames(conversation, botDisplayName);
    const guard = new FragmentationGuard(buildFragmentationRegex(trackedSpeakers));

    const commandBlocks: ClaudeContentBlock[] = this.prefillCommand
      ? [
          {
            type: 'text',
            text: this.prefillCommand,
          },
        ]
      : [];

    const conversationBlocks: ClaudeContentBlock[] = [];
    if (transcriptText) {
      conversationBlocks.push({
        type: 'text',
        text: transcriptText,
      });
    }
    if (imageBlocks.length > 0) {
      conversationBlocks.push(...imageBlocks);
    }

    const messagesPayload: { role: 'user' | 'assistant'; content: ClaudeContentBlock[] }[] = [];

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
    this.client = new OpenAI({
      apiKey,
      baseURL: options.openaiBaseURL,
    });
  }

  async send(params: ProviderRequest): Promise<AIResponse> {
    const { conversation, botDisplayName, imageBlocks } = params;
    const transcriptText = buildTranscript(conversation);
    const trackedSpeakers = getTrackedUserNames(conversation, botDisplayName);
    const guard = new FragmentationGuard(buildFragmentationRegex(trackedSpeakers));
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
    const match = this.regex.exec(currentText);
    if (!match) return currentText;

    this.truncated = true;
    this.truncatedSpeaker = match[1]?.trim();
    return currentText.slice(0, match.index).trimEnd();
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

function buildTranscript(conversation: SimpleMessage[]): string {
  return conversation
    .map((msg) => msg.content)
    .join('\n')
    .trim();
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

function extractAuthorName(content: string): string | null {
  const colonIndex = content.indexOf(':');
  if (colonIndex === -1) {
    return null;
  }
  return content.slice(0, colonIndex).trim();
}

function getTrackedUserNames(
  conversation: SimpleMessage[],
  botDisplayName: string,
): string[] {
  const normalizedBot = botDisplayName.toLowerCase();
  const names = new Set<string>();
  conversation.forEach((message) => {
    if (message.role !== 'user') return;
    const authorName = extractAuthorName(message.content);
    if (!authorName) return;
    if (authorName.toLowerCase() === normalizedBot) return;
    names.add(authorName);
  });
  return [...names];
}

function buildFragmentationRegex(names: string[]): RegExp | null {
  if (names.length === 0) return null;
  const escapedNames = names.map(escapeRegExp).join('|');
  return new RegExp(
    `(?:^|[\\r\\n])\\s*(?:<?\\s*)?(${escapedNames})\\s*>?:`,
    'i',
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
