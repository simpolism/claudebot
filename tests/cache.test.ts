import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';

const CACHE_FILE = 'conversation-cache.json';

afterEach(() => {
  if (fs.existsSync(CACHE_FILE)) {
    fs.unlinkSync(CACHE_FILE);
  }
  vi.resetModules();
});

describe('cache persistence', () => {
  it('writes cached blocks to disk when new block is formed', async () => {
    const cache = await import('../src/cache');
    cache.updateCache(
      'channel-1',
      [
        { id: '1', formattedText: 'Alice: hello', tokens: 20000 },
        { id: '2', formattedText: 'Bob: hi', tokens: 20000 },
      ],
      30000,
    );

    expect(fs.existsSync(CACHE_FILE)).toBe(true);
    const written = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8')) as {
      channels: Record<string, unknown>;
    };
    expect(written.channels['channel-1']).toBeDefined();
  });

  it('loads cached blocks from disk', async () => {
    const payload = {
      channels: {
        'channel-2': {
          blocks: [{ text: 'Alice: hi', lastMessageId: '3', tokenCount: 100 }],
        },
      },
    };
    fs.writeFileSync(CACHE_FILE, JSON.stringify(payload, null, 2));
    const cache = await import('../src/cache');
    cache.loadCache();
    const blocks = cache.getCachedBlocks('channel-2');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.text).toBe('Alice: hi');
  });
});
