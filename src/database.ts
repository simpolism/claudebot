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
  rowId?: number; // Database row ID (undefined until inserted, after v2 migration)
  id: string; // Discord message ID
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
  firstMessageId: string; // Keep for JSON backward compatibility
  lastMessageId: string; // Keep for JSON backward compatibility
  firstRowId?: number; // For DB-backed boundaries (after v3 migration)
  lastRowId?: number; // For DB-backed boundaries (after v3 migration)
  tokenCount: number;
  createdAt: number;
}

export interface ThreadResetInfo {
  lastResetRowId: number;
  lastResetAt: number;
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

const DB_PATH = process.env.TEST_DB_PATH
  ? path.join(process.cwd(), process.env.TEST_DB_PATH)
  : path.join(process.cwd(), 'claude-cache.sqlite');

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
  {
    version: 2,
    description: 'Add row_id as stable primary key for messages',
    up: (db: Database.Database) => {
      // Check if migration already applied
      const columns = db.pragma('table_info(messages)') as any[];
      const columnCheck = columns.find((col: any) => col.name === 'row_id');
      if (columnCheck) {
        console.log('[Migration v2] row_id column already exists, skipping');
        return;
      }

      console.log('[Migration v2] Adding row_id to messages table...');

      // Create new table with row_id as primary key
      db.exec(`
        CREATE TABLE messages_new (
          row_id INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT UNIQUE,
          channel_id TEXT NOT NULL,
          thread_id TEXT,
          parent_channel_id TEXT NOT NULL,
          author_id TEXT NOT NULL,
          author_name TEXT NOT NULL,
          content TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        );
      `);

      // Copy existing data, ordered by timestamp to assign row_ids sequentially
      db.exec(`
        INSERT INTO messages_new (id, channel_id, thread_id, parent_channel_id, author_id, author_name, content, timestamp, created_at)
        SELECT id, channel_id, thread_id, parent_channel_id, author_id, author_name, content, timestamp, created_at
        FROM messages
        ORDER BY timestamp ASC;
      `);

      // Drop old table
      db.exec('DROP TABLE messages;');

      // Rename new table
      db.exec('ALTER TABLE messages_new RENAME TO messages;');

      // Recreate indexes
      db.exec(`
        CREATE INDEX idx_messages_context ON messages(parent_channel_id, thread_id, timestamp DESC);
        CREATE INDEX idx_messages_thread ON messages(channel_id, thread_id, timestamp DESC);
        CREATE INDEX idx_messages_row_range ON messages(row_id);
      `);

      console.log('[Migration v2] row_id migration complete');
    },
  },
  {
    version: 3,
    description: 'Add row_id columns to block_boundaries',
    up: (db: Database.Database) => {
      // Check if columns already exist
      const columns = db.pragma('table_info(block_boundaries)') as any[];
      const firstRowIdCheck = columns.find((col: any) => col.name === 'first_row_id');
      if (firstRowIdCheck) {
        console.log('[Migration v3] row_id columns already exist in block_boundaries, skipping');
        return;
      }

      console.log('[Migration v3] Adding row_id columns to block_boundaries...');

      // Add new columns (nullable for existing rows)
      db.exec(`
        ALTER TABLE block_boundaries ADD COLUMN first_row_id INTEGER;
        ALTER TABLE block_boundaries ADD COLUMN last_row_id INTEGER;
      `);

      // Note: Existing boundaries will have NULL row_ids - they'll be regenerated on next freeze
      console.log('[Migration v3] row_id columns added to block_boundaries');
    },
  },
  {
    version: 4,
    description: 'Create thread_metadata table for reset tracking',
    up: (db: Database.Database) => {
      console.log('[Migration v4] Creating thread_metadata table...');

      db.exec(`
        CREATE TABLE IF NOT EXISTS thread_metadata (
          thread_id TEXT PRIMARY KEY,
          last_reset_row_id INTEGER NOT NULL,
          last_reset_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_thread_metadata_reset
          ON thread_metadata(thread_id, last_reset_row_id);
      `);

      console.log('[Migration v4] thread_metadata table created');
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
 * Returns the row_id of the inserted message (or null if duplicate).
 */
export function insertMessage(message: StoredMessage): number | null {
  const db = getDb();

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO messages
    (id, channel_id, thread_id, parent_channel_id, author_id, author_name, content, timestamp, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
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

  // If changes is 0, it was a duplicate (INSERT OR IGNORE)
  if (result.changes === 0) {
    // Fetch existing row_id
    const existing = db.prepare('SELECT row_id FROM messages WHERE id = ?').get(message.id) as { row_id: number } | undefined;
    return existing?.row_id ?? null;
  }

  return result.lastInsertRowid as number;
}

/**
 * Insert multiple messages in a single transaction.
 * Much faster than individual inserts.
 * Returns array of row_ids for inserted messages.
 */
export function insertMessages(messages: StoredMessage[]): number[] {
  if (messages.length === 0) return [];

  const db = getDb();

  const rowIds: number[] = [];

  const insertMany = db.transaction((msgs: StoredMessage[]) => {
    const insertStmt = db.prepare(`
      INSERT OR IGNORE INTO messages
      (id, channel_id, thread_id, parent_channel_id, author_id, author_name, content, timestamp, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const getRowIdStmt = db.prepare('SELECT row_id FROM messages WHERE id = ?');

    for (const msg of msgs) {
      const result = insertStmt.run(
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

      if (result.changes === 0) {
        // Duplicate - fetch existing row_id
        const existing = getRowIdStmt.get(msg.id) as { row_id: number } | undefined;
        if (existing) rowIds.push(existing.row_id);
      } else {
        rowIds.push(result.lastInsertRowid as number);
      }
    }
  });

  insertMany(messages);
  return rowIds;
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

/**
 * Get the last row_id for a channel/thread.
 * Returns null if no messages exist.
 */
export function getLastRowId(channelId: string, threadId: string | null = null): number | null {
  const db = getDb();

  const stmt = db.prepare(`
    SELECT MAX(row_id) as max_row_id
    FROM messages
    WHERE channel_id = ? AND thread_id IS ?
  `);

  const result = stmt.get(channelId, threadId) as { max_row_id: number | null };
  return result.max_row_id;
}

/**
 * Get messages after a specific row_id.
 * Used for loading messages after a reset boundary or for backfilling.
 */
export function getMessagesAfterRow(
  channelId: string,
  afterRowId: number,
  threadId: string | null = null
): StoredMessage[] {
  const db = getDb();

  const stmt = db.prepare(`
    SELECT row_id, id, channel_id, thread_id, parent_channel_id,
           author_id, author_name, content, timestamp, created_at
    FROM messages
    WHERE channel_id = ? AND thread_id IS ? AND row_id > ?
    ORDER BY row_id ASC
  `);

  const rows = stmt.all(channelId, threadId, afterRowId) as any[];
  return rows.map(row => ({
    rowId: row.row_id,
    id: row.id,
    channelId: row.channel_id,
    threadId: row.thread_id,
    parentChannelId: row.parent_channel_id,
    authorId: row.author_id,
    authorName: row.author_name,
    content: row.content,
    timestamp: row.timestamp,
    createdAt: row.created_at,
  }));
}

/**
 * Get messages in a row_id range (for building blocks from row-based boundaries).
 */
export function getMessagesByRowRange(
  firstRowId: number,
  lastRowId: number
): StoredMessage[] {
  const db = getDb();

  const stmt = db.prepare(`
    SELECT row_id, id, channel_id, thread_id, parent_channel_id,
           author_id, author_name, content, timestamp, created_at
    FROM messages
    WHERE row_id >= ? AND row_id <= ?
    ORDER BY row_id ASC
  `);

  const rows = stmt.all(firstRowId, lastRowId) as any[];
  return rows.map(row => ({
    rowId: row.row_id,
    id: row.id,
    channelId: row.channel_id,
    threadId: row.thread_id,
    parentChannelId: row.parent_channel_id,
    authorId: row.author_id,
    authorName: row.author_name,
    content: row.content,
    timestamp: row.timestamp,
    createdAt: row.created_at,
  }));
}

/**
 * Get the Discord message ID for a given row_id.
 * Returns null if row doesn't exist or message was deleted.
 */
export function getDiscordMessageId(rowId: number): string | null {
  const db = getDb();

  const stmt = db.prepare('SELECT id FROM messages WHERE row_id = ?');
  const result = stmt.get(rowId) as { id: string | null } | undefined;
  return result?.id ?? null;
}

// ============================================================================
// Block Boundary Operations
// ============================================================================

/**
 * Insert a block boundary.
 * Uses INSERT OR IGNORE to handle duplicates gracefully.
 * Supports both message ID-based and row ID-based boundaries.
 */
export function insertBlockBoundary(boundary: BlockBoundary): void {
  const db = getDb();

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO block_boundaries
    (channel_id, thread_id, first_message_id, last_message_id, first_row_id, last_row_id, token_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    boundary.channelId,
    boundary.threadId,
    boundary.firstMessageId,
    boundary.lastMessageId,
    boundary.firstRowId ?? null,
    boundary.lastRowId ?? null,
    boundary.tokenCount,
    boundary.createdAt
  );
}

/**
 * Get all block boundaries for a channel/thread.
 * Returns boundaries ordered by creation time.
 */
export function getBoundaries(
  channelId: string,
  threadId: string | null = null
): BlockBoundary[] {
  const db = getDb();

  const stmt = db.prepare(`
    SELECT id, channel_id, thread_id, first_message_id, last_message_id,
           first_row_id, last_row_id, token_count, created_at
    FROM block_boundaries
    WHERE channel_id = ? AND thread_id IS ?
    ORDER BY created_at ASC
  `);

  const rows = stmt.all(channelId, threadId) as any[];
  return rows.map(row => ({
    id: row.id,
    channelId: row.channel_id,
    threadId: row.thread_id,
    firstMessageId: row.first_message_id,
    lastMessageId: row.last_message_id,
    firstRowId: row.first_row_id,
    lastRowId: row.last_row_id,
    tokenCount: row.token_count,
    createdAt: row.created_at,
  }));
}

/**
 * Clear all block boundaries for a channel/thread.
 * Used during /reset.
 */
export function clearBoundaries(
  channelId: string,
  threadId: string | null = null
): void {
  const db = getDb();

  const stmt = db.prepare(`
    DELETE FROM block_boundaries
    WHERE channel_id = ? AND thread_id IS ?
  `);

  stmt.run(channelId, threadId);
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
    db.exec('DELETE FROM thread_metadata');
  })();

  console.log('[Database] All data cleared');
}

// ============================================================================
// Thread Metadata Operations
// ============================================================================

/**
 * Record a thread reset with the last row_id before the reset.
 * Used to prevent reloading pre-reset messages after downtime.
 */
export function recordThreadReset(threadId: string, lastRowId: number): void {
  const db = getDb();

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO thread_metadata
    (thread_id, last_reset_row_id, last_reset_at)
    VALUES (?, ?, ?)
  `);

  stmt.run(threadId, lastRowId, Date.now());
}

/**
 * Get reset information for a thread.
 * Returns null if thread has never been reset.
 */
export function getThreadResetInfo(threadId: string): ThreadResetInfo | null {
  const db = getDb();

  const stmt = db.prepare(`
    SELECT last_reset_row_id, last_reset_at
    FROM thread_metadata
    WHERE thread_id = ?
  `);

  const result = stmt.get(threadId) as any;
  if (!result) return null;

  return {
    lastResetRowId: result.last_reset_row_id,
    lastResetAt: result.last_reset_at,
  };
}

/**
 * Clear thread metadata (used when permanently deleting a thread).
 */
export function clearThreadMetadata(threadId: string): void {
  const db = getDb();

  const stmt = db.prepare('DELETE FROM thread_metadata WHERE thread_id = ?');
  stmt.run(threadId);
}

// ============================================================================
// Channel/Thread Clearing Operations
// ============================================================================

/**
 * Clear all messages and boundaries for a specific thread.
 * Used for /reset command in threads.
 *
 * IMPORTANT: For threads, channel_id in the DB equals the thread ID itself,
 * so we clear where channel_id = threadId (not parentChannelId).
 */
export function clearThread(channelId: string, threadId: string): void {
  const db = getDb();

  db.transaction(() => {
    // For threads: channel_id in DB is the thread's own ID
    // So we delete where channel_id = threadId (which equals channelId parameter)
    db.prepare('DELETE FROM messages WHERE channel_id = ?').run(channelId);
    db.prepare('DELETE FROM block_boundaries WHERE channel_id = ?').run(channelId);
    // Note: thread_metadata is NOT cleared here - we want to preserve reset history
  })();

  console.log(`[Database] Cleared thread ${channelId} (threadId: ${threadId})`);
}

/**
 * Clear all messages and boundaries for a specific channel (not thread).
 * DANGEROUS: This clears the entire channel history.
 */
export function clearChannel(channelId: string): void {
  const db = getDb();

  db.transaction(() => {
    db.prepare('DELETE FROM messages WHERE channel_id = ? AND thread_id IS NULL').run(channelId);
    db.prepare('DELETE FROM block_boundaries WHERE channel_id = ? AND thread_id IS NULL').run(channelId);
  })();

  console.log(`[Database] Cleared channel ${channelId}`);
}
