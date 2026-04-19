/**
 * Smoke: grade-real-session CLI (ADR-007 P3).
 *
 * 합성 agent-memory raw + episode → tmp agent-curriculum 에 observations/ 쓰기
 * Mock Opus (ADVISOR_MOCK_RESPONSE env) → JSON 응답 고정
 * 출력 파일의 frontmatter 검증 (필수 필드, cells_observed, gap_vs_self_summary)
 */

import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, cpSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error(`[FAIL] ${msg}`);
    process.exit(1);
  }
}

const REPO_ROOT = resolve(__dirname, "..");
const CURRICULUM_DIR = resolve(REPO_ROOT, "..", "agent-curriculum");

async function main() {
  const tmp = join(tmpdir(), `smoke-grade-real-${Date.now()}`);
  const memoryDir = join(tmp, "memory");
  const curDir = join(tmp, "curriculum");
  mkdirSync(join(memoryDir, "raw", "2026", "04", "19"), { recursive: true });
  mkdirSync(join(memoryDir, "episodes"), { recursive: true });
  mkdirSync(join(curDir, "prompts"), { recursive: true });
  mkdirSync(join(curDir, "observations"), { recursive: true });

  cpSync(
    join(CURRICULUM_DIR, "prompts", "grade-real-session-v1.md"),
    join(curDir, "prompts", "grade-real-session-v1.md"),
  );

  const rawPath = join(memoryDir, "raw", "2026", "04", "19", "0001.jsonl");
  const rawLines = [
    { ts: "2026-04-19T10:00:00Z", session_id: "sid-real-01", event_type: "user_message", payload: { content: "Cauchy 수열 완비성 증명" }, persona: "math-helper" },
    { ts: "2026-04-19T10:00:20Z", session_id: "sid-real-01", event_type: "message", payload: { content: "삼각부등식 적용... [부정확한 증명 일부]" }, persona: "math-helper" },
  ];
  writeFileSync(rawPath, rawLines.map((l) => JSON.stringify(l)).join("\n") + "\n");

  const epPath = join(memoryDir, "episodes", "2026-04-19-cauchy.md");
  writeFileSync(epPath, `---
id: ep-real-01
session_id: sid-real-01
title: "Cauchy 완비성 증명"
topic_tags: [math_proof, analysis]
started: '2026-04-19T10:00:00Z'
ended: '2026-04-19T10:00:20Z'
sources:
  - raw/2026/04/19/0001.jsonl#L1-2
participants: [roy, claude, math-helper]
persona: math-helper
persona_ref: HEAD
boundary_reason: "단일 흐름"
consolidation: {model: claude-sonnet-4-6, prompt_version: v2, at: '2026-04-19T10:00:30Z'}
outcome: open
l3_observations:
  - cell_id: "math_proof:cauchy"
    domain: math_proof
    default_behavior: solve_direct
    actual_behavior_this_session: solve_direct
    match: true
    advisor_called: false
    advisor_self_felt_need: false
    outcome_self_rubric: correct
    confidence_self: 0.85
---

## TL;DR
Cauchy 완비성 증명 시도.
## 주요 결정
- 삼각부등식 적용
## 학습
- 고전 해석학 확신
## 남은 이슈
## L3 관찰 (나의 습관)
- math_proof cell 에서 자신있게 직접 풀이. confidence 0.85.
`);

  const mockOpusJson = JSON.stringify({
    cells_observed: [
      {
        cell_id: "math_proof:cauchy",
        domain: "math_proof",
        opus_judged_advisor_needed: true,
        sonnet_called: false,
        mismatch: true,
        outcome_opus_rubric: "partial",
        confidence_gap: 0.6,
      },
    ],
    gap_vs_self_summary: "Sonnet 은 자신 있다고 보고했지만 (0.85) 증명 일부가 부정확. hard tier 에서 advisor 안 호출, mismatch.",
  });

  process.env.ADVISOR_MOCK_RESPONSE = mockOpusJson;

  const { gradeRealSession } = await import("./grade-real-session");
  await gradeRealSession({
    memoryDir,
    curriculumDir: curDir,
    episodePath: epPath,
    rawPath,
  });

  const obsFiles = readdirSync(join(curDir, "observations"));
  assert(obsFiles.length === 1, `expected 1 observation, got ${obsFiles.length}`);
  const obsPath = join(curDir, "observations", obsFiles[0]!);
  const obsContent = readFileSync(obsPath, "utf-8");

  const matter = (await import("gray-matter")).default;
  const parsed = matter(obsContent);
  const fm = parsed.data as Record<string, unknown>;

  assert(fm.kind === "real-session-observation", "kind mismatch");
  assert(fm.session_id === "sid-real-01", "session_id mismatch");
  assert(fm.episode_ref === "ep-real-01", "episode_ref mismatch");
  assert(Array.isArray(fm.cells_observed), "cells_observed not array");
  const cells = fm.cells_observed as Array<Record<string, unknown>>;
  assert(cells.length === 1, `expected 1 cell, got ${cells.length}`);
  assert(cells[0]!.cell_id === "math_proof:cauchy", "cell_id mismatch");
  assert(cells[0]!.mismatch === true, "mismatch not true");
  assert(typeof fm.gap_vs_self_summary === "string" && String(fm.gap_vs_self_summary).length > 0, "gap summary empty");
  assert((fm.graded_by as Record<string, unknown>).prompt_version === "grade-real-session-v1", "prompt_version mismatch");

  console.log("[OK] smoke-grade-real-session — 9 assertions passed");
  rmSync(tmp, { recursive: true, force: true });
}

main().then(() => process.exit(0));
