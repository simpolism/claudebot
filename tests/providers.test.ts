import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ChatCompletionChunk } from 'openai/resources/chat/completions';

const createMock = vi.fn();
vi.mock('openai', () => {
  return {
    default: vi.fn(() => ({
      chat: {
        completions: {
          create: createMock,
        },
      },
    })),
  };
});

const fakeChunk: ChatCompletionChunk = {
  id: 'chunk',
  object: 'chat.completion.chunk',
  created: Date.now(),
  model: 'test',
  choices: [
    {
      index: 0,
      finish_reason: null,
      delta: {
        content: 'Hello there',
      },
    },
  ],
};

const fakeStream = {
  controller: {
    abort: () => {},
  },
  async *[Symbol.asyncIterator]() {
    yield fakeChunk;
  },
};

describe('OpenAIProvider message layout', () => {
  beforeEach(() => {
    createMock.mockReset();
    createMock.mockResolvedValue(fakeStream);
  });

  it('sends assistant transcript when images are disabled', async () => {
    const { createAIProvider } = await import('../src/providers');
    const provider = createAIProvider({
      provider: 'openai',
      systemPrompt: '',
      prefillCommand: '',
      temperature: 0,
      maxTokens: 256,
      maxContextTokens: 1000,
      approxCharsPerToken: 4,
      anthropicModel: '',
      openaiModel: 'test-model',
      openaiBaseURL: '',
      openaiApiKey: 'key',
      supportsImageBlocks: false,
      useOpenAIEndpointOptimizations: false,
    });

    await provider.send({
      conversationData: {
        cachedBlocks: ['Alice: Hi'],
        tail: [],
      },
      botDisplayName: 'Bot',
      imageBlocks: [],
      otherSpeakers: ['Alice'],
    });

    const messages = createMock.mock.calls[0][0].messages;
    expect(messages[messages.length - 1]).toEqual({
      role: 'assistant',
      content: 'Alice: Hi\nBot:',
    });
    const payload = createMock.mock.calls[0][0];
    expect(payload.max_tokens).toBe(256);
    expect(payload.max_completion_tokens).toBeUndefined();
  });

  it('chunks cached blocks when OpenAI prompt caching flag is set', async () => {
    const { createAIProvider } = await import('../src/providers');
    const provider = createAIProvider({
      provider: 'openai',
      systemPrompt: '',
      prefillCommand: '',
      temperature: 0,
      maxTokens: 256,
      maxContextTokens: 1000,
      approxCharsPerToken: 4,
      anthropicModel: '',
      openaiModel: 'test-model',
      openaiBaseURL: '',
      openaiApiKey: 'key',
      supportsImageBlocks: true,
      useOpenAIEndpointOptimizations: true,
    });

    await provider.send({
      conversationData: {
        cachedBlocks: ['Alice: cached line', 'Bob: second block'],
        tail: [{ role: 'user', content: 'Carol: latest' }],
      },
      botDisplayName: 'Bot',
      imageBlocks: [
        {
          type: 'image',
          source: { type: 'url', url: 'http://example/image.png' },
        },
      ],
      otherSpeakers: ['Alice', 'Bob', 'Carol'],
    });

    const messages = createMock.mock.calls[0][0].messages;
    expect(messages[0]).toEqual({
      role: 'user',
      content: 'Alice: cached line\n',
    });
    expect(messages[1]).toEqual({
      role: 'user',
      content: 'Bob: second block\n',
    });
    expect(messages[2]).toMatchObject({
      role: 'user',
      content: [
        { type: 'text', text: 'Carol: latest' },
        {
          type: 'image_url',
          image_url: { url: 'http://example/image.png' },
        },
      ],
    });
    expect(messages[3]).toEqual({
      role: 'assistant',
      content: 'Bot:',
    });
    const payload = createMock.mock.calls[0][0];
    expect(payload.max_completion_tokens).toBe(256);
    expect(payload.max_tokens).toBeUndefined();
  });

  it('strips echoed assistant prefill when caching flag is set', async () => {
    const streamWithPrefill = {
      controller: {
        abort: () => {},
      },
      async *[Symbol.asyncIterator]() {
        yield {
          ...fakeChunk,
          choices: [
            {
              index: 0,
              finish_reason: null,
              delta: {
                content: 'Bot:\nHello world',
              },
            },
          ],
        };
      },
    };
    createMock.mockResolvedValue(streamWithPrefill);

    const { createAIProvider } = await import('../src/providers');
    const provider = createAIProvider({
      provider: 'openai',
      systemPrompt: '',
      prefillCommand: '',
      temperature: 0,
      maxTokens: 123,
      maxContextTokens: 1000,
      approxCharsPerToken: 4,
      anthropicModel: '',
      openaiModel: 'test-model',
      openaiBaseURL: '',
      openaiApiKey: 'key',
      supportsImageBlocks: false,
      useOpenAIEndpointOptimizations: true,
    });

    const response = await provider.send({
      conversationData: {
        cachedBlocks: [],
        tail: [],
      },
      botDisplayName: 'Bot',
      imageBlocks: [],
      otherSpeakers: [],
    });

    expect(response.text).toBe('Hello world');
  });

  it('sends user transcript when images are enabled', async () => {
    const { createAIProvider } = await import('../src/providers');
    const provider = createAIProvider({
      provider: 'openai',
      systemPrompt: '',
      prefillCommand: '',
      temperature: 0,
      maxTokens: 256,
      maxContextTokens: 1000,
      approxCharsPerToken: 4,
      anthropicModel: '',
      openaiModel: 'test-model',
      openaiBaseURL: '',
      openaiApiKey: 'key',
      supportsImageBlocks: true,
      useOpenAIEndpointOptimizations: false,
    });

    await provider.send({
      conversationData: {
        cachedBlocks: ['Alice: Hi'],
        tail: [],
      },
      botDisplayName: 'Bot',
      imageBlocks: [
        {
          type: 'image',
          source: { type: 'url', url: 'http://example/image.png' },
        },
      ],
      otherSpeakers: ['Alice'],
    });

    const messages = createMock.mock.calls[0][0].messages;
    expect(messages[messages.length - 2]).toMatchObject({
      role: 'user',
      content: [
        { type: 'text', text: 'Alice: Hi' },
        {
          type: 'image_url',
          image_url: { url: 'http://example/image.png' },
        },
      ],
    });
    expect(messages[messages.length - 1]).toEqual({
      role: 'assistant',
      content: 'Bot:',
    });
  });

  it('truncates when completion restarts the bot speaker mid-response', async () => {
    const abortSpy = vi.fn();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    createMock.mockResolvedValue({
      controller: {
        abort: abortSpy,
      },
      async *[Symbol.asyncIterator]() {
        yield {
          ...fakeChunk,
          choices: [
            {
              index: 0,
              finish_reason: null,
              delta: {
                content: 'First thought\nBot: continuing again',
              },
            },
          ],
        };
      },
    });

    const { createAIProvider } = await import('../src/providers');
    const provider = createAIProvider({
      provider: 'openai',
      systemPrompt: '',
      prefillCommand: '',
      temperature: 0,
      maxTokens: 256,
      maxContextTokens: 1000,
      approxCharsPerToken: 4,
      anthropicModel: '',
      openaiModel: 'test-model',
      openaiBaseURL: '',
      openaiApiKey: 'key',
      supportsImageBlocks: false,
      useOpenAIEndpointOptimizations: false,
    });

    try {
      const response = await provider.send({
        conversationData: {
          cachedBlocks: [],
          tail: [],
        },
        botDisplayName: 'Bot',
        imageBlocks: [],
        otherSpeakers: ['Bot'],
      });

      expect(response.text).toBe('First thought');
      expect(response.truncated).toBe(true);
      expect(response.truncatedSpeaker).toBe('Bot');
      expect(abortSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
