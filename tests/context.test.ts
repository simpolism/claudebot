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
  attachments?: Array<{
    id: string;
    name?: string;
    contentType?: string;
    size?: number;
    url: string;
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
  const attachmentEntries =
    msg.attachments?.map((attachment) => [
      attachment.id,
      {
        id: attachment.id,
        name: attachment.name ?? `${attachment.id}.txt`,
        contentType: attachment.contentType ?? 'text/plain',
        size: attachment.size ?? 32,
        url: attachment.url,
      },
    ]) ?? [];
  const attachmentMap = new Map(attachmentEntries);
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
    attachments: attachmentMap,
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
  it('appends messages to in-memory storage', async () => {
    const store = getStoreModule();
    const msg1 = createMockDiscordMessage(
      { id: '1', content: 'Hello', authorId: 'alice' },
      'chan',
    );
    const msg2 = createMockDiscordMessage(
      { id: '2', content: 'World', authorId: 'bob' },
      'chan',
    );

    await store.appendMessage(msg1);
    await store.appendMessage(msg2);

    const messages = store.getChannelMessages('chan');
    expect(messages).toHaveLength(2);
    expect(messages[0]?.content).toBe('Hello');
    expect(messages[1]?.content).toBe('World');
  });

  it('freezes blocks when token threshold reached', async () => {
    const store = getStoreModule();

    // Create enough messages to exceed 30k tokens (~120k chars at 4 chars/token)
    const channelId = 'test-channel';
    for (let i = 1; i <= 100; i++) {
      const longContent = 'x'.repeat(1500); // ~375 tokens per message = ~37.5k tokens total
      const msg = createMockDiscordMessage(
        { id: String(i), content: longContent, authorId: 'alice' },
        channelId,
      );
      await store.appendMessage(msg);
    }

    const boundaries = store.getBlockBoundaries(channelId);
    expect(boundaries.length).toBeGreaterThan(0);
    expect(boundaries[0]?.tokenCount).toBeGreaterThanOrEqual(30000);
  });

  it('formats messages with bot name when author is bot', async () => {
    const store = getStoreModule();
    const channelId = 'chan';

    // Bot message
    const botMsg = createMockDiscordMessage(
      { id: '1', content: 'I am bot', authorId: 'bot-user' },
      channelId,
    );
    await store.appendMessage(botMsg);

    // User message
    const userMsg = createMockDiscordMessage(
      { id: '2', content: 'I am user', authorId: 'alice' },
      channelId,
    );
    await store.appendMessage(userMsg);

    const result = store.getContext(channelId, 10000, 'bot-user', 'UnitTester');

    // Bot message should use botDisplayName, not authorId
    expect(result.tail[0]).toBe('UnitTester: I am bot');
    expect(result.tail[1]).toBe('alice: I am user');
  });

  it('normalizes mention markup to usernames in context output', async () => {
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

    await store.appendMessage(mentionedUser);
    await store.appendMessage(mentioner);

    const result = store.getContext(channelId, 10000, 'bot-user', 'UnitTester');
    const lastLine = result.tail[result.tail.length - 1];
    expect(lastLine).toBe('caller: @snav are you around?');
  });

  it('records mention metadata so unknown users still render readable tags', async () => {
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

    await store.appendMessage(mentioner);

    const result = store.getContext(channelId, 10000, 'bot-user', 'UnitTester');
    expect(result.tail[0]).toBe('caller: ping @snav');
  });

  it('inlines supported text attachments into stored content', async () => {
    const store = getStoreModule();
    const channelId = 'chan';
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('Attachment body', { status: 200, headers: { 'content-length': '16' } }));

    const message = createMockDiscordMessage(
      {
        id: '1',
        content: 'See attached',
        authorId: 'alice',
        attachments: [{ id: 'att-1', name: 'notes.txt', url: 'https://cdn.discord.test/att-1', size: 16 }],
      },
      channelId,
    );

    await store.appendMessage(message);
    fetchSpy.mockRestore();

    const result = store.getContext(channelId, 10000, 'bot-user', 'UnitTester');
    expect(result.tail[0]).toContain('alice: See attached');
    expect(result.tail[0]).toContain('[Attachment: notes.txt]');
    expect(result.tail[0]).toContain('Attachment body');
  });

  it('skips text attachments when fetch fails', async () => {
    const store = getStoreModule();
    const channelId = 'chan';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));

    const message = createMockDiscordMessage(
      {
        id: '1',
        content: 'Please read',
        authorId: 'alice',
        attachments: [{ id: 'att-2', name: 'notes.txt', url: 'https://cdn.discord.test/att-2', size: 32 }],
      },
      channelId,
    );

    await store.appendMessage(message);
    fetchSpy.mockRestore();

    const result = store.getContext(channelId, 10000, 'bot-user', 'UnitTester');
    expect(result.tail[0]).toBe('alice: Please read');
  });

  it('normalizes bot self-mentions to bot display name', async () => {
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

    await store.appendMessage(mentioner);

    const result = store.getContext(channelId, 10000, botId, 'UnitTester');
    expect(result.tail[0]).toBe('caller: @UnitTester can you help?');
  });

  it('trims oldest messages when over budget', async () => {
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
      await store.appendMessage(msg);
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

describe('timestamp formatting', () => {
  it('inserts timestamp markers after gaps of 10+ minutes', async () => {
    const store = getStoreModule();
    const channelId = 'timestamp-chan';

    // Message 1 at t=0
    const msg1 = createMockDiscordMessage(
      { id: '1000000', content: 'Hello', authorId: 'alice', authorName: 'alice' },
      channelId,
    );
    await store.appendMessage(msg1);

    // Message 2 at t=15 minutes later (15 * 60 = 900 seconds = 900000 more in ID)
    const msg2 = createMockDiscordMessage(
      { id: '1000900', content: 'Hi there', authorId: 'bob', authorName: 'bob' },
      channelId,
    );
    await store.appendMessage(msg2);

    // Message 3 at t=16 minutes (only 1 min after msg2, no gap)
    const msg3 = createMockDiscordMessage(
      { id: '1000960', content: 'How are you?', authorId: 'alice', authorName: 'alice' },
      channelId,
    );
    await store.appendMessage(msg3);

    // Get context with timestamps enabled
    const result = store.getContext(channelId, 10000, 'bot-user', 'UnitTester', null, undefined, false, true);

    // Should have 3 tail entries
    expect(result.tail).toHaveLength(3);

    // First message should NOT have timestamp (no prior message to compare)
    expect(result.tail[0]).toBe('alice: Hello');

    // Second message SHOULD have timestamp (15 min gap from first)
    expect(result.tail[1]).toMatch(/^\[.*\]\nbob: Hi there$/);

    // Third message should NOT have timestamp (only 1 min gap)
    expect(result.tail[2]).toBe('alice: How are you?');
  });

  it('includes timezone only on first timestamp', async () => {
    const store = getStoreModule();
    const channelId = 'tz-chan';

    // Create 3 messages with 15-minute gaps between each
    const msg1 = createMockDiscordMessage(
      { id: '2000000', content: 'First', authorId: 'alice', authorName: 'alice' },
      channelId,
    );
    await store.appendMessage(msg1);

    const msg2 = createMockDiscordMessage(
      { id: '2000900', content: 'Second', authorId: 'bob', authorName: 'bob' },
      channelId,
    );
    await store.appendMessage(msg2);

    const msg3 = createMockDiscordMessage(
      { id: '2001800', content: 'Third', authorId: 'alice', authorName: 'alice' },
      channelId,
    );
    await store.appendMessage(msg3);

    const result = store.getContext(channelId, 10000, 'bot-user', 'UnitTester', null, undefined, false, true);

    // Second message should have timezone (first timestamp)
    // Look for common timezone abbreviations
    expect(result.tail[1]).toMatch(/\[(.*?(EST|EDT|PST|PDT|UTC|CST|CDT|[A-Z]{2,4}))\]/);

    // Third message should NOT have timezone (subsequent timestamp)
    // Should just be time like [12:30 PM] without timezone
    const thirdTimestamp = result.tail[2]?.match(/\[(.*?)\]/)?.[1];
    expect(thirdTimestamp).toBeDefined();
    // Subsequent timestamps should be shorter (no timezone)
    expect(thirdTimestamp).not.toMatch(/EST|EDT|PST|PDT|UTC|CST|CDT/);
  });

  it('does not insert timestamps when enableTimestamps is false', async () => {
    const store = getStoreModule();
    const channelId = 'no-ts-chan';

    const msg1 = createMockDiscordMessage(
      { id: '3000000', content: 'Hello', authorId: 'alice', authorName: 'alice' },
      channelId,
    );
    await store.appendMessage(msg1);

    const msg2 = createMockDiscordMessage(
      { id: '3000900', content: 'Hi there', authorId: 'bob', authorName: 'bob' },
      channelId,
    );
    await store.appendMessage(msg2);

    // Get context with timestamps DISABLED (default)
    const result = store.getContext(channelId, 10000, 'bot-user', 'UnitTester', null, undefined, false, false);

    // Should have 2 tail entries, no timestamps
    expect(result.tail).toHaveLength(2);
    expect(result.tail[0]).toBe('alice: Hello');
    expect(result.tail[1]).toBe('bob: Hi there');
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

    await store.appendMessage(msg1);
    await store.appendMessage(msg2);

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
    await store.appendMessage(userMsg);

    // Bot message (author ID matches bot)
    const botMsg = createMockDiscordMessage(
      { id: '2', content: 'Bot replies', authorId: 'bot-user' },
      channelId,
    );
    await store.appendMessage(botMsg);

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
