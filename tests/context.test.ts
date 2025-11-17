process.env.HAIKU_DISCORD_TOKEN ||= 'test-token';
process.env.KIMI_DISCORD_TOKEN ||= 'test-token';
process.env.GROQ_API_KEY ||= 'test-key';
process.env.MAIN_CHANNEL_IDS ||= '';

import { describe, expect, it, vi, afterAll, afterEach, beforeAll } from 'vitest';
import { ChannelType, type Client, type Message } from 'discord.js';

type TestFetchedMessage = {
  id: string;
  formattedText: string;
  tokens: number;
  role: 'user' | 'assistant';
};

type CacheRecord = {
  blocks: Array<{ text: string; tokenCount: number; lastMessageId: string }>;
  lastId: string | null;
};

function createCacheAccess(initial: Record<string, CacheRecord>) {
  const store = new Map<string, CacheRecord>(Object.entries(initial));
  const updateCalls: Array<{ channelId: string; messageIds: string[] }> = [];

  return {
    cacheAccess: {
      getCachedBlocks: (channelId: string) => store.get(channelId)?.blocks ?? [],
      getLastCachedMessageId: (channelId: string) => store.get(channelId)?.lastId ?? null,
      updateCache: (
        channelId: string,
        messages: Array<{ id: string; formattedText: string; tokens: number }>,
      ) => {
        updateCalls.push({
          channelId,
          messageIds: messages.map((msg) => msg.id),
        });
      },
    },
    updateCalls,
  };
}

const fakeClient = {
  user: {
    id: 'bot-user',
    username: 'UnitTester',
    tag: 'UnitTester#0001',
  },
} as unknown as Client;

function baseChannel(overrides: Partial<any> = {}) {
  return {
    id: 'channel',
    type: ChannelType.GuildText,
    isTextBased: () => true,
    parent: null,
    parentId: null,
    ...overrides,
  } as Message['channel'];
}

const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
afterAll(() => {
  consoleSpy.mockRestore();
});

type ContextModule = typeof import('../src/context');
let contextModule: ContextModule | null = null;

beforeAll(async () => {
  contextModule = await import('../src/context');
});

function getContextModule(): ContextModule {
  if (!contextModule) {
    throw new Error('context module not loaded');
  }
  return contextModule;
}

afterEach(() => {
  getContextModule().clearTailCache();
});

describe('buildConversationContext', () => {
  it('fetches a guaranteed tail even when cached blocks fill the budget', async () => {
    const channelId = 'channel';
    const existingBlockText = 'Earlier cached transcript';
    const { cacheAccess, updateCalls } = createCacheAccess({
      [channelId]: {
        blocks: [
          {
            text: existingBlockText,
            tokenCount: 100000,
            lastMessageId: '200',
          },
        ],
        lastId: '200',
      },
    });

    let capturedBudget = 0;
    const fetchMessages = async (
      _channel: any,
      _lastId: string | null,
      tokenBudget: number,
    ): Promise<TestFetchedMessage[]> => {
      capturedBudget = tokenBudget;
      return [
        {
          id: '250',
          formattedText: 'Alice: Hello again',
          tokens: 12,
          role: 'user',
        },
      ];
    };

    const context = getContextModule();
    const conversation = await context.buildConversationContext({
      channel: baseChannel({ id: channelId }),
      maxContextTokens: 100000,
      client: fakeClient,
      botDisplayName: 'UnitTester',
      cacheAccess,
      fetchMessages,
    });

    expect(capturedBudget).toBe(context.GUARANTEED_TAIL_TOKENS);
    expect(conversation.tail).toHaveLength(1);
    expect(conversation.tail[0]?.content).toBe('Alice: Hello again');
    expect(conversation.cachedBlocks).toContain(existingBlockText);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]?.messageIds).toEqual(['250']);
  });

  it('pulls parent cached context into thread conversations', async () => {
    const parentId = 'parent-channel';
    const threadId = 'thread-123';
    const parentBlockText = 'Parent: Opening context';
    const { cacheAccess } = createCacheAccess({
      [parentId]: {
        blocks: [
          {
            text: parentBlockText,
            tokenCount: 1500,
            lastMessageId: '20',
          },
        ],
        lastId: '20',
      },
      [threadId]: {
        blocks: [],
        lastId: null,
      },
    });

    const parentChannel = baseChannel({ id: parentId });
    const threadChannel = baseChannel({
      id: threadId,
      type: ChannelType.PublicThread,
      parent: parentChannel,
      parentId,
    });

    const fetchMessages = async (): Promise<TestFetchedMessage[]> => [
      {
        id: '30',
        formattedText: 'Alice: Thread message',
        tokens: 10,
        role: 'user',
      },
      {
        id: '31',
        formattedText: 'Bob: Follow-up',
        tokens: 10,
        role: 'user',
      },
    ];

    const context = getContextModule();
    const conversation = await context.buildConversationContext({
      channel: threadChannel,
      maxContextTokens: 100000,
      client: fakeClient,
      botDisplayName: 'UnitTester',
      cacheAccess,
      fetchMessages,
    });

    expect(conversation.cachedBlocks).toEqual([parentBlockText]);
    expect(conversation.tail).toHaveLength(2);
    expect(conversation.tail.map((msg) => msg.content)).toEqual([
      'Alice: Thread message',
      'Bob: Follow-up',
    ]);
  });

  it('preserves byte-identical cached blocks across multiple turns', async () => {
    const channelId = 'channel';
    const existingBlockText = 'Transcript Block\nLine Two';
    const { cacheAccess } = createCacheAccess({
      [channelId]: {
        blocks: [
          {
            text: existingBlockText,
            tokenCount: 5000,
            lastMessageId: '100',
          },
        ],
        lastId: '100',
      },
    });

    const firstFetchMessages: TestFetchedMessage[] = [
      {
        id: '105',
        formattedText: 'Alice: Follow-up',
        tokens: 12,
        role: 'user',
      },
    ];

    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(firstFetchMessages)
      .mockResolvedValueOnce([
        {
          id: '110',
          formattedText: 'Alice: Second turn',
          tokens: 12,
          role: 'user',
        },
      ]);

    const context = getContextModule();

    const firstConversation = await context.buildConversationContext({
      channel: baseChannel({ id: channelId }),
      maxContextTokens: 100000,
      client: fakeClient,
      botDisplayName: 'UnitTester',
      cacheAccess,
      fetchMessages: fetchSpy,
    });

    expect(firstConversation.cachedBlocks).toContain(existingBlockText);
    expect(firstConversation.tail).toHaveLength(1);

    const secondConversation = await context.buildConversationContext({
      channel: baseChannel({ id: channelId }),
      maxContextTokens: 100000,
      client: fakeClient,
      botDisplayName: 'UnitTester',
      cacheAccess,
      fetchMessages: fetchSpy,
    });

    expect(secondConversation.cachedBlocks).toContain(existingBlockText);
    expect(
      secondConversation.cachedBlocks.find((block) => block === existingBlockText),
    ).toBe(existingBlockText);
    expect(secondConversation.tail).toHaveLength(2);
  });
});
