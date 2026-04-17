/**
 * Episode search over `$AGENT_MEMORY_DIR/episodes/*.md` (Phase 8 T8.7 M1).
 *
 * Pure filesystem scan + token-based scoring. No sqlite / FTS yet (T8.6).
 * Serves the auto-recall middleware (T8.8) and the `memory_search` skill.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import matter from "gray-matter";

export type EpisodeOutcome = "resolved" | "open" | "failed";

export interface EpisodeRecord {
  id: string;
  title: string;
  session_id: string;
  started: string;
  ended: string;
  outcome: EpisodeOutcome;
  persona: string;
  topic_tags: string[];
  path: string;
  bodyExcerpt: string;
}

export interface SearchOptions {
  query: string;
  limit?: number;
  outcome?: EpisodeOutcome;
  persona?: string;
}

export interface SearchHit {
  episode: EpisodeRecord;
  score: number;
  matchedTokens: string[];
}

export async function searchEpisodes(
  memoryDir: string,
  opts: SearchOptions,
): Promise<SearchHit[]> {
  const dir = join(memoryDir, "episodes");
  const files = await readdir(dir).catch(() => [] as string[]);
  const mdFiles = files.filter((f) => f.endsWith(".md"));

  const tokens = tokenize(opts.query);
  if (tokens.length === 0) return [];

  const hits: SearchHit[] = [];
  for (const f of mdFiles) {
    const fullPath = join(dir, f);
    const raw = await readFile(fullPath, "utf-8").catch(() => null);
    if (raw === null) continue;
    const parsed = matter(raw);
    const fm = parsed.data as Record<string, unknown>;

    if (opts.outcome && fm.outcome !== opts.outcome) continue;
    if (opts.persona && fm.persona !== opts.persona) continue;
    if (fm.superseded_by) continue;

    const title = String(fm.title ?? "").toLowerCase();
    const body = parsed.content.toLowerCase();
    const tagsArr = Array.isArray(fm.topic_tags) ? (fm.topic_tags as unknown[]).map(String) : [];
    const tags = tagsArr.join(" ").toLowerCase();

    let score = 0;
    const matched: string[] = [];
    for (const t of tokens) {
      const lt = t.toLowerCase();
      const titleHits = countOccurrences(title, lt);
      const tagHits = countOccurrences(tags, lt);
      const bodyHits = countOccurrences(body, lt);
      const tokScore = titleHits * 3 + tagHits * 2 + bodyHits;
      if (tokScore > 0) {
        score += tokScore;
        matched.push(t);
      }
    }
    if (score === 0) continue;

    const excerpt =
      parsed.content
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.length > 10 && !l.startsWith("#")) ?? "";

    hits.push({
      episode: {
        id: String(fm.id ?? ""),
        title: String(fm.title ?? ""),
        session_id: String(fm.session_id ?? ""),
        started: toIsoStr(fm.started),
        ended: toIsoStr(fm.ended),
        outcome: (fm.outcome as EpisodeOutcome) ?? "open",
        persona: String(fm.persona ?? ""),
        topic_tags: tagsArr,
        path: fullPath,
        bodyExcerpt: excerpt.slice(0, 240),
      },
      score,
      matchedTokens: matched,
    });
  }

  hits.sort(
    (a, b) =>
      b.score - a.score ||
      b.episode.started.localeCompare(a.episode.started),
  );
  const limit = Math.max(1, opts.limit ?? 3);
  return hits.slice(0, limit);
}

function tokenize(q: string): string[] {
  return q
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let i = 0;
  while ((i = haystack.indexOf(needle, i)) >= 0) {
    n++;
    i += needle.length;
  }
  return n;
}

function toIsoStr(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  return String(v ?? "");
}
