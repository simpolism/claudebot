import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { Message, MessageType } from 'discord.js';

process.env.MAIN_CHANNEL_IDS ||= '';

type StoreModule = typeof import('../src/message-store');

let storeModule: StoreModule | null = null;

beforeAll(async () => {
  storeModule = await import('../src/message-store');
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
  it('should NOT store thread starter messages', () => {
    const store = getStoreModule();

    // Create a thread starter message (the automatic message with thread title)
    const threadStarterMsg = createMockMessage(
      MessageType.ThreadStarterMessage,
      'Welcome to this thread!',
      '1001'
    );

    // Try to append it
    store.appendMessage(threadStarterMsg);

    // Verify it was NOT stored
    const messages = store.getChannelMessages('channel-1');
    expect(messages).toHaveLength(0);
  });

  it('should store regular messages normally', () => {
    const store = getStoreModule();

    // Create a regular message
    const regularMsg = createMockMessage(
      MessageType.Default,
      'Hello world!',
      '1002'
    );

    // Append it
    store.appendMessage(regularMsg);

    // Verify it WAS stored
    const messages = store.getChannelMessages('channel-1');
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe('Hello world!');
  });

  it('should filter thread starter messages but keep other messages', () => {
    const store = getStoreModule();

    // Add multiple messages, including a thread starter
    const msg1 = createMockMessage(MessageType.Default, 'First message', '1001');
    const threadStarter = createMockMessage(MessageType.ThreadStarterMessage, 'Thread title', '1002');
    const msg2 = createMockMessage(MessageType.Default, 'Third message', '1003');

    store.appendMessage(msg1);
    store.appendMessage(threadStarter);
    store.appendMessage(msg2);

    // Verify only the regular messages were stored
    const messages = store.getChannelMessages('channel-1');
    expect(messages).toHaveLength(2);
    expect(messages[0]?.content).toBe('First message');
    expect(messages[1]?.content).toBe('Third message');
  });
});
