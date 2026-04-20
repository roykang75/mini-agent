import { execute } from "../skills/hil-checkpoint/handler";

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error(`[FAIL] ${msg}`);
    process.exit(1);
  }
}

async function main() {
  const raw = await execute({
    reason: "fs_delete on agent-memory/goals/test.md",
    proposed_action: "delete stale goal file",
    goal_id: "goal-test-001",
  });
  const r = JSON.parse(raw) as {
    acknowledged: boolean;
    goal_id: string;
    reason: string;
    message: string;
  };
  assert(r.acknowledged === true, "acknowledged true");
  assert(r.goal_id === "goal-test-001", "goal_id echoed");
  assert(r.message.includes("goal-test-001"), "message includes goal_id");
  assert(r.message.includes("paused"), "message mentions paused");

  console.log("[OK] smoke-hil-checkpoint — 4 assertions passed");
}

main().then(() => process.exit(0));
