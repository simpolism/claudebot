#!/usr/bin/env python3
"""
GPT-2 XL Discord Bot - Simple text completion bot

Two modes:
1. Direct completion: @bot the cat sat on the -> completes that text
2. Transcript continuation: @bot .continue text -> completes based on channel history + text
"""

import os
import asyncio
from typing import List, Optional
from dotenv import load_dotenv

import discord
from discord import Message
from transformers import GPT2LMHeadModel, GPT2Tokenizer
import torch

# Load environment variables
load_dotenv()

# Configuration
DISCORD_TOKEN = os.getenv('DISCORD_TOKEN')
MAX_HISTORY_MESSAGES = int(os.getenv('MAX_HISTORY_MESSAGES', '100'))
MAX_COMPLETION_TOKENS = int(os.getenv('MAX_COMPLETION_TOKENS', '100'))
DEVICE_MODE = os.getenv('DEVICE', 'auto').lower()

# GPT-2 XL has a 1024 token context window
GPT2_CONTEXT_WINDOW = 1024

# Validate required config
if not DISCORD_TOKEN:
    raise ValueError("DISCORD_TOKEN environment variable is required")

# Initialize Discord client
intents = discord.Intents.default()
intents.message_content = True
intents.guilds = True
client = discord.Client(intents=intents)

# Per-channel processing locks and queues
processing_channels = set()
message_queues = {}

# GPT-2 model globals (loaded on ready)
model = None
tokenizer = None
device = None


def _load_gpt2_model_sync():
    """Load GPT-2 XL model and tokenizer (synchronous, runs in thread)"""
    global model, tokenizer, device

    print("Loading GPT-2 XL model...")
    model_name = "gpt2-xl"

    tokenizer = GPT2Tokenizer.from_pretrained(model_name)
    model = GPT2LMHeadModel.from_pretrained(model_name)

    # Determine device
    if DEVICE_MODE == 'cpu':
        device = 'cpu'
    elif DEVICE_MODE == 'cuda':
        if not torch.cuda.is_available():
            print("WARNING: CUDA requested but not available, falling back to CPU")
            device = 'cpu'
        else:
            device = 'cuda'
    else:  # auto
        device = 'cuda' if torch.cuda.is_available() else 'cpu'

    model.to(device)
    model.eval()  # Set to evaluation mode

    print(f"GPT-2 XL loaded successfully on device: {device}")


async def load_gpt2_model():
    """Load GPT-2 XL model and tokenizer (async wrapper)"""
    # Run in thread pool to avoid blocking event loop
    await asyncio.to_thread(_load_gpt2_model_sync)


def _generate_completion_sync(prompt: str, max_tokens: int = 100) -> str:
    """Generate text completion using GPT-2 XL (synchronous, runs in thread)"""
    if model is None or tokenizer is None:
        return "(Model not loaded)"

    try:
        # Encode prompt
        input_ids = tokenizer.encode(prompt, return_tensors='pt').to(device)

        # Generate completion
        with torch.no_grad():
            output = model.generate(
                input_ids,
                max_new_tokens=max_tokens,
                do_sample=True,
                temperature=0.9,
                top_p=0.95,
                pad_token_id=tokenizer.eos_token_id
            )

        # Decode full output
        full_text = tokenizer.decode(output[0], skip_special_tokens=True)

        # Extract only the generated portion (after the prompt)
        completion = full_text[len(prompt):]

        return completion if completion else "(no completion generated)"

    except Exception as e:
        print(f"Error generating completion: {e}")
        return f"(Error: {str(e)})"


async def generate_completion(prompt: str, max_tokens: int = 100) -> str:
    """Generate text completion using GPT-2 XL (async wrapper)"""
    # Run in thread pool to avoid blocking event loop
    return await asyncio.to_thread(_generate_completion_sync, prompt, max_tokens)


async def fetch_history(channel, max_messages: int) -> List[Message]:
    """Fetch recent message history from channel"""
    messages = []

    try:
        async for message in channel.history(limit=max_messages):
            messages.append(message)

        # Reverse to get chronological order (oldest first)
        messages.reverse()

    except Exception as e:
        print(f"Error fetching history: {e}")

    return messages


def format_transcript(messages: List[Message]) -> str:
    """Format messages as horizontal transcript using display names"""
    lines = []

    for msg in messages:
        # Use display_name (server nickname or username)
        author = msg.author.display_name
        content = msg.content

        # Skip empty messages
        if not content.strip():
            continue

        lines.append(f"{author}: {content}")

    # Join with newlines and add trailing newline
    return "\n".join(lines) + "\n" if lines else ""


def format_message(msg: Message) -> str:
    """Format a single message with display name"""
    return f"{msg.author.display_name}: {msg.content}"


def build_prompt_with_budget(messages: List[Message], prefix: str) -> str:
    """
    Build prompt from messages respecting GPT-2's token budget.
    Uses accumulative approach: adds messages from newest to oldest until budget is reached.

    Args:
        messages: List of Discord messages (oldest to newest)
        prefix: Text to append after history

    Returns:
        Formatted prompt that fits within token budget
    """
    if tokenizer is None:
        # Fallback if tokenizer not loaded
        return prefix

    # Calculate available budget for context (reserve space for completion)
    budget = GPT2_CONTEXT_WINDOW - MAX_COMPLETION_TOKENS

    # Tokenize prefix first
    prefix_text = prefix if prefix else ""
    prefix_tokens = tokenizer.encode(prefix_text)

    if len(prefix_tokens) >= budget:
        # Prefix alone exceeds budget, truncate it
        print(f"WARNING: Prefix ({len(prefix_tokens)} tokens) exceeds budget, truncating")
        prefix_tokens = prefix_tokens[:budget]
        return tokenizer.decode(prefix_tokens, skip_special_tokens=True)

    # Remaining budget for history
    remaining_budget = budget - len(prefix_tokens)

    # Accumulate message tokens from newest to oldest
    history_lines = []
    total_history_tokens = 0

    for msg in reversed(messages):
        # Skip empty messages
        if not msg.content.strip():
            continue

        msg_line = format_message(msg)
        msg_tokens = tokenizer.encode(msg_line + "\n")
        msg_token_count = len(msg_tokens)

        # Check if adding this message would exceed budget
        if total_history_tokens + msg_token_count > remaining_budget:
            break

        # Prepend to history (maintains chronological order)
        history_lines.insert(0, msg_line)
        total_history_tokens += msg_token_count

    # Build final prompt
    history_text = "\n".join(history_lines)
    if history_text:
        history_text += "\n"

    final_prompt = history_text + prefix_text

    # Log token usage
    final_tokens = len(tokenizer.encode(final_prompt))
    print(f"[Token budget] Using {final_tokens}/{budget} context tokens " +
          f"({len(history_lines)} messages + prefix)")

    return final_prompt


def truncate_prompt_to_budget(prompt: str) -> str:
    """
    Truncate a prompt to fit within GPT-2's token budget.
    Used for direct completion mode.

    Args:
        prompt: Raw text prompt

    Returns:
        Truncated prompt that fits within token budget
    """
    if tokenizer is None:
        # Fallback if tokenizer not loaded
        return prompt

    # Calculate available budget for context (reserve space for completion)
    budget = GPT2_CONTEXT_WINDOW - MAX_COMPLETION_TOKENS

    # Tokenize prompt
    input_tokens = tokenizer.encode(prompt)

    if len(input_tokens) <= budget:
        # Prompt fits within budget
        return prompt

    # Truncate from the beginning (keep most recent context)
    print(f"WARNING: Prompt ({len(input_tokens)} tokens) exceeds budget, truncating to {budget} tokens")
    truncated_tokens = input_tokens[-budget:]
    return tokenizer.decode(truncated_tokens, skip_special_tokens=True)


async def process_message(message: Message):
    """Process a single message with GPT-2 completion"""
    try:
        # Extract content without bot mention
        content = message.content

        # Remove bot mention (handles both <@ID> and <@!ID> formats)
        bot_mention = f'<@{client.user.id}>'
        bot_mention_alt = f'<@!{client.user.id}>'
        content = content.replace(bot_mention, '').replace(bot_mention_alt, '').strip()

        # Determine mode and generate completion
        if content.startswith('.continue'):
            # Mode B: Transcript continuation with token budgeting
            prefix = content[len('.continue'):].strip()

            async with message.channel.typing():
                # Fetch channel history
                history = await fetch_history(message.channel, MAX_HISTORY_MESSAGES)

                # Build prompt with accumulative token budgeting
                prompt = build_prompt_with_budget(history, prefix)

                print(f"[Transcript mode] Prompt length: {len(prompt)} chars, prefix: '{prefix[:50]}...'")

                # Generate completion (async, runs in thread pool)
                completion = await generate_completion(prompt, max_tokens=MAX_COMPLETION_TOKENS)
        else:
            # Mode A: Direct completion with token check
            async with message.channel.typing():
                # Truncate prompt if it exceeds token budget
                prompt = truncate_prompt_to_budget(content)

                print(f"[Direct mode] Prompt: '{prompt[:100]}...'")

                # Generate completion (async, runs in thread pool)
                completion = await generate_completion(prompt, max_tokens=MAX_COMPLETION_TOKENS)

        # Send reply
        await message.reply(completion)

        print(f"Completed request from {message.author.display_name} in #{message.channel.name}")

    except Exception as e:
        print(f"Error processing message {message.id}: {e}")
        try:
            await message.add_reaction('⚠️')
        except:
            pass


@client.event
async def on_ready():
    """Called when bot is ready"""
    print(f'Logged in as {client.user.name} (ID: {client.user.id})')
    print(f'Bot is ready and listening in all channels where mentioned')

    # Load GPT-2 model (async, runs in thread pool to avoid blocking event loop)
    await load_gpt2_model()


@client.event
async def on_message(message: Message):
    """Handle incoming messages"""
    # Ignore own messages
    if message.author == client.user:
        return

    # Only respond if bot is mentioned
    if client.user not in message.mentions:
        return

    channel_id = message.channel.id

    # Queue message if already processing this channel
    if channel_id in processing_channels:
        if channel_id not in message_queues:
            message_queues[channel_id] = []
        message_queues[channel_id].append(message)
        print(f"Queued message {message.id} in #{message.channel.name} (queue size: {len(message_queues[channel_id])})")
        return

    # Mark channel as processing
    processing_channels.add(channel_id)

    try:
        # Process current message
        await process_message(message)

        # Process any queued messages
        while channel_id in message_queues and message_queues[channel_id]:
            next_message = message_queues[channel_id].pop(0)
            print(f"Processing queued message {next_message.id} ({len(message_queues[channel_id])} remaining)")
            await process_message(next_message)

    finally:
        # Remove channel from processing set
        processing_channels.discard(channel_id)

        # Clean up empty queue
        if channel_id in message_queues and not message_queues[channel_id]:
            del message_queues[channel_id]


def main():
    """Main entry point"""
    print("Starting GPT-2 XL Discord Bot...")
    print(f"Configuration:")
    print(f"  - Max history messages: {MAX_HISTORY_MESSAGES}")
    print(f"  - Max completion tokens: {MAX_COMPLETION_TOKENS}")
    print(f"  - Device mode: {DEVICE_MODE}")

    try:
        client.run(DISCORD_TOKEN)
    except KeyboardInterrupt:
        print("\nShutting down gracefully...")
    except Exception as e:
        print(f"Fatal error: {e}")
        raise


if __name__ == '__main__':
    main()
