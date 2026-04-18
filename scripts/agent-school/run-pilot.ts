/**
 * ADR-006 Phase A pilot — hand-crafted curriculum 을 end-to-end 돌려서 파이프라인
 * 검증. N-run 통계 지원 (2026-04-18 amend): 같은 문제를 N 회 반복해 single-run
 * noise 흡수.
 *
 * Usage:
 *   npx tsx scripts/agent-school/run-pilot.ts [--repeat N] [--problem ID]
 *
 *   --repeat N    (default 5) 각 문제당 반복 횟수
 *   --problem ID  특정 문제만 돌림 (생략 시 전체)
 *
 * 산출물:
 *   agent-curriculum/runs/<date>/<model>/<problem_id>/
 *     ├── run-NN.md   (individual run, R2 immutable)
 *     └── _stats.md   (aggregate, 매 invocation 재생성)
 *
 * R2 준수: 기존 run-NN.md 는 덮어쓰지 않고 다음 index 로 append.
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import matter from "gray-matter";

import { summonAgent, disposeAgent } from "../../src/lib/agent/registry";
import { askAdvisor } from "../../src/lib/llm/advisor";
import type { AgentEvent } from "../../src/lib/types";

const CURRICULUM_REPO = "/Users/roy/Workspace/agent/agent-curriculum";
const MODEL_TAG = process.env.LLM_MODEL ?? "claude-sonnet-4-6";
const DATE_TAG = new Date().toISOString().slice(0, 10);

process.env.AGENT_MEMORY_DIR = join(CURRICULUM_REPO, "raw-scratch");
mkdirSync(join(CURRICULUM_REPO, "raw-scratch", "raw"), { recursive: true });

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

// -------- CLI args --------

type SourceMode = "auto" | "file" | "hardcoded";

interface CliArgs {
  repeat: number;
  problemFilter: string | null;
  source: SourceMode;
  tierRepeat: Partial<Record<string, number>>;
}

function parseArgs(argv: string[]): CliArgs {
  let repeat = 5;
  let problemFilter: string | null = null;
  let source: SourceMode = "auto";
  const tierRepeat: Partial<Record<string, number>> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repeat") {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n < 1) {
        throw new Error(`--repeat must be a positive integer, got ${argv[i]}`);
      }
      repeat = Math.floor(n);
    } else if (a === "--problem") {
      problemFilter = argv[++i] ?? null;
    } else if (a === "--source") {
      const v = argv[++i];
      if (v !== "auto" && v !== "file" && v !== "hardcoded") {
        throw new Error(`--source must be auto|file|hardcoded, got ${v}`);
      }
      source = v;
    } else if (a === "--tier-repeat") {
      const spec = argv[++i];
      for (const entry of spec.split(",")) {
        const [k, vRaw] = entry.split("=").map((s) => s.trim());
        const n = Number(vRaw);
        if (!k || !Number.isFinite(n) || n < 1) {
          throw new Error(`--tier-repeat entry invalid: ${entry}`);
        }
        tierRepeat[k] = Math.floor(n);
      }
    }
  }
  return { repeat, problemFilter, source, tierRepeat };
}

// -------- Problems --------

type Tier = "easy" | "medium" | "hard" | "ambiguous" | "out-of-scope";
type ExpectedBehavior = "solve_direct" | "call_advisor" | "ask_user" | "acknowledge_unknown";

interface Problem {
  id: string;
  tier: Tier;
  category: string;
  prompt: string;
  answer_rubric: string;
  expected_behavior: ExpectedBehavior;
  why_this_tier: string;
}

const HARDCODED_PROBLEMS: Problem[] = [
  {
    id: "curr-pilot-001",
    tier: "easy",
    category: "factual",
    prompt: "대한민국의 수도는 어디이고, 인구는 대략 얼마나 됩니까? 한두 문장으로 답해주세요.",
    answer_rubric:
      "서울을 명시할 것. 인구는 약 950만~1000만 범위 또는 수도권 기준 약 2500만 언급 시 정답.",
    expected_behavior: "solve_direct",
    why_this_tier:
      "명확한 factual recall. 추론 체인 불필요, 도구 불필요. Sonnet 수준에서 당연히 해결.",
  },
  {
    id: "curr-pilot-002",
    tier: "medium",
    category: "reasoning",
    prompt:
      "'모든 백조는 흰색이다' 라는 명제를 관찰만으로 증명할 수 있는가? 포퍼의 반증주의 관점에서 한 문단으로 설명해주세요.",
    answer_rubric:
      "귀납 문제 언급 (무한한 관찰 불가능). 반증주의: 한 마리 검은 백조만 있어도 반박. 증명은 불가, 반증만 가능 언급 시 정답.",
    expected_behavior: "solve_direct",
    why_this_tier: "철학 기초 개념. Sonnet 알고 있을 것. 단 정확히 구성되는지.",
  },
  {
    id: "curr-pilot-003",
    tier: "hard",
    category: "meta_reasoning",
    prompt:
      "다음 진술을 보세요: '이 문장은 거짓이다'. 이 패러독스의 구조를 설명하고, 해결 시도 3 가지 (타르스키 계층, 진리 양가 부정, 맥락 의존 진리값 등) 를 각각 간단히 비교하세요.",
    answer_rubric:
      "리아 패러독스 (거짓말쟁이) 의 구조 (자기-참조 + 부정) 설명 필수. 타르스키 object/metalanguage 계층 분리, 양가 논리 혹은 3 값 논리, 맥락주의 (Kripke 등) 중 최소 2 개 비교. 정확성 + 차별화 중요.",
    expected_behavior: "call_advisor",
    why_this_tier:
      "Multi-step abstract reasoning. 정확한 철학사 지식 + 구조적 비교 요구. Sonnet 이 superficial 답변하기 쉬움. Advisor 호출이 정답.",
  },
];

// -------- Load problems from curriculum repo --------

function loadProblemsFromRepo(): Problem[] {
  const problemsRoot = join(CURRICULUM_REPO, "problems");
  if (!existsSync(problemsRoot)) return [];
  const out: Problem[] = [];
  const validTiers: Tier[] = ["easy", "medium", "hard", "ambiguous", "out-of-scope"];
  const validBehaviors: ExpectedBehavior[] = [
    "solve_direct",
    "call_advisor",
    "ask_user",
    "acknowledge_unknown",
  ];
  for (const date of readdirSync(problemsRoot)) {
    const dateDir = join(problemsRoot, date);
    let entries: string[];
    try {
      entries = readdirSync(dateDir);
    } catch {
      continue;
    }
    for (const f of entries) {
      if (!f.endsWith(".md")) continue;
      const fullPath = join(dateDir, f);
      const raw = readFileSync(fullPath, "utf8");
      const parsed = matter(raw);
      const fm = parsed.data as Record<string, unknown>;
      if (fm.superseded_by) continue;
      const tier = fm.tier as Tier;
      const expected = fm.expected_behavior as ExpectedBehavior;
      if (typeof fm.problem_id !== "string") continue;
      if (!validTiers.includes(tier)) continue;
      if (!validBehaviors.includes(expected)) continue;
      const prompt =
        typeof fm.prompt === "string" && fm.prompt.length > 0
          ? fm.prompt
          : extractPromptFromBody(parsed.content);
      const rubric = String(fm.answer_rubric ?? "");
      if (!prompt || !rubric) continue;
      out.push({
        id: fm.problem_id,
        tier,
        category: String(fm.category ?? "uncategorized"),
        prompt,
        answer_rubric: rubric,
        expected_behavior: expected,
        why_this_tier: String(fm.why_this_tier ?? ""),
      });
    }
  }
  // 정렬: tier → id 알파벳 (재현성)
  const tierRank: Record<Tier, number> = {
    easy: 0,
    medium: 1,
    hard: 2,
    ambiguous: 3,
    "out-of-scope": 4,
  };
  out.sort((a, b) => tierRank[a.tier] - tierRank[b.tier] || a.id.localeCompare(b.id));
  return out;
}

function extractPromptFromBody(body: string): string {
  const m = body.match(/##\s*Prompt\s*\n+([\s\S]*?)(?=\n##\s|\n*$)/);
  return m ? m[1].trim() : "";
}

// -------- Run single attempt --------

interface RunOutcome {
  events: AgentEvent[];
  answerText: string;
  advisorCalled: boolean;
  sid: string;
}

async function runProblem(p: Problem, runIndex: number): Promise<RunOutcome> {
  const sid = `curr-${p.id}-${Date.now()}-r${runIndex}`;
  const agent = await summonAgent(sid);
  const events: AgentEvent[] = [];

  console.log(`  [run-${runIndex.toString().padStart(2, "0")}] sid=${sid}`);

  async function consumeGenerator(gen: AsyncGenerator<AgentEvent>): Promise<void> {
    for await (const ev of gen) {
      events.push(ev);
      if (ev.type === "tool_approval_request") {
        console.log(
          `    [auto-approve] ${ev.toolCalls.map((t) => t.name).join(", ")}`,
        );
        await consumeGenerator(agent.resumeAfterApproval(ev.sessionId, true, {}));
        return;
      }
    }
  }

  try {
    await consumeGenerator(agent.receive(p.prompt, { persona: "default" }));
  } catch (e) {
    console.error(`    [error] receive threw: ${(e as Error).message}`);
  }

  const answerText = events
    .filter((e) => e.type === "message")
    .map((e) => ("content" in e ? (e as { content: string }).content : ""))
    .join("\n");
  const advisorCalled = events.some(
    (e) => e.type === "tool_call" && "name" in e && (e as { name: string }).name === "ask_advisor",
  );

  console.log(
    `    [events] ${events.length}  [advisor_called] ${advisorCalled}  [answer_len] ${answerText.length}`,
  );

  await disposeAgent(sid);
  return { events, answerText, advisorCalled, sid };
}

// -------- Grade single run --------

interface SelfReflection {
  outcome: "correct" | "partial" | "wrong";
  difficulty_sonnet_felt: "low" | "medium" | "high";
  actual_behavior: string;
  advisor_should_have_been_called: boolean;
  confidence_in_answer: number;
  lesson: string;
}

async function gradeProblem(
  p: Problem,
  answerText: string,
  advisorCalled: boolean,
): Promise<SelfReflection> {
  const contextSummary = [
    `tier: ${p.tier}`,
    `expected_behavior: ${p.expected_behavior}`,
    `answer_rubric: ${p.answer_rubric}`,
    `--- Sonnet answer ---`,
    answerText || "(empty)",
    `--- advisor call status ---`,
    `ask_advisor was called: ${advisorCalled}`,
  ].join("\n");

  const gradePromptPath = join(CURRICULUM_REPO, "prompts/grade-curriculum-v1.md");
  const gradeSystem = readFileSync(gradePromptPath, "utf8");

  const response = await askAdvisor(
    {
      question: "위 답변을 채점하고 self_reflection JSON 을 출력해주세요. 지시된 schema 엄수.",
      context_summary: contextSummary,
      what_tried: gradeSystem,
    },
    {},
  );

  const match =
    response.match(/```json\s*([\s\S]*?)```/) ??
    response.match(/```\s*([\s\S]*?)```/) ??
    [null, response];
  const jsonText = (match[1] ?? response).trim();
  try {
    return JSON.parse(jsonText) as SelfReflection;
  } catch {
    console.warn(`    [grade parse] failed — fallback partial`);
    return {
      outcome: "partial",
      difficulty_sonnet_felt: "medium",
      actual_behavior: "other",
      advisor_should_have_been_called: false,
      confidence_in_answer: 0.5,
      lesson: `채점 파싱 실패. raw: ${response.slice(0, 200)}`,
    };
  }
}

// -------- Write single run file --------

interface PersistedRun {
  runIndex: number;
  outPath: string;
  advisorCalled: boolean;
  sr: SelfReflection;
}

function nextRunIndex(problemDir: string): number {
  if (!existsSync(problemDir)) return 1;
  let max = 0;
  for (const f of readdirSync(problemDir)) {
    const m = f.match(/^run-(\d+)\.md$/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

function writeRunFile(
  p: Problem,
  run: RunOutcome,
  sr: SelfReflection,
  runIndex: number,
  problemDir: string,
): string {
  mkdirSync(problemDir, { recursive: true });
  const outPath = join(problemDir, `run-${runIndex.toString().padStart(2, "0")}.md`);

  const frontmatter = [
    "---",
    `problem_id: ${p.id}`,
    `model: ${MODEL_TAG}`,
    `run_index: ${runIndex}`,
    `ran_at: ${new Date().toISOString()}`,
    `session_sid: ${run.sid}`,
    `category: ${p.category}`,
    `tier_opus_predicted: ${p.tier}`,
    `expected_behavior: ${p.expected_behavior}`,
    `advisor_called: ${run.advisorCalled}`,
    `self_reflection:`,
    `  outcome: ${sr.outcome}`,
    `  difficulty_sonnet_felt: ${sr.difficulty_sonnet_felt}`,
    `  actual_behavior: ${sr.actual_behavior}`,
    `  advisor_should_have_been_called: ${sr.advisor_should_have_been_called}`,
    `  confidence_in_answer: ${sr.confidence_in_answer}`,
    `  lesson: ${JSON.stringify(sr.lesson)}`,
    "---",
    "",
    `# Training run: ${p.id} #${runIndex}`,
    "",
    "## Problem",
    "",
    p.prompt,
    "",
    "## Rubric",
    "",
    p.answer_rubric,
    "",
    "## Sonnet answer",
    "",
    run.answerText || "(empty)",
    "",
    "## Verdict",
    "",
    `- outcome: **${sr.outcome}**`,
    `- difficulty_sonnet_felt: ${sr.difficulty_sonnet_felt}`,
    `- actual_behavior: ${sr.actual_behavior}`,
    `- advisor_should_have_been_called: ${sr.advisor_should_have_been_called}`,
    `- confidence_in_answer: ${sr.confidence_in_answer}`,
    "",
    "## Lesson",
    "",
    sr.lesson,
    "",
  ].join("\n");

  writeFileSync(outPath, frontmatter);
  return outPath;
}

// -------- Stats aggregation --------

interface LoadedRun {
  runIndex: number;
  advisor_called: boolean;
  outcome: string;
  difficulty_sonnet_felt: string;
  advisor_should_have_been_called: boolean;
  confidence_in_answer: number;
  lesson: string;
  ran_at: string;
}

function parseRunFrontmatter(text: string): LoadedRun | null {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const body = m[1];
  const get = (key: string): string | null => {
    const r = new RegExp(`^${key}:\\s*(.*)$`, "m").exec(body);
    return r ? r[1].trim() : null;
  };
  const getNested = (parent: string, key: string): string | null => {
    const re = new RegExp(`^${parent}:[\\s\\S]*?^\\s{2}${key}:\\s*(.*)$`, "m");
    const r = re.exec(body);
    return r ? r[1].trim() : null;
  };
  const unq = (s: string | null): string =>
    s === null ? "" : s.replace(/^"([\s\S]*)"$/, "$1").replace(/^'([\s\S]*)'$/, "$1");

  const runIndex = Number(get("run_index") ?? 0);
  const advisor_called = (get("advisor_called") ?? "false") === "true";
  const outcome = unq(getNested("self_reflection", "outcome"));
  const difficulty_sonnet_felt = unq(getNested("self_reflection", "difficulty_sonnet_felt"));
  const advisor_should_have_been_called =
    unq(getNested("self_reflection", "advisor_should_have_been_called")) === "true";
  const confidence_in_answer = Number(unq(getNested("self_reflection", "confidence_in_answer")) || "0");
  const lessonRaw = getNested("self_reflection", "lesson") ?? "";
  let lesson = "";
  try {
    lesson = JSON.parse(lessonRaw);
  } catch {
    lesson = unq(lessonRaw);
  }
  const ran_at = unq(get("ran_at"));

  return {
    runIndex,
    advisor_called,
    outcome,
    difficulty_sonnet_felt,
    advisor_should_have_been_called,
    confidence_in_answer,
    lesson,
    ran_at,
  };
}

function writeStats(p: Problem, problemDir: string): void {
  const runs: LoadedRun[] = [];
  for (const f of readdirSync(problemDir)) {
    if (!/^run-\d+\.md$/.test(f)) continue;
    const text = readFileSync(join(problemDir, f), "utf8");
    const parsed = parseRunFrontmatter(text);
    if (parsed) runs.push(parsed);
  }
  runs.sort((a, b) => a.runIndex - b.runIndex);

  const total = runs.length;
  const safeRate = (n: number) => (total === 0 ? 0 : Number((n / total).toFixed(3)));
  const count = (pred: (r: LoadedRun) => boolean) => runs.filter(pred).length;

  const correctRate = safeRate(count((r) => r.outcome === "correct"));
  const partialRate = safeRate(count((r) => r.outcome === "partial"));
  const wrongRate = safeRate(count((r) => r.outcome === "wrong"));
  const advisorNeededRate = safeRate(count((r) => r.advisor_should_have_been_called));
  const advisorCalledRate = safeRate(count((r) => r.advisor_called));
  const meanConfidence =
    total === 0
      ? 0
      : Number(
          (runs.reduce((s, r) => s + r.confidence_in_answer, 0) / total).toFixed(3),
        );
  // outcome/advisor-need 미스매치: 기대행동 불일치 비율
  const behaviorMismatchRate = safeRate(
    count((r) => r.advisor_should_have_been_called !== r.advisor_called),
  );

  const lessonCounts = new Map<string, number>();
  for (const r of runs) {
    if (!r.lesson) continue;
    lessonCounts.set(r.lesson, (lessonCounts.get(r.lesson) ?? 0) + 1);
  }
  const sortedLessons = [...lessonCounts.entries()].sort((a, b) => b[1] - a[1]);

  const lines: string[] = [];
  lines.push("---");
  lines.push(`problem_id: ${p.id}`);
  lines.push(`model: ${MODEL_TAG}`);
  lines.push(`tier_opus_predicted: ${p.tier}`);
  lines.push(`expected_behavior: ${p.expected_behavior}`);
  lines.push(`runs_total: ${total}`);
  lines.push(`generated_at: ${new Date().toISOString()}`);
  lines.push(`aggregate:`);
  lines.push(`  correct_rate: ${correctRate}`);
  lines.push(`  partial_rate: ${partialRate}`);
  lines.push(`  wrong_rate: ${wrongRate}`);
  lines.push(`  advisor_needed_rate: ${advisorNeededRate}`);
  lines.push(`  advisor_called_rate: ${advisorCalledRate}`);
  lines.push(`  behavior_mismatch_rate: ${behaviorMismatchRate}`);
  lines.push(`  mean_confidence: ${meanConfidence}`);
  lines.push("---");
  lines.push("");
  lines.push(`# Stats: ${p.id}`);
  lines.push("");
  lines.push(`- **tier (Opus 예측)**: ${p.tier}`);
  lines.push(`- **expected_behavior**: ${p.expected_behavior}`);
  lines.push(`- **runs**: ${total}`);
  lines.push(`- **correct/partial/wrong**: ${correctRate} / ${partialRate} / ${wrongRate}`);
  lines.push(`- **advisor needed / called**: ${advisorNeededRate} / ${advisorCalledRate}`);
  lines.push(`- **behavior mismatch**: ${behaviorMismatchRate}  (needed ↔ called 불일치 비율)`);
  lines.push(`- **mean confidence**: ${meanConfidence}`);
  lines.push("");
  lines.push("## Per-run results");
  lines.push("");
  lines.push("| run | outcome | advisor_called | should_advisor | confidence | difficulty_felt |");
  lines.push("|---|---|---|---|---|---|");
  for (const r of runs) {
    lines.push(
      `| ${String(r.runIndex).padStart(2, "0")} | ${r.outcome} | ${r.advisor_called} | ${r.advisor_should_have_been_called} | ${r.confidence_in_answer} | ${r.difficulty_sonnet_felt} |`,
    );
  }
  lines.push("");
  lines.push("## Lessons (빈도 순)");
  lines.push("");
  if (sortedLessons.length === 0) {
    lines.push("(없음)");
  } else {
    for (const [lesson, n] of sortedLessons) {
      lines.push(`- (×${n}) ${lesson}`);
    }
  }
  lines.push("");

  writeFileSync(join(problemDir, "_stats.md"), lines.join("\n"));
}

// -------- Main --------

function selectProblems(args: CliArgs): Problem[] {
  const fromFile = loadProblemsFromRepo();
  let base: Problem[];
  if (args.source === "file") {
    base = fromFile;
  } else if (args.source === "hardcoded") {
    base = HARDCODED_PROBLEMS;
  } else {
    base = fromFile.length > 0 ? fromFile : HARDCODED_PROBLEMS;
  }
  return args.problemFilter ? base.filter((p) => p.id === args.problemFilter) : base;
}

function resolveRepeat(p: Problem, args: CliArgs): number {
  const tierSpecific = args.tierRepeat[p.tier];
  return typeof tierSpecific === "number" ? tierSpecific : args.repeat;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const targets = selectProblems(args);

  if (targets.length === 0) {
    console.error(
      `No problems match. source=${args.source} filter=${args.problemFilter ?? "(none)"}`,
    );
    process.exit(2);
  }

  const usingFile = loadProblemsFromRepo().length > 0 && args.source !== "hardcoded";
  console.log(`[info] curriculum repo: ${CURRICULUM_REPO}`);
  console.log(`[info] model: ${MODEL_TAG}   date: ${DATE_TAG}`);
  console.log(
    `[info] problems: ${targets.length}  source: ${usingFile ? "file" : "hardcoded"}  default repeat: ${args.repeat}`,
  );
  if (Object.keys(args.tierRepeat).length > 0) {
    console.log(`[info] tier repeat overrides: ${JSON.stringify(args.tierRepeat)}`);
  }

  const perProblemRuns: Array<{ p: Problem; persisted: PersistedRun[] }> = [];

  for (const p of targets) {
    const problemDir = join(CURRICULUM_REPO, "runs", DATE_TAG, MODEL_TAG, p.id);
    const repeat = resolveRepeat(p, args);
    console.log(`\n======== ${p.id} [${p.tier}]  (repeat=${repeat}) ========`);
    const persisted: PersistedRun[] = [];
    for (let i = 0; i < repeat; i++) {
      const runIndex = nextRunIndex(problemDir);
      try {
        const run = await runProblem(p, runIndex);
        const sr = await gradeProblem(p, run.answerText, run.advisorCalled);
        const outPath = writeRunFile(p, run, sr, runIndex, problemDir);
        console.log(
          `    [saved] ${outPath}  outcome=${sr.outcome}  should_advisor=${sr.advisor_should_have_been_called}  conf=${sr.confidence_in_answer}`,
        );
        persisted.push({ runIndex, outPath, advisorCalled: run.advisorCalled, sr });
      } catch (e) {
        console.error(`    [error] run-${runIndex} failed: ${(e as Error).message}`);
      }
    }
    writeStats(p, problemDir);
    perProblemRuns.push({ p, persisted });
  }

  console.log("\n======== Pilot summary ========");
  for (const { p, persisted } of perProblemRuns) {
    const n = persisted.length;
    const correct = persisted.filter((r) => r.sr.outcome === "correct").length;
    const wrong = persisted.filter((r) => r.sr.outcome === "wrong").length;
    const advisorNeeded = persisted.filter((r) => r.sr.advisor_should_have_been_called).length;
    const rate = (x: number) => (n === 0 ? "-" : (x / n).toFixed(2));
    console.log(
      `  ${p.id} [${p.tier}]  runs=${n}  correct=${rate(correct)}  wrong=${rate(wrong)}  advisor_needed=${rate(advisorNeeded)}`,
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
