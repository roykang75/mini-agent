// ADR-003 M1 smoke — pino log schema + secret leak check.
//
// Self-spawns in probe mode under NODE_ENV=production so pino writes raw JSON
// synchronously to stdout (no pretty transport). Captures the output, asserts
// every line has the required fields and that a known-secret value never
// appears anywhere in the output — including redacted paths.

import { spawnSync } from "node:child_process";

const SECRET = "hvs.SMOKETESTSECRET123456ABCDEF";

async function probe(): Promise<void> {
  const { createLogger } = await import("../src/lib/log");
  const log = createLogger("vault");
  log.info({ event: "resolve", sid: "sid_abc", ref: "@vault:cia_token" }, "resolved");
  log.warn({ event: "ref_missing", ref: "@vault:missing" }, "missing");
  // Defense-in-depth: secret under redacted path names. Must not appear raw.
  log.error(
    { event: "auth_fail", token: SECRET, password: SECRET, api_key: SECRET },
    "leak attempt under redacted keys",
  );
}

function fail(msg: string): never {
  console.error(`[FAIL] ${msg}`);
  process.exit(1);
}

interface LogLine {
  ts?: unknown;
  level?: unknown;
  component?: unknown;
  event?: unknown;
  [k: string]: unknown;
}

function runner(): void {
  const r = spawnSync("npx", ["tsx", __filename], {
    env: { ...process.env, LOG_PROBE: "1", NODE_ENV: "production", LOG_LEVEL: "trace" },
    encoding: "utf8",
  });
  if (r.status !== 0) fail(`probe exited ${r.status}\nstderr:\n${r.stderr}`);

  const stdout = r.stdout.trim();
  if (!stdout) fail("probe produced no stdout");

  const lines = stdout.split("\n").filter(Boolean);
  if (lines.length < 3) fail(`expected >= 3 log lines, got ${lines.length}\n${stdout}`);

  for (const line of lines) {
    let obj: LogLine;
    try {
      obj = JSON.parse(line);
    } catch {
      fail(`non-JSON line: ${line}`);
    }
    if (typeof obj.ts !== "string" || !/\d{4}-\d{2}-\d{2}T/.test(obj.ts)) {
      fail(`missing or invalid ts field: ${line}`);
    }
    if (typeof obj.level !== "string") fail(`missing level: ${line}`);
    if (obj.component !== "vault") fail(`wrong component (expected vault): ${line}`);
    if (typeof obj.event !== "string") fail(`missing event: ${line}`);
  }
  console.log(`[ok]   ${lines.length} log lines, all have {ts, level, component, event}`);

  if (stdout.includes(SECRET)) {
    fail(`secret leaked to stdout — found "${SECRET}" in:\n${stdout}`);
  }
  console.log(`[ok]   secret value never appears in stdout (redact works)`);

  // Positive control: redact markers should be present on the error line.
  const errLine = lines.find((l) => l.includes('"event":"auth_fail"'));
  if (!errLine) fail("auth_fail line not found");
  if (!errLine.includes("[REDACTED]")) {
    fail(`redact censor not applied — expected [REDACTED] in:\n${errLine}`);
  }
  console.log(`[ok]   redact censor applied for token/password/api_key`);

  // Expected log counts: info + warn + error = 3. Levels surfaced as strings.
  const levels = lines.map((l) => (JSON.parse(l) as LogLine).level);
  if (!levels.includes("info") || !levels.includes("warn") || !levels.includes("error")) {
    fail(`expected info/warn/error levels, got: ${levels.join(",")}`);
  }
  console.log(`[ok]   levels present: info, warn, error`);

  console.log("\nlog smoke passed.");
}

if (process.env.LOG_PROBE) {
  probe().catch((e) => {
    console.error(e);
    process.exit(1);
  });
} else {
  runner();
}
