/**
 * Tests for thread support with downtime recovery and reset tracking.
 */

// Set environment BEFORE importing modules
process.env.USE_DATABASE_STORAGE = 'true';
process.env.TEST_DB_PATH = 'test-claude-cache.sqlite';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Client, Message } from 'discord.js';
import * as fs from 'fs';
import * as path from 'path';
import * as db from '../src/database';
import * as store from '../src/message-store';

const TEST_DB_PATH = path.join(process.cwd(), 'test-claude-cache.sqlite');

// Mock Discord client
const createMockClient = (): Client => {
  return {
    user: { id: 'bot-user', tag: 'TestBot#0000' },
    channels: {
      fetch: async (id: string) => {
        return {
          id,
          isTextBased: () => true,
          isThread: () => true,
          parentId: 'parent-channel',
          messages: {
            fetch: async () => new Map(), // Empty for now
          },
        } as any;
      },
    },
  } as any;
};

// Mock Discord message
const createMockMessage = (data: {
  id: string;
  content: string;
  authorId: string;
  authorName: string;
  timestamp?: number;
  threadId?: string | null;
  parentChannelId?: string;
}): Message => {
  const timestamp = data.timestamp || Date.now();
  return {
    id: data.id,
    content: data.content,
    author: {
      id: data.authorId,
      username: data.authorName,
      globalName: data.authorName,
      tag: `${data.authorName}#0000`,
    },
    createdTimestamp: timestamp,
    attachments: new Map(),
    channel: {
      id: data.threadId || 'channel-1',
      isThread: () => !!data.threadId,
      parentId: data.parentChannelId,
    },
  } as any;
};

describe('Thread Support - Reset Functionality', () => {
  beforeEach(() => {
    // Clean up test database
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }
    db.initializeDatabase();
  });

  afterEach(() => {
    db.closeDatabase();
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }
  });

  it('should record reset metadata when clearing thread', () => {
    const threadId = 'thread-123';
    const parentChannelId = 'parent-456';

    // Add some messages to the thread
    const msg1: store.StoredMessage = {
      id: '1001',
      channelId: threadId,
      threadId: threadId,
      parentChannelId: parentChannelId,
      authorId: 'user1',
      authorName: 'Alice',
      content: 'Message 1',
      timestamp: Date.now(),
    };

    const msg2: store.StoredMessage = {
      id: '1002',
      channelId: threadId,
      threadId: threadId,
      parentChannelId: parentChannelId,
      authorId: 'user2',
      authorName: 'Bob',
      content: 'Message 2',
      timestamp: Date.now() + 1000,
    };

    store.appendStoredMessage(msg1);
    store.appendStoredMessage(msg2);

    // Get messages to verify they exist
    const messagesBefore = store.getChannelMessages(threadId);
    expect(messagesBefore).toHaveLength(2);

    // Clear the thread (this should record reset metadata)
    store.clearThread(threadId, parentChannelId);

    // Verify messages are cleared
    const messagesAfter = store.getChannelMessages(threadId);
    expect(messagesAfter).toHaveLength(0);

    // Verify reset metadata was recorded
    const resetInfo = db.getThreadResetInfo(threadId);
    console.log('Reset info:', JSON.stringify(resetInfo, null, 2));
    expect(resetInfo).toBeDefined();
    expect(resetInfo).not.toBeNull();
    expect(resetInfo?.lastResetRowId).toBeTypeOf('number');
    expect(resetInfo?.lastResetRowId).toBeGreaterThan(0);
  });

  it('should clear messages and boundaries from database', () => {
    const threadId = 'thread-789';
    const parentChannelId = 'parent-456';

    // Add messages
    const msg: store.StoredMessage = {
      id: '2001',
      channelId: threadId,
      threadId: threadId,
      parentChannelId: parentChannelId,
      authorId: 'user1',
      authorName: 'Alice',
      content: 'Test message',
      timestamp: Date.now(),
    };

    store.appendStoredMessage(msg);

    // Verify message exists in DB
    const messagesBefore = db.getMessages(threadId, threadId);
    expect(messagesBefore).toHaveLength(1);

    // Clear thread
    store.clearThread(threadId, parentChannelId);

    // Verify messages cleared from DB
    const messagesAfter = db.getMessages(threadId, threadId);
    expect(messagesAfter).toHaveLength(0);

    // Verify boundaries cleared from DB
    const boundaries = db.getBoundaries(threadId, threadId);
    expect(boundaries).toHaveLength(0);
  });
});

describe('Thread Support - Lazy Loading', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }
    db.initializeDatabase();
  });

  afterEach(() => {
    db.closeDatabase();
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }
  });

  it('should load all messages from DB when no reset exists', async () => {
    const threadId = 'thread-no-reset';
    const parentChannelId = 'parent-123';
    const client = createMockClient();

    // Directly insert messages into DB
    const messages: store.StoredMessage[] = [
      {
        id: '3001',
        channelId: threadId,
        threadId: threadId,
        parentChannelId: parentChannelId,
        authorId: 'user1',
        authorName: 'Alice',
        content: 'Message 1',
        timestamp: Date.now(),
      },
      {
        id: '3002',
        channelId: threadId,
        threadId: threadId,
        parentChannelId: parentChannelId,
        authorId: 'user2',
        authorName: 'Bob',
        content: 'Message 2',
        timestamp: Date.now() + 1000,
      },
    ];

    for (const msg of messages) {
      db.insertMessage({ ...msg, createdAt: Date.now() });
    }

    // Lazy load the thread
    await store.lazyLoadThread(threadId, parentChannelId, client);

    // Verify all messages loaded
    const loadedMessages = store.getChannelMessages(threadId);
    expect(loadedMessages).toHaveLength(2);
    expect(loadedMessages[0]?.content).toBe('Message 1');
    expect(loadedMessages[1]?.content).toBe('Message 2');
  });

  it('should only load messages after reset boundary', async () => {
    const threadId = 'thread-with-reset';
    const parentChannelId = 'parent-456';
    const client = createMockClient();

    // Insert messages before reset
    const oldMessages: store.StoredMessage[] = [
      {
        id: '4001',
        channelId: threadId,
        threadId: threadId,
        parentChannelId: parentChannelId,
        authorId: 'user1',
        authorName: 'Alice',
        content: 'Old message 1',
        timestamp: Date.now(),
      },
      {
        id: '4002',
        channelId: threadId,
        threadId: threadId,
        parentChannelId: parentChannelId,
        authorId: 'user2',
        authorName: 'Bob',
        content: 'Old message 2',
        timestamp: Date.now() + 1000,
      },
    ];

    const oldRowIds: number[] = [];
    for (const msg of oldMessages) {
      const rowId = db.insertMessage({ ...msg, createdAt: Date.now() });
      if (rowId) oldRowIds.push(rowId);
    }

    // Record reset at the last old message
    const lastOldRowId = Math.max(...oldRowIds);
    db.recordThreadReset(threadId, lastOldRowId);

    // Insert new messages after reset
    const newMessages: store.StoredMessage[] = [
      {
        id: '4003',
        channelId: threadId,
        threadId: threadId,
        parentChannelId: parentChannelId,
        authorId: 'user1',
        authorName: 'Alice',
        content: 'New message 1',
        timestamp: Date.now() + 2000,
      },
      {
        id: '4004',
        channelId: threadId,
        threadId: threadId,
        parentChannelId: parentChannelId,
        authorId: 'user2',
        authorName: 'Bob',
        content: 'New message 2',
        timestamp: Date.now() + 3000,
      },
    ];

    for (const msg of newMessages) {
      db.insertMessage({ ...msg, createdAt: Date.now() });
    }

    // Lazy load the thread
    await store.lazyLoadThread(threadId, parentChannelId, client);

    // Verify only new messages loaded (not old ones)
    const loadedMessages = store.getChannelMessages(threadId);
    expect(loadedMessages).toHaveLength(2);
    expect(loadedMessages[0]?.content).toBe('New message 1');
    expect(loadedMessages[1]?.content).toBe('New message 2');

    // Verify old messages are NOT loaded
    const hasOldMessage = loadedMessages.some(m => m.content.includes('Old'));
    expect(hasOldMessage).toBe(false);
  });

  it('should load boundaries from database', async () => {
    const threadId = 'thread-with-boundaries';
    const parentChannelId = 'parent-789';
    const client = createMockClient();

    // Insert messages
    const rowId1 = db.insertMessage({
      id: '5001',
      channelId: threadId,
      threadId: threadId,
      parentChannelId: parentChannelId,
      authorId: 'user1',
      authorName: 'Alice',
      content: 'Message 1',
      timestamp: Date.now(),
      createdAt: Date.now(),
    });

    const rowId2 = db.insertMessage({
      id: '5002',
      channelId: threadId,
      threadId: threadId,
      parentChannelId: parentChannelId,
      authorId: 'user2',
      authorName: 'Bob',
      content: 'Message 2',
      timestamp: Date.now() + 1000,
      createdAt: Date.now(),
    });

    // Insert a boundary
    if (rowId1 && rowId2) {
      db.insertBlockBoundary({
        channelId: threadId,
        threadId: threadId,
        firstMessageId: '5001',
        lastMessageId: '5002',
        firstRowId: rowId1,
        lastRowId: rowId2,
        tokenCount: 1000,
        createdAt: Date.now(),
      });
    }

    // Lazy load the thread
    await store.lazyLoadThread(threadId, parentChannelId, client);

    // Verify boundaries loaded
    const boundaries = store.getBlockBoundaries(threadId);
    expect(boundaries).toHaveLength(1);
    expect(boundaries[0]?.tokenCount).toBe(1000);
  });
});

describe('Thread Support - Integration Tests', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }
    db.initializeDatabase();
  });

  afterEach(() => {
    db.closeDatabase();
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }
  });

  it('should handle downtime recovery scenario', async () => {
    const threadId = 'thread-downtime';
    const parentChannelId = 'parent-123';
    const client = createMockClient();

    // Simulate: Thread has 3 messages before bot goes down
    const beforeDowntime: store.StoredMessage[] = [
      {
        id: '6001',
        channelId: threadId,
        threadId: threadId,
        parentChannelId: parentChannelId,
        authorId: 'user1',
        authorName: 'Alice',
        content: 'Before downtime 1',
        timestamp: Date.now(),
      },
      {
        id: '6002',
        channelId: threadId,
        threadId: threadId,
        parentChannelId: parentChannelId,
        authorId: 'user2',
        authorName: 'Bob',
        content: 'Before downtime 2',
        timestamp: Date.now() + 1000,
      },
      {
        id: '6003',
        channelId: threadId,
        threadId: threadId,
        parentChannelId: parentChannelId,
        authorId: 'user1',
        authorName: 'Alice',
        content: 'Before downtime 3',
        timestamp: Date.now() + 2000,
      },
    ];

    for (const msg of beforeDowntime) {
      db.insertMessage({ ...msg, createdAt: Date.now() });
    }

    // Bot restarts - lazy load should restore all messages
    await store.lazyLoadThread(threadId, parentChannelId, client);

    const loadedMessages = store.getChannelMessages(threadId);
    expect(loadedMessages).toHaveLength(3);
    expect(loadedMessages.map(m => m.content)).toEqual([
      'Before downtime 1',
      'Before downtime 2',
      'Before downtime 3',
    ]);
  });

  it('should handle reset + downtime scenario', async () => {
    const threadId = 'thread-reset-downtime';
    const parentChannelId = 'parent-456';
    const client = createMockClient();

    // Simulate: Thread has messages, then reset, then downtime, then new messages

    // 1. Old messages (before reset)
    const oldRowIds: number[] = [];
    const oldMessages: store.StoredMessage[] = [
      {
        id: '7001',
        channelId: threadId,
        threadId: threadId,
        parentChannelId: parentChannelId,
        authorId: 'user1',
        authorName: 'Alice',
        content: 'Pre-reset message 1',
        timestamp: Date.now(),
      },
      {
        id: '7002',
        channelId: threadId,
        threadId: threadId,
        parentChannelId: parentChannelId,
        authorId: 'user2',
        authorName: 'Bob',
        content: 'Pre-reset message 2',
        timestamp: Date.now() + 1000,
      },
    ];

    for (const msg of oldMessages) {
      const rowId = db.insertMessage({ ...msg, createdAt: Date.now() });
      if (rowId) oldRowIds.push(rowId);
    }

    // 2. Reset (clears DB and records reset boundary)
    const lastOldRowId = Math.max(...oldRowIds);
    db.recordThreadReset(threadId, lastOldRowId);
    db.clearThread(threadId, threadId);

    // 3. New messages after reset (during downtime, not in DB yet - simulated)
    // For this test, we'll just insert them to DB to simulate they were added during downtime
    const newMessages: store.StoredMessage[] = [
      {
        id: '7003',
        channelId: threadId,
        threadId: threadId,
        parentChannelId: parentChannelId,
        authorId: 'user1',
        authorName: 'Alice',
        content: 'Post-reset message 1',
        timestamp: Date.now() + 2000,
      },
      {
        id: '7004',
        channelId: threadId,
        threadId: threadId,
        parentChannelId: parentChannelId,
        authorId: 'user2',
        authorName: 'Bob',
        content: 'Post-reset message 2',
        timestamp: Date.now() + 3000,
      },
    ];

    for (const msg of newMessages) {
      db.insertMessage({ ...msg, createdAt: Date.now() });
    }

    // 4. Bot restarts - lazy load should only get post-reset messages
    await store.lazyLoadThread(threadId, parentChannelId, client);

    const loadedMessages = store.getChannelMessages(threadId);

    // Should only have new messages, not old ones
    expect(loadedMessages).toHaveLength(2);
    expect(loadedMessages[0]?.content).toBe('Post-reset message 1');
    expect(loadedMessages[1]?.content).toBe('Post-reset message 2');

    // Verify old messages are NOT present
    const hasPreResetMessage = loadedMessages.some(m => m.content.includes('Pre-reset'));
    expect(hasPreResetMessage).toBe(false);
  });
});
