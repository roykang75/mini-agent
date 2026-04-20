/**
 * AgentInstance (ADR-005).
 *
 * Agent 가 persistent stateful entity 로서 자기 working memory 를 소유한다.
 * sid (쿠키) 당 하나의 인스턴스. `summonAgent(sid)` 로 불러냄.
 *
 * 기존 `runAgent()` 의 턴별 휘발성 messages 배열을 AgentInstance.messages
 * 로 승격 — 같은 sid 의 연속 receive() 호출에서 이전 턴의 맥락이 보존.
 *
 * API 의도:
 *   - receive(userMessage, personaReq?) — "나에게 메시지 도착"
 *   - resumeAfterApproval(sessionId, approved, credentials?) — HIL 이후 복귀
 *   - introspect() — "나를 돌아봄"
 *   - dispose() — "나를 놓아줌" (sid 만료 시)
 *
 * Storage shape (Map<sid, Message[]>) 이 아니라 entity shape.
 * Map<sid, AgentInstance> 는 "agents 의 집" 이지 메시지 저장소가 아니다.
 */

import { createHash, randomUUID } from "node:crypto";
import { getSkillTools, executeSkill } from "../skills/loader";
import { loadSoul, type SoulRequest } from "../souls/loader";
import type { PersonaName } from "../souls/registry.generated";
import { createLLMClient } from "../llm/client";
import { vault, makeVaultRef, resolveVaultRefs } from "../vault";
import {
  appendRaw,
  closeRaw,
  newMemorySessionId,
  setPersona as rawSetPersona,
} from "../memory/raw";
import { composeCombinedRecall, shouldRecall } from "../memory/recall";
import type { Message, ContentBlock, LLMResponse } from "../llm/types";
import type { AgentEvent, PendingToolCall } from "../types";
import { createLogger } from "../log";
import {
  type SerializedAgentState,
  type SerializedPendingApproval,
  type WorkingMemoryStore,
  getWorkingMemoryStore,
} from "./store";

const log = createLogger("agent");

/** Working state TTL in seconds — matches sid cookie lifetime (24h). */
export const SID_TTL_SEC = 24 * 60 * 60;

const MODEL_ID = process.env.LLM_MODEL ?? "claude-sonnet-4-6";

// Curriculum recall (ADR-006 Phase A). 실 세션 receive 경로에 3-인칭 훈련 기록을
// surface 한다. `CURRICULUM_DIR` 가 빈 문자열로 세팅되면 curriculum 경로 비활성.
const CURRICULUM_DIR_RAW =
  process.env.CURRICULUM_DIR ?? "/Users/roy/Workspace/agent/agent-curriculum";
const CURRICULUM_DIR: string | null = CURRICULUM_DIR_RAW === "" ? null : CURRICULUM_DIR_RAW;

// Self-map inject (ADR-006-v2 Phase 2). `PROFILE_SELF_MAP=on` 으로 활성. 기본은
// off — Phase 2 A/B 에서 `off` branch 가 Phase 1.5 이전 동작과 동일하도록 보장.
// env 는 매 receive() 에서 읽어 동일 프로세스 내 A/B 순차 실행을 허용.
function isProfileSelfMapOn(): boolean {
  return (process.env.PROFILE_SELF_MAP ?? "off").toLowerCase() === "on";
}

const client = createLLMClient();

export const REQUEST_CREDENTIAL_TOOL = "request_credential";
export const ASK_ADVISOR_TOOL = "ask_advisor";

import { loadRuntimeLimits } from "../config/limits";

/**
 * Retry 상수들은 runtime-limits config 에서 온다. env (RETRY_LIMIT /
 * ADVISOR_CALL_LIMIT) 가 있으면 override. 값 source 는 `config/runtime-limits.json`.
 * 향후 UI 편집 지점.
 */
const _limits = loadRuntimeLimits();
/** Max allowed identical (name, args) tool attempts within a single agent session. */
export const RETRY_LIMIT = _limits.retry.tool_call_retry_limit;
/** Max advisor calls per AgentInstance lifetime. Infinity = 무제한. */
export const ADVISOR_CALL_LIMIT = _limits.retry.advisor_call_limit;

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(",")}}`;
}

export function hashToolCall(name: string, args: unknown): string {
  return createHash("sha256")
    .update(`${name}\u0000${canonicalize(args)}`)
    .digest("hex")
    .slice(0, 16);
}

export function countPriorToolUses(messages: Message[], hash: string): number {
  let count = 0;
  for (const m of messages) {
    if (m.role !== "assistant" || typeof m.content === "string") continue;
    for (const block of m.content) {
      if (block.type === "tool_use" && hashToolCall(block.name, block.input) === hash) {
        count++;
      }
    }
  }
  return count;
}

async function resolveToolArgsVaultRefs(sid: string, value: unknown): Promise<unknown> {
  if (typeof value === "string") {
    return value.includes("@vault:") ? await resolveVaultRefs(sid, value) : value;
  }
  if (Array.isArray(value)) {
    return Promise.all(value.map((v) => resolveToolArgsVaultRefs(sid, v)));
  }
  if (value && typeof value === "object") {
    const entries = await Promise.all(
      Object.entries(value as Record<string, unknown>).map(async ([k, v]) => [
        k,
        await resolveToolArgsVaultRefs(sid, v),
      ] as const),
    );
    return Object.fromEntries(entries);
  }
  return value;
}

type PendingApproval = SerializedPendingApproval;

export interface AgentIntrospection {
  sid: string;
  messageCount: number;
  persona: PersonaName | null;
  personaRef: string | null;
  advisorCalls: number;
  pending: { sessionId: string; toolCount: number } | null;
  createdAt: number;
  lastActiveAt: number;
}

async function* withRawCapture(
  memoryId: string,
  source: AsyncGenerator<AgentEvent>,
): AsyncGenerator<AgentEvent> {
  try {
    for await (const ev of source) {
      if (ev.type === "persona_resolved") {
        rawSetPersona(memoryId, ev.persona, ev.ref);
      }
      if (ev.type !== "text_delta") {
        await appendRaw(memoryId, ev.type, ev);
      }
      yield ev;
      if (ev.type === "done" || ev.type === "error") {
        await closeRaw(memoryId);
      }
    }
  } catch (e) {
    await closeRaw(memoryId);
    throw e;
  }
}

export class AgentInstance {
  readonly sid: string;
  readonly createdAt: number;
  private lastActiveAt: number;

  private messages: Message[] = [];
  private systemPrompt: string = "";
  private resolvedPersona: PersonaName | null = null;
  private resolvedRef: string | null = null;

  private advisorCalls: number = 0;
  private pending: PendingApproval | null = null;

  constructor(sid: string, hydrated?: SerializedAgentState) {
    this.sid = sid;
    if (hydrated) {
      this.createdAt = hydrated.createdAt;
      this.lastActiveAt = hydrated.lastActiveAt;
      this.messages = hydrated.messages;
      this.systemPrompt = hydrated.systemPrompt;
      this.resolvedPersona = hydrated.resolvedPersona;
      this.resolvedRef = hydrated.resolvedRef;
      this.advisorCalls = hydrated.advisorCalls;
      this.pending = hydrated.pending;
    } else {
      this.createdAt = Date.now();
      this.lastActiveAt = this.createdAt;
    }
  }

  static fromSerialized(state: SerializedAgentState): AgentInstance {
    if (state.version !== 1) {
      throw new Error(`AgentInstance: unknown state version ${state.version}`);
    }
    return new AgentInstance(state.sid, state);
  }

  serialize(): SerializedAgentState {
    return {
      version: 1,
      sid: this.sid,
      messages: this.messages,
      systemPrompt: this.systemPrompt,
      resolvedPersona: this.resolvedPersona,
      resolvedRef: this.resolvedRef,
      advisorCalls: this.advisorCalls,
      pending: this.pending,
      createdAt: this.createdAt,
      lastActiveAt: this.lastActiveAt,
    };
  }

  async persist(store?: WorkingMemoryStore): Promise<void> {
    const s = store ?? getWorkingMemoryStore();
    try {
      await s.put(this.sid, this.serialize(), SID_TTL_SEC);
    } catch (e) {
      log.warn(
        { event: "persist_failed", sid: this.sid, err_message: (e as Error).message },
        "store.put failed — working memory not persisted this turn",
      );
    }
  }

  /** Roy 가 메시지를 보냄 → 내가 받아서 내 messages 에 통합하고 추론. */
  async *receive(
    userMessage: string,
    personaReq: SoulRequest = {},
  ): AsyncGenerator<AgentEvent> {
    if (this.pending) {
      yield {
        type: "error",
        message: "agent is awaiting approval — resolve via /chat/approve first",
      };
      return;
    }
    this.lastActiveAt = Date.now();

    const memoryId = newMemorySessionId();
    await appendRaw(memoryId, "user_message", { content: userMessage, sid: this.sid });

    try {
      yield* withRawCapture(memoryId, this.runReceive(userMessage, personaReq, memoryId));
    } finally {
      await this.persist();
    }
  }

  private async *runReceive(
    userMessage: string,
    personaReq: SoulRequest,
    memoryId: string,
  ): AsyncGenerator<AgentEvent> {
    const soul = await loadSoul(personaReq);
    this.resolvedPersona = soul.resolvedPersona;
    this.resolvedRef = soul.resolvedRef;
    this.systemPrompt = soul.systemPrompt;

    yield {
      type: "persona_resolved",
      persona: soul.resolvedPersona,
      ref: soul.resolvedRef,
    };

    // Memory + curriculum recall only on the very first receive (empty working memory).
    if (this.messages.length === 0) {
      const memoryDir = process.env.AGENT_MEMORY_DIR;
      if (memoryDir && shouldRecall(this.sid)) {
        const { prompt, memoryHits, curriculumHits, selfMapHits } =
          await composeCombinedRecall(
            memoryDir,
            CURRICULUM_DIR,
            MODEL_ID,
            userMessage,
            {
              includeSelfMap: isProfileSelfMapOn(),
              includeRecentSessions: true,
            },
          );
        if (prompt.length > 0) {
          this.systemPrompt = `${this.systemPrompt}\n${prompt}`;
        }
        if (memoryHits.length > 0) {
          yield {
            type: "memory_recalled",
            count: memoryHits.length,
            ids: memoryHits.map((h) => h.episode.id),
          };
        }
        if (curriculumHits.length > 0) {
          yield {
            type: "curriculum_recalled",
            count: curriculumHits.length,
            problem_ids: curriculumHits.map((h) => h.record.problem_id),
            model: MODEL_ID,
          };
        }
        if (selfMapHits.length > 0) {
          yield {
            type: "self_map_recalled",
            count: selfMapHits.length,
            problem_ids: selfMapHits.map((h) => h.cell.problem_id),
            model: MODEL_ID,
          };
        }
      }
    }

    this.messages.push({ role: "user", content: userMessage });

    yield* this.agentLoop(memoryId);
  }

  /** HIL 승인/거부 후 내가 중단된 지점부터 이어감. */
  async *resumeAfterApproval(
    sessionId: string,
    approved: boolean,
    credentials?: Record<string, string>,
  ): AsyncGenerator<AgentEvent> {
    if (!this.pending) {
      yield { type: "error", message: "no pending approval for this agent" };
      return;
    }
    if (this.pending.sessionId !== sessionId) {
      yield { type: "error", message: "approval sessionId does not match pending" };
      return;
    }
    this.lastActiveAt = Date.now();
    const pending = this.pending;
    this.pending = null;

    try {
      yield* withRawCapture(pending.memoryId, this.runResume(pending, approved, credentials));
    } finally {
      await this.persist();
    }
  }

  private async *runResume(
    pending: PendingApproval,
    approved: boolean,
    credentials?: Record<string, string>,
  ): AsyncGenerator<AgentEvent> {
    if (!approved) {
      const results: ContentBlock[] = pending.pendingToolCalls.map((tc) => ({
        type: "tool_result" as const,
        tool_use_id: tc.toolUseId,
        content: "사용자가 이 도구의 실행을 거부했습니다.",
        is_error: true,
      }));
      this.messages.push({ role: "user", content: results });
      for (const tc of pending.pendingToolCalls) {
        yield { type: "tool_rejected", name: tc.name };
      }
      yield* this.agentLoop(pending.memoryId);
      return;
    }

    const results: ContentBlock[] = [];
    for (const tc of pending.pendingToolCalls) {
      let output: string;
      let isError = false;

      if (tc.name === REQUEST_CREDENTIAL_TOOL) {
        const key = typeof (tc.args as { key?: unknown }).key === "string"
          ? ((tc.args as { key: string }).key)
          : undefined;
        const credential = credentials?.[tc.toolUseId];
        if (!key) {
          output = "request_credential: 'key' 인자가 누락되었습니다.";
          isError = true;
        } else if (typeof credential !== "string" || credential.length === 0) {
          output = "request_credential: 사용자 입력값이 제공되지 않았습니다.";
          isError = true;
        } else {
          await vault.put(this.sid, key, credential);
          output = makeVaultRef(key);
        }
      } else {
        const hash = hashToolCall(tc.name, tc.args);
        const attemptCount = countPriorToolUses(this.messages, hash);
        const overAdvisorLimit =
          tc.name === ASK_ADVISOR_TOOL &&
          Number.isFinite(ADVISOR_CALL_LIMIT) &&
          this.advisorCalls >= ADVISOR_CALL_LIMIT;

        if (attemptCount > RETRY_LIMIT) {
          output = JSON.stringify({
            error: "retry_limit_exceeded",
            tool: tc.name,
            limit: RETRY_LIMIT,
            attempts: attemptCount,
            hint: "같은 인자로 반복 호출하고 있습니다. 입력을 바꾸거나 다른 도구/접근으로 전환하세요.",
          });
          isError = true;
        } else if (overAdvisorLimit) {
          output = JSON.stringify({
            error: "advisor_call_limit_exceeded",
            limit: ADVISOR_CALL_LIMIT,
            calls: this.advisorCalls,
            hint: "세션당 advisor 호출 한도를 초과했습니다. 직접 추론으로 돌아가거나 사용자에게 현재 맥락을 요약해 보고하세요.",
          });
          isError = true;
          log.warn(
            { event: "advisor_call_limit_exceeded", sid: this.sid, limit: ADVISOR_CALL_LIMIT, calls: this.advisorCalls },
            "advisor call limit tripped",
          );
        } else {
          if (tc.name === ASK_ADVISOR_TOOL) this.advisorCalls++;
          try {
            const resolvedArgs = await resolveToolArgsVaultRefs(this.sid, tc.args);
            output = await executeSkill(tc.name, resolvedArgs);
          } catch (e) {
            const err = e as Error;
            output = JSON.stringify({
              error: "tool_execution_failed",
              tool: tc.name,
              message: err.message,
              hint: "도구 입력이 스키마에 맞지 않거나 실행 중 예외가 발생했습니다. 인자를 점검하고 다시 호출하세요.",
            });
            isError = true;
            log.warn(
              {
                event: "tool_execution_failed",
                tool_name: tc.name,
                error: { name: err.name, message: err.message },
              },
              "tool threw — returning structured tool_result",
            );
          }
        }
      }

      yield { type: "tool_result", name: tc.name, output };
      results.push({
        type: "tool_result",
        tool_use_id: tc.toolUseId,
        content: output,
        ...(isError ? { is_error: true } : {}),
      });
    }
    this.messages.push({ role: "user", content: results });

    yield* this.agentLoop(pending.memoryId);
  }

  private async *agentLoop(memoryId: string): AsyncGenerator<AgentEvent> {
    while (true) {
      let response: LLMResponse | undefined;
      for await (const ev of client.chatStream({
        model: MODEL_ID,
        max_tokens: 4096,
        system: [
          { type: "text", text: this.systemPrompt, cache_control: { type: "ephemeral" } },
        ],
        tools: getSkillTools(),
        messages: this.messages,
      })) {
        if (ev.type === "text_delta") {
          yield { type: "text_delta", delta: ev.text };
        } else if (ev.type === "done") {
          response = ev.response;
        }
      }
      if (!response) throw new Error("agent: chatStream ended without done event");

      // Token / cache usage — budget 계산과 관찰성의 기초.
      // raw append middleware 가 자동으로 이 이벤트를 memory raw 에도 기록.
      yield {
        type: "chat_usage",
        model: MODEL_ID,
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        cache_creation_input_tokens: response.usage.cache_creation_input_tokens,
        cache_read_input_tokens: response.usage.cache_read_input_tokens,
      };

      this.messages.push({ role: "assistant", content: response.content });

      for (const block of response.content) {
        if (block.type === "text") {
          yield { type: "message", content: block.text };
        }
      }

      const toolUseBlocks = response.content.filter(
        (b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use",
      );

      if (toolUseBlocks.length > 0) {
        for (const block of toolUseBlocks) {
          yield {
            type: "tool_call",
            name: block.name,
            args: block.input as Record<string, unknown>,
          };
        }

        const pendingToolCalls: PendingToolCall[] = toolUseBlocks.map((block) => ({
          toolUseId: block.id,
          name: block.name,
          args: block.input as Record<string, unknown>,
        }));

        const sessionId = randomUUID();
        this.pending = {
          sessionId,
          pendingToolCalls,
          lastAssistantContent: response.content,
          memoryId,
        };

        yield {
          type: "tool_approval_request",
          sessionId,
          toolCalls: pendingToolCalls,
        };
        return;
      }

      if (response.stop_reason !== "tool_use") {
        yield { type: "done" };
        break;
      }
    }
  }

  introspect(): AgentIntrospection {
    return {
      sid: this.sid,
      messageCount: this.messages.length,
      persona: this.resolvedPersona,
      personaRef: this.resolvedRef,
      advisorCalls: this.advisorCalls,
      pending: this.pending
        ? { sessionId: this.pending.sessionId, toolCount: this.pending.pendingToolCalls.length }
        : null,
      createdAt: this.createdAt,
      lastActiveAt: this.lastActiveAt,
    };
  }

  /** Test-only — reset messages so a fresh receive() starts clean. */
  __resetForTest(): void {
    this.messages = [];
    this.pending = null;
    this.advisorCalls = 0;
  }

  dispose(): void {
    this.messages = [];
    this.pending = null;
  }

  /** Exposed for routes that need to validate approval sessionId before calling resume. */
  get pendingSessionId(): string | null {
    return this.pending?.sessionId ?? null;
  }

  get pendingToolCalls(): readonly PendingToolCall[] {
    return this.pending?.pendingToolCalls ?? [];
  }
}
