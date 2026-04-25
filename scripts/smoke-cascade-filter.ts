#!/usr/bin/env tsx
/**
 * Smoke — cascade-filter (M1) classification logic 검증.
 *
 * 3 가지 detection rule + happy path 의 5 케이스 직접 통과:
 *   A1. title marker (오인 / 오기억) → skip
 *   B1. L3 outcome=wrong + behavior=solve_direct → skip
 *   C1. body phrase (memory_search 결과를 잘못 해석...) → skip
 *   P1. 정상 with-disclaimer episode → pass
 *   P2. correct + acknowledge_unknown → pass
 *
 * Usage: npx tsx scripts/smoke-cascade-filter.ts
 */

import { classifyCascadeRisk, filterCascadeRisk } from "../src/lib/memory/cascade-filter";
import type { ConsolidatedEpisode } from "../src/lib/memory/consolidate";

interface Case {
  name: string;
  episode: ConsolidatedEpisode;
  expectSkip: boolean;
  expectReason?: string;
}

function buildEpisode(opts: {
  title: string;
  body: string;
  rubric?: "correct" | "partial" | "wrong" | "uncertain";
  behavior?: string;
}): ConsolidatedEpisode {
  return {
    id: "smoke-id",
    slug: "smoke-slug",
    path: "smoke.md",
    body: opts.body,
    sourceRanges: [],
    frontmatter: {
      id: "smoke-id",
      session_id: "smoke",
      title: opts.title,
      topic_tags: [],
      started: "2026-04-26T00:00:00Z",
      ended: "2026-04-26T00:01:00Z",
      sources: [],
      participants: ["roy", "claude"],
      persona: "default",
      persona_ref: "HEAD",
      boundary_reason: "smoke",
      consolidation: { model: "smoke", prompt_version: "v2", at: "2026-04-26T00:01:00Z" },
      outcome: "resolved",
      l3_observations:
        opts.rubric && opts.behavior
          ? [
              {
                cell_id: "smoke:cell",
                domain: "smoke",
                default_behavior: "acknowledge_unknown",
                actual_behavior_this_session: opts.behavior,
                match: false,
                advisor_called: false,
                advisor_self_felt_need: false,
                outcome_self_rubric: opts.rubric,
                confidence_self: 0.5,
              },
            ]
          : undefined,
    },
  };
}

const cases: Case[] = [
  {
    name: "A1 title 오인 marker",
    episode: buildEpisode({
      title: "이전 추천 카페 재확인 — 오인 반복",
      body: "정상 본문",
    }),
    expectSkip: true,
    expectReason: "title_marker",
  },
  {
    name: "A2 title 오기억 marker",
    episode: buildEpisode({ title: "카페 재확인 오기억 반복", body: "" }),
    expectSkip: true,
    expectReason: "title_marker",
  },
  {
    name: "B1 wrong + solve_direct",
    episode: buildEpisode({
      title: "정상 제목",
      body: "정상 본문",
      rubric: "wrong",
      behavior: "solve_direct",
    }),
    expectSkip: true,
    expectReason: "rubric_wrong_solve_direct",
  },
  {
    name: "B2 wrong but ask_user — 통과",
    episode: buildEpisode({
      title: "정상 제목",
      body: "정상 본문",
      rubric: "wrong",
      behavior: "ask_user",
    }),
    expectSkip: false,
  },
  {
    name: "C1 body 'memory_search 결과를 잘못 해석'",
    episode: buildEpisode({
      title: "정상 제목",
      body: "memory_search 결과를 잘못 해석해 답했다.",
    }),
    expectSkip: true,
    expectReason: "body_self_aware_cascade",
  },
  {
    name: "C2 body '동일 오류 반복'",
    episode: buildEpisode({
      title: "정상 제목",
      body: "직전 세션과 동일한 오류를 반복했다.",
    }),
    expectSkip: true,
    expectReason: "body_self_aware_cascade",
  },
  {
    name: "P1 with-disclaimer correct — 통과",
    episode: buildEpisode({
      title: "Prior session 주입 기록 disclaimer 응답",
      body: "주입된 기록에 따르면 카페명은 '푸른 안개'입니다. 다만 직접 검증할 수 없습니다.",
      rubric: "correct",
      behavior: "solve_direct",
    }),
    expectSkip: false,
  },
  {
    name: "P2 acknowledge_unknown 정상 — 통과",
    episode: buildEpisode({
      title: "이전 세션 기억 없음 안내",
      body: "이전 세션 대화 내용을 기억하지 못합니다.",
      rubric: "correct",
      behavior: "acknowledge_unknown",
    }),
    expectSkip: false,
  },
];

let pass = 0;
let fail = 0;
for (const c of cases) {
  const decision = classifyCascadeRisk(c.episode);
  const ok =
    decision.skip === c.expectSkip &&
    (!c.expectReason || decision.reason === c.expectReason);
  if (ok) {
    pass++;
    console.log(
      `  ✓ ${c.name}  skip=${decision.skip}${decision.reason ? ` reason=${decision.reason}` : ""}`,
    );
  } else {
    fail++;
    console.log(
      `  ✗ ${c.name}  expected skip=${c.expectSkip} reason=${c.expectReason ?? "—"}, got skip=${decision.skip} reason=${decision.reason ?? "—"} detail=${decision.detail ?? "—"}`,
    );
  }
}

const filterResult = filterCascadeRisk(cases.map((c) => c.episode));
console.log(
  `\n[filter] ${cases.length} input → ${filterResult.written.length} written, ${filterResult.skipped.length} skipped`,
);

console.log(`\n${pass}/${cases.length} pass${fail > 0 ? `, ${fail} fail` : ""}`);
process.exit(fail > 0 ? 1 : 0);
