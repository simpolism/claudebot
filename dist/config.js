"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activeBotConfigs = exports.botConfigs = exports.globalConfig = void 0;
exports.resolveConfig = resolveConfig;
exports.getMaxBotContextTokens = getMaxBotContextTokens;
require("dotenv/config");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
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
// Load bot configurations from JSON file
function loadBotConfigsFromJSON() {
    const configPath = path.join(process.cwd(), 'bots.json');
    if (!fs.existsSync(configPath)) {
        console.warn(`No bots.json found at ${configPath}, using empty config`);
        return [];
    }
    try {
        const jsonContent = fs.readFileSync(configPath, 'utf-8');
        const jsonConfigs = JSON.parse(jsonContent);
        return jsonConfigs.map((jsonConfig) => ({
            name: jsonConfig.name,
            discordToken: process.env[jsonConfig.discordTokenEnv] || '',
            provider: jsonConfig.provider,
            model: jsonConfig.model,
            supportsImageBlocks: jsonConfig.supportsImageBlocks,
            useOpenAIPromptCaching: jsonConfig.useOpenAIPromptCaching,
            useOpenAIMaxCompletionTokens: jsonConfig.useOpenAIMaxCompletionTokens,
            keepDoubleNewlines: jsonConfig.keepDoubleNewlines,
            openaiBaseUrl: jsonConfig.openaiBaseUrl,
            openaiApiKey: jsonConfig.openaiApiKeyEnv
                ? process.env[jsonConfig.openaiApiKeyEnv] || ''
                : undefined,
            geminiApiKey: jsonConfig.geminiApiKeyEnv
                ? process.env[jsonConfig.geminiApiKeyEnv] || ''
                : undefined,
            geminiOutputMode: jsonConfig.geminiOutputMode,
            maxContextTokens: jsonConfig.maxContextTokens,
            maxTokens: jsonConfig.maxTokens,
            temperature: jsonConfig.temperature,
            systemPrompt: jsonConfig.systemPrompt,
            useUserAssistantPrefill: jsonConfig.useUserAssistantPrefill,
            cliSimMode: jsonConfig.cliSimMode,
        }));
    }
    catch (err) {
        console.error(`Failed to load bots.json:`, err);
        return [];
    }
}
exports.botConfigs = loadBotConfigsFromJSON();
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
        keepDoubleNewlines: botConfig.keepDoubleNewlines ?? false,
        geminiApiKey: botConfig.geminiApiKey ?? '',
        geminiOutputMode: botConfig.geminiOutputMode ?? 'both',
        systemPrompt: botConfig.systemPrompt ?? '',
        useOpenAIPromptCaching: botConfig.useOpenAIPromptCaching ?? false,
        useOpenAIMaxCompletionTokens: botConfig.useOpenAIMaxCompletionTokens ?? false,
    };
}
// Get the maximum context tokens across all active bots
// Used for global block eviction decisions
function getMaxBotContextTokens() {
    if (exports.activeBotConfigs.length === 0) {
        return exports.globalConfig.maxContextTokens;
    }
    return Math.max(...exports.activeBotConfigs.map((config) => config.maxContextTokens ?? exports.globalConfig.maxContextTokens));
}
