# ClaudeBot Architecture

This is a **Discord bot framework that treats AI systems as conversation participants**, not tools. The system supports multiple AI bots (using Anthropic Claude or OpenAI-compatible APIs) running simultaneously in a single process, each with independent Discord accounts.

---

## 1. Overall Project Structure

**File Organization:**
```
src/
├── bot.ts              # Main Discord client setup and event handling (347 lines)
├── config.ts           # Configuration management and bot definitions (84 lines)
├── context.ts          # Context fetching, caching assembly, tail management (492 lines)
├── cache.ts            # Prompt cache persistence to JSON (166 lines)
├── providers.ts        # AI provider abstraction (Anthropic/OpenAI) (427 lines)
├── discord-utils.ts    # Discord formatting utilities (72 lines)
└── types.ts            # Shared TypeScript types (35 lines)

conversation-cache.json # Auto-generated, stores cache metadata
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
   - Loads conversation cache from disk: `loadCache()` (cache.ts)
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

## 3. Context Fetching Mechanism & MAX_CONTEXT_TOKENS

**File:** `src/context.ts` (492 lines)

**Core Concept:** Context is split into **stable cached blocks** (for cost savings) + **fresh tail** (latest messages).

### Context Building Flow

**Entry Point:** `buildConversationContext()` (lines 168-325)

```typescript
export async function buildConversationContext(params: {
  channel: Message['channel'];
  maxContextTokens: number;        // The budget!
  client: Client;
  botDisplayName: string;
  cacheAccess?: CacheAccess;       // Injected for testing
  fetchMessages?: MessageFetcher;  // Injected for testing
}): Promise<ConversationData>
```

### MAX_CONTEXT_TOKENS Usage

1. **Budget Allocation (lines 189-222):**
   - If in a **thread**: allocates ~50% to parent channel history, 50% to thread
   - Uses constant `PARENT_CONTEXT_RATIO = 0.5`
   - Parent context is cheap (already cached blocks)

2. **Token Tracking (lines 232-246):**
   - Calculates tokens used by existing cached blocks
   - Sets fetch budget: `Math.max(threadBudget, GUARANTEED_TAIL_TOKENS)`
   - **GUARANTEED_TAIL_TOKENS = 8000** (lines 19): ensures fresh tail never skipped
   - Fetch budget = max of remaining budget OR guaranteed tail

3. **Fetch Operation (lines 247-253):**
   - Calls `fetchMessagesAfter()` with computed token budget
   - Fetches new messages from Discord after the last cached message

4. **Tail Assembly (lines 268-307):**
   - Combines:
     - Previously cached tail messages (from `tailCache` in-memory)
     - Fresh messages from current fetch
   - Trims tail to fit: `maxTailTokens = Math.max(threadBudget - channelCachedTokens, GUARANTEED_TAIL_TOKENS)`
   - Removes oldest messages from tail if over budget

**Return Structure:**
```typescript
export type ConversationData = {
  cachedBlocks: string[];    // Pre-formatted stable blocks (should cache)
  tail: SimpleMessage[];     // Fresh messages (variable, not cached)
};
```

### Message Fetching

**Function:** `fetchMessagesAfter()` (lines 355-423)

- Fetches up to 100 messages at a time from Discord
- Stops when token budget is met OR no more messages available
- Formats each message: `"Author: content"`
- Estimates tokens: `text.length / approxCharsPerToken`

**Key Detail:** This always fetches a fresh tail even if cached blocks already fill the budget, ensuring the current mention never gets skipped.

---

## 4. Context Blocks & Rolling

**File:** `src/cache.ts` (166 lines)

### Block Structure

```typescript
export interface CachedBlock {
  text?: string;              // Full formatted text (can be undefined!)
  firstMessageId: string;     // Range marker
  lastMessageId: string;      // Range marker
  tokenCount: number;         // Estimated token count
}

interface ChannelCache {
  blocks: CachedBlock[];      // Array of blocks
  lastProcessedId: string | null;
}
```

### Block Persistence

**Storage:** `conversation-cache.json` (auto-created)
- Stores only metadata (message ID boundaries + token counts)
- **Does NOT store text** on disk (text field omitted)
- Text is hydrated on-demand from Discord API at startup

**Example JSON:**
```json
{
  "channels": {
    "channel-123": {
      "blocks": [
        {
          "firstMessageId": "90",
          "lastMessageId": "200",
          "tokenCount": 30000
        }
      ],
      "lastProcessedId": "200"
    }
  }
}
```

### Block Rolling (Creating New Blocks)

**Function:** `updateCache()` (lines 98-154)

Blocks are created when they accumulate enough tokens:

```typescript
export function updateCache(
  channelId: string,
  newMessages: Array<{ id: string; formattedText: string; tokens: number }>,
  tokensPerBlock: number = DEFAULT_TOKENS_PER_BLOCK,  // 30000
): void
```

1. **Accumulation Phase:**
   - Iterate through new messages
   - Accumulate text + tokens
   - Track first and last message ID of the accumulating block

2. **Roll Trigger (lines 127-142):**
   - When accumulated tokens >= `DEFAULT_TOKENS_PER_BLOCK` (30000 tokens):
     - Create new block with boundaries + token count
     - Push to `channelCache.blocks`
     - **Save JSON to disk**
     - Reset accumulator for next block

3. **Tail Remains Uncached:**
   - Messages that don't fill a block stay in the "fresh tail"
   - Will be cached on the NEXT roll

4. **Caching Strategy Benefit:**
   - Old blocks: byte-identical, hit Anthropic's prompt cache
   - New tail: changes frequently, sent fresh each time
   - Cost optimization: cache hits on stable blocks

### Text Hydration

**Function:** `hydrateCachedBlockTexts()` (lines 36-60)

When blocks are loaded from cache:

1. Block has `firstMessageId` and `lastMessageId` boundaries
2. But `text` field is undefined
3. On first use, fetch Discord messages in that range
4. Reconstruct the exact formatted text
5. Assign back to `block.text`

**Why?** Saves disk space and keeps cache metadata tiny. Actual text is reconstructed from Discord's API.

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

**File:** `context.ts` (lines 189-219)

When a message is in a thread:

1. **Parent Context (50% of budget):**
   - Get parent channel's cached blocks
   - Allocate ~50% of tokens to parent history
   - Provides context on what started the thread

2. **Thread Budget:**
   - Remaining 50% for current thread messages

3. **Benefits:**
   - Thread responses aware of parent channel topic
   - Stable parent blocks reused (cache hits!)
   - Thread can see why the conversation started

**Example Test:** `context.test.ts` lines 279-340

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

**In Code (`config.ts`):**

- `globalConfig.maxContextTokens`: Soft limit for conversation budget
- `globalConfig.discordMessageLimit`: 2000 (Discord's per-message limit)
- `GUARANTEED_TAIL_TOKENS`: 8000 (always fetch at least this much fresh)
- `DEFAULT_TOKENS_PER_BLOCK`: 30000 (when to roll a new cache block)
- `PARENT_CONTEXT_RATIO`: 0.5 (50% budget for parent in threads)

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

| What | Where | Lines |
|------|-------|-------|
| Main entry point | `src/bot.ts` | 293-347 |
| Bot initialization | `src/bot.ts` | 139-173 |
| Message handler | `src/bot.ts` | 183-289 |
| Context building | `src/context.ts` | 168-325 |
| Message fetching | `src/context.ts` | 355-423 |
| Cache persistence | `src/cache.ts` | 98-154 |
| Cache loading | `src/cache.ts` | 26-59 |
| Anthropic provider | `src/providers.ts` | 50-197 |
| OpenAI provider | `src/providers.ts` | 199-317 |
| Config parsing | `src/config.ts` | 24-84 |
| Discord formatting | `src/discord-utils.ts` | 4-72 |

---

## 11. Critical Sequences

**Starting the System:**
1. `main()` loads cache
2. Creates bot instances
3. Sets up event handlers
4. Logs all in simultaneously
5. Waits for `ClientReady` events

**Responding to a Mention:**
1. `MessageCreate` event fires
2. Track bot exchanges
3. Build context (fetch + cache assembly)
4. Send to provider (stream response)
5. Convert mentions + chunk reply
6. Post to Discord

**Managing Context:**
1. Load cached blocks from metadata
2. Hydrate text from Discord if needed
3. Fetch fresh tail with guaranteed minimum
4. Trim tail to fit remaining budget
5. Return `{cachedBlocks, tail}`

**Rolling Blocks:**
1. Accumulate new messages
2. When 30k tokens reached, create block
3. Save block metadata to JSON
4. Reset accumulator
5. Next block starts fresh

---

This architecture elegantly balances **cost optimization** (prompt caching), **conversation context** (multi-message history), and **natural interaction** (transcript format, mention conversion, bot-to-bot safety).
