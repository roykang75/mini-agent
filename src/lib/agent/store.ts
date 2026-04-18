/**
 * WorkingMemoryStore — AgentInstance 의 직렬화 state 를 persistent 저장.
 *
 * AgentInstance 는 receive() / resumeAfterApproval() 각 완결 시점에 자기
 * state 를 store.put(sid, ...) 로 write-through. 다음 summonAgent(sid)
 * 호출 시 Map cache 를 miss 하면 store.get(sid) 로 복원.
 *
 * TTL 은 sid 쿠키 수명 (24h) 과 일치. Redis native TTL 이 자연 cleanup.
 *
 * Backend:
 *   - Redis (prod + local) — 기본 `redis://localhost:6379`
 *   - In-memory (tests only)
 */

import type { Message, ContentBlock } from "../llm/types";
import type { PendingToolCall } from "../types";
import type { PersonaName } from "../souls/registry.generated";
import { createLogger } from "../log";

const log = createLogger("agent");

export interface SerializedPendingApproval {
  sessionId: string;
  pendingToolCalls: PendingToolCall[];
  lastAssistantContent: ContentBlock[];
  memoryId: string;
}

export interface SerializedAgentState {
  version: 1;
  sid: string;
  messages: Message[];
  systemPrompt: string;
  resolvedPersona: PersonaName | null;
  resolvedRef: string | null;
  advisorCalls: number;
  pending: SerializedPendingApproval | null;
  createdAt: number;
  lastActiveAt: number;
}

export interface WorkingMemoryStore {
  put(sid: string, state: SerializedAgentState, ttlSec: number): Promise<void>;
  get(sid: string): Promise<SerializedAgentState | null>;
  delete(sid: string): Promise<void>;
  close(): Promise<void>;
}

export class InMemoryStore implements WorkingMemoryStore {
  private store = new Map<string, { state: SerializedAgentState; expiresAt: number }>();

  async put(sid: string, state: SerializedAgentState, ttlSec: number): Promise<void> {
    this.store.set(sid, { state, expiresAt: Date.now() + ttlSec * 1000 });
  }

  async get(sid: string): Promise<SerializedAgentState | null> {
    const entry = this.store.get(sid);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(sid);
      return null;
    }
    return entry.state;
  }

  async delete(sid: string): Promise<void> {
    this.store.delete(sid);
  }

  async close(): Promise<void> {
    this.store.clear();
  }
}

export class RedisStore implements WorkingMemoryStore {
  private client: import("ioredis").default;
  private keyPrefix: string;

  constructor(opts: { url?: string; keyPrefix?: string; client?: import("ioredis").default } = {}) {
    this.keyPrefix = opts.keyPrefix ?? "agent:state:";
    if (opts.client) {
      this.client = opts.client;
    } else {
      // Lazy require so test environments without ioredis don't fail at import.
      const IORedis = require("ioredis");
      const url = opts.url ?? process.env.REDIS_URL ?? "redis://localhost:6379";
      this.client = new IORedis.default(url, {
        // Fail fast on startup if Redis unavailable — don't silently degrade.
        maxRetriesPerRequest: 2,
        enableReadyCheck: true,
      });
      this.client.on("error", (err: Error) => {
        log.warn({ event: "redis_error", message: err.message }, "redis client error");
      });
    }
  }

  private key(sid: string): string {
    return `${this.keyPrefix}${sid}`;
  }

  async put(sid: string, state: SerializedAgentState, ttlSec: number): Promise<void> {
    const blob = JSON.stringify(state);
    await this.client.set(this.key(sid), blob, "EX", ttlSec);
  }

  async get(sid: string): Promise<SerializedAgentState | null> {
    const blob = await this.client.get(this.key(sid));
    if (!blob) return null;
    try {
      const parsed = JSON.parse(blob) as SerializedAgentState;
      if (parsed.version !== 1) {
        log.warn(
          { event: "state_version_mismatch", sid, got: parsed.version },
          "unknown state version — treating as missing",
        );
        return null;
      }
      return parsed;
    } catch (e) {
      log.warn(
        { event: "state_parse_failed", sid, err_message: (e as Error).message },
        "state JSON parse failed — treating as missing",
      );
      return null;
    }
  }

  async delete(sid: string): Promise<void> {
    await this.client.del(this.key(sid));
  }

  async close(): Promise<void> {
    await this.client.quit();
  }
}

let _singleton: WorkingMemoryStore | null = null;

/**
 * Singleton selected from env. Default InMemoryStore unless REDIS_URL set.
 * `AGENT_STATE_BACKEND=memory` forces in-memory even when REDIS_URL set (for tests).
 */
export function getWorkingMemoryStore(): WorkingMemoryStore {
  if (_singleton) return _singleton;
  const backend = process.env.AGENT_STATE_BACKEND;
  if (backend === "memory") {
    _singleton = new InMemoryStore();
  } else if (process.env.REDIS_URL || backend === "redis") {
    _singleton = new RedisStore();
  } else {
    _singleton = new InMemoryStore();
  }
  return _singleton;
}

/** Test-only — replace the singleton. */
export function __setWorkingMemoryStore(store: WorkingMemoryStore | null): void {
  if (_singleton && _singleton !== store) {
    _singleton.close().catch(() => {
      /* best-effort */
    });
  }
  _singleton = store;
}
