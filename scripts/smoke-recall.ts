/**
 * Smoke: auto-recall middleware (Phase 8 T8.8).
 *
 * Exercises composeRecall + shouldRecall directly. Depends on at least one
 * episode existing under AGENT_MEMORY_DIR.
 */

import { composeRecall, resetRecallClock, shouldRecall } from "../src/lib/memory/recall";

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error(`[FAIL] ${msg}`);
    process.exit(1);
  }
}

async function main() {
  const dir = process.env.AGENT_MEMORY_DIR;
  if (!dir) {
    console.error("AGENT_MEMORY_DIR must be set for this smoke");
    process.exit(2);
  }

  resetRecallClock();
  const sid = "smoke-sid-recall-001";

  // First check: must recall (no prior activity)
  assert(shouldRecall(sid, 5) === true, "first call should recall");
  // Second call within window: skip
  assert(shouldRecall(sid, 5) === false, "second call within idle window should skip");
  console.log(`[ok]   idle-gate: first=recall, second=skip`);

  const { prompt, hits } = await composeRecall(dir, "CIA 커밋 영향도 분석");
  assert(hits.length >= 1, `expected >=1 hit for real query, got ${hits.length}`);
  assert(prompt.includes("<agent_memory_recall>"), "prompt block missing opening tag");
  assert(prompt.includes("</agent_memory_recall>"), "prompt block missing closing tag");
  assert(prompt.includes(hits[0]!.episode.id), "prompt missing episode id");
  console.log(`[ok]   composeRecall → ${hits.length} hit(s), prompt ${prompt.length} chars`);
  console.log(`       top: id=${hits[0]!.episode.id}  title="${hits[0]!.episode.title.slice(0, 50)}"`);

  const { hits: empty } = await composeRecall(dir, "완전히-관련없는-주제-xyz");
  assert(empty.length === 0, `expected 0 hits for nonsense, got ${empty.length}`);
  console.log(`[ok]   nonsense query → empty recall`);

  console.log("\nauto-recall smoke passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
