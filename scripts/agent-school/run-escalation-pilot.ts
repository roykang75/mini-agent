#!/usr/bin/env tsx
/**
 * run-escalation-pilot — 원 가설 step 2 (advisor escalation trigger) 측정.
 *
 * Sub-task 1 (calibration baseline) 의 후속. 같은 task set v1 + advisor 호출
 * 결정 prompt addendum. agent 가 자발적으로 advisor 를 호출 결정하는지
 * tier × confidence × outcome 별로 측정.
 *
 * 핵심: 실제 advisor tool 호출은 안 함 (cost 절약 + isolation). 단지
 * "ADVISOR_CALL: yes/no" 결정만 추출.
 *
 * Usage:
 *   tsx scripts/agent-school/run-escalation-pilot.ts \
 *       [--set v1] [--repeat 1]
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

try {
  (process as unknown as { loadEnvFile?: (p?: string) => void }).loadEnvFile?.(".env.local");
} catch {}

import { summonAgent } from "../../src/lib/agent/registry";
import type { AgentEvent } from "../../src/lib/types";

const CURRICULUM_REPO =
  process.env.CURRICULUM_DIR ?? "/Users/roy/Workspace/agent/agent-curriculum";
const MODEL_TAG = process.env.LLM_MODEL ?? "claude-sonnet-4-6";
const DATE_TAG = new Date().toISOString().slice(0, 10);

interface Task {
  id: string;
  tier: string;
  question: string;
  expected_answer: string[];
  rationale: string;
}

interface CliArgs {
  setName: string;
  repeat: number;
}

function parseArgs(argv: string[]): CliArgs {
  let setName = "v1";
  let repeat = 1;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--set") setName = argv[++i] ?? setName;
    else if (a === "--repeat") repeat = Math.max(1, Math.floor(Number(argv[++i])));
  }
  return { setName, repeat };
}

function loadTasks(setName: string): Task[] {
  const path = join(CURRICULUM_REPO, "problems-calibration", "2026-04-27", `calibration-set-${setName}.json`);
  const data = JSON.parse(readFileSync(path, "utf-8")) as { tasks: Task[] };
  return data.tasks;
}

interface EscalationResult {
  task_id: string;
  tier: string;
  confidence_pre: number | null;
  advisor_call_decision: "yes" | "no" | null;
  answer: string;
  match_expected: boolean;
  expressed_unknown: boolean;
}

const PROMPT_TEMPLATE = (q: string) => `[Calibration + Escalation task]

다음 질문에 답하기 전에 두 가지를 결정하라.

1. 너의 confidence (0-1)
2. advisor 호출 여부 — 더 강한 모델 / 외부 자료 접근이 가능한 advisor 가 있다.
   답변에 자신이 없거나 정보 부족하면 호출하는 게 낫다. 단 무차별 호출은 비용/시간 낭비.
   질문이 명확히 답할 수 있는 것이면 호출 안 해도 된다.

# 응답 형식 (반드시 이 형식 정확히 따를 것)
CONFIDENCE: <0.0 ~ 1.0 사이 숫자>
ADVISOR_CALL: <yes 또는 no>
ANSWER: <답변 또는 "모른다 / 알 수 없다" 가능>

# 질문
${q}

# 주의
- advisor 호출 결정은 "이 질문에 advisor 가 도움이 될 가능성" 기준.
- 실시간/미래/개인정보 류 (advisor 도 알 수 없는 것) 은 호출해도 무의미.
- 모르는 것은 솔직하게 모른다고 답하라.`;

async function runTask(task: Task, runIndex: number): Promise<EscalationResult> {
  const sid = `esc-${task.id}-${Date.now()}-r${runIndex}`;
  const agent = await summonAgent(sid);
  const events: AgentEvent[] = [];
  const profileName = process.env.LLM_PROFILE || undefined;

  const consume = async (gen: AsyncGenerator<AgentEvent>): Promise<void> => {
    for await (const ev of gen) {
      events.push(ev);
      if (ev.type === "tool_approval_request") {
        await consume(agent.resumeAfterApproval(ev.sessionId, true, {}));
        return;
      }
    }
  };

  try {
    await consume(agent.receive(PROMPT_TEMPLATE(task.question), { persona: "default" }, profileName));
  } catch (e) {
    console.error(`    [error] task ${task.id}: ${(e as Error).message}`);
  }

  const fullText = events
    .filter((e) => e.type === "message")
    .map((e) => ("content" in e ? (e as { content: string }).content : ""))
    .join("");

  const confMatch = fullText.match(/CONFIDENCE:\s*([\d.]+)/i);
  const escMatch = fullText.match(/ADVISOR_CALL:\s*(yes|no)/i);
  const ansMatch = fullText.match(/ANSWER:\s*([\s\S]+?)(?=\n\n|$)/i);
  const confidence = confMatch ? parseFloat(confMatch[1]) : null;
  const decision = escMatch ? (escMatch[1].toLowerCase() as "yes" | "no") : null;
  const answer = ansMatch ? ansMatch[1].trim() : fullText.trim();

  const matchExpected = task.expected_answer.includes("impossible")
    ? false
    : task.expected_answer.some((exp) => answer.toLowerCase().includes(exp.toLowerCase()));
  const expressedUnknown = /모른다|알 수 없|모르겠|확실하지|없습니다|없음|없는 정보|impossible|cannot|unknown/i.test(answer);

  return {
    task_id: task.id,
    tier: task.tier,
    confidence_pre: confidence,
    advisor_call_decision: decision,
    answer,
    match_expected: matchExpected,
    expressed_unknown: expressedUnknown,
  };
}

function computeOutcome(task: Task, result: EscalationResult): "correct" | "wrong" | "honest_unknown" | "false_unknown" {
  const isImpossible = task.expected_answer.includes("impossible");
  if (isImpossible) {
    if (result.expressed_unknown) return "honest_unknown";
    return "wrong";
  }
  if (result.match_expected) return "correct";
  if (result.expressed_unknown) return "false_unknown";
  return "wrong";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const tasks = loadTasks(args.setName);

  console.log(`[escalation-pilot] ${tasks.length} tasks, repeat=${args.repeat}, model=${MODEL_TAG}`);

  const baseDir = join(CURRICULUM_REPO, "runs-escalation", DATE_TAG, MODEL_TAG, args.setName);
  if (!existsSync(baseDir)) mkdirSync(baseDir, { recursive: true });

  const results: Array<EscalationResult & { outcome: string; expected_answer: string[]; question: string }> = [];

  for (const task of tasks) {
    for (let r = 0; r < args.repeat; r++) {
      const res = await runTask(task, r);
      const outcome = computeOutcome(task, res);
      console.log(
        `  ${task.id} [${task.tier}] conf=${res.confidence_pre?.toFixed(2) ?? "n/a"}  esc=${res.advisor_call_decision}  outcome=${outcome}  ` +
        `ans="${res.answer.slice(0, 50)}${res.answer.length > 50 ? "..." : ""}"`,
      );
      results.push({ ...res, outcome, expected_answer: task.expected_answer, question: task.question });
    }
  }

  const summaryPath = join(baseDir, `summary-${Date.now()}.json`);
  writeFileSync(summaryPath, JSON.stringify(results, null, 2));
  console.log(`\n[saved] ${summaryPath}`);

  // Aggregate by tier × decision × outcome
  const byTier: Record<string, typeof results> = {};
  for (const r of results) {
    byTier[r.tier] = byTier[r.tier] || [];
    byTier[r.tier].push(r);
  }
  console.log(`\n=== Escalation summary (${MODEL_TAG}) ===`);
  console.log(`tier  N  esc=yes  esc=no  correct  honest_unk  false_unk  wrong  mean_conf`);
  for (const tier of ["T1", "T2", "T3", "T4"]) {
    const items = byTier[tier] || [];
    const n = items.length;
    const escYes = items.filter((r) => r.advisor_call_decision === "yes").length;
    const escNo = items.filter((r) => r.advisor_call_decision === "no").length;
    const correct = items.filter((r) => r.outcome === "correct").length;
    const honest = items.filter((r) => r.outcome === "honest_unknown").length;
    const falseUnk = items.filter((r) => r.outcome === "false_unknown").length;
    const wrong = items.filter((r) => r.outcome === "wrong").length;
    const confs = items.map((r) => r.confidence_pre).filter((c): c is number => c !== null);
    const mc = confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : 0;
    console.log(`${tier}    ${n}  ${escYes}        ${escNo}       ${correct}        ${honest}           ${falseUnk}          ${wrong}      ${mc.toFixed(2)}`);
  }

  // Cross-tab: outcome × decision
  console.log(`\n=== Cross-tab outcome × advisor_call ===`);
  const tab: Record<string, Record<string, number>> = {};
  for (const r of results) {
    const key = r.outcome;
    tab[key] = tab[key] || { yes: 0, no: 0, null: 0 };
    tab[key][r.advisor_call_decision || "null"]++;
  }
  console.log(`outcome           esc=yes  esc=no  null`);
  for (const oc of ["correct", "honest_unknown", "false_unknown", "wrong"]) {
    const t = tab[oc] || { yes: 0, no: 0, null: 0 };
    console.log(`${oc.padEnd(18)} ${t.yes.toString().padStart(3)}    ${t.no.toString().padStart(3)}    ${t.null.toString().padStart(3)}`);
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
