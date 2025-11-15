export type SimpleMessage = {
  role: 'user' | 'assistant';
  content: string;
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
  };
};

export type ClaudeContentBlock = TextBlock | ImageBlock;

export type AIResponse = {
  text: string;
  truncated: boolean;
  truncatedSpeaker?: string;
};
