"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activeBotConfigs = exports.botConfigs = exports.globalConfig = void 0;
exports.resolveConfig = resolveConfig;
require("dotenv/config");
// Global configuration shared across all bots
function parseMainChannelIds() {
    const raw = process.env.MAIN_CHANNEL_IDS || '';
    return raw
        .split(',')
        .map((id) => id.trim())
        .filter((id) => id.length > 0);
}
const mainChannelIds = parseMainChannelIds();
exports.globalConfig = {
    mainChannelIds,
    maxContextTokens: parseInt(process.env.MAX_CONTEXT_TOKENS || '100000', 10),
    maxTokens: parseInt(process.env.MAX_TOKENS || '4096', 10),
    temperature: parseFloat(process.env.TEMPERATURE || '1'),
    approxCharsPerToken: parseFloat(process.env.APPROX_CHARS_PER_TOKEN || '4'),
    discordMessageLimit: 2000,
};
// Bot configurations - add your bots here
exports.botConfigs = [
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
    {
        name: 'gemflash',
        discordToken: process.env.NANOBANANA_DISCORD_TOKEN || '',
        provider: 'gemini',
        model: 'gemini-2.5-flash-image',
        geminiApiKey: process.env.GOOGLE_API_KEY || '',
        geminiOutputMode: 'both', // Can generate both text and images
        maxContextTokens: 30000,
    },
];
// Filter out bots without tokens (allows partial configuration)
exports.activeBotConfigs = exports.botConfigs.filter((config) => {
    if (!config.discordToken) {
        console.warn(`Bot "${config.name}" has no Discord token, skipping`);
        return false;
    }
    if (config.provider === 'openai' && !config.openaiApiKey) {
        console.warn(`Bot "${config.name}" uses OpenAI provider but has no API key, skipping`);
        return false;
    }
    if (config.provider === 'gemini' && !config.geminiApiKey) {
        console.warn(`Bot "${config.name}" uses Gemini provider but has no API key, skipping`);
        return false;
    }
    return true;
});
// Resolve per-bot config with global defaults
function resolveConfig(botConfig) {
    return {
        ...botConfig,
        maxContextTokens: botConfig.maxContextTokens ?? exports.globalConfig.maxContextTokens,
        maxTokens: botConfig.maxTokens ?? exports.globalConfig.maxTokens,
        temperature: botConfig.temperature ?? exports.globalConfig.temperature,
        geminiApiKey: botConfig.geminiApiKey ?? '',
        geminiOutputMode: botConfig.geminiOutputMode ?? 'both',
    };
}
