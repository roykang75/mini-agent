/**
 * Signal detector (Phase 8 T8.2).
 *
 * Scans a session's raw JSONL events and returns boundary signal candidates.
 * Consumed by the consolidation worker (T8.3) to hint Sonnet at natural
 * episode boundaries. Pure function — no I/O, no env dependencies.
 *
 * Signal kinds (see memory design doc):
 *   - persona_diff       : persona changed mid-session
 *   - tool_error_streak  : N consecutive tool_result errors
 *   - idle_gap           : timestamp gap exceeds threshold
 *   - meta_phrase        : user says "다른 얘기 / ok 다음 / 이제 / 참"
 *
 * The detector does not DECIDE boundaries — it enumerates candidates with a
 * severity in [0, 1]. Sonnet (T8.3) picks up to 5 boundaries per session from
 * these + its own judgment.
 */

import type { RawEvent } from "./raw";

export type SignalReason =
  | "persona_diff"
  | "tool_error_streak"
  | "idle_gap"
  | "meta_phrase";

export interface Signal {
  /** Index into the events array where the boundary applies (before this event). */
  index: number;
  reason: SignalReason;
  /** Strength 0 (weak) ~ 1 (very strong). */
  severity: number;
  /** One-line human-readable explanation for boundary_reason audit. */
  detail: string;
}

export interface SignalOptions {
  idleGapMinutes?: number;
  toolErrorStreakN?: number;
  metaPhrases?: readonly string[];
}

export const DEFAULT_META_PHRASES: readonly string[] = [
  "다른 얘기",
  "ok 다음",
  "이제",
  "참",
];

const ERROR_BODY_RE = /"error"\s*:|"ok"\s*:\s*false|"is_error"\s*:\s*true/;

function looksLikeError(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const output = (payload as { output?: unknown }).output;
  if (typeof output !== "string") return false;
  return ERROR_BODY_RE.test(output);
}

export function detectSignals(events: RawEvent[], opts: SignalOptions = {}): Signal[] {
  const idleGapMs = (opts.idleGapMinutes ?? 30) * 60_000;
  const errStreakN = opts.toolErrorStreakN ?? 3;
  const phrases = opts.metaPhrases ?? DEFAULT_META_PHRASES;

  const signals: Signal[] = [];

  let prevTs: number | null = null;
  let prevPersona: string | undefined;
  let errRun = 0;
  let errStreakReported = false;

  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    const t = Date.parse(e.ts);

    if (prevTs !== null && Number.isFinite(t) && t - prevTs >= idleGapMs) {
      const minutes = Math.round((t - prevTs) / 60_000);
      signals.push({
        index: i,
        reason: "idle_gap",
        severity: Math.min(1, (t - prevTs) / idleGapMs / 2),
        detail: `${minutes}분 공백`,
      });
    }
    if (Number.isFinite(t)) prevTs = t;

    if (e.persona && prevPersona !== undefined && e.persona !== prevPersona) {
      signals.push({
        index: i,
        reason: "persona_diff",
        severity: 0.9,
        detail: `${prevPersona} → ${e.persona}`,
      });
    }
    if (e.persona) prevPersona = e.persona;

    if (e.event_type === "tool_result") {
      if (looksLikeError(e.payload)) {
        errRun++;
        if (errRun >= errStreakN && !errStreakReported) {
          signals.push({
            index: i,
            reason: "tool_error_streak",
            severity: Math.min(1, errRun / (errStreakN * 2)),
            detail: `연속 ${errRun}회 tool_result 에러`,
          });
          errStreakReported = true;
        }
      } else {
        errRun = 0;
        errStreakReported = false;
      }
    }

    if (e.event_type === "user_message") {
      const payload = e.payload as { content?: unknown };
      const content =
        typeof payload.content === "string" ? payload.content.toLowerCase() : "";
      for (const p of phrases) {
        if (content.includes(p.toLowerCase())) {
          signals.push({
            index: i,
            reason: "meta_phrase",
            severity: 0.7,
            detail: `phrase="${p}"`,
          });
          break;
        }
      }
    }
  }

  return signals;
}

/** Deduplicate signals that land on the same event index, keeping the strongest. */
export function compactSignals(signals: Signal[]): Signal[] {
  const byIndex = new Map<number, Signal>();
  for (const s of signals) {
    const existing = byIndex.get(s.index);
    if (!existing || s.severity > existing.severity) {
      byIndex.set(s.index, s);
    }
  }
  return Array.from(byIndex.values()).sort((a, b) => a.index - b.index);
}
