/**
 * Wire protocol mirror of `night-watch/src/lib/ingest/wire.ts` (schema_version 1).
 *
 * Night's Watch 서버와 mini-agent observer client 가 공유하는 envelope. 두 레포는
 * 별도 패키지이므로 mirror 정책 — 변경 시 양쪽을 같은 커밋 묶음으로 갱신.
 * canonical 정의는 night-watch 쪽이 holds (plan §14.4).
 */

export type TraceStatus =
  | "ok"
  | "error"
  | "hil_paused"
  | "user_input_pending"
  | "running";

export type EventKind =
  | "user_message"
  | "persona_resolved"
  | "memory_recalled"
  | "curriculum_recalled"
  | "self_map_recalled"
  | "recent_sessions_recalled"
  | "llm_request"
  | "llm_response"
  | "llm_stream_delta"
  | "llm_reasoning"
  | "llm_error"
  | "tool_call"
  | "tool_result"
  | "tool_rejected"
  | "tool_approval_request"
  | "tool_approval_decision"
  | "user_input_request"
  | "user_input_answer"
  | "chat_usage"
  | "message"
  | "text_delta"
  | "done"
  | "error"
  | "agent_note";

export type EventStatus =
  | "ok"
  | "error"
  | "timeout"
  | "refusal"
  | "truncated"
  | "empty_200";

export interface AgentIdentity {
  name: string;
  version: string;
  hostname?: string;
}

export interface SessionRecord {
  session_id: string;
  agent_name: string;
  sid?: string;
  persona?: string;
  persona_ref?: string;
  profile_name?: string;
  started_at: number;
  last_active_at: number;
  metadata?: Record<string, unknown>;
}

export interface TraceStart {
  trace_id: string;
  session_id?: string;
  agent_name: string;
  started_at: number;
  user_message?: string;
  metadata?: Record<string, unknown>;
}

export interface EventRecord {
  event_id: string;
  trace_id: string;
  seq: number;
  parent_event_id?: string;
  kind: EventKind;
  ts: number;
  duration_ms?: number;
  horn_level?: 1 | 2 | 3;
  model?: string;
  provider?: string;
  tokens_in?: number;
  tokens_out?: number;
  cache_creation_tokens?: number;
  cache_read_tokens?: number;
  reasoning_tokens?: number;
  status?: EventStatus;
  payload?: Record<string, unknown>;
  payload_summary?: string;
  body_ref?: string;
}

export interface TraceSummary {
  assistant_message?: string;
  tokens_total_in: number;
  tokens_total_out: number;
  cost_usd?: number;
  tool_call_count: number;
  user_input_count: number;
  error_count: number;
  horn_max: 1 | 2 | 3;
  model_breakdown?: Array<{
    model: string;
    calls: number;
    tokens_in: number;
    tokens_out: number;
  }>;
}

export type IngestItem =
  | { op: "session_upsert"; session: SessionRecord }
  | { op: "trace_start"; trace: TraceStart }
  | { op: "event"; event: EventRecord }
  | {
      op: "trace_end";
      trace_id: string;
      ended_at: number;
      status: TraceStatus;
      summary?: TraceSummary;
    }
  | {
      op: "body";
      body_ref: string;
      body: unknown;
      content_encoding?: "gzip";
    };

export interface IngestBatch {
  schema_version: 1;
  agent: AgentIdentity;
  items: IngestItem[];
}

export interface ApplyResult {
  accepted: number;
  skipped: number;
  errors: Array<{ item_index: number; reason: string }>;
}
