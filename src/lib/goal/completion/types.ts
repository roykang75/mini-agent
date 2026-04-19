/**
 * Completion check types (ADR-009 P1).
 */

import type { CompletionCriterion } from "../types";

export interface EvaluatorResult {
  passed: boolean;
  criterion: CompletionCriterion;
  detail: string;   // human-readable evidence (pass 인 경우 "file found", fail 인 경우 "pattern 0 matches")
}

export interface EvaluatorContext {
  workDir: string;     // criterion path 를 resolve 할 base dir (보통 프로젝트 root)
  askAdvisor?: (question: string, context: string) => Promise<string>;  // llm_predicate 에 필요
}
