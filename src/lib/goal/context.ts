/**
 * Goal context builder (ADR-009 Phase 2).
 *
 * Controller 가 AgentInstance 에게 iteration 마다 보낼 메시지를 만든다.
 * goal frontmatter + body 요약 + 남은 budget + 이전 iteration 결과를 감싼 형태.
 *
 * System prompt 는 별도 — persona 의 SOUL.md 를 primary 로, autonomous context 를
 * tail 로 추가.
 */

import type { LoadedGoal } from "./io";
import type { BudgetCheckpoint } from "./budget";

export interface IterationContext {
  iteration: number;
  last_iteration_summary?: string;
  completion_check_hint?: string;
}

export function buildGoalSystemTail(goal: LoadedGoal, workDir?: string): string {
  const fm = goal.frontmatter;
  const criteriaList = fm.completion_criteria
    .map((c, i) => {
      switch (c.type) {
        case "file_exists":
          return `${i + 1}. 파일 존재: ${c.path}`;
        case "file_not_exists":
          return `${i + 1}. 파일 부재: ${c.path}`;
        case "grep_count": {
          const range = `(${c.min_count ?? "-"}~${c.max_count ?? "-"})`;
          return `${i + 1}. ${c.path} 에 "${c.pattern}" 매치 ${range}`;
        }
        case "grep_absent":
          return `${i + 1}. ${c.path} 에 "${c.pattern}" 없음`;
        case "llm_predicate":
          return `${i + 1}. 판정: ${c.description}`;
      }
    })
    .join("\n");

  const allowFs = fm.autonomy_config.allow_fs_write.length > 0
    ? fm.autonomy_config.allow_fs_write.join(", ")
    : "(없음 — 읽기 전용)";
  const denyFs = fm.autonomy_config.deny_fs_write.join(", ");
  const shell = typeof fm.autonomy_config.allow_shell === "boolean"
    ? (fm.autonomy_config.allow_shell ? "허용 (모든 명령)" : "금지")
    : `허용된 명령만: ${fm.autonomy_config.allow_shell.join(", ")}`;
  const hilBefore = fm.autonomy_config.require_hil_before.join(", ");

  return `

<goal_context>
이 세션은 ADR-009 autonomous goal execution 맥락이다. 너는 user 가 매 turn trigger 하는 assistant 가 아니라 **지정된 goal 을 끝까지 완료해야 하는 executor** 다.

**Goal ID**: ${fm.id}
**Slug**: ${fm.slug}
**Status**: ${fm.status}
**Persona**: ${fm.persona}

## 완료 조건 (모두 통과해야 completed)

${criteriaList}

## Autonomy 경계

- **쓰기 허용 경로**: ${allowFs}
- **쓰기 금지 경로**: ${denyFs}
- **Shell**: ${shell}
- **HIL 필수 action**: ${hilBefore} → 이 중 하나를 수행해야 하면 \`hil_checkpoint\` skill 을 먼저 호출해 Roy 의 승인을 구할 것.

## 경로 규칙 (중요)

- **정책 판정 기준 cwd**: \`${workDir ?? "(unspecified — process.cwd)"}\`
- 위 allow/deny 글로브는 **이 cwd 기준 상대경로** 로 매칭된다.
- **절대 경로를 써도 된다** — tool-approval 이 자동으로 cwd 기준 상대화한 뒤 매칭.
- **\`..\` 로 시작하는 경로는 금지** — cwd 밖으로 벗어나면 즉시 HIL. 상위 디렉토리가 필요하면 절대 경로로 명시.
- 예) 허용 = \`agent-memory/knowledge/**\`, cwd = \`${workDir ?? "/path/to/workdir"}\` → agent 는 \`agent-memory/knowledge/x.md\` 또는 \`${workDir ? `${workDir}/agent-memory/knowledge/x.md` : "/absolute/agent-memory/knowledge/x.md"}\` 형태로 경로 지정.

## 행동 규약

1. 매 turn 은 한 iteration. iteration 안에서 여러 tool 호출 가능.
2. 완료 조건을 명시적으로 확인 (rubric 이 rubric 대로 통과한지 내가 판단, 마지막에 controller 가 재검증).
3. budget 소진 전에 완료 or hil_checkpoint 권장.
4. 중간에 stuck 이면 \`ask_advisor\` skill 호출 (Opus teacher 가 답변).
5. 다음 iteration 을 위한 **단일 문단 요약** 을 매 turn 의 마지막에 남길 것. 요약은 "이번 iteration 에서 무엇을 했고, 다음 iteration 이 어디서 이어가야 하는지".
</goal_context>`;
}

export function buildIterationUserMessage(
  goal: LoadedGoal,
  iterCtx: IterationContext,
  budgetCp: BudgetCheckpoint,
): string {
  const fm = goal.frontmatter;
  const remainingIter = fm.budget.max_iterations - budgetCp.iterations;
  const remainingUsd = (fm.budget.max_usd - budgetCp.usd_spent).toFixed(2);
  const elapsedMin = budgetCp.wall_time_elapsed_min.toFixed(1);

  const lastSummary = iterCtx.last_iteration_summary
    ? `\n\n## 이전 iteration 요약\n\n${iterCtx.last_iteration_summary}`
    : "";
  const hint = iterCtx.completion_check_hint
    ? `\n\n## Completion check 힌트\n\n${iterCtx.completion_check_hint}`
    : "";

  return `# Iteration ${iterCtx.iteration} — ${fm.slug}

## 목표 본문

${goal.body.slice(0, 2000)}

## 남은 budget

- 남은 iteration: ${remainingIter}
- 남은 예산: $${remainingUsd}
- 경과 시간: ${elapsedMin} 분 / ${fm.budget.wall_time_minutes} 분${lastSummary}${hint}

이번 iteration 에서 다음 단계를 실행하고, 마지막에 단일 문단 요약을 남겨라.`;
}
