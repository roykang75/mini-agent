/**
 * Recent sessions search for <my_recent_sessions> recall block (ADR-007).
 *
 * v2+ episodes 만 후보 — consolidation.prompt_version ≥ v2 인 파일.
 * L3 관찰 섹션 본문을 발췌해 hit 에 포함. searchEpisodes 와 별도 — query 기반
 * 스코어링은 동일한 token 매칭이지만 cell_id 필드도 매칭 가중.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import matter from "gray-matter";

export interface RecentSessionHit {
  episode_id: string;
  session_id: string;
  started: string;
  persona: string;
  cell_ids: string[];
  l3_section_excerpt: string;
  score: number;
}

export interface RecentSessionsOptions {
  limit?: number;
}

const MAX_EXCERPT = 400;

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[\s,.;:()\[\]{}<>"']+/)
    .filter((t) => t.length >= 2);
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

function extractL3Section(body: string): string {
  const marker = "## L3 관찰";
  const idx = body.indexOf(marker);
  if (idx === -1) return "";
  const rest = body.slice(idx);
  const nextHeading = rest.slice(marker.length).search(/\n## [^#]/);
  const section = nextHeading === -1 ? rest : rest.slice(0, marker.length + nextHeading);
  return section.trim();
}

/**
 * Search v2+ episodes by query tokens. Only episodes with prompt_version === "v2"
 * are candidates (v1 episodes lack L3 section). `model` reserved for future
 * model-based filtering — currently unused (one memory dir == one agent identity).
 */
export async function searchRecentSessions(
  memoryDir: string,
  _model: string,
  query: string,
  opts: RecentSessionsOptions = {},
): Promise<RecentSessionHit[]> {
  const dir = join(memoryDir, "episodes");
  const files = await readdir(dir).catch(() => [] as string[]);
  const mdFiles = files.filter((f) => f.endsWith(".md"));

  const tokens = tokenize(query);
  if (tokens.length === 0) return [];

  const hits: RecentSessionHit[] = [];
  for (const f of mdFiles) {
    const fullPath = join(dir, f);
    const raw = await readFile(fullPath, "utf-8").catch(() => null);
    if (raw === null) continue;
    const parsed = matter(raw);
    const fm = parsed.data as Record<string, unknown>;
    if (fm.superseded_by) continue;

    const promptVersion =
      ((fm.consolidation ?? {}) as Record<string, unknown>).prompt_version;
    if (promptVersion !== "v2") continue;

    const l3obs = Array.isArray(fm.l3_observations)
      ? (fm.l3_observations as Array<Record<string, unknown>>)
      : [];
    const cell_ids = l3obs
      .map((o) => String(o.cell_id ?? ""))
      .filter((s) => s.length > 0);

    const l3Section = extractL3Section(parsed.content);
    if (l3Section.length === 0 && cell_ids.length === 0) continue;

    const title = String(fm.title ?? "").toLowerCase();
    const tagsArr = Array.isArray(fm.topic_tags)
      ? (fm.topic_tags as unknown[]).map(String)
      : [];
    const tags = tagsArr.join(" ").toLowerCase();
    const cells = cell_ids.join(" ").toLowerCase();
    const bodyLower = l3Section.toLowerCase();

    let score = 0;
    for (const t of tokens) {
      score += countOccurrences(title, t) * 3;
      score += countOccurrences(tags, t) * 2;
      score += countOccurrences(cells, t) * 3;
      score += countOccurrences(bodyLower, t) * 1;
    }
    if (score === 0) continue;

    hits.push({
      episode_id: String(fm.id ?? f),
      session_id: String(fm.session_id ?? ""),
      started: String(fm.started ?? ""),
      persona: String(fm.persona ?? ""),
      cell_ids,
      l3_section_excerpt: l3Section.slice(0, MAX_EXCERPT),
      score,
    });
  }

  hits.sort((a, b) => b.score - a.score || b.started.localeCompare(a.started));
  return hits.slice(0, opts.limit ?? 3);
}
