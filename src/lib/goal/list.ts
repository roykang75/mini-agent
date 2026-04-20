/**
 * Goal directory scan + slug-based lookup (ADR-010 P1).
 *
 * UI 가 agent-memory/goals/ 아래의 모든 *.md 를 열거하고 slug 로 조회한다.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { loadGoal, type LoadedGoal } from "./io";

const GOALS_SUBDIR = "goals";

export interface GoalsDirContext {
  /** agent-memory root. env AGENT_MEMORY_DIR 기본값. */
  agentMemoryDir: string;
}

export function getGoalsDir(ctx?: Partial<GoalsDirContext>): string {
  const root =
    ctx?.agentMemoryDir ??
    process.env.AGENT_MEMORY_DIR ??
    "/Users/roy/Workspace/agent/agent-memory";
  return join(root, GOALS_SUBDIR);
}

export async function listGoals(ctx?: Partial<GoalsDirContext>): Promise<LoadedGoal[]> {
  const dir = getGoalsDir(ctx);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const mdFiles = entries.filter((f) => f.endsWith(".md"));
  const loaded: LoadedGoal[] = [];
  for (const name of mdFiles) {
    try {
      loaded.push(await loadGoal(join(dir, name)));
    } catch {
      // Schema 검증 실패 파일은 UI 에서 제외 — 전체 리스트는 깨지지 않는다.
      continue;
    }
  }
  // Recent first — last_updated 기준, null 은 끝으로.
  loaded.sort((a, b) => {
    const al = a.frontmatter.progress.last_updated ?? "";
    const bl = b.frontmatter.progress.last_updated ?? "";
    return bl.localeCompare(al);
  });
  return loaded;
}

export async function loadGoalBySlug(
  slug: string,
  ctx?: Partial<GoalsDirContext>,
): Promise<LoadedGoal | null> {
  const goals = await listGoals(ctx);
  return goals.find((g) => g.frontmatter.slug === slug) ?? null;
}

export function summarizeBudget(goal: LoadedGoal): {
  iterations: string;
  wall: string;
  usd: string;
} {
  const b = goal.frontmatter.budget;
  const p = goal.frontmatter.progress;
  const elapsedMin = p.started_at
    ? (Date.now() - new Date(p.started_at).getTime()) / 60_000
    : 0;
  return {
    iterations: `${p.iterations} / ${b.max_iterations}`,
    wall: `${elapsedMin.toFixed(1)}m / ${b.wall_time_minutes}m`,
    usd: `$${p.usd_spent.toFixed(2)} / $${b.max_usd.toFixed(2)}`,
  };
}
