#!/usr/bin/env tsx
/**
 * Validate every episode under `$AGENT_MEMORY_DIR/episodes/` against RULES.md
 * E1~E8. Exits 1 on any violation.
 *
 *   tsx scripts/validate-episodes.ts
 *
 *   --memory-dir <dir>   override AGENT_MEMORY_DIR
 *   --strict-id          also verify id = sha256(session|ranges|prompt|model)
 *                        (skipped by default because model suffix can include
 *                        "+heuristic" appended by the consolidation worker)
 */

import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import matter from "gray-matter";

try {
  (process as unknown as { loadEnvFile?: (p?: string) => void }).loadEnvFile?.(".env.local");
} catch {
  /* optional */
}

interface EpisodeFile {
  path: string;
  frontmatter: Record<string, unknown>;
  body: string;
}

interface SourceRange {
  path: string;
  start: number;
  end: number;
}

interface Violation {
  episode: string;
  rule: string;
  message: string;
}

function parseSourceRef(ref: string): SourceRange | null {
  const m = ref.match(/^(.+?)#L(\d+)-(\d+)$/);
  if (!m) return null;
  const start = parseInt(m[2]!, 10);
  const end = parseInt(m[3]!, 10);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end < start) return null;
  return { path: m[1]!, start, end };
}

async function countLines(path: string): Promise<number> {
  const text = await readFile(path, "utf-8").catch(() => null);
  if (text === null) return -1;
  return text.split("\n").filter((l) => l.length > 0).length;
}

async function loadEpisodes(dir: string): Promise<EpisodeFile[]> {
  const files = await readdir(dir).catch(() => [] as string[]);
  const out: EpisodeFile[] = [];
  for (const f of files) {
    if (!f.endsWith(".md")) continue;
    const p = join(dir, f);
    const raw = await readFile(p, "utf-8");
    const parsed = matter(raw);
    out.push({ path: p, frontmatter: parsed.data as Record<string, unknown>, body: parsed.content });
  }
  return out;
}

const REQUIRED_FIELDS = [
  "id",
  "session_id",
  "title",
  "topic_tags",
  "started",
  "ended",
  "sources",
  "participants",
  "persona",
  "boundary_reason",
  "consolidation",
  "outcome",
];

function validateFields(ep: EpisodeFile, v: Violation[]): void {
  const fm = ep.frontmatter;
  for (const k of REQUIRED_FIELDS) {
    if (!(k in fm) || fm[k] === null || fm[k] === undefined || fm[k] === "") {
      v.push({ episode: ep.path, rule: "E1", message: `missing frontmatter field: ${k}` });
    }
  }
  if (!("boundary_reason" in fm) || typeof fm.boundary_reason !== "string" || String(fm.boundary_reason).trim().length === 0) {
    v.push({ episode: ep.path, rule: "E6", message: `boundary_reason must be a non-empty string` });
  }
  const cons = fm.consolidation as { model?: unknown; prompt_version?: unknown; at?: unknown } | undefined;
  if (!cons || typeof cons.model !== "string" || typeof cons.prompt_version !== "string" || !cons.at) {
    v.push({ episode: ep.path, rule: "E1", message: `consolidation.{model, prompt_version, at} incomplete` });
  }
  const outcome = fm.outcome as string;
  if (!["resolved", "open", "failed"].includes(outcome)) {
    v.push({ episode: ep.path, rule: "E1", message: `outcome must be one of resolved/open/failed, got ${outcome}` });
  }
}

function recomputeId(ep: EpisodeFile): string | undefined {
  const fm = ep.frontmatter;
  const sources = Array.isArray(fm.sources) ? (fm.sources as string[]) : [];
  const ranges = sources.map(parseSourceRef).filter((r): r is SourceRange => r !== null);
  if (ranges.length === 0) return undefined;
  const rangeKey = ranges
    .slice()
    .sort((a, b) => a.start - b.start)
    .map((r) => `${r.start}-${r.end}`)
    .join(",");
  const cons = fm.consolidation as { model?: string; prompt_version?: string };
  if (!cons?.model || !cons?.prompt_version) return undefined;
  return createHash("sha256")
    .update(`${fm.session_id}|${rangeKey}|${cons.prompt_version}|${cons.model}`)
    .digest("hex")
    .slice(0, 16);
}

async function validateSourceRanges(
  ep: EpisodeFile,
  memoryDir: string,
  lineCache: Map<string, number>,
  v: Violation[],
): Promise<SourceRange[]> {
  const sources = Array.isArray(ep.frontmatter.sources) ? (ep.frontmatter.sources as string[]) : [];
  const ranges: SourceRange[] = [];
  for (const s of sources) {
    const r = parseSourceRef(s);
    if (!r) {
      v.push({ episode: ep.path, rule: "E3", message: `malformed source ref: ${s}` });
      continue;
    }
    let lines = lineCache.get(r.path);
    if (lines === undefined) {
      const full = join(memoryDir, r.path);
      const st = await stat(full).catch(() => null);
      if (!st) {
        v.push({ episode: ep.path, rule: "E3", message: `source file missing: ${r.path}` });
        continue;
      }
      lines = await countLines(full);
      lineCache.set(r.path, lines);
    }
    if (r.end > lines) {
      v.push({
        episode: ep.path,
        rule: "E3",
        message: `range ${r.start}-${r.end} exceeds file length ${lines} for ${r.path}`,
      });
    }
    ranges.push(r);
  }
  return ranges;
}

function validateSessionCoverage(
  sessionId: string,
  episodes: { ep: EpisodeFile; ranges: SourceRange[] }[],
  lineCache: Map<string, number>,
  v: Violation[],
): void {
  const active = episodes.filter(({ ep }) => !ep.frontmatter.superseded_by);
  if (active.length < 1 || active.length > 5) {
    v.push({
      episode: `session:${sessionId}`,
      rule: "E5",
      message: `active episode count out of 1..5: ${active.length}`,
    });
  }
  // Expect all ranges to reference the same raw file (per-session coverage rule).
  const rawFiles = new Set(active.flatMap(({ ranges }) => ranges.map((r) => r.path)));
  for (const rf of rawFiles) {
    const totalLines = lineCache.get(rf);
    if (totalLines === undefined || totalLines < 0) continue;
    const flat = active
      .flatMap(({ ranges }) => ranges.filter((r) => r.path === rf))
      .slice()
      .sort((a, b) => a.start - b.start);
    let cursor = 0;
    for (const r of flat) {
      if (r.start !== cursor + 1) {
        v.push({
          episode: `session:${sessionId}:${rf}`,
          rule: "E4",
          message: `gap or overlap: expected start ${cursor + 1}, got ${r.start}`,
        });
        return;
      }
      cursor = r.end;
    }
    if (cursor !== totalLines) {
      v.push({
        episode: `session:${sessionId}:${rf}`,
        rule: "E4",
        message: `coverage ends at ${cursor}, expected ${totalLines}`,
      });
    }
  }
}

function validateSupersedeChains(episodes: EpisodeFile[], v: Violation[]): void {
  const byId = new Map<string, EpisodeFile>();
  for (const ep of episodes) {
    const id = String(ep.frontmatter.id ?? "");
    if (id) byId.set(id, ep);
  }
  for (const ep of episodes) {
    const sby = ep.frontmatter.superseded_by;
    if (!sby) continue;
    if (typeof sby !== "string") {
      v.push({ episode: ep.path, rule: "E8", message: `superseded_by must be a string, got ${typeof sby}` });
      continue;
    }
    if (!byId.has(sby)) {
      v.push({ episode: ep.path, rule: "E7", message: `superseded_by points to unknown id: ${sby}` });
    }
  }
}

async function main() {
  const argv = process.argv.slice(2);
  let memoryDir = process.env.AGENT_MEMORY_DIR;
  let strictId = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--memory-dir") memoryDir = argv[++i];
    else if (argv[i] === "--strict-id") strictId = true;
  }
  if (!memoryDir) {
    console.error("error: --memory-dir or AGENT_MEMORY_DIR is required");
    process.exit(2);
  }
  memoryDir = resolve(memoryDir);

  const episodes = await loadEpisodes(join(memoryDir, "episodes"));
  console.log(`[validate] ${episodes.length} episode(s) under ${memoryDir}/episodes`);

  const violations: Violation[] = [];
  const lineCache = new Map<string, number>();
  const withRanges: { ep: EpisodeFile; ranges: SourceRange[] }[] = [];

  for (const ep of episodes) {
    validateFields(ep, violations);
    const ranges = await validateSourceRanges(ep, memoryDir, lineCache, violations);
    withRanges.push({ ep, ranges });

    if (strictId) {
      const expected = recomputeId(ep);
      const actual = String(ep.frontmatter.id ?? "");
      if (expected && expected !== actual) {
        violations.push({
          episode: ep.path,
          rule: "E2",
          message: `id mismatch: expected ${expected}, got ${actual}`,
        });
      }
    }
  }

  // group by session_id for E4 / E5
  const bySession = new Map<string, { ep: EpisodeFile; ranges: SourceRange[] }[]>();
  for (const e of withRanges) {
    const sid = String(e.ep.frontmatter.session_id ?? "");
    if (!sid) continue;
    const arr = bySession.get(sid) ?? [];
    arr.push(e);
    bySession.set(sid, arr);
  }
  for (const [sid, arr] of bySession) {
    validateSessionCoverage(sid, arr, lineCache, violations);
  }

  validateSupersedeChains(episodes, violations);

  if (violations.length === 0) {
    console.log(`[ok] all ${episodes.length} episode(s) pass E1/E3/E4/E5/E6/E7/E8${strictId ? "/E2" : ""}`);
    process.exit(0);
  }

  console.error(`[FAIL] ${violations.length} violation(s):`);
  for (const v of violations) {
    console.error(`  [${v.rule}] ${v.episode}`);
    console.error(`         ${v.message}`);
  }
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
