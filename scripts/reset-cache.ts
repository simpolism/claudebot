import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { activeBotConfigs, globalConfig } from '../src/config';
import { initializeDatabase, closeDatabase } from '../src/database';
import { loadHistoryFromDiscord } from '../src/message-store';

async function main() {
  if (activeBotConfigs.length === 0) {
    console.error('No active bot configurations available. Check bots.json/env vars.');
    process.exit(1);
  }

  if (globalConfig.mainChannelIds.length === 0) {
    console.error('MAIN_CHANNEL_IDS is empty. Set it before running this script.');
    process.exit(1);
  }

  const dbPath = path.join(process.cwd(), 'claude-cache.sqlite');
  backupExistingDatabase(dbPath);

  console.log('[Reset] Initializing fresh SQLite database...');
  initializeDatabase();

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel, Partials.Message],
  });

  const primaryBot = activeBotConfigs[0];
  console.log(`[Reset] Logging into Discord as ${primaryBot.name} for refill...`);

  try {
    await client.login(primaryBot.discordToken);
  } catch (err) {
    console.error('[Reset] Failed to login to Discord:', err);
    await client.destroy();
    closeDatabase();
    process.exit(1);
  }

  try {
    console.log(
      `[Reset] Refilling cache for ${globalConfig.mainChannelIds.length} configured channel(s)...`,
    );
    await loadHistoryFromDiscord(
      globalConfig.mainChannelIds,
      client,
      globalConfig.maxContextTokens,
    );
    console.log('[Reset] Cache refill complete.');
  } catch (err) {
    console.error('[Reset] Failed during history refill:', err);
  } finally {
    await client.destroy();
    closeDatabase();
  }
}

function backupExistingDatabase(dbPath: string) {
  if (!fs.existsSync(dbPath)) {
    console.log('[Reset] No existing claude-cache.sqlite found, nothing to back up.');
    return;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${dbPath}.${timestamp}.bak`;
  fs.renameSync(dbPath, backupPath);
  console.log(`[Reset] Moved existing database to ${backupPath}`);

  const auxFiles = ['-shm', '-wal'];
  for (const suffix of auxFiles) {
    const auxPath = `${dbPath}${suffix}`;
    if (fs.existsSync(auxPath)) {
      fs.rmSync(auxPath);
      console.log(`[Reset] Removed ${auxPath}`);
    }
  }
}

main().catch((err) => {
  console.error('[Reset] Unexpected error:', err);
  closeDatabase();
  process.exit(1);
});
