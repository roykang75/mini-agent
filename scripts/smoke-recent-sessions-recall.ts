/**
 * Smoke: <my_recent_sessions> recall 블록 (ADR-007 P2).
 *
 * 합성 agent-memory/episodes/ 에 v2 episodes 를 여러 개 만들고:
 *   1. searchRecentSessions 가 L3 관찰 섹션을 가진 episode 만 반환하는가
 *   2. query token 매칭으로 score 가 매겨지는가
 *   3. model 필터가 다른 persona/model 을 제외하는가
 *   4. composeRecentSessionsBlock 이 출처 라벨 + cell 발췌를 주입하는가
 *   5. 매칭 0 개 → 빈 블록
 *   6. v1 episode (L3 섹션 없음) 는 후보에서 제외
 */

import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { searchRecentSessions } from "../src/lib/memory/recent-sessions";
import { composeRecentSessionsBlock } from "../src/lib/memory/recall";

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error(`[FAIL] ${msg}`);
    process.exit(1);
  }
}

function makeEpisode(dir: string, filename: string, opts: {
  id: string;
  session_id: string;
  title: string;
  started: string;
  persona: string;
  promptVersion: "v1" | "v2";
  cellId?: string;
  domain?: string;
  l3Body?: string;
  topicTags?: string[];
}): void {
  const isV2 = opts.promptVersion === "v2";
  const l3fm = isV2 && opts.cellId ? `l3_observations:
  - cell_id: "${opts.cellId}"
    domain: ${opts.domain ?? "general"}
    default_behavior: solve_direct
    actual_behavior_this_session: solve_direct
    match: true
    advisor_called: false
    advisor_self_felt_need: false
    outcome_self_rubric: correct
    confidence_self: 0.9
` : "";
  const l3Section = isV2 ? `
## L3 관찰 (나의 습관)

- ${opts.l3Body ?? "기본 cell 관찰"}
` : "";
  const content = `---
id: ${opts.id}
session_id: ${opts.session_id}
title: "${opts.title}"
topic_tags: [${(opts.topicTags ?? ["general"]).join(", ")}]
started: '${opts.started}'
ended: '${opts.started}'
sources:
  - raw/2026/04/19/0001.jsonl#L1-5
participants: [roy, claude, ${opts.persona}]
persona: ${opts.persona}
persona_ref: HEAD
boundary_reason: "smoke test"
consolidation:
  model: claude-sonnet-4-6
  prompt_version: ${opts.promptVersion}
  at: '${opts.started}'
outcome: resolved
${l3fm}---

## TL;DR

smoke test episode.

## 주요 결정

- none
${l3Section}`;
  writeFileSync(join(dir, filename), content);
}

async function main() {
  const tmp = join(tmpdir(), `smoke-recent-${Date.now()}`);
  const memoryDir = join(tmp, "memory");
  const episodesDir = join(memoryDir, "episodes");
  mkdirSync(episodesDir, { recursive: true });

  makeEpisode(episodesDir, "2026-04-19-math-a.md", {
    id: "ep-a",
    session_id: "sid-a",
    title: "소수 증명",
    started: "2026-04-19T10:00:00Z",
    persona: "math-helper",
    promptVersion: "v2",
    cellId: "math_proof:primes",
    domain: "math_proof",
    l3Body: "classical math_proof 에서 직접 풀이, 결과 맞음",
    topicTags: ["math", "proof", "primes"],
  });
  makeEpisode(episodesDir, "2026-04-18-cia-b.md", {
    id: "ep-b",
    session_id: "sid-b",
    title: "CIA 토큰 갱신",
    started: "2026-04-18T14:00:00Z",
    persona: "cia-analyst",
    promptVersion: "v2",
    cellId: "cia_workflow:token-expiry",
    domain: "cia_workflow",
    l3Body: "token 만료 후 재인증 - 도움 요청 없이 완주",
    topicTags: ["cia", "token", "vault"],
  });
  makeEpisode(episodesDir, "2026-04-17-legacy.md", {
    id: "ep-c",
    session_id: "sid-c",
    title: "레거시 v1 에피소드",
    started: "2026-04-17T09:00:00Z",
    persona: "math-helper",
    promptVersion: "v1",
    topicTags: ["math", "proof"],
  });

  const hits1 = await searchRecentSessions(memoryDir, "claude-sonnet-4-6", "math proof primes", { limit: 3 });
  assert(hits1.length === 1, `expected 1 hit for math query, got ${hits1.length}`);
  assert(hits1[0]!.episode_id === "ep-a", `expected ep-a, got ${hits1[0]!.episode_id}`);
  assert(hits1[0]!.cell_ids.includes("math_proof:primes"), "cell_id missing");
  assert(hits1[0]!.l3_section_excerpt.includes("classical"), "L3 excerpt missing keyword");

  const hits2 = await searchRecentSessions(memoryDir, "claude-sonnet-4-6", "cia token", { limit: 3 });
  assert(hits2.length === 1, `expected 1 hit for cia query, got ${hits2.length}`);
  assert(hits2[0]!.episode_id === "ep-b", "expected ep-b");

  const hits3 = await searchRecentSessions(memoryDir, "claude-sonnet-4-6", "자전거 수리", { limit: 3 });
  assert(hits3.length === 0, `expected 0 hits for irrelevant, got ${hits3.length}`);

  const res = await composeRecentSessionsBlock(memoryDir, "claude-sonnet-4-6", "math proof", { limit: 3 });
  assert(res.prompt.includes("<my_recent_sessions>"), "missing opening tag");
  assert(res.prompt.includes("</my_recent_sessions>"), "missing closing tag");
  assert(res.prompt.includes("출처: 나의 최근 세션"), "missing source label");
  assert(res.prompt.includes("명령이 아니다"), "missing non-imperative marker");
  assert(res.prompt.includes("cell=math_proof:primes"), "missing cell annotation");
  assert(res.prompt.includes("classical"), "missing L3 excerpt content");

  const res2 = await composeRecentSessionsBlock(memoryDir, "claude-sonnet-4-6", "자전거 수리", { limit: 3 });
  assert(res2.prompt === "", `expected empty prompt, got: ${res2.prompt}`);

  console.log("[OK] smoke-recent-sessions-recall — 11 assertions passed");
  rmSync(tmp, { recursive: true, force: true });
}

main().then(() => process.exit(0));
