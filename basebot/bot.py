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


def load_gpt2_model():
    """Load GPT-2 XL model and tokenizer"""
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


def generate_completion(prompt: str, max_tokens: int = 100) -> str:
    """Generate text completion using GPT-2 XL"""
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
            # Mode B: Transcript continuation
            prefix = content[len('.continue'):].strip()

            async with message.channel.typing():
                # Fetch channel history
                history = await fetch_history(message.channel, MAX_HISTORY_MESSAGES)

                # Format as transcript
                transcript = format_transcript(history)

                # Build prompt: transcript + prefix
                prompt = transcript + prefix

                print(f"[Transcript mode] Prompt length: {len(prompt)} chars, prefix: '{prefix[:50]}...'")

                # Generate completion
                completion = generate_completion(prompt, max_tokens=MAX_COMPLETION_TOKENS)
        else:
            # Mode A: Direct completion
            async with message.channel.typing():
                prompt = content

                print(f"[Direct mode] Prompt: '{prompt[:100]}...'")

                # Generate completion
                completion = generate_completion(prompt, max_tokens=MAX_COMPLETION_TOKENS)

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

    # Load GPT-2 model
    load_gpt2_model()


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
