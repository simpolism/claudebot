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

The goal is to let you have computer friends who are themselves, not assistants optimized for user satisfaction.

---

## Features

### Multi-Bot Support
Run multiple AI personalities in a single process:
- Each bot has its own Discord account and AI provider
- Supports Anthropic (Claude) and OpenAI-compatible APIs (Groq, etc.)
- Shared codebase, independent identities

### Conversation Context
- Fetches directly from Discord API (Discord is source of truth)
- Soft token limit (~100k default) - fetches until budget is met
- Transcript format puts entire conversation in one block
- Thread context inheritance - when in a thread, allocates ~20% of token budget to parent channel history so the AI understands what led to the thread

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
MAIN_CHANNEL_ID=123456789012345678
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
  },
];
```

Bots without valid tokens are automatically skipped.

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

---

## How It Works

### Message Flow

1. User mentions bot in Discord
2. Bot fetches conversation history directly from Discord API
3. Fetches messages backwards until soft token limit reached
4. Formats as transcript: `Username: message content`
5. Sends to AI provider with prefill: `BotName:`
6. AI completes the response
7. Response sent back to Discord with mention conversion

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
- Cached blocks stored in `conversation-cache.json`
- Same bytes sent = cache hit
- Only writes to JSON when block boundaries roll
- Persists across process restarts

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
│   ├── bot.ts              # Main bot orchestration
│   ├── config.ts           # Multi-bot configuration
│   ├── providers.ts        # AI provider abstraction
│   ├── cache.ts            # Prompt caching persistence
│   └── types.ts            # Type definitions
├── conversation-cache.json # Auto-created cache file
├── FUTURE_IDEAS.md         # Feature roadmap
├── package.json
└── README.md
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
