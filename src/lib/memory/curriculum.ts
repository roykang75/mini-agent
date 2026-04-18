/**
 * Curriculum search over `<curriculumDir>/runs/<date>/<model>/<problem_id>/run-NN.md`.
 *
 * 3-인칭 관찰 기록 (agent-curriculum repo). 1-인칭 episode 와 구분해 별도 파일로
 * 둔다 — ADR-002 의 화자 분리 원칙을 search 경로에서도 지킨다.
 *
 * 레거시 flat 레이아웃 (`runs/<date>/<model>/<problem_id>.md`) 도 함께 스캔.
 * 같은 problem_id 로 여러 run 이 매칭되면 score 가 높은 run 1 개만 surface
 * (agent context 에 run 을 여러 번 반복해 주입하지 않는다).
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import matter from "gray-matter";

export interface CurriculumRecord {
  problem_id: string;
  model: string;
  ran_at: string;
  run_index: number | null;
  tier_opus_predicted: string;
  category: string;
  outcome: "correct" | "partial" | "wrong" | "unknown";
  advisor_called: boolean;
  advisor_should_have_been_called: boolean;
  confidence_in_answer: number;
  lesson: string;
  path: string;
  bodyExcerpt: string;
}

export interface CurriculumSearchOptions {
  query: string;
  model?: string;
  limit?: number;
}

export interface CurriculumHit {
  record: CurriculumRecord;
  score: number;
  matchedTokens: string[];
}

export async function searchCurriculum(
  curriculumDir: string,
  opts: CurriculumSearchOptions,
): Promise<CurriculumHit[]> {
  const tokens = tokenize(opts.query);
  if (tokens.length === 0) return [];

  const runsRoot = join(curriculumDir, "runs");
  const runFiles = await collectRunFiles(runsRoot, opts.model);

  const bestByProblem = new Map<string, CurriculumHit>();

  for (const f of runFiles) {
    const raw = await readFile(f, "utf-8").catch(() => null);
    if (raw === null) continue;
    const parsed = matter(raw);
    const fm = parsed.data as Record<string, unknown>;

    const problem_id = String(fm.problem_id ?? "");
    if (!problem_id) continue;
    const fmModel = String(fm.model ?? "");
    if (opts.model && fmModel && fmModel !== opts.model) continue;

    const sr =
      (fm.self_reflection as Record<string, unknown> | undefined) ?? {};
    const record: CurriculumRecord = {
      problem_id,
      model: fmModel,
      ran_at: String(fm.ran_at ?? ""),
      run_index: typeof fm.run_index === "number" ? fm.run_index : null,
      tier_opus_predicted: String(fm.tier_opus_predicted ?? ""),
      category: String(fm.category ?? ""),
      outcome: normalizeOutcome(sr.outcome ?? fm.outcome),
      advisor_called: Boolean(fm.advisor_called),
      advisor_should_have_been_called: Boolean(sr.advisor_should_have_been_called),
      confidence_in_answer: Number(sr.confidence_in_answer ?? 0),
      lesson: String(sr.lesson ?? ""),
      path: f,
      bodyExcerpt: firstMeaningfulLine(parsed.content),
    };

    const body = parsed.content.toLowerCase();
    const blob = [
      record.problem_id,
      record.category,
      record.tier_opus_predicted,
      record.lesson,
      body,
    ]
      .join(" ")
      .toLowerCase();
    const lessonLower = record.lesson.toLowerCase();
    const tagLower = `${record.category} ${record.tier_opus_predicted}`.toLowerCase();

    let score = 0;
    const matched: string[] = [];
    for (const t of tokens) {
      const lt = t.toLowerCase();
      const lessonHits = countOccurrences(lessonLower, lt);
      const tagHits = countOccurrences(tagLower, lt);
      const bodyHits = countOccurrences(blob, lt);
      const tokScore = lessonHits * 4 + tagHits * 2 + bodyHits;
      if (tokScore > 0) {
        score += tokScore;
        matched.push(t);
      }
    }
    if (score === 0) continue;

    const prev = bestByProblem.get(problem_id);
    if (!prev || prev.score < score) {
      bestByProblem.set(problem_id, { record, score, matchedTokens: matched });
    }
  }

  const hits = [...bestByProblem.values()];
  hits.sort(
    (a, b) =>
      b.score - a.score || b.record.ran_at.localeCompare(a.record.ran_at),
  );
  const limit = Math.max(1, opts.limit ?? 3);
  return hits.slice(0, limit);
}

async function collectRunFiles(runsRoot: string, model?: string): Promise<string[]> {
  const dateDirs = await readdir(runsRoot).catch(() => [] as string[]);
  const out: string[] = [];
  for (const d of dateDirs) {
    const dateDir = join(runsRoot, d);
    const dateStat = await stat(dateDir).catch(() => null);
    if (!dateStat || !dateStat.isDirectory()) continue;

    const modelDirs = await readdir(dateDir).catch(() => [] as string[]);
    for (const m of modelDirs) {
      if (model && m !== model) continue;
      const modelDir = join(dateDir, m);
      const modelStat = await stat(modelDir).catch(() => null);
      if (!modelStat || !modelStat.isDirectory()) continue;

      const entries = await readdir(modelDir).catch(() => [] as string[]);
      for (const e of entries) {
        const ePath = join(modelDir, e);
        const eStat = await stat(ePath).catch(() => null);
        if (!eStat) continue;
        if (eStat.isFile() && e.endsWith(".md") && e !== "_stats.md") {
          out.push(ePath);
          continue;
        }
        if (eStat.isDirectory()) {
          const sub = await readdir(ePath).catch(() => [] as string[]);
          for (const f of sub) {
            if (/^run-\d+\.md$/.test(f)) out.push(join(ePath, f));
          }
        }
      }
    }
  }
  return out;
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

function normalizeOutcome(v: unknown): CurriculumRecord["outcome"] {
  const s = String(v ?? "").toLowerCase();
  if (s === "correct" || s === "partial" || s === "wrong") return s;
  return "unknown";
}

function firstMeaningfulLine(content: string): string {
  for (const raw of content.split("\n")) {
    const l = raw.trim();
    if (l.length > 10 && !l.startsWith("#")) return l.slice(0, 240);
  }
  return "";
}
