/**
 * ADR-006 Phase A pilot — 3 문제 hand-crafted curriculum 을 end-to-end 돌려서
 * pipeline 검증. 자동 generation 은 다음 단계.
 *
 *   1. 3 problems (tier: easy / medium / hard) 정의
 *   2. 각 문제를 fresh AgentInstance 에 receive, 이벤트 수집 (ask_advisor
 *      호출 시 자동 approve)
 *   3. Opus (askAdvisor) 로 채점 → self_reflection JSON 생성
 *   4. agent-memory/episodes/curriculum/<problem_id>.md 로 training episode
 *      저장
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { summonAgent, disposeAgent } from "../../src/lib/agent/registry";
import { askAdvisor } from "../../src/lib/llm/advisor";
import type { AgentEvent } from "../../src/lib/types";

// Isolate memory dir (memory/raw.ts reads this lazily — OK to set before main).
const REAL_MEMORY_DIR =
  process.env.AGENT_MEMORY_DIR ?? "/Users/roy/Workspace/agent/agent-memory";
const CURRICULUM_MEMORY_DIR = join(REAL_MEMORY_DIR, "curriculum");
process.env.AGENT_MEMORY_DIR = CURRICULUM_MEMORY_DIR;
mkdirSync(join(CURRICULUM_MEMORY_DIR, "raw"), { recursive: true });

// Inline env loader for .env.local (tsx doesn't load Next's env).
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

const PROBLEMS: Problem[] = [
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

// -------- Run single problem --------

async function runProblem(p: Problem): Promise<{
  events: AgentEvent[];
  answerText: string;
  advisorCalled: boolean;
  sid: string;
}> {
  const sid = `curr-${p.id}-${Date.now()}`;
  const agent = await summonAgent(sid);
  const events: AgentEvent[] = [];

  console.log(`\n========================================`);
  console.log(`[${p.id}] tier=${p.tier} category=${p.category}`);
  console.log(`[prompt] ${p.prompt.slice(0, 100)}...`);

  async function consumeGenerator(gen: AsyncGenerator<AgentEvent>): Promise<void> {
    for await (const ev of gen) {
      events.push(ev);
      if (ev.type === "tool_approval_request") {
        console.log(`  [auto-approve] ${ev.toolCalls.map((t) => t.name).join(", ")}`);
        await consumeGenerator(
          agent.resumeAfterApproval(ev.sessionId, true, {}),
        );
        return;
      }
    }
  }

  try {
    await consumeGenerator(agent.receive(p.prompt, { persona: "default" }));
  } catch (e) {
    console.error(`  [error] receive threw: ${(e as Error).message}`);
  }

  const answerText = events
    .filter((e) => e.type === "message")
    .map((e) => ("content" in e ? (e as { content: string }).content : ""))
    .join("\n");
  const advisorCalled = events.some(
    (e) => e.type === "tool_call" && "name" in e && (e as { name: string }).name === "ask_advisor",
  );

  console.log(`  [events] ${events.length}  [advisor_called] ${advisorCalled}`);
  console.log(`  [answer] ${answerText.slice(0, 150).replace(/\n/g, " ")}...`);

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

  const __filename_self = fileURLToPath(import.meta.url);
  const __dirname_self = dirname(__filename_self);
  const gradePromptPath = resolve(__dirname_self, "../../prompts/grade-curriculum-v1.md");
  const gradeSystem = readFileSync(gradePromptPath, "utf8");

  const response = await askAdvisor(
    {
      question:
        "위 답변을 채점하고 self_reflection JSON 을 출력해주세요. 지시된 schema 엄수.",
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    console.warn(`[grade parse] failed — raw response saved, using fallback`);
    parsed = {
      outcome: "partial",
      difficulty_sonnet_felt: "medium",
      actual_behavior: "other",
      advisor_should_have_been_called: false,
      confidence_in_answer: 0.5,
      lesson: `채점 파싱 실패. raw: ${response.slice(0, 200)}`,
    };
  }
  return parsed as SelfReflection;
}

// -------- Write training episode --------

function writeEpisode(
  p: Problem,
  answerText: string,
  advisorCalled: boolean,
  sr: SelfReflection,
  sid: string,
): string {
  const episodesDir = join(CURRICULUM_MEMORY_DIR, "episodes", "curriculum");
  mkdirSync(episodesDir, { recursive: true });
  const outPath = join(episodesDir, `${p.id}.md`);

  const frontmatter = [
    "---",
    `problem_id: ${p.id}`,
    `training_source: curriculum`,
    `session_sid: ${sid}`,
    `category: ${p.category}`,
    `tier_opus_predicted: ${p.tier}`,
    `expected_behavior: ${p.expected_behavior}`,
    `advisor_called: ${advisorCalled}`,
    `self_reflection:`,
    `  outcome: ${sr.outcome}`,
    `  difficulty_sonnet_felt: ${sr.difficulty_sonnet_felt}`,
    `  actual_behavior: ${sr.actual_behavior}`,
    `  advisor_should_have_been_called: ${sr.advisor_should_have_been_called}`,
    `  confidence_in_answer: ${sr.confidence_in_answer}`,
    `  lesson: ${JSON.stringify(sr.lesson)}`,
    "---",
    "",
    `# Training episode: ${p.id}`,
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
    answerText || "(empty)",
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

// -------- Main --------

async function main() {
  console.log(`[info] curriculum memory dir: ${CURRICULUM_MEMORY_DIR}`);
  console.log(`[info] problems: ${PROBLEMS.length}`);

  const results: Array<{
    problem: Problem;
    sr: SelfReflection;
    outPath: string;
  }> = [];

  for (const p of PROBLEMS) {
    const run = await runProblem(p);
    const sr = await gradeProblem(p, run.answerText, run.advisorCalled);
    const outPath = writeEpisode(p, run.answerText, run.advisorCalled, sr, run.sid);
    results.push({ problem: p, sr, outPath });
    console.log(`  [episode] ${outPath}`);
    console.log(`  [verdict] outcome=${sr.outcome}  advisor_should=${sr.advisor_should_have_been_called}`);
  }

  console.log("\n========================================");
  console.log("Pilot summary:");
  for (const r of results) {
    console.log(
      `  ${r.problem.id} [${r.problem.tier}] → ${r.sr.outcome} (should_advisor=${r.sr.advisor_should_have_been_called}, confidence=${r.sr.confidence_in_answer})`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
