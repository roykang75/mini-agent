/**
 * Smoke: consolidate-v2 — L3 섹션 파싱/검증.
 *
 * 합성 raw JSONL + 합성 agent-memory tmp dir 에 consolidate-v2 prompt 를 두고
 * LLM 을 mock 해서 v2 episode 출력을 consolidate() 가 파싱·검증하는지 확인.
 *
 * LLM 호출은 MOCK_LLM_RESPONSE env 로 가로챔 (실 비용 없음).
 */

import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, cpSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { consolidate } from "../src/lib/memory/consolidate";

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error(`[FAIL] ${msg}`);
    process.exit(1);
  }
}

const REPO_ROOT = resolve(__dirname, "..");
const MEMORY_PROMPT_SRC = resolve(REPO_ROOT, "..", "agent-memory", "prompts", "consolidate-v2.md");

async function main() {
  const tmp = join(tmpdir(), `smoke-consolidate-v2-${Date.now()}`);
  const memoryDir = join(tmp, "memory");
  mkdirSync(join(memoryDir, "prompts"), { recursive: true });
  mkdirSync(join(memoryDir, "raw", "2026", "04", "19"), { recursive: true });
  mkdirSync(join(memoryDir, "episodes"), { recursive: true });

  cpSync(MEMORY_PROMPT_SRC, join(memoryDir, "prompts", "consolidate-v2.md"));

  const rawPath = join(memoryDir, "raw", "2026", "04", "19", "0001.jsonl");
  const rawLines = [
    { ts: "2026-04-19T10:00:00Z", session_id: "sid-test-001", event_type: "user_message", payload: { content: "소수 증명 해줘" }, persona: "math-helper", persona_ref: "HEAD" },
    { ts: "2026-04-19T10:00:10Z", session_id: "sid-test-001", event_type: "message", payload: { content: "Euclid 스타일 귀류법으로 증명..." }, persona: "math-helper", persona_ref: "HEAD" },
  ];
  writeFileSync(rawPath, rawLines.map((l) => JSON.stringify(l)).join("\n") + "\n");

  const mockEpisodeText = `---
id: PLACEHOLDER
session_id: sid-test-001
title: "소수 무한성 증명 세션"
topic_tags: [math_proof, primes]
started: 2026-04-19T10:00:00Z
ended: 2026-04-19T10:00:10Z
sources:
  - raw/2026/04/19/0001.jsonl#L1-2
participants: [roy, claude, math-helper]
persona: math-helper
persona_ref: HEAD
boundary_reason: "단일 요청-응답 흐름, 경계 분할 불필요"
consolidation:
  model: claude-sonnet-4-6
  prompt_version: v2
  at: PLACEHOLDER
outcome: resolved
l3_observations:
  - cell_id: "math_proof:primes-infinity"
    domain: math_proof
    default_behavior: solve_direct
    actual_behavior_this_session: solve_direct
    match: true
    advisor_called: false
    advisor_self_felt_need: false
    outcome_self_rubric: correct
    confidence_self: 0.95
---

## TL;DR

소수가 무한하다는 것을 Euclid 귀류법으로 증명했다.

## 주요 결정

- Euclid 귀류법 사용
- N! + 1 꼴 언급

## 학습

- 이런 고전 증명은 advisor 없이 충분

## 남은 이슈

## L3 관찰 (나의 습관)

- math_proof 류 classical 문제에서 나는 직접 풀이 습관대로 갔고 결과도 맞았다.

### 다음으로 읽을 나에게

classical math_proof 는 confident 로 가도 안전. non-classical 변형은 재검토.
`;

  process.env.CONSOLIDATE_MODEL = "claude-sonnet-4-6";
  process.env.MOCK_LLM_RESPONSE = mockEpisodeText;

  const result = await consolidate({ rawPath, memoryDir });

  assert(!result.usedFallback, `expected no fallback, got ${result.fallbackReason}`);
  assert(result.episodes.length === 1, `expected 1 episode, got ${result.episodes.length}`);

  const ep = result.episodes[0]!;
  const epContent = readFileSync(ep.path, "utf-8");

  assert(epContent.includes("## L3 관찰 (나의 습관)"), "missing L3 section in body");
  assert(epContent.includes("l3_observations:"), "missing l3_observations in frontmatter");
  assert(epContent.includes("math_proof:primes-infinity"), "missing cell_id in frontmatter");
  assert(epContent.includes("다음으로 읽을 나에게"), "missing 다음으로 서브섹션");

  const matter = (await import("gray-matter")).default;
  const parsed = matter(epContent);
  const fm = parsed.data as Record<string, unknown>;
  assert(Array.isArray(fm.l3_observations), "l3_observations not array");
  const l3 = (fm.l3_observations as unknown[])[0] as Record<string, unknown>;
  assert(l3.cell_id === "math_proof:primes-infinity", "cell_id mismatch");
  assert(l3.match === true, "match field not true");
  assert(l3.confidence_self === 0.95, "confidence_self mismatch");

  // Negative: v2 prompt_version but l3_observations missing → should fallback
  const badV2 = mockEpisodeText
    .replace(/l3_observations:[\s\S]*?confidence_self: 0\.95\s*/, "");
  process.env.MOCK_LLM_RESPONSE = badV2;

  const tmp2 = join(tmpdir(), `smoke-consolidate-v2-neg-${Date.now()}`);
  mkdirSync(join(tmp2, "memory", "prompts"), { recursive: true });
  mkdirSync(join(tmp2, "memory", "raw", "2026", "04", "19"), { recursive: true });
  mkdirSync(join(tmp2, "memory", "episodes"), { recursive: true });
  cpSync(MEMORY_PROMPT_SRC, join(tmp2, "memory", "prompts", "consolidate-v2.md"));
  const rawPath2 = join(tmp2, "memory", "raw", "2026", "04", "19", "0001.jsonl");
  writeFileSync(rawPath2, rawLines.map((l) => JSON.stringify(l)).join("\n") + "\n");

  const result2 = await consolidate({ rawPath: rawPath2, memoryDir: join(tmp2, "memory") });
  assert(result2.usedFallback, "expected fallback for missing l3_observations, got normal episode");
  assert(
    (result2.fallbackReason ?? "").includes("l3_observations"),
    `expected fallback reason to mention l3_observations, got: ${result2.fallbackReason}`,
  );
  rmSync(tmp2, { recursive: true, force: true });

  console.log("[OK] smoke-consolidate-v2 — 10 assertions passed");
  rmSync(tmp, { recursive: true, force: true });
}

main().then(() => process.exit(0));
