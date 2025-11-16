import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ENV_KEYS = ['MAIN_CHANNEL_IDS', 'MAX_CONTEXT_TOKENS', 'MAX_TOKENS', 'TEMPERATURE'];

beforeEach(() => {
  vi.resetModules();
  ENV_KEYS.forEach((key) => {
    delete process.env[key];
  });
});

afterEach(() => {
  ENV_KEYS.forEach((key) => {
    delete process.env[key];
  });
});

describe('config module', () => {
  it('parses MAIN_CHANNEL_IDS into trimmed list', async () => {
    process.env.MAIN_CHANNEL_IDS = '12345, 67890 , , ';
    const { globalConfig } = await import('../src/config');
    expect(globalConfig.mainChannelIds).toEqual(['12345', '67890']);
  });

  it('resolveConfig merges global defaults when overrides missing', async () => {
    process.env.MAIN_CHANNEL_IDS = '';
    process.env.MAX_CONTEXT_TOKENS = '64000';
    process.env.MAX_TOKENS = '2048';
    process.env.TEMPERATURE = '0.6';
    const { resolveConfig } = await import('../src/config');

    const baseConfig = {
      name: 'TestBot',
      discordToken: 'token',
      provider: 'anthropic' as const,
      model: 'claude-haiku',
    };

    const resolved = resolveConfig(baseConfig);
    expect(resolved.maxContextTokens).toBe(64000);
    expect(resolved.maxTokens).toBe(2048);
    expect(resolved.temperature).toBe(0.6);
  });

  it('resolveConfig respects per-bot overrides', async () => {
    process.env.MAIN_CHANNEL_IDS = '1';
    process.env.MAX_CONTEXT_TOKENS = '64000';
    process.env.MAX_TOKENS = '2048';
    process.env.TEMPERATURE = '0.6';
    const { resolveConfig } = await import('../src/config');

    const baseConfig = {
      name: 'TestBot',
      discordToken: 'token',
      provider: 'anthropic' as const,
      model: 'claude-haiku',
      maxContextTokens: 32000,
      maxTokens: 1024,
      temperature: 0.9,
    };

    const resolved = resolveConfig(baseConfig);
    expect(resolved.maxContextTokens).toBe(32000);
    expect(resolved.maxTokens).toBe(1024);
    expect(resolved.temperature).toBe(0.9);
  });
});
