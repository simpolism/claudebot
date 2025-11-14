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
};

export type ClaudeContentBlock = TextBlock | ImageBlock;

export type AIResponse = {
  text: string;
  truncated: boolean;
  truncatedSpeaker?: string;
};
