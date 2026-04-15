import type { LLMRequest, LLMResponse, ContentBlock, StopReason } from "../types";
import { LLMError } from "../types";
import { withRetry } from "../retry";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

export interface AnthropicClientOptions {
  apiKey?: string;
  baseURL?: string;
}

interface AnthropicRawResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: ContentBlock[];
  stop_reason: StopReason;
  stop_sequence: string | null;
  usage: { input_tokens: number; output_tokens: number };
}

export class AnthropicClient {
  private readonly explicitApiKey?: string;
  private readonly baseURL: string;

  constructor(opts: AnthropicClientOptions = {}) {
    this.explicitApiKey = opts.apiKey;
    this.baseURL = opts.baseURL ?? ANTHROPIC_API_URL;
  }

  private resolveApiKey(): string {
    const key = this.explicitApiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error("ANTHROPIC_API_KEY is required (env or options.apiKey)");
    return key;
  }

  async chat(req: LLMRequest): Promise<LLMResponse> {
    const apiKey = this.resolveApiKey();
    const payload = {
      model: req.model,
      max_tokens: req.max_tokens,
      system: req.system,
      messages: req.messages,
      tools: req.tools,
    };

    return withRetry(async () => {
      const res = await fetch(this.baseURL, {
        method: "POST",
        cache: "no-store",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const body = await res.text();
        const retryAfterHeader = res.headers.get("retry-after");
        const retryAfter = retryAfterHeader != null ? Number(retryAfterHeader) : undefined;
        throw new LLMError(res.status, body, Number.isFinite(retryAfter) ? retryAfter : undefined);
      }

      const data = (await res.json()) as AnthropicRawResponse;
      return {
        content: data.content.filter(isNonEmptyBlock),
        stop_reason: data.stop_reason,
        usage: data.usage,
      };
    });
  }
}

function isNonEmptyBlock(b: ContentBlock): boolean {
  if (b.type === "text") return b.text.length > 0;
  return true;
}