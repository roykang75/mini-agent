/**
 * In-memory Vault for M1.
 *
 * - Secrets are scoped per session cookie (sid).
 * - The LLM never sees the raw value; it only sees `@vault:<key>` references.
 * - Tool handlers call `resolveVaultRefs(sid, text)` right before making external
 *   calls. The raw value therefore never appears in message history or events.
 *
 * The VaultBackend interface is deliberately async so a real-Vault adapter
 * (AppRole + KV v2 at 192.168.1.218) can slot in without touching callers.
 */

export interface VaultBackend {
  put(sid: string, key: string, value: string): Promise<void>;
  get(sid: string, key: string): Promise<string | undefined>;
  has(sid: string, key: string): Promise<boolean>;
  clear(sid: string): Promise<void>;
}

export function inMemoryVault(): VaultBackend {
  const store = new Map<string, Map<string, string>>();
  const bucket = (sid: string): Map<string, string> => {
    let m = store.get(sid);
    if (!m) {
      m = new Map();
      store.set(sid, m);
    }
    return m;
  };
  return {
    async put(sid, key, value) {
      bucket(sid).set(key, value);
    },
    async get(sid, key) {
      return store.get(sid)?.get(key);
    },
    async has(sid, key) {
      return store.get(sid)?.has(key) ?? false;
    },
    async clear(sid) {
      store.delete(sid);
    },
  };
}

export const vault: VaultBackend = inMemoryVault();

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
 */
export async function resolveVaultRefs(sid: string, text: string): Promise<string> {
  const matches = Array.from(text.matchAll(VAULT_REF_RE));
  if (matches.length === 0) return text;
  let out = text;
  for (const m of matches) {
    const key = m[1];
    const v = await vault.get(sid, key);
    if (v !== undefined) out = out.split(m[0]).join(v);
  }
  return out;
}
