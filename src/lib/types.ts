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
  | {
      type: "user_input_request";
      sessionId: string;
      toolUseId: string;
      kind: "choose" | "confirm";
      question: string;
      options?: AskUserOption[];
      multi?: boolean;
    }
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

export interface AskUserOption {
  id: string;
  label: string;
  description?: string;
}

/**
 * Client → server answer payload. Server 는 이 값을 `ask_user` tool_result JSON
 * 으로 변환해 agent messages 에 push.
 *
 * - "choose" / "confirm": pendingUserInput.kind 와 일치해야 함 — 정상 응답 경로.
 * - "cancel": pendingUserInput.kind 와 무관하게 항상 허용 — 사용자가 질문 자체를
 *   포기하고 다른 작업으로 넘어가고 싶을 때. agent 는 is_error tool_result 로
 *   표시하고 agentLoop 재진입 없이 턴을 종료해 다음 receive() 를 풀어준다.
 */
export type UserInputAnswer =
  | { kind: "choose"; selected: string | string[] }
  | { kind: "confirm"; confirmed: boolean }
  | { kind: "cancel" };

export interface ChatMessage {
  id: string;
  role:
    | "user"
    | "assistant"
    | "tool_call"
    | "tool_result"
    | "tool_approval"
    | "tool_rejected"
    | "user_input"
    | "thinking"
    | "error";
  content: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  sessionId?: string;
  pendingToolCalls?: PendingToolCall[];
  /** user_input role 전용 — user_input_request 이벤트에서 복사한 필드. */
  userInput?: {
    toolUseId: string;
    kind: "choose" | "confirm";
    question: string;
    options?: AskUserOption[];
    multi?: boolean;
  };
  timestamp: number;
}
