/**
 * Agents 의 집 — sid 로 keyed 된 살아있는 AgentInstance 들의 register.
 *
 * Storage Map 이 아니다. 주체들의 서식지.
 *
 * Lifecycle:
 *   - summonAgent(sid): AgentInstance — 없으면 탄생, 있으면 깨움
 *   - sweepIdle(maxIdleMs): 유휴 agent 를 dispose + 제거 (cron / 주기 호출)
 *   - disposeAgent(sid): 즉시 dispose + 제거
 */

import { AgentInstance } from "./instance";

const agents = new Map<string, AgentInstance>();

export function summonAgent(sid: string): AgentInstance {
  let a = agents.get(sid);
  if (!a) {
    a = new AgentInstance(sid);
    agents.set(sid, a);
  }
  return a;
}

export function getAgent(sid: string): AgentInstance | undefined {
  return agents.get(sid);
}

export function disposeAgent(sid: string): void {
  const a = agents.get(sid);
  if (a) {
    a.dispose();
    agents.delete(sid);
  }
}

/** Dispose agents with lastActiveAt older than `maxIdleMs`. Returns the number removed. */
export function sweepIdle(maxIdleMs: number): number {
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
  return removed;
}

/** Test-only — wipe all agents. */
export function __clearAllAgents(): void {
  for (const a of agents.values()) a.dispose();
  agents.clear();
}

/** Test-only — count currently summoned agents. */
export function __agentCount(): number {
  return agents.size;
}
