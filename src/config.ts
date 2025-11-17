import 'dotenv/config';

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

  // CLI simulation mode (legacy, can be removed later)
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

// Bot configurations - add your bots here
export const botConfigs: BotConfig[] = [
  {
    name: 'Haiku4.5',
    discordToken: process.env.HAIKU_DISCORD_TOKEN || '',
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
  },
  {
    name: 'CL-KU',
    discordToken: process.env.CLKU_DISCORD_TOKEN || '',
    provider: 'anthropic',
    model: 'claude-3-5-haiku-latest',
  },
  {
    name: 'K2',
    discordToken: process.env.KIMI_DISCORD_TOKEN || '',
    provider: 'openai',
    model: 'moonshotai/kimi-k2-instruct-0905',
    openaiBaseUrl: 'https://api.groq.com/openai/v1',
    openaiApiKey: process.env.GROQ_API_KEY || '',
  },
  {
    name: 'gemflash',
    discordToken: process.env.NANOBANANA_DISCORD_TOKEN || '',
    provider: 'gemini',
    model: 'gemini-2.5-flash-image',
    geminiApiKey: process.env.GOOGLE_API_KEY || '',
    geminiOutputMode: 'both',
    maxContextTokens: 30000,
    systemPrompt:
      'You are an image-generating AI assistant. When users request images, drawings, or visual content, you MUST generate an actual image - do not just describe it. Always include a generated image when the context calls for visual output.',
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
