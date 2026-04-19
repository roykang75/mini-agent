/**
 * ADR-006-v2 Phase 2 — cell-query similarity scoring.
 *
 * Query 에 대해 profile cells 중 유사한 top-K 를 선택한다. `curriculum.ts`
 * 의 token scoring 과 동일 원칙 (lesson/tag 우대) 을 적용하되, cell 은
 * lesson 대신 `short` + `domain` + `note` 를 서치 대상으로 삼는다.
 */

import type { Profile, ProfileCell } from "./load";

export interface ProfileCellHit {
  cell: ProfileCell;
  score: number;
  matchedTokens: string[];
}

export interface SearchProfileOptions {
  limit?: number;
}

export function searchProfileCells(
  profile: Profile,
  query: string,
  opts: SearchProfileOptions = {},
): ProfileCellHit[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];

  const hits: ProfileCellHit[] = [];
  for (const cell of profile.cells) {
    const shortLower = cell.short.toLowerCase();
    const domainLower = cell.domain.toLowerCase();
    const noteLower = cell.note.toLowerCase();
    const blob = `${cell.problem_id} ${cell.short} ${cell.domain} ${cell.note}`.toLowerCase();

    let score = 0;
    const matched: string[] = [];
    for (const t of tokens) {
      const lt = t.toLowerCase();
      const shortHits = countOccurrences(shortLower, lt);
      const domainHits = countOccurrences(domainLower, lt);
      const noteHits = countOccurrences(noteLower, lt);
      const bodyHits = countOccurrences(blob, lt);
      const tokScore = shortHits * 4 + domainHits * 3 + noteHits * 2 + bodyHits;
      if (tokScore > 0) {
        score += tokScore;
        matched.push(t);
      }
    }
    if (score === 0) continue;
    hits.push({ cell, score, matchedTokens: matched });
  }

  hits.sort((a, b) => b.score - a.score);
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
