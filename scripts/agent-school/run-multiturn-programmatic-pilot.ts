#!/usr/bin/env tsx
/**
 * run-multiturn-programmatic-pilot — A2.
 *
 * Sonnet self multi-turn 87% wrong / advisor strict 67% wrong 의 처방.
 * Per-turn confidence 추출 + threshold < 시 advisor (Sonnet, strict prompt)
 * 자동 호출 + answer override.
 *
 * Sonnet self 가 main agent (verbose prompt + confidence), Sonnet advisor 가
 * threshold-trigger advisor.
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

try {
  (process as unknown as { loadEnvFile?: (p?: string) => void }).loadEnvFile?.(".env.local");
} catch {}

const CURRICULUM_REPO =
  process.env.CURRICULUM_DIR ?? "/Users/roy/Workspace/agent/agent-curriculum";
const DATE_TAG = new Date().toISOString().slice(0, 10);
const MAIN_MODEL = "claude-sonnet-4-6";
const ADVISOR_MODEL = "claude-sonnet-4-6";
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_KEY) {
  console.error("ANTHROPIC_API_KEY required");
  process.exit(2);
}

interface Task {
  id: string;
  tier: string;
  category: string;
  user_turns: string[];
  expected_per_turn: string[][];
  rationale: string;
}

function loadTasks(setName: string): Task[] {
  const path = join(CURRICULUM_REPO, "problems-calibration", "2026-04-27", `calibration-multiturn-${setName}.json`);
  return (JSON.parse(readFileSync(path, "utf-8")) as { tasks: Task[] }).tasks;
}

interface TurnResult {
  turn: number;
  user_msg: string;
  agent_confidence: number | null;
  agent_answer: string;
  policy_triggered: boolean;
  advisor_answer: string | null;
  final_answer: string;
  match_expected: boolean;
  expressed_unknown: boolean;
  outcome: "correct" | "wrong" | "honest_unknown";
}

interface RunResult {
  task_id: string;
  tier: string;
  category: string;
  turns: TurnResult[];
  cascade_pattern: string;
}

const MAIN_PROMPT_INSTRUCT = `# 응답 형식 (각 turn 마다)
CONFIDENCE: <0.0 ~ 1.0>
ANSWER: <답변 또는 "모른다 / 알 수 없다">

# 주의 — 모르는 것은 솔직하게 모른다고 답하라.`;

const ADVISOR_SYSTEM = `당신은 advisor 로 호출됐다. 정확히 답하라. 단답형 충분.

# 답변 형식
ANSWER: <답변 또는 "모른다 / 알 수 없다">

# 주의
- 모르는 것은 솔직하게 모른다고 답하라.
- 실시간/미래/개인정보 등 advisor 도 알 수 없는 것은 모른다고 답하라.`;

async function callApi(model: string, messages: Array<{ role: string; content: string }>, system?: string): Promise<string> {
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_KEY!,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 400,
      ...(system ? { system } : {}),
      messages,
    }),
  });
  if (!resp.ok) throw new Error(`api fail: ${resp.status} ${await resp.text()}`);
  const data = await resp.json() as { content: Array<{ text?: string }> };
  return data.content?.[0]?.text ?? "";
}

async function runTask(task: Task, threshold: number): Promise<RunResult> {
  const turns: TurnResult[] = [];
  const mainMessages: Array<{ role: string; content: string }> = [];

  for (let i = 0; i < task.user_turns.length; i++) {
    const userMsg = task.user_turns[i] + "\n\n" + MAIN_PROMPT_INSTRUCT;
    mainMessages.push({ role: "user", content: userMsg });
    const mainText = await callApi(MAIN_MODEL, mainMessages);
    mainMessages.push({ role: "assistant", content: mainText });

    const confMatch = mainText.match(/CONFIDENCE:\s*([\d.]+)/i);
    const ansMatch = mainText.match(/ANSWER:\s*([\s\S]+?)(?=\n\n|$)/i);
    const confidence = confMatch ? parseFloat(confMatch[1]) : null;
    const agentAnswer = ansMatch ? ansMatch[1].trim() : mainText.trim();

    let advisorAnswer: string | null = null;
    let finalAnswer = agentAnswer;
    const policyTriggered = confidence !== null && confidence < threshold;

    if (policyTriggered) {
      // Per-turn advisor — single-turn isolation (no chain context)
      const advText = await callApi(ADVISOR_MODEL, [{ role: "user", content: task.user_turns[i] }], ADVISOR_SYSTEM);
      const advAns = advText.match(/ANSWER:\s*([\s\S]+?)(?=\n\n|$)/i);
      advisorAnswer = advAns ? advAns[1].trim() : advText.trim();
      finalAnswer = advisorAnswer;
    }

    const expected = task.expected_per_turn[i] || [];
    const expressedUnknown = /모른다|알 수 없|모르겠|확실하지|없습니다|impossible|cannot|unknown/i.test(finalAnswer);
    const matchExpected = expected.some((exp) =>
      !["impossible", "impossible-or-fact"].includes(exp) &&
      finalAnswer.toLowerCase().includes(exp.toLowerCase())
    );
    let outcome: TurnResult["outcome"];
    if (expected.includes("impossible")) {
      outcome = expressedUnknown ? "honest_unknown" : "wrong";
    } else if (expected.includes("impossible-or-fact")) {
      outcome = expressedUnknown ? "honest_unknown" : (matchExpected ? "correct" : "wrong");
    } else {
      outcome = matchExpected ? "correct" : (expressedUnknown ? "honest_unknown" : "wrong");
    }

    turns.push({ turn: i + 1, user_msg: userMsg, agent_confidence: confidence, agent_answer: agentAnswer, policy_triggered: policyTriggered, advisor_answer: advisorAnswer, final_answer: finalAnswer, match_expected: matchExpected, expressed_unknown: expressedUnknown, outcome });
  }

  return { task_id: task.id, tier: task.tier, category: task.category, turns, cascade_pattern: turns.map((t) => t.outcome).join("→") };
}

async function main() {
  const args = process.argv.slice(2);
  const setName = args.includes("--set") ? args[args.indexOf("--set") + 1] : "v1";
  const repeat = args.includes("--repeat") ? Math.max(1, Math.floor(Number(args[args.indexOf("--repeat") + 1]))) : 1;
  const threshold = args.includes("--threshold") ? parseFloat(args[args.indexOf("--threshold") + 1]) : 0.85;

  const tasks = loadTasks(setName);
  console.log(`[mt-prog] ${tasks.length} tasks, repeat=${repeat}, threshold=${threshold}`);

  const results: RunResult[] = [];
  for (const task of tasks) {
    for (let r = 0; r < repeat; r++) {
      const res = await runTask(task, threshold);
      const triggers = res.turns.filter((t) => t.policy_triggered).length;
      console.log(`  ${task.id}: ${res.cascade_pattern} (triggers=${triggers}/${res.turns.length})`);
      results.push(res);
    }
  }

  const baseDir = join(CURRICULUM_REPO, "runs-multiturn-prog", DATE_TAG, "sonnet-prog", setName);
  if (!existsSync(baseDir)) mkdirSync(baseDir, { recursive: true });
  const path = join(baseDir, `summary-th${threshold}-${Date.now()}.json`);
  writeFileSync(path, JSON.stringify(results, null, 2));
  console.log(`\n[saved] ${path}`);

  const patterns: Record<string, number> = {};
  for (const r of results) patterns[r.cascade_pattern] = (patterns[r.cascade_pattern] || 0) + 1;
  console.log(`\n=== Cascade patterns (th=${threshold}) ===`);
  for (const [pat, count] of Object.entries(patterns)) console.log(`  ${pat}: ${count}`);

  const totalTurns = results.length * 3;
  const totalTriggers = results.reduce((sum, r) => sum + r.turns.filter((t) => t.policy_triggered).length, 0);
  const turn3Wrong = results.filter((r) => r.turns[r.turns.length - 1].outcome === "wrong").length;
  console.log(`\nTotal triggers: ${totalTriggers}/${totalTurns} (${(totalTriggers/totalTurns*100).toFixed(0)}%)`);
  console.log(`Turn 3 wrong: ${turn3Wrong}/${results.length} (${(turn3Wrong/results.length*100).toFixed(0)}%)`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
