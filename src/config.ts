import 'dotenv/config';

export interface BotConfig {
  name: string;
  discordToken: string;
  provider: 'anthropic' | 'openai';
  model: string;

  // For OpenAI-compatible providers (Groq, etc)
  openaiBaseUrl?: string;
  openaiApiKey?: string;

  // Per-bot overrides (uses global defaults if not specified)
  maxContextTokens?: number;
  maxTokens?: number;
  temperature?: number;

  // CLI simulation mode (legacy, can be removed later)
  cliSimMode?: boolean;
}

// Global configuration shared across all bots
export const globalConfig = {
  mainChannelId: process.env.MAIN_CHANNEL_ID || '',
  maxContextTokens: parseInt(process.env.MAX_CONTEXT_TOKENS || '100000', 10),
  maxTokens: parseInt(process.env.MAX_TOKENS || '4096', 10),
  temperature: parseFloat(process.env.TEMPERATURE || '1'),
  approxCharsPerToken: parseFloat(process.env.APPROX_CHARS_PER_TOKEN || '4'),
  discordMessageLimit: 2000,
};

// Bot configurations - add your bots here
export const botConfigs: BotConfig[] = [
  {
    name: 'Haiku4.5',
    discordToken: process.env.HAIKU_DISCORD_TOKEN || '',
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
  },
  {
    name: 'K2',
    discordToken: process.env.KIMI_DISCORD_TOKEN || '',
    provider: 'openai',
    model: 'moonshotai/kimi-k2-instruct-0905',
    openaiBaseUrl: 'https://api.groq.com/openai/v1',
    openaiApiKey: process.env.GROQ_API_KEY || '',
  },
];

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
  return true;
});

// Resolve per-bot config with global defaults
export function resolveConfig(botConfig: BotConfig) {
  return {
    ...botConfig,
    maxContextTokens:
      botConfig.maxContextTokens ?? globalConfig.maxContextTokens,
    maxTokens: botConfig.maxTokens ?? globalConfig.maxTokens,
    temperature: botConfig.temperature ?? globalConfig.temperature,
  };
}
