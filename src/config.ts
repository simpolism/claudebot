import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';

export interface BotConfig {
  name: string;
  discordToken: string;
  provider: 'anthropic' | 'openai' | 'gemini';
  model: string;
  supportsImageBlocks?: boolean;

  // For OpenAI-compatible providers (Groq, etc)
  openaiBaseUrl?: string;
  openaiApiKey?: string;

  // For Gemini provider
  geminiApiKey?: string;
  geminiOutputMode?: 'text' | 'image' | 'both';

  // Per-bot overrides (uses global defaults if not specified)
  maxContextTokens?: number;
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string; // Override global system prompt

  // Use Anthropic-style user message + assistant prefill (for OpenAI-compatible providers)
  useUserAssistantPrefill?: boolean;

  // CLI simulation mode (legacy, can be removed later)
  cliSimMode?: boolean;
}

// JSON file format (env var names instead of actual values)
interface BotConfigJSON {
  name: string;
  discordTokenEnv: string;
  provider: 'anthropic' | 'openai' | 'gemini';
  model: string;
  supportsImageBlocks?: boolean;
  openaiBaseUrl?: string;
  openaiApiKeyEnv?: string;
  geminiApiKeyEnv?: string;
  geminiOutputMode?: 'text' | 'image' | 'both';
  maxContextTokens?: number;
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
  useUserAssistantPrefill?: boolean;
  cliSimMode?: boolean;
}

// Global configuration shared across all bots
function parseMainChannelIds(): string[] {
  const raw = process.env.MAIN_CHANNEL_IDS || '';
  return raw
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

const mainChannelIds = parseMainChannelIds();

export const globalConfig = {
  mainChannelIds,
  maxContextTokens: parseInt(process.env.MAX_CONTEXT_TOKENS || '100000', 10),
  maxTokens: parseInt(process.env.MAX_TOKENS || '4096', 10),
  temperature: parseFloat(process.env.TEMPERATURE || '1'),
  approxCharsPerToken: parseFloat(process.env.APPROX_CHARS_PER_TOKEN || '4'),
  discordMessageLimit: 2000,
};

// Load bot configurations from JSON file
function loadBotConfigsFromJSON(): BotConfig[] {
  const configPath = path.join(process.cwd(), 'bots.json');

  if (!fs.existsSync(configPath)) {
    console.warn(`No bots.json found at ${configPath}, using empty config`);
    return [];
  }

  try {
    const jsonContent = fs.readFileSync(configPath, 'utf-8');
    const jsonConfigs: BotConfigJSON[] = JSON.parse(jsonContent);

    return jsonConfigs.map((jsonConfig) => ({
      name: jsonConfig.name,
      discordToken: process.env[jsonConfig.discordTokenEnv] || '',
      provider: jsonConfig.provider,
      model: jsonConfig.model,
      supportsImageBlocks: jsonConfig.supportsImageBlocks,
      openaiBaseUrl: jsonConfig.openaiBaseUrl,
      openaiApiKey: jsonConfig.openaiApiKeyEnv ? process.env[jsonConfig.openaiApiKeyEnv] || '' : undefined,
      geminiApiKey: jsonConfig.geminiApiKeyEnv ? process.env[jsonConfig.geminiApiKeyEnv] || '' : undefined,
      geminiOutputMode: jsonConfig.geminiOutputMode,
      maxContextTokens: jsonConfig.maxContextTokens,
      maxTokens: jsonConfig.maxTokens,
      temperature: jsonConfig.temperature,
      systemPrompt: jsonConfig.systemPrompt,
      useUserAssistantPrefill: jsonConfig.useUserAssistantPrefill,
      cliSimMode: jsonConfig.cliSimMode,
    }));
  } catch (err) {
    console.error(`Failed to load bots.json:`, err);
    return [];
  }
}

export const botConfigs: BotConfig[] = loadBotConfigsFromJSON();

// Filter out bots without tokens (allows partial configuration)
export const activeBotConfigs = botConfigs.filter((config) => {
  if (!config.discordToken) {
    console.warn(`Bot "${config.name}" has no Discord token, skipping`);
    return false;
  }
  if (config.provider === 'openai' && !config.openaiApiKey) {
    console.warn(
      `Bot "${config.name}" uses OpenAI provider but has no API key, skipping`,
    );
    return false;
  }
  if (config.provider === 'gemini' && !config.geminiApiKey) {
    console.warn(
      `Bot "${config.name}" uses Gemini provider but has no API key, skipping`,
    );
    return false;
  }
  return true;
});

// Resolve per-bot config with global defaults
export function resolveConfig(botConfig: BotConfig) {
  return {
    ...botConfig,
    maxContextTokens: botConfig.maxContextTokens ?? globalConfig.maxContextTokens,
    maxTokens: botConfig.maxTokens ?? globalConfig.maxTokens,
    temperature: botConfig.temperature ?? globalConfig.temperature,
    geminiApiKey: botConfig.geminiApiKey ?? '',
    geminiOutputMode: botConfig.geminiOutputMode ?? 'both',
    systemPrompt: botConfig.systemPrompt ?? '',
  };
}

// Get the maximum context tokens across all active bots
// Used for global block eviction decisions
export function getMaxBotContextTokens(): number {
  if (activeBotConfigs.length === 0) {
    return globalConfig.maxContextTokens;
  }
  return Math.max(
    ...activeBotConfigs.map((config) => config.maxContextTokens ?? globalConfig.maxContextTokens),
  );
}
