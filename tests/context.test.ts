process.env.HAIKU_DISCORD_TOKEN ||= 'test-token';
process.env.KIMI_DISCORD_TOKEN ||= 'test-token';
process.env.GROQ_API_KEY ||= 'test-key';
process.env.MAIN_CHANNEL_IDS ||= '';

import { describe, expect, it, vi, afterAll, afterEach, beforeAll } from 'vitest';
import { type Client, type Message } from 'discord.js';

type MockMessage = {
  id: string;
  content: string;
  authorId: string;
};

function createMockDiscordMessage(msg: MockMessage, channelId: string): Message {
  return {
    id: msg.id,
    content: msg.content,
    channel: { id: channelId },
    author: {
      id: msg.authorId,
      username: msg.authorId,
      globalName: msg.authorId,
      tag: msg.authorId,
    },
    createdTimestamp: parseInt(msg.id, 10) * 1000,
    attachments: new Map(),
    mentions: { users: new Map() },
  } as unknown as Message;
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
    isTextBased: () => true,
    ...overrides,
  } as Message['channel'];
}

const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
afterAll(() => {
  consoleSpy.mockRestore();
});

type StoreModule = typeof import('../src/message-store');
type ContextModule = typeof import('../src/context');

let storeModule: StoreModule | null = null;
let contextModule: ContextModule | null = null;

beforeAll(async () => {
  storeModule = await import('../src/message-store');
  contextModule = await import('../src/context');
});

function getStoreModule(): StoreModule {
  if (!storeModule) throw new Error('store module not loaded');
  return storeModule;
}

function getContextModule(): ContextModule {
  if (!contextModule) throw new Error('context module not loaded');
  return contextModule;
}

afterEach(() => {
  getStoreModule().clearAll();
});

describe('message-store', () => {
  it('appends messages to in-memory storage', () => {
    const store = getStoreModule();
    const msg1 = createMockDiscordMessage({ id: '1', content: 'Hello', authorId: 'alice' }, 'chan');
    const msg2 = createMockDiscordMessage({ id: '2', content: 'World', authorId: 'bob' }, 'chan');

    store.appendMessage(msg1);
    store.appendMessage(msg2);

    const messages = store.getChannelMessages('chan');
    expect(messages).toHaveLength(2);
    expect(messages[0]?.content).toBe('Hello');
    expect(messages[1]?.content).toBe('World');
  });

  it('freezes blocks when token threshold reached', () => {
    const store = getStoreModule();

    // Create enough messages to exceed 30k tokens (~120k chars at 4 chars/token)
    const channelId = 'test-channel';
    for (let i = 1; i <= 100; i++) {
      const longContent = 'x'.repeat(1500); // ~375 tokens per message = ~37.5k tokens total
      const msg = createMockDiscordMessage(
        { id: String(i), content: longContent, authorId: 'alice' },
        channelId,
      );
      store.appendMessage(msg);
    }

    const boundaries = store.getBlockBoundaries(channelId);
    expect(boundaries.length).toBeGreaterThan(0);
    expect(boundaries[0]?.tokenCount).toBeGreaterThanOrEqual(30000);
  });

  it('formats messages with bot name when author is bot', () => {
    const store = getStoreModule();
    const channelId = 'chan';

    // Bot message
    const botMsg = createMockDiscordMessage(
      { id: '1', content: 'I am bot', authorId: 'bot-user' },
      channelId,
    );
    store.appendMessage(botMsg);

    // User message
    const userMsg = createMockDiscordMessage(
      { id: '2', content: 'I am user', authorId: 'alice' },
      channelId,
    );
    store.appendMessage(userMsg);

    const result = store.getContext(channelId, 10000, 'bot-user', 'UnitTester');

    // Bot message should use botDisplayName, not authorId
    expect(result.tail[0]).toBe('UnitTester: I am bot');
    expect(result.tail[1]).toBe('alice: I am user');
  });

  it('trims oldest messages when over budget', () => {
    const store = getStoreModule();
    const channelId = 'chan';

    // Add 10 messages with longer content
    for (let i = 1; i <= 10; i++) {
      const msg = createMockDiscordMessage(
        { id: String(i), content: `This is a longer message number ${i} with more content`, authorId: 'alice' },
        channelId,
      );
      store.appendMessage(msg);
    }

    // Request with budget that fits ~3-4 messages (each ~20 tokens)
    const result = store.getContext(channelId, 60, 'bot-user', 'UnitTester');

    // Should have fewer than 10 messages
    expect(result.tail.length).toBeLessThan(10);
    expect(result.tail.length).toBeGreaterThan(0);
    // Should keep newest messages
    const lastTail = result.tail[result.tail.length - 1];
    expect(lastTail).toContain('message number 10');
  });
});

describe('buildConversationContext', () => {
  it('builds context from in-memory messages', async () => {
    const store = getStoreModule();
    const context = getContextModule();

    const channelId = 'channel';
    const msg1 = createMockDiscordMessage(
      { id: '1', content: 'Hello from alice', authorId: 'alice' },
      channelId,
    );
    const msg2 = createMockDiscordMessage(
      { id: '2', content: 'Hello from bob', authorId: 'bob' },
      channelId,
    );

    store.appendMessage(msg1);
    store.appendMessage(msg2);

    const result = await context.buildConversationContext({
      channel: baseChannel({ id: channelId }),
      maxContextTokens: 10000,
      client: fakeClient,
      botDisplayName: 'UnitTester',
    });

    expect(result.tail).toHaveLength(2);
    expect(result.tail[0]?.content).toContain('alice: Hello from alice');
    expect(result.tail[1]?.content).toContain('bob: Hello from bob');
  });

  it('returns empty context for non-text channel', async () => {
    const context = getContextModule();

    const nonTextChannel = {
      id: 'voice-channel',
      isTextBased: () => false,
    } as unknown as Message['channel'];

    const result = await context.buildConversationContext({
      channel: nonTextChannel,
      maxContextTokens: 10000,
      client: fakeClient,
      botDisplayName: 'UnitTester',
    });

    expect(result.cachedBlocks).toEqual([]);
    expect(result.tail).toEqual([]);
  });

  it('assigns correct role based on bot authorship', async () => {
    const store = getStoreModule();
    const context = getContextModule();

    const channelId = 'channel';

    // User message
    const userMsg = createMockDiscordMessage(
      { id: '1', content: 'User says hi', authorId: 'alice' },
      channelId,
    );
    store.appendMessage(userMsg);

    // Bot message (author ID matches bot)
    const botMsg = createMockDiscordMessage(
      { id: '2', content: 'Bot replies', authorId: 'bot-user' },
      channelId,
    );
    store.appendMessage(botMsg);

    const result = await context.buildConversationContext({
      channel: baseChannel({ id: channelId }),
      maxContextTokens: 10000,
      client: fakeClient,
      botDisplayName: 'UnitTester',
    });

    expect(result.tail[0]?.role).toBe('user');
    expect(result.tail[1]?.role).toBe('assistant');
  });
});
