/**
 * AgentEvent → EventRecord 매핑.
 *
 * mini-agent 의 in-process AgentEvent 스트림을 Night's Watch wire EventRecord 로
 * 변환. text_delta 같이 너무 빈번한 이벤트는 drop (null 반환). seq 는 caller 가
 * 단조 증가 카운터로 공급.
 *
 * 보안: 도구 args / output 의 vault ref (`@vault:...`) 는 그대로 전송. agent.ts
 * 의 resolveToolArgsVaultRefs 는 executeSkill 직전에만 작동하므로, AgentEvent 의
 * tool_call.args 는 이미 ref 형태이고, tool_result.output 도 skill handler 가
 * 반환한 텍스트라 secret 노출 위험 낮음.
 */

import { randomUUID } from "node:crypto";
import type { AgentEvent } from "../types";
import type { EventRecord } from "./wire";

export interface MapContext {
  trace_id: string;
  /** Caller-provided seq generator. Must be unique within trace. */
  nextSeq: () => number;
}

const TOOL_OUTPUT_PREVIEW_MAX = 4096;
const PAYLOAD_SUMMARY_MAX = 200;

function summary(s: string): string {
  return s.length > PAYLOAD_SUMMARY_MAX ? `${s.slice(0, PAYLOAD_SUMMARY_MAX)}…` : s;
}

export function mapAgentEvent(ev: AgentEvent, ctx: MapContext): EventRecord | null {
  // Drop high-frequency / non-recordable kinds BEFORE consuming a seq slot —
  // otherwise the timeline shows visible gaps (#1 → #6) when a streamed
  // assistant reply produces several text_delta chunks. mini-agent 의 chatStream
  // 은 한 응답을 N 청크로 yield 하므로 N seq 가 통째로 소실되었음.
  if (ev.type === "text_delta") return null;

  const ts = Date.now();
  const event_id = randomUUID();
  const seq = ctx.nextSeq();
  const base = { event_id, trace_id: ctx.trace_id, seq, ts } as const;

  switch (ev.type) {
    case "persona_resolved":
      return {
        ...base,
        kind: "persona_resolved",
        payload: { persona: ev.persona, ref: ev.ref },
        payload_summary: summary(`${ev.persona}@${ev.ref.slice(0, 7)}`),
      };
    case "memory_recalled":
      return {
        ...base,
        kind: "memory_recalled",
        payload: { count: ev.count, ids: ev.ids },
        payload_summary: summary(`${ev.count} hits`),
      };
    case "curriculum_recalled":
      return {
        ...base,
        kind: "curriculum_recalled",
        model: ev.model,
        payload: { count: ev.count, problem_ids: ev.problem_ids },
        payload_summary: summary(`${ev.count} hits`),
      };
    case "self_map_recalled":
      return {
        ...base,
        kind: "self_map_recalled",
        model: ev.model,
        payload: { count: ev.count, problem_ids: ev.problem_ids },
        payload_summary: summary(`${ev.count} cells`),
      };
    case "recent_sessions_recalled":
      return {
        ...base,
        kind: "recent_sessions_recalled",
        model: ev.model,
        payload: { count: ev.count, session_ids: ev.session_ids },
        payload_summary: summary(`${ev.count} sessions`),
      };
    case "tool_call":
      return {
        ...base,
        kind: "tool_call",
        payload: { name: ev.name, args: ev.args },
        payload_summary: summary(ev.name),
      };
    case "tool_result": {
      const out = ev.output ?? "";
      return {
        ...base,
        kind: "tool_result",
        payload: {
          name: ev.name,
          output: out.slice(0, TOOL_OUTPUT_PREVIEW_MAX),
          truncated: out.length > TOOL_OUTPUT_PREVIEW_MAX,
        },
        payload_summary: summary(`${ev.name} → ${out.length}b`),
      };
    }
    case "tool_rejected":
      return {
        ...base,
        kind: "tool_rejected",
        payload: { name: ev.name },
        payload_summary: summary(ev.name),
      };
    case "tool_approval_request":
      return {
        ...base,
        kind: "tool_approval_request",
        payload: {
          sessionId: ev.sessionId,
          tools: ev.toolCalls.map((t) => ({ name: t.name, toolUseId: t.toolUseId })),
        },
        payload_summary: summary(
          `${ev.toolCalls.length} tool${ev.toolCalls.length === 1 ? "" : "s"} pending`,
        ),
      };
    case "user_input_request":
      return {
        ...base,
        kind: "user_input_request",
        payload: {
          kind: ev.kind,
          question: ev.question,
          options: ev.options,
          multi: ev.multi,
        },
        payload_summary: summary(`${ev.kind}: ${ev.question}`),
      };
    case "chat_usage":
      return {
        ...base,
        kind: "chat_usage",
        model: ev.model,
        tokens_in: ev.input_tokens,
        tokens_out: ev.output_tokens,
        cache_creation_tokens: ev.cache_creation_input_tokens,
        cache_read_tokens: ev.cache_read_input_tokens,
        payload_summary: summary(
          `in=${ev.input_tokens} out=${ev.output_tokens}` +
            (ev.cache_read_input_tokens
              ? ` cache_read=${ev.cache_read_input_tokens}`
              : ""),
        ),
      };
    case "message":
      return {
        ...base,
        kind: "message",
        payload: { content: ev.content },
        payload_summary: summary(ev.content),
      };
    case "thinking":
      // Map agent's intermediate "thinking" event to llm_reasoning kind.
      return {
        ...base,
        kind: "llm_reasoning",
        payload: { content: ev.content },
        payload_summary: summary(ev.content),
      };
    case "done":
      return { ...base, kind: "done" };
    case "error":
      return {
        ...base,
        kind: "error",
        status: "error",
        payload: { message: ev.message },
        payload_summary: summary(ev.message),
      };
    default: {
      // exhaustiveness check
      const _exhaustive: never = ev;
      void _exhaustive;
      return null;
    }
  }
}
