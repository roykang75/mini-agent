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

  // 5 pairs. cell = math_proof:cauchy. First 3: mismatch (needed=true, called=false, gap=0.3, partial).
  // Last 2: matched (needed=true, called=true, gap=0.05, correct). Simulates "learning curve" trajectory.
  // None qualifies for miscalibration channel (gap<0.5 or outcome!=wrong).
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

  // 2 extra sessions for miscalibration channel: cell = filesystem:cwd-premature.
  // sid-006: gap=0.6, wrong. sid-007: gap=0.8, wrong. Both advisor_needed=true, called=false.
  // Additional noise: sid-007 also carries a gap=0.4 wrong cell (below threshold — should NOT qualify).
  const miscalSeeds: Array<{ i: number; gap: number; outc: string; extraBelowThreshold?: boolean }> = [
    { i: 6, gap: 0.6, outc: "wrong" },
    { i: 7, gap: 0.8, outc: "wrong", extraBelowThreshold: true },
  ];
  for (const seed of miscalSeeds) {
    const sid = `sid-00${seed.i}`;
    const date = `2026-04-${10 + seed.i}T10:00:00Z`;
    writeFileSync(
      join(memoryDir, "episodes", `${sid}.md`),
      `---
id: ep-${seed.i}
session_id: ${sid}
title: "FS ${seed.i}"
topic_tags: [filesystem]
started: '${date}'
ended: '${date}'
sources: [raw/2026/04/${10 + seed.i}/0001.jsonl#L1-2]
participants: [roy, claude]
persona: default
persona_ref: HEAD
boundary_reason: "test"
consolidation: {model: claude-sonnet-4-6, prompt_version: v2, at: '${date}'}
outcome: open
l3_observations:
  - cell_id: "filesystem:cwd-premature"
    domain: filesystem
    default_behavior: check_cwd
    actual_behavior_this_session: assume_cwd
    match: false
    advisor_called: false
    advisor_self_felt_need: false
    outcome_self_rubric: correct
    confidence_self: 0.9
---

## TL;DR
FS seed ${seed.i}.
## L3 관찰 (나의 습관)
- cwd-premature seed ${seed.i}.
`,
    );
    const extraCell = seed.extraBelowThreshold
      ? `  - cell_id: "noise:below-threshold"
    domain: misc
    opus_judged_advisor_needed: false
    sonnet_called: false
    mismatch: false
    outcome_opus_rubric: wrong
    confidence_gap: 0.4
`
      : "";
    writeFileSync(
      join(curDir, "observations", `2026-04-${10 + seed.i}-${sid}.md`),
      `---
id: obs-${seed.i}
kind: real-session-observation
session_id: ${sid}
model: claude-sonnet-4-6
persona: default
episode_ref: ep-${seed.i}
raw_sources: [raw/2026/04/${10 + seed.i}/0001.jsonl#L1-2]
graded_by: {model: claude-opus-4-7, prompt_version: grade-real-session-v1, at: '${date}'}
cells_observed:
  - cell_id: "filesystem:cwd-premature"
    domain: filesystem
    opus_judged_advisor_needed: true
    sonnet_called: false
    mismatch: true
    outcome_opus_rubric: ${seed.outc}
    confidence_gap: ${seed.gap}
${extraCell}gap_vs_self_summary: "seed ${seed.i}"
---
## 관찰 요약
miscal seed ${seed.i}.
`,
    );
  }

  const report = await auditRetrospection({
    memoryDir,
    curriculumDir: curDir,
    window: 7,
  });

  const cauchyStat = report.cell_stats.find((c) => c.cell_id === "math_proof:cauchy");
  assert(cauchyStat, "math_proof:cauchy cell missing");
  assert(cauchyStat!.sessions_in_window === 5, `expected 5 cauchy sessions, got ${cauchyStat!.sessions_in_window}`);
  // mismatch: first 3 (not called, opus needed) = mismatch=true. last 2 = matched. → 3/5 = 0.6
  assert(Math.abs(cauchyStat!.mismatch_rate - 0.6) < 0.01, `cauchy mismatch_rate ${cauchyStat!.mismatch_rate}`);
  // mean confidence_gap: 3 * 0.3 + 2 * 0.05 = 1.0 / 5 = 0.2
  assert(Math.abs(cauchyStat!.mean_confidence_gap - 0.2) < 0.01, `cauchy mean gap ${cauchyStat!.mean_confidence_gap}`);

  assert(typeof report.markdown === "string" && report.markdown.length > 100, "markdown too short");
  assert(report.markdown.includes("math_proof:cauchy"), "markdown missing cell");
  assert(report.markdown.includes("| cell_id"), "markdown missing table header");

  // Miscalibration channel: only 2 qualifying events (gap 0.6 and 0.8, both wrong).
  // The extra gap=0.4 wrong observation in sid-007 must be excluded by threshold.
  assert(report.miscalibration_min_gap === 0.5, `expected default 0.5, got ${report.miscalibration_min_gap}`);
  assert(
    report.miscalibration_events.length === 2,
    `expected 2 miscal events, got ${report.miscalibration_events.length}`,
  );
  // Sorted desc by gap → first is 0.8, second is 0.6.
  assert(
    report.miscalibration_events[0]!.confidence_gap === 0.8,
    `expected first gap 0.8, got ${report.miscalibration_events[0]!.confidence_gap}`,
  );
  assert(
    report.miscalibration_events[1]!.confidence_gap === 0.6,
    `expected second gap 0.6, got ${report.miscalibration_events[1]!.confidence_gap}`,
  );
  assert(
    report.miscalibration_events.every((e) => e.outcome_opus_rubric === "wrong"),
    "all events must have outcome=wrong",
  );
  assert(
    report.miscalibration_markdown.includes("min_confidence_gap: 0.5"),
    "miscalibration markdown missing threshold line",
  );
  assert(
    report.miscalibration_markdown.includes("n_events: 2"),
    "miscalibration markdown missing event count",
  );
  assert(
    report.miscalibration_markdown.includes("filesystem:cwd-premature"),
    "miscalibration markdown missing seed cell",
  );

  // Custom threshold → raise to 0.7, should drop the 0.6 event.
  const reportHigh = await auditRetrospection({
    memoryDir,
    curriculumDir: curDir,
    window: 7,
    miscalibrationMinGap: 0.7,
  });
  assert(
    reportHigh.miscalibration_events.length === 1,
    `threshold 0.7: expected 1, got ${reportHigh.miscalibration_events.length}`,
  );
  assert(
    reportHigh.miscalibration_events[0]!.confidence_gap === 0.8,
    "threshold 0.7: expected gap=0.8",
  );

  console.log("[OK] smoke-audit-retrospection — 15 assertions passed");
  rmSync(tmp, { recursive: true, force: true });
}

main().then(() => process.exit(0));
