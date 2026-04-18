/**
 * Agents 의 집 — sid 로 keyed 된 살아있는 AgentInstance 들의 register.
 *
 * Storage Map 이 아니다. 주체들의 서식지.
 *
 * Lifecycle:
 *   - summonAgent(sid): Promise<AgentInstance>
 *       1) 이미 Map 에 있으면 그대로 반환 (fast path, in-process).
 *       2) 없으면 WorkingMemoryStore 에서 hydrate 시도.
 *       3) 둘 다 없으면 새 AgentInstance 탄생.
 *   - sweepIdle(maxIdleMs): 유휴 agent 를 dispose + 제거 (cron / 주기 호출)
 *   - disposeAgent(sid): 즉시 dispose + Map/store 제거
 *
 * Map 은 process 수명 동안의 cache — HMR / 재시작 시 비워짐. 진짜
 * durable 상태는 WorkingMemoryStore (Redis) 에 있음. sid 쿠키가 살아있는
 * 동안 다음 요청은 store 에서 hydrate 되어 같은 agent 를 이어감.
 */

import { AgentInstance } from "./instance";
import { getWorkingMemoryStore } from "./store";

const agents = new Map<string, AgentInstance>();

export async function summonAgent(sid: string): Promise<AgentInstance> {
  let a = agents.get(sid);
  if (a) return a;

  const store = getWorkingMemoryStore();
  const state = await store.get(sid);
  if (state) {
    a = AgentInstance.fromSerialized(state);
  } else {
    a = new AgentInstance(sid);
  }
  agents.set(sid, a);
  return a;
}

export function getAgent(sid: string): AgentInstance | undefined {
  return agents.get(sid);
}

export async function disposeAgent(sid: string): Promise<void> {
  const a = agents.get(sid);
  if (a) {
    a.dispose();
    agents.delete(sid);
  }
  const store = getWorkingMemoryStore();
  await store.delete(sid);
}

/** Dispose agents (in-memory Map) with lastActiveAt older than `maxIdleMs`. */
export async function sweepIdle(maxIdleMs: number): Promise<number> {
  const now = Date.now();
  let removed = 0;
  for (const [sid, a] of agents) {
    const idle = now - a.introspect().lastActiveAt;
    if (idle > maxIdleMs) {
      a.dispose();
      agents.delete(sid);
      removed++;
    }
  }
  // Note: store entries have TTL (SID_TTL_SEC) native to Redis; we don't sweep them here.
  return removed;
}

export function __clearAllAgents(): void {
  for (const a of agents.values()) a.dispose();
  agents.clear();
}

export function __agentCount(): number {
  return agents.size;
}
