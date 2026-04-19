import type {
  LLMRequest,
  LLMResponse,
  LLMUsage,
  ContentBlock,
  StopReason,
  Message,
  ToolDef,
  SystemBlock,
} from "../types";
import { LLMError } from "../types";
import type { StreamEvent } from "../client";
import { withRetry } from "../retry";
import { createLogger } from "../../log";

const log = createLogger("llm");

export interface OpenAICompatClientOptions {
  apiKey?: string;
  baseURL?: string;
}

interface OAIToolCall {
  id?: string;
  type?: "function";
  function: { name?: string; arguments?: string };
  index?: number;
}

interface OAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: OAIToolCall[];
  tool_call_id?: string;
}

interface OAITool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

interface OAIChoice {
  index: number;
  message: { role: "assistant"; content: string | null; tool_calls?: OAIToolCall[] };
  finish_reason: "stop" | "tool_calls" | "length" | "content_filter" | string;
}

interface OAIResponse {
  id: string;
  choices: OAIChoice[];
  usage?: { prompt_tokens: number; completion_tokens: number };
}

interface OAIStreamChoice {
  index: number;
  delta: { content?: string; tool_calls?: OAIToolCall[] };
  finish_reason: string | null;
}

interface OAIStreamChunk {
  choices: OAIStreamChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class OpenAICompatClient {
  private readonly explicitApiKey?: string;
  private readonly baseURL: string;

  constructor(opts: OpenAICompatClientOptions = {}) {
    this.explicitApiKey = opts.apiKey;
    const raw = opts.baseURL ?? process.env.LLM_BASE_URL ?? "http://localhost:1234";
    this.baseURL = raw.replace(/\/$/, "");
  }

  private resolveApiKey(): string {
    return this.explicitApiKey ?? process.env.LLM_API_KEY ?? "local";
  }

  private buildPayload(req: LLMRequest, stream: boolean): Record<string, unknown> {
    // gpt-5 / o-series 는 max_tokens 대신 max_completion_tokens 요구
    const useCompletionTokens = /^(gpt-5|o[1-9])/.test(req.model);
    const payload: Record<string, unknown> = {
      model: req.model,
      messages: translateMessages(req.system, req.messages),
      [useCompletionTokens ? "max_completion_tokens" : "max_tokens"]: req.max_tokens,
      stream,
    };
    if (req.tools && req.tools.length > 0) {
      payload.tools = req.tools.map(translateTool);
      payload.tool_choice = "auto";
    }
    return payload;
  }

  async chat(req: LLMRequest): Promise<LLMResponse> {
    const apiKey = this.resolveApiKey();
    const url = `${this.baseURL}/v1/chat/completions`;
    const payload = this.buildPayload(req, false);

    return withRetry(async () => {
      const started = Date.now();
      const res = await fetch(url, {
        method: "POST",
        cache: "no-store",
        headers: {
          authorization: `Bearer ${apiKey}`,
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
          "openai-compat chat failed",
        );
        throw new LLMError(res.status, body, Number.isFinite(retryAfter) ? retryAfter : undefined);
      }

      const data = (await res.json()) as OAIResponse;
      const choice = data.choices[0];
      if (!choice) {
        throw new LLMError(500, `no choices in response: ${JSON.stringify(data).slice(0, 200)}`);
      }

      const content = translateResponseContent(choice.message.content, choice.message.tool_calls);
      const stop_reason = translateFinishReason(choice.finish_reason);
      const usage: LLMUsage = {
        input_tokens: data.usage?.prompt_tokens ?? 0,
        output_tokens: data.usage?.completion_tokens ?? 0,
      };

      log.info(
        {
          event: "chat",
          model: req.model,
          duration_ms: Date.now() - started,
          tokens_in: usage.input_tokens,
          tokens_out: usage.output_tokens,
          cache_creation_tokens: 0,
          cache_read_tokens: 0,
          stop_reason,
        },
        "openai-compat chat ok",
      );
      return { content, stop_reason, usage };
    });
  }

  async *chatStream(req: LLMRequest): AsyncGenerator<StreamEvent, void, void> {
    const apiKey = this.resolveApiKey();
    const url = `${this.baseURL}/v1/chat/completions`;
    const payload = this.buildPayload(req, true);
    const started = Date.now();

    const res = await fetch(url, {
      method: "POST",
      cache: "no-store",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        accept: "text/event-stream",
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
        "openai-compat stream open failed",
      );
      throw new LLMError(res.status, body, Number.isFinite(retryAfter) ? retryAfter : undefined);
    }

    // Accumulators.
    let textBuf = "";
    const toolBuf = new Map<number, { id?: string; name?: string; args: string }>();
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
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line || !line.startsWith("data:")) continue;
          const raw = line.slice("data:".length).trim();
          if (!raw) continue;
          if (raw === "[DONE]") continue;

          let chunk: OAIStreamChunk;
          try {
            chunk = JSON.parse(raw) as OAIStreamChunk;
          } catch {
            continue;
          }

          if (chunk.usage) {
            if (chunk.usage.prompt_tokens != null) usage.input_tokens = chunk.usage.prompt_tokens;
            if (chunk.usage.completion_tokens != null) usage.output_tokens = chunk.usage.completion_tokens;
          }

          const choice = chunk.choices?.[0];
          if (!choice) continue;

          const deltaText = choice.delta.content;
          if (deltaText != null && deltaText.length > 0) {
            textBuf += deltaText;
            yield { type: "text_delta", text: deltaText };
          }

          if (choice.delta.tool_calls) {
            for (const tc of choice.delta.tool_calls) {
              const i = tc.index ?? 0;
              const entry = toolBuf.get(i) ?? { args: "" };
              if (tc.id) entry.id = tc.id;
              if (tc.function?.name) entry.name = tc.function.name;
              if (tc.function?.arguments) entry.args += tc.function.arguments;
              toolBuf.set(i, entry);
            }
          }

          if (choice.finish_reason) {
            stopReason = translateFinishReason(choice.finish_reason);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    const content: ContentBlock[] = [];
    if (textBuf.length > 0) content.push({ type: "text", text: textBuf });
    const toolIndices = [...toolBuf.keys()].sort((a, b) => a - b);
    for (const i of toolIndices) {
      const entry = toolBuf.get(i)!;
      const name = entry.name ?? "";
      if (!name) continue;
      const id = entry.id ?? `tool-${i}`;
      let input: unknown = {};
      if (entry.args.length > 0) {
        try {
          input = JSON.parse(entry.args);
        } catch {
          input = { _raw: entry.args };
        }
      }
      content.push({ type: "tool_use", id, name, input });
    }

    const response: LLMResponse = { content, stop_reason: stopReason, usage };

    log.info(
      {
        event: "chat",
        model: req.model,
        duration_ms: Date.now() - started,
        tokens_in: usage.input_tokens,
        tokens_out: usage.output_tokens,
        cache_creation_tokens: 0,
        cache_read_tokens: 0,
        stop_reason: stopReason,
        streamed: true,
      },
      "openai-compat chat ok (stream)",
    );

    yield { type: "done", response };
  }
}

function flattenSystem(system: LLMRequest["system"]): string {
  if (!system) return "";
  if (typeof system === "string") return system;
  return (system as SystemBlock[]).map((b) => b.text).join("\n\n");
}

function translateMessages(
  system: LLMRequest["system"],
  messages: readonly Message[],
): OAIMessage[] {
  const out: OAIMessage[] = [];
  const sys = flattenSystem(system);
  if (sys.length > 0) out.push({ role: "system", content: sys });

  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    const textParts: string[] = [];
    const toolCalls: OAIToolCall[] = [];
    const toolResults: Array<{ tool_use_id: string; content: string }> = [];
    for (const b of m.content) {
      if (b.type === "text") textParts.push(b.text);
      else if (b.type === "tool_use") {
        toolCalls.push({
          id: b.id,
          type: "function",
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        });
      } else if (b.type === "tool_result") {
        toolResults.push({ tool_use_id: b.tool_use_id, content: b.content });
      }
    }

    if (m.role === "assistant") {
      const msg: OAIMessage = { role: "assistant" };
      if (textParts.length > 0) msg.content = textParts.join("");
      if (toolCalls.length > 0) msg.tool_calls = toolCalls;
      if (msg.content == null && !msg.tool_calls) msg.content = "";
      out.push(msg);
    } else {
      // user role: emit tool results as separate role="tool" messages, then
      // the remaining text (if any) as a user message.
      for (const tr of toolResults) {
        out.push({ role: "tool", tool_call_id: tr.tool_use_id, content: tr.content });
      }
      if (textParts.length > 0) {
        out.push({ role: "user", content: textParts.join("") });
      }
    }
  }

  return out;
}

function translateTool(t: ToolDef): OAITool {
  return {
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: {
        type: t.input_schema.type,
        properties: t.input_schema.properties,
        ...(t.input_schema.required ? { required: [...t.input_schema.required] } : {}),
      },
    },
  };
}

function translateResponseContent(
  text: string | null | undefined,
  toolCalls: OAIToolCall[] | undefined,
): ContentBlock[] {
  const out: ContentBlock[] = [];
  if (text && text.length > 0) out.push({ type: "text", text });
  if (toolCalls) {
    for (const tc of toolCalls) {
      const name = tc.function?.name;
      if (!name) continue;
      const id = tc.id ?? `tool-${out.length}`;
      let input: unknown = {};
      const argsStr = tc.function?.arguments ?? "";
      if (argsStr.length > 0) {
        try {
          input = JSON.parse(argsStr);
        } catch {
          input = { _raw: argsStr };
        }
      }
      out.push({ type: "tool_use", id, name, input });
    }
  }
  return out;
}

function translateFinishReason(fr: string | null): StopReason {
  switch (fr) {
    case "stop":
      return "end_turn";
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "refusal";
    default:
      return (fr ?? "end_turn") as StopReason;
  }
}
