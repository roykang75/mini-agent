#!/usr/bin/env tsx
/**
 * post-goal-hook — goal 종료 후 최근 N 개 episode 에 grade-real-session 실행.
 *
 *   tsx scripts/post-goal-hook.ts <goalPath>
 *
 * Required env:
 *   - AGENT_MEMORY_DIR
 *   - CURRICULUM_DIR
 *   - ANTHROPIC_API_KEY (gradeRealSession 내부가 Opus 호출)
 *
 * Optional env:
 *   - POST_GOAL_HOOK_WAIT_MS — consolidate 완료 대기 시간 (default 30000ms).
 *     auto-consolidate 가 돌고 있으면 30s 안에 episode 가 생길 확률이 높다.
 *     실패해도 이미 존재하는 가장 최근 episode 를 grade.
 *   - POST_GOAL_HOOK_N — grade 할 최근 episode 개수 (default 3).
 *
 * Idempotency:
 *   이미 `observations/<episodeId>-<shortHash>.md` 가 존재하면 skip.
 *   goal.md 자체에 대한 직접 연결은 없음 — 시간-window 기반 근사.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join, basename } from "node:path";

try {
  (process as unknown as { loadEnvFile?: (p?: string) => void }).loadEnvFile?.(".env.local");
} catch {
  // no-op
}

const WAIT_MS = Number(process.env.POST_GOAL_HOOK_WAIT_MS ?? 30000);
const RECENT_N = Number(process.env.POST_GOAL_HOOK_N ?? 3);

interface EpisodeMeta {
  path: string;
  id: string;
  started: string;
  rawPath: string | null;
}

async function parseEpisodeMeta(path: string): Promise<EpisodeMeta | null> {
  const text = await readFile(path, "utf-8").catch(() => null);
  if (!text) return null;
  const match = text.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return null;
  const fmText = match[1];
  const idMatch = fmText.match(/^id:\s*(\S+)/m);
  const startedMatch = fmText.match(/^started:\s*(\S+)/m);
  // sources 는 YAML 두 형태 모두 처리:
  //   (a) flow:   sources: [raw/.../0001.jsonl#L1-N]
  //   (b) block:  sources:\n  - raw/.../0001.jsonl#L1-N
  const sourcesFlow = fmText.match(/^sources:\s*\[\s*(.+?)\s*\]/m);
  const sourcesBlock = fmText.match(/^sources:\s*\n((?:\s*-\s*.+\n?)+)/m);
  let first: string | null = null;
  if (sourcesFlow) {
    first = sourcesFlow[1].split(",")[0].trim();
  } else if (sourcesBlock) {
    const line = sourcesBlock[1].split("\n")[0] ?? "";
    first = line.replace(/^\s*-\s*/, "").trim();
  }
  let rawPath: string | null = null;
  if (first) {
    rawPath = first.replace(/^["']|["']$/g, "").split("#")[0];
  }
  if (!idMatch || !startedMatch) return null;
  return {
    path,
    id: idMatch[1],
    started: startedMatch[1].replace(/^["']|["']$/g, ""),
    rawPath,
  };
}

async function listRecentEpisodes(memoryDir: string, n: number): Promise<EpisodeMeta[]> {
  const epDir = join(memoryDir, "episodes");
  const names = await readdir(epDir).catch(() => [] as string[]);
  const metas: EpisodeMeta[] = [];
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    const p = join(epDir, name);
    const meta = await parseEpisodeMeta(p);
    if (meta) metas.push(meta);
  }
  // sort by file mtime desc as proxy for "most recent" — started field may be
  // older than mtime if consolidate re-wrote.
  const withStat = await Promise.all(
    metas.map(async (m) => ({ meta: m, mtime: (await stat(m.path)).mtimeMs })),
  );
  withStat.sort((a, b) => b.mtime - a.mtime);
  return withStat.slice(0, n).map((w) => w.meta);
}

async function hasObservation(curriculumDir: string, episodeId: string): Promise<boolean> {
  const obsDir = join(curriculumDir, "observations");
  const names = await readdir(obsDir).catch(() => [] as string[]);
  return names.some((n) => n.includes(episodeId));
}

async function main() {
  const goalPath = process.argv[2];
  if (!goalPath) {
    console.error("usage: tsx scripts/post-goal-hook.ts <goalPath>");
    process.exit(2);
  }
  const memoryDir = process.env.AGENT_MEMORY_DIR;
  const curriculumDir = process.env.CURRICULUM_DIR;
  if (!memoryDir || !curriculumDir) {
    console.error("error: AGENT_MEMORY_DIR and CURRICULUM_DIR are required");
    process.exit(2);
  }

  console.log(`[post-goal-hook] goal=${basename(goalPath)}  wait=${WAIT_MS}ms  n=${RECENT_N}`);
  await new Promise((r) => setTimeout(r, WAIT_MS));

  const episodes = await listRecentEpisodes(memoryDir, RECENT_N);
  if (episodes.length === 0) {
    console.log(`[post-goal-hook] no episodes found — auto-consolidate 미실행 가능성.`);
    return;
  }

  const { gradeRealSession } = await import("./grade-real-session");

  let graded = 0;
  let skipped = 0;
  for (const ep of episodes) {
    if (!ep.rawPath) {
      console.warn(`[post-goal-hook] skip ${ep.id} — sources 비어있음`);
      skipped++;
      continue;
    }
    if (await hasObservation(curriculumDir, ep.id)) {
      console.log(`[post-goal-hook] skip ${ep.id} — observation 이미 존재`);
      skipped++;
      continue;
    }
    try {
      const rawAbs = ep.rawPath.startsWith("/") ? ep.rawPath : join(memoryDir, ep.rawPath);
      await gradeRealSession({
        memoryDir,
        curriculumDir,
        episodePath: ep.path,
        rawPath: rawAbs,
      });
      graded++;
      console.log(`[post-goal-hook] graded ${ep.id}`);
    } catch (e) {
      console.error(`[post-goal-hook] grade failed for ${ep.id}: ${(e as Error).message}`);
    }
  }

  console.log(`[post-goal-hook] done — graded=${graded} skipped=${skipped}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
