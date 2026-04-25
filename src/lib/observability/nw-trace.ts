/**
 * Trace lifecycle helpers + AsyncGenerator wrapper for Night's Watch.
 *
 * AgentInstance.receive() / resumeAfter*() 가 yield 하는 AgentEvent 스트림을
 * Night's Watch wire EventRecord 로 변환해 client 에 흘려보낸다. trace_start
 * 는 wrap 진입 시 1회, trace_end 는 종료시 1회. status 는 yield 된 마지막 종결성
 * 이벤트로 추정 (done → ok, user_input_request → user_input_pending,
 * tool_approval_request → hil_paused, error → error).
 *
 * 이 모듈은 NightWatch 가 disabled 일 때도 안전 — client.push 가 no-op.
 */

import { randomUUID } from "node:crypto";
import { getNightWatchClient } from "./night-watch";
import { mapAgentEvent } from "./agent-event-mapper";
import type {
  EventRecord,
  SessionRecord,
  TraceStart,
  TraceStatus,
  TraceSummary,
} from "./wire";
import type { AgentEvent, PendingToolCall } from "../types";
import type { LLMResponse } from "../llm/types";

export interface ModelBreakdownEntry {
  model: string;
  calls: number;
  tokens_in: number;
  tokens_out: number;
}

export interface TraceContext {
  trace_id: string;
  session_id: string;
  agent_name: string;
  startedAt: number;
  /** Monotonic seq counter — must be unique within the trace. */
  seq: number;
  // Aggregates for trace_end summary.
  tokens_in: number;
  tokens_out: number;
  tool_call_count: number;
  user_input_count: number;
  error_count: number;
  horn_max: 1 | 2 | 3;
  assistant_pieces: string[];
  model_breakdown: Map<string, ModelBreakdownEntry>;
  /** Last terminal status observed in the stream — defaults to "ok". */
  endStatus: TraceStatus;
}

export function newTraceContext(opts: {
  trace_id?: string;
  session_id: string;
  agent_name: string;
}): TraceContext {
  return {
    trace_id: opts.trace_id ?? randomUUID(),
    session_id: opts.session_id,
    agent_name: opts.agent_name,
    startedAt: Date.now(),
    seq: 0,
    tokens_in: 0,
    tokens_out: 0,
    tool_call_count: 0,
    user_input_count: 0,
    error_count: 0,
    horn_max: 1,
    assistant_pieces: [],
    model_breakdown: new Map(),
    endStatus: "ok",
  };
}

export function pushSessionUpsert(rec: SessionRecord): void {
  getNightWatchClient().push({ op: "session_upsert", session: rec });
}

export function pushTraceStart(rec: TraceStart): void {
  getNightWatchClient().push({ op: "trace_start", trace: rec });
}

export function pushEvent(rec: EventRecord): void {
  getNightWatchClient().push({ op: "event", event: rec });
}

function recordAccum(ctx: TraceContext, ev: AgentEvent): void {
  switch (ev.type) {
    case "chat_usage": {
      ctx.tokens_in += ev.input_tokens;
      ctx.tokens_out += ev.output_tokens;
      const entry = ctx.model_breakdown.get(ev.model) ?? {
        model: ev.model,
        calls: 0,
        tokens_in: 0,
        tokens_out: 0,
      };
      entry.calls += 1;
      entry.tokens_in += ev.input_tokens;
      entry.tokens_out += ev.output_tokens;
      ctx.model_breakdown.set(ev.model, entry);
      break;
    }
    case "tool_call":
      ctx.tool_call_count += 1;
      break;
    case "user_input_request":
      ctx.user_input_count += 1;
      ctx.endStatus = "user_input_pending";
      break;
    case "tool_approval_request":
      ctx.endStatus = "hil_paused";
      break;
    case "message":
      ctx.assistant_pieces.push(ev.content);
      break;
    case "error":
      ctx.error_count += 1;
      ctx.horn_max = ctx.horn_max === 3 ? 3 : 2;
      ctx.endStatus = "error";
      break;
    case "done":
      ctx.endStatus = "ok";
      break;
    default:
      break;
  }
}

export function pushTraceEnd(ctx: TraceContext, statusOverride?: TraceStatus): void {
  const status = statusOverride ?? ctx.endStatus;
  const summary: TraceSummary = {
    assistant_message: ctx.assistant_pieces.join("\n").slice(0, 1000),
    tokens_total_in: ctx.tokens_in,
    tokens_total_out: ctx.tokens_out,
    tool_call_count: ctx.tool_call_count,
    user_input_count: ctx.user_input_count,
    error_count: ctx.error_count,
    horn_max: ctx.horn_max,
    model_breakdown: [...ctx.model_breakdown.values()],
  };
  getNightWatchClient().push({
    op: "trace_end",
    trace_id: ctx.trace_id,
    ended_at: Date.now(),
    status,
    summary,
  });
}

/**
 * Wrap an AgentEvent generator with Night's Watch trace lifecycle.
 *
 * - On first iteration: emit trace_start (caller-controlled — pass `traceStart` arg).
 * - For each yielded event: map → push to NightWatch.
 * - On end / throw: emit trace_end with appropriate status.
 *
 * `traceStart` is sent here (instead of by the caller) so that a thrown error
 * before the first yield still produces both trace_start and trace_end.
 */
export async function* withNightWatchTrace(
  ctx: TraceContext,
  traceStart: TraceStart,
  source: AsyncGenerator<AgentEvent>,
): AsyncGenerator<AgentEvent> {
  pushTraceStart(traceStart);
  let threw: unknown = null;
  try {
    for await (const ev of source) {
      recordAccum(ctx, ev);
      const rec = mapAgentEvent(ev, {
        trace_id: ctx.trace_id,
        nextSeq: () => ctx.seq++,
      });
      if (rec) pushEvent(rec);
      yield ev;
    }
  } catch (e) {
    threw = e;
    ctx.error_count += 1;
    ctx.endStatus = "error";
    throw e;
  } finally {
    pushTraceEnd(ctx, threw ? "error" : undefined);
  }
}

/* ------------------------------------------------------------------------- */
/* LLM-specific events (instance.ts agentLoop 가 직접 발행)                    */
/* ------------------------------------------------------------------------- */

export interface LlmRequestSnapshot {
  model: string;
  message_count: number;
  tool_count: number;
  system_chars: number;
  /** 첫 system 블록 프리뷰 — 디버깅 용. */
  system_preview?: string;
}

export interface LlmRequestHandle {
  event_id: string;
  started_at: number;
  model: string;
}

export function recordLlmRequest(
  ctx: TraceContext,
  snapshot: LlmRequestSnapshot,
): LlmRequestHandle {
  const event_id = randomUUID();
  const ts = Date.now();
  pushEvent({
    event_id,
    trace_id: ctx.trace_id,
    seq: ctx.seq++,
    kind: "llm_request",
    ts,
    model: snapshot.model,
    payload: {
      message_count: snapshot.message_count,
      tool_count: snapshot.tool_count,
      system_chars: snapshot.system_chars,
      ...(snapshot.system_preview ? { system_preview: snapshot.system_preview } : {}),
    },
    payload_summary: `${snapshot.model} (${snapshot.message_count} msgs, ${snapshot.tool_count} tools)`,
  });
  return { event_id, started_at: ts, model: snapshot.model };
}

export function recordLlmResponse(
  ctx: TraceContext,
  parent: LlmRequestHandle,
  response: LLMResponse,
): void {
  const ts = Date.now();
  pushEvent({
    event_id: randomUUID(),
    trace_id: ctx.trace_id,
    seq: ctx.seq++,
    parent_event_id: parent.event_id,
    kind: "llm_response",
    ts,
    duration_ms: ts - parent.started_at,
    model: parent.model,
    tokens_in: response.usage.input_tokens,
    tokens_out: response.usage.output_tokens,
    cache_creation_tokens: response.usage.cache_creation_input_tokens,
    cache_read_tokens: response.usage.cache_read_input_tokens,
    reasoning_tokens: response.usage.reasoning_tokens,
    status: "ok",
    payload: {
      stop_reason: response.stop_reason,
      content_kinds: response.content.map((b) => b.type),
    },
    payload_summary: `stop=${response.stop_reason} in=${response.usage.input_tokens} out=${response.usage.output_tokens}`,
  });

  if (response.reasoning && response.reasoning.length > 0) {
    pushEvent({
      event_id: randomUUID(),
      trace_id: ctx.trace_id,
      seq: ctx.seq++,
      parent_event_id: parent.event_id,
      kind: "llm_reasoning",
      ts: Date.now(),
      model: parent.model,
      reasoning_tokens: response.usage.reasoning_tokens,
      payload: { reasoning: response.reasoning.slice(0, 8192) },
      payload_summary: `${response.reasoning.length} chars`,
    });
  }
}

export function recordLlmError(
  ctx: TraceContext,
  parent: LlmRequestHandle,
  err: Error & { status?: number; body?: string; retryAfter?: number },
): void {
  const ts = Date.now();
  pushEvent({
    event_id: randomUUID(),
    trace_id: ctx.trace_id,
    seq: ctx.seq++,
    parent_event_id: parent.event_id,
    kind: "llm_error",
    ts,
    duration_ms: ts - parent.started_at,
    model: parent.model,
    status: "error",
    payload: {
      name: err.name,
      message: err.message,
      ...(typeof err.status === "number" ? { http_status: err.status } : {}),
      ...(typeof err.retryAfter === "number" ? { retry_after_s: err.retryAfter } : {}),
      ...(typeof err.body === "string" ? { body_preview: err.body.slice(0, 1024) } : {}),
    },
    payload_summary: `${parent.model}: ${err.message.slice(0, 120)}`,
  });
  ctx.error_count += 1;
  // LLM error 는 horn level 2 후보 — 단 horn classifier 는 night-watch 서버측이
  // 결정하므로 여기서는 raw signal 만 기록.
}

/* ------------------------------------------------------------------------- */
/* tool_approval_decision — agent-runner 가 호출                              */
/* ------------------------------------------------------------------------- */

export interface ToolApprovalDecisionPayload {
  sessionId: string;
  decision: "auto_approve" | "hil";
  reason: string;
  trace?: unknown;
  toolCalls: PendingToolCall[];
}

export function recordToolApprovalDecision(
  ctx: TraceContext,
  payload: ToolApprovalDecisionPayload,
): void {
  pushEvent({
    event_id: randomUUID(),
    trace_id: ctx.trace_id,
    seq: ctx.seq++,
    kind: "tool_approval_decision",
    ts: Date.now(),
    payload: {
      sessionId: payload.sessionId,
      decision: payload.decision,
      reason: payload.reason,
      tools: payload.toolCalls.map((t) => ({ name: t.name, toolUseId: t.toolUseId })),
      ...(payload.trace !== undefined ? { trace: payload.trace } : {}),
    },
    payload_summary: `${payload.decision}: ${payload.toolCalls.map((t) => t.name).join(", ")}`,
  });
}
