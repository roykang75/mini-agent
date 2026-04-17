// Vault refs + sid cookie smoke. Backend contract is covered separately in
// scripts/smoke-vault-backend.ts against a mock Hashicorp Vault server.

import {
  makeVaultRef,
  isVaultRef,
  resolveVaultRefs,
  type VaultBackend,
} from "../src/lib/vault";
import {
  makeSid,
  readSidFromCookieHeader,
  sidCookieHeader,
} from "../src/lib/sid";

function assertEq<T>(label: string, actual: T, expected: T) {
  if (actual !== expected) {
    console.error(`[FAIL] ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    process.exit(1);
  }
  console.log(`[ok]   ${label} → ${JSON.stringify(actual)}`);
}

function fakeVault(): VaultBackend {
  const store = new Map<string, Map<string, string>>();
  const bucket = (sid: string) => {
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

async function main() {
  // --- refs ---
  assertEq("makeVaultRef('cia_token')", makeVaultRef("cia_token"), "@vault:cia_token");
  assertEq("isVaultRef('@vault:cia_token')", isVaultRef("@vault:cia_token"), true);
  assertEq("isVaultRef('not a ref')", isVaultRef("Bearer xxx"), false);

  try {
    makeVaultRef("bad key with spaces");
    console.error("[FAIL] makeVaultRef should reject spaces");
    process.exit(1);
  } catch {
    console.log("[ok]   makeVaultRef rejects invalid keys");
  }

  // --- resolveVaultRefs (with injected fake backend so no real Vault is touched) ---
  const fake = fakeVault();
  const sidC = makeSid();
  await fake.put(sidC, "cia_token", "ABCDE");
  const resolved = await resolveVaultRefs(
    sidC,
    "Authorization: Bearer @vault:cia_token",
    fake,
  );
  assertEq("resolveVaultRefs substitutes", resolved, "Authorization: Bearer ABCDE");

  const unresolved = await resolveVaultRefs(sidC, "no @vault:missing here", fake);
  assertEq("resolveVaultRefs leaves unknown keys", unresolved, "no @vault:missing here");

  // --- sid cookie roundtrip ---
  const sid = makeSid();
  const header = sidCookieHeader(sid);
  if (!header.includes("HttpOnly") || !header.includes("SameSite=Lax")) {
    console.error(`[FAIL] sidCookieHeader missing security attrs — got: ${header}`);
    process.exit(1);
  }
  console.log("[ok]   sidCookieHeader has HttpOnly + SameSite=Lax");

  const cookieOnly = header.split(";")[0];
  assertEq("readSidFromCookieHeader roundtrip", readSidFromCookieHeader(cookieOnly), sid);
  assertEq(
    "readSidFromCookieHeader rejects malformed",
    readSidFromCookieHeader("mini_agent_sid=not-a-uuid"),
    undefined,
  );
  assertEq(
    "readSidFromCookieHeader empty",
    readSidFromCookieHeader(null),
    undefined,
  );

  console.log("\nall vault-ref/sid smoke tests passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
