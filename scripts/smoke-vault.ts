import {
  inMemoryVault,
  makeVaultRef,
  isVaultRef,
  resolveVaultRefs,
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

async function main() {
  // --- vault: session isolation ---
  const v = inMemoryVault();
  const sidA = makeSid();
  const sidB = makeSid();
  await v.put(sidA, "cia_token", "aaa-secret");
  await v.put(sidB, "cia_token", "bbb-secret");

  assertEq("vault.get sid A", await v.get(sidA, "cia_token"), "aaa-secret");
  assertEq("vault.get sid B", await v.get(sidB, "cia_token"), "bbb-secret");
  assertEq("vault.has sid A", await v.has(sidA, "cia_token"), true);
  assertEq("vault.has sid A unknown key", await v.has(sidA, "other"), false);
  assertEq("vault.get sid A unknown key", await v.get(sidA, "other"), undefined);

  await v.clear(sidA);
  assertEq("vault.get after clear(sidA)", await v.get(sidA, "cia_token"), undefined);
  assertEq("vault.get sidB after clear(sidA)", await v.get(sidB, "cia_token"), "bbb-secret");

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

  // --- resolveVaultRefs ---
  const sidC = makeSid();
  // Use the exported `vault` singleton via module: resolveVaultRefs calls vault.get
  // To keep the smoke test hermetic we import inMemoryVault above; resolveVaultRefs
  // however uses the module-level singleton. Populate it:
  const mod = await import("../src/lib/vault");
  await mod.vault.put(sidC, "cia_token", "ABCDE");
  const resolved = await resolveVaultRefs(
    sidC,
    "Authorization: Bearer @vault:cia_token",
  );
  assertEq("resolveVaultRefs substitutes", resolved, "Authorization: Bearer ABCDE");

  const unresolved = await resolveVaultRefs(sidC, "no @vault:missing here");
  assertEq("resolveVaultRefs leaves unknown keys", unresolved, "no @vault:missing here");

  // --- sid cookie roundtrip ---
  const sid = makeSid();
  const header = sidCookieHeader(sid);
  if (!header.includes("HttpOnly") || !header.includes("SameSite=Lax")) {
    console.error(`[FAIL] sidCookieHeader missing security attrs — got: ${header}`);
    process.exit(1);
  }
  console.log("[ok]   sidCookieHeader has HttpOnly + SameSite=Lax");

  // Parse "mini_agent_sid=<uuid>; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400" back
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

  console.log("\nall vault/sid smoke tests passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
