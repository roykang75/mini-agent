/**
 * Consolidation worker (Phase 8 T8.3).
 *
 * Takes a single session's raw JSONL, runs signal detection, asks Sonnet to
 * emit 1~5 episode markdowns, validates the output against RULES.md (E1/E3/E4/
 * E5/E6), computes content-addressed ids, and writes the episodes. On any
 * failure falls back to a single heuristic episode so the session is never
 * completely unmemorable (prompts/consolidate-v1.md "실패 처리" section).
 *
 * Scope: single-session, offline. Auto-trigger and re-consolidation CLI are
 * separate tasks (T8.8 / T8.9). Pure data in, files out.
 */

import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname, relative } from "node:path";
import matter from "gray-matter";

import { createLLMClient } from "../llm/client";
import type { Message } from "../llm/types";
import { detectSignals, type Signal } from "./signals";
import type { RawEvent } from "./raw";

const PROMPT_VERSION = "v1";
const MODEL_ID = process.env.CONSOLIDATE_MODEL ?? "claude-sonnet-4-6";
const MAX_ATTEMPTS = 3;
const EPISODE_BOUNDARY = "---EPISODE-BOUNDARY---";

export interface ConsolidateOptions {
  rawPath: string;
  memoryDir: string;
  model?: string;
}

export interface ConsolidatedEpisode {
  id: string;
  slug: string;
  path: string;
  frontmatter: EpisodeFrontmatter;
  body: string;
  sourceRanges: SourceRange[];
}

export interface SourceRange {
  path: string;
  start: number;
  end: number;
}

interface EpisodeFrontmatter {
  id: string;
  session_id: string;
  title: string;
  topic_tags: string[];
  started: string;
  ended: string;
  sources: string[];
  participants: string[];
  persona: string;
  persona_ref: string;
  boundary_reason: string;
  consolidation: { model: string; prompt_version: string; at: string };
  outcome: "resolved" | "open" | "failed";
}

export interface ConsolidateResult {
  episodes: ConsolidatedEpisode[];
  usedFallback: boolean;
  fallbackReason?: string;
}

export async function consolidate(opts: ConsolidateOptions): Promise<ConsolidateResult> {
  const model = opts.model ?? MODEL_ID;
  const events = await loadRawEvents(opts.rawPath);
  if (events.length === 0) {
    throw new Error(`consolidate: raw file is empty — ${opts.rawPath}`);
  }

  const meta = extractMeta(events, opts.rawPath, opts.memoryDir);
  const signals = detectSignals(events);
  const totalLines = events.length;

  const promptPath = join(opts.memoryDir, "prompts", `consolidate-${PROMPT_VERSION}.md`);
  const promptRaw = await readFile(promptPath, "utf-8").catch(() => {
    throw new Error(`consolidate: prompt file not found at ${promptPath}`);
  });
  const { systemPrompt } = splitPromptSections(promptRaw);

  const userMessage = buildUserMessage(events, signals, meta);

  // Try LLM path up to MAX_ATTEMPTS. Any failure → heuristic fallback.
  let lastErr: string | undefined;
  const client = createLLMClient();
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const messages: Message[] = [{ role: "user", content: userMessage }];
      const res = await client.chat({
        model,
        max_tokens: 4096,
        system: systemPrompt,
        messages,
      });
      const text = collectTextBlocks(res.content);
      if (process.env.CONSOLIDATE_DEBUG) {
        console.log(`\n[consolidate-debug] attempt ${attempt} raw LLM output (${text.length} chars):\n${text.slice(0, 4000)}\n---END---`);
      }
      const parsed = parseEpisodesResponse(text);
      validateEpisodes(parsed, meta, totalLines);

      const now = new Date().toISOString();
      const enriched = parsed.map((p) => finalizeEpisode(p, meta, model, now));
      const written = await Promise.all(enriched.map((e) => writeEpisode(e, opts.memoryDir)));
      return { episodes: written, usedFallback: false };
    } catch (e) {
      lastErr = (e as Error).message;
      console.warn(`[consolidate] attempt ${attempt} failed: ${lastErr}`);
    }
  }

  const episode = heuristicEpisode(events, meta, model, lastErr ?? "unknown");
  const written = await writeEpisode(episode, opts.memoryDir);
  return {
    episodes: [written],
    usedFallback: true,
    fallbackReason: lastErr ?? "unknown",
  };
}

// ---------- raw + meta ----------

async function loadRawEvents(path: string): Promise<RawEvent[]> {
  const raw = await readFile(path, "utf-8");
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RawEvent);
}

interface SessionMeta {
  session_id: string;
  started: string;
  ended: string;
  persona: string;
  persona_ref: string;
  rawRelPath: string;
  totalLines: number;
}

function extractMeta(events: RawEvent[], rawPath: string, memoryDir: string): SessionMeta {
  const first = events[0]!;
  const last = events[events.length - 1]!;
  const withPersona = events.find((e) => e.persona) ?? first;
  const rel = relative(memoryDir, rawPath).split(/[\\/]/).join("/");
  return {
    session_id: first.session_id,
    started: first.ts,
    ended: last.ts,
    persona: withPersona.persona ?? "unknown",
    persona_ref: withPersona.persona_ref ?? "HEAD",
    rawRelPath: rel,
    totalLines: events.length,
  };
}

// ---------- prompt ----------

function splitPromptSections(prompt: string): { systemPrompt: string } {
  // Everything from the first `## System` header onward is the system prompt.
  // The user message is built programmatically from the session data, so no
  // separate "user template" is extracted from the file.
  const idx = prompt.search(/(^|\n)##\s*System\s*(\n|$)/);
  if (idx === -1) {
    throw new Error("consolidate: prompt must contain a '## System' section");
  }
  return { systemPrompt: prompt.slice(idx).trim() };
}

function buildUserMessage(
  events: RawEvent[],
  signals: Signal[],
  meta: SessionMeta,
): string {
  const rawBlock = events.map((e) => JSON.stringify(e)).join("\n");
  const signalsBlock = JSON.stringify(
    signals.map((s) => ({ type: s.reason, at_line: s.index + 1, reason: s.detail, severity: s.severity })),
    null,
    2,
  );
  const metaBlock = JSON.stringify(
    {
      session_id: meta.session_id,
      started: meta.started,
      ended: meta.ended,
      persona: meta.persona,
      persona_ref: meta.persona_ref,
      raw_path: meta.rawRelPath,
      total_lines: meta.totalLines,
    },
    null,
    2,
  );
  return `<raw_session>
${rawBlock}
</raw_session>

<signals>
${signalsBlock}
</signals>

<session_meta>
${metaBlock}
</session_meta>`;
}

// ---------- LLM output parsing ----------

function collectTextBlocks(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return (content as { type: string; text?: string }[])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text!)
    .join("\n");
}

interface ParsedEpisode {
  frontmatter: Partial<EpisodeFrontmatter>;
  body: string;
  sourceRanges: SourceRange[];
}

export function parseEpisodesResponse(text: string): ParsedEpisode[] {
  // Tolerant cleanup: strip any code-fence wrappers the LLM might add, and
  // drop everything before the first `---` line so stray prose preamble does
  // not break YAML parsing.
  let cleaned = text.trim();
  cleaned = cleaned.replace(/```(?:yaml|markdown|md)?\s*\n?/gi, "").replace(/```/g, "");
  const firstDelim = cleaned.indexOf("---");
  if (firstDelim > 0) cleaned = cleaned.slice(firstDelim);

  const pieces = cleaned
    .split(EPISODE_BOUNDARY)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const out: ParsedEpisode[] = [];
  for (const piece of pieces) {
    const fmStart = piece.indexOf("---");
    if (fmStart === -1) continue;
    const fmEnd = piece.indexOf("\n---", fmStart + 3);
    if (fmEnd === -1) continue;
    const fmBlock = piece.slice(fmStart, fmEnd + 4);
    const rest = piece.slice(fmEnd + 4).trim();
    const parsed = matter(`${fmBlock}\n${rest}\n`);
    const fm = parsed.data as Partial<EpisodeFrontmatter> & { sources?: unknown };
    // Normalize outcome synonyms the LLM sometimes invents.
    const raw = String(fm.outcome ?? "").toLowerCase();
    if (raw === "success" || raw === "succeeded" || raw === "ok") fm.outcome = "resolved";
    else if (raw === "in_progress" || raw === "pending" || raw === "unresolved") fm.outcome = "open";
    else if (raw === "error" || raw === "aborted") fm.outcome = "failed";
    const sources = Array.isArray(fm.sources) ? (fm.sources as string[]) : [];
    const ranges = sources.map(parseSourceRef).filter((r): r is SourceRange => r !== null);
    out.push({ frontmatter: fm, body: parsed.content.trim(), sourceRanges: ranges });
  }
  return out;
}

export function parseSourceRef(ref: string): SourceRange | null {
  const m = ref.match(/^(.+?)#L(\d+)-(\d+)$/);
  if (!m) return null;
  const start = parseInt(m[2]!, 10);
  const end = parseInt(m[3]!, 10);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end < start) return null;
  return { path: m[1]!, start, end };
}

// ---------- validation ----------

export function validateEpisodes(
  episodes: ParsedEpisode[],
  meta: SessionMeta,
  totalLines: number,
): void {
  if (episodes.length < 1 || episodes.length > 5) {
    throw new Error(`E5 violated: expected 1~5 episodes, got ${episodes.length}`);
  }
  for (const [i, ep] of episodes.entries()) {
    if (!ep.frontmatter.boundary_reason || typeof ep.frontmatter.boundary_reason !== "string") {
      throw new Error(`E6 violated: episode[${i}] missing boundary_reason`);
    }
    if (ep.sourceRanges.length === 0) {
      throw new Error(`E3 violated: episode[${i}] has no source ranges`);
    }
    for (const r of ep.sourceRanges) {
      if (r.start < 1 || r.end > totalLines) {
        throw new Error(
          `E3 violated: episode[${i}] range ${r.start}-${r.end} outside [1..${totalLines}]`,
        );
      }
    }
  }

  // E4: ranges sort + cover [1..totalLines] exactly, no gaps, no overlaps
  const flat = episodes
    .flatMap((ep) => ep.sourceRanges)
    .slice()
    .sort((a, b) => a.start - b.start);
  let cursor = 0;
  for (const r of flat) {
    if (r.start !== cursor + 1) {
      throw new Error(
        `E4 violated: gap or overlap at line ${cursor + 1} vs range start ${r.start}`,
      );
    }
    cursor = r.end;
  }
  if (cursor !== totalLines) {
    throw new Error(`E4 violated: coverage ends at ${cursor}, expected ${totalLines}`);
  }

  // basic fields
  for (const [i, ep] of episodes.entries()) {
    for (const k of ["title", "started", "ended", "outcome"] as const) {
      if (!ep.frontmatter[k]) throw new Error(`E1 violated: episode[${i}] missing ${k}`);
    }
    if (ep.frontmatter.session_id && ep.frontmatter.session_id !== meta.session_id) {
      throw new Error(
        `session_id mismatch: episode[${i}] ${ep.frontmatter.session_id} vs raw ${meta.session_id}`,
      );
    }
  }
}

// ---------- id + finalize ----------

function episodeId(
  sessionId: string,
  ranges: SourceRange[],
  promptVersion: string,
  model: string,
): string {
  const rangeKey = ranges
    .slice()
    .sort((a, b) => a.start - b.start)
    .map((r) => `${r.start}-${r.end}`)
    .join(",");
  return createHash("sha256")
    .update(`${sessionId}|${rangeKey}|${promptVersion}|${model}`)
    .digest("hex")
    .slice(0, 16);
}

function finalizeEpisode(
  p: ParsedEpisode,
  meta: SessionMeta,
  model: string,
  now: string,
): ConsolidatedEpisode {
  const id = episodeId(meta.session_id, p.sourceRanges, PROMPT_VERSION, model);
  const fm: EpisodeFrontmatter = {
    id,
    session_id: meta.session_id,
    title: String(p.frontmatter.title),
    topic_tags: Array.isArray(p.frontmatter.topic_tags) ? p.frontmatter.topic_tags as string[] : [],
    started: toIsoString(p.frontmatter.started) ?? meta.started,
    ended: toIsoString(p.frontmatter.ended) ?? meta.ended,
    sources: p.sourceRanges.map((r) => `${r.path}#L${r.start}-${r.end}`),
    participants: Array.isArray(p.frontmatter.participants)
      ? (p.frontmatter.participants as string[])
      : ["roy", "claude", meta.persona],
    persona: String(p.frontmatter.persona ?? meta.persona),
    persona_ref: String(p.frontmatter.persona_ref ?? meta.persona_ref),
    boundary_reason: String(p.frontmatter.boundary_reason),
    consolidation: {
      model,
      prompt_version: PROMPT_VERSION,
      at: now,
    },
    outcome: (["resolved", "open", "failed"] as const).includes(p.frontmatter.outcome as "resolved")
      ? (p.frontmatter.outcome as "resolved" | "open" | "failed")
      : "open",
  };
  const slug = buildSlug(fm, id);
  return {
    id,
    slug,
    path: slug + ".md",
    frontmatter: fm,
    body: p.body,
    sourceRanges: p.sourceRanges,
  };
}

function toIsoString(value: unknown): string | undefined {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
  }
  return undefined;
}

function buildSlug(fm: EpisodeFrontmatter, id: string): string {
  const dateOnly = fm.started.slice(0, 10); // ISO yyyy-mm-dd
  const title = fm.title
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${dateOnly}-${title || "episode"}-${id.slice(0, 6)}`;
}

// ---------- heuristic fallback ----------

function heuristicEpisode(
  events: RawEvent[],
  meta: SessionMeta,
  model: string,
  reason: string,
): ConsolidatedEpisode {
  const firstUser = events.find((e) => e.event_type === "user_message");
  const lastAssistant =
    [...events].reverse().find((e) => e.event_type === "message") ?? events[events.length - 1]!;
  const firstUserText = extractContent(firstUser?.payload) ?? "";
  const lastText = extractContent(lastAssistant.payload) ?? "";

  const range: SourceRange = {
    path: meta.rawRelPath,
    start: 1,
    end: meta.totalLines,
  };
  const id = episodeId(meta.session_id, [range], PROMPT_VERSION, `${model}+heuristic`);
  const now = new Date().toISOString();
  const fm: EpisodeFrontmatter = {
    id,
    session_id: meta.session_id,
    title: "(auto-generated, manual review needed)",
    topic_tags: ["heuristic"],
    started: meta.started,
    ended: meta.ended,
    sources: [`${range.path}#L${range.start}-${range.end}`],
    participants: ["roy", "claude", meta.persona],
    persona: meta.persona,
    persona_ref: meta.persona_ref,
    boundary_reason: `consolidation failed, raw 참조 필요 (reason: ${reason.slice(0, 120)})`,
    consolidation: { model: `${model}+heuristic`, prompt_version: PROMPT_VERSION, at: now },
    outcome: "failed",
  };
  const body = `## TL;DR
raw 참조 필요.

## 주요 결정
- (자동 생성 실패 — raw 를 직접 확인하세요)

## 학습
- —

## 남은 이슈
- [ ] consolidation 재시도 또는 수동 요약 필요

<!-- 힌트: first_user / last_message -->

\`\`\`
first_user: ${firstUserText.slice(0, 200)}
last_message: ${lastText.slice(0, 200)}
\`\`\`
`;
  const slug = buildSlug(fm, id);
  return { id, slug, path: slug + ".md", frontmatter: fm, body, sourceRanges: [range] };
}

function extractContent(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const p = payload as { content?: unknown; text?: unknown };
  if (typeof p.content === "string") return p.content;
  if (typeof p.text === "string") return p.text;
  return undefined;
}

// ---------- writing ----------

async function writeEpisode(
  ep: ConsolidatedEpisode,
  memoryDir: string,
): Promise<ConsolidatedEpisode> {
  const fullPath = join(memoryDir, "episodes", ep.path);
  await mkdir(dirname(fullPath), { recursive: true });
  const fmYaml = matter.stringify(ep.body + "\n", ep.frontmatter).trimEnd() + "\n";
  await writeFile(fullPath, fmYaml, "utf-8");
  return { ...ep, path: fullPath };
}
