/**
 * Database layer for persistent message storage with thread support.
 *
 * This module provides SQLite-based storage for:
 * - Discord messages (channels and threads)
 * - Block boundaries (for Anthropic prompt caching)
 * - Schema migrations
 *
 * Design goals:
 * 1. Single source of truth (replaces conversation-cache.json)
 * 2. Thread-aware storage (parent + thread relationship)
 * 3. Efficient context queries (indexed for performance)
 * 4. ACID guarantees (no partial writes on crash)
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// Types
// ============================================================================

export interface StoredMessage {
  id: string;
  channelId: string;
  threadId: string | null;
  parentChannelId: string;
  authorId: string;
  authorName: string;
  content: string;
  timestamp: number;
  createdAt: number;
}

export interface BlockBoundary {
  id?: number; // Auto-incremented, undefined when inserting
  channelId: string;
  threadId: string | null;
  firstMessageId: string;
  lastMessageId: string;
  tokenCount: number;
  createdAt: number;
}

export interface ChannelInfo {
  channelId: string;
  threadId: string | null;
  parentChannelId: string;
}

interface Migration {
  version: number;
  description: string;
  up: (db: Database.Database) => void;
}

// ============================================================================
// Database Instance
// ============================================================================

let db: Database.Database | null = null;

const DB_PATH = path.join(process.cwd(), 'claude-cache.sqlite');

/**
 * Initialize the database connection and run migrations.
 * Safe to call multiple times (idempotent).
 */
export function initializeDatabase(): void {
  if (db) {
    console.log('[Database] Already initialized');
    return;
  }

  console.log(`[Database] Initializing at ${DB_PATH}`);

  // Create database connection
  db = new Database(DB_PATH);

  // Enable WAL mode for better concurrency
  db.pragma('journal_mode = WAL');

  // Use NORMAL synchronous mode (faster, still safe)
  db.pragma('synchronous = NORMAL');

  // Enable foreign keys (for future use)
  db.pragma('foreign_keys = ON');

  // Run migrations
  runMigrations(db);

  console.log('[Database] Initialization complete');
}

/**
 * Close the database connection.
 * Useful for clean shutdown.
 */
export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
    console.log('[Database] Closed');
  }
}

/**
 * Get the database instance.
 * Throws if not initialized.
 */
function getDb(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initializeDatabase() first.');
  }
  return db;
}

// ============================================================================
// Migrations
// ============================================================================

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'Initial schema with messages and block_boundaries',
    up: (db: Database.Database) => {
      // Create messages table
      db.exec(`
        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY,
          channel_id TEXT NOT NULL,
          thread_id TEXT,
          parent_channel_id TEXT NOT NULL,
          author_id TEXT NOT NULL,
          author_name TEXT NOT NULL,
          content TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_messages_context
          ON messages(parent_channel_id, thread_id, timestamp DESC);

        CREATE INDEX IF NOT EXISTS idx_messages_thread
          ON messages(channel_id, thread_id, timestamp DESC);
      `);

      // Create block_boundaries table
      db.exec(`
        CREATE TABLE IF NOT EXISTS block_boundaries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          channel_id TEXT NOT NULL,
          thread_id TEXT,
          first_message_id TEXT NOT NULL,
          last_message_id TEXT NOT NULL,
          token_count INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          UNIQUE(channel_id, thread_id, first_message_id)
        );

        CREATE INDEX IF NOT EXISTS idx_boundaries_context
          ON block_boundaries(channel_id, thread_id, id);

        CREATE INDEX IF NOT EXISTS idx_boundaries_last
          ON block_boundaries(channel_id, thread_id, last_message_id);
      `);

      // Create schema_migrations table
      db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at INTEGER NOT NULL,
          description TEXT
        );
      `);
    },
  },
];

function getCurrentVersion(db: Database.Database): number {
  // Check if schema_migrations table exists
  const tableExists = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'`
    )
    .get();

  if (!tableExists) {
    return 0;
  }

  // Get the highest version
  const result = db
    .prepare('SELECT MAX(version) as version FROM schema_migrations')
    .get() as { version: number | null };

  return result.version ?? 0;
}

function runMigrations(db: Database.Database): void {
  const currentVersion = getCurrentVersion(db);
  const pendingMigrations = MIGRATIONS.filter((m) => m.version > currentVersion);

  if (pendingMigrations.length === 0) {
    console.log(`[Database] Schema up to date (version ${currentVersion})`);
    return;
  }

  console.log(
    `[Database] Running ${pendingMigrations.length} migration(s) from version ${currentVersion}...`
  );

  for (const migration of pendingMigrations) {
    console.log(`[Database] Applying migration ${migration.version}: ${migration.description}`);

    db.transaction(() => {
      migration.up(db);
      db.prepare(
        'INSERT INTO schema_migrations (version, applied_at, description) VALUES (?, ?, ?)'
      ).run(migration.version, Date.now(), migration.description);
    })();

    console.log(`[Database] Migration ${migration.version} complete`);
  }

  console.log('[Database] All migrations complete');
}

// ============================================================================
// Message Operations
// ============================================================================

/**
 * Insert a message into the database.
 * Uses INSERT OR IGNORE to handle duplicates gracefully.
 */
export function insertMessage(message: StoredMessage): void {
  const db = getDb();

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO messages
    (id, channel_id, thread_id, parent_channel_id, author_id, author_name, content, timestamp, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    message.id,
    message.channelId,
    message.threadId,
    message.parentChannelId,
    message.authorId,
    message.authorName,
    message.content,
    message.timestamp,
    message.createdAt
  );
}

/**
 * Insert multiple messages in a single transaction.
 * Much faster than individual inserts.
 */
export function insertMessages(messages: StoredMessage[]): void {
  if (messages.length === 0) return;

  const db = getDb();

  const insertMany = db.transaction((msgs: StoredMessage[]) => {
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO messages
      (id, channel_id, thread_id, parent_channel_id, author_id, author_name, content, timestamp, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const msg of msgs) {
      stmt.run(
        msg.id,
        msg.channelId,
        msg.threadId,
        msg.parentChannelId,
        msg.authorId,
        msg.authorName,
        msg.content,
        msg.timestamp,
        msg.createdAt
      );
    }
  });

  insertMany(messages);
}

/**
 * Get messages in a specific range (for building blocks from boundaries).
 */
export function getMessagesInRange(
  firstMessageId: string,
  lastMessageId: string
): StoredMessage[] {
  const db = getDb();

  // Note: This assumes message IDs are Discord snowflakes (sortable)
  const stmt = db.prepare(`
    SELECT * FROM messages
    WHERE id >= ? AND id <= ?
    ORDER BY timestamp ASC
  `);

  return stmt.all(firstMessageId, lastMessageId) as StoredMessage[];
}

/**
 * Get all messages for a channel/thread combination.
 * Ordered by timestamp (oldest first).
 */
export function getMessages(
  channelId: string,
  threadId: string | null,
  limit?: number
): StoredMessage[] {
  const db = getDb();

  let query = `
    SELECT * FROM messages
    WHERE channel_id = ? AND thread_id IS ?
    ORDER BY timestamp ASC
  `;

  if (limit !== undefined) {
    query += ` LIMIT ${limit}`;
  }

  const stmt = db.prepare(query);
  return stmt.all(channelId, threadId) as StoredMessage[];
}

/**
 * Get unfrozen tail messages (messages after last boundary).
 */
export function getTailMessages(
  channelId: string,
  threadId: string | null,
  lastBoundaryMessageId: string | null
): StoredMessage[] {
  const db = getDb();

  if (!lastBoundaryMessageId) {
    // No boundaries yet, return all messages
    return getMessages(channelId, threadId);
  }

  const stmt = db.prepare(`
    SELECT * FROM messages
    WHERE channel_id = ? AND thread_id IS ?
      AND id > ?
    ORDER BY timestamp ASC
  `);

  return stmt.all(channelId, threadId, lastBoundaryMessageId) as StoredMessage[];
}

/**
 * Get all distinct parent channel IDs that have messages.
 * Useful for startup to know which channels to load.
 */
export function getChannelsWithMessages(): string[] {
  const db = getDb();

  const stmt = db.prepare(`
    SELECT DISTINCT parent_channel_id FROM messages
  `);

  const rows = stmt.all() as { parent_channel_id: string }[];
  return rows.map((r) => r.parent_channel_id);
}

/**
 * Get all thread IDs for a parent channel.
 */
export function getThreadsForChannel(parentChannelId: string): string[] {
  const db = getDb();

  const stmt = db.prepare(`
    SELECT DISTINCT thread_id FROM messages
    WHERE parent_channel_id = ? AND thread_id IS NOT NULL
  `);

  const rows = stmt.all(parentChannelId) as { thread_id: string }[];
  return rows.map((r) => r.thread_id);
}

/**
 * Check if a message exists in the database.
 */
export function messageExists(messageId: string): boolean {
  const db = getDb();

  const stmt = db.prepare('SELECT 1 FROM messages WHERE id = ? LIMIT 1');
  const result = stmt.get(messageId);
  return result !== undefined;
}

// ============================================================================
// Block Boundary Operations
// ============================================================================

/**
 * Insert a block boundary.
 * Uses INSERT OR IGNORE to handle duplicates gracefully.
 */
export function insertBlockBoundary(boundary: BlockBoundary): void {
  const db = getDb();

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO block_boundaries
    (channel_id, thread_id, first_message_id, last_message_id, token_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    boundary.channelId,
    boundary.threadId,
    boundary.firstMessageId,
    boundary.lastMessageId,
    boundary.tokenCount,
    boundary.createdAt
  );
}

/**
 * Get all block boundaries for a channel/thread combination.
 * Ordered by ID (chronological order of creation).
 */
export function getBlockBoundaries(
  channelId: string,
  threadId: string | null
): BlockBoundary[] {
  const db = getDb();

  const stmt = db.prepare(`
    SELECT * FROM block_boundaries
    WHERE channel_id = ? AND thread_id IS ?
    ORDER BY id ASC
  `);

  return stmt.all(channelId, threadId) as BlockBoundary[];
}

/**
 * Get the last block boundary for a channel/thread.
 * Returns null if no boundaries exist.
 */
export function getLastBlockBoundary(
  channelId: string,
  threadId: string | null
): BlockBoundary | null {
  const db = getDb();

  const stmt = db.prepare(`
    SELECT * FROM block_boundaries
    WHERE channel_id = ? AND thread_id IS ?
    ORDER BY id DESC
    LIMIT 1
  `);

  const result = stmt.get(channelId, threadId) as BlockBoundary | undefined;
  return result ?? null;
}

/**
 * Delete the oldest N block boundaries for a channel/thread.
 * Used for eviction when total tokens exceed budget.
 */
export function deleteOldestBlockBoundaries(
  channelId: string,
  threadId: string | null,
  count: number
): void {
  if (count <= 0) return;

  const db = getDb();

  // Get IDs of oldest boundaries
  const stmt = db.prepare(`
    SELECT id FROM block_boundaries
    WHERE channel_id = ? AND thread_id IS ?
    ORDER BY id ASC
    LIMIT ?
  `);

  const boundaries = stmt.all(channelId, threadId, count) as { id: number }[];
  const ids = boundaries.map((b) => b.id);

  if (ids.length === 0) return;

  // Delete them
  const deleteStmt = db.prepare(`
    DELETE FROM block_boundaries
    WHERE id IN (${ids.map(() => '?').join(',')})
  `);

  deleteStmt.run(...ids);
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Get database statistics.
 * Useful for debugging and monitoring.
 */
export function getDatabaseStats(): {
  messageCount: number;
  boundaryCount: number;
  channelCount: number;
  threadCount: number;
  databaseSizeBytes: number;
} {
  const db = getDb();

  const messageCount = (db.prepare('SELECT COUNT(*) as count FROM messages').get() as { count: number }).count;
  const boundaryCount = (db.prepare('SELECT COUNT(*) as count FROM block_boundaries').get() as { count: number }).count;
  const channelCount = (db.prepare('SELECT COUNT(DISTINCT parent_channel_id) as count FROM messages').get() as { count: number }).count;
  const threadCount = (db.prepare('SELECT COUNT(DISTINCT thread_id) as count FROM messages WHERE thread_id IS NOT NULL').get() as { count: number }).count;

  let databaseSizeBytes = 0;
  try {
    const stats = fs.statSync(DB_PATH);
    databaseSizeBytes = stats.size;
  } catch (err) {
    // File might not exist yet
  }

  return {
    messageCount,
    boundaryCount,
    channelCount,
    threadCount,
    databaseSizeBytes,
  };
}

/**
 * Vacuum the database to reclaim space.
 * Should be called periodically (e.g., on startup).
 */
export function vacuumDatabase(): void {
  const db = getDb();
  console.log('[Database] Running VACUUM...');
  db.exec('VACUUM');
  console.log('[Database] VACUUM complete');
}

/**
 * Clear all data from the database.
 * DANGEROUS: Only use for testing or reset scenarios.
 */
export function clearAllData(): void {
  const db = getDb();

  db.transaction(() => {
    db.exec('DELETE FROM messages');
    db.exec('DELETE FROM block_boundaries');
  })();

  console.log('[Database] All data cleared');
}
