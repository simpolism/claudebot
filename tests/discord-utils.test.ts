import { describe, expect, it, afterEach } from 'vitest';
import type { Client, Message } from 'discord.js';
import { chunkReplyText, convertOutputMentions } from '../src/discord-utils';
import { globalConfig } from '../src/config';

const originalLimit = globalConfig.discordMessageLimit;

afterEach(() => {
  globalConfig.discordMessageLimit = originalLimit;
});

function buildClient(
  users: Array<{ id: string; username: string; globalName?: string }>,
) {
  const cache = new Map(
    users.map((user) => [
      user.id,
      {
        id: user.id,
        username: user.username,
        globalName: user.globalName,
      },
    ]),
  );
  return {
    users: {
      cache,
    },
  } as unknown as Client;
}

function buildChannel(
  members: Array<{
    id: string;
    username: string;
    nickname?: string;
    globalName?: string;
  }>,
) {
  const memberCache = new Map(
    members.map((member) => [
      member.id,
      {
        user: {
          id: member.id,
          username: member.username,
          globalName: member.globalName,
        },
        nickname: member.nickname,
      },
    ]),
  );
  return {
    isTextBased: () => true,
    guild: {
      members: {
        cache: memberCache,
      },
    },
  } as unknown as Message['channel'];
}

describe('chunkReplyText', () => {
  it('splits long text at newline boundaries', () => {
    globalConfig.discordMessageLimit = 12;
    const text = ['line-one', 'line-two', 'line-three'].join('\n');
    const chunks = chunkReplyText(text);
    expect(chunks).toEqual(['line-one\n', 'line-two\n', 'line-three']);
  });

  it('falls back to hard splits when a single line exceeds the limit', () => {
    globalConfig.discordMessageLimit = 5;
    const text = 'abcdefghij';
    const chunks = chunkReplyText(text);
    expect(chunks).toEqual(['abcde', 'fghij']);
  });
});

describe('convertOutputMentions', () => {
  it('converts usernames and nicknames to Discord mention ids', () => {
    const client = buildClient([
      { id: '1', username: 'Alice' },
      { id: '2', username: 'Bob', globalName: 'Robert' },
    ]);
    const channel = buildChannel([
      { id: '3', username: 'Charlie', nickname: 'Chaz' },
      { id: '2', username: 'Bob', globalName: 'Robert' },
    ]);

    const converted = convertOutputMentions(
      'Hello @Alice and @Chaz and @Robert',
      channel,
      client,
    );

    expect(converted).toBe('Hello <@1> and <@3> and <@2>');
  });

  it('leaves unmatched handles untouched', () => {
    const client = buildClient([{ id: '1', username: 'Alice' }]);
    const channel = buildChannel([]);
    const converted = convertOutputMentions('Ping @Unknown', channel, client);
    expect(converted).toBe('Ping @Unknown');
  });
});
