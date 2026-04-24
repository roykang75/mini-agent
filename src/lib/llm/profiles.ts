/**
 * LLM Profile 시스템 — 모델/provider 조합을 config 파일로 선언하고 세션별로 선택.
 *
 * 원칙:
 *   - 기본값은 `config/llm-profiles.json.default` (env 의 LLM_PROVIDER/LLM_MODEL 이 아님)
 *   - client 는 profile.name 당 하나로 캐시 → 동일 profile 을 쓰는 여러 agent 가 공유
 *   - AgentInstance 는 세션 처음에 profileName 을 고정 (대화 중 모델 전환 금지 — 컨텍스트 오염 방지)
 *
 * feedback memory "retry/limit 은 config 파일로" 와 동일한 패턴.
 */

import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { AnthropicClient } from "./providers/anthropic";
import { OpenAICompatClient } from "./providers/openai-compat";
import type { LLMClient } from "./client";
import { createLogger } from "../log";

const log = createLogger("llm");

export type ProviderName = "anthropic" | "openai-compat";

export interface LlmProfile {
  name: string;
  label: string;
  provider: ProviderName;
  model: string;
  baseURL?: string;
}

export interface PublicLlmProfile {
  name: string;
  label: string;
  model: string;
}

interface ProfilesFile {
  default: string;
  profiles: LlmProfile[];
}

const CONFIG_PATH = resolve(process.cwd(), "config/llm-profiles.json");

let _cache: ProfilesFile | null = null;
let _cacheMtime: number | null = null;

function loadProfilesFile(): ProfilesFile {
  // mtime 기반 hot-reload — config 파일이 수정되면 자동으로 재적재하고
  // stale client cache 도 청소해 dev 편집이 즉시 반영되도록 한다.
  const stat = statSync(CONFIG_PATH);
  const mtime = stat.mtimeMs;
  if (_cache && _cacheMtime === mtime) return _cache;

  const raw = readFileSync(CONFIG_PATH, "utf8");
  const parsed = JSON.parse(raw) as ProfilesFile;
  if (!parsed.default || !Array.isArray(parsed.profiles) || parsed.profiles.length === 0) {
    throw new Error(`invalid ${CONFIG_PATH}: missing default or empty profiles`);
  }
  const names = new Set<string>();
  for (const p of parsed.profiles) {
    if (!p.name || !p.label || !p.provider || !p.model) {
      throw new Error(`profile missing required field: ${JSON.stringify(p)}`);
    }
    if (names.has(p.name)) {
      throw new Error(`duplicate profile name: ${p.name}`);
    }
    names.add(p.name);
  }
  if (!names.has(parsed.default)) {
    throw new Error(`default profile "${parsed.default}" not in profiles list`);
  }
  _cache = parsed;
  _cacheMtime = mtime;
  // Profile 정의가 바뀌면 기존 client 는 stale (baseURL 등 달라질 수 있음) →
  // 재생성을 강제해서 drift 방지.
  clientCache.clear();
  log.info(
    { event: "profiles_loaded", path: CONFIG_PATH, count: parsed.profiles.length, mtime },
    "llm profiles (re)loaded",
  );
  return parsed;
}

export function listProfiles(): LlmProfile[] {
  return loadProfilesFile().profiles;
}

export function listPublicProfiles(): PublicLlmProfile[] {
  return loadProfilesFile().profiles.map(({ name, label, model }) => ({
    name,
    label,
    model,
  }));
}

export function getDefaultProfileName(): string {
  return loadProfilesFile().default;
}

/**
 * 이름으로 profile 조회. 이름이 없으면 default. 존재하지 않는 이름이면 throw.
 */
export function resolveProfile(name: string | null | undefined): LlmProfile {
  const file = loadProfilesFile();
  const target = name ?? file.default;
  const found = file.profiles.find((p) => p.name === target);
  if (!found) {
    throw new Error(
      `LLM profile "${target}" not found in config/llm-profiles.json`,
    );
  }
  return found;
}

const clientCache = new Map<string, LLMClient>();

export function getClientForProfile(profile: LlmProfile): LLMClient {
  const cached = clientCache.get(profile.name);
  if (cached) return cached;
  let client: LLMClient;
  if (profile.provider === "anthropic") {
    client = new AnthropicClient({ baseURL: profile.baseURL });
  } else if (profile.provider === "openai-compat") {
    client = new OpenAICompatClient({ baseURL: profile.baseURL });
  } else {
    throw new Error(`Unknown provider: ${profile.provider satisfies never}`);
  }
  clientCache.set(profile.name, client);
  log.info(
    { event: "llm_client_created", profile: profile.name, provider: profile.provider, model: profile.model },
    "LLM client instantiated for profile",
  );
  return client;
}

/** Test-only — clear client/profile caches. */
export function __resetProfilesForTest(): void {
  _cache = null;
  clientCache.clear();
}
