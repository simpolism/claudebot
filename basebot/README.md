# GPT-2 XL Discord Bot

A simple Discord bot that uses GPT-2 XL for text completion. Supports both direct completion and transcript-based continuation.

## Features

- **Direct Completion Mode**: Complete any text prompt
- **Transcript Continuation Mode**: Complete based on channel conversation history
- **Typing Indicators**: Shows typing while generating
- **Message Queueing**: Processes messages sequentially per channel
- **CPU/GPU Support**: Automatic device detection or manual configuration
- **Guild-wide Operation**: Works in any channel where the bot is mentioned

## Installation

Choose between native Python installation or Docker.

### Option 1: Docker (Recommended)

**Prerequisites:**
- Docker
- Docker Compose (optional, for easier management)
- NVIDIA Docker runtime (for GPU support)

**Setup:**

1. Clone or navigate to this directory:
   ```bash
   cd basebot/
   ```

2. Create a `.env` file from the example:
   ```bash
   cp .env.example .env
   ```

3. Edit `.env` and add your Discord bot token:
   ```env
   DISCORD_TOKEN=your_discord_bot_token_here
   ```

4. Run with Docker Compose:

   **CPU mode:**
   ```bash
   docker compose --profile cpu up -d
   ```

   **GPU mode (requires NVIDIA Docker runtime):**
   ```bash
   docker compose --profile gpu up -d
   ```

**Alternatively, use raw Docker commands:**

Build the image:
```bash
docker build -t gpt2bot .
```

Run CPU version:
```bash
docker run -d --name gpt2bot \
  --env-file .env \
  -e DEVICE=cpu \
  gpt2bot
```

Run GPU version:
```bash
docker run -d --name gpt2bot \
  --env-file .env \
  -e DEVICE=cuda \
  --gpus all \
  gpt2bot
```

**View logs:**
```bash
docker logs -f gpt2bot
# or with compose:
docker compose logs -f
```

**Stop the bot:**
```bash
docker stop gpt2bot
# or with compose:
docker compose --profile cpu down
```

### Option 2: Native Python

**Prerequisites:**
- Python 3.8 or higher
- pip

**Setup:**

1. Clone or navigate to this directory:
   ```bash
   cd basebot/
   ```

2. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```

3. Create a `.env` file from the example:
   ```bash
   cp .env.example .env
   ```

4. Edit `.env` and add your Discord bot token:
   ```env
   DISCORD_TOKEN=your_discord_bot_token_here
   ```

## Configuration

Edit `.env` to configure the bot:

| Variable | Description | Default |
|----------|-------------|---------|
| `DISCORD_TOKEN` | Discord bot token (required) | - |
| `MAX_HISTORY_MESSAGES` | Number of messages to fetch for transcript mode | 100 |
| `MAX_COMPLETION_TOKENS` | Maximum tokens to generate | 100 |
| `DEVICE` | Device for inference: `auto`, `cpu`, or `cuda` | `auto` |

## Usage

### Running the Bot

**With Docker:**
See Installation section above. The bot runs automatically when the container starts.

**With Python:**
```bash
python bot.py
```

The bot will:
1. Load the GPT-2 XL model (this takes a moment on first run)
2. Connect to Discord
3. Listen for mentions in any channel

**Note:** On first run, the bot will download the GPT-2 XL model (~6GB). With Docker, this is cached in a volume and won't be re-downloaded on restarts.

### Interacting with the Bot

The bot operates in two modes:

#### Mode A: Direct Completion

Tag the bot with any text to complete:

```
@GPT2Bot the cat sat on the
```

The bot will complete the text: "the cat sat on the"

#### Mode B: Transcript Continuation

Tag the bot with `.continue` followed by text to continue based on channel history:

```
@GPT2Bot .continue and then she said
```

The bot will:
1. Fetch recent channel messages (up to `MAX_HISTORY_MESSAGES`)
2. Format them as a transcript using display names
3. Append "and then she said" to the end
4. Generate a completion

Example transcript format:
```
Alice: hello everyone
Bob: hi Alice
Alice: how are you?
@GPT2Bot .continue and then she said
```

The prompt sent to GPT-2 will be:
```
Alice: hello everyone
Bob: hi Alice
Alice: how are you?
and then she said
```

## Technical Details

### Model

- **Model**: GPT-2 XL (1.5B parameters)
- **Source**: HuggingFace Transformers
- **Download**: Automatic on first run (~6GB)

### Transcript Format

Messages are formatted horizontally using display names:
```
DisplayName: message content
```

### Performance

- **CPU**: Slower but works on any machine (~10-30s per completion)
- **GPU**: Much faster with CUDA support (~1-5s per completion)
- **Memory**: Requires ~6-8GB RAM for model + overhead

### Message Queueing

The bot processes one message per channel at a time. If multiple users tag the bot simultaneously in the same channel, messages are queued and processed sequentially.

## Troubleshooting

### Model Download Fails

**Native Python:**
```bash
python -c "from transformers import GPT2LMHeadModel, GPT2Tokenizer; GPT2Tokenizer.from_pretrained('gpt2-xl'); GPT2LMHeadModel.from_pretrained('gpt2-xl')"
```

**Docker:**
Check logs for download progress:
```bash
docker logs -f gpt2bot
```

The model cache is persisted in a Docker volume. If download fails, you can restart:
```bash
docker compose restart
```

### CUDA Out of Memory

If you get CUDA OOM errors, set `DEVICE=cpu` in `.env`:
```env
DEVICE=cpu
```

Then restart the container:
```bash
docker compose --profile cpu up -d
```

### Bot Not Responding

Check that:
1. Bot has proper Discord permissions (Read Messages, Send Messages, Read Message History)
2. Message Content intent is enabled in Discord Developer Portal
3. Bot is mentioned correctly (not just replied to)

**Docker-specific checks:**
```bash
# Check if container is running
docker ps | grep gpt2bot

# View logs
docker logs gpt2bot

# Check environment variables
docker exec gpt2bot env | grep DISCORD
```

### Docker GPU Not Working

Ensure NVIDIA Docker runtime is installed:
```bash
# Test GPU access
docker run --rm --gpus all nvidia/cuda:11.8.0-base-ubuntu22.04 nvidia-smi
```

If this fails, install nvidia-docker2:
```bash
# Ubuntu/Debian
sudo apt-get install -y nvidia-docker2
sudo systemctl restart docker
```

## Comparison with Main Bot

This is a simplified version focused on GPT-2 text completion:

| Feature | Main Bot | GPT-2 Bot |
|---------|----------|-----------|
| Language | TypeScript | Python |
| Storage | SQLite | None (live fetch) |
| AI Model | Anthropic/OpenAI/Gemini | GPT-2 XL only |
| Mode | Conversational | Text completion |
| Threads | Supported | No |
| Config | Multi-bot JSON | Simple .env |

## License

Same as parent project.
