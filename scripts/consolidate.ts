#!/usr/bin/env tsx
/**
 * CLI: consolidate a single raw JSONL into episodes.
 *
 *   tsx scripts/consolidate.ts <raw-jsonl-path>
 *
 * Requires AGENT_MEMORY_DIR. Writes episodes under $AGENT_MEMORY_DIR/episodes/.
 */

import { resolve } from "node:path";

// Load .env.local for standalone CLI invocation (Next.js loads it automatically
// inside the dev server, but tsx does not). Safe no-op if the file is absent.
try {
  (process as unknown as { loadEnvFile?: (p?: string) => void }).loadEnvFile?.(".env.local");
} catch {
  // file missing or unreadable — fall through; the consolidate call will error
  // clearly if a required key is unset.
}

import { consolidate } from "../src/lib/memory/consolidate";

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error("usage: tsx scripts/consolidate.ts <raw-jsonl-path>");
    process.exit(2);
  }
  const rawPath = resolve(arg);
  const memoryDir = process.env.AGENT_MEMORY_DIR;
  if (!memoryDir) {
    console.error("error: AGENT_MEMORY_DIR is required");
    process.exit(2);
  }

  console.log(`[consolidate] raw=${rawPath}`);
  console.log(`[consolidate] memory_dir=${memoryDir}`);

  const started = Date.now();
  const result = await consolidate({ rawPath, memoryDir });
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  console.log(`\n[consolidate] done in ${elapsed}s — ${result.episodes.length} episode(s)`);
  if (result.usedFallback) {
    console.warn(`[consolidate] ⚠ fallback used: ${result.fallbackReason}`);
  }
  for (const ep of result.episodes) {
    console.log(`  ${ep.id}  ${ep.frontmatter.outcome.padEnd(8)}  ${ep.path}`);
    console.log(`    title: ${ep.frontmatter.title}`);
    console.log(`    boundary: ${ep.frontmatter.boundary_reason.slice(0, 120)}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
