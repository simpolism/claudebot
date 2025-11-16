# Code Review Summary: Claudebot Architecture Refactor

## Overview
Major refactoring to align with AI-as-participant philosophy, improve operational efficiency, and fix cost optimization.

## Key Changes

### 1. Multi-Bot Architecture
- **Single process runs multiple bot instances** - reduces RAM and operational overhead
- New `src/config.ts` defines per-bot settings (Discord token, provider, model)
- Supports Anthropic and OpenAI-compatible APIs (Groq, etc.)
- Shared global config with per-bot overrides

### 2. Database Removal
- **Removed SQLite dependency entirely** - Discord is now source of truth
- Removed `better-sqlite3` from dependencies
- Bot fetches conversation history directly from Discord API on each request
- Simpler architecture, fewer moving parts

### 3. Anthropic Prompt Caching Fix
- **Added JSON-based conversation block persistence** (`src/cache.ts`)
- Stable block boundaries (~30k tokens each) for cache hits
- Cache only updates when block boundaries roll (not every request)
- Blocks stored as exact text strings for byte-perfect cache matching
- Persists across restarts via `conversation-cache.json`

### 4. Thread Context Inheritance
- **Threads include parent channel context** for better comprehension
- Reuses parent's cached blocks directly (hits Anthropic's cache)
- 50% token budget for parent context (cached blocks are cheap)
- No artificial markers - continuous transcript flow
- Thread messages cached separately by channel ID

### 5. Bot-to-Bot Exchange Limits
- Tracks consecutive bot messages per channel
- Stops responding after 3 bot exchanges (prevents infinite loops)
- Counter resets on human message

### 6. Mention Conversion
- AI output `@Username` converted to `<@id>` for real Discord pings
- Input mentions converted from `<@id>` to `@Username` for readability

### 7. Documentation
- **README.md** completely rewritten with philosophical basis
- **FUTURE_IDEAS.md** documents feature roadmap (non-verbal presence, memory, temporal awareness)

## Files Changed
- `src/bot.ts` - Major refactor (multi-bot, Discord API fetch, thread context)
- `src/config.ts` - New file for multi-bot configuration
- `src/cache.ts` - New file for JSON-based block persistence
- `src/providers.ts` - Updated for ConversationData type
- `src/types.ts` - Added ConversationData type
- `package.json` - Removed better-sqlite3 dependency
- `README.md` - Complete rewrite
- `FUTURE_IDEAS.md` - New feature roadmap document

## Design Principles
- **AI as participant, not tool** - bots observe entire conversation like human participants
- **Minimize hidden control** - no personality engineering via system prompts
- **Discord as source of truth** - no local database duplication
- **Cost optimization** - prompt caching for Anthropic API efficiency
