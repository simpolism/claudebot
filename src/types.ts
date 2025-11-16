export type SimpleMessage = {
  role: 'user' | 'assistant';
  content: string;
};

// Structured conversation data for stable prompt caching
export type ConversationData = {
  cachedBlocks: string[]; // Pre-formatted text blocks (stable, should be cached)
  tail: SimpleMessage[]; // Fresh messages not yet cached
};

export type ImageBlock = {
  type: 'image';
  source: {
    type: 'url';
    url: string;
  };
};

export type TextBlock = {
  type: 'text';
  text: string;
  cache_control?: {
    type: 'ephemeral';
    ttl?: '5m' | '1h';
  };
};

export type ClaudeContentBlock = TextBlock | ImageBlock;

export type AIResponse = {
  text: string;
  truncated: boolean;
  truncatedSpeaker?: string;
};
