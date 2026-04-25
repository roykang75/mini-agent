/**
 * NightWatchClient — Night's Watch observer client.
 *
 * - Fire-and-forget batch POST: queue 에 모은 후 250ms timer 또는 32 item 한도에서
 *   batch flush.
 * - **Outbox + retry** (Phase 2): flush 실패 시 batch JSON 을 디스크
 *   (`.observer-outbox/`) 에 적재. 30s 주기로 background reaper 가 재시도. 200
 *   응답 받으면 파일 삭제. MAX_RETRY 초과 시 `.observer-outbox/dead/` 로 이동
 *   (수동 검수 후 처리).
 *
 * env:
 *   NW_ENABLED            "on" 이면 활성. 그 외 ("off"/"") → 모든 push 가 no-op.
 *   NW_BASE_URL           기본 "http://localhost:3001". `/api/ingest` 자동 결합.
 *   NW_INGEST_TOKEN       있으면 `Authorization: Bearer <token>` 헤더.
 *   NW_OUTBOX_DIR         기본 `<cwd>/.observer-outbox`. 실패 batch 적재 위치.
 *   NW_OUTBOX_ENABLED     "off" 이면 outbox 도 끔 (drop 만, Phase 1 동작).
 *   MINI_AGENT_VERSION    AgentIdentity.version. 없으면 "0.1.0".
 *
 * 보안: body 안의 vault ref (`@vault:...`) 는 그대로 전송 (resolve 안 함).
 * Authorization 헤더는 NightWatch 서버 인증 용. agent ↔ server payload 안에는
 * api key / secret 이 들어가지 않도록 호출 측 책임.
 */

import { hostname } from "node:os";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve as pathResolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createLogger } from "../log";
import type { AgentIdentity, IngestBatch, IngestItem } from "./wire";

const log = createLogger("night-watch");

const FLUSH_INTERVAL_MS = 250;
const BATCH_MAX = 32;
const REQUEST_TIMEOUT_MS = 2000;
const OUTBOX_REAP_INTERVAL_MS = 30_000;
const OUTBOX_MAX_RETRY = 5;
const OUTBOX_REAP_PER_TICK = 5;

export interface NightWatchConfig {
  enabled: boolean;
  baseUrl: string;
  token: string | null;
  agent: AgentIdentity;
  /** Outbox 적재 디렉토리. 미지정 시 reaper 자동 비활성. */
  outboxDir?: string;
  /** 명시적 false 면 outbox 비활성. 미지정 + outboxDir 있음 = 활성. */
  outboxEnabled?: boolean;
}

interface OutboxFileMeta {
  path: string;
  retry: number;
  mtimeMs: number;
}

function readOutboxRetry(filename: string): number {
  // <ts>-<uuid>-r<n>.jsonl
  const m = filename.match(/-r(\d+)\.jsonl$/);
  return m ? Number(m[1]) : 0;
}

export class NightWatchClient {
  private queue: IngestItem[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private reaperTimer: ReturnType<typeof setInterval> | null = null;

  private readonly outboxDir: string | null;
  private readonly outboxEnabled: boolean;

  constructor(private readonly cfg: NightWatchConfig) {
    this.outboxDir = cfg.outboxDir ?? null;
    this.outboxEnabled =
      cfg.outboxEnabled !== false && this.outboxDir !== null;
    if (cfg.enabled && this.outboxEnabled) this.startReaper();
  }

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
        this.writeOutbox(batch);
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
      this.writeOutbox(batch);
    } finally {
      clearTimeout(timeout);
    }
  }

  private writeOutbox(batch: IngestBatch): void {
    if (!this.outboxEnabled || !this.outboxDir) return;
    try {
      mkdirSync(this.outboxDir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const id = randomUUID().slice(0, 8);
      const path = join(this.outboxDir, `${ts}-${id}-r0.jsonl`);
      writeFileSync(path, JSON.stringify(batch));
      log.info({ event: "outbox_buffered", path, items: batch.items.length });
    } catch (err) {
      log.warn({
        event: "outbox_write_failed",
        err_message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private listOutbox(): OutboxFileMeta[] {
    if (!this.outboxDir) return [];
    try {
      const files = readdirSync(this.outboxDir);
      const out: OutboxFileMeta[] = [];
      for (const f of files) {
        if (!f.endsWith(".jsonl")) continue;
        const fp = join(this.outboxDir, f);
        try {
          const st = statSync(fp);
          if (!st.isFile()) continue;
          out.push({
            path: fp,
            retry: readOutboxRetry(f),
            mtimeMs: st.mtimeMs,
          });
        } catch {
          /* ignore */
        }
      }
      out.sort((a, b) => a.mtimeMs - b.mtimeMs);
      return out;
    } catch {
      return [];
    }
  }

  /** Visible for tests / manual sweep. */
  async reapOutbox(): Promise<{ tried: number; ok: number; failed: number; dead: number }> {
    if (!this.cfg.enabled || !this.outboxEnabled || !this.outboxDir) {
      return { tried: 0, ok: 0, failed: 0, dead: 0 };
    }
    const files = this.listOutbox().slice(0, OUTBOX_REAP_PER_TICK);
    let ok = 0;
    let failed = 0;
    let dead = 0;
    for (const f of files) {
      let batch: IngestBatch;
      try {
        batch = JSON.parse(readFileSync(f.path, "utf8")) as IngestBatch;
      } catch {
        try {
          unlinkSync(f.path);
        } catch {
          /* ignore */
        }
        continue;
      }
      const sent = await this.postBatch(batch);
      if (sent) {
        try {
          unlinkSync(f.path);
        } catch {
          /* ignore */
        }
        ok += 1;
      } else if (f.retry + 1 >= OUTBOX_MAX_RETRY) {
        const deadDir = join(this.outboxDir, "dead");
        try {
          mkdirSync(deadDir, { recursive: true });
          renameSync(f.path, join(deadDir, basename(f.path)));
        } catch {
          try {
            unlinkSync(f.path);
          } catch {
            /* ignore */
          }
        }
        dead += 1;
      } else {
        // Bump retry counter in filename
        const next = f.path.replace(
          /-r(\d+)\.jsonl$/,
          () => `-r${f.retry + 1}.jsonl`,
        );
        try {
          renameSync(f.path, next);
        } catch {
          /* ignore */
        }
        failed += 1;
      }
    }
    return { tried: files.length, ok, failed, dead };
  }

  private async postBatch(batch: IngestBatch): Promise<boolean> {
    const url = `${this.cfg.baseUrl.replace(/\/$/, "")}/api/ingest`;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.cfg.token) headers.authorization = `Bearer ${this.cfg.token}`;
    const ac = new AbortController();
    const timeout = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: "POST",
        cache: "no-store",
        headers,
        body: JSON.stringify(batch),
        signal: ac.signal,
      });
      return res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  startReaper(): void {
    if (this.reaperTimer) return;
    this.reaperTimer = setInterval(() => {
      void this.reapOutbox();
    }, OUTBOX_REAP_INTERVAL_MS);
    const t = this.reaperTimer as { unref?: () => void };
    if (typeof t.unref === "function") t.unref();
  }

  stopReaper(): void {
    if (this.reaperTimer) {
      clearInterval(this.reaperTimer);
      this.reaperTimer = null;
    }
  }
}

function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
}

let _client: NightWatchClient | null = null;

export function getNightWatchClient(): NightWatchClient {
  if (_client) return _client;
  const enabled = (process.env.NW_ENABLED ?? "off").toLowerCase() === "on";
  const baseUrl = process.env.NW_BASE_URL ?? "http://localhost:3001";
  const token = process.env.NW_INGEST_TOKEN ?? null;
  const version = process.env.MINI_AGENT_VERSION ?? "0.1.0";
  const outboxDir = pathResolve(
    process.cwd(),
    process.env.NW_OUTBOX_DIR ?? ".observer-outbox",
  );
  const outboxEnabled =
    (process.env.NW_OUTBOX_ENABLED ?? "on").toLowerCase() !== "off";
  _client = new NightWatchClient({
    enabled,
    baseUrl,
    token,
    agent: {
      name: "mini-agent",
      version,
      hostname: hostname(),
    },
    outboxDir,
    outboxEnabled,
  });
  return _client;
}

/** Test-only — replace the singleton (or null to force re-init from env on next get). */
export function setNightWatchClient(client: NightWatchClient | null): void {
  _client = client;
}
