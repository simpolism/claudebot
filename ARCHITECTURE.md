# ClaudeBot Architecture

This is a **Discord bot framework that treats AI systems as conversation participants**, not tools. The system supports multiple AI bots (using Anthropic Claude or OpenAI-compatible APIs) running simultaneously in a single process, each with independent Discord accounts.

---

## 1. Overall Project Structure

**File Organization:**
```
src/
├── bot.ts              # Main Discord client setup and event handling
├── config.ts           # Configuration management and bot definitions
├── message-store.ts    # In-memory message storage and block management
├── context.ts          # Context building wrapper (thin layer over message-store)
├── providers.ts        # AI provider abstraction (Anthropic/OpenAI)
├── discord-utils.ts    # Discord formatting utilities
└── types.ts            # Shared TypeScript types

conversation-cache.json # Auto-generated, stores block boundaries only
package.json            # Dependencies: discord.js, @anthropic-ai/sdk, openai
```

**Technology Stack:**
- TypeScript + ts-node
- discord.js v14 (Discord integration)
- @anthropic-ai/sdk (Claude API)
- openai package (OpenAI-compatible APIs)
- Vitest for testing

---

## 2. How Bots Come Online

**Entry Point:** `src/bot.ts` (lines 293-347)

**Initialization Flow:**

1. **Startup (`main()`):**
   - Loads block boundaries from disk: `loadBoundariesFromDisk()` (message-store.ts)
   - Logs configuration summary
   - Filters bots with missing tokens

2. **Bot Instance Creation (`createBotInstance()` - lines 139-173):**
   - For each configured bot in `botConfigs` array (config.ts, lines 44-59):
     - Create Discord.js `Client` with required intents/partials
     - Create AI provider (Anthropic or OpenAI) via `createAIProvider()`
     - Configure system prompt and context settings
   - Returns `BotInstance` object containing: config, client, aiProvider

3. **Event Registration (`setupBotEvents()` - lines 175-290):**
   - Registers `ClientReady` event: logs successful login
   - Registers `MessageCreate` event: handles incoming Discord messages

4. **Login Phase (lines 324-341):**
   - Simultaneously login all bot instances with their Discord tokens
   - Uses `Promise.all()` for concurrent logins
   - Exits if any login fails

**Bot Configuration Structure** (`src/config.ts`):
```typescript
export interface BotConfig {
  name: string;                    // Display name
  discordToken: string;            // Discord bot token
  provider: 'anthropic' | 'openai';
  model: string;                   // Model identifier
  supportsImageBlocks?: boolean;
  openaiBaseUrl?: string;          // For OpenAI-compatible endpoints
  openaiApiKey?: string;           // API key for OpenAI provider
  maxContextTokens?: number;       // Per-bot override
  maxTokens?: number;              // Per-bot override
  temperature?: number;            // Per-bot override
}
```

**Global Configuration** (env vars in `.env`):
```ini
MAX_CONTEXT_TOKENS=100000         # Soft budget (key!)
MAX_TOKENS=1024                   # Output limit
TEMPERATURE=1                     # Randomness
APPROX_CHARS_PER_TOKEN=4          # Token estimation
MAIN_CHANNEL_IDS=...              # Whitelist channels (optional)
```

---

## 3. Context Management (Simplified Architecture)

**Files:** `src/message-store.ts` + `src/context.ts`

**Core Concept:** Simple in-memory message list per channel, fragmented into stable blocks for Anthropic caching.

### Message Storage

**In-Memory Structure:**
```typescript
const messagesByChannel = new Map<string, StoredMessage[]>();
const blockBoundaries = new Map<string, BlockBoundary[]>();

interface StoredMessage {
  id: string;
  channelId: string;
  authorId: string;
  authorName: string;  // Discord username
  content: string;
  timestamp: number;
}

interface BlockBoundary {
  firstMessageId: string;
  lastMessageId: string;
  tokenCount: number;
}
```

### Flow

1. **On Startup:**
   - Load block boundaries from disk (`conversation-cache.json`)
   - Fetch history from Discord up to MAX_CONTEXT_TOKENS
   - Freeze history into 30k token blocks
   - Save updated boundaries to disk

2. **On Every MessageCreate:**
   - Append message to in-memory list
   - Check if tail has 30k+ tokens → freeze new block
   - Save boundaries to disk

3. **On Bot Mention (Build Context):**
   - Get frozen blocks (slice by boundaries)
   - Get tail (messages after last block)
   - Format with bot's own name at query time
   - Trim if over budget (remove oldest blocks first, then oldest tail)

**Return Structure:**
```typescript
export type ConversationData = {
  cachedBlocks: string[];    // Frozen blocks with cache_control
  tail: SimpleMessage[];     // Fresh messages (no cache_control)
};
```

### Thread Handling

Threads now get **full parent context** (no arbitrary 50% split):
- Include all parent channel blocks
- Subtract parent tokens from budget
- Thread gets remaining budget for its own messages

---

## 4. Block Freezing & Disk Persistence

**File:** `src/message-store.ts`

### Block Structure

Blocks are defined by boundaries only:

```typescript
interface BlockBoundary {
  firstMessageId: string;
  lastMessageId: string;
  tokenCount: number;
}
```

### Disk Persistence

**Storage:** `conversation-cache.json`
- Stores **only boundaries** (no text)
- Text reconstructed from in-memory messages at runtime

**Example JSON:**
```json
{
  "channels": {
    "channel-123": [
      {
        "firstMessageId": "90",
        "lastMessageId": "200",
        "tokenCount": 30000
      }
    ]
  }
}
```

### Block Freezing

Blocks are frozen when tail accumulates 30k+ tokens:

```typescript
function checkAndFreezeBlocks(channelId: string): void {
  // Find tail start (after last block boundary)
  // Accumulate tokens
  // When >= 30000 tokens: freeze block, save to disk
}
```

**Why freeze at 30k tokens?**
- Large enough for stable Anthropic cache hits
- Small enough to allow context trimming if needed
- Byte-identical across API calls = cost savings

### Startup Block Freezing

On startup, after loading history:

```typescript
function freezeBlocksFromHistory(channelId: string): void {
  // Freeze all complete 30k blocks from loaded history
  // Remaining messages become tail
}
```

This ensures that historical conversations get proper block boundaries for caching.

---

## 5. Message Processing & Response Flow

**Entry Point:** `bot.ts` MessageCreate event (lines 183-289)

**Sequence:**

1. **Scope Check:**
   - Verify message is in allowed channel(s)
   - Check if bot is mentioned

2. **Exchange Tracking:**
   - Track consecutive bot-to-bot messages per channel
   - Reset counter on human message
   - Stop responding after 3 consecutive bot exchanges (line 23: `MAX_CONSECUTIVE_BOT_EXCHANGES`)

3. **Locking:**
   - Use `processingChannels` Set to prevent duplicate responses if bot mentioned multiple times quickly

4. **Context Building (lines 222-228):**
   - Call `buildConversationContext()` with `maxContextTokens` from resolved config
   - Records timing

5. **Typing Indicator (line 234):**
   - Show "typing..." in Discord while processing

6. **Provider Call (lines 236-245):**
   - Send to AI provider via `aiProvider.send()`
   - Provider returns `AIResponse` with text + truncation info

7. **Output Processing (lines 250-268):**
   - Convert `@Username` mentions to Discord pings
   - Split response into chunks (Discord 2000 char limit)
   - Post first chunk as reply, subsequent chunks as separate messages

---

## 6. AI Provider Abstraction

**File:** `src/providers.ts` (427 lines)

### Factory Pattern

```typescript
export function createAIProvider(options: ProviderInitOptions): AIProvider {
  if (normalized === 'openai') {
    return new OpenAIProvider(options);
  }
  return new AnthropicProvider(options);
}
```

### Anthropic Provider

**Class:** `AnthropicProvider` (lines 50-197)

- Uses `@anthropic-ai/sdk`
- Beta header: `'anthropic-beta': 'prompt-caching-2024-07-31'`
- Sends **multiple message blocks** to Claude:
  1. Optional system prompt (with cache control)
  2. Cached conversation blocks (with `cache_control: { type: 'ephemeral' }`)
  3. Fresh tail (no cache)
  4. Image blocks (if present)
  5. **Prefill**: `"BotName:"` to establish who's speaking

**Cache Control Strategy:**
- All cached blocks + system prompt marked with `cache_control.ttl: '1h'`
- Byte-identical cached blocks = cache hits
- Cost savings from reusing stable blocks

### OpenAI Provider

**Class:** `OpenAIProvider` (lines 199-317)

- Uses OpenAI package with configurable `baseURL`
- Supports Groq, OpenAI, or other compatible endpoints
- Different message structure:
  - Can use `image_url` content parts if `supportsImageBlocks: true`
  - Otherwise concatenates everything into text

### Fragmentation Guard

**Class:** `FragmentationGuard` (lines 319-347)

Prevents AI from starting another speaker's line mid-response:

- Builds regex from all detected speakers in conversation
- Pattern: `(?:^|[\r\n])\s*(?:<?\s*)?(name1|name2|name3)\s*>?:`
- Inspects streamed response as it arrives
- If pattern matches mid-stream, truncates before that line
- Prevents outputs like: "Alice: blah\nBob:" where Bob wasn't asked

---

## 7. Thread Handling

**File:** `context.ts`

When a message is in a thread:

1. **Parent Context (FULL budget):**
   - Get all parent channel's cached blocks + tail
   - No arbitrary 50% split anymore
   - Provides complete context on what started the thread

2. **Thread Budget:**
   - Remaining budget after parent context
   - Thread accumulates its own messages normally

3. **Benefits:**
   - Thread responses have maximum parent context
   - Stable parent blocks reused (cache hits!)
   - Thread can see complete channel history

---

## 8. Key Configuration Parameters

**In `.env`:**

| Parameter | Default | Purpose |
|-----------|---------|---------|
| `MAX_CONTEXT_TOKENS` | 100000 | Soft budget for conversation context |
| `MAX_TOKENS` | 4096 | Max output tokens |
| `TEMPERATURE` | 1.0 | Randomness (1.0 = high) |
| `APPROX_CHARS_PER_TOKEN` | 4 | For token estimation |
| `MAIN_CHANNEL_IDS` | (unset) | Whitelist channels (blank = all) |

**In Code:**

- `globalConfig.maxContextTokens`: Soft limit for conversation budget (`config.ts`)
- `globalConfig.discordMessageLimit`: 2000 (Discord's per-message limit)
- `DEFAULT_TOKENS_PER_BLOCK`: 30000 (when to freeze a new cache block) (`message-store.ts`)

---

## 9. Design Philosophy

From README:

- **Minimal scaffolding**: Framework translates Discord ↔ AI API, doesn't dictate behavior
- **Transcript format**: Single `"Name: message"` block per turn, not alternating roles
- **AI agency**: Prefill trick (`BotName:`) establishes "you speak now" without control
- **Multi-mind awareness**: Bots can mention each other, interact naturally
- **Soft budget**: `MAX_CONTEXT_TOKENS` (100k default) is below Claude's max (200k), allowing overflow to keep newest messages

---

## 10. File Locations & Key Functions

| What | Where |
|------|-------|
| Main entry point | `src/bot.ts` - `main()` |
| Bot initialization | `src/bot.ts` - `createBotInstance()` |
| Message handler | `src/bot.ts` - `MessageCreate` event |
| In-memory storage | `src/message-store.ts` - `appendMessage()`, `getContext()` |
| Block freezing | `src/message-store.ts` - `checkAndFreezeBlocks()` |
| Boundary persistence | `src/message-store.ts` - `saveBoundariesToDisk()` |
| History loading | `src/message-store.ts` - `loadHistoryFromDiscord()` |
| Context building | `src/context.ts` - `buildConversationContext()` |
| Speaker list | `src/message-store.ts` - `getChannelSpeakers()` |
| Anthropic provider | `src/providers.ts` - `AnthropicProvider` |
| OpenAI provider | `src/providers.ts` - `OpenAIProvider` |
| Fragmentation guard | `src/providers.ts` - `FragmentationGuard` |
| Config parsing | `src/config.ts` |
| Discord formatting | `src/discord-utils.ts` |

---

## 11. Critical Sequences

**Starting the System:**
1. `main()` loads block boundaries from disk
2. Creates bot instances
3. Sets up event handlers (including MessageCreate append)
4. Logs all bots in simultaneously
5. Waits for `ClientReady` events
6. Loads history from Discord for configured channels
7. Freezes history into 30k blocks

**Responding to a Mention:**
1. `MessageCreate` fires (message already appended to list)
2. Track bot-to-bot exchanges
3. Build context from in-memory list (instant - no fetches!)
4. Get speaker list for fragmentation guard
5. Send to provider (stream response)
6. Convert mentions + chunk reply
7. Post to Discord

**Managing Context:**
1. Slice in-memory list by block boundaries
2. Format messages with bot's own name
3. Trim if over budget
4. Return `{cachedBlocks, tail}`

**Freezing Blocks:**
1. Append message to list
2. Check if tail >= 30k tokens
3. If yes: create boundary (firstId, lastId, tokenCount)
4. Save boundaries to disk
5. Reset accumulator

---

This simplified architecture prioritizes:
1. **Reply latency** - Context from memory, no Discord fetches
2. **Maximum history** - Full context up to budget, no arbitrary drops
3. **Cost efficiency** - Stable blocks for Anthropic cache hits
4. **Simplicity** - Single source of truth, clear data flow
