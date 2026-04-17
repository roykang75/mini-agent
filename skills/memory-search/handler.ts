import { searchEpisodes } from "../../src/lib/memory/search";
import type { EpisodeOutcome } from "../../src/lib/memory/search";

export interface MemorySearchInput {
  query: string;
  limit?: number;
  outcome?: EpisodeOutcome;
  persona?: string;
}

export async function execute(args: MemorySearchInput): Promise<string> {
  const memoryDir = process.env.AGENT_MEMORY_DIR;
  if (!memoryDir) {
    return JSON.stringify({
      error: "agent_memory_unconfigured",
      message: "AGENT_MEMORY_DIR env var is not set on the server",
    });
  }

  if (typeof args?.query !== "string" || args.query.trim().length === 0) {
    return JSON.stringify({ error: "invalid_query", message: "query must be a non-empty string" });
  }

  const limit = Math.min(Math.max(args.limit ?? 3, 1), 10);
  const hits = await searchEpisodes(memoryDir, {
    query: args.query,
    limit,
    outcome: args.outcome,
    persona: args.persona,
  });

  return JSON.stringify({
    query: args.query,
    count: hits.length,
    results: hits.map((h) => ({
      id: h.episode.id,
      title: h.episode.title,
      session_id: h.episode.session_id,
      persona: h.episode.persona,
      outcome: h.episode.outcome,
      started: h.episode.started,
      topic_tags: h.episode.topic_tags,
      score: h.score,
      matched: h.matchedTokens,
      excerpt: h.episode.bodyExcerpt,
      path: h.episode.path,
    })),
  });
}
