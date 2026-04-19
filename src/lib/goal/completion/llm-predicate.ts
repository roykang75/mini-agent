/**
 * llm_predicate evaluator (ADR-009 P1).
 *
 * askAdvisor 재사용 — Opus 가 자연어 predicate 에 YES/NO 답변. 신뢰 구간 낮음 — last resort.
 */

import type { LlmPredicateCriterion } from "../types";
import type { EvaluatorContext, EvaluatorResult } from "./types";

export async function evaluateLlmPredicate(
  c: LlmPredicateCriterion,
  ctx: EvaluatorContext,
): Promise<EvaluatorResult> {
  if (!ctx.askAdvisor) {
    return {
      passed: false,
      criterion: c,
      detail: "llm_predicate requires askAdvisor in EvaluatorContext",
    };
  }
  const question = `다음 명제가 현재 시점에서 참인지 판단: "${c.description}". 답변 시작을 반드시 "YES" 또는 "NO" 대문자로 하고 그 뒤에 한 줄 근거.`;
  const context = `이 평가는 ADR-009 goal completion check 의 llm_predicate 타입. 근거를 가능한 한 file 이나 관측 데이터 인용으로. 불확실하면 NO.`;
  const response = await ctx.askAdvisor(question, context);
  const trimmed = response.trim();
  const upper = trimmed.slice(0, 16).toUpperCase();
  const passed = upper.startsWith("YES");
  return {
    passed,
    criterion: c,
    detail: `llm_predicate "${c.description}" → ${passed ? "YES" : "NO"} (${trimmed.slice(0, 120)})`,
  };
}
