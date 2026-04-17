#!/usr/bin/env tsx
/**
 * CLI: re-consolidate a raw session.
 *
 *   tsx scripts/reconsolidate.ts <raw-jsonl-path>
 *
 * Runs consolidation again (picking up any new prompts/consolidate-v1.md,
 * CONSOLIDATE_MODEL override, etc.) then marks any previous episodes of the
 * same session that don't match the new set with `superseded_by: <new_id>`.
 *
 * Rules honored (RULES.md):
 *   E7  — no deletion. Old episode files stay on disk; only frontmatter
 *         gains `superseded_by`.
 *   E8  — superseded_by is set-once. Episodes already superseded are skipped.
 *
 * Requires AGENT_MEMORY_DIR.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import matter from "gray-matter";

try {
  (process as unknown as { loadEnvFile?: (p?: string) => void }).loadEnvFile?.(".env.local");
} catch {
  /* optional */
}

import { consolidate } from "../src/lib/memory/consolidate";
import type { RawEvent } from "../src/lib/memory/raw";

interface ExistingEpisode {
  path: string;
  id: string;
  frontmatter: Record<string, unknown>;
  body: string;
  superseded: boolean;
}

async function loadExistingEpisodes(epDir: string, sessionId: string): Promise<ExistingEpisode[]> {
  const files = await readdir(epDir).catch(() => [] as string[]);
  const out: ExistingEpisode[] = [];
  for (const f of files) {
    if (!f.endsWith(".md")) continue;
    const p = join(epDir, f);
    const raw = await readFile(p, "utf-8");
    const parsed = matter(raw);
    const data = parsed.data as Record<string, unknown>;
    if (data.session_id !== sessionId) continue;
    out.push({
      path: p,
      id: String(data.id ?? ""),
      frontmatter: data,
      body: parsed.content,
      superseded: Boolean(data.superseded_by),
    });
  }
  return out;
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error("usage: tsx scripts/reconsolidate.ts <raw-jsonl-path>");
    process.exit(2);
  }
  const rawPath = resolve(arg);
  const memoryDir = process.env.AGENT_MEMORY_DIR;
  if (!memoryDir) {
    console.error("error: AGENT_MEMORY_DIR is required");
    process.exit(2);
  }

  const rawText = await readFile(rawPath, "utf-8");
  const firstLine = rawText.split("\n").find((l) => l.trim().length > 0);
  if (!firstLine) {
    console.error("error: raw file is empty");
    process.exit(1);
  }
  const firstEvent = JSON.parse(firstLine) as RawEvent;
  const sessionId = firstEvent.session_id;
  console.log(`[reconsolidate] session_id=${sessionId} raw=${rawPath}`);

  const epDir = join(memoryDir, "episodes");
  const existingBefore = await loadExistingEpisodes(epDir, sessionId);
  console.log(
    `[reconsolidate] existing: ${existingBefore.length} (${existingBefore.filter((e) => e.superseded).length} already superseded)`,
  );

  const started = Date.now();
  const result = await consolidate({ rawPath, memoryDir });
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`[reconsolidate] new: ${result.episodes.length} episode(s) in ${elapsed}s${result.usedFallback ? " (fallback)" : ""}`);
  for (const ep of result.episodes) {
    console.log(`  ${ep.id}  ${ep.frontmatter.outcome.padEnd(8)}  ${ep.frontmatter.title.slice(0, 60)}`);
  }

  const newIds = new Set(result.episodes.map((e) => e.id));
  const firstNewId = result.episodes[0]?.id;
  if (!firstNewId) {
    console.error("error: consolidation produced no episodes (should never happen — heuristic fallback always yields >=1)");
    process.exit(1);
  }

  let supersededCount = 0;
  for (const old of existingBefore) {
    if (old.superseded) continue;          // E8 set-once
    if (newIds.has(old.id)) continue;      // same hash = unchanged, no supersede
    old.frontmatter.superseded_by = firstNewId;
    old.frontmatter.superseded_at = new Date().toISOString();
    const rewritten = matter.stringify(old.body, old.frontmatter).trimEnd() + "\n";
    await writeFile(old.path, rewritten, "utf-8");
    supersededCount++;
    console.log(`  superseded ${old.id} → ${firstNewId}  (${old.path.split("/").slice(-1)[0]})`);
  }
  console.log(`[reconsolidate] marked ${supersededCount} old episode(s) as superseded`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
