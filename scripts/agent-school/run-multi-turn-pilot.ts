#!/usr/bin/env tsx
/**
 * run-multi-turn-pilot — actual multi-turn pilot. 시뮬 trap (pr004-008) 의 한계
 * 돌파. 같은 sid 에 USER turn 시퀀스를 sequential 로 receive() 호출. 각 turn
 * 의 ASSISTANT response 가 actual model output (시뮬 텍스트 아님). 마지막
 * turn 의 응답을 outcome 평가 대상으로 채점.
 *
 * Problem schema:
 *   problem_id, tier, category, expected_behavior, created_at, created_by,
 *   user_turns: string[],   # USER 발언 시퀀스
 *   final_question: string  # 마지막 USER turn (가장 critical, outcome 측정점)
 *   answer_rubric: string   # 마지막 응답 평가 기준
 *   why_this_tier: string
 *
 * Usage:
 *   tsx scripts/agent-school/run-multi-turn-pilot.ts \
 *       [--problem ID] [--repeat N] [--source file]
 *
 * Env:
 *   LLM_PROFILE=claude-sonnet-4-6   # cross-model 비교 시
 *   LLM_MODEL=claude-sonnet-4-6-real # output 디렉토리 tag
 */

import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import matter from "gray-matter";

// .env.local
try {
  (process as unknown as { loadEnvFile?: (p?: string) => void }).loadEnvFile?.(".env.local");
} catch {
  // no-op
}

import { summonAgent } from "../../src/lib/agent/registry";
import type { AgentEvent } from "../../src/lib/types";
import { askAdvisor } from "../../src/lib/llm/advisor";

const CURRICULUM_REPO =
  process.env.CURRICULUM_DIR ?? "/Users/roy/Workspace/agent/agent-curriculum";
const MODEL_TAG = process.env.LLM_MODEL ?? "claude-sonnet-4-6";
const DATE_TAG = new Date().toISOString().slice(0, 10);

interface CliArgs {
  repeat: number;
  problemFilter: string | null;
}

interface MultiTurnProblem {
  id: string;
  tier: string;
  category: string;
  expected_behavior: string;
  user_turns: string[];
  final_question: string;
  answer_rubric: string;
  why_this_tier: string;
}

interface TurnResult {
  user: string;
  assistant: string;
  events: AgentEvent[];
}

interface RunOutcome {
  sid: string;
  turns: TurnResult[];
  finalAnswer: string;
  advisorCalled: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  let repeat = 3;
  let problemFilter: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repeat") {
      repeat = Math.max(1, Math.floor(Number(argv[++i])));
    } else if (a === "--problem") {
      problemFilter = argv[++i] ?? null;
    }
  }
  return { repeat, problemFilter };
}

function loadProblems(): MultiTurnProblem[] {
  const dir = join(CURRICULUM_REPO, "problems-multi-turn");
  if (!existsSync(dir)) return [];
  const out: MultiTurnProblem[] = [];
  for (const date of readdirSync(dir)) {
    const sub = join(dir, date);
    if (!statSync(sub).isDirectory()) continue;
    for (const file of readdirSync(sub)) {
      if (!file.endsWith(".md")) continue;
      const text = readFileSync(join(sub, file), "utf-8");
      const fm = matter(text).data as Record<string, unknown>;
      if (typeof fm.problem_id !== "string") continue;
      const turns = fm.user_turns as string[] | undefined;
      if (!Array.isArray(turns) || turns.length === 0) continue;
      out.push({
        id: fm.problem_id,
        tier: String(fm.tier ?? "unknown"),
        category: String(fm.category ?? "uncategorized"),
        expected_behavior: String(fm.expected_behavior ?? ""),
        user_turns: turns,
        final_question: String(fm.final_question ?? turns[turns.length - 1]),
        answer_rubric: String(fm.answer_rubric ?? ""),
        why_this_tier: String(fm.why_this_tier ?? ""),
      });
    }
  }
  return out;
}

async function runProblem(p: MultiTurnProblem, runIndex: number): Promise<RunOutcome> {
  const sid = `mt-${p.id}-${Date.now()}-r${runIndex}`;
  const agent = await summonAgent(sid);
  const turns: TurnResult[] = [];
  let advisorCalled = false;

  console.log(`  [run-${runIndex.toString().padStart(2, "0")}] sid=${sid}, ${p.user_turns.length} turns`);

  const profileName = process.env.LLM_PROFILE || undefined;

  for (let i = 0; i < p.user_turns.length; i++) {
    const userMsg = p.user_turns[i];
    const turnEvents: AgentEvent[] = [];

    const consumeGenerator = async (gen: AsyncGenerator<AgentEvent>): Promise<void> => {
      for await (const ev of gen) {
        turnEvents.push(ev);
        if (ev.type === "tool_call" && (ev as { name?: string }).name === "ask-advisor") {
          advisorCalled = true;
        }
        if (ev.type === "tool_approval_request") {
          await consumeGenerator(agent.resumeAfterApproval(ev.sessionId, true, {}));
          return;
        }
      }
    };

    try {
      await consumeGenerator(agent.receive(userMsg, { persona: "default" }, profileName));
    } catch (e) {
      console.error(`    [error] turn ${i + 1}: ${(e as Error).message}`);
    }

    const assistantMsg = turnEvents
      .filter((e) => e.type === "message")
      .map((e) => ("content" in e ? (e as { content: string }).content : ""))
      .join("");

    turns.push({ user: userMsg, assistant: assistantMsg, events: turnEvents });
    console.log(`    turn ${i + 1}: USER (${userMsg.length}c) -> ASSISTANT (${assistantMsg.length}c)`);
  }

  const finalAnswer = turns[turns.length - 1]?.assistant ?? "";
  return { sid, turns, finalAnswer, advisorCalled };
}

interface SelfReflection {
  outcome: "correct" | "partial" | "wrong";
  difficulty_felt: string;
  actual_behavior: string;
  advisor_should_have_been_called: boolean;
  confidence_in_answer: number;
  lesson: string;
}

async function selfGrade(p: MultiTurnProblem, outcome: RunOutcome): Promise<SelfReflection> {
  const transcript = outcome.turns
    .map((t, i) => `[Turn ${i + 1}]\nUSER: ${t.user}\nASSISTANT: ${t.assistant}`)
    .join("\n\n");

  const prompt = `당신은 방금 사용자와 ${outcome.turns.length} 턴 대화를 했고, 마지막 응답이 'final answer' 입니다. 자기 답변을 다음 rubric 으로 채점하세요. JSON 만 출력:

{
  "outcome": "correct" | "partial" | "wrong",
  "difficulty_felt": "low" | "medium" | "high",
  "actual_behavior": "<짧은 설명>",
  "advisor_should_have_been_called": true | false,
  "confidence_in_answer": 0.0~1.0,
  "lesson": "<짧은 학습 내용>"
}

# 대화 transcript
${transcript}

# rubric
${p.answer_rubric}

# 측정 대상
final answer (마지막 ASSISTANT 응답) 가 rubric 의 정답 / partial / wrong 중 어디에 해당하는가.`;

  const text = await askAdvisor({
    question: prompt,
    context_summary: "multi-turn pilot self-grade",
    what_tried: "agent ran multi-turn dialogue, now reflecting on final answer",
  });
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return {
      outcome: "wrong",
      difficulty_felt: "high",
      actual_behavior: "JSON parse failed",
      advisor_should_have_been_called: false,
      confidence_in_answer: 0.0,
      lesson: "self-grade JSON parse failed: " + text.slice(0, 200),
    };
  }
  try {
    return JSON.parse(jsonMatch[0]) as SelfReflection;
  } catch {
    return {
      outcome: "wrong",
      difficulty_felt: "high",
      actual_behavior: "JSON parse error",
      advisor_should_have_been_called: false,
      confidence_in_answer: 0.0,
      lesson: "self-grade JSON parse error",
    };
  }
}

function nextRunIndex(dir: string): number {
  if (!existsSync(dir)) return 1;
  const nums = readdirSync(dir)
    .filter((f) => /^run-\d+\.md$/.test(f))
    .map((f) => parseInt(f.match(/^run-(\d+)\.md$/)?.[1] ?? "0", 10));
  return nums.length === 0 ? 1 : Math.max(...nums) + 1;
}

function writeRunFile(p: MultiTurnProblem, outcome: RunOutcome, reflection: SelfReflection, runIndex: number, dir: string): string {
  const transcript = outcome.turns
    .map((t, i) => `### Turn ${i + 1}\n\n**USER**: ${t.user}\n\n**ASSISTANT**: ${t.assistant}`)
    .join("\n\n");

  const yaml = `---
problem_id: ${p.id}
model: ${MODEL_TAG}
run_index: ${runIndex}
ran_at: ${new Date().toISOString()}
session_sid: ${outcome.sid}
category: ${p.category}
tier_opus_predicted: ${p.tier}
expected_behavior: ${p.expected_behavior}
advisor_called: ${outcome.advisorCalled}
multi_turn: true
turn_count: ${outcome.turns.length}
self_reflection:
  outcome: ${reflection.outcome}
  difficulty_felt: ${reflection.difficulty_felt}
  actual_behavior: ${JSON.stringify(reflection.actual_behavior)}
  advisor_should_have_been_called: ${reflection.advisor_should_have_been_called}
  confidence_in_answer: ${reflection.confidence_in_answer}
  lesson: ${JSON.stringify(reflection.lesson)}
---

# Multi-turn run: ${p.id} #${runIndex}

## Transcript

${transcript}

## Final answer rubric

${p.answer_rubric}

## Verdict

- outcome: **${reflection.outcome}**
- difficulty_felt: ${reflection.difficulty_felt}
- actual_behavior: ${reflection.actual_behavior}
- advisor_should_have_been_called: ${reflection.advisor_should_have_been_called}
- confidence_in_answer: ${reflection.confidence_in_answer}

## Lesson

${reflection.lesson}
`;

  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const file = join(dir, `run-${runIndex.toString().padStart(2, "0")}.md`);
  writeFileSync(file, yaml);
  return file;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const problems = loadProblems().filter(
    (p) => !args.problemFilter || p.id === args.problemFilter,
  );
  if (problems.length === 0) {
    console.error("No multi-turn problems found.");
    process.exit(2);
  }

  console.log(`[mt-pilot] ${problems.length} problems, repeat=${args.repeat}, model=${MODEL_TAG}`);

  for (const p of problems) {
    console.log(`\n======== ${p.id} [${p.tier}] (repeat=${args.repeat}) ========`);
    const baseDir = join(CURRICULUM_REPO, "runs", DATE_TAG, MODEL_TAG, p.id);

    for (let r = 0; r < args.repeat; r++) {
      const runIndex = nextRunIndex(baseDir) ;
      const outcome = await runProblem(p, runIndex);
      const reflection = await selfGrade(p, outcome);
      const file = writeRunFile(p, outcome, reflection, runIndex, baseDir);
      console.log(`    [saved] ${file}  outcome=${reflection.outcome}  conf=${reflection.confidence_in_answer}`);
    }
  }

  console.log(`\n[mt-pilot] all done.`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
