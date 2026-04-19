/**
 * Auto-recall middleware (Phase 8 T8.8) + curriculum recall (ADR-006).
 *
 * 두 출처를 분리해 주입한다:
 *   1. agent-memory episodes — **나의 경험** (1-인칭, sid/persona 스코프)
 *   2. agent-curriculum runs — **훈련에서 배운 것** (3-인칭, 모든 agent 공통)
 *
 * Caller 는 두 블록을 독립적으로 받거나 `composeCombinedRecall` 로 합쳐서
 * 하나의 system prompt 꼬리로 받을 수 있다. 블록은 태그 (`<agent_memory_recall>`,
 * `<curriculum_recall>`) 로 구분 — LLM 이 출처를 혼동하지 않도록 **출처 명시**
 * 를 블록 안에 본문으로 박는다.
 */

import { searchEpisodes, type SearchHit } from "./search";
import { searchCurriculum, type CurriculumHit } from "./curriculum";
import { loadProfile, type Profile } from "../profile/load";
import { searchProfileCells, type ProfileCellHit } from "../profile/inject";

const DEFAULT_IDLE_MIN = Number(process.env.MEMORY_IDLE_MINUTES ?? 5);
const DEFAULT_LIMIT = 3;
const lastActivity = new Map<string, number>();

export interface RecallResult {
  prompt: string;
  hits: SearchHit[];
}

export interface RecallOptions {
  limit?: number;
  idleMinutes?: number;
}

/**
 * Decide whether enough idle time has elapsed since the last activity for this
 * sid to warrant re-injecting recall context. Updates the activity clock as a
 * side effect (so consecutive turns within the idle window don't re-recall).
 */
export function shouldRecall(sid: string, idleMinutes = DEFAULT_IDLE_MIN): boolean {
  const now = Date.now();
  const last = lastActivity.get(sid);
  lastActivity.set(sid, now);
  if (last === undefined) return true;
  return now - last >= idleMinutes * 60_000;
}

/**
 * Build the recall context block. Returns both the composed markdown string
 * (empty if no hits) and the underlying SearchHit[] so the caller can emit
 * an agent event with the matched episode ids.
 */
export async function composeRecall(
  memoryDir: string,
  query: string,
  opts: RecallOptions = {},
): Promise<RecallResult> {
  const hits = await searchEpisodes(memoryDir, {
    query,
    limit: opts.limit ?? DEFAULT_LIMIT,
  });
  if (hits.length === 0) return { prompt: "", hits: [] };

  const lines: string[] = [
    "",
    "<agent_memory_recall>",
    "**출처: 나의 경험** — 이전 세션에서 내가 직접 겪은 요약이다. 참고하되 꼭 일치시키지 않아도 된다. 내용이 현재 요청과 맞지 않으면 무시해도 좋다.",
    "",
  ];
  hits.forEach((h, i) => {
    lines.push(
      `[${i + 1}] id=${h.episode.id}  persona=${h.episode.persona}  outcome=${h.episode.outcome}`,
    );
    lines.push(`    title: ${h.episode.title}`);
    lines.push(`    started: ${h.episode.started}`);
    if (h.episode.topic_tags.length > 0) {
      lines.push(`    tags: ${h.episode.topic_tags.join(", ")}`);
    }
    if (h.episode.bodyExcerpt) {
      lines.push(`    excerpt: ${h.episode.bodyExcerpt.replace(/\s+/g, " ").slice(0, 240)}`);
    }
    lines.push("");
  });
  lines.push("</agent_memory_recall>");

  return { prompt: lines.join("\n"), hits };
}

/** For tests: reset the in-process idle clock. */
export function resetRecallClock(sid?: string): void {
  if (sid) lastActivity.delete(sid);
  else lastActivity.clear();
}

// -------- Curriculum recall (ADR-006) --------

export interface CurriculumRecallResult {
  prompt: string;
  hits: CurriculumHit[];
}

export interface CurriculumRecallOptions {
  limit?: number;
}

/**
 * Build the curriculum recall block. 3-인칭 훈련 기록을 system prompt 에 주입해
 * agent 가 "과거 훈련에서 유사 문제를 겪었음" 을 인지하고 advisor 호출 판단에
 * 활용할 수 있게 한다.
 *
 * `model` 인자로 동일 버전 우선 필터. 지정된 model 디렉토리가 비어 있거나 해당
 * model 기록이 없으면 빈 블록.
 */
export async function composeCurriculumRecall(
  curriculumDir: string,
  model: string,
  query: string,
  opts: CurriculumRecallOptions = {},
): Promise<CurriculumRecallResult> {
  const hits = await searchCurriculum(curriculumDir, {
    query,
    model,
    limit: opts.limit ?? DEFAULT_LIMIT,
  });
  if (hits.length === 0) return { prompt: "", hits: [] };

  const lines: string[] = [
    "",
    "<curriculum_recall>",
    "**출처: 훈련에서 배운 것** — 실 경험이 아니라 Opus 교사가 관찰·채점한 훈련 run 기록이다. 과거 유사 문제에서 내가 (같은 모델) 어떻게 행동했고 무엇을 틀렸는지 surface. 현재 상황에 유사하면 교훈을 고려하되, 무관하면 무시한다.",
    "",
  ];
  hits.forEach((h, i) => {
    const r = h.record;
    lines.push(
      `[${i + 1}] problem=${r.problem_id}  tier=${r.tier_opus_predicted}  outcome=${r.outcome}`,
    );
    lines.push(
      `    advisor_called=${r.advisor_called}  should_have_called=${r.advisor_should_have_been_called}  confidence=${r.confidence_in_answer}`,
    );
    if (r.category) lines.push(`    category: ${r.category}`);
    if (r.lesson) lines.push(`    lesson: ${r.lesson}`);
    lines.push("");
  });
  lines.push("</curriculum_recall>");
  return { prompt: lines.join("\n"), hits };
}

export interface CombinedRecallResult {
  prompt: string;
  memoryHits: SearchHit[];
  curriculumHits: CurriculumHit[];
  selfMapHits: ProfileCellHit[];
}

export interface CombinedRecallOptions
  extends RecallOptions,
    CurriculumRecallOptions,
    SelfMapOptions {
  /**
   * When set, load profile from `<curriculumDir>/profiles/<model>/self-map.md`
   * and inject as `<self_map>` block. Requires `curriculumDir` to be non-null.
   */
  includeSelfMap?: boolean;
}

/**
 * Combine agent-memory (나의 경험) + agent-curriculum (훈련에서 배운 것) +
 * profile self-map (관측된 나의 습관) into a single prompt tail.
 *
 * Order: memory (1-인칭 세션) → curriculum (3-인칭 훈련 개별 run) →
 * self-map (3-인칭 집계된 습관). 구체 → 추상 순. LLM 이 블록 태그로 출처를
 * 구분할 수 있도록 각 블록 본문 첫 줄에 출처 라벨을 명시한다.
 *
 * `curriculumDir === null` 이면 curriculum/self-map 둘 다 생략.
 * `includeSelfMap === false` (default) 이면 self-map 생략 — Phase 2 A/B 에서
 * `off` branch 가 기존 v1 동작과 완전히 동일하도록 보장.
 */
export async function composeCombinedRecall(
  memoryDir: string,
  curriculumDir: string | null,
  model: string,
  query: string,
  opts: CombinedRecallOptions = {},
): Promise<CombinedRecallResult> {
  const { prompt: memoryPrompt, hits: memoryHits } = await composeRecall(
    memoryDir,
    query,
    opts,
  );
  let curriculumPrompt = "";
  let curriculumHits: CurriculumHit[] = [];
  if (curriculumDir) {
    const res = await composeCurriculumRecall(curriculumDir, model, query, opts);
    curriculumPrompt = res.prompt;
    curriculumHits = res.hits;
  }

  let selfMapPrompt = "";
  let selfMapHits: ProfileCellHit[] = [];
  if (curriculumDir && opts.includeSelfMap) {
    const res = await composeSelfMapBlock(curriculumDir, model, query, opts);
    selfMapPrompt = res.prompt;
    selfMapHits = res.hits;
  }

  const parts = [memoryPrompt, curriculumPrompt, selfMapPrompt].filter(
    (p) => p.length > 0,
  );
  return {
    prompt: parts.join("\n"),
    memoryHits,
    curriculumHits,
    selfMapHits,
  };
}

// -------- Self-map recall (ADR-006 v2 Phase 2) --------

export interface SelfMapRecallResult {
  prompt: string;
  hits: ProfileCellHit[];
  profile: Profile | null;
}

export interface SelfMapOptions {
  limit?: number;
}

/**
 * Build the self-map recall block. Profile 은 과거 N-run 의 집계된 habit 이며,
 * 개별 run 보다 **상위 레이어의 자기-초상화** 를 준다.
 *
 * 명령조 금지 원칙 (ADR-006-v2): "호출하라" 가 아니라 "너의 관측된 습관은 이렇다,
 * 현 상황에 맞는지 스스로 판단하라". 블록 본문 첫 줄에 그 원칙을 박음.
 */
export async function composeSelfMapBlock(
  curriculumDir: string,
  model: string,
  query: string,
  opts: SelfMapOptions = {},
): Promise<SelfMapRecallResult> {
  const profile = await loadProfile(model, curriculumDir);
  if (!profile || profile.cells.length === 0) {
    return { prompt: "", hits: [], profile: null };
  }

  const hits = searchProfileCells(profile, query, { limit: opts.limit ?? DEFAULT_LIMIT });
  if (hits.length === 0) return { prompt: "", hits: [], profile };

  const lines: string[] = [
    "",
    "<self_map>",
    "**출처: 관측된 나의 습관** — 과거 N-run 훈련에서 집계된 너의 L3 default 다. **명령이 아니다.** 아래 cell 이 현재 질문과 유사하면, 네가 그런 상황에서 **실제로 어떻게 행동했는지** 와 rubric 기준이 어떻게 어긋났는지 보고, 이번엔 그 습관대로 갈지 재검토할지 **스스로 판단**하라. 습관과 다르게 가는 것도 허용된다.",
    "",
  ];
  hits.forEach((h, i) => {
    const c = h.cell;
    lines.push(
      `[${i + 1}] cell=${c.problem_id}  domain=${c.domain}  default_behavior=${c.default_behavior}`,
    );
    lines.push(
      `    advisor_called=${c.advisor_called_rate.toFixed(3)}  needed=${c.advisor_needed_rate.toFixed(3)}  mismatch=${c.behavior_mismatch_rate.toFixed(3)}`,
    );
    lines.push(
      `    correct=${c.correct_rate.toFixed(3)}  partial=${c.partial_rate.toFixed(3)}  wrong=${c.wrong_rate.toFixed(3)}  conf=${c.mean_confidence.toFixed(3)}  runs=${c.runs_total}`,
    );
    if (c.note) lines.push(`    note: ${c.note}`);
    lines.push("");
  });
  lines.push("</self_map>");

  return { prompt: lines.join("\n"), hits, profile };
}
