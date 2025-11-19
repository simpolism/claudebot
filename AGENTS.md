# Agent Operations Notes

## Development Priorities (in order)

1. **Reply latency** — every change should favor the fastest possible turnaround from Discord message to Claude answer.
2. **Maximize conversation history** — always hydrate the largest legal chunk of history up to `MAX_CONTEXT_TOKENS`; never trim early or request only the head of history.
3. **Cost efficiency** — protect Anthropic prompt caching by keeping cache boundaries stable and never forcing unnecessary recache work.
4. **Simplicity & elegance** — prefer clear, boring code flows instead of cleverness.

Discord API efficiency is explicitly *not* a goal; focus on latency/context/cost instead.

## SQLite Cache Contract

`claude-cache.sqlite` is the **only** persistence layer. Every Discord message and every frozen block boundary is written there so we can rebuild byte-identical cached chunks on reboot without touching Anthropic’s cache. The DB is lean—raw payloads, boundary metadata, and reset markers—but it is authoritative. No JSON cache, no parallel store.

## Architectural Context

- Legacy SQLite path stored every message in `claude-cache.sqlite` and queried via SQL. We briefly experimented with a JSON-only boundary file, but that split-brain design is gone—the database is canonical again.
- A single in-memory list per channel now replaces the old tail cache complexity.
- Discord provides raw message payloads (authorId, authorName, content); formatting happens later using `botDisplayName` for the bot’s own entries.
- Startup hydration loads existing history from SQLite first, then backfills from Discord for any downtime gap so cached chunks remain byte-stable.

## Key Operating Decisions

- **Block size**: fixed 30k-token blocks to get reliable cache hits without huge payloads.
- **Tail handling**: recent, unhardened messages live in memory and, because we persist every message row, they are automatically present in SQLite if we crash mid-tail.
- **Formatting**: use `"AuthorName: message"` per line with a single newline separator; assistant-prefill gets exactly one newline before it.
- **Persistence**: rely exclusively on SQLite for both raw messages and boundary triplets; never re-introduce a JSON cache.
- **Fragmentation guard**: rely on real Discord usernames stored with each message, never text-parsing heuristics.
- **Scope**: bot only watches channels enumerated in `MAIN_CHANNEL_IDS`; thread support is out of scope unless explicitly added.

These notes should be the reflexive checklist anytime you touch ClaudeBot logic: prioritize latency, never compromise cache boundaries, and keep the architecture dull and reliable.
