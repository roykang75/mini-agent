/**
 * Runtime limits loader (Roy 의 "config 파일 중심 관리" 원칙, 2026-04-21).
 *
 * Source-of-truth: `config/runtime-limits.json`. 미래에 UI 가 같은 파일을 편집.
 * 코드 default 는 파일 누락/파싱 실패 시 fallback. env override 는 backward
 * compat 유지 (우선순위 env > file > default).
 *
 * JSON schema (retry 섹션):
 *   tool_call_retry_limit : number       — RETRY_LIMIT 대체
 *   advisor_call_limit    : number|null  — null/absent = 무제한 (Infinity)
 *   goal_retry_max        : number       — goal.retry_count 상한
 *   approval_safety_limit : number       — per-iter resume 상한
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface RetryLimits {
  tool_call_retry_limit: number;
  advisor_call_limit: number; // Infinity when disabled
  goal_retry_max: number;
  approval_safety_limit: number;
}

export interface RuntimeLimits {
  retry: RetryLimits;
}

const DEFAULTS: RuntimeLimits = {
  retry: {
    tool_call_retry_limit: 3,
    advisor_call_limit: Infinity,
    goal_retry_max: 3,
    approval_safety_limit: 32,
  },
};

function resolveConfigPath(): string {
  return (
    process.env.RUNTIME_LIMITS_PATH ??
    resolve(process.cwd(), "config/runtime-limits.json")
  );
}

function readConfigFile(path: string): Partial<RuntimeLimits> | null {
  try {
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as Partial<RuntimeLimits>;
  } catch {
    return null;
  }
}

function coerceNonNegative(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  return fallback;
}

function coerceLimitOrInfinity(value: unknown, fallback: number): number {
  // null / undefined → Infinity (무제한)
  if (value === null || value === undefined) return Infinity;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  return fallback;
}

function envNumberOr(envName: string, base: number, allowInfinity = false): number {
  const raw = process.env[envName];
  if (raw === undefined || raw === "") return base;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    if (allowInfinity && /^(inf|infinity|unlimited|none)$/i.test(raw)) {
      return Infinity;
    }
    return base;
  }
  return n;
}

let cached: RuntimeLimits | null = null;

export function loadRuntimeLimits(): RuntimeLimits {
  if (cached) return cached;

  const path = resolveConfigPath();
  const file = readConfigFile(path);

  const fileRetry = (file?.retry ?? {}) as Partial<RetryLimits>;

  const merged: RuntimeLimits = {
    retry: {
      tool_call_retry_limit: envNumberOr(
        "RETRY_LIMIT",
        coerceNonNegative(
          fileRetry.tool_call_retry_limit,
          DEFAULTS.retry.tool_call_retry_limit,
        ),
      ),
      advisor_call_limit: envNumberOr(
        "ADVISOR_CALL_LIMIT",
        coerceLimitOrInfinity(
          fileRetry.advisor_call_limit,
          DEFAULTS.retry.advisor_call_limit,
        ),
        /* allowInfinity */ true,
      ),
      goal_retry_max: coerceNonNegative(
        fileRetry.goal_retry_max,
        DEFAULTS.retry.goal_retry_max,
      ),
      approval_safety_limit: envNumberOr(
        "APPROVAL_SAFETY_LIMIT",
        coerceNonNegative(
          fileRetry.approval_safety_limit,
          DEFAULTS.retry.approval_safety_limit,
        ),
      ),
    },
  };

  cached = merged;
  return merged;
}

/** Test-only — drop cached value so next loadRuntimeLimits re-reads. */
export function __resetRuntimeLimitsCache(): void {
  cached = null;
}
