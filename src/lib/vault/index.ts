/**
 * Vault facade.
 *
 * Runtime: HashicorpVaultBackend wired from env (VAULT_ADDR + AppRole creds).
 * The singleton is lazy — the backend is constructed on first vault operation
 * so scripts / smokes that don't touch the backend can import this module
 * without needing the env set.
 *
 * Tests: construct HashicorpVaultBackend directly with a mock fetch/URL, or
 * pass a fresh VaultBackend implementation into `resolveVaultRefs` via its
 * optional `backend` arg.
 *
 * The LLM never sees raw values; it only sees `@vault:<key>` refs. Handlers
 * call `resolveVaultRefs(sid, text)` right before external calls, and the raw
 * value therefore never appears in message history or agent events.
 */

import { createHashicorpVaultFromEnv } from "./hashicorp";

export interface VaultBackend {
  put(sid: string, key: string, value: string): Promise<void>;
  get(sid: string, key: string): Promise<string | undefined>;
  has(sid: string, key: string): Promise<boolean>;
  clear(sid: string): Promise<void>;
}

let _backend: VaultBackend | null = null;
function backend(): VaultBackend {
  return (_backend ??= createHashicorpVaultFromEnv());
}

export const vault: VaultBackend = {
  put: (sid, key, value) => backend().put(sid, key, value),
  get: (sid, key) => backend().get(sid, key),
  has: (sid, key) => backend().has(sid, key),
  clear: (sid) => backend().clear(sid),
};

const VAULT_REF_RE = /@vault:([a-zA-Z0-9_\-.]+)/g;
const VAULT_KEY_RE = /^[a-zA-Z0-9_\-.]{1,64}$/;

export function makeVaultRef(key: string): string {
  if (!VAULT_KEY_RE.test(key)) {
    throw new Error(`Invalid vault key: ${key}`);
  }
  return `@vault:${key}`;
}

export function isVaultRef(s: string): boolean {
  return /^@vault:[a-zA-Z0-9_\-.]+$/.test(s);
}

/**
 * Replace every `@vault:<key>` token inside `text` with its stored value.
 * Unknown keys are left as-is so the downstream error surface is meaningful.
 *
 * `backend` is injectable for tests; production callers should use the default
 * module-level `vault`.
 */
export async function resolveVaultRefs(
  sid: string,
  text: string,
  b: VaultBackend = vault,
): Promise<string> {
  const matches = Array.from(text.matchAll(VAULT_REF_RE));
  if (matches.length === 0) return text;
  let out = text;
  for (const m of matches) {
    const key = m[1];
    const v = await b.get(sid, key);
    if (v !== undefined) out = out.split(m[0]).join(v);
  }
  return out;
}

export { HashicorpVaultBackend, createHashicorpVaultFromEnv } from "./hashicorp";
