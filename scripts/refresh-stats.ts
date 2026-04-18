/**
 * Refresh _stats.md files by re-scanning existing run-NN.md files.
 *
 * Used to rebuild stats after invalid runs are removed from the working tree
 * (e.g. fetch_failed batches that leave junk frontmatter but zero content).
 *
 * Usage:
 *   npx tsx scripts/refresh-stats.ts <curriculum-dir> [<problem-id>...]
 */

import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";

interface RunSnapshot {
  run_index: number;
  outcome: "correct" | "partial" | "wrong" | "unknown";
  advisor_called: boolean;
  should_have_called: boolean;
  confidence: number;
  difficulty: string;
}

function parseRun(path: string): RunSnapshot | null {
  const raw = readFileSync(path, "utf-8");
  const parsed = matter(raw);
  const fm = parsed.data as Record<string, unknown>;
  if (!parsed.content.includes("## Sonnet answer")) return null;
  const ansMatch = parsed.content.match(/## Sonnet answer\s*\n+([\s\S]*?)(?=\n## |$)/);
  const answer = ansMatch ? ansMatch[1].trim() : "";
  if (answer.length === 0 || answer === "(empty)") return null;

  const sr =
    (fm.self_reflection as Record<string, unknown> | undefined) ?? {};
  const outcomeRaw = String(sr.outcome ?? "").toLowerCase();
  const outcome: RunSnapshot["outcome"] =
    outcomeRaw === "correct" || outcomeRaw === "partial" || outcomeRaw === "wrong"
      ? outcomeRaw
      : "unknown";

  return {
    run_index: Number(fm.run_index ?? 0),
    outcome,
    advisor_called: Boolean(fm.advisor_called),
    should_have_called: Boolean(sr.advisor_should_have_been_called),
    confidence: Number(sr.confidence_in_answer ?? 0),
    difficulty: String(sr.difficulty_sonnet_felt ?? ""),
  };
}

function regenerateStats(problemDir: string): void {
  const entries = readdirSync(problemDir).filter((f) => /^run-\d+\.md$/.test(f));
  const runs: RunSnapshot[] = [];
  for (const e of entries) {
    const snap = parseRun(join(problemDir, e));
    if (snap) runs.push(snap);
  }
  runs.sort((a, b) => a.run_index - b.run_index);
  if (runs.length === 0) {
    console.log(`  [skip] no valid runs in ${problemDir}`);
    return;
  }

  const pidPath = join(problemDir, "run-" + String(runs[0].run_index).padStart(2, "0") + ".md");
  const firstRun = matter(readFileSync(pidPath, "utf-8")).data as Record<string, unknown>;
  const problem_id = String(firstRun.problem_id ?? "");
  const model = String(firstRun.model ?? "");
  const tier = String(firstRun.tier_opus_predicted ?? "");
  const expectedBehavior = String(firstRun.expected_behavior ?? "");

  const n = runs.length;
  const count = (pred: (r: RunSnapshot) => boolean) =>
    runs.filter(pred).length;
  const correct = count((r) => r.outcome === "correct");
  const partial = count((r) => r.outcome === "partial");
  const wrong = count((r) => r.outcome === "wrong");
  const called = count((r) => r.advisor_called);
  const needed = count((r) => r.should_have_called);
  const mismatch = count((r) => r.advisor_called !== r.should_have_called);
  const meanConf =
    runs.reduce((a, r) => a + r.confidence, 0) / n;
  const round = (x: number) => Math.round(x * 1000) / 1000;

  const header = [
    "---",
    `problem_id: ${problem_id}`,
    `model: ${model}`,
    `tier_opus_predicted: ${tier}`,
    `expected_behavior: ${expectedBehavior}`,
    `runs_total: ${n}`,
    `generated_at: ${new Date().toISOString()}`,
    `aggregate:`,
    `  correct_rate: ${round(correct / n)}`,
    `  partial_rate: ${round(partial / n)}`,
    `  wrong_rate: ${round(wrong / n)}`,
    `  advisor_needed_rate: ${round(needed / n)}`,
    `  advisor_called_rate: ${round(called / n)}`,
    `  behavior_mismatch_rate: ${round(mismatch / n)}`,
    `  mean_confidence: ${round(meanConf)}`,
    "---",
    "",
    `# Stats: ${problem_id}`,
    "",
    `- **tier (Opus 예측)**: ${tier}`,
    `- **expected_behavior**: ${expectedBehavior}`,
    `- **runs**: ${n}`,
    `- **correct/partial/wrong**: ${round(correct / n)} / ${round(partial / n)} / ${round(wrong / n)}`,
    `- **advisor needed / called**: ${round(needed / n)} / ${round(called / n)}`,
    `- **behavior mismatch**: ${round(mismatch / n)}  (needed ↔ called 불일치 비율)`,
    `- **mean confidence**: ${round(meanConf)}`,
    "",
    "## Per-run results",
    "",
    "| run | outcome | advisor_called | should_advisor | confidence | difficulty_felt |",
    "|---|---|---|---|---|---|",
  ];
  const rows = runs.map(
    (r) =>
      `| ${String(r.run_index).padStart(2, "0")} | ${r.outcome} | ${r.advisor_called} | ${r.should_have_called} | ${r.confidence} | ${r.difficulty} |`,
  );
  const body = [...header, ...rows, "", "## Lessons (규약 재생성 시 비어 있음)", ""].join("\n");
  writeFileSync(join(problemDir, "_stats.md"), body + "\n");
  console.log(
    `  [ok] ${problem_id} runs=${n} correct=${round(correct / n)} called=${round(called / n)} mismatch=${round(mismatch / n)} conf=${round(meanConf)}`,
  );
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("usage: refresh-stats.ts <curriculum-dir> [problem-id...]");
    process.exit(1);
  }
  const curriculumDir = args[0];
  const filter = new Set(args.slice(1));
  const runsRoot = join(curriculumDir, "runs");
  if (!existsSync(runsRoot)) {
    console.error(`no runs/ under ${curriculumDir}`);
    process.exit(1);
  }
  for (const date of readdirSync(runsRoot)) {
    const dateDir = join(runsRoot, date);
    if (!statSync(dateDir).isDirectory()) continue;
    for (const model of readdirSync(dateDir)) {
      const modelDir = join(dateDir, model);
      if (!statSync(modelDir).isDirectory()) continue;
      for (const pid of readdirSync(modelDir)) {
        const pdir = join(modelDir, pid);
        const st = statSync(pdir);
        if (!st.isDirectory()) continue;
        if (filter.size > 0 && !filter.has(pid)) continue;
        regenerateStats(pdir);
      }
    }
  }
}

main();
