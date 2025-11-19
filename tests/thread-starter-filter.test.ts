import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { Message, MessageType } from 'discord.js';
import * as fs from 'fs';
import * as path from 'path';

process.env.MAIN_CHANNEL_IDS ||= '';
process.env.TEST_DB_PATH ||= 'test-thread-starter-cache.sqlite';

const TEST_DB_PATH = path.join(process.cwd(), process.env.TEST_DB_PATH);

type StoreModule = typeof import('../src/message-store');
type DatabaseModule = typeof import('../src/database');

let storeModule: StoreModule | null = null;
let databaseModule: DatabaseModule | null = null;

beforeAll(async () => {
  if (fs.existsSync(TEST_DB_PATH)) {
    fs.rmSync(TEST_DB_PATH);
  }
  databaseModule = await import('../src/database');
  databaseModule.initializeDatabase();
  storeModule = await import('../src/message-store');
});

afterAll(() => {
  databaseModule?.closeDatabase();
  if (fs.existsSync(TEST_DB_PATH)) {
    fs.rmSync(TEST_DB_PATH);
  }
});

function getStoreModule(): StoreModule {
  if (!storeModule) throw new Error('store module not loaded');
  return storeModule;
}

afterEach(() => {
  getStoreModule().clearAll();
});

function createMockMessage(type: MessageType, content: string, id: string): Message {
  return {
    id,
    content,
    type,
    channel: {
      id: 'channel-1',
      isThread: () => type === MessageType.ThreadStarterMessage,
    },
    author: {
      id: 'user1',
      username: 'TestUser',
      globalName: 'TestUser',
      tag: 'TestUser#0000',
    },
    createdTimestamp: Date.now(),
    attachments: new Map(),
  } as any;
}

describe('Thread Starter Message Filtering', () => {
  it('should NOT store thread starter messages', async () => {
    const store = getStoreModule();

    const threadStarterMsg = createMockMessage(
      MessageType.ThreadStarterMessage,
      'Welcome to this thread!',
      '1001',
    );

    await store.appendMessage(threadStarterMsg);

    const messages = store.getChannelMessages('channel-1');
    expect(messages).toHaveLength(0);
  });

  it('should store regular messages normally', async () => {
    const store = getStoreModule();

    const regularMsg = createMockMessage(MessageType.Default, 'Hello world!', '1002');

    await store.appendMessage(regularMsg);

    const messages = store.getChannelMessages('channel-1');
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe('Hello world!');
  });

  it('should filter thread starter messages but keep other messages', async () => {
    const store = getStoreModule();

    const msg1 = createMockMessage(MessageType.Default, 'First message', '1001');
    const threadStarter = createMockMessage(
      MessageType.ThreadStarterMessage,
      'Thread title',
      '1002',
    );
    const msg2 = createMockMessage(MessageType.Default, 'Third message', '1003');

    await store.appendMessage(msg1);
    await store.appendMessage(threadStarter);
    await store.appendMessage(msg2);

    const messages = store.getChannelMessages('channel-1');
    expect(messages).toHaveLength(2);
    expect(messages[0]?.content).toBe('First message');
    expect(messages[1]?.content).toBe('Third message');
  });
});
