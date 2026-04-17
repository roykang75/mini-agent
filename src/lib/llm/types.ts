export type Role = "user" | "assistant";

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

export interface Message {
  role: Role;
  content: string | ContentBlock[];
}

export interface ToolDef {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: readonly string[] | string[];
  };
}

export interface CacheControl {
  type: "ephemeral";
}

export interface SystemBlock {
  type: "text";
  text: string;
  cache_control?: CacheControl;
}

export interface LLMRequest {
  model: string;
  system?: string | SystemBlock[];
  messages: Message[];
  tools?: readonly ToolDef[];
  max_tokens: number;
}

export type StopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "stop_sequence"
  | "refusal"
  | "pause_turn"
  | (string & {});

export interface LLMUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface LLMResponse {
  content: ContentBlock[];
  stop_reason: StopReason;
  usage: LLMUsage;
}

export class LLMError extends Error {
  constructor(
    public status: number,
    public body: string,
    public retryAfter?: number,
  ) {
    super(`LLM HTTP ${status}: ${body.slice(0, 200)}`);
    this.name = "LLMError";
  }
}