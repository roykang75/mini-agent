/**
 * Goal IO (ADR-009 Phase 1).
 *
 * Atomic write via tmp + rename. Frontmatter 는 gray-matter 로 round-trip.
 * Body 는 user/agent 가 편집 — loadGoal 은 body 를 string 으로 그대로 둠.
 */

import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import matter from "gray-matter";

import type {
  GoalFrontmatter,
  GoalStatus,
  CompletionCriterion,
  ProgressState,
} from "./types";

export interface LoadedGoal {
  path: string;
  frontmatter: GoalFrontmatter;
  body: string;
}

export async function loadGoal(path: string): Promise<LoadedGoal> {
  const raw = await readFile(path, "utf-8");
  const parsed = matter(raw);
  const fm = parsed.data as Record<string, unknown>;
  validateFrontmatter(fm, path);
  return {
    path,
    frontmatter: fm as unknown as GoalFrontmatter,
    body: parsed.content,
  };
}

export async function saveGoal(goal: LoadedGoal): Promise<void> {
  const fmData = goal.frontmatter as unknown as Record<string, unknown>;
  const out = matter.stringify(goal.body, fmData);
  await mkdir(dirname(goal.path), { recursive: true });
  // Atomic: write to tmp then rename.
  const tmp = `${goal.path}.tmp-${randomBytes(4).toString("hex")}`;
  await writeFile(tmp, out, "utf-8");
  await rename(tmp, goal.path);
}

function validateFrontmatter(fm: Record<string, unknown>, path: string): void {
  const required = [
    "id", "slug", "created", "created_by", "status",
    "completion_criteria", "budget", "hil_policy",
    "autonomy_config", "progress", "persona",
  ];
  for (const k of required) {
    if (fm[k] === undefined) {
      throw new Error(`goal ${path}: missing required frontmatter field "${k}"`);
    }
  }
  if (!Array.isArray(fm.completion_criteria)) {
    throw new Error(`goal ${path}: completion_criteria must be array`);
  }
  for (const c of fm.completion_criteria) {
    validateCriterion(c as CompletionCriterion, path);
  }
  const validStatus: GoalStatus[] = ["draft", "active", "paused", "completed", "failed", "aborted"];
  if (!validStatus.includes(fm.status as GoalStatus)) {
    throw new Error(`goal ${path}: invalid status "${fm.status}"`);
  }
}

function validateCriterion(c: CompletionCriterion, path: string): void {
  switch (c.type) {
    case "file_exists":
    case "file_not_exists":
      if (typeof c.path !== "string" || c.path.length === 0) {
        throw new Error(`goal ${path}: ${c.type} criterion missing path`);
      }
      return;
    case "grep_count":
      if (typeof c.path !== "string" || typeof c.pattern !== "string") {
        throw new Error(`goal ${path}: grep_count missing path or pattern`);
      }
      if (c.min_count === undefined && c.max_count === undefined) {
        throw new Error(`goal ${path}: grep_count requires min_count or max_count`);
      }
      return;
    case "grep_absent":
      if (typeof c.path !== "string" || typeof c.pattern !== "string") {
        throw new Error(`goal ${path}: grep_absent missing path or pattern`);
      }
      return;
    case "llm_predicate":
      if (typeof c.description !== "string" || c.description.length === 0) {
        throw new Error(`goal ${path}: llm_predicate missing description`);
      }
      return;
    default: {
      const _exhaustive: never = c;
      throw new Error(`goal ${path}: unknown criterion type: ${JSON.stringify(c)}`);
    }
  }
}
