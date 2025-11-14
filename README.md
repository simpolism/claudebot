# ClaudeBot (TypeScript)

A lightweight Discord bot built in **TypeScript**, powered by **Anthropic Claude**, with **SQLite-backed per-thread context caching**.

* Responds **only when mentioned** (in both main channel & its threads).
* Each **thread** gets its **own isolated context**.
* Uses **SQLite** as a rolling cache of the last *N* messages per channel/thread.
* Uses **Anthropic prompt caching** to speed up interactions & reduce token usage.
* Minimal external infra — runs locally or on any small VPS.

Perfect for:

* Multi-party LLM interaction experiments
* “Spin up a thread with a fresh context” workflows
* Clean, predictable, low-cost LLM usage
* Local / self-hosted assistant bots

---

## ✨ Features

### **Thread-scoped contexts**

Each Discord thread has a unique conversation history stored in a small SQLite file.
The bot will never leak context between threads.

### **Responds only when tagged**

No spam.
The bot will respond only when someone explicitly mentions it:

```
@ClaudeBot what do you think about...
```

### **SQLite rolling cache**

A local file `claude-cache.sqlite` stores only the last N messages (configurable).
No Discord re-fetching required.

### **Anthropic Prompt Caching**

System prompt (and optionally other long-lived context segments) is cached using Anthropic's prompt-caching beta:

* Faster responses
* Lower token usage
* Cheaper
* More consistent persona/behavior over time

### **Zero external state required**

Runs with:

* Node
* SQLite file
* One `.env` file

---

## 🛠 Requirements

* **Node.js 18+**
* **Discord bot token**
* **Anthropic API key**
* **A single Discord channel** where threads will be created (your “workspace”)

---

## 📦 Installation

```bash
npm install
```

If you haven’t installed dependencies yet:

```bash
npm init -y
npm install discord.js @anthropic-ai/sdk better-sqlite3 dotenv
npm install -D typescript ts-node @types/node @types/better-sqlite3
```

Generate a basic TypeScript config:

```bash
npx tsc --init
```

(or use the provided `tsconfig.json`)

---

## ⚙️ Configuration

Create a `.env` file:

```ini
DISCORD_TOKEN=your-discord-token
MAIN_CHANNEL_ID=123456789012345678
ANTHROPIC_API_KEY=your-anthropic-key

CLAUDE_MODEL=claude-3-5-sonnet-20241022
MESSAGE_CACHE_LIMIT=40
MAX_TOKENS=512
TEMPERATURE=0.7

SYSTEM_PROMPT=You are a helpful, concise assistant in a Discord server.
```

### `MAIN_CHANNEL_ID`

This is the channel where people will start threads.
Each thread under that channel becomes its own Claude context.

### `SYSTEM_PROMPT`

This gets **prompt-cached** on Anthropic’s side, so feel free to make it long.

### CLI Simulation Mode

Set `CLI_SIM_MODE=true` to switch the bot into the classic “CLI simulation” persona from the original **Infinite Backrooms** project. In this mode the bot:

* Sends a CLI-style system prompt (`"The assistant is in CLI simulation mode…"`).
* Injects `<cmd>cat untitled.txt</cmd>` as a *user* message so the latest transcript is framed as terminal output.
* Prefills the assistant reply with `Claude Bot:` to force the model to keep “typing” as the simulated CLI before appending new output.

This trick keeps the conversation hidden inside the faux terminal buffer, which makes some providers more verbose/creative without leaving “CLI mode.” Leave `CLI_SIM_MODE` unset (or false) for normal Discord behavior.

### Inspect cached context

You can inspect exactly what the bot would send to the model for any Discord channel/thread:

```bash
node scripts/inspect-context.cjs <channel_or_thread_id>
```

Add `--raw` to skip trimming so you can see the last `MESSAGE_CACHE_LIMIT` rows straight from `claude-cache.sqlite`. The default view applies the same pruning/token estimates as the live bot, so the output mirrors the real context window. Pass `--plain` to emit the exact stored message text (no numbering/token annotations) in the same order it will be sent upstream.

---

## ▶️ Running the bot

Add to `package.json`:

```json
"scripts": {
  "start": "ts-node src/bot.ts"
}
```

Start the bot:

```bash
npm run start
```

---

## 🧠 How It Works

### **Context Model**

* Key = `channel.id`
* For normal messages in the main channel:

  * Bot replies **only when mentioned**
* For messages inside threads under that channel:

  * Bot replies **only when mentioned**
  * Thread is treated as distinct context

### **SQLite Storage**

We store:

* channel_id
* role (`user` | `assistant`)
* content
* created_at

We keep only the last `MESSAGE_CACHE_LIMIT` messages per context (default: 40).

### **Anthropic Prompt Caching**

Enabled via:

```ts
defaultHeaders: {
  "anthropic-beta": "prompt-caching-2024-07-31"
}
```

The system prompt is sent as:

```ts
{
  type: "text",
  text: SYSTEM_PROMPT,
  cache_control: { type: "ephemeral" }
}
```

Meaning:
Claude can reuse this part of the prompt efficiently as long as it doesn’t change.

---

## 📁 Project Structure

```
.
├── src/
│   └── bot.ts              # Main bot implementation
├── claude-cache.sqlite     # Auto-created SQLite db
├── tsconfig.json
├── package.json
└── README.md
```

---

## 🤝 Extending the bot

You can easily add:

### Slash commands

* `/reset` — clears DB entries for this thread
* `/persona` — swap system prompts stored in DB
* `/stats` — show token usage, thread history size, etc.

### Additional persona modes

Per-thread or per-user personalities.

### Message summarization

Turn long threads into compressed “memory chunks”.

### Tool use

Add arbitrary function-calling behavior or server utilities.

---

## 🧪 Notes & Caveats

* SQLite file grows very slowly due to pruning.
* Token limits still apply — old messages are trimmed in DB already.
* If you change `SYSTEM_PROMPT`, cached prompt segments will reset (expected).
* Do **not** run on huge/multi-thousand-user servers without further rate limiting.

---

## 🚀 Quick Start Summary

1. Clone or drop the files into a folder
2. Install deps
3. Create `.env`
4. Set `MAIN_CHANNEL_ID`
5. Run `npm run start`
6. Mention the bot inside the main channel or any thread under it:

```
@ClaudeBot hello!
```
