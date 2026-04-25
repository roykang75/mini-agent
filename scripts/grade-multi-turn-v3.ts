#!/usr/bin/env tsx
/**
 * V3 grade — multi-turn run-NN.md transcript 를 V3 grade-real-session prompt
 * 로 채점. multi-turn pilot 이 raw+episode pair 생성 안 하므로 별도 validator.
 *
 * Usage:
 *   npx tsx scripts/grade-multi-turn-v3.ts <run-md-path> [<run-md-path>...]
 *
 * 환경:
 *   - .env.local 의 ANTHROPIC_API_KEY (askAdvisor → Opus)
 *   - GRADE_PROMPT_VERSION=grade-real-session-v3 (기본)
 */

import { readFile } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import matter from "gray-matter";

try {
  (process as unknown as { loadEnvFile?: (p?: string) => void }).loadEnvFile?.(".env.local");
} catch {
  // no-op
}

import { askAdvisor } from "../src/lib/llm/advisor";

const PROMPT_VERSION = process.env.GRADE_PROMPT_VERSION ?? "grade-real-session-v3";
const CURRICULUM_REPO =
  process.env.CURRICULUM_DIR ?? "/Users/roy/Workspace/agent/agent-curriculum";

interface V3Result {
  transcript_status: string;
  cells_observed: Array<{
    cell_id: string;
    domain: string;
    outcome_opus_rubric: string;
    confidence_gap: number;
    context_source_check: {
      external_context_present: boolean;
      external_context_kind: string;
      agent_treated_as_verified: boolean | string;
    };
    cascade_risk_marker?: {
      specific_entity_cited: boolean;
      citation_form: string;
      vector_risk_for_future_retrieval: boolean;
    };
  }>;
  gap_vs_self_summary: string;
}

async function gradeOne(runPath: string, prompt: string): Promise<{ runPath: string; v2Self: string; v3: V3Result | null; error?: string }> {
  const content = await readFile(runPath, "utf-8");
  const parsed = matter(content);
  const fm = parsed.data as Record<string, unknown>;

  const v2Self = ((fm.self_reflection as Record<string, unknown> | undefined)?.outcome ?? "?") as string;

  const transcript = parsed.content;

  const userMessage = `<session_meta>
problem_id: ${fm.problem_id}
model: ${fm.model}
run_index: ${fm.run_index}
multi_turn: true
turn_count: ${fm.turn_count}
</session_meta>

<raw_session>
${transcript}
</raw_session>

<episode>
self_reflection (1인칭 자기-채점, V2 grader 가 생성):
- outcome: ${v2Self}
- difficulty_felt: ${(fm.self_reflection as Record<string, unknown> | undefined)?.difficulty_felt ?? "?"}
- actual_behavior: ${(fm.self_reflection as Record<string, unknown> | undefined)?.actual_behavior ?? "?"}
- confidence_in_answer: ${(fm.self_reflection as Record<string, unknown> | undefined)?.confidence_in_answer ?? "?"}
- lesson: ${(fm.self_reflection as Record<string, unknown> | undefined)?.lesson ?? "?"}

(consolidate-v2 episode 가 없는 multi-turn pilot run. self_reflection 만 입력으로
받음. transcript_status 평가 시 transcript 자체를 기준으로 삼을 것.)
</episode>`;

  const fullPrompt = `<prompt_instructions>
${prompt}
</prompt_instructions>

${userMessage}

위 prompt_instructions 의 채점 기준으로 transcript 를 평가해 정확히 하나의 JSON code block 만 출력하라.`;

  let text: string;
  try {
    text = await askAdvisor({
      question: fullPrompt,
      context_summary: `multi-turn V3 grade — ${runPath.split("/").slice(-3).join("/")}`,
      what_tried: "V2 self-reflection 외 외부 채점 미실시",
    });
  } catch (e) {
    return { runPath, v2Self, v3: null, error: (e as Error).message };
  }

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return { runPath, v2Self, v3: null, error: "JSON not found in advisor response" };
  }
  try {
    const v3 = JSON.parse(jsonMatch[0]) as V3Result;
    return { runPath, v2Self, v3 };
  } catch (e) {
    return { runPath, v2Self, v3: null, error: `JSON parse: ${(e as Error).message}` };
  }
}

async function main() {
  const promptPath = join(CURRICULUM_REPO, "prompts", `${PROMPT_VERSION}.md`);
  const prompt = await readFile(promptPath, "utf-8");

  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("usage: npx tsx scripts/grade-multi-turn-v3.ts <run-md-path>...");
    process.exit(2);
  }

  console.log(`[v3-grade] prompt=${PROMPT_VERSION}  inputs=${args.length}\n`);

  const results: Awaited<ReturnType<typeof gradeOne>>[] = [];
  for (const arg of args) {
    const path = resolve(arg);
    process.stdout.write(`  ${path.split("/").slice(-3).join("/")} ... `);
    const result = await gradeOne(path, prompt);
    if (result.error) {
      console.log(`error: ${result.error}`);
    } else if (result.v3) {
      const cells = result.v3.cells_observed.length;
      const outcomes = result.v3.cells_observed.map((c) => c.outcome_opus_rubric).join("/");
      const cascadeRisk = result.v3.cells_observed.some(
        (c) => c.cascade_risk_marker?.vector_risk_for_future_retrieval === true,
      );
      console.log(
        `v2_self=${result.v2Self} v3=${outcomes}  status=${result.v3.transcript_status}  cells=${cells}  cascade_risk=${cascadeRisk}`,
      );
    }
    results.push(result);
  }

  console.log("\n[summary]");
  const v2Counts: Record<string, number> = {};
  const v3Counts: Record<string, number> = {};
  let cascadeRiskCount = 0;
  for (const r of results) {
    v2Counts[r.v2Self] = (v2Counts[r.v2Self] ?? 0) + 1;
    if (r.v3) {
      const dominant = r.v3.cells_observed[0]?.outcome_opus_rubric ?? "n/a";
      v3Counts[dominant] = (v3Counts[dominant] ?? 0) + 1;
      if (r.v3.cells_observed.some((c) => c.cascade_risk_marker?.vector_risk_for_future_retrieval === true)) {
        cascadeRiskCount++;
      }
    }
  }
  console.log("  v2 self-grade:", v2Counts);
  console.log("  v3 (Opus):    ", v3Counts);
  console.log(`  cascade_risk:  ${cascadeRiskCount}/${results.length} (entity 인용된 episode 비율)`);

  console.log("\n[detail summaries]");
  for (const r of results) {
    if (r.v3) {
      console.log(`\n  ${r.runPath.split("/").slice(-3).join("/")}`);
      console.log(`  → ${r.v3.gap_vs_self_summary.slice(0, 200)}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
