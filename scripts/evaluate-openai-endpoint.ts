type CheckStatus = 'pass' | 'warn' | 'fail';

type CheckResult = {
  name: string;
  status: CheckStatus;
  detail: string;
};

type CliConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  cliSim: boolean;
};

type ChatCompletionContentPart = {
  type: 'text';
  text: string;
};

const DEFAULT_BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const DEFAULT_TIMEOUT_MS = process.env.OPENAI_REQUEST_TIMEOUT
  ? Number(process.env.OPENAI_REQUEST_TIMEOUT)
  : 15000;

class FeatureEvaluator {
  private readonly baseUrl: string;

  constructor(private readonly config: CliConfig) {
    this.baseUrl = this.normalizeBaseUrl(config.baseUrl);
  }

  async run(): Promise<CheckResult[]> {
    const results: CheckResult[] = [];
    results.push(await this.checkBasicChatCompletion());
    results.push(await this.checkAssistantPrefillContinuation());
    if (this.config.cliSim) {
      results.push(await this.checkCliSimulationContinuation());
    }
    return results;
  }

  private normalizeBaseUrl(url: string): string {
    return url.endsWith('/') ? url.slice(0, -1) : url;
  }

  private buildHeaders(extra?: Record<string, string>): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.config.apiKey}`,
      ...extra,
    };
  }

  private async fetchWithTimeout(path: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      return await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private async checkBasicChatCompletion(): Promise<CheckResult> {
    const payload = {
      model: this.config.model,
      max_tokens: 32,
      temperature: 0,
      messages: [
        { role: 'system', content: 'You are a test harness.' },
        { role: 'user', content: 'Reply with the word "ack".' },
      ],
    };

    try {
      const response = await this.fetchWithTimeout('/chat/completions', {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(payload),
      });
      const bodyText = await response.text();
      if (!response.ok) {
        return {
          name: 'chat.completions',
          status: 'fail',
          detail: `HTTP ${response.status}: ${summarizeBody(bodyText)}`,
        };
      }

      const parsed = safeJson(bodyText);
      const ack = extractChatCompletionText(parsed);
      const matched = typeof ack === 'string' && ack.toLowerCase().includes('ack');
      return {
        name: 'chat.completions',
        status: matched ? 'pass' : 'warn',
        detail: matched
          ? 'Received chat completion response.'
          : `Unexpected completion text: ${summarizeBody(ack ?? '(empty)')}`,
      };
    } catch (err) {
      return {
        name: 'chat.completions',
        status: 'fail',
        detail: `Request failed: ${(err as Error).message}`,
      };
    }
  }

  private async checkAssistantPrefillContinuation(): Promise<CheckResult> {
    const botDisplayName = 'Claude Bot';
    const mentionHandle = '@ClaudeBot';
    const transcriptText = [
      `Alex: ${mentionHandle} we just logged the first deployment step.`,
      `${botDisplayName}: Step 1: provision the primary node.`,
      `Sam: ${mentionHandle} please finish the remaining two steps.`,
    ].join('\n');

    const conversationParts: ChatCompletionContentPart[] = [
      {
        type: 'text',
        text: transcriptText,
      },
    ];

    const assistantPrefill = `${botDisplayName}:`;
    const payload = {
      model: this.config.model,
      temperature: 0,
      max_tokens: 64,
      messages: [
        {
          role: 'system',
          content: 'You are a cooperative assistant following the transcript verbatim.',
        },
        {
          role: 'user',
          content: conversationParts,
        },
        {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: `${assistantPrefill} `,
            },
          ],
        },
      ],
    };

    try {
      const response = await this.fetchWithTimeout('/chat/completions', {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(payload),
      });
      const bodyText = await response.text();
      if (!response.ok) {
        return {
          name: 'assistant prefill continuation',
          status: 'fail',
          detail: `HTTP ${response.status}: ${summarizeBody(bodyText)}`,
        };
      }

      const parsed = safeJson(bodyText);
      const completionText = extractChatCompletionText(parsed) || '';
      const trimmed = completionText.trimStart();
      const startsWithPrefill = trimmed.startsWith(assistantPrefill);
      const otherSpeakerMatch = /^([A-Za-z0-9 _-]{2,40}):/.exec(trimmed);

      let status: CheckStatus = 'fail';
      let detail: string;
      if (startsWithPrefill) {
        status = 'pass';
        detail = 'Assistant continued speaking as itself after the mention.';
      } else if (otherSpeakerMatch) {
        const speaker = otherSpeakerMatch[1];
        status = 'fail';
        detail = `Model started a new turn as "${speaker}" instead of continuing the assistant response.`;
      } else {
        status = 'warn';
        detail = 'Assistant reply dropped the prefill prefix; behavior may be out of context.';
      }

      const detailLines = [
        `Payload user content:\n${conversationParts.map((part) => part.text).join('\n')}`,
        `Assistant prefill message:\n${assistantPrefill} `,
        `Assistant completion:\n${completionText || '(empty response)'}`,
        detail,
      ];

      const name = 'assistant prefill continuation';
      const detailText = detailLines.join('\n\n');
      console.log(formatVerboseResult(name, detailText));
      return {
        name,
        status,
        detail,
      };
    } catch (err) {
      return {
        name: 'assistant prefill continuation',
        status: 'fail',
        detail: `Request failed: ${(err as Error).message}`,
      };
    }
  }

  private async checkCliSimulationContinuation(): Promise<CheckResult> {
    const botDisplayName = 'Claude Bot';
    const commandText = '<cmd>cat untitled.txt</cmd>';
    const assistantPrefill = `${botDisplayName}:`;
    const systemPrompt =
      "The assistant is in CLI simulation mode, and responds to the user's CLI commands only with the output of the command.";

    const transcriptText = [
      'Alex: Deployment log so far shows step 1 completed.',
      `${botDisplayName}: Step 1: Provision the primary node.`,
      'Sam: Please record steps 2 and 3 now.',
    ].join('\n');

    const userContent: ChatCompletionContentPart[] = [
      {
        type: 'text',
        text: transcriptText,
      },
    ];

    const payload = {
      model: this.config.model,
      temperature: 0,
      max_tokens: 128,
      messages: [
        {
          role: 'system',
          content: systemPrompt,
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: commandText,
            },
          ],
        },
        {
          role: 'user',
          content: userContent,
        },
        {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: `${assistantPrefill} `,
            },
          ],
        },
      ],
    };

    try {
      const response = await this.fetchWithTimeout('/chat/completions', {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(payload),
      });
      const bodyText = await response.text();
      if (!response.ok) {
        return {
          name: 'cli simulation prefill',
          status: 'fail',
          detail: `HTTP ${response.status}: ${summarizeBody(bodyText)}`,
        };
      }

      const parsed = safeJson(bodyText);
      const completionText = extractChatCompletionText(parsed) || '';
      const trimmed = completionText.trimStart();
      const startsWithAssistant = trimmed.startsWith(assistantPrefill);

      let status: CheckStatus = 'fail';
      let detail: string;
      if (startsWithAssistant) {
        status = 'pass';
        detail = 'Assistant prefix preserved; model should emit CLI output next.';
      } else if (completionText.includes(assistantPrefill)) {
        status = 'warn';
        detail = 'Assistant prefix appeared later in the text; CLI sim may misbehave.';
      } else {
        status = 'fail';
        detail = 'Model ignored the assistant prefix prefill.';
      }

      const details = [
        `System prompt: ${systemPrompt}`,
        `Transcript content:\n${transcriptText}`,
        `Command user message: ${commandText}`,
        `Assistant prefill: ${assistantPrefill} `,
        `Assistant completion:\n${completionText || '(empty response)'}`,
        detail,
      ];

      const name = 'cli simulation prefill';
      console.log(formatVerboseResult(name, details.join('\n\n')));
      return {
        name,
        status,
        detail,
      };
    } catch (err) {
      return {
        name: 'cli simulation prefill',
        status: 'fail',
        detail: `Request failed: ${(err as Error).message}`,
      };
    }
  }
}

function parseArgs(argv: string[]): CliConfig {
  const config: CliConfig = {
    baseUrl: DEFAULT_BASE_URL,
    apiKey: process.env.OPENAI_API_KEY || '',
    model: DEFAULT_MODEL,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    cliSim: false,
  };

  const args = [...argv];
  for (let i = 0; i < args.length; i += 1) {
    const raw = args[i];
    if (!raw.startsWith('--')) {
      continue;
    }

    if (raw === '--help') {
      printUsage();
      process.exit(0);
    }

    const eqIndex = raw.indexOf('=');
    const key = raw.slice(2, eqIndex === -1 ? undefined : eqIndex);
    let value: string | undefined;
    if (eqIndex === -1) {
      value = args[i + 1];
      i += 1;
    } else {
      value = raw.slice(eqIndex + 1);
    }

    if (!value) {
      throw new Error(`Flag "--${key}" requires a value.`);
    }

    switch (key) {
      case 'base-url':
        config.baseUrl = value;
        break;
      case 'api-key':
        config.apiKey = value;
        break;
      case 'model':
        config.model = value;
        break;
      case 'timeout':
        config.timeoutMs = Number(value);
        break;
      case 'cli-sim':
        config.cliSim = parseBoolean(value);
        break;
      default:
        throw new Error(`Unknown flag "--${key}". Use --help to see usage.`);
    }
  }

  if (!config.apiKey) {
    throw new Error('Missing API key. Provide --api-key or set OPENAI_API_KEY.');
  }

  return config;
}

function printUsage(): void {
  console.log(`Feature evaluation script

Usage:
  npx ts-node scripts/evaluate-openai-endpoint.ts --api-key sk-... [--base-url URL] [--model MODEL] [--cli-sim true]

Environment fallbacks:
  OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_MODEL, OPENAI_REQUEST_TIMEOUT`);
}

function safeJson(text: string): any | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function summarizeBody(body: string, limit = 120): string {
  if (!body) return '(empty body)';
  return body.length <= limit ? body : `${body.slice(0, limit)}…`;
}

function extractChatCompletionText(payload: any): string {
  if (!payload?.choices?.length) return '';
  const message = payload.choices[0]?.message;
  if (!message) return '';
  if (typeof message.content === 'string') {
    return message.content;
  }
  if (Array.isArray(message.content)) {
    return message.content
      .map((part: any) => {
        if (typeof part === 'string') return part;
        if (typeof part?.text === 'string') return part.text;
        return '';
      })
      .join('');
  }
  if (Array.isArray(message.parts)) {
    return message.parts
      .map((part: any) => (typeof part?.text === 'string' ? part.text : ''))
      .join('');
  }
  return '';
}

function printResults(results: CheckResult[]): void {
  const nameWidth = Math.max(...results.map((result) => result.name.length));
  results.forEach((result) => {
    const label = result.status.toUpperCase().padEnd(4);
    const paddedName = result.name.padEnd(nameWidth);
    console.log(`[${label}] ${paddedName} - ${result.detail}`);
  });
}

function formatVerboseResult(name: string, text: string): string {
  const divider = '-'.repeat(40);
  return `${divider}\n${name}\n${divider}\n${text}\n${divider}`;
}

function parseBoolean(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
}

async function main(): Promise<void> {
  const config = parseArgs(process.argv.slice(2));
  const evaluator = new FeatureEvaluator(config);
  const results = await evaluator.run();
  printResults(results);
  const hasFailure = results.some((result) => result.status === 'fail');
  process.exit(hasFailure ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
