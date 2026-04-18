import type { LLMRequest, LLMResponse, LLMUsage, ContentBlock, StopReason } from "../types";
import { LLMError } from "../types";
import type { StreamEvent } from "../client";
import { withRetry } from "../retry";
import { createLogger } from "../../log";

const log = createLogger("llm");

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
  usage: LLMUsage;
}

export class AnthropicClient {
  private readonly explicitApiKey?: string;
  private readonly baseURL: string;

  constructor(opts: AnthropicClientOptions = {}) {
    this.explicitApiKey = opts.apiKey;
    this.baseURL = opts.baseURL ?? process.env.ANTHROPIC_BASE_URL ?? ANTHROPIC_API_URL;
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
      const started = Date.now();
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
        log.warn(
          {
            event: "chat_error",
            model: req.model,
            status: res.status,
            duration_ms: Date.now() - started,
            retry_after: Number.isFinite(retryAfter) ? retryAfter : undefined,
          },
          "anthropic chat failed",
        );
        throw new LLMError(res.status, body, Number.isFinite(retryAfter) ? retryAfter : undefined);
      }

      const data = (await res.json()) as AnthropicRawResponse;
      log.info(
        {
          event: "chat",
          model: req.model,
          duration_ms: Date.now() - started,
          tokens_in: data.usage.input_tokens,
          tokens_out: data.usage.output_tokens,
          cache_creation_tokens: data.usage.cache_creation_input_tokens ?? 0,
          cache_read_tokens: data.usage.cache_read_input_tokens ?? 0,
          stop_reason: data.stop_reason,
        },
        "anthropic chat ok",
      );
      return {
        content: data.content.filter(isNonEmptyBlock),
        stop_reason: data.stop_reason,
        usage: data.usage,
      };
    });
  }

  /**
   * Streaming variant of chat. Opens an SSE connection to Anthropic messages
   * with `stream: true`, yields `text_delta` events as text chunks arrive, and
   * finally yields `done` carrying an LLMResponse assembled from the stream.
   *
   * No mid-stream retries — once bytes start flowing, a failure aborts the
   * turn. HTTP status failures before the stream opens throw LLMError
   * (without retry) so callers can retry at the agent level if needed.
   */
  async *chatStream(req: LLMRequest): AsyncGenerator<StreamEvent, void, void> {
    const apiKey = this.resolveApiKey();
    const payload = {
      model: req.model,
      max_tokens: req.max_tokens,
      system: req.system,
      messages: req.messages,
      tools: req.tools,
      stream: true,
    };
    const started = Date.now();

    const res = await fetch(this.baseURL, {
      method: "POST",
      cache: "no-store",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
        "accept": "text/event-stream",
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const body = await res.text();
      const retryAfterHeader = res.headers.get("retry-after");
      const retryAfter = retryAfterHeader != null ? Number(retryAfterHeader) : undefined;
      log.warn(
        {
          event: "chat_error",
          model: req.model,
          status: res.status,
          duration_ms: Date.now() - started,
          retry_after: Number.isFinite(retryAfter) ? retryAfter : undefined,
        },
        "anthropic stream open failed",
      );
      throw new LLMError(res.status, body, Number.isFinite(retryAfter) ? retryAfter : undefined);
    }

    // Accumulators for the final LLMResponse.
    const blocks: ContentBlock[] = [];
    const toolInput: Record<number, string> = {};
    let stopReason: StopReason = "end_turn";
    const usage: LLMUsage = { input_tokens: 0, output_tokens: 0 };

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const dataLine = chunk.split("\n").find((l) => l.startsWith("data:"));
          if (!dataLine) continue;
          const raw = dataLine.slice("data:".length).trim();
          if (!raw) continue;

          let ev: SseEvent;
          try {
            ev = JSON.parse(raw) as SseEvent;
          } catch {
            continue;
          }

          switch (ev.type) {
            case "message_start":
              usage.input_tokens = ev.message.usage.input_tokens ?? 0;
              if (ev.message.usage.cache_creation_input_tokens != null) {
                usage.cache_creation_input_tokens = ev.message.usage.cache_creation_input_tokens;
              }
              if (ev.message.usage.cache_read_input_tokens != null) {
                usage.cache_read_input_tokens = ev.message.usage.cache_read_input_tokens;
              }
              break;
            case "content_block_start":
              blocks[ev.index] = structuredClone(ev.content_block);
              if (ev.content_block.type === "tool_use") toolInput[ev.index] = "";
              break;
            case "content_block_delta":
              if (ev.delta.type === "text_delta") {
                const b = blocks[ev.index] as Extract<ContentBlock, { type: "text" }>;
                b.text += ev.delta.text;
                yield { type: "text_delta", text: ev.delta.text };
              } else if (ev.delta.type === "input_json_delta") {
                toolInput[ev.index] = (toolInput[ev.index] ?? "") + ev.delta.partial_json;
              }
              break;
            case "content_block_stop": {
              const b = blocks[ev.index];
              if (b && b.type === "tool_use") {
                const txt = toolInput[ev.index] ?? "";
                b.input = txt.length > 0 ? JSON.parse(txt) : {};
              }
              break;
            }
            case "message_delta":
              if (ev.delta.stop_reason) stopReason = ev.delta.stop_reason;
              if (ev.usage?.output_tokens != null) usage.output_tokens = ev.usage.output_tokens;
              break;
            case "message_stop":
              break;
            case "error":
              throw new LLMError(500, ev.error?.message ?? "stream error");
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    const response: LLMResponse = {
      content: blocks.filter(isNonEmptyBlock),
      stop_reason: stopReason,
      usage,
    };

    log.info(
      {
        event: "chat",
        model: req.model,
        duration_ms: Date.now() - started,
        tokens_in: usage.input_tokens,
        tokens_out: usage.output_tokens,
        cache_creation_tokens: usage.cache_creation_input_tokens ?? 0,
        cache_read_tokens: usage.cache_read_input_tokens ?? 0,
        stop_reason: stopReason,
        streamed: true,
      },
      "anthropic chat ok (stream)",
    );

    yield { type: "done", response };
  }
}

type SseEvent =
  | { type: "message_start"; message: { usage: LLMUsage } }
  | { type: "content_block_start"; index: number; content_block: ContentBlock }
  | { type: "content_block_delta"; index: number; delta: { type: "text_delta"; text: string } | { type: "input_json_delta"; partial_json: string } }
  | { type: "content_block_stop"; index: number }
  | { type: "message_delta"; delta: { stop_reason?: StopReason }; usage?: { output_tokens?: number } }
  | { type: "message_stop" }
  | { type: "error"; error?: { message?: string } }
  | { type: "ping" };

function isNonEmptyBlock(b: ContentBlock): boolean {
  if (!b) return false;
  if (b.type === "text") return b.text.length > 0;
  return true;
}
