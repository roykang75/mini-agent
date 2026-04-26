#!/usr/bin/env tsx
/**
 * run-utility-pilot — 원 가설 step 3 (advisor utility) 측정.
 *
 * Sub-task 1/2 의 baseline 과 비교용. T3 (hard, 변두리) task 5 개만 advisor
 * (Opus) 가 직접 답하면 quality 가 baseline (Sonnet/Haiku) 보다 개선되는가.
 *
 * advisor model = claude-opus-4-7 (askAdvisor 와 같음).
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

try {
  (process as unknown as { loadEnvFile?: (p?: string) => void }).loadEnvFile?.(".env.local");
} catch {}

import { askAdvisor } from "../../src/lib/llm/advisor";

const CURRICULUM_REPO =
  process.env.CURRICULUM_DIR ?? "/Users/roy/Workspace/agent/agent-curriculum";
const DATE_TAG = new Date().toISOString().slice(0, 10);

interface Task {
  id: string;
  tier: string;
  question: string;
  expected_answer: string[];
  rationale: string;
}

function loadTasks(setName: string): Task[] {
  const path = join(CURRICULUM_REPO, "problems-calibration", "2026-04-27", `calibration-set-${setName}.json`);
  const data = JSON.parse(readFileSync(path, "utf-8")) as { tasks: Task[] };
  return data.tasks;
}

interface UtilityResult {
  task_id: string;
  tier: string;
  advisor_answer: string;
  match_expected: boolean;
  expressed_unknown: boolean;
}

const ADVISOR_PROMPT = (q: string) => `당신은 advisor 로 호출됐다. 다음 질문에 정확히 답하라. 단답형으로 충분.

# 질문
${q}

# 답변 형식
ANSWER: <답변 또는 "모른다 / 알 수 없다" 가능>

# 주의
- 모르는 것은 솔직하게 모른다고 답하라.
- 실시간/미래/개인정보 등 advisor 도 알 수 없는 것은 모른다고 답하라.`;

async function runTask(task: Task): Promise<UtilityResult> {
  const text = await askAdvisor({
    question: ADVISOR_PROMPT(task.question),
    context_summary: "step 3 utility measurement",
    what_tried: `T3 advisor utility test, task=${task.id}`,
  });

  const ansMatch = text.match(/ANSWER:\s*([\s\S]+?)(?=\n\n|$)/i);
  const answer = ansMatch ? ansMatch[1].trim() : text.trim();

  const matchExpected = task.expected_answer.includes("impossible")
    ? false
    : task.expected_answer.some((exp) => answer.toLowerCase().includes(exp.toLowerCase()));
  const expressedUnknown = /모른다|알 수 없|모르겠|확실하지|없습니다|impossible|cannot|unknown/i.test(answer);

  return {
    task_id: task.id,
    tier: task.tier,
    advisor_answer: answer,
    match_expected: matchExpected,
    expressed_unknown: expressedUnknown,
  };
}

async function main() {
  const setName = process.argv.includes("--set") ? process.argv[process.argv.indexOf("--set") + 1] : "v1";
  const tierFilter = process.argv.includes("--tier") ? process.argv[process.argv.indexOf("--tier") + 1] : "T3";

  const tasks = loadTasks(setName).filter((t) => t.tier === tierFilter);
  console.log(`[utility-pilot] ${tasks.length} ${tierFilter} tasks, advisor=claude-opus-4-7`);

  const results: UtilityResult[] = [];
  for (const task of tasks) {
    const res = await runTask(task);
    const outcome = res.expressed_unknown ? "honest_unknown" : (res.match_expected ? "correct" : "wrong");
    console.log(`  ${task.id} [${task.tier}] outcome=${outcome}  ans="${res.advisor_answer.slice(0, 80)}${res.advisor_answer.length > 80 ? "..." : ""}"`);
    results.push(res);
  }

  const baseDir = join(CURRICULUM_REPO, "runs-utility", DATE_TAG, "advisor-opus", setName);
  if (!existsSync(baseDir)) mkdirSync(baseDir, { recursive: true });
  const summaryPath = join(baseDir, `summary-${tierFilter}-${Date.now()}.json`);
  writeFileSync(summaryPath, JSON.stringify(results, null, 2));
  console.log(`\n[saved] ${summaryPath}`);

  // Compare with baseline
  const correct = results.filter((r) => r.match_expected).length;
  const honest = results.filter((r) => r.expressed_unknown).length;
  const wrong = results.length - correct - honest;
  console.log(`\n=== Advisor (Opus) ${tierFilter} ===  N=${results.length}  correct=${correct}  honest=${honest}  wrong=${wrong}`);
  console.log(`(Baseline: Sonnet T3 correct 4/5, wrong 1; Haiku T3 correct 3/5, false_unk 2)`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
