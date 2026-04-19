#!/usr/bin/env tsx
/**
 * run-goal CLI (ADR-009 Phase 3).
 *
 * Usage:
 *   AGENT_MEMORY_DIR=/path/to/agent-memory \
 *     npx tsx scripts/run-goal.ts /path/to/goal.md
 *
 * Loads goal, transitions draft→active if needed, invokes runGoal with
 * real AgentRunner, reports final status.
 */

import { resolve } from "node:path";

try {
  (process as unknown as { loadEnvFile?: (p?: string) => void }).loadEnvFile?.(".env.local");
} catch {
  // ignore — .env.local optional
}

import { loadGoal, setStatus } from "../src/lib/goal/io";
import { runGoal } from "../src/lib/goal/controller";
import { createAgentRunner } from "../src/lib/goal/agent-runner";

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error("usage: tsx scripts/run-goal.ts <goal.md path>");
    process.exit(2);
  }
  const goalPath = resolve(arg);
  console.log(`[run-goal] loading ${goalPath}`);

  let goal = await loadGoal(goalPath);
  console.log(
    `[run-goal] id=${goal.frontmatter.id} slug=${goal.frontmatter.slug} status=${goal.frontmatter.status}`,
  );

  if (goal.frontmatter.status === "draft") {
    console.log("[run-goal] transitioning draft → active");
    await setStatus(goal, "active", "CLI auto-activate");
    goal = await loadGoal(goalPath);
  }

  if (goal.frontmatter.status !== "active") {
    console.error(
      `[run-goal] refuse — status must be active, got ${goal.frontmatter.status}`,
    );
    process.exit(2);
  }

  const workDir = process.env.GOAL_WORK_DIR ?? process.cwd();
  console.log(`[run-goal] workDir for evaluator: ${workDir}`);

  const started = Date.now();
  const result = await runGoal(goalPath, {
    runIteration: createAgentRunner({}),
    evaluatorContext: { workDir },
  });
  const elapsedSec = ((Date.now() - started) / 1000).toFixed(1);

  console.log(`\n[run-goal] ===== FINAL =====`);
  console.log(`status: ${result.final_status}`);
  if (result.reason) console.log(`reason: ${result.reason}`);
  console.log(`iterations: ${result.iterations_executed}`);
  if (result.budget_breached) console.log(`budget_breached: ${result.budget_breached}`);
  if (result.hil_request) {
    console.log(`hil_request.reason: ${result.hil_request.reason}`);
    console.log(`hil_request.proposed_action: ${result.hil_request.proposed_action}`);
  }
  if (result.completion_report) {
    console.log(
      `completion: ${result.completion_report.passed ? "PASSED" : "FAILED"}`,
    );
    for (const r of result.completion_report.results) {
      console.log(`  [${r.passed ? "OK" : "X"}] ${r.detail}`);
    }
  }
  console.log(`elapsed: ${elapsedSec}s`);

  process.exit(result.final_status === "completed" ? 0 : 1);
}

main().catch((e) => {
  console.error("[run-goal] error:", e);
  process.exit(1);
});
