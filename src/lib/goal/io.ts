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

/**
 * Append a line to the goal's "## 진행 로그" section. 없으면 섹션 자체를 append.
 * Atomic — reuses saveGoal.
 */
export async function appendProgress(
  goal: LoadedGoal,
  line: string,
  now: Date = new Date(),
): Promise<void> {
  const ts = now.toISOString();
  const entry = `- ${ts} ${line.trim()}`;

  const marker = "## 진행 로그";
  let newBody: string;
  const idx = goal.body.indexOf(marker);
  if (idx === -1) {
    // No section — append at end.
    newBody = goal.body.trimEnd() + `\n\n${marker}\n\n${entry}\n`;
  } else {
    // Find end of section (next "## " heading or EOF).
    const afterHeading = idx + marker.length;
    const rest = goal.body.slice(afterHeading);
    const nextSectionMatch = rest.match(/\n## [^\n]/);
    const insertAt =
      nextSectionMatch && nextSectionMatch.index !== undefined
        ? afterHeading + nextSectionMatch.index
        : goal.body.length;
    const before = goal.body.slice(0, insertAt).trimEnd();
    const after = goal.body.slice(insertAt);
    newBody = `${before}\n${entry}\n${after.startsWith("\n") ? after : "\n" + after}`;
  }

  // Update progress timestamps in frontmatter.
  const updated: LoadedGoal = {
    ...goal,
    body: newBody,
    frontmatter: {
      ...goal.frontmatter,
      progress: {
        ...goal.frontmatter.progress,
        last_updated: ts,
      },
    },
  };
  await saveGoal(updated);
}

const ALLOWED_TRANSITIONS: Record<GoalStatus, GoalStatus[]> = {
  draft: ["active", "aborted"],
  active: ["paused", "completed", "failed", "aborted"],
  paused: ["active", "aborted", "failed"],
  completed: [],      // terminal
  failed: [],         // terminal
  aborted: [],        // terminal
};

export async function setStatus(
  goal: LoadedGoal,
  next: GoalStatus,
  reason?: string,
  now: Date = new Date(),
): Promise<LoadedGoal> {
  const current = goal.frontmatter.status;
  const allowed = ALLOWED_TRANSITIONS[current] ?? [];
  if (!allowed.includes(next)) {
    throw new Error(
      `goal ${goal.path}: invalid status transition ${current} → ${next}. allowed: [${allowed.join(", ")}]`,
    );
  }

  const ts = now.toISOString();
  const progressUpdate: ProgressState = {
    ...goal.frontmatter.progress,
    last_updated: ts,
    ...(next === "active" && goal.frontmatter.progress.started_at === null
      ? { started_at: ts }
      : {}),
  };

  const updated: LoadedGoal = {
    ...goal,
    frontmatter: {
      ...goal.frontmatter,
      status: next,
      progress: progressUpdate,
    },
  };
  await saveGoal(updated);

  // Also append a progress log entry.
  const loaded = await loadGoal(goal.path);
  const reasonStr = reason ? ` (${reason})` : "";
  await appendProgress(loaded, `[status] ${current} → ${next}${reasonStr}`, now);

  return await loadGoal(goal.path);
}

/**
 * Reset execution progress — Roy 가 paused 된 goal 을 "새 run 으로 재시작"
 * 할 때 사용. started_at/iterations/tokens/usd 를 0/null 로 클리어하여
 * BudgetTracker 가 새 wall-time clock 으로 출발하게 한다.
 *
 * retry_count 는 보존 — 재시도 상한은 누적 기준.
 * 진행 로그에 `[reset]` 라인 append.
 */
export async function resetProgress(
  goal: LoadedGoal,
  now: Date = new Date(),
): Promise<LoadedGoal> {
  const ts = now.toISOString();
  const cleared: ProgressState = {
    iterations: 0,
    tokens_used: 0,
    usd_spent: 0,
    started_at: null,
    last_updated: ts,
    retry_count: goal.frontmatter.progress.retry_count,
  };
  const updated: LoadedGoal = {
    ...goal,
    frontmatter: {
      ...goal.frontmatter,
      progress: cleared,
    },
  };
  await saveGoal(updated);
  const loaded = await loadGoal(goal.path);
  await appendProgress(loaded, `[reset] progress cleared`, now);
  return await loadGoal(goal.path);
}
