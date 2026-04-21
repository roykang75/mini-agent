export type AgentEvent =
  | { type: "persona_resolved"; persona: string; ref: string }
  | { type: "memory_recalled"; count: number; ids: string[] }
  | { type: "curriculum_recalled"; count: number; problem_ids: string[]; model: string }
  | { type: "self_map_recalled"; count: number; problem_ids: string[]; model: string }
  | { type: "recent_sessions_recalled"; count: number; session_ids: string[]; model: string }
  | { type: "thinking"; content: string }
  | { type: "tool_call"; name: string; args: Record<string, unknown> }
  | {
      type: "chat_usage";
      model: string;
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    }
  | { type: "tool_approval_request"; sessionId: string; toolCalls: PendingToolCall[] }
  | { type: "tool_result"; name: string; output: string }
  | { type: "tool_rejected"; name: string }
  | { type: "text_delta"; delta: string }
  | { type: "message"; content: string }
  | { type: "done" }
  | { type: "error"; message: string };

export interface PendingToolCall {
  toolUseId: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "tool_call" | "tool_result" | "tool_approval" | "tool_rejected" | "thinking" | "error";
  content: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  sessionId?: string;
  pendingToolCalls?: PendingToolCall[];
  timestamp: number;
}
