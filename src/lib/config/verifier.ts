/**
 * Verifier hook config loader (Roy 의 "config 파일 중심 관리" 원칙, 2026-04-21).
 *
 * Source-of-truth: `config/verifier-hook.json`. UI 가 같은 파일을 편집.
 * 코드 default 는 파일 누락/파싱 실패 시 fallback. env override 우선.
 *
 * 우선순위: env > file > code default.
 *
 * env 키 — pilot script 와 호환 유지 (memory: feedback_test_artifact_reuse):
 *   VERIFIER_HOOK              : "on"|"off" — master enable
 *   VERIFIER_HOOK_ADVISOR      : "on"|"off" — advisor hook (step 1)
 *   VERIFIER_HOOK_AGENT_TURN   : "on"|"off" — agent turn hook (step 2)
 *   VERIFIER_MODEL             : claude-opus-4-7 등
 *   VERIFIER_PROMPT_VERSION    : v1|v2|v3
 *   PLAUSIBILITY_CHECK         : "on"|"off"
 *   PLAUSIBILITY_MODEL         : claude-haiku-4-5-20251001 등
 *   PLAUSIBILITY_DEPTH_LIMIT   : 2 등 (Infinity = "inf"|"unlimited"|"none")
 *   VERIFIER_REJECT_MESSAGE    : reject 시 override 메시지
 *
 * 동작: 개별 hook 활성 = master `enabled` AND individual flag.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { PromptVersion } from "../llm/verify";

export interface PlausibilityConfig {
  enabled: boolean;
  model: string;
  depth_limit: number;
}

export interface VerifierConfig {
  model: string;
  prompt_version: PromptVersion;
}

export interface VerifierHookConfig {
  enabled: boolean;
  advisor_hook: boolean;
  agent_turn_hook: boolean;
  plausibility: PlausibilityConfig;
  verifier: VerifierConfig;
  reject_message: string;
}

const DEFAULTS: VerifierHookConfig = {
  enabled: false,
  advisor_hook: true,
  agent_turn_hook: true,
  plausibility: {
    enabled: true,
    model: "claude-haiku-4-5-20251001",
    depth_limit: 2,
  },
  verifier: {
    model: "claude-opus-4-7",
    prompt_version: "v3",
  },
  reject_message: "모른다 / 알 수 없다 (verifier rejected)",
};

function resolveConfigPath(): string {
  return (
    process.env.VERIFIER_HOOK_CONFIG_PATH ??
    resolve(process.cwd(), "config/verifier-hook.json")
  );
}

interface FilePlausibility {
  enabled?: unknown;
  model?: unknown;
  depth_limit?: unknown;
}
interface FileVerifier {
  model?: unknown;
  prompt_version?: unknown;
}
interface FileShape {
  enabled?: unknown;
  advisor_hook?: unknown;
  agent_turn_hook?: unknown;
  plausibility?: FilePlausibility;
  verifier?: FileVerifier;
  reject_message?: unknown;
}

function readConfigFile(path: string): FileShape | null {
  try {
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as FileShape;
  } catch {
    return null;
  }
}

function envBoolOr(envName: string, base: boolean): boolean {
  const raw = process.env[envName];
  if (raw === undefined || raw === "") return base;
  return /^(on|true|1|yes)$/i.test(raw);
}

function envStringOr(envName: string, base: string): string {
  const raw = process.env[envName];
  if (raw === undefined || raw === "") return base;
  return raw;
}

function envDepthLimitOr(envName: string, base: number): number {
  const raw = process.env[envName];
  if (raw === undefined || raw === "") return base;
  if (/^(inf|infinity|unlimited|none)$/i.test(raw)) return Infinity;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return base;
  return n;
}

function coerceBool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function coerceString(v: unknown, fallback: string): string {
  return typeof v === "string" && v.length > 0 ? v : fallback;
}

function coerceDepthLimit(v: unknown, fallback: number): number {
  if (v === null || v === undefined) return Infinity;
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
  return fallback;
}

function coercePromptVersion(v: unknown, fallback: PromptVersion): PromptVersion {
  if (v === "v1" || v === "v2" || v === "v3") return v;
  return fallback;
}

let cached: VerifierHookConfig | null = null;

export function loadVerifierHookConfig(): VerifierHookConfig {
  if (cached) return cached;

  const file = readConfigFile(resolveConfigPath());

  const fileEnabled = coerceBool(file?.enabled, DEFAULTS.enabled);
  const fileAdvisorHook = coerceBool(file?.advisor_hook, DEFAULTS.advisor_hook);
  const fileAgentTurnHook = coerceBool(file?.agent_turn_hook, DEFAULTS.agent_turn_hook);
  const filePlausEnabled = coerceBool(file?.plausibility?.enabled, DEFAULTS.plausibility.enabled);
  const filePlausModel = coerceString(file?.plausibility?.model, DEFAULTS.plausibility.model);
  const filePlausDepth = coerceDepthLimit(file?.plausibility?.depth_limit, DEFAULTS.plausibility.depth_limit);
  const fileVerifierModel = coerceString(file?.verifier?.model, DEFAULTS.verifier.model);
  const fileVerifierVersion = coercePromptVersion(file?.verifier?.prompt_version, DEFAULTS.verifier.prompt_version);
  const fileReject = coerceString(file?.reject_message, DEFAULTS.reject_message);

  const merged: VerifierHookConfig = {
    enabled: envBoolOr("VERIFIER_HOOK", fileEnabled),
    advisor_hook: envBoolOr("VERIFIER_HOOK_ADVISOR", fileAdvisorHook),
    agent_turn_hook: envBoolOr("VERIFIER_HOOK_AGENT_TURN", fileAgentTurnHook),
    plausibility: {
      enabled: envBoolOr("PLAUSIBILITY_CHECK", filePlausEnabled),
      model: envStringOr("PLAUSIBILITY_MODEL", filePlausModel),
      depth_limit: envDepthLimitOr("PLAUSIBILITY_DEPTH_LIMIT", filePlausDepth),
    },
    verifier: {
      model: envStringOr("VERIFIER_MODEL", fileVerifierModel),
      prompt_version: coercePromptVersion(process.env.VERIFIER_PROMPT_VERSION, fileVerifierVersion),
    },
    reject_message: envStringOr("VERIFIER_REJECT_MESSAGE", fileReject),
  };

  cached = merged;
  return merged;
}

/** Master ON AND advisor hook ON. step 1 의 advisor.ts 가 사용. */
export function isAdvisorHookActive(cfg: VerifierHookConfig = loadVerifierHookConfig()): boolean {
  return cfg.enabled && cfg.advisor_hook;
}

/** Master ON AND agent turn hook ON. step 2 의 instance.ts 가 사용. */
export function isAgentTurnHookActive(cfg: VerifierHookConfig = loadVerifierHookConfig()): boolean {
  return cfg.enabled && cfg.agent_turn_hook;
}

/** Test-only — drop cached value so next loadVerifierHookConfig re-reads. */
export function __resetVerifierHookConfigCache(): void {
  cached = null;
}
