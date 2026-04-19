#!/usr/bin/env tsx
/**
 * grade-real-session — ADR-007 P3.
 *
 * Input: raw JSONL + v2 episode + memoryDir + curriculumDir
 * Output: agent-curriculum/observations/<date>-<sid>.md with cells_observed[]
 *         + gap_vs_self_summary + graded_by metadata.
 *
 * Opus teacher 는 askAdvisor 를 통해 호출. ADVISOR_MOCK_RESPONSE env 로 테스트 우회.
 */

import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import matter from "gray-matter";

import { askAdvisor } from "../src/lib/llm/advisor";

export interface GradeRealSessionOpts {
  memoryDir: string;
  curriculumDir: string;
  episodePath: string;
  rawPath: string;
  model?: string;
}

export interface ObservationCell {
  cell_id: string;
  domain: string;
  opus_judged_advisor_needed: boolean;
  sonnet_called: boolean;
  mismatch: boolean;
  outcome_opus_rubric: "correct" | "partial" | "wrong" | "uncertain";
  confidence_gap: number;
}

export interface ObservationFrontmatter {
  id: string;
  kind: "real-session-observation";
  session_id: string;
  model: string;
  persona: string;
  episode_ref: string;
  raw_sources: string[];
  graded_by: { model: string; prompt_version: string; at: string };
  cells_observed: ObservationCell[];
  gap_vs_self_summary: string;
}

const PROMPT_VERSION = "grade-real-session-v1";
const OPUS_MODEL = process.env.GRADE_OPUS_MODEL ?? "claude-opus-4-7";

export async function gradeRealSession(opts: GradeRealSessionOpts): Promise<ObservationFrontmatter> {
  const rawContent = await readFile(opts.rawPath, "utf-8");
  const epContent = await readFile(opts.episodePath, "utf-8");
  const epParsed = matter(epContent);
  const epFm = epParsed.data as Record<string, unknown>;

  const promptPath = join(opts.curriculumDir, "prompts", `${PROMPT_VERSION}.md`);
  const promptFull = await readFile(promptPath, "utf-8");

  const meta = {
    session_id: String(epFm.session_id ?? ""),
    model: String((epFm.consolidation as Record<string, unknown> | undefined)?.model ?? ""),
    persona: String(epFm.persona ?? ""),
    raw_path: opts.rawPath,
    total_lines: rawContent.trim().split("\n").length,
  };

  const contextSummary = `<prompt_instructions>
${promptFull}
</prompt_instructions>

<raw_session>
${rawContent}
</raw_session>

<episode>
${epContent}
</episode>

<session_meta>
${JSON.stringify(meta, null, 2)}
</session_meta>`;

  // askAdvisor signature: (input: { question, context_summary, what_tried? }, opts: { model? })
  // ADVISOR_MOCK_RESPONSE env short-circuits the call inside askAdvisor.
  const response = await askAdvisor(
    {
      question:
        "Grade this real agent session as Opus teacher per the prompt_instructions. Return exactly one JSON code block matching the schema.",
      context_summary: contextSummary,
    },
    { model: opts.model ?? OPUS_MODEL },
  );

  const jsonText = extractJsonBlock(response);

  const parsed = JSON.parse(jsonText) as {
    cells_observed: ObservationCell[];
    gap_vs_self_summary: string;
  };

  const now = new Date().toISOString();
  const sourceLines = Array.isArray(epFm.sources) ? (epFm.sources as string[]) : [];
  const fm: ObservationFrontmatter = {
    id: observationId(meta.session_id, now),
    kind: "real-session-observation",
    session_id: meta.session_id,
    model: meta.model,
    persona: meta.persona,
    episode_ref: String(epFm.id ?? ""),
    raw_sources: sourceLines,
    graded_by: { model: opts.model ?? OPUS_MODEL, prompt_version: PROMPT_VERSION, at: now },
    cells_observed: parsed.cells_observed,
    gap_vs_self_summary: parsed.gap_vs_self_summary,
  };

  const date = now.slice(0, 10);
  const outPath = join(opts.curriculumDir, "observations", `${date}-${meta.session_id}.md`);
  await mkdir(join(opts.curriculumDir, "observations"), { recursive: true });

  const body = buildBody(fm);
  const out = matter.stringify(body, fm as unknown as Record<string, unknown>);
  await writeFile(outPath, out, "utf-8");

  return fm;
}

function extractJsonBlock(text: string): string {
  const m = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (m) return m[1]!.trim();
  return text.trim();
}

function observationId(sessionId: string, now: string): string {
  return createHash("sha256")
    .update(`${sessionId}|${now}|${PROMPT_VERSION}|${OPUS_MODEL}`)
    .digest("hex")
    .slice(0, 16);
}

function buildBody(fm: ObservationFrontmatter): string {
  return `## 관찰 요약

${fm.gap_vs_self_summary}

## 활성 cell

${fm.cells_observed
  .map(
    (c) =>
      `- **${c.cell_id}** (${c.domain}): needed=${c.opus_judged_advisor_needed}, called=${c.sonnet_called}, mismatch=${c.mismatch}, outcome=${c.outcome_opus_rubric}, confidence_gap=${c.confidence_gap}`,
  )
  .join("\n")}
`;
}

// CLI invocation
if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , memoryDir, curriculumDir, episodePath, rawPath] = process.argv;
  if (!memoryDir || !curriculumDir || !episodePath || !rawPath) {
    console.error("usage: grade-real-session.ts <memoryDir> <curriculumDir> <episodePath> <rawPath>");
    process.exit(1);
  }
  gradeRealSession({
    memoryDir: resolve(memoryDir),
    curriculumDir: resolve(curriculumDir),
    episodePath: resolve(episodePath),
    rawPath: resolve(rawPath),
  })
    .then((fm) => {
      console.log(JSON.stringify(fm, null, 2));
      process.exit(0);
    })
    .catch((e) => {
      console.error("grade-real-session failed:", e);
      process.exit(1);
    });
}
