// HashicorpVaultBackend contract smoke against a mock Vault HTTP server.
//
// Covers:
//   1. AppRole login — uses role_id/secret_id, stores client_token in memory
//   2. KV v2 put/get/has round-trip
//   3. Session isolation — different sids don't see each other's keys
//   4. 404 on get of unknown key returns undefined (not throw)
//   5. clear(sid) — list + metadata delete for all keys under that sid
//   6. Token expiry — 401 response triggers re-login transparently
//   7. resolveVaultRefs with the real backend

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";

import { HashicorpVaultBackend } from "../src/lib/vault/hashicorp";
import { resolveVaultRefs } from "../src/lib/vault";
import { makeSid } from "../src/lib/sid";

interface MockStore {
  // key = `${mount}/data/${prefix}/${sid}/${key}`
  data: Map<string, string>;
}

function fail(msg: string): never {
  console.error(`[FAIL] ${msg}`);
  process.exit(1);
}

function assertEq<T>(label: string, actual: T, expected: T) {
  if (actual !== expected) fail(`${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  console.log(`[ok]   ${label} → ${JSON.stringify(actual)}`);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw.length > 0 ? JSON.parse(raw) : null;
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function startMockVault(opts: { roleId: string; secretId: string; initialBadTokens?: number }): Promise<{
  url: string;
  close: () => void;
  store: MockStore;
  stats: { loginCalls: number; totalCalls: number };
}> {
  const store: MockStore = { data: new Map() };
  const stats = { loginCalls: 0, totalCalls: 0 };
  // List of tokens we'll reject once to exercise re-auth. Popped per 401.
  let pendingRejects = opts.initialBadTokens ?? 0;

  const server: Server = createServer(async (req, res) => {
    stats.totalCalls++;
    const url = req.url ?? "/";
    const method = req.method ?? "GET";

    try {
      if (url === "/v1/auth/approle/login" && method === "POST") {
        stats.loginCalls++;
        const body = (await readJson(req)) as { role_id?: string; secret_id?: string } | null;
        if (!body || body.role_id !== opts.roleId || body.secret_id !== opts.secretId) {
          return json(res, 403, { errors: ["invalid approle credentials"] });
        }
        return json(res, 200, {
          request_id: "mock-login",
          auth: {
            client_token: `mock.token.${stats.loginCalls}`,
            lease_duration: 3600,
            renewable: true,
            policies: ["default"],
          },
        });
      }

      const token = req.headers["x-vault-token"];
      if (!token) return json(res, 401, { errors: ["missing token"] });
      if (pendingRejects > 0) {
        pendingRejects--;
        return json(res, 401, { errors: ["token rejected (simulated)"] });
      }

      // KV v2 data: POST / GET / (DELETE)
      const dataMatch = url.match(/^\/v1\/([^/]+)\/data\/(.+)$/);
      if (dataMatch) {
        const [, , logicalPath] = dataMatch;
        if (method === "POST") {
          const body = (await readJson(req)) as { data?: { value?: string } } | null;
          const value = body?.data?.value;
          if (typeof value !== "string") return json(res, 400, { errors: ["bad body"] });
          store.data.set(logicalPath, value);
          return json(res, 200, {
            request_id: "mock-put",
            data: { created_time: new Date().toISOString(), version: 1 },
          });
        }
        if (method === "GET") {
          const v = store.data.get(logicalPath);
          if (v === undefined) return json(res, 404, { errors: [] });
          return json(res, 200, {
            request_id: "mock-get",
            data: { data: { value: v }, metadata: { version: 1, deletion_time: "" } },
          });
        }
      }

      // KV v2 metadata: GET ?list=true / DELETE a specific key
      const [urlPath, query = ""] = url.split("?");
      const metaMatch = urlPath.match(/^\/v1\/([^/]+)\/metadata\/(.+?)\/?$/);
      if (metaMatch && method === "GET" && query.includes("list=true")) {
        const [, , listPath] = metaMatch;
        const keys = new Set<string>();
        for (const k of store.data.keys()) {
          if (k.startsWith(`${listPath}/`)) {
            const rest = k.slice(listPath.length + 1);
            const head = rest.split("/")[0];
            if (rest.includes("/")) keys.add(`${head}/`);
            else keys.add(head);
          }
        }
        if (keys.size === 0) return json(res, 404, { errors: [] });
        return json(res, 200, {
          request_id: "mock-list",
          data: { keys: Array.from(keys) },
        });
      }
      if (metaMatch && method === "DELETE") {
        const [, , deletePath] = metaMatch;
        store.data.delete(deletePath);
        res.writeHead(204);
        return res.end();
      }

      res.writeHead(404);
      res.end(`no route for ${method} ${url}`);
    } catch (e) {
      res.writeHead(500);
      res.end(String(e));
    }
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => server.close(),
        store,
        stats,
      });
    });
  });
}

async function main() {
  const ROLE_ID = "00000000-role-0000-0000-000000000001";
  const SECRET_ID = "00000000-scrt-0000-0000-000000000001";
  const MOUNT = "secret";
  const PREFIX = "mini-agent-smoke";

  // ---- 1/2/3/4: login + put/get + session isolation + 404 ----
  const mock = await startMockVault({ roleId: ROLE_ID, secretId: SECRET_ID });
  try {
    const vault = new HashicorpVaultBackend({
      addr: mock.url,
      roleId: ROLE_ID,
      secretId: SECRET_ID,
      mount: MOUNT,
      prefix: PREFIX,
    });

    const sidA = makeSid();
    const sidB = makeSid();

    await vault.put(sidA, "cia_token", "alpha-secret");
    await vault.put(sidB, "cia_token", "beta-secret");
    await vault.put(sidA, "books_key", "alpha-books");

    assertEq("login called exactly once for 3 puts", mock.stats.loginCalls, 1);
    assertEq("get sidA cia_token", await vault.get(sidA, "cia_token"), "alpha-secret");
    assertEq("get sidB cia_token", await vault.get(sidB, "cia_token"), "beta-secret");
    assertEq("session isolation: sidA has books_key", await vault.has(sidA, "books_key"), true);
    assertEq("session isolation: sidB does not have books_key", await vault.has(sidB, "books_key"), false);
    assertEq("get unknown key returns undefined (404)", await vault.get(sidA, "never_set"), undefined);

    // ---- 5: clear(sid) wipes only that sid's keys ----
    await vault.clear(sidA);
    assertEq("after clear(sidA) cia_token gone", await vault.get(sidA, "cia_token"), undefined);
    assertEq("after clear(sidA) books_key gone", await vault.get(sidA, "books_key"), undefined);
    assertEq("clear(sidA) left sidB intact", await vault.get(sidB, "cia_token"), "beta-secret");

    // ---- 7: resolveVaultRefs with the real backend ----
    const sidC = makeSid();
    await vault.put(sidC, "cia_token", "RESOLVED-VALUE");
    const out = await resolveVaultRefs(
      sidC,
      "Authorization: Bearer @vault:cia_token",
      vault,
    );
    assertEq(
      "resolveVaultRefs substitutes via real backend",
      out,
      "Authorization: Bearer RESOLVED-VALUE",
    );
  } finally {
    mock.close();
  }

  // ---- 6: token-expiry re-auth path ----
  const mock2 = await startMockVault({
    roleId: ROLE_ID,
    secretId: SECRET_ID,
    initialBadTokens: 1, // reject the first authed request once
  });
  try {
    const vault = new HashicorpVaultBackend({
      addr: mock2.url,
      roleId: ROLE_ID,
      secretId: SECRET_ID,
      mount: MOUNT,
      prefix: PREFIX,
    });
    const sid = makeSid();
    // First put: login → authed call rejected 401 → re-login → authed call succeeds.
    await vault.put(sid, "k1", "v1");
    assertEq("re-auth: login was called twice", mock2.stats.loginCalls, 2);
    assertEq("re-auth: value landed", await vault.get(sid, "k1"), "v1");
  } finally {
    mock2.close();
  }

  console.log("\nhashicorp-vault backend smoke passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
