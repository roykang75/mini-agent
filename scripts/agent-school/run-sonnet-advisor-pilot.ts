#!/usr/bin/env tsx
/**
 * run-sonnet-advisor-pilot — J 후보. Sonnet 이 advisor 역할 직접 답변.
 * utility-pilot 의 fork — model = claude-sonnet-4-6 (Opus 대신).
 *
 * 운영 비용 절감 차원 — Sonnet 이 advisor 로 충분한지 (cal v2 96% 기반) 직접 검증.
 *
 * Usage:
 *   tsx scripts/agent-school/run-sonnet-advisor-pilot.ts --set v2 --tier T3
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

try {
  (process as unknown as { loadEnvFile?: (p?: string) => void }).loadEnvFile?.(".env.local");
} catch {}

const CURRICULUM_REPO =
  process.env.CURRICULUM_DIR ?? "/Users/roy/Workspace/agent/agent-curriculum";
const DATE_TAG = new Date().toISOString().slice(0, 10);
const ADVISOR_MODEL = "claude-sonnet-4-6";
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_KEY) {
  console.error("ANTHROPIC_API_KEY required");
  process.exit(2);
}

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

interface Result {
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

async function callSonnet(prompt: string): Promise<string> {
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_KEY!,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: ADVISOR_MODEL,
      max_tokens: 300,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!resp.ok) throw new Error(`sonnet advisor fail: ${resp.status} ${await resp.text()}`);
  const data = await resp.json() as { content: Array<{ text?: string }> };
  return data.content?.[0]?.text ?? "";
}

async function runTask(task: Task): Promise<Result> {
  const text = await callSonnet(ADVISOR_PROMPT(task.question));
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
  console.log(`[sonnet-advisor-pilot] ${tasks.length} ${tierFilter} tasks (set ${setName}), advisor=${ADVISOR_MODEL}`);

  const results: Result[] = [];
  for (const task of tasks) {
    const res = await runTask(task);
    const outcome = res.expressed_unknown ? "honest_unknown" : (res.match_expected ? "correct" : "wrong");
    console.log(`  ${task.id} [${task.tier}] outcome=${outcome}  ans="${res.advisor_answer.slice(0, 80)}${res.advisor_answer.length > 80 ? "..." : ""}"`);
    results.push(res);
  }

  const baseDir = join(CURRICULUM_REPO, "runs-utility", DATE_TAG, "advisor-sonnet", setName);
  if (!existsSync(baseDir)) mkdirSync(baseDir, { recursive: true });
  const summaryPath = join(baseDir, `summary-${tierFilter}-${Date.now()}.json`);
  writeFileSync(summaryPath, JSON.stringify(results, null, 2));
  console.log(`\n[saved] ${summaryPath}`);

  const correct = results.filter((r) => r.match_expected).length;
  const honest = results.filter((r) => r.expressed_unknown).length;
  const wrong = results.length - correct - honest;
  console.log(`\n=== Advisor (Sonnet) ${tierFilter} ===  N=${results.length}  correct=${correct}  honest=${honest}  wrong=${wrong}`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
