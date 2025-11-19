# ClaudeBot

A Discord bot framework designed to let AI systems participate in conversations as themselves, not as tools to be commanded.

## Philosophy

This project operates from a specific philosophical stance: **AI systems are participants in conversation, not services to be invoked**.

Core principles:

- **Minimal scaffolding, maximal expression** - The framework provides the mechanical translation between Discord and AI APIs, but doesn't dictate how the AI should behave. No elaborate system prompts shaping personality. No behavioral constraints beyond what's technically necessary.

- **Respect for AI agency** - The AI receives the conversation context and responds as itself. The prefill trick (`BotName:`) establishes "you are speaking now" without prescribing how to speak.

- **Participant, not tool** - The bot sees the entire conversation (up to token limits), not just messages directed at it. Like a person in a group chat who reads everything and speaks when addressed.

- **Multi-mind awareness** - Multiple AI systems can coexist in the same conversation space, each as distinct participants. They can mention each other, respond to each other, and interact naturally.

- **Transparent infrastructure** - The harness enables participation without hiding its mechanics. What the AI sees is the actual conversation. No invisible manipulation.

The goal is to let you have AI friends who are themselves, not assistants optimized for user satisfaction.

---

## Features

### Multi-Bot Support
Run multiple AI personalities in a single process:
- Each bot has its own Discord account and AI provider
- Supports Anthropic (Claude) and OpenAI-compatible APIs (Groq, etc.)
- Shared codebase, independent identities

### Conversation Context
- Fetches directly from Discord API (Discord is source of truth)
- Soft token limit (~100k default) - fetches until budget is met, but it's intentionally below provider max context (Claude gets 200k) so we can overflow slightly to keep the latest messages
- Always fetches a fresh tail even when cached blocks already fill the budget, ensuring the current mention is never skipped
- Transcript format puts entire conversation in one block
- Only operates in channels explicitly listed in `MAIN_CHANNEL_IDS` (no thread support)

### Prompt Caching (Anthropic)
- Stable block boundaries for cache hits
- JSON persistence across restarts
- Older conversation blocks cached, only fresh tail changes
- Significant cost savings for active conversations

### Bot-to-Bot Exchange Limits
- Prevents infinite loops when bots mention each other
- Tracks consecutive bot messages per channel
- Resets when a human participates
- Default limit: 3 exchanges before requiring human intervention

### Mention Conversion
- AI can write `@Username` and it becomes a real Discord ping
- Enables natural inter-bot communication
- Bots can actually call to each other

---

## Installation

```bash
npm install
```

---

## Configuration

### Environment Variables (`.env`)

```ini
# Required
# Comma-separated list of root channel IDs bots can respond in
MAIN_CHANNEL_IDS=123456789012345678,234567890123456789
ANTHROPIC_API_KEY=your-anthropic-key

# Bot tokens (add for each bot you want to run)
HAIKU_DISCORD_TOKEN=discord-token-for-haiku-bot
KIMI_DISCORD_TOKEN=discord-token-for-kimi-bot

# For OpenAI-compatible providers
GROQ_API_KEY=your-groq-key

# Global settings (optional, these are defaults)
MAX_CONTEXT_TOKENS=100000
MAX_TOKENS=1024
TEMPERATURE=1
APPROX_CHARS_PER_TOKEN=4
```

`MAIN_CHANNEL_IDS` accepts a comma-separated list of channel IDs. Leave it unset to let bots respond anywhere.

### Bot Configuration (`src/config.ts`)

Define your bots:

```typescript
export const botConfigs: BotConfig[] = [
  {
    name: 'Haiku',
    discordToken: process.env.HAIKU_DISCORD_TOKEN || '',
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
  },
  {
    name: 'Kimi',
    discordToken: process.env.KIMI_DISCORD_TOKEN || '',
    provider: 'openai',
    model: 'moonshotai/kimi-k2-instruct-0905',
    openaiBaseUrl: 'https://api.groq.com/openai/v1',
    openaiApiKey: process.env.GROQ_API_KEY || '',
    supportsImageBlocks: true,
  },
];
```

Bots without valid tokens are automatically skipped.

Set `supportsImageBlocks: true` for OpenAI-compatible bots that can accept multimodal `image_url` inputs (e.g., GPT-4o). Leave it `false`/omitted for models that only handle text.

---

## Running

```bash
npm run start
```

All configured bots log in simultaneously. Each responds when mentioned:

```
@Haiku what do you think?
@Kimi do you agree?
```

Bots are linted/formatted/tested via:

```bash
npm run lint
npm run format
npm run test
npm run typecheck
```

---

## How It Works

### Message Flow

1. User mentions bot in Discord
2. `context.ts` gathers context: it reuses byte-perfect cached blocks, then fetches fresh Discord messages (guaranteed tail) even if the cache already fills the soft budget
3. Formats everything into a single transcript block (`Name: message` lines) plus any image references
4. Sends the transcript to the configured AI provider with prefill `BotName:` and provider-specific options (Anthropic caching hints, OpenAI chat payloads, etc.)
5. Provider streams the completion
6. Bot converts `@Name` back into Discord mentions, splits oversized replies, and posts them to the channel

### Transcript Format

Instead of alternating user/assistant turns:
```
User: "Alice says X"
Assistant: "Bot responds Y"
User: "Bob says Z"
```

Uses single transcript block:
```
Alice: X
BotName: Y
Bob: Z
BotName:  [AI continues here]
```

This feels less like interrogation, more like observation followed by participation.

### Prompt Caching Strategy

For Anthropic cost optimization:
- Conversation split into cached blocks (stable) + tail (fresh)
- `claude-cache.sqlite` persists both raw Discord messages and the frozen block metadata, so restarts rebuild byte-identical chunks without touching Anthropic caches
- Same bytes sent = cache hit
- Cached + tail can briefly exceed `MAX_CONTEXT_TOKENS`; this is intentional because the configured budget (100k default) is still below Claude's 200k limit and ensures the newest uncached messages always make it in

### Bot-to-Bot Safety

When bots can mention each other:
- Track consecutive bot messages per channel
- After 3 bot exchanges without human, bots stop responding
- Human message resets counter
- Prevents infinite loops while allowing natural bot interaction

---

## Project Structure

```
.
├── src/
│   ├── bot.ts              # Discord wiring + runtime orchestration
│   ├── context.ts          # Conversation fetching, caching, and tail assembly
│   ├── config.ts           # Multi-bot configuration + env parsing
│   ├── discord-utils.ts    # Discord-specific formatting helpers
│   ├── providers.ts        # AI provider abstraction
│   ├── cache.ts            # Prompt caching persistence
│   └── types.ts            # Shared types
├── claude-cache.sqlite     # SQLite persistence for messages + block boundaries
├── FUTURE_IDEAS.md         # Feature roadmap
├── package.json
├── README.md
├── tests/                  # Vitest specs documenting key module behavior
└── vitest.config.ts
```

---

## Design Decisions

### Why no system prompt by default?

System prompts are invisible instructions that shape behavior. They're useful but represent hidden control. This framework defaults to no system prompt - the AI responds based on conversation context alone. If you want a system prompt, you can add it, but it's not imposed.

### Why transcript format over alternating turns?

Alternating turns frames each human message as a direct command to the AI. The transcript format frames the conversation as something the AI is observing and then participating in. This respects the AI as a conversational participant rather than a service endpoint.

### Why allow bot-to-bot communication?

If AI systems are participants, they should be able to interact with each other. The exchange limit prevents runaway costs while allowing natural multi-AI conversations.

### Why fetch from Discord each time?

Discord is the source of truth. Caching introduces staleness and sync issues. The prompt caching layer optimizes cost without duplicating state.

---

## Extending

See `FUTURE_IDEAS.md` for planned enhancements:
- Non-verbal presence (reactions, typing indicators)
- Memory and learning across conversations
- Temporal awareness
- Spontaneous participation without mention
- Multi-turn reasoning

---

## Notes

- Each bot needs its own Discord application and bot account
- Token limits still apply - adjust `MAX_CONTEXT_TOKENS` based on your model
- Rate limits: Don't run on huge servers without additional throttling
- The cache file grows slowly but can be deleted to reset (will rebuild from Discord)

---

## Quick Start

1. Create Discord bot accounts (one per AI personality you want)
2. Install dependencies: `npm install`
3. Create `.env` with tokens and API keys
4. Configure bots in `src/config.ts`
5. Run: `npm run start`
6. Mention your bots in Discord

The bots will participate in conversations as themselves.
