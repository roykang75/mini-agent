/**
 * Real AgentRunner wrapping AgentInstance (ADR-009 Phase 3).
 *
 * summonAgent → receive(userMessage) async generator → consume events →
 * collect iteration_summary (final assistant text) + hil signal.
 *
 * session_id per iteration = `${baseSid ?? goal.id}/iter-${iteration}`.
 *
 * 주의: 현재 AgentEvent union (src/lib/types.ts) 에는 별도의 `chat` 이벤트가
 * 없어 실 tokens_in/tokens_out 을 이벤트 스트림에서 직접 뽑아낼 수 없다.
 * 본 runner 는 iteration 당 tokens=0, model=LLM_MODEL env 로 보고하고,
 * budget tracker 는 wall_time/iterations 위주로 동작하도록 한다.
 *
 * tool_approval_request 는 현재 아키텍처상 모든 tool_use 에 대해 발생한다.
 * 그 중 name === "hil_checkpoint" 만 goal controller 의 hil signal 로
 * 승격시키고, 나머지는 단순 iteration 종료로 처리 (pending 상태로 인해
 * 같은 sid 의 다음 receive() 는 실패하므로 per-iteration sid 로 분리).
 */

import type { AgentRunner, IterationInput, IterationOutput } from "./controller";
import { summonAgent } from "../agent/registry";
import type { AgentEvent } from "../types";
import type { SoulRequest } from "../souls/loader";
import type { PersonaName } from "../souls/registry.generated";

const CANON_HIL_TOOL_NAME = "hil_checkpoint";
const DEFAULT_MODEL = process.env.LLM_MODEL ?? "claude-sonnet-4-6";

export interface AgentRunnerOptions {
  /** Base sid stem; iteration sid = `${baseSid}/iter-${iteration}`. Default: goal.id. */
  baseSid?: string;
  /** Persona override (PersonaName). Default: goal.frontmatter.persona. */
  personaOverride?: string;
}

export function createAgentRunner(opts: AgentRunnerOptions = {}): AgentRunner {
  return async (input: IterationInput): Promise<IterationOutput> => {
    const base = opts.baseSid ?? input.goal.frontmatter.id;
    const sid = `${base}/iter-${input.iteration}`;

    const agent = await summonAgent(sid);

    // Persona: 명시 override > goal.frontmatter.persona.
    const personaRaw = opts.personaOverride ?? input.goal.frontmatter.persona;
    const personaReq: SoulRequest = personaRaw
      ? { persona: personaRaw as PersonaName }
      : {};

    // systemTail 을 userMessage 앞에 preamble 로 붙인다. AgentInstance 내부 systemPrompt
    // 는 soul 기반으로 구성되므로, goal-specific 지시는 user 턴으로 전달한다.
    const composed = `${input.systemTail}\n\n${input.userMessage}`;

    let assistantText = "";
    let hil: IterationOutput["hil_checkpoint_triggered"];
    let errorMsg: string | undefined;

    for await (const ev of agent.receive(composed, personaReq) as AsyncGenerator<AgentEvent>) {
      switch (ev.type) {
        case "message": {
          // Final assistant text block in the turn — 축적.
          assistantText += (assistantText ? "\n" : "") + ev.content;
          break;
        }
        case "text_delta": {
          // Streaming delta — also captured to maximize assistantText coverage.
          assistantText += ev.delta;
          break;
        }
        case "tool_call": {
          if (ev.name === CANON_HIL_TOOL_NAME) {
            const args = ev.args ?? {};
            hil = {
              reason: String((args as Record<string, unknown>).reason ?? "(unspecified)"),
              proposed_action: String(
                (args as Record<string, unknown>).proposed_action ?? "(unspecified)",
              ),
            };
          }
          break;
        }
        case "tool_approval_request": {
          // Tool 이 approval 대기에 걸리면 iteration 은 여기서 종료.
          // (hil_checkpoint 는 위 tool_call 에서 이미 hil 로 마킹됨)
          break;
        }
        case "error": {
          errorMsg = ev.message;
          break;
        }
        default:
          // persona_resolved / memory_recalled / curriculum_recalled /
          // self_map_recalled / thinking / tool_result / tool_rejected /
          // done — 본 runner 에서는 특별 처리 없음.
          break;
      }
    }

    return {
      iteration_summary: assistantText.trim().slice(0, 2000) || "(empty agent response)",
      tokens_in: 0,
      tokens_out: 0,
      model: DEFAULT_MODEL,
      hil_checkpoint_triggered: hil,
      error: errorMsg,
    };
  };
}
