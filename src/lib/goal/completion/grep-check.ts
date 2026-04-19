/**
 * grep_count / grep_absent evaluators (ADR-009 P1).
 *
 * Pattern 은 plain substring (v1). 정규식은 후속 타입으로 분리 예정.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type {
  GrepCountCriterion,
  GrepAbsentCriterion,
} from "../types";
import type { EvaluatorContext, EvaluatorResult } from "./types";

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let n = 0;
  let i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) {
    n++;
    i += needle.length;
  }
  return n;
}

export async function evaluateGrepCount(
  c: GrepCountCriterion,
  ctx: EvaluatorContext,
): Promise<EvaluatorResult> {
  const abs = resolve(ctx.workDir, c.path);
  let content: string;
  try {
    content = await readFile(abs, "utf-8");
  } catch {
    return { passed: false, criterion: c, detail: `cannot read ${c.path}` };
  }
  const n = countOccurrences(content, c.pattern);
  const minOk = c.min_count === undefined || n >= c.min_count;
  const maxOk = c.max_count === undefined || n <= c.max_count;
  const passed = minOk && maxOk;
  const range = `[${c.min_count ?? "-"}..${c.max_count ?? "-"}]`;
  return {
    passed,
    criterion: c,
    detail: `${c.path} pattern "${c.pattern}" found ${n} (expected ${range})`,
  };
}

export async function evaluateGrepAbsent(
  c: GrepAbsentCriterion,
  ctx: EvaluatorContext,
): Promise<EvaluatorResult> {
  const abs = resolve(ctx.workDir, c.path);
  let content: string;
  try {
    content = await readFile(abs, "utf-8");
  } catch {
    // File missing → pattern trivially absent. Pass.
    return { passed: true, criterion: c, detail: `file missing (treated as pattern absent): ${c.path}` };
  }
  const n = countOccurrences(content, c.pattern);
  return {
    passed: n === 0,
    criterion: c,
    detail: `${c.path} pattern "${c.pattern}" found ${n} (expected 0)`,
  };
}
