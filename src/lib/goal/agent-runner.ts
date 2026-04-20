/**
 * Real AgentRunner wrapping AgentInstance (ADR-009 Phase 3).
 *
 * summonAgent(sid) → receive(composed) async generator → 이벤트 소비.
 *
 * **Tool auto-approve loop (ADR-009 P3 blocker fix)**:
 *   AgentInstance.agentLoop 는 tool_use 마다 `tool_approval_request` 를
 *   발행하고 pending 에 저장한 뒤 return 한다 (chat UI HIL 용). 이 구조에서는
 *   autonomous goal 실행이 아예 동작하지 않는다.
 *
 *   Runner 가 이 이벤트를 받아 `decideToolApproval(autonomy_config)` 로 판정:
 *     - auto_approve → `resumeAfterApproval(sid, true)` 호출해 같은 턴을 잇고,
 *                       새로 반환된 generator 를 이어서 소비한다.
 *     - hil         → goal controller 의 hil_checkpoint_triggered 로 승격,
 *                      iteration 종료.
 *
 *   정책은 AgentInstance 가 모른다 (ADR-009 "HIL 정책은 학습 대상 아님").
 *
 * **Intra-iter live reload**:
 *   매 tool_approval_request 시점에 `loadGoal(goalPath)` 로 최신 autonomy_config
 *   를 가져온다. Roy 가 실행 중 goal.md 를 편집해 auto → hil 로 전환 가능.
 *
 * session_id per iteration = `${baseSid ?? goal.id}/iter-${iteration}`.
 */

import type { AgentRunner, IterationInput, IterationOutput } from "./controller";
import { loadGoal } from "./io";
import {
  decideToolApproval,
  HIL_CHECKPOINT_TOOL,
  type ApprovalDecision,
} from "./tool-approval";
import type { AutonomyConfig } from "./types";
import { disposeAgent, summonAgent } from "../agent/registry";
import type { AgentInstance } from "../agent/instance";
import type { AgentEvent } from "../types";
import type { SoulRequest } from "../souls/loader";
import type { PersonaName } from "../souls/registry.generated";
import { createLogger } from "../log";

import { loadRuntimeLimits } from "../config/limits";

const DEFAULT_MODEL = process.env.LLM_MODEL ?? "claude-sonnet-4-6";
/**
 * 한 iter 안에서 허용되는 auto-approve resume 최대 횟수. runtime-limits config
 * 에서 조회. env APPROVAL_SAFETY_LIMIT 도 override 가능 (loader 내부).
 */
const APPROVAL_SAFETY_LIMIT = loadRuntimeLimits().retry.approval_safety_limit;
const log = createLogger("agent");

export interface AgentRunnerOptions {
  /** Base sid stem; iteration sid = `${baseSid}/iter-${iteration}`. Default: goal.id. */
  baseSid?: string;
  /** Persona override (PersonaName). Default: goal.frontmatter.persona. */
  personaOverride?: string;
  /**
   * Tool-approval path 정규화 기준 cwd. GOAL_WORK_DIR env 또는 CLI/route 가
   * 전달. 없으면 process.env.GOAL_WORK_DIR → process.cwd() 로 fallback.
   *
   * 이 값이 agent 가 쓴 경로를 어떤 상대 공간에서 해석할지를 결정한다.
   * 예) workDir=/Users/roy/Workspace/agent, agent path=absolute agent-memory
   * path → relative = "agent-memory/..." → allow_fs_write 매치 OK.
   * workDir 이 mini-agent 였다면 "../agent-memory/..." 가 되어 escapes workdir.
   */
  workDir?: string;
}

/** Minimal agent shape that the runner actually uses. Allows fakes in smoke tests. */
export interface AgentLike {
  receive(userMessage: string, personaReq?: SoulRequest): AsyncGenerator<AgentEvent>;
  resumeAfterApproval(
    sessionId: string,
    approved: boolean,
    credentials?: Record<string, string>,
  ): AsyncGenerator<AgentEvent>;
}

export interface AgentRunnerDeps {
  summonFn?: (sid: string) => Promise<AgentLike>;
  loadAutonomyFn?: (goalPath: string, fallback: AutonomyConfig) => Promise<AutonomyConfig>;
}

// Compile-time 보증 — AgentInstance 가 AgentLike 를 structurally 만족해야 한다.
// AgentInstance.receive / resumeAfterApproval 시그니처가 drift 되면 여기가 터진다.
type _AgentInstanceSatisfiesAgentLike = AgentInstance extends AgentLike ? true : false;
const _agentLikeMatchCheck: _AgentInstanceSatisfiesAgentLike = true;
// eslint-disable-next-line @typescript-eslint/no-unused-expressions
_agentLikeMatchCheck;

export function createAgentRunner(
  opts: AgentRunnerOptions = {},
  deps: AgentRunnerDeps = {},
): AgentRunner {
  const summon = deps.summonFn ?? ((sid: string) => summonAgent(sid));
  const loadAutonomy = deps.loadAutonomyFn ?? loadCurrentAutonomy;
  const approvalCwd = opts.workDir ?? process.env.GOAL_WORK_DIR ?? process.cwd();
  return async (input: IterationInput): Promise<IterationOutput> => {
    const base = opts.baseSid ?? input.goal.frontmatter.id;
    const sid = `${base}/iter-${input.iteration}`;

    // Autonomous 경로는 매 iter 를 fresh agent 로 시작한다.
    // 이전 paused 에서 남은 pending / messages 가 Redis 에서 hydrate 되면
    // receive() 가 즉시 "awaiting approval" error 로 끝나 iter 가 0 tool 로 빠진다.
    // (같은 sid 의 goal-level idempotency 는 goal.md 의 frontmatter/body 가 담당.)
    // DI 주입된 summonFn (smoke) 은 이 삭제 영향 없음.
    if (!deps.summonFn) await disposeAgent(sid);
    const agent = await summon(sid);

    const personaRaw = opts.personaOverride ?? input.goal.frontmatter.persona;
    const personaReq: SoulRequest = personaRaw
      ? { persona: personaRaw as PersonaName }
      : {};

    const composed = `${input.systemTail}\n\n${input.userMessage}`;

    let assistantText = "";
    let hil: IterationOutput["hil_checkpoint_triggered"];
    let errorMsg: string | undefined;
    // LLM 사용량 집계 — 한 iter 안 여러 번의 chat turn 을 전부 합산.
    let tokensIn = 0;
    let tokensOut = 0;
    let cacheCreation = 0;
    let cacheRead = 0;
    let lastModel = DEFAULT_MODEL;

    let gen: AsyncGenerator<AgentEvent> = agent.receive(composed, personaReq) as AsyncGenerator<AgentEvent>;
    let approvalsGranted = 0;

    outer: while (true) {
      let pendingSid: string | null = null;

      for await (const ev of gen) {
        switch (ev.type) {
          case "message": {
            assistantText += (assistantText ? "\n" : "") + ev.content;
            break;
          }
          case "text_delta": {
            assistantText += ev.delta;
            break;
          }
          case "tool_call": {
            if (ev.name === HIL_CHECKPOINT_TOOL) {
              // Agent 가 명시적으로 호출한 경우 — 풍부한 reason/action 을 보존.
              const args = (ev.args ?? {}) as Record<string, unknown>;
              hil = {
                reason: String(args.reason ?? "(unspecified)"),
                proposed_action: String(args.proposed_action ?? "(unspecified)"),
              };
            }
            break;
          }
          case "tool_approval_request": {
            // 최신 goal 을 다시 읽어 autonomy_config 의 live 변경 반영.
            // Reload 실패 → **fail-closed**: silent fallback 대신 hil 로 승격.
            // Roy 철학상 "의심되면 멈춘다" — 옛 snapshot 으로 silently permissive 진행은 금지.
            let autonomy: AutonomyConfig;
            try {
              autonomy = await loadAutonomy(
                input.goal.path,
                input.goal.frontmatter.autonomy_config,
              );
            } catch (e) {
              const msg = (e as Error).message;
              log.warn(
                {
                  event: "autonomy_reload_failed",
                  err_message: msg,
                  goal_path: input.goal.path,
                },
                "autonomy reload threw — failing closed to hil",
              );
              if (!hil) {
                hil = {
                  reason: `autonomy_reload_failed: ${msg}`,
                  proposed_action: "(reload failure — goal.md parse/read error)",
                };
              }
              pendingSid = null;
              break;
            }
            const decision = decideToolApproval(ev.toolCalls, autonomy, { cwd: approvalCwd });

            log.info(
              {
                event: "tool_approval_decision",
                goal_id: input.goal.frontmatter.id,
                iteration: input.iteration,
                sid,
                tool_count: ev.toolCalls.length,
                decision: decision.decision,
                trace: decision.trace,
              },
              `tool_approval decision=${decision.decision}`,
            );

            if (decision.decision === "auto_approve") {
              approvalsGranted++;
              if (approvalsGranted > APPROVAL_SAFETY_LIMIT) {
                log.warn(
                  {
                    event: "approval_safety_limit_exceeded",
                    limit: APPROVAL_SAFETY_LIMIT,
                    goal_id: input.goal.frontmatter.id,
                    iteration: input.iteration,
                    sid,
                  },
                  "resume 상한 초과 — retry loop 로 간주, iter 종료",
                );
                errorMsg = `approval_safety_limit exceeded (${APPROVAL_SAFETY_LIMIT})`;
                break outer;
              }
              pendingSid = ev.sessionId;
              // break inner loop → outer while 이 resumeAfterApproval 로 gen 재설정.
            } else {
              // Agent 가 이미 hil_checkpoint 로 풍부한 hil 를 제공했으면 유지, 아니면 policy decision 사용.
              if (!hil) {
                hil = {
                  reason: decision.hil_trigger!.reason,
                  proposed_action: decision.hil_trigger!.proposed_action,
                };
              }
              pendingSid = null;
            }
            break; // inner for-await — 다음 이벤트는 resume 후 새 gen 에서.
          }
          case "chat_usage": {
            tokensIn += ev.input_tokens;
            tokensOut += ev.output_tokens;
            cacheCreation += ev.cache_creation_input_tokens ?? 0;
            cacheRead += ev.cache_read_input_tokens ?? 0;
            lastModel = ev.model;
            break;
          }
          case "error": {
            errorMsg = ev.message;
            // 에러 이후 이벤트는 전부 무시하고 runner 를 즉시 종료한다.
            break outer;
          }
          default:
            // persona_resolved / memory_recalled / curriculum_recalled /
            // self_map_recalled / thinking / tool_result / tool_rejected / done
            break;
        }
      }

      if (pendingSid && !hil && !errorMsg) {
        gen = agent.resumeAfterApproval(pendingSid, true) as AsyncGenerator<AgentEvent>;
        continue;
      }
      break;
    }

    return {
      iteration_summary: assistantText.trim().slice(0, 2000) || "(empty agent response)",
      // 입력 토큰 = 실제 LLM 프롬프트 전체 (system + history + cache). cache 분도
      // 합산 — budget 의 max_tokens 는 "LLM 이 처리한 총 토큰" 관점.
      // 비용 계산은 BudgetTracker.usdForChat 의 MODEL_PRICES 로, 현재는 input 요율
      // 하나만 적용 (cache_read 할인 미반영) — 이 정도 overestimate 는 안전망.
      tokens_in: tokensIn + cacheCreation + cacheRead,
      tokens_out: tokensOut,
      model: lastModel,
      hil_checkpoint_triggered: hil,
      error: errorMsg,
    };
  };
}

async function loadCurrentAutonomy(
  goalPath: string,
  fallback: AutonomyConfig,
): Promise<AutonomyConfig> {
  try {
    const fresh = await loadGoal(goalPath);
    return fresh.frontmatter.autonomy_config;
  } catch (e) {
    log.warn(
      { event: "autonomy_reload_failed", err_message: (e as Error).message, goal_path: goalPath },
      "failed to reload goal for autonomy — falling back to snapshot",
    );
    return fallback;
  }
}
