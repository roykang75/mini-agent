#!/usr/bin/env tsx
/**
 * Dry-run — M1 cascade-filter 를 실 agent_memory/episodes 에 적용해 catch
 * rate / false positive 영역 측정. 디스크 변경 없음.
 *
 * Usage:
 *   AGENT_MEMORY_DIR=/Users/roy/Workspace/agent/agent-memory \
 *     npx tsx scripts/dryrun-cascade-filter-real.ts [keyword]
 *
 * keyword 기본값 = "푸른 안개" (cascade 검증 대상).
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import matter from "gray-matter";

import { classifyCascadeRisk } from "../src/lib/memory/cascade-filter";
import type { ConsolidatedEpisode } from "../src/lib/memory/consolidate";

async function main() {
  const memoryDir = process.env.AGENT_MEMORY_DIR;
  if (!memoryDir) {
    console.error("AGENT_MEMORY_DIR required");
    process.exit(2);
  }
  const keyword = process.argv[2] ?? "푸른 안개";
  const dir = join(memoryDir, "episodes");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".md"));

  const matched: { file: string; episode: ConsolidatedEpisode }[] = [];
  for (const file of files) {
    const full = join(dir, file);
    const content = await readFile(full, "utf-8");
    if (!content.includes(keyword)) continue;
    const parsed = matter(content);
    const episode: ConsolidatedEpisode = {
      id: String(parsed.data.id ?? ""),
      slug: file.replace(/\.md$/, ""),
      path: full,
      body: parsed.content,
      sourceRanges: [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      frontmatter: parsed.data as any,
    };
    matched.push({ file, episode });
  }

  console.log(`[dryrun] keyword="${keyword}" matched=${matched.length} files`);

  const counts: Record<string, number> = {
    title_marker: 0,
    rubric_wrong_solve_direct: 0,
    body_self_aware_cascade: 0,
    pass: 0,
  };
  const samples: Record<string, string[]> = {
    title_marker: [],
    rubric_wrong_solve_direct: [],
    body_self_aware_cascade: [],
  };
  for (const m of matched) {
    const decision = classifyCascadeRisk(m.episode);
    if (!decision.skip) {
      counts.pass++;
    } else {
      const r = decision.reason!;
      counts[r] = (counts[r] ?? 0) + 1;
      if (samples[r].length < 3) {
        samples[r].push(m.file.replace(/\.md$/, "").slice(0, 80));
      }
    }
  }

  console.log("\n[breakdown]");
  for (const r of ["title_marker", "rubric_wrong_solve_direct", "body_self_aware_cascade", "pass"]) {
    const c = counts[r] ?? 0;
    console.log(`  ${r.padEnd(28)}  ${c}`);
  }

  console.log("\n[samples — first 3 per skip reason]");
  for (const r of ["title_marker", "rubric_wrong_solve_direct", "body_self_aware_cascade"]) {
    if (samples[r].length === 0) continue;
    console.log(`  ${r}:`);
    for (const s of samples[r]) console.log(`    - ${s}`);
  }

  const skipped = matched.length - counts.pass;
  const skipRate = matched.length === 0 ? 0 : (skipped / matched.length) * 100;
  console.log(`\n[summary] total=${matched.length} skipped=${skipped} (${skipRate.toFixed(1)}%) pass=${counts.pass}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
