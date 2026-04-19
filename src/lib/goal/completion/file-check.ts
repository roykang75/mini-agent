/**
 * file_exists / file_not_exists evaluators (ADR-009 P1).
 */

import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { resolve } from "node:path";

import type {
  FileExistsCriterion,
  FileNotExistsCriterion,
} from "../types";
import type { EvaluatorContext, EvaluatorResult } from "./types";

export async function evaluateFileExists(
  c: FileExistsCriterion,
  ctx: EvaluatorContext,
): Promise<EvaluatorResult> {
  const abs = resolve(ctx.workDir, c.path);
  try {
    await access(abs, fsConstants.F_OK);
    return { passed: true, criterion: c, detail: `file exists: ${c.path}` };
  } catch {
    return { passed: false, criterion: c, detail: `file missing: ${c.path}` };
  }
}

export async function evaluateFileNotExists(
  c: FileNotExistsCriterion,
  ctx: EvaluatorContext,
): Promise<EvaluatorResult> {
  const abs = resolve(ctx.workDir, c.path);
  try {
    await access(abs, fsConstants.F_OK);
    return { passed: false, criterion: c, detail: `file unexpectedly exists: ${c.path}` };
  } catch {
    return { passed: true, criterion: c, detail: `file absent: ${c.path}` };
  }
}
