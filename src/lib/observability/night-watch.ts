/**
 * NightWatchClient — Night's Watch observer client.
 *
 * Plan §2.9 Phase 1: fire-and-forget. queue 에 모은 후 250ms timer 또는 32 item
 * 한도에서 batch POST. 실패는 warn 로그 + drop. retry / outbox 는 Phase 2.
 *
 * env:
 *   NW_ENABLED            "on" 이면 활성. 그 외 ("off"/"") → 모든 push 가 no-op.
 *   NW_BASE_URL           기본 "http://localhost:3001". `/api/ingest` 자동 결합.
 *   NW_INGEST_TOKEN       있으면 `Authorization: Bearer <token>` 헤더.
 *   MINI_AGENT_VERSION    AgentIdentity.version. 없으면 "0.1.0".
 *
 * 보안: body 안의 vault ref (`@vault:...`) 는 그대로 전송 (resolve 안 함).
 * Authorization 헤더는 NightWatch 서버 인증 용. agent ↔ server payload 안에는
 * api key / secret 이 들어가지 않도록 호출 측 책임.
 */

import { hostname } from "node:os";
import { createLogger } from "../log";
import type { AgentIdentity, IngestBatch, IngestItem } from "./wire";

const log = createLogger("night-watch");

const FLUSH_INTERVAL_MS = 250;
const BATCH_MAX = 32;
const REQUEST_TIMEOUT_MS = 2000;

export interface NightWatchConfig {
  enabled: boolean;
  baseUrl: string;
  token: string | null;
  agent: AgentIdentity;
}

export class NightWatchClient {
  private queue: IngestItem[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly cfg: NightWatchConfig) {}

  enabled(): boolean {
    return this.cfg.enabled;
  }

  /** Test/observability hook — clone of pending queue. */
  pendingCount(): number {
    return this.queue.length;
  }

  push(item: IngestItem): void {
    if (!this.cfg.enabled) return;
    this.queue.push(item);
    if (this.queue.length >= BATCH_MAX) {
      void this.flush();
      return;
    }
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        void this.flush();
      }, FLUSH_INTERVAL_MS);
      // unref so a pending timer doesn't keep node alive in CLI scripts.
      const t = this.flushTimer as { unref?: () => void };
      if (typeof t.unref === "function") t.unref();
    }
  }

  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.queue.length === 0) return;
    const items = this.queue.splice(0, this.queue.length);
    const batch: IngestBatch = {
      schema_version: 1,
      agent: this.cfg.agent,
      items,
    };
    const url = `${this.cfg.baseUrl.replace(/\/$/, "")}/api/ingest`;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.cfg.token) headers.authorization = `Bearer ${this.cfg.token}`;

    const ac = new AbortController();
    const timeout = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
    const started = Date.now();
    try {
      const res = await fetch(url, {
        method: "POST",
        cache: "no-store",
        headers,
        body: JSON.stringify(batch),
        signal: ac.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        log.warn(
          {
            event: "ingest_failed",
            status: res.status,
            items: items.length,
            duration_ms: Date.now() - started,
            body_preview: body.slice(0, 200),
          },
          "ravens lost (http)",
        );
        return;
      }
      log.info(
        {
          event: "ingest_ok",
          items: items.length,
          duration_ms: Date.now() - started,
        },
        "ravens delivered",
      );
    } catch (e) {
      const err = e as Error;
      log.warn(
        {
          event: "ingest_error",
          err_name: err.name,
          err_message: err.message,
          items: items.length,
          duration_ms: Date.now() - started,
        },
        "ravens lost (network)",
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

let _client: NightWatchClient | null = null;

export function getNightWatchClient(): NightWatchClient {
  if (_client) return _client;
  const enabled = (process.env.NW_ENABLED ?? "off").toLowerCase() === "on";
  const baseUrl = process.env.NW_BASE_URL ?? "http://localhost:3001";
  const token = process.env.NW_INGEST_TOKEN ?? null;
  const version = process.env.MINI_AGENT_VERSION ?? "0.1.0";
  _client = new NightWatchClient({
    enabled,
    baseUrl,
    token,
    agent: {
      name: "mini-agent",
      version,
      hostname: hostname(),
    },
  });
  return _client;
}

/** Test-only — replace the singleton (or null to force re-init from env on next get). */
export function setNightWatchClient(client: NightWatchClient | null): void {
  _client = client;
}
