process.env.TEST_DB_PATH = 'test-hydration-claude-cache.sqlite';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import type { Message } from 'discord.js';
import * as db from '../src/database';
import * as store from '../src/message-store';

const TEST_DB_PATH = path.join(process.cwd(), process.env.TEST_DB_PATH);

const createMockDiscordMessage = (overrides: {
  id: string;
  content: string;
  channelId: string;
  threadId?: string | null;
  parentChannelId?: string | null;
}): Partial<Message> => {
  return {
    id: overrides.id,
    content: overrides.content,
    attachments: new Map(),
    createdTimestamp: Date.now(),
    author: {
      id: 'user-test',
      username: 'User Test',
      globalName: 'User Test',
      tag: 'user#0000',
    },
    channel: {
      id: overrides.threadId ?? overrides.channelId,
      isThread: () => !!overrides.threadId,
      isTextBased: () => true,
      parentId: overrides.parentChannelId ?? overrides.channelId,
    },
  } as Partial<Message>;
};

describe('Message store hydration + backfill', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.rmSync(TEST_DB_PATH);
    }
    db.initializeDatabase();
    store.clearAll();
  });

  afterEach(() => {
    db.closeDatabase();
    store.clearAll();
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.rmSync(TEST_DB_PATH);
    }
  });

  it('hydrates channel history and frozen boundaries from SQLite', () => {
    const channelId = 'channel-hydrate';
    const now = Date.now();

    const firstRowId = db.insertMessage({
      id: '1001',
      channelId,
      threadId: null,
      parentChannelId: channelId,
      authorId: 'alice',
      authorName: 'Alice',
      content: 'Hello',
      timestamp: now,
      createdAt: now,
    });

    const lastRowId = db.insertMessage({
      id: '1002',
      channelId,
      threadId: null,
      parentChannelId: channelId,
      authorId: 'bob',
      authorName: 'Bob',
      content: 'World',
      timestamp: now + 1,
      createdAt: now + 1,
    });

    db.insertBlockBoundary({
      channelId,
      threadId: null,
      firstMessageId: '1001',
      lastMessageId: '1002',
      firstRowId: firstRowId ?? undefined,
      lastRowId: lastRowId ?? undefined,
      tokenCount: 1234,
      createdAt: now + 2,
    });

    // Emulate process restart with empty in-memory state
    store.clearAll();
    expect(store.getChannelMessages(channelId)).toHaveLength(0);

    store.__testing.hydrateChannelFromDatabase(channelId);

    const messages = store.getChannelMessages(channelId);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.content).toBe('Hello');
    expect(messages[1]?.content).toBe('World');

    const boundaries = store.getBlockBoundaries(channelId);
    expect(boundaries).toHaveLength(1);
    expect(boundaries[0]?.firstMessageId).toBe('1001');
    expect(boundaries[0]?.threadId ?? null).toBeNull();
  });

  it('backfills thread messages that arrived during downtime', async () => {
    const threadId = 'thread-backfill';
    const parentChannelId = 'parent-xyz';
    const now = Date.now();

    db.insertMessage({
      id: '2001',
      channelId: threadId,
      threadId,
      parentChannelId,
      authorId: 'alice',
      authorName: 'Alice',
      content: 'Before downtime',
      timestamp: now,
      createdAt: now,
    });

    const mockClient = {
      channels: {
        fetch: async () => ({
          id: threadId,
          isTextBased: () => true,
          isThread: () => true,
          parentId: parentChannelId,
          messages: {
            fetch: async () => {
              const message = createMockDiscordMessage({
                id: '2002',
                content: 'After downtime',
                channelId: parentChannelId,
                threadId,
                parentChannelId,
              });
              const map = new Map<string, Partial<Message>>();
              map.set('2002', message);
              return map;
            },
          },
        }),
      },
      user: { id: 'bot-user' },
    } as any;

    await store.lazyLoadThread(threadId, parentChannelId, mockClient);

    const messages = store.getChannelMessages(threadId);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.content).toBe('Before downtime');
    expect(messages[1]?.content).toBe('After downtime');
  });
});

describe('Thread metadata sentinel', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.rmSync(TEST_DB_PATH);
    }
    db.initializeDatabase();
  });

  afterEach(() => {
    db.closeDatabase();
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.rmSync(TEST_DB_PATH);
    }
  });

  it('falls back to __GLOBAL__ reset when bot-specific record is missing', () => {
    const threadId = 'thread-sentinel';
    db.recordThreadReset(threadId, 42, 'reset-msg', null);

    const info = db.getThreadResetInfo(threadId, 'bot-123');
    expect(info).toBeTruthy();
    expect(info?.lastResetRowId).toBe(42);
    expect(info?.lastResetDiscordMessageId).toBe('reset-msg');
  });
});
