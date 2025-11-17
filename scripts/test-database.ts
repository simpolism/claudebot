/**
 * Test script for database functionality
 *
 * Tests:
 * 1. Database initialization
 * 2. Message insertion
 * 3. Block boundary creation
 * 4. Data persistence across restarts
 * 5. Query functionality
 */

import { initializeDatabase, closeDatabase, getDatabaseStats, insertMessage, insertBlockBoundary, getMessages, getBlockBoundaries, getTailMessages, StoredMessage, BlockBoundary, clearAllData } from '../src/database';

console.log('=== Database Test Suite ===\n');

// Test 1: Initialize database
console.log('Test 1: Initializing database...');
initializeDatabase();
console.log('✓ Database initialized\n');

// Test 2: Insert messages
console.log('Test 2: Inserting test messages...');
const testMessages: StoredMessage[] = [
  {
    id: '1000',
    channelId: 'channel-123',
    threadId: null,
    parentChannelId: 'channel-123',
    authorId: 'user-1',
    authorName: 'Alice',
    content: 'Hello world!',
    timestamp: Date.now() - 5000,
    createdAt: Date.now(),
  },
  {
    id: '1001',
    channelId: 'channel-123',
    threadId: null,
    parentChannelId: 'channel-123',
    authorId: 'user-2',
    authorName: 'Bob',
    content: 'Hi Alice!',
    timestamp: Date.now() - 4000,
    createdAt: Date.now(),
  },
  {
    id: '1002',
    channelId: 'channel-123',
    threadId: null,
    parentChannelId: 'channel-123',
    authorId: 'bot-1',
    authorName: 'TestBot',
    content: 'How can I help you?',
    timestamp: Date.now() - 3000,
    createdAt: Date.now(),
  },
  {
    id: '1003',
    channelId: 'thread-456',
    threadId: 'thread-456',
    parentChannelId: 'channel-123',
    authorId: 'user-1',
    authorName: 'Alice',
    content: 'This is a thread message',
    timestamp: Date.now() - 2000,
    createdAt: Date.now(),
  },
];

for (const msg of testMessages) {
  insertMessage(msg);
}
console.log(`✓ Inserted ${testMessages.length} messages\n`);

// Test 3: Query messages
console.log('Test 3: Querying messages...');
const channelMessages = getMessages('channel-123', null);
console.log(`✓ Retrieved ${channelMessages.length} messages from channel-123`);
console.log(`  Messages: ${channelMessages.map(m => `${m.authorName}: ${m.content}`).join(', ')}\n`);

const threadMessages = getMessages('thread-456', 'thread-456');
console.log(`✓ Retrieved ${threadMessages.length} messages from thread-456`);
console.log(`  Messages: ${threadMessages.map(m => `${m.authorName}: ${m.content}`).join(', ')}\n`);

// Test 4: Insert block boundary
console.log('Test 4: Creating block boundary...');
const boundary: BlockBoundary = {
  channelId: 'channel-123',
  threadId: null,
  firstMessageId: '1000',
  lastMessageId: '1002',
  tokenCount: 150,
  createdAt: Date.now(),
};
insertBlockBoundary(boundary);
console.log('✓ Created block boundary\n');

// Test 5: Query boundaries
console.log('Test 5: Querying block boundaries...');
const boundaries = getBlockBoundaries('channel-123', null);
console.log(`✓ Retrieved ${boundaries.length} boundaries`);
if (boundaries.length > 0) {
  console.log(`  First boundary: ${boundaries[0].firstMessageId} -> ${boundaries[0].lastMessageId} (${boundaries[0].tokenCount} tokens)\n`);
}

// Test 6: Get tail messages
console.log('Test 6: Getting tail messages (unfrozen)...');
const tailMessages = getTailMessages('channel-123', null, '1002');
console.log(`✓ Retrieved ${tailMessages.length} tail messages (should be 0 since all are in frozen block)\n`);

// Test 7: Database stats
console.log('Test 7: Database statistics...');
const stats = getDatabaseStats();
console.log('✓ Database stats:');
console.log(`  Messages: ${stats.messageCount}`);
console.log(`  Boundaries: ${stats.boundaryCount}`);
console.log(`  Channels: ${stats.channelCount}`);
console.log(`  Threads: ${stats.threadCount}`);
console.log(`  Database size: ${(stats.databaseSizeBytes / 1024).toFixed(2)} KB\n`);

// Test 8: Persistence (close and reopen)
console.log('Test 8: Testing persistence (close and reopen)...');
closeDatabase();
console.log('✓ Database closed');

initializeDatabase();
console.log('✓ Database reopened');

const persistedMessages = getMessages('channel-123', null);
console.log(`✓ Retrieved ${persistedMessages.length} persisted messages (should be 3)`);

const persistedBoundaries = getBlockBoundaries('channel-123', null);
console.log(`✓ Retrieved ${persistedBoundaries.length} persisted boundaries (should be 1)\n`);

// Test 9: Verify data integrity
console.log('Test 9: Verifying data integrity...');
let allGood = true;

if (persistedMessages.length !== 3) {
  console.error(`✗ Expected 3 messages, got ${persistedMessages.length}`);
  allGood = false;
}

if (persistedBoundaries.length !== 1) {
  console.error(`✗ Expected 1 boundary, got ${persistedBoundaries.length}`);
  allGood = false;
}

if (persistedMessages[0]?.content !== 'Hello world!') {
  console.error(`✗ First message content mismatch`);
  allGood = false;
}

if (allGood) {
  console.log('✓ All data integrity checks passed\n');
} else {
  console.error('✗ Data integrity checks failed\n');
  process.exit(1);
}

// Cleanup
console.log('Cleanup: Clearing test data...');
clearAllData();
closeDatabase();
console.log('✓ Database cleared and closed\n');

console.log('=== All tests passed! ===');
