/**
 * ADR-005 — WorkingMemoryStore (Redis backend) persistence smoke.
 *
 * 실 Redis (env REDIS_URL, 기본 redis://localhost:6379) 에 AgentInstance
 * state 를 put/get round-trip + hydration 을 검증. HMR / 재시작 후에도
 * agent 가 기억을 이어가는 시나리오의 핵심 단위.
 *
 * 주의: 실 Redis 가 필요. 없으면 skip 하지 말고 명시적 실패 (의도).
 *
 * 테스트 스텝:
 *   1. RedisStore 직접 new — 간단한 state put/get/delete 왕복
 *   2. AgentInstance → serialize → store.put → 새 AgentInstance.fromSerialized
 *      로 hydrate → 내부 messages / advisorCalls / pending 복원 확인
 *   3. 같은 sid 로 registry.summonAgent 두 번 호출: 첫 번째는 새로 탄생,
 *      두 번째는 store 에서 hydrate (Map cache 클리어 후)
 */

import { AgentInstance } from "../src/lib/agent/instance";
import { RedisStore, type SerializedAgentState } from "../src/lib/agent/store";
import { __setWorkingMemoryStore } from "../src/lib/agent/store";
import {
  summonAgent,
  __clearAllAgents,
} from "../src/lib/agent/registry";

function fail(msg: string): never {
  console.error(`[FAIL] ${msg}`);
  process.exit(1);
}

function assertEq<T>(label: string, actual: T, expected: T) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
  console.log(`[ok]   ${label}`);
}

async function main() {
  const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
  console.log(`[info] REDIS_URL = ${redisUrl}`);

  const prefix = `agent:state:smoke-${Date.now()}:`;
  const store = new RedisStore({ url: redisUrl, keyPrefix: prefix });
  __setWorkingMemoryStore(store);

  const sid = `smoke-${Math.random().toString(36).slice(2, 10)}`;

  // --- 1. Raw store round-trip ---
  const state1: SerializedAgentState = {
    version: 1,
    sid,
    messages: [
      { role: "user", content: "첫 번째 질문" },
      { role: "assistant", content: [{ type: "text", text: "첫 번째 답" }] },
    ],
    systemPrompt: "당신은 smoke 테스트 agent.",
    resolvedPersona: "default",
    resolvedRef: "HEAD",
    advisorCalls: 1,
    pending: null,
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
  };
  await store.put(sid, state1, 60);
  console.log("[ok]   store.put");

  const readBack = await store.get(sid);
  if (!readBack) fail("store.get returned null after put");
  assertEq("messages preserved", readBack.messages, state1.messages);
  assertEq("advisorCalls preserved", readBack.advisorCalls, 1);
  assertEq("resolvedPersona preserved", readBack.resolvedPersona, "default");

  // --- 2. AgentInstance serialize / hydrate ---
  const fresh = new AgentInstance(sid);
  (fresh as unknown as { messages: typeof state1.messages }).messages = state1.messages;
  // quick path: just verify serialize preserves shape
  const serialized = fresh.serialize();
  if (serialized.version !== 1) fail(`serialized.version expected 1, got ${serialized.version}`);
  if (serialized.sid !== sid) fail(`serialized.sid wrong`);
  console.log("[ok]   AgentInstance.serialize shape");

  const hydrated = AgentInstance.fromSerialized(state1);
  const intro = hydrated.introspect();
  if (intro.messageCount !== 2) fail(`hydrated messageCount expected 2, got ${intro.messageCount}`);
  if (intro.persona !== "default") fail(`hydrated persona wrong: ${intro.persona}`);
  if (intro.advisorCalls !== 1) fail(`hydrated advisorCalls wrong: ${intro.advisorCalls}`);
  console.log("[ok]   AgentInstance.fromSerialized hydrates state");

  // --- 3. summonAgent hydrates after Map cache clear (simulates HMR) ---
  // Put state into store, clear in-memory Map, call summonAgent → should
  // hydrate from store with our state, not a fresh agent.
  const sidHyd = `smoke-hyd-${Math.random().toString(36).slice(2, 10)}`;
  await store.put(
    sidHyd,
    {
      version: 1,
      sid: sidHyd,
      messages: [{ role: "user", content: "어제의 질문" }, { role: "assistant", content: [{ type: "text", text: "어제의 답" }] }],
      systemPrompt: "어제의 system",
      resolvedPersona: "default",
      resolvedRef: "HEAD",
      advisorCalls: 0,
      pending: null,
      createdAt: Date.now() - 1000,
      lastActiveAt: Date.now() - 500,
    },
    60,
  );

  __clearAllAgents(); // HMR simulation — Map cache 증발
  const summoned = await summonAgent(sidHyd);
  const sintro = summoned.introspect();
  if (sintro.messageCount !== 2) {
    fail(`after HMR simulation, summoned agent lost memory — messageCount=${sintro.messageCount} (expected 2)`);
  }
  console.log("[ok]   summonAgent hydrates from Redis after Map cache clear (HMR survival)");

  // --- cleanup ---
  await store.delete(sid);
  await store.delete(sidHyd);
  assertEq("after delete — get returns null", await store.get(sid), null);
  assertEq("after delete sidHyd — null", await store.get(sidHyd), null);

  await store.close();

  console.log("\nagent redis-persistence smoke passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
