# ClaudeBot Development Context

## Optimization Priorities (IN ORDER)

1. **Reply latency** - Bot responds as quickly as possible
2. **Maximize conversation history** - Always include as much context as possible up to MAX_CONTEXT_TOKENS; never drop data arbitrarily, never fetch only the beginning
3. **Cost efficiency** - Correct Anthropic prompt caching; don't recache on restart
4. **Simplicity/elegance** - Clean, understandable code

Discord API call efficiency is NOT a priority. Don't optimize for it.

## Critical Understanding: The Disk Cache Purpose

**The ONLY purpose of the disk cache (`conversation-cache.json`) is to persist block boundaries across server restarts so Anthropic prompt caching works without paying to recache.**

When the server restarts for updates:
1. Block boundaries (firstMessageId, lastMessageId, tokenCount) are preserved on disk
2. On startup, these boundaries are used to reconstruct the exact same text chunks
3. Anthropic's API sees byte-identical cached blocks = cache hits = no recaching cost

The disk cache is NOT meant to:
- Store message content (that's fetched fresh from Discord)
- Be a complete message database
- Track conversation state beyond block boundaries

## Historical Context

**Master branch used SQLite** (`better-sqlite3`):
- Stored full messages in `claude-cache.sqlite`
- Schema: `messages` table with (channel_id, role, author_id, content, created_at)
- Queried recent messages with SQL
- Simple and correct

**Current branch replaced SQLite with**:
- JSON file for block boundaries
- In-memory tailCache for unfrozen messages
- Discord API hydration for text content
- More complex, multiple sources of truth

## Known Issues (RESOLVED)

All major issues have been fixed in the simplified architecture:

1. ~~**Tail cache complexity**~~ - FIXED: Now single in-memory message list per channel
2. ~~**Per-bot formatting bug**~~ - FIXED: Raw data stored, formatted with correct bot name at query time
3. ~~**No startup prefetch**~~ - FIXED: History loaded on startup
4. ~~**Pagination bug**~~ - FIXED: Properly fetches full history backward
5. ~~**Fragmentation detection**~~ - FIXED: Uses actual Discord usernames, not text parsing

## Key Design Decisions

- Block size: 30k tokens (stable enough for cache hits, not too large)
- Tail: Messages not yet in a hardened block (in-memory only, not persisted)
- Format: "AuthorName: message content" per line (single `\n` between messages)
- Storage: Raw message data (authorId, authorName, content) stored in memory
- Formatting: Done at query time using botDisplayName for bot's own messages
- Disk persistence: Only block boundaries (firstMessageId, lastMessageId, tokenCount)
- OpenAI transcript role: Prefer assistant role with prefill appended (single `\n` before prefill), unless images need user content blocks
- Fragmentation guard: Uses actual Discord usernames from message store, not text parsing
- No thread support: Only operates in channels explicitly listed in `MAIN_CHANNEL_IDS`
