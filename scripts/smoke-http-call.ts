/**
 * E2E smoke: simulate the resumeAgent tool dispatch path.
 * 1. Store a token in a fake in-test vault backend under sid.
 * 2. Resolve @vault: refs inside synthetic tool args (the same pass agent.ts does).
 * 3. Call executeSkill("http_call", resolvedArgs) against the running cia-mock.
 * 4. Verify the first pass returns missing_fields; the retry returns 200.
 *
 * Run `npm start` in cia-mock-server first. This smoke is decoupled from the
 * real Vault backend — HashicorpVaultBackend contract is covered by
 * smoke-vault-backend.ts, and here we only care about the http_call path.
 */

import { executeSkill } from "../src/lib/skills/loader";
import { resolveVaultRefs, type VaultBackend } from "../src/lib/vault";

const CIA_URL = process.env.CIA_URL ?? "http://localhost:7777/analyze";
const SID = "smoke-sid-0001";

function fakeVault(): VaultBackend {
  const store = new Map<string, string>();
  return {
    async put(_, key, value) {
      store.set(key, value);
    },
    async get(_, key) {
      return store.get(key);
    },
    async has(_, key) {
      return store.has(key);
    },
    async clear() {
      store.clear();
    },
  };
}

const vault = fakeVault();

async function resolveAll(value: unknown): Promise<unknown> {
  if (typeof value === "string") {
    return value.includes("@vault:") ? await resolveVaultRefs(SID, value, vault) : value;
  }
  if (Array.isArray(value)) return Promise.all(value.map(resolveAll));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = await resolveAll(v);
    }
    return out;
  }
  return value;
}

function expectJson(raw: string): Record<string, unknown> {
  const parsed = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`expected object, got: ${raw}`);
  }
  return parsed as Record<string, unknown>;
}

async function main() {
  await vault.put(SID, "cia_token", "smoke-test-token-xyz");
  console.log(`[setup] stored cia_token in fake vault[${SID}]`);

  // 1) first call — intentionally omit compare_mode
  const firstArgs = await resolveAll({
    method: "POST",
    url: CIA_URL,
    headers: {
      Authorization: "Bearer @vault:cia_token",
      "Content-Type": "application/json",
    },
    body: {
      repo: "impact-analysis.git",
      base: "abc1234",
      head: "def5678",
    },
  });

  // sanity: resolved headers should not contain @vault anymore
  const resolvedAuth = ((firstArgs as { headers: { Authorization: string } }).headers).Authorization;
  if (resolvedAuth.includes("@vault:")) {
    console.error(`[FAIL] vault ref not resolved: ${resolvedAuth}`);
    process.exit(1);
  }
  console.log(`[ok]   Authorization resolved → ${resolvedAuth.replace(/[^ ]+$/, "***")}`);

  const firstRaw = await executeSkill("http_call", firstArgs);
  const first = expectJson(firstRaw);
  if (first.status !== 400) {
    console.error(`[FAIL] first call expected 400, got ${JSON.stringify(first)}`);
    process.exit(1);
  }
  console.log(`[ok]   first call → 400`, JSON.stringify(first.body));

  // 2) retry with compare_mode
  const retryArgs = await resolveAll({
    method: "POST",
    url: CIA_URL,
    headers: {
      Authorization: "Bearer @vault:cia_token",
      "Content-Type": "application/json",
    },
    body: {
      repo: "impact-analysis.git",
      base: "abc1234",
      head: "def5678",
      compare_mode: "full",
    },
  });
  const retryRaw = await executeSkill("http_call", retryArgs);
  const retry = expectJson(retryRaw);
  if (retry.status !== 200) {
    console.error(`[FAIL] retry expected 200, got ${JSON.stringify(retry)}`);
    process.exit(1);
  }
  const body = retry.body as Record<string, unknown>;
  console.log(
    `[ok]   retry → 200`,
    JSON.stringify({ risk: body.risk, affected: body.affected_services }),
  );

  // 3) 401 when Authorization missing
  const unauthArgs = await resolveAll({
    method: "POST",
    url: CIA_URL,
    headers: { "Content-Type": "application/json" },
    body: { repo: "x", base: "a", head: "b", compare_mode: "full" },
  });
  const unauthRaw = await executeSkill("http_call", unauthArgs);
  const unauth = expectJson(unauthRaw);
  if (unauth.status !== 401) {
    console.error(`[FAIL] no-auth expected 401, got ${JSON.stringify(unauth)}`);
    process.exit(1);
  }
  console.log(`[ok]   no-auth → 401`);

  console.log("\nhttp_call E2E smoke passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
