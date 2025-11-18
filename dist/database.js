"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.initializeDatabase = initializeDatabase;
exports.closeDatabase = closeDatabase;
exports.insertMessage = insertMessage;
exports.insertMessages = insertMessages;
exports.getMessagesInRange = getMessagesInRange;
exports.getMessages = getMessages;
exports.getTailMessages = getTailMessages;
exports.getChannelsWithMessages = getChannelsWithMessages;
exports.getThreadsForChannel = getThreadsForChannel;
exports.messageExists = messageExists;
exports.getLastRowId = getLastRowId;
exports.getMessagesAfterRow = getMessagesAfterRow;
exports.getMessagesByRowRange = getMessagesByRowRange;
exports.getDiscordMessageId = getDiscordMessageId;
exports.insertBlockBoundary = insertBlockBoundary;
exports.getBoundaries = getBoundaries;
exports.clearBoundaries = clearBoundaries;
exports.getBlockBoundaries = getBlockBoundaries;
exports.getLastBlockBoundary = getLastBlockBoundary;
exports.deleteOldestBlockBoundaries = deleteOldestBlockBoundaries;
exports.getDatabaseStats = getDatabaseStats;
exports.vacuumDatabase = vacuumDatabase;
exports.clearAllData = clearAllData;
exports.recordThreadReset = recordThreadReset;
exports.getThreadResetInfo = getThreadResetInfo;
exports.clearThreadMetadata = clearThreadMetadata;
exports.clearThread = clearThread;
exports.clearChannel = clearChannel;
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
// ============================================================================
// Database Instance
// ============================================================================
let db = null;
const DB_PATH = process.env.TEST_DB_PATH
    ? path.join(process.cwd(), process.env.TEST_DB_PATH)
    : path.join(process.cwd(), 'claude-cache.sqlite');
/**
 * Initialize the database connection and run migrations.
 * Safe to call multiple times (idempotent).
 */
function initializeDatabase() {
    if (db) {
        console.log('[Database] Already initialized');
        return;
    }
    console.log(`[Database] Initializing at ${DB_PATH}`);
    // Create database connection
    db = new better_sqlite3_1.default(DB_PATH);
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
function closeDatabase() {
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
function getDb() {
    if (!db) {
        throw new Error('Database not initialized. Call initializeDatabase() first.');
    }
    return db;
}
// ============================================================================
// Migrations
// ============================================================================
const MIGRATIONS = [
    {
        version: 1,
        description: 'Initial schema with messages and block_boundaries',
        up: (db) => {
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
        up: (db) => {
            // Check if migration already applied
            const columns = db.pragma('table_info(messages)');
            const columnCheck = columns.find((col) => col.name === 'row_id');
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
        up: (db) => {
            // Check if columns already exist
            const columns = db.pragma('table_info(block_boundaries)');
            const firstRowIdCheck = columns.find((col) => col.name === 'first_row_id');
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
        up: (db) => {
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
    {
        version: 5,
        description: 'Add last_reset_discord_message_id to thread_metadata',
        up: (db) => {
            console.log('[Migration v5] Adding last_reset_discord_message_id column...');
            // Check if column already exists
            const columns = db.pragma('table_info(thread_metadata)');
            const columnExists = columns.find((col) => col.name === 'last_reset_discord_message_id');
            if (columnExists) {
                console.log('[Migration v5] Column already exists, skipping');
                return;
            }
            // Add column
            db.exec(`
        ALTER TABLE thread_metadata ADD COLUMN last_reset_discord_message_id TEXT;
      `);
            console.log('[Migration v5] Column added successfully');
        },
    },
];
function getCurrentVersion(db) {
    // Check if schema_migrations table exists
    const tableExists = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'`)
        .get();
    if (!tableExists) {
        return 0;
    }
    // Get the highest version
    const result = db
        .prepare('SELECT MAX(version) as version FROM schema_migrations')
        .get();
    return result.version ?? 0;
}
function runMigrations(db) {
    const currentVersion = getCurrentVersion(db);
    const pendingMigrations = MIGRATIONS.filter((m) => m.version > currentVersion);
    if (pendingMigrations.length === 0) {
        console.log(`[Database] Schema up to date (version ${currentVersion})`);
        return;
    }
    console.log(`[Database] Running ${pendingMigrations.length} migration(s) from version ${currentVersion}...`);
    for (const migration of pendingMigrations) {
        console.log(`[Database] Applying migration ${migration.version}: ${migration.description}`);
        db.transaction(() => {
            migration.up(db);
            db.prepare('INSERT INTO schema_migrations (version, applied_at, description) VALUES (?, ?, ?)').run(migration.version, Date.now(), migration.description);
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
function insertMessage(message) {
    const db = getDb();
    const stmt = db.prepare(`
    INSERT OR IGNORE INTO messages
    (id, channel_id, thread_id, parent_channel_id, author_id, author_name, content, timestamp, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
    const result = stmt.run(message.id, message.channelId, message.threadId, message.parentChannelId, message.authorId, message.authorName, message.content, message.timestamp, message.createdAt);
    // If changes is 0, it was a duplicate (INSERT OR IGNORE)
    if (result.changes === 0) {
        // Fetch existing row_id
        const existing = db
            .prepare('SELECT row_id FROM messages WHERE id = ?')
            .get(message.id);
        return existing?.row_id ?? null;
    }
    return result.lastInsertRowid;
}
/**
 * Insert multiple messages in a single transaction.
 * Much faster than individual inserts.
 * Returns array of row_ids for inserted messages.
 */
function insertMessages(messages) {
    if (messages.length === 0)
        return [];
    const db = getDb();
    const rowIds = [];
    const insertMany = db.transaction((msgs) => {
        const insertStmt = db.prepare(`
      INSERT OR IGNORE INTO messages
      (id, channel_id, thread_id, parent_channel_id, author_id, author_name, content, timestamp, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
        const getRowIdStmt = db.prepare('SELECT row_id FROM messages WHERE id = ?');
        for (const msg of msgs) {
            const result = insertStmt.run(msg.id, msg.channelId, msg.threadId, msg.parentChannelId, msg.authorId, msg.authorName, msg.content, msg.timestamp, msg.createdAt);
            if (result.changes === 0) {
                // Duplicate - fetch existing row_id
                const existing = getRowIdStmt.get(msg.id);
                if (existing)
                    rowIds.push(existing.row_id);
            }
            else {
                rowIds.push(result.lastInsertRowid);
            }
        }
    });
    insertMany(messages);
    return rowIds;
}
/**
 * Helper function to map database row to StoredMessage.
 * Converts snake_case column names to camelCase properties.
 */
function mapRowToMessage(row) {
    return {
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
    };
}
/**
 * Get messages in a specific range (for building blocks from boundaries).
 */
function getMessagesInRange(firstMessageId, lastMessageId) {
    const db = getDb();
    // Note: This assumes message IDs are Discord snowflakes (sortable)
    const stmt = db.prepare(`
    SELECT * FROM messages
    WHERE id >= ? AND id <= ?
    ORDER BY timestamp ASC
  `);
    const rows = stmt.all(firstMessageId, lastMessageId);
    return rows.map(mapRowToMessage);
}
/**
 * Get all messages for a channel/thread combination.
 * Ordered by timestamp (oldest first).
 */
function getMessages(channelId, threadId, limit) {
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
    const rows = stmt.all(channelId, threadId);
    return rows.map(mapRowToMessage);
}
/**
 * Get unfrozen tail messages (messages after last boundary).
 */
function getTailMessages(channelId, threadId, lastBoundaryMessageId) {
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
    const rows = stmt.all(channelId, threadId, lastBoundaryMessageId);
    return rows.map(mapRowToMessage);
}
/**
 * Get all distinct parent channel IDs that have messages.
 * Useful for startup to know which channels to load.
 */
function getChannelsWithMessages() {
    const db = getDb();
    const stmt = db.prepare(`
    SELECT DISTINCT parent_channel_id FROM messages
  `);
    const rows = stmt.all();
    return rows.map((r) => r.parent_channel_id);
}
/**
 * Get all thread IDs for a parent channel.
 */
function getThreadsForChannel(parentChannelId) {
    const db = getDb();
    const stmt = db.prepare(`
    SELECT DISTINCT thread_id FROM messages
    WHERE parent_channel_id = ? AND thread_id IS NOT NULL
  `);
    const rows = stmt.all(parentChannelId);
    return rows.map((r) => r.thread_id);
}
/**
 * Check if a message exists in the database.
 */
function messageExists(messageId) {
    const db = getDb();
    const stmt = db.prepare('SELECT 1 FROM messages WHERE id = ? LIMIT 1');
    const result = stmt.get(messageId);
    return result !== undefined;
}
/**
 * Get the last row_id for a channel/thread.
 * Returns null if no messages exist.
 */
function getLastRowId(channelId, threadId = null) {
    const db = getDb();
    const stmt = db.prepare(`
    SELECT MAX(row_id) as max_row_id
    FROM messages
    WHERE channel_id = ? AND thread_id IS ?
  `);
    const result = stmt.get(channelId, threadId);
    return result.max_row_id;
}
/**
 * Get messages after a specific row_id.
 * Used for loading messages after a reset boundary or for backfilling.
 */
function getMessagesAfterRow(channelId, afterRowId, threadId = null) {
    const db = getDb();
    const stmt = db.prepare(`
    SELECT row_id, id, channel_id, thread_id, parent_channel_id,
           author_id, author_name, content, timestamp, created_at
    FROM messages
    WHERE channel_id = ? AND thread_id IS ? AND row_id > ?
    ORDER BY row_id ASC
  `);
    const rows = stmt.all(channelId, threadId, afterRowId);
    return rows.map(mapRowToMessage);
}
/**
 * Get messages in a row_id range (for building blocks from row-based boundaries).
 */
function getMessagesByRowRange(firstRowId, lastRowId) {
    const db = getDb();
    const stmt = db.prepare(`
    SELECT row_id, id, channel_id, thread_id, parent_channel_id,
           author_id, author_name, content, timestamp, created_at
    FROM messages
    WHERE row_id >= ? AND row_id <= ?
    ORDER BY row_id ASC
  `);
    const rows = stmt.all(firstRowId, lastRowId);
    return rows.map(mapRowToMessage);
}
/**
 * Get the Discord message ID for a given row_id.
 * Returns null if row doesn't exist or message was deleted.
 */
function getDiscordMessageId(rowId) {
    const db = getDb();
    const stmt = db.prepare('SELECT id FROM messages WHERE row_id = ?');
    const result = stmt.get(rowId);
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
function insertBlockBoundary(boundary) {
    const db = getDb();
    const stmt = db.prepare(`
    INSERT OR IGNORE INTO block_boundaries
    (channel_id, thread_id, first_message_id, last_message_id, first_row_id, last_row_id, token_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
    stmt.run(boundary.channelId, boundary.threadId, boundary.firstMessageId, boundary.lastMessageId, boundary.firstRowId ?? null, boundary.lastRowId ?? null, boundary.tokenCount, boundary.createdAt);
}
/**
 * Get all block boundaries for a channel/thread.
 * Returns boundaries ordered by creation time.
 */
function getBoundaries(channelId, threadId = null) {
    const db = getDb();
    const stmt = db.prepare(`
    SELECT id, channel_id, thread_id, first_message_id, last_message_id,
           first_row_id, last_row_id, token_count, created_at
    FROM block_boundaries
    WHERE channel_id = ? AND thread_id IS ?
    ORDER BY created_at ASC
  `);
    const rows = stmt.all(channelId, threadId);
    return rows.map((row) => ({
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
function clearBoundaries(channelId, threadId = null) {
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
function getBlockBoundaries(channelId, threadId) {
    const db = getDb();
    const stmt = db.prepare(`
    SELECT * FROM block_boundaries
    WHERE channel_id = ? AND thread_id IS ?
    ORDER BY id ASC
  `);
    return stmt.all(channelId, threadId);
}
/**
 * Get the last block boundary for a channel/thread.
 * Returns null if no boundaries exist.
 */
function getLastBlockBoundary(channelId, threadId) {
    const db = getDb();
    const stmt = db.prepare(`
    SELECT * FROM block_boundaries
    WHERE channel_id = ? AND thread_id IS ?
    ORDER BY id DESC
    LIMIT 1
  `);
    const result = stmt.get(channelId, threadId);
    return result ?? null;
}
/**
 * Delete the oldest N block boundaries for a channel/thread.
 * Used for eviction when total tokens exceed budget.
 */
function deleteOldestBlockBoundaries(channelId, threadId, count) {
    if (count <= 0)
        return;
    const db = getDb();
    // Get IDs of oldest boundaries
    const stmt = db.prepare(`
    SELECT id FROM block_boundaries
    WHERE channel_id = ? AND thread_id IS ?
    ORDER BY id ASC
    LIMIT ?
  `);
    const boundaries = stmt.all(channelId, threadId, count);
    const ids = boundaries.map((b) => b.id);
    if (ids.length === 0)
        return;
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
function getDatabaseStats() {
    const db = getDb();
    const messageCount = db.prepare('SELECT COUNT(*) as count FROM messages').get().count;
    const boundaryCount = db.prepare('SELECT COUNT(*) as count FROM block_boundaries').get().count;
    const channelCount = db
        .prepare('SELECT COUNT(DISTINCT parent_channel_id) as count FROM messages')
        .get().count;
    const threadCount = db
        .prepare('SELECT COUNT(DISTINCT thread_id) as count FROM messages WHERE thread_id IS NOT NULL')
        .get().count;
    let databaseSizeBytes = 0;
    try {
        const stats = fs.statSync(DB_PATH);
        databaseSizeBytes = stats.size;
    }
    catch (err) {
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
function vacuumDatabase() {
    const db = getDb();
    console.log('[Database] Running VACUUM...');
    db.exec('VACUUM');
    console.log('[Database] VACUUM complete');
}
/**
 * Clear all data from the database.
 * DANGEROUS: Only use for testing or reset scenarios.
 */
function clearAllData() {
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
 * Record a thread reset with the last row_id and Discord message ID before the reset.
 * Used to prevent reloading pre-reset messages after downtime.
 */
function recordThreadReset(threadId, lastRowId, lastDiscordMessageId = null) {
    const db = getDb();
    const stmt = db.prepare(`
    INSERT OR REPLACE INTO thread_metadata
    (thread_id, last_reset_row_id, last_reset_discord_message_id, last_reset_at)
    VALUES (?, ?, ?, ?)
  `);
    stmt.run(threadId, lastRowId, lastDiscordMessageId, Date.now());
}
/**
 * Get reset information for a thread.
 * Returns null if thread has never been reset.
 */
function getThreadResetInfo(threadId) {
    const db = getDb();
    const stmt = db.prepare(`
    SELECT last_reset_row_id, last_reset_discord_message_id, last_reset_at
    FROM thread_metadata
    WHERE thread_id = ?
  `);
    const result = stmt.get(threadId);
    if (!result)
        return null;
    return {
        lastResetRowId: result.last_reset_row_id,
        lastResetDiscordMessageId: result.last_reset_discord_message_id,
        lastResetAt: result.last_reset_at,
    };
}
/**
 * Clear thread metadata (used when permanently deleting a thread).
 */
function clearThreadMetadata(threadId) {
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
function clearThread(channelId, threadId) {
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
function clearChannel(channelId) {
    const db = getDb();
    db.transaction(() => {
        db.prepare('DELETE FROM messages WHERE channel_id = ? AND thread_id IS NULL').run(channelId);
        db.prepare('DELETE FROM block_boundaries WHERE channel_id = ? AND thread_id IS NULL').run(channelId);
    })();
    console.log(`[Database] Cleared channel ${channelId}`);
}
