/**
 * Smoke: AgentRunner wrapper structure (ADR-009 Phase 3).
 *
 * 실 LLM 호출 없이 import 성공 + type shape 검증만. e2e 는 run-goal CLI 로 수동.
 */

import { createAgentRunner } from "../src/lib/goal/agent-runner";

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error(`[FAIL] ${msg}`);
    process.exit(1);
  }
}

async function main() {
  const runner = createAgentRunner({});
  assert(typeof runner === "function", "runner is function");
  assert(runner.length === 1, "runner takes 1 arg (IterationInput)");
  console.log(
    "[OK] smoke-agent-runner — 2 assertions passed (structure only; e2e via run-goal CLI)",
  );
}

main().then(() => process.exit(0));
