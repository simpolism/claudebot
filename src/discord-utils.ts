import type { Client, Message } from 'discord.js';
import { globalConfig } from './config';

export function chunkReplyText(text: string): string[] {
  if (text.length <= globalConfig.discordMessageLimit) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= globalConfig.discordMessageLimit) {
      chunks.push(remaining);
      break;
    }

    let sliceEnd = globalConfig.discordMessageLimit;
    const newlineIndex = remaining.lastIndexOf('\n', sliceEnd);
    const spaceIndex = remaining.lastIndexOf(' ', sliceEnd);
    const breakIndex = Math.max(newlineIndex, spaceIndex);

    if (breakIndex > sliceEnd * 0.5) {
      sliceEnd = breakIndex;
    }

    const chunk = remaining.slice(0, sliceEnd).trimEnd();
    chunks.push(chunk);
    remaining = remaining.slice(sliceEnd).trimStart();
  }

  return chunks;
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
