import 'dotenv/config';
import { Client, GatewayIntentBits } from 'discord.js';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { GoogleGenAI } from '@google/genai';
import { botConfigs, BotConfig } from '../src/config';

interface VerificationResult {
  name: string;
  discordSuccess: boolean;
  discordUsername?: string;
  discordError?: string;
  discordDuration: number;
  apiSuccess: boolean;
  apiError?: string;
  apiDuration: number;
}

async function verifyDiscord(config: BotConfig): Promise<{
  success: boolean;
  username?: string;
  error?: string;
  duration: number;
}> {
  const start = Date.now();

  if (!config.discordToken) {
    return {
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
        success: false,
        error: 'Connection timeout (10s)',
        duration: Date.now() - start,
      });
    }, 10000);

    client.once('ready', (c) => {
      clearTimeout(timeout);
      const result = {
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
        success: false,
        error: err.message,
        duration: Date.now() - start,
      });
    });

    client.login(config.discordToken).catch((err) => {
      clearTimeout(timeout);
      client.destroy();
      resolve({
        success: false,
        error: err.message || 'Login failed',
        duration: Date.now() - start,
      });
    });
  });
}

async function verifyAnthropicAPI(): Promise<{ success: boolean; error?: string; duration: number }> {
  const start = Date.now();
  try {
    const client = new Anthropic();
    // Use a minimal message to verify API key works
    await client.messages.create({
      model: 'claude-3-haiku-20240307',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
    });
    return { success: true, duration: Date.now() - start };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return { success: false, error: message, duration: Date.now() - start };
  }
}

async function verifyOpenAIAPI(
  baseUrl: string,
  apiKey: string,
  model: string,
): Promise<{ success: boolean; error?: string; duration: number }> {
  const start = Date.now();
  try {
    const client = new OpenAI({
      baseURL: baseUrl,
      apiKey: apiKey,
    });
    // Use a minimal completion to verify API key works
    await client.chat.completions.create({
      model: model,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
    });
    return { success: true, duration: Date.now() - start };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return { success: false, error: message, duration: Date.now() - start };
  }
}

async function verifyGeminiAPI(
  apiKey: string,
  model: string,
): Promise<{ success: boolean; error?: string; duration: number }> {
  const start = Date.now();
  try {
    const genai = new GoogleGenAI({ apiKey });
    // Use a minimal generation to verify API key works
    await genai.models.generateContent({
      model: model,
      contents: 'hi',
    });
    return { success: true, duration: Date.now() - start };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return { success: false, error: message, duration: Date.now() - start };
  }
}

async function verifyAPI(config: BotConfig): Promise<{ success: boolean; error?: string; duration: number }> {
  switch (config.provider) {
    case 'anthropic':
      return verifyAnthropicAPI();

    case 'openai':
      if (!config.openaiApiKey) {
        return { success: false, error: 'No OpenAI API key configured', duration: 0 };
      }
      return verifyOpenAIAPI(
        config.openaiBaseUrl || 'https://api.openai.com/v1',
        config.openaiApiKey,
        config.model,
      );

    case 'gemini':
      if (!config.geminiApiKey) {
        return { success: false, error: 'No Gemini API key configured', duration: 0 };
      }
      return verifyGeminiAPI(config.geminiApiKey, config.model);

    default:
      return { success: false, error: `Unknown provider: ${config.provider}`, duration: 0 };
  }
}

async function main(): Promise<void> {
  // Parse optional bot name filter from command line
  const args = process.argv.slice(2);
  let botFilter: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--bot' || args[i] === '-b') {
      botFilter = args[i + 1] || null;
      break;
    } else if (!args[i].startsWith('-')) {
      botFilter = args[i];
      break;
    }
  }

  let configsToTest = botConfigs;

  if (botFilter) {
    configsToTest = botConfigs.filter((c) => c.name.toLowerCase() === botFilter!.toLowerCase());
    if (configsToTest.length === 0) {
      console.error(`Bot "${botFilter}" not found in bots.json`);
      console.log('Available bots:', botConfigs.map((c) => c.name).join(', '));
      process.exit(1);
    }
  }

  console.log(`Verifying ${configsToTest.length} bot(s) from bots.json...\n`);

  if (configsToTest.length === 0) {
    console.log('No bots configured in bots.json');
    process.exit(1);
  }

  const results: VerificationResult[] = [];

  // Verify bots sequentially to avoid rate limiting
  for (const config of configsToTest) {
    console.log(`${config.name}:`);

    // Verify Discord
    process.stdout.write(`  Discord... `);
    const discordResult = await verifyDiscord(config);
    if (discordResult.success) {
      console.log(`OK (${discordResult.username}) [${discordResult.duration}ms]`);
    } else {
      console.log(`FAILED: ${discordResult.error} [${discordResult.duration}ms]`);
    }

    // Verify API
    process.stdout.write(`  ${config.provider} API... `);
    const apiResult = await verifyAPI(config);
    if (apiResult.success) {
      console.log(`OK [${apiResult.duration}ms]`);
    } else {
      console.log(`FAILED: ${apiResult.error} [${apiResult.duration}ms]`);
    }

    results.push({
      name: config.name,
      discordSuccess: discordResult.success,
      discordUsername: discordResult.username,
      discordError: discordResult.error,
      discordDuration: discordResult.duration,
      apiSuccess: apiResult.success,
      apiError: apiResult.error,
      apiDuration: apiResult.duration,
    });

    console.log('');
  }

  console.log('--- Summary ---');
  const fullySuccessful = results.filter((r) => r.discordSuccess && r.apiSuccess).length;
  const discordFailed = results.filter((r) => !r.discordSuccess).length;
  const apiFailed = results.filter((r) => !r.apiSuccess).length;

  console.log(`Total: ${results.length}`);
  console.log(`Fully operational: ${fullySuccessful}`);
  console.log(`Discord failures: ${discordFailed}`);
  console.log(`API failures: ${apiFailed}`);

  const hasFailures = discordFailed > 0 || apiFailed > 0;

  if (hasFailures) {
    console.log('\nIssues:');
    results.forEach((r) => {
      const issues: string[] = [];
      if (!r.discordSuccess) issues.push(`Discord: ${r.discordError}`);
      if (!r.apiSuccess) issues.push(`API: ${r.apiError}`);
      if (issues.length > 0) {
        console.log(`  ${r.name}:`);
        issues.forEach((issue) => console.log(`    - ${issue}`));
      }
    });
    process.exit(1);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
