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
exports.insertBlockBoundary = insertBlockBoundary;
exports.getBlockBoundaries = getBlockBoundaries;
exports.getLastBlockBoundary = getLastBlockBoundary;
exports.deleteOldestBlockBoundaries = deleteOldestBlockBoundaries;
exports.getDatabaseStats = getDatabaseStats;
exports.vacuumDatabase = vacuumDatabase;
exports.clearAllData = clearAllData;
exports.clearThread = clearThread;
exports.clearChannel = clearChannel;
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
// ============================================================================
// Database Instance
// ============================================================================
let db = null;
const DB_PATH = path.join(process.cwd(), 'claude-cache.sqlite');
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
 */
function insertMessage(message) {
    const db = getDb();
    const stmt = db.prepare(`
    INSERT OR IGNORE INTO messages
    (id, channel_id, thread_id, parent_channel_id, author_id, author_name, content, timestamp, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
    stmt.run(message.id, message.channelId, message.threadId, message.parentChannelId, message.authorId, message.authorName, message.content, message.timestamp, message.createdAt);
}
/**
 * Insert multiple messages in a single transaction.
 * Much faster than individual inserts.
 */
function insertMessages(messages) {
    if (messages.length === 0)
        return;
    const db = getDb();
    const insertMany = db.transaction((msgs) => {
        const stmt = db.prepare(`
      INSERT OR IGNORE INTO messages
      (id, channel_id, thread_id, parent_channel_id, author_id, author_name, content, timestamp, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
        for (const msg of msgs) {
            stmt.run(msg.id, msg.channelId, msg.threadId, msg.parentChannelId, msg.authorId, msg.authorName, msg.content, msg.timestamp, msg.createdAt);
        }
    });
    insertMany(messages);
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
    return stmt.all(firstMessageId, lastMessageId);
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
    return stmt.all(channelId, threadId);
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
    return stmt.all(channelId, threadId, lastBoundaryMessageId);
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
// ============================================================================
// Block Boundary Operations
// ============================================================================
/**
 * Insert a block boundary.
 * Uses INSERT OR IGNORE to handle duplicates gracefully.
 */
function insertBlockBoundary(boundary) {
    const db = getDb();
    const stmt = db.prepare(`
    INSERT OR IGNORE INTO block_boundaries
    (channel_id, thread_id, first_message_id, last_message_id, token_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
    stmt.run(boundary.channelId, boundary.threadId, boundary.firstMessageId, boundary.lastMessageId, boundary.tokenCount, boundary.createdAt);
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
    const channelCount = db.prepare('SELECT COUNT(DISTINCT parent_channel_id) as count FROM messages').get().count;
    const threadCount = db.prepare('SELECT COUNT(DISTINCT thread_id) as count FROM messages WHERE thread_id IS NOT NULL').get().count;
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
    })();
    console.log('[Database] All data cleared');
}
/**
 * Clear all messages and boundaries for a specific thread.
 * Used for /reset command in threads.
 */
function clearThread(channelId, threadId) {
    const db = getDb();
    db.transaction(() => {
        db.prepare('DELETE FROM messages WHERE channel_id = ? AND thread_id = ?').run(channelId, threadId);
        db.prepare('DELETE FROM block_boundaries WHERE channel_id = ? AND thread_id = ?').run(channelId, threadId);
    })();
    console.log(`[Database] Cleared thread ${threadId} in channel ${channelId}`);
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
