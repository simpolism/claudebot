# Agent Operations Notes

## Development Priorities (in order)

1. **Reply latency** — every change should favor the fastest possible turnaround from Discord message to Claude answer.
2. **Maximize conversation history** — always hydrate the largest legal chunk of history up to `MAX_CONTEXT_TOKENS`; never trim early or request only the head of history.
3. **Cost efficiency** — protect Anthropic prompt caching by keeping cache boundaries stable and never forcing unnecessary recache work.
4. **Simplicity & elegance** — prefer clear, boring code flows instead of cleverness.

Discord API efficiency is explicitly *not* a goal; focus on latency/context/cost instead.

## Disk Cache Contract

`conversation-cache.json` exists **only** to remember block boundaries (`firstMessageId`, `lastMessageId`, `tokenCount`) across restarts so Anthropic sees byte-identical cached blocks. It should never try to persist message text, author info, or any other conversation state; message data is always re-fetched from Discord and held in memory.

## Architectural Context

- Legacy SQLite path stored every message in `claude-cache.sqlite` and queried via SQL; the current design dropped that in favor of an in-memory store plus a JSON file for block metadata.
- A single in-memory list per channel now replaces the old tail cache complexity.
- Discord provides raw message payloads (authorId, authorName, content); formatting happens later using `botDisplayName` for the bot’s own entries.
- Startup hydration fetches the full history (with correct backward pagination) so cache chunks can be reconstructed immediately.

## Key Operating Decisions

- **Block size**: fixed 30k-token blocks to get reliable cache hits without huge payloads.
- **Tail handling**: recent, unhardened messages live only in memory; once frozen into a block, only the boundary metadata persists on disk.
- **Formatting**: use `"AuthorName: message"` per line with a single newline separator; assistant-prefill gets exactly one newline before it.
- **Disk persistence**: write and read only the block boundary triplets; never mix in conversation text.
- **Fragmentation guard**: rely on real Discord usernames stored with each message, never text-parsing heuristics.
- **Scope**: bot only watches channels enumerated in `MAIN_CHANNEL_IDS`; thread support is out of scope unless explicitly added.

These notes should be the reflexive checklist anytime you touch ClaudeBot logic: prioritize latency, never compromise cache boundaries, and keep the architecture dull and reliable.
