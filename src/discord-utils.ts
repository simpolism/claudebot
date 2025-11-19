import type { Client, Message } from 'discord.js';
import { globalConfig } from './config';

export function chunkReplyText(text: string): string[] {
  const limit = globalConfig.discordMessageLimit;

  if (text.length <= limit) {
    return [text];
  }

  const chunks: string[] = [];
  const lines = text.split('\n');
  let currentChunk = '';

  const flushCurrentChunk = () => {
    if (currentChunk.length > 0) {
      chunks.push(currentChunk);
      currentChunk = '';
    }
  };

  const appendSegment = (segment: string) => {
    if (!segment) {
      return;
    }

    if (segment.length > limit) {
      flushCurrentChunk();
      const pieces = splitSegment(segment, limit);
      for (let i = 0; i < pieces.length - 1; i++) {
        chunks.push(pieces[i]);
      }
      currentChunk = pieces[pieces.length - 1];
      return;
    }

    if (currentChunk.length + segment.length > limit && currentChunk.length > 0) {
      flushCurrentChunk();
    }

    currentChunk += segment;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const hasTrailingNewline = i < lines.length - 1;
    const segment = hasTrailingNewline ? `${line}\n` : line;
    appendSegment(segment);
  }

  flushCurrentChunk();
  return chunks;
}

function splitSegment(segment: string, limit: number): string[] {
  const pieces: string[] = [];
  let start = 0;

  while (start < segment.length) {
    pieces.push(segment.slice(start, start + limit));
    start += limit;
  }

  return pieces;
}

export function convertOutputMentions(
  text: string,
  channel: Message['channel'],
  client: Client,
): string {
  if (!channel.isTextBased()) return text;

  const usernameToId = new Map<string, string>();

  client.users.cache.forEach((user) => {
    if (user.username) {
      usernameToId.set(user.username.toLowerCase(), user.id);
    }
    if (user.globalName) {
      usernameToId.set(user.globalName.toLowerCase(), user.id);
    }
  });

  if ('guild' in channel && channel.guild) {
    channel.guild.members.cache.forEach((member) => {
      const { user } = member;
      if (user.username) {
        usernameToId.set(user.username.toLowerCase(), user.id);
      }
      if (member.nickname) {
        usernameToId.set(member.nickname.toLowerCase(), user.id);
      }
      if (user.globalName) {
        usernameToId.set(user.globalName.toLowerCase(), user.id);
      }
    });
  }

  return text.replace(/@(\w+)/g, (match, name) => {
    const id = usernameToId.get(name.toLowerCase());
    return id ? `<@${id}>` : match;
  });
}
