/**
 * Smoke: BudgetTracker (ADR-009 P2).
 */

import { BudgetTracker, usdForChat } from "../src/lib/goal/budget";
import { DEFAULT_BUDGET } from "../src/lib/goal/types";

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error(`[FAIL] ${msg}`);
    process.exit(1);
  }
}

async function main() {
  const u1 = usdForChat("claude-sonnet-4-6", 1_000_000, 1_000_000);
  assert(Math.abs(u1 - 18) < 0.001, `Sonnet 1M/1M should be $18, got ${u1}`);

  const u2 = usdForChat("unknown-model", 1_000_000, 0);
  assert(Math.abs(u2 - 15) < 0.001, `unknown model fallback should be $15 for 1M in, got ${u2}`);

  const t3 = new BudgetTracker({ ...DEFAULT_BUDGET, max_iterations: 3 });
  let s3 = t3.tickIteration();
  assert(s3.within_limits, "iter 1 within");
  s3 = t3.tickIteration();
  assert(s3.within_limits, "iter 2 within");
  s3 = t3.tickIteration();
  assert(s3.within_limits, "iter 3 within");
  s3 = t3.tickIteration();
  assert(!s3.within_limits && s3.breached === "max_iterations", "iter 4 breaches max_iterations");

  const t4 = new BudgetTracker({ ...DEFAULT_BUDGET, max_tokens: 1000 });
  let s4 = t4.addChatUsage("claude-sonnet-4-6", 500, 200);
  assert(s4.within_limits, "700 tokens within 1000");
  s4 = t4.addChatUsage("claude-sonnet-4-6", 200, 200);
  assert(!s4.within_limits && s4.breached === "max_tokens", "1100 tokens breaches");

  const t5 = new BudgetTracker({ ...DEFAULT_BUDGET, max_usd: 0.01 });
  const s5 = t5.addChatUsage("claude-opus-4-7", 500, 300);
  assert(!s5.within_limits && s5.breached === "max_usd", `opus 800 tokens should breach $0.01, spent ${s5.checkpoint.usd_spent}`);

  const pastStart = new Date(Date.now() - 20 * 60_000);
  const t6 = new BudgetTracker({ ...DEFAULT_BUDGET, wall_time_minutes: 10 }, undefined, pastStart);
  const s6 = t6.checkWallTime();
  assert(!s6.within_limits && s6.breached === "wall_time_minutes", "20 min elapsed should breach 10 min limit");

  const t7 = new BudgetTracker(DEFAULT_BUDGET);
  t7.tickIteration();
  t7.addChatUsage("claude-sonnet-4-6", 100, 50);
  const snap = t7.snapshot();
  assert(snap.iterations === 1, "snapshot iterations");
  assert(snap.tokens_used === 150, "snapshot tokens");
  assert(snap.usd_spent > 0, "snapshot usd > 0");
  assert(snap.started_at !== null, "snapshot started_at");

  console.log("[OK] smoke-goal-budget — 12 assertions passed");
}

main().then(() => process.exit(0));
