/**
 * Auto-recall middleware (Phase 8 T8.8).
 *
 * On new-session start (or after an idle gap), search the agent-memory
 * episodes for context relevant to the user's first message and return a
 * short hidden block to be appended to the SOUL system prompt. The goal is
 * that past sessions inform the current turn without requiring the LLM to
 * explicitly call `memory_search` every time.
 */

import { searchEpisodes, type SearchHit } from "./search";

const DEFAULT_IDLE_MIN = Number(process.env.MEMORY_IDLE_MINUTES ?? 5);
const DEFAULT_LIMIT = 3;
const lastActivity = new Map<string, number>();

export interface RecallResult {
  prompt: string;
  hits: SearchHit[];
}

export interface RecallOptions {
  limit?: number;
  idleMinutes?: number;
}

/**
 * Decide whether enough idle time has elapsed since the last activity for this
 * sid to warrant re-injecting recall context. Updates the activity clock as a
 * side effect (so consecutive turns within the idle window don't re-recall).
 */
export function shouldRecall(sid: string, idleMinutes = DEFAULT_IDLE_MIN): boolean {
  const now = Date.now();
  const last = lastActivity.get(sid);
  lastActivity.set(sid, now);
  if (last === undefined) return true;
  return now - last >= idleMinutes * 60_000;
}

/**
 * Build the recall context block. Returns both the composed markdown string
 * (empty if no hits) and the underlying SearchHit[] so the caller can emit
 * an agent event with the matched episode ids.
 */
export async function composeRecall(
  memoryDir: string,
  query: string,
  opts: RecallOptions = {},
): Promise<RecallResult> {
  const hits = await searchEpisodes(memoryDir, {
    query,
    limit: opts.limit ?? DEFAULT_LIMIT,
  });
  if (hits.length === 0) return { prompt: "", hits: [] };

  const lines: string[] = [
    "",
    "<agent_memory_recall>",
    "아래는 이 요청과 연관된 과거 세션 기억 요약이다. 참고하되 꼭 일치시키지 않아도 된다. 내용이 현재 요청과 맞지 않으면 무시해도 좋다.",
    "",
  ];
  hits.forEach((h, i) => {
    lines.push(
      `[${i + 1}] id=${h.episode.id}  persona=${h.episode.persona}  outcome=${h.episode.outcome}`,
    );
    lines.push(`    title: ${h.episode.title}`);
    lines.push(`    started: ${h.episode.started}`);
    if (h.episode.topic_tags.length > 0) {
      lines.push(`    tags: ${h.episode.topic_tags.join(", ")}`);
    }
    if (h.episode.bodyExcerpt) {
      lines.push(`    excerpt: ${h.episode.bodyExcerpt.replace(/\s+/g, " ").slice(0, 240)}`);
    }
    lines.push("");
  });
  lines.push("</agent_memory_recall>");

  return { prompt: lines.join("\n"), hits };
}

/** For tests: reset the in-process idle clock. */
export function resetRecallClock(sid?: string): void {
  if (sid) lastActivity.delete(sid);
  else lastActivity.clear();
}
