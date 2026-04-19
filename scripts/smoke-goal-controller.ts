/**
 * Smoke: Goal Controller (ADR-009 P2).
 *
 * Mock AgentRunner:
 *   - Iteration 1-2: 파일 생성 작업 흉내
 *   - Iteration 3: completion 통과시킴
 * 기대: status completed.
 *
 * + Budget breach scenario + HIL scenario 각자 독립 goal 로.
 */

import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runGoal, type AgentRunner } from "../src/lib/goal/controller";
import { loadGoal } from "../src/lib/goal/io";
import {
  DEFAULT_BUDGET,
  DEFAULT_AUTONOMY,
  DEFAULT_PROGRESS,
  type GoalFrontmatter,
} from "../src/lib/goal/types";

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error(`[FAIL] ${msg}`);
    process.exit(1);
  }
}

function writeGoal(tmp: string, slug: string, frontmatter: GoalFrontmatter): string {
  const path = join(tmp, `${slug}.md`);
  const yaml = frontmatterToYaml(frontmatter);
  writeFileSync(path, `---\n${yaml}---\n\n## 목표\n\n${slug} test body\n`);
  return path;
}

function frontmatterToYaml(fm: GoalFrontmatter): string {
  return `id: ${JSON.stringify(fm.id)}
slug: ${JSON.stringify(fm.slug)}
created: ${JSON.stringify(fm.created)}
created_by: ${JSON.stringify(fm.created_by)}
status: ${fm.status}
completion_criteria:
${fm.completion_criteria.map((c) => {
  const keys = Object.entries(c).map(([k, v]) => `    ${k}: ${JSON.stringify(v)}`).join("\n");
  return `  - ${keys.trimStart()}`;
}).join("\n")}
budget:
  max_iterations: ${fm.budget.max_iterations}
  max_tokens: ${fm.budget.max_tokens}
  max_usd: ${fm.budget.max_usd}
  wall_time_minutes: ${fm.budget.wall_time_minutes}
hil_policy: ${fm.hil_policy}
autonomy_config:
  allow_fs_write: [${fm.autonomy_config.allow_fs_write.map((x) => JSON.stringify(x)).join(", ")}]
  deny_fs_write: [${fm.autonomy_config.deny_fs_write.map((x) => JSON.stringify(x)).join(", ")}]
  allow_shell: ${typeof fm.autonomy_config.allow_shell === "boolean" ? fm.autonomy_config.allow_shell : `[${fm.autonomy_config.allow_shell.map((x) => JSON.stringify(x)).join(", ")}]`}
  require_hil_before: [${fm.autonomy_config.require_hil_before.map((x) => JSON.stringify(x)).join(", ")}]
progress:
  iterations: ${fm.progress.iterations}
  tokens_used: ${fm.progress.tokens_used}
  usd_spent: ${fm.progress.usd_spent}
  started_at: ${fm.progress.started_at === null ? "null" : JSON.stringify(fm.progress.started_at)}
  last_updated: ${fm.progress.last_updated === null ? "null" : JSON.stringify(fm.progress.last_updated)}
  retry_count: ${fm.progress.retry_count}
parent_goal: ${fm.parent_goal === null ? "null" : JSON.stringify(fm.parent_goal)}
persona: ${JSON.stringify(fm.persona)}
`;
}

async function main() {
  const tmp = join(tmpdir(), `smoke-controller-${Date.now()}`);
  mkdirSync(tmp, { recursive: true });

  // Scenario 1: completes at iteration 3
  const targetFile = join(tmp, "output.md");
  const fm1: GoalFrontmatter = {
    id: "goal-complete-001",
    slug: "complete-at-iter-3",
    created: "2026-04-19T22:00:00Z",
    created_by: "roy",
    status: "active",
    completion_criteria: [{ type: "file_exists", path: "output.md" }],
    budget: { ...DEFAULT_BUDGET, max_iterations: 5 },
    hil_policy: "balanced",
    autonomy_config: DEFAULT_AUTONOMY,
    progress: { ...DEFAULT_PROGRESS, started_at: "2026-04-19T22:00:00Z" },
    parent_goal: null,
    persona: "autonomous-executor",
  };
  const p1 = writeGoal(tmp, "complete-at-iter-3", fm1);

  let callCount1 = 0;
  const runner1: AgentRunner = async ({ iteration }) => {
    callCount1 = iteration;
    if (iteration === 3) {
      writeFileSync(targetFile, "done\n");
    }
    return {
      iteration_summary: `iter ${iteration} mock work done`,
      tokens_in: 100,
      tokens_out: 50,
      model: "claude-sonnet-4-6",
    };
  };
  const r1 = await runGoal(p1, {
    runIteration: runner1,
    evaluatorContext: { workDir: tmp },
  });
  assert(r1.final_status === "completed", `scenario 1: completed, got ${r1.final_status}`);
  assert(r1.iterations_executed === 3, `scenario 1: 3 iters, got ${r1.iterations_executed}`);
  assert(callCount1 === 3, "agent invoked 3 times");
  const reload1 = await loadGoal(p1);
  assert(reload1.frontmatter.status === "completed", "goal file status = completed");

  // Scenario 2: max_iterations breach → paused
  const fm2: GoalFrontmatter = {
    ...fm1,
    id: "goal-iter-breach",
    slug: "iter-breach",
    status: "active",
    completion_criteria: [{ type: "file_exists", path: "never-created.md" }],
    budget: { ...DEFAULT_BUDGET, max_iterations: 2 },
  };
  const p2 = writeGoal(tmp, "iter-breach", fm2);
  const runner2: AgentRunner = async ({ iteration }) => ({
    iteration_summary: `iter ${iteration} mock (no completion)`,
    tokens_in: 50,
    tokens_out: 25,
    model: "claude-sonnet-4-6",
  });
  const r2 = await runGoal(p2, {
    runIteration: runner2,
    evaluatorContext: { workDir: tmp },
  });
  assert(r2.final_status === "paused", `scenario 2: paused, got ${r2.final_status}`);
  assert(r2.budget_breached === "max_iterations", `scenario 2: max_iterations breach`);
  const reload2 = await loadGoal(p2);
  assert(reload2.frontmatter.status === "paused", "scenario 2: goal file paused");

  // Scenario 3: HIL checkpoint triggered on iter 1
  const fm3: GoalFrontmatter = {
    ...fm1,
    id: "goal-hil",
    slug: "hil-test",
    status: "active",
    completion_criteria: [{ type: "file_exists", path: "never.md" }],
  };
  const p3 = writeGoal(tmp, "hil-test", fm3);
  const runner3: AgentRunner = async ({ iteration }) => ({
    iteration_summary: `iter ${iteration} about to hit HIL`,
    tokens_in: 50,
    tokens_out: 25,
    model: "claude-sonnet-4-6",
    hil_checkpoint_triggered: {
      reason: "fs_delete requested",
      proposed_action: "rm test-file.md",
    },
  });
  const r3 = await runGoal(p3, {
    runIteration: runner3,
    evaluatorContext: { workDir: tmp },
  });
  assert(r3.final_status === "paused", `scenario 3: paused, got ${r3.final_status}`);
  assert(r3.hil_request !== undefined, "scenario 3: hil_request present");
  assert(r3.hil_request!.reason === "fs_delete requested", "hil reason");
  const reload3 = await loadGoal(p3);
  assert(reload3.body.includes("[hil]"), "goal log includes [hil]");
  assert(reload3.frontmatter.status === "paused", "scenario 3: file paused");

  console.log("[OK] smoke-goal-controller — 11 assertions passed");
  rmSync(tmp, { recursive: true, force: true });
}

main().then(() => process.exit(0));
