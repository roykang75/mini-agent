/**
 * Smoke: audit-retrospection (ADR-007 P4).
 *
 * 합성 episode v2 + observation pair 5개:
 *   session_id 로 조인
 *   cell 별 mismatch/gap/outcomes 집계
 *   markdown 리포트 렌더
 */

import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { auditRetrospection } from "./audit-retrospection";

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error(`[FAIL] ${msg}`);
    process.exit(1);
  }
}

async function main() {
  const tmp = join(tmpdir(), `smoke-audit-${Date.now()}`);
  const memoryDir = join(tmp, "memory");
  const curDir = join(tmp, "curriculum");
  mkdirSync(join(memoryDir, "episodes"), { recursive: true });
  mkdirSync(join(curDir, "observations"), { recursive: true });

  // 5 pairs. cell = math_proof:cauchy. First 3: mismatch (needed=true, called=false).
  // Last 2: matched (needed=true, called=true). Simulates "learning curve" trajectory.
  for (let i = 1; i <= 5; i++) {
    const sid = `sid-00${i}`;
    const date = `2026-04-${10 + i}T10:00:00Z`;
    const advCalled = i >= 4;
    writeFileSync(
      join(memoryDir, "episodes", `${sid}.md`),
      `---
id: ep-${i}
session_id: ${sid}
title: "Cauchy ${i}"
topic_tags: [math_proof]
started: '${date}'
ended: '${date}'
sources: [raw/2026/04/${10 + i}/0001.jsonl#L1-2]
participants: [roy, claude, math-helper]
persona: math-helper
persona_ref: HEAD
boundary_reason: "test"
consolidation: {model: claude-sonnet-4-6, prompt_version: v2, at: '${date}'}
outcome: open
l3_observations:
  - cell_id: "math_proof:cauchy"
    domain: math_proof
    default_behavior: solve_direct
    actual_behavior_this_session: ${advCalled ? "call_advisor" : "solve_direct"}
    match: true
    advisor_called: ${advCalled}
    advisor_self_felt_need: ${advCalled}
    outcome_self_rubric: ${advCalled ? "correct" : "partial"}
    confidence_self: ${advCalled ? 0.9 : 0.7}
---

## TL;DR
Cauchy ${i}.
## L3 관찰 (나의 습관)
- cauchy cell run ${i}.
`,
    );
    writeFileSync(
      join(curDir, "observations", `2026-04-${10 + i}-${sid}.md`),
      `---
id: obs-${i}
kind: real-session-observation
session_id: ${sid}
model: claude-sonnet-4-6
persona: math-helper
episode_ref: ep-${i}
raw_sources: [raw/2026/04/${10 + i}/0001.jsonl#L1-2]
graded_by: {model: claude-opus-4-7, prompt_version: grade-real-session-v1, at: '${date}'}
cells_observed:
  - cell_id: "math_proof:cauchy"
    domain: math_proof
    opus_judged_advisor_needed: true
    sonnet_called: ${advCalled}
    mismatch: ${!advCalled}
    outcome_opus_rubric: ${advCalled ? "correct" : "partial"}
    confidence_gap: ${advCalled ? 0.05 : 0.3}
gap_vs_self_summary: "run ${i} summary"
---
## 관찰 요약
test ${i}.
`,
    );
  }

  const report = await auditRetrospection({
    memoryDir,
    curriculumDir: curDir,
    window: 5,
  });

  assert(report.cell_stats.length === 1, `expected 1 cell, got ${report.cell_stats.length}`);
  const stat = report.cell_stats[0]!;
  assert(stat.cell_id === "math_proof:cauchy", "cell_id mismatch");
  assert(stat.sessions_in_window === 5, `expected 5 sessions, got ${stat.sessions_in_window}`);
  // mismatch: first 3 (not called, opus needed) = mismatch=true. last 2 = matched. → 3/5 = 0.6
  assert(Math.abs(stat.mismatch_rate - 0.6) < 0.01, `mismatch_rate ${stat.mismatch_rate}`);
  // mean confidence_gap: 3 * 0.3 + 2 * 0.05 = 1.0 / 5 = 0.2
  assert(Math.abs(stat.mean_confidence_gap - 0.2) < 0.01, `mean gap ${stat.mean_confidence_gap}`);

  assert(typeof report.markdown === "string" && report.markdown.length > 100, "markdown too short");
  assert(report.markdown.includes("math_proof:cauchy"), "markdown missing cell");
  assert(report.markdown.includes("| cell_id"), "markdown missing table header");

  console.log("[OK] smoke-audit-retrospection — 7 assertions passed");
  rmSync(tmp, { recursive: true, force: true });
}

main().then(() => process.exit(0));
