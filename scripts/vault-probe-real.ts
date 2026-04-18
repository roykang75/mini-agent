/**
 * 실 Hashicorp Vault 서버 연결 검증 스크립트.
 *
 * .env.local 에 VAULT_ADDR / VAULT_ROLE_ID / VAULT_SECRET_ID /
 * VAULT_KV_MOUNT / VAULT_KV_PREFIX 설정 후:
 *
 *   npx tsx scripts/vault-probe-real.ts
 *
 * 수행:
 *   1. AppRole 로그인 (client_token 획득)
 *   2. put → get → has → clear 사이클 (테스트 sid: probe-YYYYMMDD-HHmmss)
 *   3. 결과 요약 + pino 로그에서 vault_login/put/get/clear 이벤트 확인
 *
 * 성공 시 exit 0. 실패 시 exit 1 + 사람-읽기 가능한 원인.
 *
 * 주의: 이 스크립트는 실 Vault 에 쓰기를 수행. probe-* 접두 sid 로
 * 격리되고 마지막에 clear 로 정리되지만, 예기치 못한 종료 시 남을 수
 * 있음. `vault kv list secret/<PREFIX>/` 로 확인 + 필요시 수동 정리.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HashicorpVaultBackend } from "../src/lib/vault/hashicorp";

// Minimal .env.local loader — no dotenv dep.
// Format: KEY=value per line, lines starting with # ignored, blank lines ignored.
// Quoted values ("..." or '...') are unquoted. Existing process.env wins.
function loadEnvLocal(): void {
  try {
    const raw = readFileSync(join(process.cwd(), ".env.local"), "utf8");
    for (const line of raw.split("\n")) {
      const s = line.trim();
      if (!s || s.startsWith("#")) continue;
      const eq = s.indexOf("=");
      if (eq < 0) continue;
      const k = s.slice(0, eq).trim();
      let v = s.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (process.env[k] === undefined) process.env[k] = v;
    }
  } catch {
    // .env.local missing — tolerate; env may come from shell.
  }
}

loadEnvLocal();

function fail(msg: string): never {
  console.error(`[FAIL] ${msg}`);
  process.exit(1);
}

function assertEq<T>(label: string, actual: T, expected: T) {
  if (actual !== expected) {
    fail(`${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
  console.log(`[ok]   ${label} → ${JSON.stringify(actual)}`);
}

async function main() {
  const required = ["VAULT_ADDR", "VAULT_ROLE_ID", "VAULT_SECRET_ID", "VAULT_KV_MOUNT", "VAULT_KV_PREFIX"] as const;
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    fail(`missing env: ${missing.join(", ")} — check .env.local`);
  }

  const addr = process.env.VAULT_ADDR!;
  console.log(`[info] VAULT_ADDR = ${addr}`);
  console.log(`[info] mount=${process.env.VAULT_KV_MOUNT} prefix=${process.env.VAULT_KV_PREFIX}`);

  // Quick reachability check before AppRole.
  try {
    const health = await fetch(`${addr.replace(/\/+$/, "")}/v1/sys/health`, {
      method: "GET",
      cache: "no-store",
    });
    console.log(`[ok]   /sys/health → HTTP ${health.status}`);
    if (health.status === 503) {
      fail("Vault is sealed — run `vault operator unseal` 3 times with unseal keys");
    }
  } catch (e) {
    fail(`cannot reach ${addr}: ${(e as Error).message}`);
  }

  const vault = new HashicorpVaultBackend({
    addr,
    roleId: process.env.VAULT_ROLE_ID!,
    secretId: process.env.VAULT_SECRET_ID!,
    mount: process.env.VAULT_KV_MOUNT!,
    prefix: process.env.VAULT_KV_PREFIX!,
  });

  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  const sid = `probe-${stamp}`;
  const testValue = `probe-value-${Math.random().toString(36).slice(2, 10)}`;

  console.log(`\n[info] using test sid = ${sid}`);

  // 1. put
  await vault.put(sid, "probe_key", testValue);
  console.log(`[ok]   put(${sid}, probe_key, <redacted>)`);

  // 2. get
  const got = await vault.get(sid, "probe_key");
  assertEq("get roundtrip", got, testValue);

  // 3. has
  assertEq("has(existing)", await vault.has(sid, "probe_key"), true);
  assertEq("has(missing)", await vault.has(sid, "never_set"), false);
  assertEq("get(missing) returns undefined", await vault.get(sid, "never_set"), undefined);

  // 4. put second key
  await vault.put(sid, "probe_key_2", "another-value");
  console.log(`[ok]   put second key`);

  // 5. clear
  await vault.clear(sid);
  assertEq("after clear — probe_key gone", await vault.get(sid, "probe_key"), undefined);
  assertEq("after clear — probe_key_2 gone", await vault.get(sid, "probe_key_2"), undefined);

  console.log("\nreal vault probe passed.");
  console.log("   • AppRole login: ok");
  console.log("   • KV v2 put/get/has: ok");
  console.log("   • clear (list + metadata delete): ok");
  console.log(`   • pino 로그에서 event:vault_login / vault_put / vault_get / vault_clear 가 찍혀있는지 확인`);
}

main().catch((e) => {
  console.error("\n[FAIL]", e instanceof Error ? e.message : String(e));
  if (e instanceof Error && e.stack) console.error(e.stack);
  process.exit(1);
});
