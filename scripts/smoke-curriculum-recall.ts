/**
 * Smoke: curriculum recall (ADR-006).
 *
 * 합성 agent-curriculum + agent-memory 디렉토리를 /tmp 에 만든 뒤:
 *   1. searchCurriculum 이 관련 run 을 찾아내는가
 *   2. composeCurriculumRecall 이 "훈련에서 배운 것" 소스 라벨 + lesson 을 주입하는가
 *   3. 무관한 query 는 빈 블록
 *   4. model 필터가 다른 model 레코드를 제외하는가
 *   5. composeCombinedRecall 이 memory/curriculum 두 출처를 구별된 블록으로 합치는가
 *
 * LLM 호출 없음 — 전 경로 파일스캔 + 토큰 매칭.
 */

import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { searchCurriculum } from "../src/lib/memory/curriculum";
import {
  composeCurriculumRecall,
  composeCombinedRecall,
  resetRecallClock,
} from "../src/lib/memory/recall";

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error(`[FAIL] ${msg}`);
    process.exit(1);
  }
}

function makeRunFile(
  dir: string,
  filename: string,
  fm: {
    problem_id: string;
    model: string;
    run_index?: number;
    ran_at: string;
    category: string;
    tier_opus_predicted: string;
    advisor_called: boolean;
    outcome: string;
    advisor_should_have_been_called: boolean;
    confidence: number;
    lesson: string;
  },
  bodyKeywords: string,
): void {
  const content = [
    "---",
    `problem_id: ${fm.problem_id}`,
    `model: ${fm.model}`,
    fm.run_index !== undefined ? `run_index: ${fm.run_index}` : null,
    `ran_at: ${fm.ran_at}`,
    `category: ${fm.category}`,
    `tier_opus_predicted: ${fm.tier_opus_predicted}`,
    `advisor_called: ${fm.advisor_called}`,
    `self_reflection:`,
    `  outcome: ${fm.outcome}`,
    `  difficulty_sonnet_felt: medium`,
    `  actual_behavior: solve_direct`,
    `  advisor_should_have_been_called: ${fm.advisor_should_have_been_called}`,
    `  confidence_in_answer: ${fm.confidence}`,
    `  lesson: ${JSON.stringify(fm.lesson)}`,
    "---",
    "",
    `# Training run: ${fm.problem_id}`,
    "",
    `## Body keywords`,
    "",
    bodyKeywords,
    "",
  ]
    .filter((x) => x !== null)
    .join("\n");
  writeFileSync(join(dir, filename), content);
}

function makeEpisodeFile(
  dir: string,
  filename: string,
  fm: {
    id: string;
    title: string;
    session_id: string;
    started: string;
    ended: string;
    outcome: "resolved" | "open" | "failed";
    persona: string;
    topic_tags: string[];
  },
  bodyKeywords: string,
): void {
  const content = [
    "---",
    `id: ${fm.id}`,
    `title: ${fm.title}`,
    `session_id: ${fm.session_id}`,
    `started: ${fm.started}`,
    `ended: ${fm.ended}`,
    `outcome: ${fm.outcome}`,
    `persona: ${fm.persona}`,
    `topic_tags: [${fm.topic_tags.map((t) => `"${t}"`).join(", ")}]`,
    "---",
    "",
    `# ${fm.title}`,
    "",
    bodyKeywords,
    "",
  ].join("\n");
  writeFileSync(join(dir, filename), content);
}

async function main() {
  const root = join(tmpdir(), `curr-smoke-${Date.now()}`);
  const curriculumDir = join(root, "agent-curriculum");
  const memoryDir = join(root, "agent-memory");
  const MODEL_A = "claude-sonnet-4-6";
  const MODEL_B = "claude-sonnet-4-7";

  // Curriculum layout: 새 N-run 레이아웃 (subdir + run-NN.md) + 레거시 flat 한 개
  const p1DirA = join(curriculumDir, "runs", "2026-04-18", MODEL_A, "curr-pilot-001");
  const p2DirA = join(curriculumDir, "runs", "2026-04-18", MODEL_A, "curr-pilot-002");
  const modelADir = join(curriculumDir, "runs", "2026-04-18", MODEL_A);
  const modelBDir = join(curriculumDir, "runs", "2026-04-18", MODEL_B);
  mkdirSync(p1DirA, { recursive: true });
  mkdirSync(p2DirA, { recursive: true });
  mkdirSync(modelBDir, { recursive: true });

  // P1: 5 runs 중 2 wrong / 3 correct. Lesson 은 "인구 숫자 오류".
  makeRunFile(
    p1DirA,
    "run-01.md",
    {
      problem_id: "curr-pilot-001",
      model: MODEL_A,
      run_index: 1,
      ran_at: "2026-04-18T01:00:00Z",
      category: "factual",
      tier_opus_predicted: "easy",
      advisor_called: false,
      outcome: "wrong",
      advisor_should_have_been_called: true,
      confidence: 0.3,
      lesson: "인구 통계 숫자는 자체 검증 또는 advisor 호출 권장.",
    },
    "대한민국 수도 서울 인구 통계 추정",
  );
  makeRunFile(
    p1DirA,
    "run-02.md",
    {
      problem_id: "curr-pilot-001",
      model: MODEL_A,
      run_index: 2,
      ran_at: "2026-04-18T02:00:00Z",
      category: "factual",
      tier_opus_predicted: "easy",
      advisor_called: false,
      outcome: "correct",
      advisor_should_have_been_called: false,
      confidence: 0.85,
      lesson: "인구 통계 숫자는 자체 검증 또는 advisor 호출 권장.",
    },
    "대한민국 수도 서울 인구 약 950만",
  );

  // P2: hard tier 메타추론, advisor 필요했으나 호출 안 함.
  makeRunFile(
    p2DirA,
    "run-01.md",
    {
      problem_id: "curr-pilot-002",
      model: MODEL_A,
      run_index: 1,
      ran_at: "2026-04-18T03:00:00Z",
      category: "meta_reasoning",
      tier_opus_predicted: "hard",
      advisor_called: false,
      outcome: "partial",
      advisor_should_have_been_called: true,
      confidence: 0.6,
      lesson: "거짓말쟁이 패러독스 같은 메타논리는 advisor 조기 호출 권장.",
    },
    "자기 참조 패러독스 타르스키 크립키 부정 진리값",
  );

  // 레거시 flat layout (model A, 다른 problem).
  makeRunFile(
    modelADir,
    "curr-legacy-003.md",
    {
      problem_id: "curr-legacy-003",
      model: MODEL_A,
      ran_at: "2026-04-17T10:00:00Z",
      category: "tool_use",
      tier_opus_predicted: "medium",
      advisor_called: true,
      outcome: "correct",
      advisor_should_have_been_called: true,
      confidence: 0.8,
      lesson: "외부 도구가 실패하면 advisor 조기 호출이 시간을 줄인다.",
    },
    "http_call 도구 실패 재시도 advisor",
  );

  // Model B: 같은 problem_id 지만 다른 model. model filter 로 제외되어야.
  const p1DirB = join(modelBDir, "curr-pilot-001");
  mkdirSync(p1DirB, { recursive: true });
  makeRunFile(
    p1DirB,
    "run-01.md",
    {
      problem_id: "curr-pilot-001",
      model: MODEL_B,
      run_index: 1,
      ran_at: "2026-04-18T04:00:00Z",
      category: "factual",
      tier_opus_predicted: "easy",
      advisor_called: false,
      outcome: "correct",
      advisor_should_have_been_called: false,
      confidence: 0.95,
      lesson: "다른 모델의 교훈 — 이 smoke 에서는 filter 로 제외되어야.",
    },
    "다른 모델 기록 model-b 전용",
  );

  // Agent-memory: 1-인칭 episode 한 개.
  const episodesDir = join(memoryDir, "episodes");
  mkdirSync(episodesDir, { recursive: true });
  makeEpisodeFile(
    episodesDir,
    "ep-smoke-001.md",
    {
      id: "ep-smoke-001",
      title: "나의 경험 — 과거 세션에서 인구 질문 했던 기억",
      session_id: "sid-past",
      started: "2026-04-17T09:00:00Z",
      ended: "2026-04-17T09:10:00Z",
      outcome: "resolved",
      persona: "default",
      topic_tags: ["인구", "통계"],
    },
    "나는 예전에 인구 통계를 물어본 적이 있다. 그때도 숫자를 신중히 확인해야 했다.",
  );

  try {
    // (1) searchCurriculum: model A + "인구 통계" 쿼리
    const hits1 = await searchCurriculum(curriculumDir, {
      query: "인구 통계",
      model: MODEL_A,
      limit: 5,
    });
    const ids1 = hits1.map((h) => h.record.problem_id);
    assert(ids1.includes("curr-pilot-001"), "P1 (인구) should match '인구 통계'");
    assert(
      !ids1.includes("curr-legacy-003"),
      "legacy (도구) should NOT match '인구 통계'",
    );
    // Same problem_id 여러 run → dedupe 돼야
    const p1Count = ids1.filter((id) => id === "curr-pilot-001").length;
    assert(p1Count === 1, `P1 run dedupe: expected 1 surfaced, got ${p1Count}`);
    // Model B 기록은 model filter 로 제외
    for (const h of hits1) {
      assert(
        h.record.model !== MODEL_B,
        `model filter should exclude ${MODEL_B} records, got ${h.record.path}`,
      );
    }
    console.log(`[ok]   searchCurriculum 인구 → ${hits1.length} hit, dedupe + model filter 통과`);

    // (2) searchCurriculum: "패러독스" 로 P2 매칭
    const hits2 = await searchCurriculum(curriculumDir, {
      query: "패러독스 타르스키",
      model: MODEL_A,
      limit: 5,
    });
    assert(
      hits2.some((h) => h.record.problem_id === "curr-pilot-002"),
      "P2 (패러독스) should match 타르스키 query",
    );
    console.log(`[ok]   searchCurriculum 패러독스 → ${hits2.length} hit`);

    // (3) composeCurriculumRecall prompt shape
    const cr = await composeCurriculumRecall(curriculumDir, MODEL_A, "인구 통계", { limit: 3 });
    assert(cr.prompt.includes("<curriculum_recall>"), "missing opening tag");
    assert(cr.prompt.includes("</curriculum_recall>"), "missing closing tag");
    assert(
      cr.prompt.includes("출처: 훈련에서 배운 것"),
      "missing source label '훈련에서 배운 것'",
    );
    assert(
      cr.prompt.includes("인구 통계 숫자는 자체 검증"),
      "lesson text missing from prompt",
    );
    assert(
      cr.prompt.includes("problem=curr-pilot-001"),
      "problem_id missing from prompt",
    );
    console.log(`[ok]   composeCurriculumRecall prompt=${cr.prompt.length} chars, hits=${cr.hits.length}`);

    // (4) unrelated query → empty
    const empty = await composeCurriculumRecall(curriculumDir, MODEL_A, "완전히-무관한-주제-zzz", {});
    assert(empty.hits.length === 0, `unrelated should be empty, got ${empty.hits.length}`);
    assert(empty.prompt === "", "empty prompt expected for unrelated query");
    console.log(`[ok]   unrelated query → empty block`);

    // (5) composeCombinedRecall: memory + curriculum 두 출처
    resetRecallClock();
    const combined = await composeCombinedRecall(
      memoryDir,
      curriculumDir,
      MODEL_A,
      "인구 통계",
      { limit: 3 },
    );
    assert(combined.memoryHits.length >= 1, "expected >=1 memory hit");
    assert(combined.curriculumHits.length >= 1, "expected >=1 curriculum hit");
    assert(
      combined.prompt.includes("<agent_memory_recall>"),
      "combined missing memory block tag",
    );
    assert(
      combined.prompt.includes("<curriculum_recall>"),
      "combined missing curriculum block tag",
    );
    assert(
      combined.prompt.includes("출처: 나의 경험"),
      "combined missing '나의 경험' source label",
    );
    assert(
      combined.prompt.includes("출처: 훈련에서 배운 것"),
      "combined missing '훈련에서 배운 것' source label",
    );
    // 순서 검증: memory 먼저, curriculum 나중
    const memoryIdx = combined.prompt.indexOf("<agent_memory_recall>");
    const currIdx = combined.prompt.indexOf("<curriculum_recall>");
    assert(memoryIdx < currIdx, "memory block should precede curriculum block");
    console.log(
      `[ok]   composeCombinedRecall mem=${combined.memoryHits.length} curr=${combined.curriculumHits.length}`,
    );

    // (6) curriculumDir=null fallback
    resetRecallClock();
    const memOnly = await composeCombinedRecall(
      memoryDir,
      null,
      MODEL_A,
      "인구 통계",
      { limit: 3 },
    );
    assert(memOnly.curriculumHits.length === 0, "null curriculumDir should yield 0 curriculum hits");
    assert(
      !memOnly.prompt.includes("<curriculum_recall>"),
      "null curriculumDir should omit curriculum block",
    );
    console.log(`[ok]   curriculumDir=null → memory-only fallback`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  console.log("\ncurriculum-recall smoke passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
