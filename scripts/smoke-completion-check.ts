/**
 * Smoke: completion-check (ADR-009 P1).
 *
 * 합성 file + 가짜 askAdvisor 로 5 type 평가 + aggregator AND 로직 검증.
 */

import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { evaluateCompletion } from "../src/lib/goal/completion/evaluate";
import type { EvaluatorContext } from "../src/lib/goal/completion/types";
import type { CompletionCriterion } from "../src/lib/goal/types";

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error(`[FAIL] ${msg}`);
    process.exit(1);
  }
}

async function main() {
  const tmp = join(tmpdir(), `smoke-completion-${Date.now()}`);
  mkdirSync(tmp, { recursive: true });

  writeFileSync(join(tmp, "present.md"), "Hello world\nHello again\nbye\n");
  // "absent.md" 는 일부러 없음

  const askAdvisorYes = async (_q: string, _ctx: string) => "YES — 명제 참임, 근거: test OK.";
  const askAdvisorNo = async (_q: string, _ctx: string) => "NO — 근거 없음.";

  const ctx: EvaluatorContext = { workDir: tmp, askAdvisor: askAdvisorYes };

  // Test 1: all mechanical pass
  const criteria1: CompletionCriterion[] = [
    { type: "file_exists", path: "present.md" },
    { type: "file_not_exists", path: "absent.md" },
    { type: "grep_count", path: "present.md", pattern: "Hello", min_count: 2 },
    { type: "grep_absent", path: "present.md", pattern: "farewell" },
  ];
  const r1 = await evaluateCompletion(criteria1, ctx);
  assert(r1.passed, `mechanical all pass — got ${r1.failed_criteria.length} failures`);
  assert(r1.results.length === 4, "4 criteria evaluated");

  // Test 2: grep_count under min
  const criteria2: CompletionCriterion[] = [
    { type: "grep_count", path: "present.md", pattern: "Hello", min_count: 10 },
  ];
  const r2 = await evaluateCompletion(criteria2, ctx);
  assert(!r2.passed, "grep_count under min should fail");
  assert(r2.failed_criteria[0]!.detail.includes("found 2"), "detail includes actual count");

  // Test 3: grep_absent with matching pattern
  const criteria3: CompletionCriterion[] = [
    { type: "grep_absent", path: "present.md", pattern: "Hello" },
  ];
  const r3 = await evaluateCompletion(criteria3, ctx);
  assert(!r3.passed, "grep_absent with match should fail");

  // Test 4: file_exists on missing
  const criteria4: CompletionCriterion[] = [
    { type: "file_exists", path: "absent.md" },
  ];
  const r4 = await evaluateCompletion(criteria4, ctx);
  assert(!r4.passed, "file_exists on missing file should fail");

  // Test 5: mechanical pass + llm_predicate YES
  const criteria5: CompletionCriterion[] = [
    { type: "file_exists", path: "present.md" },
    { type: "llm_predicate", description: "파일이 의미 있는 내용을 담았는가" },
  ];
  const r5 = await evaluateCompletion(criteria5, ctx);
  assert(r5.passed, "mechanical + llm YES should pass");

  // Test 6: mechanical pass + llm_predicate NO
  const ctxNo: EvaluatorContext = { workDir: tmp, askAdvisor: askAdvisorNo };
  const r6 = await evaluateCompletion(criteria5, ctxNo);
  assert(!r6.passed, "mechanical pass + llm NO should fail");
  assert(r6.failed_criteria.some((f) => f.criterion.type === "llm_predicate"), "llm_predicate in failed");

  // Test 7: short-circuit — mechanical fails, llm skipped
  const criteria7: CompletionCriterion[] = [
    { type: "file_exists", path: "absent.md" },
    { type: "llm_predicate", description: "irrelevant" },
  ];
  const r7 = await evaluateCompletion(criteria7, ctx);
  assert(!r7.passed, "mechanical fail → whole report fail");
  const llmResult7 = r7.results.find((r) => r.criterion.type === "llm_predicate")!;
  assert(llmResult7.detail.includes("skipped"), "llm_predicate skipped when mechanical failed");

  console.log("[OK] smoke-completion-check — 11 assertions passed");
  rmSync(tmp, { recursive: true, force: true });
}

main().then(() => process.exit(0));
