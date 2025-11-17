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
    });

    await provider.send({
      conversationData: {
        cachedBlocks: ['Alice: Hi'],
        tail: [],
      },
      botDisplayName: 'Bot',
      imageBlocks: [],
    });

    const messages = createMock.mock.calls[0][0].messages;
    expect(messages[messages.length - 1]).toEqual({
      role: 'assistant',
      content: 'Alice: Hi\n\nBot:',
    });
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
});
