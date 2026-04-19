/**
 * Completion aggregator (ADR-009 P1).
 *
 * Goal 의 completion_criteria 배열을 차례로 평가. 전부 통과해야 goal complete.
 * Order: rubric mechanical (file_exists, grep_*) → llm_predicate (ADR-009 결정 4).
 */

import type { CompletionCriterion } from "../types";
import type { EvaluatorContext, EvaluatorResult } from "./types";
import { evaluateFileExists, evaluateFileNotExists } from "./file-check";
import { evaluateGrepCount, evaluateGrepAbsent } from "./grep-check";
import { evaluateLlmPredicate } from "./llm-predicate";

export interface CompletionReport {
  passed: boolean;
  results: EvaluatorResult[];
  failed_criteria: EvaluatorResult[];
}

export async function evaluateCompletion(
  criteria: CompletionCriterion[],
  ctx: EvaluatorContext,
): Promise<CompletionReport> {
  // Order: mechanical first (cheap, deterministic), llm_predicate last (expensive, potentially wrong).
  const mechanical = criteria.filter((c) => c.type !== "llm_predicate");
  const llm = criteria.filter((c) => c.type === "llm_predicate");

  const results: EvaluatorResult[] = [];
  for (const c of mechanical) {
    const r = await evaluateOne(c, ctx);
    results.push(r);
  }
  // Short-circuit: if any mechanical failed, skip llm_predicate to save tokens.
  const mechanicalAllPassed = results.every((r) => r.passed);
  if (mechanicalAllPassed) {
    for (const c of llm) {
      const r = await evaluateOne(c, ctx);
      results.push(r);
    }
  } else {
    for (const c of llm) {
      results.push({ passed: false, criterion: c, detail: "skipped (mechanical failed first)" });
    }
  }

  const failed = results.filter((r) => !r.passed);
  return { passed: failed.length === 0, results, failed_criteria: failed };
}

async function evaluateOne(
  c: CompletionCriterion,
  ctx: EvaluatorContext,
): Promise<EvaluatorResult> {
  switch (c.type) {
    case "file_exists": return evaluateFileExists(c, ctx);
    case "file_not_exists": return evaluateFileNotExists(c, ctx);
    case "grep_count": return evaluateGrepCount(c, ctx);
    case "grep_absent": return evaluateGrepAbsent(c, ctx);
    case "llm_predicate": return evaluateLlmPredicate(c, ctx);
    default: {
      const _ex: never = c;
      throw new Error(`unknown criterion type: ${JSON.stringify(c)}`);
    }
  }
}
