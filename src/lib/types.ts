export type AgentEvent =
  | { type: "persona_resolved"; persona: string; ref: string }
  | { type: "memory_recalled"; count: number; ids: string[] }
  | { type: "thinking"; content: string }
  | { type: "tool_call"; name: string; args: Record<string, unknown> }
  | { type: "tool_approval_request"; sessionId: string; toolCalls: PendingToolCall[] }
  | { type: "tool_result"; name: string; output: string }
  | { type: "tool_rejected"; name: string }
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
