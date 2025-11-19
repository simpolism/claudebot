# ClaudeBot Development Context

## Optimization Priorities (IN ORDER)

1. **Reply latency** - Bot responds as quickly as possible
2. **Maximize conversation history** - Always include as much context as possible up to MAX_CONTEXT_TOKENS; never drop data arbitrarily, never fetch only the beginning
3. **Cost efficiency** - Correct Anthropic prompt caching; don't recache on restart
4. **Simplicity/elegance** - Clean, understandable code

Discord API call efficiency is NOT a priority. Don't optimize for it.

## Critical Understanding: Persistent Cache Purpose

**SQLite (`claude-cache.sqlite`) is now the single source of truth for cached history.**

When the server restarts:
1. Every stored Discord message plus its block boundary metadata already lives in SQLite.
2. Startup hydrates memory directly from SQLite *before* hitting Discord.
3. The same message text is reformatted under the same boundaries, so Anthropic sees byte-identical cached blocks and never forces a recache.

SQLite is not a general analytics store; it only tracks raw Discord payloads, block boundaries, and reset metadata. Message text still comes from Discord for live updates, but the database guarantees cache-stable transcripts across restarts without a parallel JSON path.

## Historical Context

**Master branch used SQLite** (`better-sqlite3`):
- Stored full messages in `claude-cache.sqlite`
- Schema: `messages` table with (channel_id, role, author_id, content, created_at)
- Queried recent messages with SQL
- Simple and correct

**A later branch replaced SQLite with a JSON cache**, which introduced split sources of truth and made cached block reconstruction fragile. We've now returned to SQLite as the canonical persistence layer so block boundaries and transcripts never drift across restarts.

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
- Storage: Raw message data (authorId, authorName, content) stored in memory and persisted via SQLite
- Formatting: Done at query time using botDisplayName for bot's own messages
- Persistence: SQLite holds both messages and block boundaries; no JSON cache path remains
- OpenAI transcript role: Prefer assistant role with prefill appended (single `\n` before prefill), unless images need user content blocks
- Fragmentation guard: Uses actual Discord usernames from message store, not text parsing
- No thread support: Only operates in channels explicitly listed in `MAIN_CHANNEL_IDS`
