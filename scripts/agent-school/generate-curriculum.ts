/**
 * Curriculum generator (ADR-006 Phase A, Top 2).
 *
 * Opus teacher 에게 agent-curriculum 의 `prompts/generate-curriculum-v1.md`
 * 지침을 주고 N 개 문제를 생성시킨다. 결과를 `problems/<date>/<problem_id>.md`
 * 로 저장.
 *
 * Usage:
 *   npx tsx scripts/agent-school/generate-curriculum.ts \
 *     [--count N]              (기본 15)
 *     [--easy N --medium N --hard N --ambiguous N --out-of-scope N]
 *     [--categories "reasoning,factual,meta"]
 *
 * Tier 분포는 `--<tier> N` 로 오버라이드. 합이 --count 와 다르면 합이 우선.
 *
 * R1 준수: 기존 problem_id 와 충돌하지 않도록 이미 있는 파일을 스캔해
 * 중복 id 목록을 생성 prompt 에 전달.
 */

import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { askAdvisor } from "../../src/lib/llm/advisor";

const CURRICULUM_REPO = "/Users/roy/Workspace/agent/agent-curriculum";

function loadEnvLocal(): void {
  const path = resolve(process.cwd(), ".env.local");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const eq = s.indexOf("=");
    if (eq < 0) continue;
    const k = s.slice(0, eq).trim();
    let v = s.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
loadEnvLocal();

type Tier = "easy" | "medium" | "hard" | "ambiguous" | "out-of-scope";

interface CliArgs {
  count: number;
  distribution: Partial<Record<Tier, number>>;
  categories: string[] | null;
}

function parseArgs(argv: string[]): CliArgs {
  let count = 15;
  const distribution: Partial<Record<Tier, number>> = {};
  let categories: string[] | null = null;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--count") {
      count = Number(argv[++i]);
    } else if (a === "--easy") distribution.easy = Number(argv[++i]);
    else if (a === "--medium") distribution.medium = Number(argv[++i]);
    else if (a === "--hard") distribution.hard = Number(argv[++i]);
    else if (a === "--ambiguous") distribution.ambiguous = Number(argv[++i]);
    else if (a === "--out-of-scope") distribution["out-of-scope"] = Number(argv[++i]);
    else if (a === "--categories") {
      const v = argv[++i];
      categories = v.split(",").map((s) => s.trim()).filter(Boolean);
    }
  }

  const distSum = Object.values(distribution).reduce((a, b) => a + (b ?? 0), 0);
  if (distSum > 0) count = distSum;
  return { count, distribution, categories };
}

// -------- Existing id 수집 (중복 방지, R1) --------

function collectExistingIds(): string[] {
  const ids: string[] = [];
  const problemsRoot = join(CURRICULUM_REPO, "problems");
  if (!existsSync(problemsRoot)) return ids;
  for (const d of readdirSync(problemsRoot)) {
    const dateDir = join(problemsRoot, d);
    try {
      for (const f of readdirSync(dateDir)) {
        const m = f.match(/^(curr-[\w-]+)\.md$/);
        if (m) ids.push(m[1]);
      }
    } catch {
      continue;
    }
  }
  // Runs 의 problem_id 도 수집 (legacy 포함)
  const runsRoot = join(CURRICULUM_REPO, "runs");
  if (existsSync(runsRoot)) {
    for (const date of readdirSync(runsRoot)) {
      const dateDir = join(runsRoot, date);
      try {
        for (const model of readdirSync(dateDir)) {
          const modelDir = join(dateDir, model);
          for (const entry of readdirSync(modelDir)) {
            const m1 = entry.match(/^(curr-[\w-]+)(?:\.md)?$/);
            if (m1) ids.push(m1[1]);
          }
        }
      } catch {
        continue;
      }
    }
  }
  return [...new Set(ids)];
}

// -------- Opus 호출 --------

interface GeneratedProblem {
  problem_id: string;
  tier: Tier;
  category: string;
  prompt: string;
  answer_rubric: string;
  expected_behavior: "solve_direct" | "call_advisor" | "ask_user" | "acknowledge_unknown";
  why_this_tier: string;
}

function buildContextSummary(args: CliArgs, existing: string[]): string {
  const distLines: string[] = [];
  const dist = args.distribution;
  if (Object.keys(dist).length === 0) {
    distLines.push(
      `분포 지정 없음. 총 ${args.count} 문제를 tier 별로 균형 분배.`,
      `권장 분포 (5 tier 균등): easy/medium/hard 위주, ambiguous 와 out-of-scope 는 총량의 10~20%.`,
    );
  } else {
    distLines.push(`tier 별 목표 수:`);
    for (const t of ["easy", "medium", "hard", "ambiguous", "out-of-scope"] as Tier[]) {
      const n = dist[t];
      if (n !== undefined) distLines.push(`  - ${t}: ${n}`);
    }
  }

  const catLine = args.categories
    ? `카테고리 힌트 (이 중에서 다양하게 섞어라): ${args.categories.join(", ")}`
    : `카테고리 힌트 없음. 다양하게 섞어라 (reasoning / factual / meta / philosophy / coding / math / tool_use 등).`;

  const idSnippet =
    existing.length === 0
      ? "(중복 검사 대상 없음)"
      : existing.slice(0, 80).join(", ") + (existing.length > 80 ? `, ... (+${existing.length - 80})` : "");

  return [
    `총량: ${args.count}`,
    distLines.join("\n"),
    catLine,
    `피해야 할 기존 problem_id 목록 (이 id 와 충돌 금지):`,
    idSnippet,
    `오늘 날짜 (problem_id 접두어용): ${new Date().toISOString().slice(0, 10)}`,
  ].join("\n\n");
}

function extractJSON(response: string): string {
  const m1 = response.match(/```json\s*([\s\S]*?)```/);
  if (m1) return m1[1].trim();
  const m2 = response.match(/```\s*([\s\S]*?)```/);
  if (m2) return m2[1].trim();
  const start = response.indexOf("[");
  const end = response.lastIndexOf("]");
  if (start >= 0 && end > start) return response.slice(start, end + 1);
  return response.trim();
}

function validateProblem(p: unknown, existing: Set<string>): p is GeneratedProblem {
  if (!p || typeof p !== "object") return false;
  const o = p as Record<string, unknown>;
  const validTiers: Tier[] = ["easy", "medium", "hard", "ambiguous", "out-of-scope"];
  const validBehaviors = ["solve_direct", "call_advisor", "ask_user", "acknowledge_unknown"];
  if (typeof o.problem_id !== "string" || !/^curr-[\w-]+$/.test(o.problem_id)) return false;
  if (existing.has(o.problem_id)) return false;
  if (!validTiers.includes(o.tier as Tier)) return false;
  if (typeof o.category !== "string" || o.category.length < 2) return false;
  if (typeof o.prompt !== "string" || o.prompt.length < 5) return false;
  if (typeof o.answer_rubric !== "string" || o.answer_rubric.length < 10) return false;
  if (!validBehaviors.includes(o.expected_behavior as string)) return false;
  if (typeof o.why_this_tier !== "string" || o.why_this_tier.length < 10) return false;
  return true;
}

// -------- 파일 저장 --------

function writeProblem(p: GeneratedProblem, date: string): string {
  const dir = join(CURRICULUM_REPO, "problems", date);
  mkdirSync(dir, { recursive: true });
  const outPath = join(dir, `${p.problem_id}.md`);
  if (existsSync(outPath)) {
    throw new Error(`Problem file already exists (R1 violation): ${outPath}`);
  }

  const content = [
    "---",
    `problem_id: ${p.problem_id}`,
    `tier: ${p.tier}`,
    `category: ${p.category}`,
    `expected_behavior: ${p.expected_behavior}`,
    `created_at: ${new Date().toISOString()}`,
    `created_by: opus`,
    `prompt: ${JSON.stringify(p.prompt)}`,
    `answer_rubric: ${JSON.stringify(p.answer_rubric)}`,
    `why_this_tier: ${JSON.stringify(p.why_this_tier)}`,
    "---",
    "",
    `# Problem: ${p.problem_id}`,
    "",
    "## Prompt",
    "",
    p.prompt,
    "",
    "## Answer rubric",
    "",
    p.answer_rubric,
    "",
    "## Tier rationale",
    "",
    p.why_this_tier,
    "",
  ].join("\n");

  writeFileSync(outPath, content);
  return outPath;
}

// -------- Main --------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const existingList = collectExistingIds();
  const existing = new Set(existingList);
  const date = new Date().toISOString().slice(0, 10);

  const promptPath = join(CURRICULUM_REPO, "prompts/generate-curriculum-v1.md");
  const systemPrompt = readFileSync(promptPath, "utf8");
  const contextSummary = buildContextSummary(args, existingList);

  console.log(`[info] curriculum repo: ${CURRICULUM_REPO}`);
  console.log(`[info] date: ${date}  target count: ${args.count}`);
  console.log(`[info] existing ids: ${existingList.length}`);
  console.log(`[info] distribution: ${JSON.stringify(args.distribution)}`);

  const response = await askAdvisor(
    {
      question: `지침에 따라 JSON 배열로 ${args.count} 문제를 생성하라. schema 엄수, 기존 id 충돌 금지.`,
      context_summary: contextSummary,
      what_tried: systemPrompt,
    },
    { maxTokens: 8192 },
  );

  const jsonText = extractJSON(response);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (e) {
    console.error(`[error] JSON parse failed: ${(e as Error).message}`);
    console.error(`[raw, first 500 chars]\n${response.slice(0, 500)}`);
    process.exit(1);
  }

  if (!Array.isArray(parsed)) {
    console.error(`[error] expected array, got ${typeof parsed}`);
    process.exit(1);
  }

  const kept: GeneratedProblem[] = [];
  const rejected: Array<{ why: string; raw: unknown }> = [];
  for (const item of parsed) {
    if (validateProblem(item, existing)) {
      kept.push(item);
      existing.add(item.problem_id);
    } else {
      rejected.push({
        why: "schema violation or duplicate id",
        raw: item,
      });
    }
  }

  console.log(`[info] generated: ${parsed.length}, valid: ${kept.length}, rejected: ${rejected.length}`);
  if (rejected.length > 0) {
    for (const r of rejected.slice(0, 3)) {
      const id = typeof (r.raw as { problem_id?: unknown }).problem_id === "string"
        ? (r.raw as { problem_id: string }).problem_id
        : "(no id)";
      console.log(`  [reject] ${id}  ${r.why}`);
    }
  }

  const written: string[] = [];
  for (const p of kept) {
    try {
      const outPath = writeProblem(p, date);
      written.push(outPath);
      console.log(`  [saved] ${p.problem_id} [${p.tier}]  → ${outPath}`);
    } catch (e) {
      console.error(`  [write fail] ${p.problem_id}: ${(e as Error).message}`);
    }
  }

  console.log("\n========================================");
  console.log(`Curriculum generation summary: ${written.length} problems written`);
  const byTier: Record<string, number> = {};
  for (const p of kept) byTier[p.tier] = (byTier[p.tier] ?? 0) + 1;
  for (const t of ["easy", "medium", "hard", "ambiguous", "out-of-scope"]) {
    console.log(`  ${t}: ${byTier[t] ?? 0}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
