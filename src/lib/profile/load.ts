/**
 * ADR-006-v2 Phase 2 — profile loader.
 *
 * `agent-curriculum/profiles/<model>/self-map.md` 를 파싱해 cell 목록을 반환.
 * 이 파일은 `scripts/profile/generate-self-map.ts` 로 생성되며, cell 당 한
 * 블록 (`### N. <problem_id> — <short>`) + 필드 라인 (`- **<key>**: <val>`)
 * 구조를 가진다.
 *
 * 파싱은 파일 형식의 rigid-match 이 아니라 느슨한 key 추출 — 신규 필드가
 * 추가돼도 기존 필드만 있으면 통과한다.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import matter from "gray-matter";

export interface ProfileCell {
  problem_id: string;
  short: string;
  domain: string;
  default_behavior: string;
  advisor_called_rate: number;
  advisor_needed_rate: number;
  behavior_mismatch_rate: number;
  correct_rate: number;
  partial_rate: number;
  wrong_rate: number;
  mean_confidence: number;
  runs_total: number;
  note: string;
}

export interface Profile {
  model: string;
  generated_at: string;
  cell_count: number;
  cells: ProfileCell[];
  path: string;
}

const FIELD_PATTERNS: Array<[keyof ProfileCell, RegExp, "number" | "string"]> = [
  ["domain", /-\s*\*\*domain\*\*:\s*(.+)$/m, "string"],
  ["default_behavior", /-\s*\*\*default_behavior \(관측\)\*\*:\s*(.+)$/m, "string"],
  ["advisor_called_rate", /-\s*\*\*advisor_called_rate\*\*:\s*([0-9.]+)/m, "number"],
  ["correct_rate", /-\s*\*\*correct_rate\*\*:\s*([0-9.]+)/m, "number"],
  ["mean_confidence", /-\s*\*\*mean_confidence\*\*:\s*([0-9.]+)/m, "number"],
  ["note", /-\s*\*\*관측\*\*:\s*(.+)$/m, "string"],
];

function parseCell(section: string): ProfileCell | null {
  const header = section.match(/^###\s+\d+\.\s+([A-Za-z0-9_\-]+)\s+—\s+(.+)$/m);
  if (!header) return null;

  const cell: ProfileCell = {
    problem_id: header[1].trim(),
    short: header[2].trim(),
    domain: "",
    default_behavior: "",
    advisor_called_rate: 0,
    advisor_needed_rate: 0,
    behavior_mismatch_rate: 0,
    correct_rate: 0,
    partial_rate: 0,
    wrong_rate: 0,
    mean_confidence: 0,
    runs_total: 0,
    note: "",
  };

  for (const [key, re, type] of FIELD_PATTERNS) {
    const m = section.match(re);
    if (!m) continue;
    if (type === "number") (cell[key] as number) = Number(m[1]);
    else (cell[key] as string) = m[1].trim();
  }

  // runs_total is embedded in advisor_called_rate line: "0.000 (10 runs)"
  const runsMatch = section.match(/advisor_called_rate\*\*:\s*[0-9.]+\s*\((\d+)\s+runs\)/);
  if (runsMatch) cell.runs_total = Number(runsMatch[1]);

  // partial/wrong 는 같은 줄에 병기됨
  const pwMatch = section.match(/partial \/ wrong\*\*:\s*([0-9.]+)\s*\/\s*([0-9.]+)/);
  if (pwMatch) {
    cell.partial_rate = Number(pwMatch[1]);
    cell.wrong_rate = Number(pwMatch[2]);
  }

  // advisor_needed + behavior_mismatch 도 같은 줄
  const needMatch = section.match(
    /advisor_needed[^:]*:\s*([0-9.]+)[^,]*,\s*\*\*behavior_mismatch\*\*:\s*([0-9.]+)/,
  );
  if (needMatch) {
    cell.advisor_needed_rate = Number(needMatch[1]);
    cell.behavior_mismatch_rate = Number(needMatch[2]);
  }

  return cell;
}

export async function loadProfile(model: string, curriculumDir: string): Promise<Profile | null> {
  const path = join(curriculumDir, "profiles", model, "self-map.md");
  const raw = await readFile(path, "utf-8").catch(() => null);
  if (raw === null) return null;

  const parsed = matter(raw);
  const fm = parsed.data as Record<string, unknown>;

  const sections = parsed.content.split(/^###\s+/m).slice(1).map((s) => `### ${s}`);
  const cells: ProfileCell[] = [];
  for (const section of sections) {
    const cell = parseCell(section);
    if (cell) cells.push(cell);
  }

  return {
    model: String(fm.model ?? model),
    generated_at: String(fm.generated_at ?? ""),
    cell_count: typeof fm.cell_count === "number" ? fm.cell_count : cells.length,
    cells,
    path,
  };
}

/**
 * List all models that have a `profiles/<model>/self-map.md` file under
 * `curriculumDir`. Returns bare model directory names, sorted.
 */
export async function listProfileModels(curriculumDir: string): Promise<string[]> {
  const root = join(curriculumDir, "profiles");
  const entries = await readdir(root).catch(() => [] as string[]);
  const out: string[] = [];
  for (const e of entries) {
    const s = await stat(join(root, e, "self-map.md")).catch(() => null);
    if (s && s.isFile()) out.push(e);
  }
  return out.sort();
}
