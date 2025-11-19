process.env.HAIKU_DISCORD_TOKEN ||= 'test-token';
process.env.KIMI_DISCORD_TOKEN ||= 'test-token';
process.env.GROQ_API_KEY ||= 'test-key';
process.env.MAIN_CHANNEL_IDS ||= '';
process.env.TEST_DB_PATH ||= 'test-context-claude-cache.sqlite';

import { describe, expect, it, vi, afterAll, afterEach, beforeAll, beforeEach } from 'vitest';
import { type Client, type Message } from 'discord.js';
import * as fs from 'fs';
import * as path from 'path';

type MockMessage = {
  id: string;
  content: string;
  authorId: string;
  authorName?: string;
  mentions?: Array<{
    id: string;
    username?: string;
    globalName?: string;
    tag?: string;
  }>;
};

const TEST_DB_PATH = path.join(process.cwd(), process.env.TEST_DB_PATH);

function createMockDiscordMessage(msg: MockMessage, channelId: string): Message {
  const displayName = msg.authorName ?? msg.authorId;
  const mentionEntries =
    msg.mentions?.map((mention) => {
      const mentionName =
        mention.username ?? mention.globalName ?? mention.tag ?? mention.id;
      return [
        mention.id,
        {
          id: mention.id,
          username: mention.username ?? mentionName,
          globalName: mention.globalName ?? mentionName,
          tag: mention.tag ?? `${mentionName}#0001`,
        },
      ];
    }) ?? [];
  const mentionUsers = new Map(mentionEntries);
  return {
    id: msg.id,
    content: msg.content,
    channel: {
      id: channelId,
      isThread: () => false,
      parentId: null,
      isTextBased: () => true,
    },
    author: {
      id: msg.authorId,
      username: displayName,
      globalName: displayName,
      tag: `${displayName}#0001`,
    },
    createdTimestamp: parseInt(msg.id, 10) * 1000,
    attachments: new Map(),
    mentions: { users: mentionUsers },
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
    isThread: () => false,
    ...overrides,
  } as Message['channel'];
}

const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

type StoreModule = typeof import('../src/message-store');
type ContextModule = typeof import('../src/context');
type DatabaseModule = typeof import('../src/database');

let storeModule: StoreModule | null = null;
let contextModule: ContextModule | null = null;
let databaseModule: DatabaseModule | null = null;

beforeAll(async () => {
  if (fs.existsSync(TEST_DB_PATH)) {
    fs.rmSync(TEST_DB_PATH);
  }
  databaseModule = await import('../src/database');
  databaseModule.initializeDatabase();
  storeModule = await import('../src/message-store');
  contextModule = await import('../src/context');
});

afterAll(() => {
  consoleSpy.mockRestore();
  databaseModule?.closeDatabase();
  if (fs.existsSync(TEST_DB_PATH)) {
    fs.rmSync(TEST_DB_PATH);
  }
});

function getStoreModule(): StoreModule {
  if (!storeModule) throw new Error('store module not loaded');
  return storeModule;
}

function getContextModule(): ContextModule {
  if (!contextModule) throw new Error('context module not loaded');
  return contextModule;
}

beforeEach(() => {
  if (databaseModule) {
    databaseModule.closeDatabase();
  }
  if (fs.existsSync(TEST_DB_PATH)) {
    fs.rmSync(TEST_DB_PATH);
  }
  databaseModule?.initializeDatabase();
  getStoreModule().clearAll();
});

afterEach(() => {
  getStoreModule().clearAll();
});

describe('message-store', () => {
  it('appends messages to in-memory storage', () => {
    const store = getStoreModule();
    const msg1 = createMockDiscordMessage(
      { id: '1', content: 'Hello', authorId: 'alice' },
      'chan',
    );
    const msg2 = createMockDiscordMessage(
      { id: '2', content: 'World', authorId: 'bob' },
      'chan',
    );

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

  it('normalizes mention markup to usernames in context output', () => {
    const store = getStoreModule();
    const channelId = 'chan';

    const mentionedUser = createMockDiscordMessage(
      { id: '1', content: 'Hello there', authorId: '123', authorName: 'snav' },
      channelId,
    );
    const mentioner = createMockDiscordMessage(
      { id: '2', content: '<@123> are you around?', authorId: '456', authorName: 'caller' },
      channelId,
    );

    store.appendMessage(mentionedUser);
    store.appendMessage(mentioner);

    const result = store.getContext(channelId, 10000, 'bot-user', 'UnitTester');
    const lastLine = result.tail[result.tail.length - 1];
    expect(lastLine).toBe('caller: @snav are you around?');
  });

  it('records mention metadata so unknown users still render readable tags', () => {
    const store = getStoreModule();
    const channelId = 'chan';

    const mentioner = createMockDiscordMessage(
      {
        id: '1',
        content: 'ping <@999>',
        authorId: '456',
        authorName: 'caller',
        mentions: [{ id: '999', username: 'snav' }],
      },
      channelId,
    );

    store.appendMessage(mentioner);

    const result = store.getContext(channelId, 10000, 'bot-user', 'UnitTester');
    expect(result.tail[0]).toBe('caller: ping @snav');
  });

  it('normalizes bot self-mentions to bot display name', () => {
    const store = getStoreModule();
    const channelId = 'chan';

    // Use numeric ID matching the realistic Discord snowflake format
    const botId = '987654321';
    const mentioner = createMockDiscordMessage(
      {
        id: '1',
        content: '<@987654321> can you help?',
        authorId: '456',
        authorName: 'caller',
        mentions: [{ id: botId, username: 'ActualBotName' }],
      },
      channelId,
    );

    store.appendMessage(mentioner);

    const result = store.getContext(channelId, 10000, botId, 'UnitTester');
    expect(result.tail[0]).toBe('caller: @UnitTester can you help?');
  });

  it('trims oldest messages when over budget', () => {
    const store = getStoreModule();
    const channelId = 'chan';

    // Add 10 messages with longer content
    for (let i = 1; i <= 10; i++) {
      const msg = createMockDiscordMessage(
        {
          id: String(i),
          content: `This is a longer message number ${i} with more content`,
          authorId: 'alice',
        },
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
