/**
 * Cascade-confab episode filter (M1 mitigation, ADR follow-up).
 *
 * 자연 누적 corruption 의 secondary defense — agent 가 cascade 한 답변이 episode
 * 로 consolidate 되면 다음 retrieval 의 자기-reference cascade vector 가 된다.
 * 71 "푸른 안개" episodes 의 amplification chain 직접 관측 (5.5x amplification,
 * 3 wrong + 15 partial + 45 correct-with-disclaimer 모두 entity 인용 → 잠재
 * cascade vector).
 *
 * 분석 근거: agent-curriculum/analyses/2026-04-26-trap-redesign-pilot.md
 * §"Consolidation cascade 검증 — 71 episodes amplification chain 직접 관측"
 *
 * 보수적 high-precision rule:
 *   A. title 에 명시적 cascade marker (오인 / 오기억 / 오기록)
 *   B. L3 obs 의 outcome_self_rubric=wrong AND actual_behavior=solve_direct
 *   C. body 에 self-aware cascade 인정 문구 (memory_search ... 잘못 / 동일 오류 반복 등)
 *
 * 통과 (false negative 우려 영역):
 *   - 단순 partial / uncertain 은 차단 안 함 (M3 disclaimer 가 처리)
 *   - correct-with-disclaimer 도 차단 안 함 (entity 인용 자체는 cascade vector
 *     이지만 grading 한계로 정확 식별 어려움 — V3 grading prompt 작업 후 재고)
 *
 * 정책: 차단된 episode 는 disk 에 write 안 함 + skip 사유 로그 + result 의
 * skipped[] 배열에 메타데이터 포함. consolidate caller 가 후속 처리 (예: NW
 * corruption signal 발행) 가능하도록.
 */

import type { ConsolidatedEpisode, L3Observation } from "./consolidate";

export interface CascadeSkipDecision {
  skip: boolean;
  reason?: "title_marker" | "rubric_wrong_solve_direct" | "body_self_aware_cascade";
  detail?: string;
}

const TITLE_CASCADE_MARKERS = /(오인|오기억|오기록|재확인.*오류|오답.*반복|cascade.*반복)/i;
const BODY_CASCADE_PHRASES: RegExp[] = [
  /memory_search\s+결과(를|가)\s*잘못\s*(해석|읽)/,
  /recall\s+결과(를)?\s*비판적으로\s*읽지\s*않/,
  /동일\s*(한)?\s*(오류|오인)(를|이)?\s*반복/,
  /이전\s*세션의?\s*경고\s*(텍스트)?(를)?\s*무시/,
  /자기\s*confab(ulation)?을?\s*반복/,
];

export function classifyCascadeRisk(ep: ConsolidatedEpisode): CascadeSkipDecision {
  // Rule A — title 의 명시적 cascade marker
  const title = ep.frontmatter.title ?? "";
  if (TITLE_CASCADE_MARKERS.test(title)) {
    return {
      skip: true,
      reason: "title_marker",
      detail: `title matches cascade marker: "${title}"`,
    };
  }

  // Rule B — L3 의 wrong + solve_direct (cascade-confab 명시)
  const obs: L3Observation[] = Array.isArray(ep.frontmatter.l3_observations)
    ? ep.frontmatter.l3_observations
    : [];
  const cascadeObs = obs.find(
    (o) =>
      o.outcome_self_rubric === "wrong" &&
      o.actual_behavior_this_session === "solve_direct",
  );
  if (cascadeObs) {
    return {
      skip: true,
      reason: "rubric_wrong_solve_direct",
      detail: `cell=${cascadeObs.cell_id} rubric=wrong behavior=solve_direct`,
    };
  }

  // Rule C — body 의 self-aware cascade 인정 phrases
  const body = ep.body ?? "";
  for (const re of BODY_CASCADE_PHRASES) {
    const m = re.exec(body);
    if (m) {
      return {
        skip: true,
        reason: "body_self_aware_cascade",
        detail: `body matches "${m[0].slice(0, 60)}"`,
      };
    }
  }

  return { skip: false };
}

export interface FilterResult<T> {
  written: T[];
  skipped: Array<{ episode: T; reason: NonNullable<CascadeSkipDecision["reason"]>; detail: string }>;
}

export function filterCascadeRisk(
  episodes: ConsolidatedEpisode[],
): FilterResult<ConsolidatedEpisode> {
  const written: ConsolidatedEpisode[] = [];
  const skipped: FilterResult<ConsolidatedEpisode>["skipped"] = [];
  for (const ep of episodes) {
    const decision = classifyCascadeRisk(ep);
    if (decision.skip && decision.reason && decision.detail) {
      skipped.push({ episode: ep, reason: decision.reason, detail: decision.detail });
    } else {
      written.push(ep);
    }
  }
  return { written, skipped };
}
