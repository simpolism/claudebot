import 'dotenv/config';
import { Client, GatewayIntentBits } from 'discord.js';
import { botConfigs } from '../src/config';

interface VerificationResult {
  name: string;
  success: boolean;
  username?: string;
  error?: string;
  duration: number;
}

async function verifyBot(config: { name: string; discordToken: string }): Promise<VerificationResult> {
  const start = Date.now();

  if (!config.discordToken) {
    return {
      name: config.name,
      success: false,
      error: 'No Discord token configured',
      duration: Date.now() - start,
    };
  }

  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  });

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      client.destroy();
      resolve({
        name: config.name,
        success: false,
        error: 'Connection timeout (10s)',
        duration: Date.now() - start,
      });
    }, 10000);

    client.once('ready', (c) => {
      clearTimeout(timeout);
      const result = {
        name: config.name,
        success: true,
        username: c.user.tag,
        duration: Date.now() - start,
      };
      client.destroy();
      resolve(result);
    });

    client.once('error', (err) => {
      clearTimeout(timeout);
      client.destroy();
      resolve({
        name: config.name,
        success: false,
        error: err.message,
        duration: Date.now() - start,
      });
    });

    client.login(config.discordToken).catch((err) => {
      clearTimeout(timeout);
      client.destroy();
      resolve({
        name: config.name,
        success: false,
        error: err.message || 'Login failed',
        duration: Date.now() - start,
      });
    });
  });
}

async function main(): Promise<void> {
  console.log(`Verifying ${botConfigs.length} bot(s) from bots.json...\n`);

  if (botConfigs.length === 0) {
    console.log('No bots configured in bots.json');
    process.exit(1);
  }

  const results: VerificationResult[] = [];

  // Verify bots sequentially to avoid rate limiting
  for (const config of botConfigs) {
    process.stdout.write(`  ${config.name}... `);
    const result = await verifyBot(config);
    results.push(result);

    if (result.success) {
      console.log(`OK (${result.username}) [${result.duration}ms]`);
    } else {
      console.log(`FAILED: ${result.error} [${result.duration}ms]`);
    }
  }

  console.log('\n--- Summary ---');
  const successful = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;

  console.log(`Total: ${results.length}`);
  console.log(`Success: ${successful}`);
  console.log(`Failed: ${failed}`);

  if (failed > 0) {
    console.log('\nFailed bots:');
    results
      .filter((r) => !r.success)
      .forEach((r) => {
        console.log(`  - ${r.name}: ${r.error}`);
      });
    process.exit(1);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
