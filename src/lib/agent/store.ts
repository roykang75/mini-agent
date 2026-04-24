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
import type { PendingToolCall, AskUserOption } from "../types";
import type { PersonaName } from "../souls/registry.generated";
import { createLogger } from "../log";

const log = createLogger("agent");

export interface SerializedPendingApproval {
  sessionId: string;
  pendingToolCalls: PendingToolCall[];
  lastAssistantContent: ContentBlock[];
  memoryId: string;
}

/**
 * ask_user tool 의 pending 상태. `SerializedPendingApproval` 과는 완전히 별도
 * 필드 — 보안 게이트(approval) 와 UX 게이트(user_input) 의 분리 유지.
 */
export interface SerializedPendingUserInput {
  sessionId: string;
  toolUseId: string;
  memoryId: string;
  lastAssistantContent: ContentBlock[];
  kind: "choose" | "confirm";
  /** 서버 검증용 — choose 일 때 사용자가 답한 id 가 이 목록 안에 있어야 함. */
  optionIds?: string[];
  multi?: boolean;
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
  pendingUserInput: SerializedPendingUserInput | null;
  /** 세션에 고정된 LLM profile 이름. 첫 receive() 때 결정되고 대화 내내 유지. */
  profileName: string | null;
  createdAt: number;
  lastActiveAt: number;
}

// `AskUserOption` 은 타입 가져오기만 했지 값으로 쓰진 않음 — store 는 option 자체를 저장하지
// 않고 optionIds 만 직렬화해서 가볍게 유지. (UI 에 다시 보여줄 options 는 messages 내
// assistant content 의 tool_use block.input 에 이미 들어 있음.)
export type { AskUserOption };

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
