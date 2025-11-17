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
  blocks: Array<{
    text?: string;
    tokenCount: number;
    firstMessageId: string;
    lastMessageId: string;
  }>;
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

function createMockChannel(messages: MockMessage[]): Message['channel'] {
  const messageMap = new Map(
    messages.map((m) => [
      m.id,
      {
        id: m.id,
        content: m.content,
        author: { id: m.authorId, username: m.authorId, tag: m.authorId },
        attachments: [],
        mentions: {
          users: new Map(),
        },
      },
    ]),
  );

  return {
    id: 'channel',
    type: ChannelType.GuildText,
    isTextBased: () => true,
    parent: null,
    parentId: null,
    messages: {
      async fetch(idOrOptions?: any) {
        if (typeof idOrOptions === 'string') {
          return messageMap.get(idOrOptions) as unknown as Message;
        }
        const after = idOrOptions?.after;
        const before = idOrOptions?.before;
        const limit = idOrOptions?.limit ?? 100;

        let result = [...messageMap.values()];

        if (after) {
          // Fetch messages AFTER the given ID (going forward in time)
          result = result.filter((msg) => BigInt(msg.id) > BigInt(after));
          // Sort chronologically and take first `limit`
          result = result.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
          result = result.slice(0, limit);
        } else if (before) {
          // Fetch messages BEFORE the given ID (going backward in time)
          result = result.filter((msg) => BigInt(msg.id) < BigInt(before));
          // Sort chronologically and take LAST `limit` (most recent before cursor)
          result = result.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
          result = result.slice(-limit);
        } else {
          // No cursor: Discord returns MOST RECENT messages (this is key!)
          // Sort chronologically and take LAST `limit`
          result = result.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
          result = result.slice(-limit);
        }

        const collection = new Map(result.map((msg) => [msg.id, msg]));
        (collection as any).last = () => result[result.length - 1];
        return collection as any;
      },
    },
  } as Message['channel'];
}

describe('fetchMessagesAfter pagination', () => {
  it('fetches all available history up to token budget on empty cache', async () => {
    // Bug: When starting with no cache, the function only fetches 100 messages
    // because it uses `after: undefined` which returns newest messages,
    // then tries to fetch `after: <newest_id>` which returns nothing.

    // Create 250 messages (more than one fetch batch of 100)
    const allMessages: MockMessage[] = [];
    for (let i = 1; i <= 250; i++) {
      allMessages.push({
        id: String(i),
        content: `Message ${i}`,
        authorId: i % 2 === 0 ? 'alice' : 'bob',
      });
    }

    const channel = createMockChannel(allMessages);
    const { cacheAccess } = createCacheAccess({
      channel: { blocks: [], lastId: null },
    });

    const context = getContextModule();
    // With 250 messages averaging ~20 chars each = ~5 tokens per message
    // Budget of 2000 tokens should fetch ~400 messages worth, so all 250
    const conversation = await context.buildConversationContext({
      channel,
      maxContextTokens: 2000,
      client: fakeClient,
      botDisplayName: 'UnitTester',
      cacheAccess,
    });

    // Should have fetched significantly more than 100 messages
    expect(conversation.tail.length).toBeGreaterThan(100);
    // Should have fetched all 250 messages (well within budget)
    expect(conversation.tail.length).toBe(250);
    // Should be in chronological order (oldest first)
    expect(conversation.tail[0]?.content).toContain('Message 1');
    expect(conversation.tail[249]?.content).toContain('Message 250');
  });

  it('continues fetching incrementally after initial load', async () => {
    // First load gets history, second load gets only new messages
    const initialMessages: MockMessage[] = [];
    for (let i = 1; i <= 50; i++) {
      initialMessages.push({
        id: String(i),
        content: `Message ${i}`,
        authorId: 'alice',
      });
    }

    const channel = createMockChannel(initialMessages);
    const { cacheAccess } = createCacheAccess({
      channel: { blocks: [], lastId: null },
    });

    const context = getContextModule();

    // First fetch - should get all 50 messages
    const first = await context.buildConversationContext({
      channel,
      maxContextTokens: 10000,
      client: fakeClient,
      botDisplayName: 'UnitTester',
      cacheAccess,
    });
    expect(first.tail.length).toBe(50);

    // Add new messages
    const updatedMessages = [
      ...initialMessages,
      { id: '51', content: 'New message 51', authorId: 'bob' },
      { id: '52', content: 'New message 52', authorId: 'alice' },
    ];
    const updatedChannel = createMockChannel(updatedMessages);

    // Second fetch - should get the 2 new messages appended to tail
    const second = await context.buildConversationContext({
      channel: updatedChannel,
      maxContextTokens: 10000,
      client: fakeClient,
      botDisplayName: 'UnitTester',
      cacheAccess,
    });
    expect(second.tail.length).toBe(52);
    expect(second.tail[50]?.content).toContain('New message 51');
    expect(second.tail[51]?.content).toContain('New message 52');
  });
});

describe('buildConversationContext', () => {
  it('hydrates cached block text from metadata-only entries', async () => {
    const channelMessages: MockMessage[] = [
      { id: '90', content: 'Alice says hi', authorId: 'alice' },
      { id: '95', content: 'Bob replies', authorId: 'bob' },
    ];
    const channel = createMockChannel(channelMessages);
    const metadataBlock = {
      text: undefined as unknown as string,
      tokenCount: 100,
      firstMessageId: '90',
      lastMessageId: '95',
    };
    const { cacheAccess } = createCacheAccess({
      channel: {
        blocks: [metadataBlock],
        lastId: '95',
      },
    });

    const context = getContextModule();
    const conversation = await context.buildConversationContext({
      channel,
      maxContextTokens: 1000,
      client: fakeClient,
      botDisplayName: 'UnitTester',
      cacheAccess,
      fetchMessages: async () => [],
    });

    expect(metadataBlock.text).toContain('Alice');
    expect(conversation.cachedBlocks[0]).toContain('Alice says hi');
  });

  it('fetches new tail messages using last tail id as cursor', async () => {
    const channel = createMockChannel([]);
    const { cacheAccess } = createCacheAccess({
      channel: {
        blocks: [],
        lastId: null,
      },
    });

    const recordedAfterIds: Array<string | null> = [];
    const fetchMessages = vi
      .fn()
      .mockImplementationOnce(
        async (_channel: Message['channel'], afterId: string | null) => {
          recordedAfterIds.push(afterId);
          return [
            {
              id: '300',
              formattedText: 'User: first tail',
              tokens: 10,
              role: 'user',
            },
          ];
        },
      )
      .mockImplementationOnce(
        async (_channel: Message['channel'], afterId: string | null) => {
          recordedAfterIds.push(afterId);
          return [
            {
              id: '301',
              formattedText: 'User: second tail',
              tokens: 10,
              role: 'user',
            },
          ];
        },
      );

    const context = getContextModule();
    await context.buildConversationContext({
      channel,
      maxContextTokens: 1000,
      client: fakeClient,
      botDisplayName: 'UnitTester',
      cacheAccess,
      fetchMessages: fetchMessages as any,
    });

    await context.buildConversationContext({
      channel,
      maxContextTokens: 1000,
      client: fakeClient,
      botDisplayName: 'UnitTester',
      cacheAccess,
      fetchMessages: fetchMessages as any,
    });

    expect(recordedAfterIds[0]).toBeNull();
    expect(recordedAfterIds[1]).toBe('300');
  });

  it('fetches a guaranteed tail even when cached blocks fill the budget', async () => {
    const channelId = 'channel';
    const existingBlockText = 'Earlier cached transcript';
    const { cacheAccess, updateCalls } = createCacheAccess({
      [channelId]: {
        blocks: [
          {
            text: existingBlockText,
            tokenCount: 100000,
            firstMessageId: '150',
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
    const maxContextTokens = 100000;
    const conversation = await context.buildConversationContext({
      channel: baseChannel({ id: channelId }),
      maxContextTokens,
      client: fakeClient,
      botDisplayName: 'UnitTester',
      cacheAccess,
      fetchMessages,
    });

    expect(capturedBudget).toBe(maxContextTokens);
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
            firstMessageId: '10',
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
            firstMessageId: '90',
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
type MockMessage = {
  id: string;
  content: string;
  authorId: string;
};
