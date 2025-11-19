# Database Schema Design

## Overview

This database replaces the in-memory + JSON file persistence with a single SQLite database that supports:
- Thread-aware message storage
- Block boundary persistence for Anthropic prompt caching
- Efficient queries for parent + thread context
- Migration system for schema evolution

## Schema Version 1

### Table: `messages`

Stores all messages from Discord channels and threads.

```sql
CREATE TABLE messages (
  id TEXT PRIMARY KEY,              -- Discord message ID (snowflake)
  channel_id TEXT NOT NULL,         -- Discord channel ID (parent or thread)
  thread_id TEXT,                   -- NULL for parent channel messages, thread ID for thread messages
  parent_channel_id TEXT NOT NULL,  -- Always points to parent (same as channel_id if not a thread)
  author_id TEXT NOT NULL,          -- Discord user ID
  author_name TEXT NOT NULL,        -- Display name at time of message
  content TEXT NOT NULL,            -- Message content (raw text)
  timestamp INTEGER NOT NULL,       -- Unix timestamp in milliseconds
  created_at INTEGER NOT NULL       -- When this row was inserted (for debugging)
);

-- Index for efficient context queries
CREATE INDEX idx_messages_context ON messages(parent_channel_id, thread_id, timestamp DESC);

-- Index for deduplication checks
CREATE INDEX idx_messages_id ON messages(id);

-- Index for thread-specific queries
CREATE INDEX idx_messages_thread ON messages(channel_id, thread_id, timestamp DESC);
```

**Key design decisions:**
- `thread_id` is NULL for parent channel messages
- `parent_channel_id` denormalizes the parent for fast queries
- `timestamp` is Discord's message timestamp (for ordering)
- `created_at` tracks when we inserted it (for debugging)

### Table: `block_boundaries`

Stores frozen block boundaries for Anthropic prompt caching.

```sql
CREATE TABLE block_boundaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL,         -- Parent channel ID
  thread_id TEXT,                   -- NULL for parent blocks, thread ID for thread blocks
  first_message_id TEXT NOT NULL,   -- Discord message ID of first message in block
  last_message_id TEXT NOT NULL,    -- Discord message ID of last message in block
  token_count INTEGER NOT NULL,     -- Estimated tokens in this block
  created_at INTEGER NOT NULL,      -- When this block was frozen
  UNIQUE(channel_id, thread_id, first_message_id)
);

-- Index for context building (ordered by creation)
CREATE INDEX idx_boundaries_context ON block_boundaries(channel_id, thread_id, id);

-- Index for finding last boundary
CREATE INDEX idx_boundaries_last ON block_boundaries(channel_id, thread_id, last_message_id);
```

**Key design decisions:**
- `thread_id` NULL means parent channel block
- Blocks are ordered by `id` (autoincrement = chronological)
- `UNIQUE` constraint prevents duplicate blocks
- `token_count` stored to avoid recalculating on restart

### Table: `thread_metadata`

Tracks reset boundaries so bots never reload messages that were explicitly cleared.

```sql
CREATE TABLE thread_metadata (
  thread_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,             -- '__GLOBAL__' sentinel when reset applies to every bot
  last_reset_row_id INTEGER NOT NULL,
  last_reset_discord_message_id TEXT,
  last_reset_at INTEGER NOT NULL,
  PRIMARY KEY(thread_id, bot_id)
);
```

**Key design decisions:**
- Resets are recorded per bot; the special bot ID `__GLOBAL__` stores the last universal reset.
- When `getThreadResetInfo(threadId, botId)` runs, it first checks the specific bot’s row and falls back to the `__GLOBAL__` sentinel.
- Storing the Discord message ID lets downtime backfill resume strictly after the `/reset` marker, matching Anthropic cache boundaries byte-for-byte.

### Table: `schema_migrations`

Tracks applied migrations for schema versioning.

```sql
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL,
  description TEXT
);
```

## Query Patterns

### 1. Get context for thread (includes parent blocks)

```sql
-- Get all boundaries (parent + thread)
SELECT * FROM block_boundaries
WHERE channel_id = ?           -- parent channel ID
  AND (thread_id IS NULL       -- parent blocks
       OR thread_id = ?)       -- thread-specific blocks
ORDER BY id;

-- Get messages for a specific block
SELECT * FROM messages
WHERE id >= ? AND id <= ?      -- between first_message_id and last_message_id
ORDER BY timestamp;

-- Get unfrozen tail messages
SELECT * FROM messages
WHERE parent_channel_id = ?    -- parent channel
  AND (thread_id IS ? OR thread_id IS NULL)  -- specific thread or parent
  AND id > ?                   -- after last frozen block
ORDER BY timestamp;
```

### 2. Insert new message

```sql
INSERT OR IGNORE INTO messages
(id, channel_id, thread_id, parent_channel_id, author_id, author_name, content, timestamp, created_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);
```

### 3. Freeze new block

```sql
INSERT INTO block_boundaries
(channel_id, thread_id, first_message_id, last_message_id, token_count, created_at)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(channel_id, thread_id, first_message_id) DO NOTHING;
```

### 4. Get channels with messages (for startup)

```sql
SELECT DISTINCT parent_channel_id FROM messages;
```

### 5. Get threads for a channel

```sql
SELECT DISTINCT thread_id FROM messages
WHERE parent_channel_id = ? AND thread_id IS NOT NULL;
```

## Migration System

Migrations are applied sequentially. Each migration:
1. Checks `schema_migrations` table for current version
2. Applies all migrations > current version
3. Records new version in `schema_migrations`

**Migration 0001: Initial Schema**
- Create `messages` table
- Create `block_boundaries` table
- Create `schema_migrations` table
- Create all indexes

**Future migrations:**
- 0002: Add attachments support
- 0003: Add reaction tracking
- 0004: Add soft delete support

## Performance Considerations

**Write Performance:**
- Use WAL mode: `PRAGMA journal_mode = WAL;`
- Use normal synchronous: `PRAGMA synchronous = NORMAL;`
- Batch inserts in transactions
- Expected: ~1000 inserts/sec

**Read Performance:**
- All queries use indexes
- Context building: 2-3 queries total (boundaries + messages + tail)
- Expected: <5ms for typical context query

**Storage:**
- ~500 bytes per message (avg)
- 100k messages = ~50 MB
- Plus SQLite overhead (~30%)
- Total: ~65 MB per 100k messages

## Why SQLite Replaced `conversation-cache.json`

**JSON cache (legacy):**
```json
{
  "channels": {
    "123": [
      {"firstMessageId": "...", "lastMessageId": "...", "tokenCount": 30000}
    ]
  }
}
```
- Stored only boundaries, no message bodies
- Required manual sync with in-memory state
- Provided no ACID guarantees
- Had no concept of per-thread data or resets

**SQLite (current):**
- Single source of truth for both raw Discord messages and block boundaries
- Thread-aware schemas with reset metadata
- ACID transactions, WAL durability, indexed queries
- Lets us rebuild byte-identical cached blocks on restart without extra JSON plumbing

## Migration Status

The migration is complete:
- `claude-cache.sqlite` now persists every message/block write
- `conversation-cache.json` has been removed from the runtime
- The `USE_DATABASE_STORAGE` feature flag is gone; SQLite is mandatory
- In-memory maps remain as hot caches, but they hydrate exclusively from SQLite on boot and lazily for threads

## Testing Strategy

1. **Unit tests**: Schema creation, migrations, CRUD operations
2. **Integration tests**: Parallel writes, consistency checks
3. **Load tests**: 10k messages, measure query performance
4. **Restart determinism tests**: ensure SQLite-only hydration produces byte-identical cached blocks after process restarts
