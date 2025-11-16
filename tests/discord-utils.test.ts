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
  it('splits long text while preserving words where possible', () => {
    globalConfig.discordMessageLimit = 20;
    const text = 'This is a long message that should be split cleanly';
    const chunks = chunkReplyText(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]).toBe('This is a long');
    expect(chunks[1]).toBe('message that should');
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
