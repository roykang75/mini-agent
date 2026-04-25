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
import { getSkillTools, executeSkill, ASK_USER_TOOL } from "../skills/loader";
import { BUILTIN_TOOL_GUIDE } from "./builtin-tool-guide";
import { loadSoul, type SoulRequest } from "../souls/loader";
import type { PersonaName } from "../souls/registry.generated";
import type { LLMClient } from "../llm/client";
import {
  resolveProfile,
  getClientForProfile,
  getDefaultProfileName,
  type LlmProfile,
} from "../llm/profiles";
import { vault, makeVaultRef, resolveVaultRefs } from "../vault";
import {
  appendRaw,
  closeRaw,
  newMemorySessionId,
  setPersona as rawSetPersona,
} from "../memory/raw";
import { maybeSpawnConsolidate } from "../memory/auto-consolidate";
import { composeCombinedRecall, shouldRecall } from "../memory/recall";
import type { Message, ContentBlock, LLMResponse } from "../llm/types";
import type {
  AgentEvent,
  PendingToolCall,
  UserInputAnswer,
  AskUserOption,
} from "../types";
import { createLogger } from "../log";
import {
  newTraceContext,
  pushSessionUpsert,
  recordLlmError,
  recordLlmRequest,
  recordLlmResponse,
  recordToolApprovalDecision as nwRecordToolApprovalDecision,
  withNightWatchTrace,
  type ToolApprovalDecisionPayload,
  type TraceContext,
} from "../observability/nw-trace";
import {
  type SerializedAgentState,
  type SerializedPendingApproval,
  type SerializedPendingUserInput,
  type WorkingMemoryStore,
  getWorkingMemoryStore,
} from "./store";

export { ASK_USER_TOOL } from "../skills/loader";

const log = createLogger("agent");

/** Identity name for Night's Watch ingestion (AgentIdentity.name + agent_name). */
const NW_AGENT_NAME = "mini-agent";

/** Working state TTL in seconds — matches sid cookie lifetime (24h). */
export const SID_TTL_SEC = 24 * 60 * 60;

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
type PendingUserInput = SerializedPendingUserInput;

interface ValidatedAskUserInput {
  kind: "choose" | "confirm";
  question: string;
  options?: AskUserOption[];
  multi?: boolean;
}

type AskUserValidation =
  | { ok: true; parsed: ValidatedAskUserInput }
  | { ok: false; error: string };

/**
 * `ask_user` tool_use 블록의 input 검증. LLM 이 스키마를 어기거나 options 의 id
 * 를 중복으로 만들 수 있으므로 런타임에서 한 번 더 거른다. 실패 시 `error`
 * 메시지를 그대로 tool_result 로 내려보내면 LLM 이 재호출을 시도.
 */
export function validateAskUserInput(raw: unknown): AskUserValidation {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "ask_user input must be an object." };
  }
  const obj = raw as Record<string, unknown>;
  const kind = obj.kind;
  if (kind !== "choose" && kind !== "confirm") {
    return { ok: false, error: "ask_user.kind must be 'choose' or 'confirm'." };
  }
  const question = obj.question;
  if (typeof question !== "string" || question.trim().length === 0) {
    return { ok: false, error: "ask_user.question must be a non-empty string." };
  }
  if (kind === "confirm") {
    return { ok: true, parsed: { kind: "confirm", question } };
  }
  // kind === "choose"
  const optsRaw = obj.options;
  if (!Array.isArray(optsRaw)) {
    return { ok: false, error: "ask_user.options is required when kind='choose'." };
  }
  if (optsRaw.length < 2 || optsRaw.length > 5) {
    return { ok: false, error: "ask_user.options must have 2~5 items." };
  }
  const options: AskUserOption[] = [];
  const ids = new Set<string>();
  for (const o of optsRaw) {
    if (!o || typeof o !== "object") {
      return { ok: false, error: "each option must be an object with id and label." };
    }
    const opt = o as Record<string, unknown>;
    if (typeof opt.id !== "string" || opt.id.length === 0) {
      return { ok: false, error: "each option.id must be a non-empty string." };
    }
    if (typeof opt.label !== "string" || opt.label.length === 0) {
      return { ok: false, error: "each option.label must be a non-empty string." };
    }
    if (ids.has(opt.id)) {
      return { ok: false, error: `duplicate option.id "${opt.id}" — ids must be unique.` };
    }
    ids.add(opt.id);
    const entry: AskUserOption = { id: opt.id, label: opt.label };
    if (typeof opt.description === "string" && opt.description.length > 0) {
      entry.description = opt.description;
    }
    options.push(entry);
  }
  const multi = obj.multi === true;
  return { ok: true, parsed: { kind: "choose", question, options, multi } };
}

export interface AgentIntrospection {
  sid: string;
  messageCount: number;
  persona: PersonaName | null;
  personaRef: string | null;
  /** 세션에 고정된 LLM profile 이름 (receive() 첫 호출에서 결정). */
  profileName: string;
  /** profile 에 연결된 실제 모델 식별자 (관찰성용). */
  model: string;
  advisorCalls: number;
  pending: { sessionId: string; toolCount: number } | null;
  pendingUserInput: { sessionId: string; kind: "choose" | "confirm" } | null;
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
        const rawPath = await closeRaw(memoryId);
        maybeSpawnConsolidate(rawPath, process.env.AGENT_MEMORY_DIR);
      }
    }
  } catch (e) {
    const rawPath = await closeRaw(memoryId);
    maybeSpawnConsolidate(rawPath, process.env.AGENT_MEMORY_DIR);
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
  private pendingUserInput: PendingUserInput | null = null;
  private profileName: string | null = null;

  /** Active Night's Watch trace (one per receive/resume turn). null when idle. */
  private currentTrace: TraceContext | null = null;
  /** Whether session_upsert has been emitted for this AgentInstance. */
  private nwSessionEmitted: boolean = false;

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
      this.pendingUserInput = hydrated.pendingUserInput ?? null;
      this.profileName = hydrated.profileName ?? null;
    } else {
      this.createdAt = Date.now();
      this.lastActiveAt = this.createdAt;
    }
  }

  /** 현재 세션의 LLM profile (lazy, default fallback). */
  private get currentProfile(): LlmProfile {
    return resolveProfile(this.profileName);
  }

  private get llmClient(): LLMClient {
    return getClientForProfile(this.currentProfile);
  }

  private get modelId(): string {
    return this.currentProfile.model;
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
      pendingUserInput: this.pendingUserInput,
      profileName: this.profileName,
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

  /**
   * Roy 가 메시지를 보냄 → 내가 받아서 내 messages 에 통합하고 추론.
   *
   * profileName 은 첫 receive() 호출에서만 효력 — 세션 시작 후에는 락돼서
   * 무시된다. 대화 중 모델 전환 시 tool_use / prompt caching 호환성 문제와
   * 추론 궤적 불연속이 생기므로 명시적으로 금지. 모델을 바꾸려면 새 sid 세션으로.
   */
  async *receive(
    userMessage: string,
    personaReq: SoulRequest = {},
    profileName?: string,
  ): AsyncGenerator<AgentEvent> {
    if (this.pending) {
      yield {
        type: "error",
        message: "agent is awaiting approval — resolve via /chat/approve first",
      };
      return;
    }
    // pendingUserInput (UX 게이트) 은 auto-cancel. 사용자가 새 메시지를 보낸 것
    // 자체가 "이전 질문은 넘어가고 이걸 해줘" 라는 명시적 신호. approval 의
    // `pending` (보안 게이트) 과는 역할이 달라서 자동 취소 규칙에서 제외한다.
    if (this.pendingUserInput) {
      const pending = this.pendingUserInput;
      this.pendingUserInput = null;
      this.messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: pending.toolUseId,
            content: JSON.stringify({
              cancelled: true,
              reason: "사용자가 새 메시지를 보내 이전 질문을 취소함.",
            }),
            is_error: true,
          },
        ],
      });
    }
    // Profile lock-on-first-use: 첫 receive() 의 profileName 이 세션을 고정.
    // 이후 호출에서 다른 값이 넘어와도 무시 — 대화 중 모델 스위치 방지.
    if (!this.profileName) {
      this.profileName = profileName ?? getDefaultProfileName();
    }
    this.lastActiveAt = Date.now();

    const memoryId = newMemorySessionId();
    await appendRaw(memoryId, "user_message", { content: userMessage, sid: this.sid });

    const traceCtx = this.startTrace({ user_message: userMessage });
    try {
      yield* withRawCapture(
        memoryId,
        withNightWatchTrace(
          traceCtx,
          {
            trace_id: traceCtx.trace_id,
            session_id: this.sid,
            agent_name: NW_AGENT_NAME,
            started_at: traceCtx.startedAt,
            user_message: userMessage.slice(0, 1000),
          },
          this.runReceive(userMessage, personaReq, memoryId),
        ),
      );
    } finally {
      this.currentTrace = null;
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
    // Persona systemPrompt 뒤에 framework-level built-in tool 가이드를 무조건
    // append. 약한 모델 (Qwen 등) 에서 ask_user 같은 UX-gate 도구가 발화되도록
    // 시스템 프롬프트에서 "언제·왜" 를 명시하는 층. Recall 은 다시 이 뒤에 붙는다.
    this.systemPrompt = `${soul.systemPrompt}\n\n${BUILTIN_TOOL_GUIDE}`;

    yield {
      type: "persona_resolved",
      persona: soul.resolvedPersona,
      ref: soul.resolvedRef,
    };

    // Memory + curriculum recall only on the very first receive (empty working memory).
    // 14차 실험용 토글: MEMORY_RECALL=off 이면 전체 recall 블록 skip.
    const recallOff = process.env.MEMORY_RECALL === "off";
    if (this.messages.length === 0 && !recallOff) {
      const memoryDir = process.env.AGENT_MEMORY_DIR;
      if (memoryDir && shouldRecall(this.sid)) {
        const { prompt, memoryHits, curriculumHits, selfMapHits, recentSessionsHits } =
          await composeCombinedRecall(
            memoryDir,
            CURRICULUM_DIR,
            this.modelId,
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
            model: this.modelId,
          };
        }
        if (selfMapHits.length > 0) {
          yield {
            type: "self_map_recalled",
            count: selfMapHits.length,
            problem_ids: selfMapHits.map((h) => h.cell.problem_id),
            model: this.modelId,
          };
        }
        if (recentSessionsHits.length > 0) {
          yield {
            type: "recent_sessions_recalled",
            count: recentSessionsHits.length,
            session_ids: recentSessionsHits.map((h) => h.session_id),
            model: this.modelId,
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

    const traceCtx = this.startTrace({
      user_message: `(resume approved=${approved} tools=${pending.pendingToolCalls.map((t) => t.name).join(",")})`,
    });
    try {
      yield* withRawCapture(
        pending.memoryId,
        withNightWatchTrace(
          traceCtx,
          {
            trace_id: traceCtx.trace_id,
            session_id: this.sid,
            agent_name: NW_AGENT_NAME,
            started_at: traceCtx.startedAt,
            metadata: {
              resume_kind: "tool_approval",
              approved,
              tool_count: pending.pendingToolCalls.length,
            },
          },
          this.runResume(pending, approved, credentials),
        ),
      );
    } finally {
      this.currentTrace = null;
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

  /**
   * ask_user 응답 도착 → tool_result 로 변환 후 agentLoop 재진입.
   * `kind === "cancel"` 인 경우는 pending.kind 무관하게 허용 — 사용자가 질문을
   * 포기하고 방향을 바꾸고 싶을 때의 탈출구. 이 경로는 agentLoop 재진입 없이
   * 턴을 종료해 다음 receive() 를 풀어준다.
   */
  async *resumeAfterUserInput(
    sessionId: string,
    answer: UserInputAnswer,
  ): AsyncGenerator<AgentEvent> {
    if (!this.pendingUserInput) {
      yield { type: "error", message: "no pending user input for this agent" };
      return;
    }
    if (this.pendingUserInput.sessionId !== sessionId) {
      yield { type: "error", message: "user_input sessionId does not match pending" };
      return;
    }
    if (answer.kind !== "cancel" && answer.kind !== this.pendingUserInput.kind) {
      yield {
        type: "error",
        message: `answer.kind "${answer.kind}" does not match pending.kind "${this.pendingUserInput.kind}"`,
      };
      return;
    }
    this.lastActiveAt = Date.now();
    const pending = this.pendingUserInput;
    this.pendingUserInput = null;

    const traceCtx = this.startTrace({
      user_message: `(resume user_input kind=${answer.kind})`,
    });
    const traceStart = {
      trace_id: traceCtx.trace_id,
      session_id: this.sid,
      agent_name: NW_AGENT_NAME,
      started_at: traceCtx.startedAt,
      metadata: { resume_kind: "user_input", answer_kind: answer.kind },
    } as const;
    try {
      if (answer.kind === "cancel") {
        yield* withRawCapture(
          pending.memoryId,
          withNightWatchTrace(traceCtx, traceStart, this.runCancelUserInput(pending)),
        );
      } else {
        yield* withRawCapture(
          pending.memoryId,
          withNightWatchTrace(
            traceCtx,
            traceStart,
            this.runResumeUserInput(pending, answer),
          ),
        );
      }
    } finally {
      this.currentTrace = null;
      await this.persist();
    }
  }

  private async *runResumeUserInput(
    pending: SerializedPendingUserInput,
    answer: UserInputAnswer,
  ): AsyncGenerator<AgentEvent> {
    const output = JSON.stringify(answer);
    this.messages.push({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: pending.toolUseId,
          content: output,
        },
      ],
    });
    yield { type: "tool_result", name: ASK_USER_TOOL, output };
    yield* this.agentLoop(pending.memoryId);
  }

  /**
   * ask_user 취소 경로. is_error tool_result 를 남겨 conversation 의 tool_use
   * invariant 를 지키되 agentLoop 재진입 없이 즉시 done 을 yield — 사용자가
   * 바로 새 receive() 로 방향을 바꿀 수 있게 한다.
   */
  private async *runCancelUserInput(
    pending: SerializedPendingUserInput,
  ): AsyncGenerator<AgentEvent> {
    const output = JSON.stringify({
      cancelled: true,
      reason: "사용자가 질문을 취소했습니다. 다음 사용자 메시지에서 새로운 지시를 받으세요.",
    });
    this.messages.push({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: pending.toolUseId,
          content: output,
          is_error: true,
        },
      ],
    });
    yield { type: "tool_result", name: ASK_USER_TOOL, output };
    yield { type: "done" };
  }

  /**
   * Start a Night's Watch trace for the current turn. Idempotent within a turn:
   * if `currentTrace` is already set, return it. Also emits session_upsert on the
   * very first trace of this AgentInstance — once per sid lifetime.
   */
  private startTrace(opts: { user_message?: string }): TraceContext {
    if (this.currentTrace) return this.currentTrace;
    const ctx = newTraceContext({
      session_id: this.sid,
      agent_name: NW_AGENT_NAME,
    });
    this.currentTrace = ctx;
    if (!this.nwSessionEmitted) {
      this.nwSessionEmitted = true;
      const profile = this.currentProfile;
      pushSessionUpsert({
        session_id: this.sid,
        agent_name: NW_AGENT_NAME,
        sid: this.sid,
        persona: this.resolvedPersona ?? undefined,
        persona_ref: this.resolvedRef ?? undefined,
        profile_name: profile.name,
        started_at: this.createdAt,
        last_active_at: this.lastActiveAt,
      });
    }
    void opts;
    return ctx;
  }

  private async *agentLoop(memoryId: string): AsyncGenerator<AgentEvent> {
    while (true) {
      const tools = getSkillTools();
      const traceCtx = this.currentTrace;
      const reqHandle = traceCtx
        ? recordLlmRequest(traceCtx, {
            model: this.modelId,
            message_count: this.messages.length,
            tool_count: tools.length,
            system_chars: this.systemPrompt.length,
          })
        : null;

      let response: LLMResponse | undefined;
      try {
        for await (const ev of this.llmClient.chatStream({
          model: this.modelId,
          max_tokens: 4096,
          system: [
            { type: "text", text: this.systemPrompt, cache_control: { type: "ephemeral" } },
          ],
          tools,
          messages: this.messages,
        })) {
          if (ev.type === "text_delta") {
            yield { type: "text_delta", delta: ev.text };
          } else if (ev.type === "done") {
            response = ev.response;
          }
        }
      } catch (e) {
        if (traceCtx && reqHandle) recordLlmError(traceCtx, reqHandle, e as Error);
        throw e;
      }
      if (!response) throw new Error("agent: chatStream ended without done event");
      if (traceCtx && reqHandle) recordLlmResponse(traceCtx, reqHandle, response);

      // Token / cache usage — budget 계산과 관찰성의 기초.
      // raw append middleware 가 자동으로 이 이벤트를 memory raw 에도 기록.
      yield {
        type: "chat_usage",
        model: this.modelId,
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
        // ask_user 분기: built-in UX 게이트, approval 경로와 완전히 분리.
        const askUserBlocks = toolUseBlocks.filter((b) => b.name === ASK_USER_TOOL);
        const otherBlocks = toolUseBlocks.filter((b) => b.name !== ASK_USER_TOOL);

        // (1) mixed 호출 혹은 다중 ask_user → 전원 error tool_result 로 반려.
        //     LLM 은 다음 턴에 ask_user 만 단독 호출하거나 ask_user 없이 재시도.
        if (
          askUserBlocks.length > 0 &&
          (otherBlocks.length > 0 || askUserBlocks.length > 1)
        ) {
          const hint =
            "ask_user 는 같은 턴에 다른 tool 이나 다른 ask_user 와 함께 호출될 수 없습니다. " +
            "ask_user 만 단독으로 호출하거나, ask_user 없이 다른 tool 만 호출하세요.";
          const errorOutput = JSON.stringify({
            error: "ask_user_isolation_required",
            hint,
          });
          const results: ContentBlock[] = toolUseBlocks.map((b) => ({
            type: "tool_result" as const,
            tool_use_id: b.id,
            content: errorOutput,
            is_error: true,
          }));
          this.messages.push({ role: "user", content: results });
          for (const b of toolUseBlocks) {
            yield { type: "tool_result", name: b.name, output: errorOutput };
          }
          continue;
        }

        // (2) solo ask_user → 검증 후 user_input_request yield.
        if (askUserBlocks.length === 1 && otherBlocks.length === 0) {
          const block = askUserBlocks[0]!;

          // Retry 가드: approval 경로와 달리 ask_user 는 runResume 을 타지 않으므로
          // 여기서 직접 hash 반복을 차단. 같은 질문(=동일 args) 을 RETRY_LIMIT
          // 이상 반복하면 error tool_result 로 되돌려 LLM 이 방향을 바꾸게 함.
          const retryHash = hashToolCall(block.name, block.input);
          const retryAttempts = countPriorToolUses(this.messages, retryHash);
          if (retryAttempts > RETRY_LIMIT) {
            const errorOutput = JSON.stringify({
              error: "retry_limit_exceeded",
              tool: ASK_USER_TOOL,
              limit: RETRY_LIMIT,
              attempts: retryAttempts,
              hint: "같은 ask_user 호출을 반복했습니다. 질문/옵션을 바꾸거나 되묻지 말고 직접 진행하세요.",
            });
            this.messages.push({
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: block.id,
                  content: errorOutput,
                  is_error: true,
                },
              ],
            });
            yield { type: "tool_result", name: ASK_USER_TOOL, output: errorOutput };
            continue;
          }

          const validated = validateAskUserInput(block.input);
          if (!validated.ok) {
            const errorOutput = JSON.stringify({
              error: "ask_user_invalid_input",
              hint: validated.error,
            });
            this.messages.push({
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: block.id,
                  content: errorOutput,
                  is_error: true,
                },
              ],
            });
            yield { type: "tool_result", name: ASK_USER_TOOL, output: errorOutput };
            continue;
          }
          const { kind, question, options, multi } = validated.parsed;
          const sessionId = randomUUID();
          this.pendingUserInput = {
            sessionId,
            toolUseId: block.id,
            memoryId,
            lastAssistantContent: response.content,
            kind,
            optionIds: kind === "choose" ? options!.map((o) => o.id) : undefined,
            multi,
          };
          yield {
            type: "user_input_request",
            sessionId,
            toolUseId: block.id,
            kind,
            question,
            options,
            multi,
          };
          return;
        }

        // (3) normal approval 경로 (ask_user 미관여).
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
    const profile = this.currentProfile;
    return {
      sid: this.sid,
      messageCount: this.messages.length,
      persona: this.resolvedPersona,
      personaRef: this.resolvedRef,
      profileName: profile.name,
      model: profile.model,
      advisorCalls: this.advisorCalls,
      pending: this.pending
        ? { sessionId: this.pending.sessionId, toolCount: this.pending.pendingToolCalls.length }
        : null,
      pendingUserInput: this.pendingUserInput
        ? { sessionId: this.pendingUserInput.sessionId, kind: this.pendingUserInput.kind }
        : null,
      createdAt: this.createdAt,
      lastActiveAt: this.lastActiveAt,
    };
  }

  /**
   * Clear any pending tool-approval state without wiping messages.
   *
   * Used by goal-runner before starting a new iteration: 같은 AgentInstance 가
   * goal 의 모든 iter 동안 이어지므로 (ADR-009 Amendment 2026-04-21), 이전 iter
   * 가 HIL 로 paused 된 뒤 Roy 가 Reset → 재실행할 때 stale pending 잔존을 방지.
   *
   * disposeAgent 와 다른 점: messages / systemPrompt / advisorCalls 등 "나" 의
   * working memory 는 보존 — iter 간 사고 궤적을 끊지 않는다.
   */
  clearPending(): void {
    this.pending = null;
    this.pendingUserInput = null;
  }

  /** Test-only — reset messages so a fresh receive() starts clean. */
  __resetForTest(): void {
    this.messages = [];
    this.pending = null;
    this.pendingUserInput = null;
    this.advisorCalls = 0;
  }

  dispose(): void {
    this.messages = [];
    this.pending = null;
    this.pendingUserInput = null;
  }

  /** Active Night's Watch trace_id (one per receive/resume turn), or null when idle. */
  get currentTraceId(): string | null {
    return this.currentTrace?.trace_id ?? null;
  }

  /**
   * Emit a `tool_approval_decision` event into the active trace. Called by
   * AgentRunner after `decideToolApproval()` resolves — the runner owns the
   * autonomy policy but the trace context lives on this AgentInstance.
   *
   * No-op if there is no active trace (e.g., decision happened outside a turn).
   */
  recordToolApprovalDecision(payload: ToolApprovalDecisionPayload): void {
    if (!this.currentTrace) return;
    nwRecordToolApprovalDecision(this.currentTrace, payload);
  }

  /** Exposed for routes that need to validate approval sessionId before calling resume. */
  get pendingSessionId(): string | null {
    return this.pending?.sessionId ?? null;
  }

  get pendingToolCalls(): readonly PendingToolCall[] {
    return this.pending?.pendingToolCalls ?? [];
  }

  /** ask_user 응답 엔드포인트가 sessionId 매칭을 검증하기 위해 노출. */
  get pendingUserInputSessionId(): string | null {
    return this.pendingUserInput?.sessionId ?? null;
  }

  get pendingUserInputKind(): "choose" | "confirm" | null {
    return this.pendingUserInput?.kind ?? null;
  }

  /** choose 응답의 selected id 가 이 목록 안에 있어야 유효. */
  get pendingUserInputOptionIds(): readonly string[] | null {
    return this.pendingUserInput?.optionIds ?? null;
  }

  get pendingUserInputMulti(): boolean {
    return this.pendingUserInput?.multi ?? false;
  }
}
