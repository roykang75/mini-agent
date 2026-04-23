#!/usr/bin/env tsx
/**
 * audit-retrospection — ADR-007 P4.
 *
 * Joins agent-memory/episodes (v2+) with agent-curriculum/observations by
 * session_id. Computes cell-level mismatch_rate, mean_confidence_gap, and
 * outcome distribution. Outputs markdown report.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import matter from "gray-matter";

export interface CellStat {
  cell_id: string;
  sessions_in_window: number;
  advisor_called_count: number;
  advisor_needed_count_opus: number;
  mismatch_count: number;
  mismatch_rate: number;
  mean_confidence_gap: number;
  outcomes_opus: Record<string, number>;
}

/**
 * Single self-miscalibration event — agent 의 자기-확신과 Opus 관찰 사이의
 * 큰 간극 + wrong outcome 의 조합. ADR-007 "self-miscalibration 측정 채널"
 * (NEXT.md 15차 Top 1). 채널은 sampling; cell_stats 와 달리 rate 가 아니라
 * 개별 event 의 시계열 리스트.
 */
export interface MiscalibrationEvent {
  session_id: string;
  started: string;
  cell_id: string;
  canonical_cell_id: string;
  confidence_gap: number;
  outcome_opus_rubric: string;
  sonnet_called: boolean;
  opus_judged_advisor_needed: boolean;
}

export interface AuditReport {
  window_size: number;
  sessions_audited: number;
  cell_stats: CellStat[];
  miscalibration_events: MiscalibrationEvent[];
  miscalibration_min_gap: number;
  markdown: string;
  miscalibration_markdown: string;
}

export interface AuditOpts {
  memoryDir: string;
  curriculumDir: string;
  window?: number;
  model?: string;
  /**
   * Optional canonical cell mapping. Keys are raw cell_ids as written in
   * episodes/observations; values are canonical cell_ids to project them onto
   * before aggregation. Missing keys pass through unchanged. Produced by
   * `scripts/cell-canonicalize.ts`.
   */
  canonicalMapping?: Record<string, string>;
  /**
   * Self-miscalibration 채널의 conf_gap 하한 (default 0.5). 이 임계 이상 +
   * outcome_opus_rubric === "wrong" 인 observation 을 event 로 수집한다.
   */
  miscalibrationMinGap?: number;
}

interface EpisodeL3 {
  cell_id: string;
  advisor_called: boolean;
  advisor_self_felt_need: boolean;
  confidence_self: number;
}
interface ObsCell {
  cell_id: string;
  opus_judged_advisor_needed: boolean;
  sonnet_called: boolean;
  mismatch: boolean;
  outcome_opus_rubric: string;
  confidence_gap: number;
}

export async function auditRetrospection(opts: AuditOpts): Promise<AuditReport> {
  const window = opts.window ?? 10;
  const epsDir = join(opts.memoryDir, "episodes");
  const obsDir = join(opts.curriculumDir, "observations");

  const epFiles = await readdir(epsDir).catch(() => [] as string[]);
  const obsFiles = await readdir(obsDir).catch(() => [] as string[]);

  const episodes = new Map<string, { fm: Record<string, unknown>; l3: EpisodeL3[] }>();
  for (const f of epFiles.filter((x) => x.endsWith(".md"))) {
    const raw = await readFile(join(epsDir, f), "utf-8");
    const p = matter(raw);
    const fm = p.data as Record<string, unknown>;
    const pv = ((fm.consolidation ?? {}) as Record<string, unknown>).prompt_version;
    if (pv !== "v2") continue;
    if (opts.model && ((fm.consolidation as Record<string, unknown>).model !== opts.model)) continue;
    const l3arr = Array.isArray(fm.l3_observations) ? (fm.l3_observations as Array<Record<string, unknown>>) : [];
    const l3 = l3arr.map((x) => ({
      cell_id: String(x.cell_id ?? ""),
      advisor_called: Boolean(x.advisor_called),
      advisor_self_felt_need: Boolean(x.advisor_self_felt_need),
      confidence_self: Number(x.confidence_self ?? 0),
    }));
    episodes.set(String(fm.session_id ?? ""), { fm, l3 });
  }

  const observations = new Map<string, { fm: Record<string, unknown>; cells: ObsCell[] }>();
  for (const f of obsFiles.filter((x) => x.endsWith(".md"))) {
    const raw = await readFile(join(obsDir, f), "utf-8");
    const p = matter(raw);
    const fm = p.data as Record<string, unknown>;
    const cellsArr = Array.isArray(fm.cells_observed) ? (fm.cells_observed as Array<Record<string, unknown>>) : [];
    const cells = cellsArr.map((x) => ({
      cell_id: String(x.cell_id ?? ""),
      opus_judged_advisor_needed: Boolean(x.opus_judged_advisor_needed),
      sonnet_called: Boolean(x.sonnet_called),
      mismatch: Boolean(x.mismatch),
      outcome_opus_rubric: String(x.outcome_opus_rubric ?? "uncertain"),
      confidence_gap: Number(x.confidence_gap ?? 0),
    }));
    observations.set(String(fm.session_id ?? ""), { fm, cells });
  }

  const joined: Array<{ session_id: string; started: string; l3: EpisodeL3[]; obs: ObsCell[] }> = [];
  for (const [sid, ep] of episodes) {
    const obs = observations.get(sid);
    if (!obs) continue;
    joined.push({
      session_id: sid,
      started: String(ep.fm.started ?? ""),
      l3: ep.l3,
      obs: obs.cells,
    });
  }
  joined.sort((a, b) => a.started.localeCompare(b.started));
  const recent = joined.slice(-window);

  const cellMap = new Map<string, {
    sessions: number;
    called: number;
    needed_opus: number;
    mismatch: number;
    gap_sum: number;
    gap_n: number;
    outcomes: Record<string, number>;
  }>();

  const canon = (cid: string): string => opts.canonicalMapping?.[cid] ?? cid;
  const miscalMinGap = opts.miscalibrationMinGap ?? 0.5;
  const miscalibration_events: MiscalibrationEvent[] = [];

  for (const s of recent) {
    // Group observation cells by canonical id — multiple raw cells mapping to
    // the same canonical in one session collapse to a single session tick for
    // that canonical (avoids double-counting when Sonnet labeled the same L3
    // activity with two slightly different cell_ids).
    const canonicalCells = new Map<string, ObsCell>();
    for (const ob of s.obs) {
      if (ob.confidence_gap >= miscalMinGap && ob.outcome_opus_rubric === "wrong") {
        miscalibration_events.push({
          session_id: s.session_id,
          started: s.started,
          cell_id: ob.cell_id,
          canonical_cell_id: canon(ob.cell_id),
          confidence_gap: ob.confidence_gap,
          outcome_opus_rubric: ob.outcome_opus_rubric,
          sonnet_called: ob.sonnet_called,
          opus_judged_advisor_needed: ob.opus_judged_advisor_needed,
        });
      }
      const key = canon(ob.cell_id);
      if (!canonicalCells.has(key)) canonicalCells.set(key, ob);
    }
    for (const [cid, ob] of canonicalCells) {
      const cur = cellMap.get(cid) ?? {
        sessions: 0, called: 0, needed_opus: 0, mismatch: 0, gap_sum: 0, gap_n: 0, outcomes: {},
      };
      cur.sessions += 1;
      if (ob.sonnet_called) cur.called += 1;
      if (ob.opus_judged_advisor_needed) cur.needed_opus += 1;
      if (ob.mismatch) cur.mismatch += 1;
      cur.gap_sum += ob.confidence_gap;
      cur.gap_n += 1;
      cur.outcomes[ob.outcome_opus_rubric] = (cur.outcomes[ob.outcome_opus_rubric] ?? 0) + 1;
      cellMap.set(cid, cur);
    }
  }

  const cell_stats: CellStat[] = Array.from(cellMap.entries()).map(([cell_id, v]) => ({
    cell_id,
    sessions_in_window: v.sessions,
    advisor_called_count: v.called,
    advisor_needed_count_opus: v.needed_opus,
    mismatch_count: v.mismatch,
    mismatch_rate: v.sessions > 0 ? v.mismatch / v.sessions : 0,
    mean_confidence_gap: v.gap_n > 0 ? v.gap_sum / v.gap_n : 0,
    outcomes_opus: v.outcomes,
  }));
  cell_stats.sort((a, b) => b.mismatch_rate - a.mismatch_rate);
  miscalibration_events.sort((a, b) => b.confidence_gap - a.confidence_gap);

  return {
    window_size: window,
    sessions_audited: recent.length,
    cell_stats,
    miscalibration_events,
    miscalibration_min_gap: miscalMinGap,
    markdown: renderMarkdown(window, recent.length, cell_stats),
    miscalibration_markdown: renderMiscalibrationMarkdown(window, recent.length, miscalMinGap, miscalibration_events),
  };
}

function renderMarkdown(window: number, n: number, stats: CellStat[]): string {
  const lines: string[] = [];
  lines.push(`# audit-retrospection report`);
  lines.push("");
  lines.push(`- window_size: ${window}`);
  lines.push(`- sessions_audited: ${n}`);
  lines.push(`- generated_at: ${new Date().toISOString()}`);
  lines.push("");
  lines.push(`## Cell stats`);
  lines.push("");
  lines.push("| cell_id | sessions | called | opus_needed | mismatch_rate | conf_gap | outcomes |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const s of stats) {
    const outs = Object.entries(s.outcomes_opus).map(([k, v]) => `${k}=${v}`).join(", ");
    lines.push(`| ${s.cell_id} | ${s.sessions_in_window} | ${s.advisor_called_count} | ${s.advisor_needed_count_opus} | ${s.mismatch_rate.toFixed(3)} | ${s.mean_confidence_gap.toFixed(3)} | ${outs} |`);
  }
  return lines.join("\n");
}

function renderMiscalibrationMarkdown(
  window: number,
  n: number,
  minGap: number,
  events: MiscalibrationEvent[],
): string {
  const lines: string[] = [];
  lines.push(`# self-miscalibration events`);
  lines.push("");
  lines.push(`- window_size: ${window}`);
  lines.push(`- sessions_audited: ${n}`);
  lines.push(`- min_confidence_gap: ${minGap}`);
  lines.push(`- outcome_filter: wrong`);
  lines.push(`- n_events: ${events.length}`);
  lines.push(`- generated_at: ${new Date().toISOString()}`);
  lines.push("");
  lines.push(`## Events (sorted by confidence_gap desc)`);
  lines.push("");
  if (events.length === 0) {
    lines.push("_none_");
    return lines.join("\n");
  }
  lines.push("| started | session_id | canonical_cell | cell_id | gap | outcome | called | needed |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const e of events) {
    lines.push(
      `| ${e.started} | ${e.session_id} | ${e.canonical_cell_id} | ${e.cell_id} | ${e.confidence_gap.toFixed(2)} | ${e.outcome_opus_rubric} | ${e.sonnet_called} | ${e.opus_judged_advisor_needed} |`,
    );
  }
  return lines.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const memoryDir = process.env.AGENT_MEMORY_DIR;
  const curriculumDir = process.env.AGENT_CURRICULUM_DIR;
  if (!memoryDir || !curriculumDir) {
    console.error("Set AGENT_MEMORY_DIR and AGENT_CURRICULUM_DIR envs.");
    process.exit(1);
  }
  const canonPath = process.env.CANON_MAPPING_PATH;
  const miscalOnly = process.env.MISCAL_ONLY === "1" || process.argv.includes("--miscalibration-only");
  const miscalMinGap = process.env.MISCAL_MIN_GAP ? Number(process.env.MISCAL_MIN_GAP) : undefined;
  (async () => {
    let canonicalMapping: Record<string, string> | undefined;
    if (canonPath) {
      const raw = await readFile(canonPath, "utf-8");
      canonicalMapping = (JSON.parse(raw) as { mapping: Record<string, string> }).mapping;
    }
    const r = await auditRetrospection({
      memoryDir,
      curriculumDir,
      window: Number(process.env.AUDIT_WINDOW ?? 10),
      canonicalMapping,
      miscalibrationMinGap: miscalMinGap,
    });
    console.log(miscalOnly ? r.miscalibration_markdown : r.markdown);
    process.exit(0);
  })().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
