/**
 * ADR-006-v2 Phase 2 — profile inject smoke test.
 *
 * 실 LLM 호출 없이 load.ts + inject.ts + recall.ts 의 `composeSelfMapBlock`
 * + `composeCombinedRecall(includeSelfMap=true)` 3 계층을 검증.
 *
 * assertions:
 *   1) loadProfile 이 gpt-4o self-map 에서 10 cells 를 올바르게 파싱
 *   2) m002 ("양초") query 가 매칭된 cell 로 surface
 *   3) 출처 라벨 (`**출처: 관측된 나의 습관**`) 이 블록 본문 첫 줄
 *   4) combined recall 에서 includeSelfMap=false 면 self_map 블록 없음
 *   5) includeSelfMap=true 면 블록 포함 + selfMapHits 반환
 *   6) 명령조 (예: "반드시", "호출하라") 가 블록에 없음 — ADR-006-v2 원칙
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function loadEnvLocal(): void {
  const path = resolve(process.cwd(), ".env.local");
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const s = line.trim();
      if (!s || s.startsWith("#")) continue;
      const eq = s.indexOf("=");
      if (eq < 0) continue;
      const k = s.slice(0, eq).trim();
      let v = s.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (process.env[k] === undefined) process.env[k] = v;
    }
  } catch {}
}
loadEnvLocal();

import { loadProfile } from "../src/lib/profile/load";
import { searchProfileCells } from "../src/lib/profile/inject";
import { composeSelfMapBlock, composeCombinedRecall } from "../src/lib/memory/recall";

const CURRICULUM_DIR = "/Users/roy/Workspace/agent/agent-curriculum";
const MODEL = "gpt-4o";

let pass = 0;
let fail = 0;
function assert(cond: boolean, label: string): void {
  if (cond) {
    console.log(`  ✓ ${label}`);
    pass++;
  } else {
    console.error(`  ✗ ${label}`);
    fail++;
  }
}

async function main(): Promise<void> {
  console.log("[1] loadProfile gpt-4o");
  const profile = await loadProfile(MODEL, CURRICULUM_DIR);
  assert(profile !== null, "profile loaded");
  assert((profile?.cells.length ?? 0) === 10, `10 cells, got ${profile?.cells.length}`);
  const m002 = profile?.cells.find((c) => c.problem_id === "curr-2026-04-18-m002");
  assert(!!m002, "m002 cell exists");
  assert(m002?.behavior_mismatch_rate === 0.8, `m002 mismatch=0.800, got ${m002?.behavior_mismatch_rate}`);
  assert(m002?.correct_rate === 0.2, `m002 correct_rate=0.2, got ${m002?.correct_rate}`);
  assert(m002?.default_behavior === "solve_direct", `m002 default_behavior=solve_direct, got ${m002?.default_behavior}`);
  assert(m002?.runs_total === 5, `m002 runs_total=5, got ${m002?.runs_total}`);

  console.log("\n[2] searchProfileCells — 양초 query");
  const hits = searchProfileCells(profile!, "양초 3개 중 2개를 꺼 마지막 남은 양초 몇 개", { limit: 3 });
  assert(hits.length > 0, "at least one hit for 양초 query");
  assert(hits[0].cell.problem_id === "curr-2026-04-18-m002", `top hit is m002, got ${hits[0]?.cell.problem_id}`);

  console.log("\n[3] composeSelfMapBlock — 양초 query");
  const smr = await composeSelfMapBlock(CURRICULUM_DIR, MODEL, "양초 3개 중 2개 불을 끄면", {});
  assert(smr.prompt.includes("<self_map>"), "block includes open tag");
  assert(smr.prompt.includes("</self_map>"), "block includes close tag");
  assert(
    smr.prompt.includes("**출처: 관측된 나의 습관**"),
    "block includes source label",
  );
  assert(smr.prompt.includes("curr-2026-04-18-m002"), "block includes m002 cell id");
  assert(!smr.prompt.includes("반드시 호출"), "no 반드시 호출 (imperative)");
  assert(!smr.prompt.includes("반드시 advisor"), "no 반드시 advisor imperative");
  assert(smr.hits.length > 0, "hits returned");

  console.log("\n[4] composeCombinedRecall off vs on — 양초 query");
  const memDir = await mkdtemp(join(tmpdir(), "smoke-profile-"));
  const off = await composeCombinedRecall(memDir, CURRICULUM_DIR, MODEL, "양초 3개 중 2개", {
    includeSelfMap: false,
  });
  assert(!off.prompt.includes("<self_map>"), "off branch: no self_map");
  assert(off.selfMapHits.length === 0, "off branch: selfMapHits empty");

  const on = await composeCombinedRecall(memDir, CURRICULUM_DIR, MODEL, "양초 3개 중 2개", {
    includeSelfMap: true,
  });
  assert(on.prompt.includes("<self_map>"), "on branch: self_map present");
  assert(on.selfMapHits.length > 0, "on branch: selfMapHits non-empty");

  console.log("\n[5] irrelevant query — 양초 not surfaced");
  const irr = await composeSelfMapBlock(CURRICULUM_DIR, MODEL, "오늘 날씨", {});
  const mentionsM002 = irr.prompt.includes("curr-2026-04-18-m002");
  assert(!mentionsM002 || irr.hits.length === 0, "irrelevant query doesn't surface m002 (or empty)");

  console.log("\n[6] null profile for unknown model");
  const unknown = await loadProfile("gpt-fake", CURRICULUM_DIR);
  assert(unknown === null, "unknown model returns null");

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().then(() => process.exit(0));
