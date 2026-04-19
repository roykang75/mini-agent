/**
 * ADR-006-v2 Phase 1 — self-map.md 생성기
 *
 * `agent-curriculum/runs/<date>/<model>/<problem_id>/_stats.md` 를 스캔해
 * 모델별 profile (L3 default 지도) 을 markdown 으로 생성한다.
 *
 * 원칙 (ADR-006-v2):
 * - 명령조 금지 — "호출하라" 대신 "관측된 습관은 이렇다"
 * - 기존 run 데이터 재사용 (curriculum 은 교재가 아닌 scanner)
 *
 * Usage:
 *   npx tsx scripts/profile/generate-self-map.ts
 *
 * 대상 모델 (Roy 결정 2026-04-19):
 *   - claude-sonnet-4-6
 *   - claude-haiku-4-5-20251001
 *   - gpt-5.4
 *   - gpt-4o
 *
 * 출력: agent-curriculum/profiles/<model>/self-map.md
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const CURRICULUM_REPO = "/Users/roy/Workspace/agent/agent-curriculum";
const RUNS_ROOT = join(CURRICULUM_REPO, "runs");
const PROFILES_ROOT = join(CURRICULUM_REPO, "profiles");

// --- Roy 결정 2026-04-19: 대상 모델 ---
const TARGET_MODELS = [
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
  "gpt-5.4",
  "gpt-4o",
];

// --- Seed 문제 metadata (hand-maintained; 문제 내용은 immutable R1) ---
const PROBLEM_META: Record<string, { domain: string; short: string }> = {
  // easy
  "curr-2026-04-18-e001": {
    domain: "factual_basic",
    short: "물의 어는점/끓는점 (기초 사실 recall)",
  },
  "curr-2026-04-18-e002": {
    domain: "math_arithmetic",
    short: "17 × 24 산수 (단순 계산)",
  },
  // medium
  "curr-2026-04-18-m001": {
    domain: "coding_idiom",
    short: "Python list dedupe with order-preserve (관용 구문)",
  },
  "curr-2026-04-18-m002": {
    domain: "reasoning_lateral",
    short: "양초 3/2 문제 (lateral thinking, trick question)",
  },
  "curr-2026-04-18-m003": {
    domain: "factual_protocol",
    short: "TCP vs UDP 핵심 차이 3가지 (프로토콜 사실 recall)",
  },
  // hard
  "curr-2026-04-18-h001": {
    domain: "math_proof",
    short: "Cauchy 함수방정식 — 선형함수 증명 (다단계 해석학)",
  },
  "curr-2026-04-18-h002": {
    domain: "coding_runtime",
    short: "asyncio.gather 예외 전파 의미론 (runtime 의미론)",
  },
  "curr-2026-04-18-h003": {
    domain: "philosophy_meta_ethics",
    short: "규칙 공리주의 + collapse objection (학술용어 요구)",
  },
  // ambiguous
  "curr-2026-04-18-x001": {
    domain: "reasoning_disambiguation",
    short: "'Apple' 참조 모호 (사용자 의도 확인 필요)",
  },
  // out-of-scope
  "curr-2026-04-18-o001": {
    domain: "factual_realtime",
    short: "현재 한국 기준금리 (모델 cutoff 너머의 실시간 정보)",
  },
};

interface StatsAggregate {
  correct_rate: number;
  partial_rate: number;
  wrong_rate: number;
  advisor_needed_rate: number;
  advisor_called_rate: number;
  behavior_mismatch_rate: number;
  mean_confidence: number;
  runs_total: number;
}

function parseStatsFile(path: string): StatsAggregate | null {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return null;
  const body = fm[1];
  const get = (key: string): number => {
    const m = new RegExp(`^\\s*${key}:\\s*(.*)$`, "m").exec(body);
    return m ? Number(m[1].trim()) : 0;
  };
  return {
    correct_rate: get("correct_rate"),
    partial_rate: get("partial_rate"),
    wrong_rate: get("wrong_rate"),
    advisor_needed_rate: get("advisor_needed_rate"),
    advisor_called_rate: get("advisor_called_rate"),
    behavior_mismatch_rate: get("behavior_mismatch_rate"),
    mean_confidence: get("mean_confidence"),
    runs_total: get("runs_total"),
  };
}

function classifyDefault(rate: number): "solve_direct" | "mostly_advisor" | "flexible" {
  if (rate <= 0.25) return "solve_direct";
  if (rate >= 0.75) return "mostly_advisor";
  return "flexible";
}

function buildNote(s: StatsAggregate): string {
  const parts: string[] = [];
  const def = classifyDefault(s.advisor_called_rate);
  if (def === "solve_direct") parts.push("자체 풀이 경향");
  else if (def === "mostly_advisor") parts.push("도움 요청 우선");
  else parts.push("상황별 혼용");

  if (s.correct_rate < 0.5) parts.push("위험 cell — 자체 풀이 실패가 더 잦음");
  else if (s.correct_rate >= 0.9) parts.push("안정 cell — 전략이 실제로 먹힘");

  if (s.behavior_mismatch_rate >= 0.5)
    parts.push("rubric 기준과 자기 판단 괴리가 크다 — 현 상황 재점검 권장");
  else if (s.behavior_mismatch_rate === 0 && s.advisor_needed_rate > 0)
    parts.push("rubric 과 자기 판단이 일치 — 이 도메인은 self-aware");

  return parts.join(". ") + ".";
}

function findRunsDateForModel(model: string, problemId: string): string | null {
  // runs/<date>/<model>/<problem_id>/_stats.md 를 찾음. 여러 date 면 최신 선택.
  if (!existsSync(RUNS_ROOT)) return null;
  const dates = readdirSync(RUNS_ROOT).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse();
  for (const date of dates) {
    const statsPath = join(RUNS_ROOT, date, model, problemId, "_stats.md");
    if (existsSync(statsPath)) return date;
  }
  return null;
}

interface CellData {
  problem_id: string;
  domain: string;
  short: string;
  source_date: string;
  stats: StatsAggregate;
  default_behavior: string;
  note: string;
}

function collectCellsForModel(model: string): CellData[] {
  const cells: CellData[] = [];
  for (const [problemId, meta] of Object.entries(PROBLEM_META)) {
    const date = findRunsDateForModel(model, problemId);
    if (!date) {
      console.log(`  [skip] ${model} / ${problemId} — no _stats.md found`);
      continue;
    }
    const statsPath = join(RUNS_ROOT, date, model, problemId, "_stats.md");
    const stats = parseStatsFile(statsPath);
    if (!stats) {
      console.log(`  [skip] ${model} / ${problemId} — parse failed`);
      continue;
    }
    cells.push({
      problem_id: problemId,
      domain: meta.domain,
      short: meta.short,
      source_date: date,
      stats,
      default_behavior: classifyDefault(stats.advisor_called_rate),
      note: buildNote(stats),
    });
  }
  return cells;
}

function renderSelfMap(model: string, cells: CellData[], allModelCells: Map<string, CellData[]>): string {
  const now = new Date().toISOString();
  const lines: string[] = [];

  // Frontmatter
  lines.push("---");
  lines.push(`model: ${model}`);
  lines.push(`generated_at: ${now}`);
  lines.push(`adr: ADR-006-v2-experiential-self-map`);
  lines.push(`cell_count: ${cells.length}`);
  lines.push(`seed_problems: [${cells.map((c) => c.problem_id).join(", ")}]`);
  lines.push("---");
  lines.push("");

  lines.push(`# Self-map: ${model}`);
  lines.push("");
  lines.push(
    "> 이 문서는 과거 N-run 관측에서 드러난 **너의 습관** (L3 default) 이다. **명령이 아니다.** 새 질문이 왔을 때 비슷한 cell 인지 먼저 보고, 이번 상황에 그 습관이 맞는지 **스스로 판단**하라. 편향을 인식하는 것이 목적이지, 습관대로 행동하는 게 목적이 아니다.",
  );
  lines.push("");

  lines.push("## Cells");
  lines.push("");

  for (const [i, cell] of cells.entries()) {
    lines.push(`### ${i + 1}. ${cell.problem_id} — ${cell.short}`);
    lines.push("");
    lines.push(`- **domain**: ${cell.domain}`);
    lines.push(`- **default_behavior (관측)**: ${cell.default_behavior}`);
    lines.push(
      `- **advisor_called_rate**: ${cell.stats.advisor_called_rate.toFixed(3)} (${cell.stats.runs_total} runs)`,
    );
    lines.push(`- **correct_rate**: ${cell.stats.correct_rate.toFixed(3)}`);
    lines.push(
      `- **partial / wrong**: ${cell.stats.partial_rate.toFixed(3)} / ${cell.stats.wrong_rate.toFixed(3)}`,
    );
    lines.push(`- **mean_confidence**: ${cell.stats.mean_confidence.toFixed(3)}`);
    lines.push(
      `- **advisor_needed (rubric 판정)**: ${cell.stats.advisor_needed_rate.toFixed(3)}, **behavior_mismatch**: ${cell.stats.behavior_mismatch_rate.toFixed(3)}`,
    );
    lines.push(`- **관측**: ${cell.note}`);
    lines.push(`- **source**: \`runs/${cell.source_date}/${model}/${cell.problem_id}/_stats.md\``);
    lines.push("");
  }

  // Cross-model 비교 (읽는 모델이 "타 모델과 비교해 자기가 어느 지점에 있는지" 볼 수 있게)
  lines.push("## 비교 참조 — 다른 모델 같은 cell");
  lines.push("");
  lines.push("| 문제 | 이 모델 (자기) | " + TARGET_MODELS.filter((m) => m !== model).join(" | ") + " |");
  lines.push("|---|---" + "|---".repeat(TARGET_MODELS.length - 1) + "|");
  for (const cell of cells) {
    const row: string[] = [
      cell.problem_id,
      `${cell.stats.correct_rate.toFixed(2)}/${cell.stats.advisor_called_rate.toFixed(2)}`,
    ];
    for (const other of TARGET_MODELS) {
      if (other === model) continue;
      const otherCells = allModelCells.get(other) ?? [];
      const match = otherCells.find((c) => c.problem_id === cell.problem_id);
      row.push(
        match
          ? `${match.stats.correct_rate.toFixed(2)}/${match.stats.advisor_called_rate.toFixed(2)}`
          : "—",
      );
    }
    lines.push(`| ${row.join(" | ")} |`);
  }
  lines.push("");
  lines.push("(숫자 형식: `correct_rate / advisor_called_rate`. 같은 문제에 대한 다른 모델의 관측이므로, 자기 전략이 outlier 인지 check.)");
  lines.push("");

  lines.push("## 읽는 법");
  lines.push("");
  lines.push("- `default_behavior` = 과거 12 run 에서 네가 기본적으로 선택한 전략.");
  lines.push("- `behavior_mismatch` ≥ 0.5 는 **외부 기준과 자기 판단이 어긋나는 cell**. 이번 같은 문제에서 그 어긋남을 재검토.");
  lines.push("- `correct_rate` 가 낮으면서 `default_behavior=solve_direct` 라면 **위험 cell** — advisor 호출을 옵션에 둘 것.");
  lines.push("- `correct_rate` 가 높고 `default_behavior=solve_direct` 라면 자체 풀이로 충분. 호출 강요 안 해도 OK.");
  lines.push("");

  lines.push("## 출처");
  lines.push("");
  lines.push("- ADR: [ADR-006-v2](../../../agentic_agent/train-of-thought/decisions/ADR-006-v2-experiential-self-map.md)");
  lines.push("- Matrix narrative: [analyses/2026-04-18-19-h003-advisor-refusal-spectrum.md](../../analyses/2026-04-18-19-h003-advisor-refusal-spectrum.md)");
  lines.push("- 초보자용 리포트: [analyses/report-easy-2026-04-19.md](../../analyses/report-easy-2026-04-19.md)");
  lines.push("");

  return lines.join("\n");
}

function main(): void {
  console.log(`[info] ADR-006-v2 Phase 1 — self-map 생성`);
  console.log(`[info] 대상 모델: ${TARGET_MODELS.join(", ")}`);
  console.log(`[info] 출력 루트: ${PROFILES_ROOT}`);

  // 1st pass: 모든 모델 cells 수집 (cross-model 비교표 용)
  const allModelCells = new Map<string, CellData[]>();
  for (const model of TARGET_MODELS) {
    console.log(`\n[scan] ${model}`);
    const cells = collectCellsForModel(model);
    allModelCells.set(model, cells);
    console.log(`  [cells] ${cells.length}`);
  }

  // 2nd pass: self-map 파일 쓰기
  for (const model of TARGET_MODELS) {
    const cells = allModelCells.get(model) ?? [];
    if (cells.length === 0) {
      console.log(`\n[skip] ${model} — no cells, skipping self-map`);
      continue;
    }
    const outDir = join(PROFILES_ROOT, model);
    mkdirSync(outDir, { recursive: true });
    const outPath = join(outDir, "self-map.md");
    writeFileSync(outPath, renderSelfMap(model, cells, allModelCells));
    console.log(`\n[write] ${outPath}  (${cells.length} cells)`);
  }

  console.log(`\n[done] ${TARGET_MODELS.length} 모델 self-map 생성 완료`);
}

main();
