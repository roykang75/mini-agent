/**
 * Hashicorp Vault backend (AppRole + KV v2).
 *
 * Talks to Vault via raw fetch (ADR-001 — no SDK). Secrets are namespaced per
 * sid under `{mount}/{prefix}/{sid}/{key}`. The client_token is cached in
 * memory and silently re-acquired on 401/403.
 *
 * Logging: component="vault" events (vault_login, vault_put, vault_get,
 * vault_delete, vault_clear). The token and secret values never appear in
 * logs — pino's redact handles standard paths, and these call sites avoid
 * putting the raw value under a non-redacted key.
 */

import { createLogger } from "../log";
import type { VaultBackend } from "./index";

const log = createLogger("vault");

export interface HashicorpVaultOptions {
  addr: string;        // e.g. http://192.168.1.218:8200 (no trailing slash)
  roleId: string;
  secretId: string;
  mount: string;       // KV v2 mount name, e.g. "secret"
  prefix: string;      // logical key prefix, e.g. "mini-agent"
  namespace?: string;  // Vault Enterprise only
  fetchFn?: typeof fetch;
}

interface AppRoleLoginResponse {
  auth: {
    client_token: string;
    lease_duration: number;
    renewable: boolean;
  };
}

interface KvV2ReadResponse {
  data: {
    data: { value: string } | null;
    metadata: { deletion_time: string };
  };
}

interface KvV2ListResponse {
  data: { keys: string[] };
}

const SID_SEGMENT_RE = /^[a-zA-Z0-9_\-.]{1,128}$/;
const KEY_SEGMENT_RE = /^[a-zA-Z0-9_\-.]{1,64}$/;

export class HashicorpVaultBackend implements VaultBackend {
  private readonly opts: HashicorpVaultOptions;
  private readonly fetchFn: typeof fetch;
  private token: string | undefined;

  constructor(opts: HashicorpVaultOptions) {
    if (!opts.addr) throw new Error("HashicorpVault: addr is required");
    if (!opts.roleId || !opts.secretId) {
      throw new Error("HashicorpVault: roleId and secretId are required");
    }
    if (!opts.mount) throw new Error("HashicorpVault: mount is required");
    if (!opts.prefix) throw new Error("HashicorpVault: prefix is required");
    this.opts = { ...opts, addr: opts.addr.replace(/\/+$/, "") };
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  async put(sid: string, key: string, value: string): Promise<void> {
    this.assertSegment(sid, "sid");
    this.assertSegment(key, "key");
    const path = this.dataPath(sid, key);
    await this.authedRequest("POST", path, { data: { value } });
    log.info({ event: "vault_put", sid_hash: hashSid(sid), key }, "kv put ok");
  }

  async get(sid: string, key: string): Promise<string | undefined> {
    this.assertSegment(sid, "sid");
    this.assertSegment(key, "key");
    const path = this.dataPath(sid, key);
    const res = await this.authedRequest("GET", path);
    if (res.status === 404) return undefined;
    if (!res.ok) throw await toError(res, "vault get");
    const body = (await res.json()) as KvV2ReadResponse;
    return body.data?.data?.value;
  }

  async has(sid: string, key: string): Promise<boolean> {
    return (await this.get(sid, key)) !== undefined;
  }

  async clear(sid: string): Promise<void> {
    this.assertSegment(sid, "sid");
    const listPath = `${this.metadataPath(sid, "")}?list=true`;
    const res = await this.authedRequest("GET", listPath);
    if (res.status === 404) {
      log.info({ event: "vault_clear", sid_hash: hashSid(sid), count: 0 }, "nothing to clear");
      return;
    }
    if (!res.ok) throw await toError(res, "vault clear list");
    const body = (await res.json()) as KvV2ListResponse;
    const keys = body.data.keys ?? [];
    for (const k of keys) {
      const norm = k.endsWith("/") ? k.slice(0, -1) : k;
      if (!KEY_SEGMENT_RE.test(norm)) continue;
      const del = await this.authedRequest("DELETE", this.metadataPath(sid, norm));
      if (!del.ok && del.status !== 404) throw await toError(del, `vault clear delete ${norm}`);
    }
    log.info({ event: "vault_clear", sid_hash: hashSid(sid), count: keys.length }, "cleared");
  }

  private dataPath(sid: string, key: string): string {
    return `/v1/${this.opts.mount}/data/${this.opts.prefix}/${sid}/${key}`;
  }

  private metadataPath(sid: string, key: string): string {
    const tail = key ? `/${key}` : "/";
    return `/v1/${this.opts.mount}/metadata/${this.opts.prefix}/${sid}${tail}`;
  }

  private assertSegment(segment: string, label: "sid" | "key"): void {
    const re = label === "sid" ? SID_SEGMENT_RE : KEY_SEGMENT_RE;
    if (!re.test(segment)) {
      throw new Error(`HashicorpVault: invalid ${label} segment "${segment}"`);
    }
  }

  private async authedRequest(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    if (!this.token) await this.login();
    let res = await this.rawRequest(method, path, body);
    if (res.status === 401 || res.status === 403) {
      log.warn({ event: "vault_reauth", status: res.status }, "token rejected — re-login");
      this.token = undefined;
      await this.login();
      res = await this.rawRequest(method, path, body);
    }
    return res;
  }

  private async rawRequest(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (this.token) headers["x-vault-token"] = this.token;
    if (this.opts.namespace) headers["x-vault-namespace"] = this.opts.namespace;
    return this.fetchFn(`${this.opts.addr}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
  }

  private async login(): Promise<void> {
    const started = Date.now();
    const res = await this.fetchFn(`${this.opts.addr}/v1/auth/approle/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({
        role_id: this.opts.roleId,
        secret_id: this.opts.secretId,
      }),
    });
    if (!res.ok) {
      log.error(
        { event: "vault_login_failed", status: res.status, duration_ms: Date.now() - started },
        "AppRole login failed",
      );
      throw await toError(res, "vault login");
    }
    const body = (await res.json()) as AppRoleLoginResponse;
    this.token = body.auth.client_token;
    log.info(
      {
        event: "vault_login",
        duration_ms: Date.now() - started,
        lease_duration: body.auth.lease_duration,
        renewable: body.auth.renewable,
      },
      "AppRole login ok",
    );
  }
}

async function toError(res: Response, label: string): Promise<Error> {
  const text = await res.text().catch(() => "");
  return new Error(`${label}: HTTP ${res.status} ${res.statusText} ${text.slice(0, 200)}`);
}

function hashSid(sid: string): string {
  // Short non-reversible tag so logs can correlate sessions without leaking the cookie.
  let h = 0;
  for (let i = 0; i < sid.length; i++) h = (h * 31 + sid.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16).padStart(8, "0").slice(0, 8);
}

export function createHashicorpVaultFromEnv(): HashicorpVaultBackend {
  const required = ["VAULT_ADDR", "VAULT_ROLE_ID", "VAULT_SECRET_ID", "VAULT_KV_MOUNT", "VAULT_KV_PREFIX"] as const;
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(
      `HashicorpVault: missing required env vars: ${missing.join(", ")}. ` +
        `Set them in .env.local — see .env.local.sample for shape.`,
    );
  }
  return new HashicorpVaultBackend({
    addr: process.env.VAULT_ADDR!,
    roleId: process.env.VAULT_ROLE_ID!,
    secretId: process.env.VAULT_SECRET_ID!,
    mount: process.env.VAULT_KV_MOUNT!,
    prefix: process.env.VAULT_KV_PREFIX!,
    namespace: process.env.VAULT_NAMESPACE,
  });
}
