/**
 * 15차 recall ablation v2 — 18 run 통합 runner.
 *
 * 6 condition (allon / nomem / nocur / noself / norec / alloff) × idx (01/02/03)
 * 을 condition 별 dev server 재시작 + Redis 자동 클리어로 깨끗하게 측정.
 *
 * 사용:
 *   npx tsx scripts/agent-school/run-recall-ablation.ts
 *
 * env:
 *   ANTHROPIC_API_KEY (required, .env.local 에서 자동 load)
 *   AGENT_MEMORY_DIR / CURRICULUM_DIR (required)
 *   REDIS_URL (optional, default redis://192.168.1.218:6379)
 *   GOAL_MAX_TOKENS (default 8192)
 */

import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import Redis from "ioredis";

interface Condition {
  name: string;
  env: Record<string, string>;
}

interface RunResult {
  cond: string;
  idx: string;
  slug: string;
  status: string;
  iterations: number;
  tokens_used: number;
  usd_spent: number;
  reason?: string;
}

const CONDITIONS: Condition[] = [
  { name: "allon",  env: {} },
  { name: "nomem",  env: { MEMORY_RECALL_MEMORY: "off" } },
  { name: "nocur",  env: { MEMORY_RECALL_CURRICULUM: "off" } },
  { name: "noself", env: { MEMORY_RECALL_SELF_MAP: "off" } },
  { name: "norec",  env: { MEMORY_RECALL_RECENT_SESSIONS: "off" } },
  { name: "alloff", env: { MEMORY_RECALL: "off" } },
];

const IDXS = ["01", "02", "03"] as const;

const REDIS_URL = process.env.REDIS_URL ?? "redis://192.168.1.218:6379";
const REDIS_KEY_PATTERN = "agent:state:goal-2026-04-30-scan-*";

const DEV_SERVER_PORT = 3000;
const POLL_INTERVAL_MS = 30_000;
const MAX_WALL_TIME_MS = 30 * 60_000;

async function clearRedis(): Promise<void> {
  const r = new Redis(REDIS_URL);
  try {
    const keys = await r.keys(REDIS_KEY_PATTERN);
    if (keys.length > 0) await r.del(...keys);
    console.log(`[redis] cleared ${keys.length} keys`);
  } finally {
    await r.quit();
  }
}

function startDevServer(extraEnv: Record<string, string>): ChildProcess {
  const env = {
    ...process.env,
    GOAL_MAX_TOKENS: process.env.GOAL_MAX_TOKENS ?? "8192",
    ...extraEnv,
  };
  const proc = spawn("pnpm", ["dev"], {
    cwd: "/Users/roy/Workspace/agent/mini-agent",
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });
  proc.stdout?.on("data", (b) => process.stdout.write(`[dev] ${b}`));
  proc.stderr?.on("data", (b) => process.stderr.write(`[dev-err] ${b}`));
  return proc;
}

async function waitForReady(timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://localhost:${DEV_SERVER_PORT}/`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("dev server did not become ready");
}

async function killServer(proc: ChildProcess): Promise<void> {
  proc.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 2000));
  if (!proc.killed) proc.kill("SIGKILL");
}

async function postRun(slug: string): Promise<void> {
  const res = await fetch(`http://localhost:${DEV_SERVER_PORT}/api/goals/${slug}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (!res.ok && res.status !== 202) {
    const body = await res.text();
    throw new Error(`POST /run failed: ${res.status} ${body}`);
  }
}

async function getGoal(slug: string): Promise<any> {
  const res = await fetch(`http://localhost:${DEV_SERVER_PORT}/api/goals/${slug}`);
  if (!res.ok) throw new Error(`GET goal failed: ${res.status}`);
  return await res.json();
}

const TERMINAL = new Set(["completed", "paused", "error", "budget-breached", "failed", "aborted"]);

async function pollUntilTerminal(slug: string): Promise<RunResult> {
  const start = Date.now();
  while (Date.now() - start < MAX_WALL_TIME_MS) {
    const g = await getGoal(slug);
    const fm = g.frontmatter ?? {};
    const status = fm.status as string;
    if (TERMINAL.has(status)) {
      return {
        cond: "",
        idx: "",
        slug,
        status,
        iterations: fm.progress?.iterations ?? 0,
        tokens_used: fm.progress?.tokens_used ?? 0,
        usd_spent: fm.progress?.usd_spent ?? 0,
      };
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`poll timeout for ${slug}`);
}

async function runCondition(cond: Condition): Promise<RunResult[]> {
  console.log(`\n=== condition: ${cond.name} ===`);
  await clearRedis();
  const proc = startDevServer(cond.env);
  try {
    await waitForReady();
    const results: RunResult[] = [];
    for (const idx of IDXS) {
      const slug = `scan-${cond.name}-${idx}`;
      console.log(`[${cond.name}/${idx}] starting...`);
      try {
        await postRun(slug);
      } catch (e) {
        console.error(`[${cond.name}/${idx}] postRun err: ${(e as Error).message}`);
        results.push({
          cond: cond.name, idx, slug,
          status: "error_in_runner",
          iterations: 0, tokens_used: 0, usd_spent: 0,
          reason: (e as Error).message,
        });
        continue;
      }
      const out = await pollUntilTerminal(slug);
      out.cond = cond.name;
      out.idx = idx;
      results.push(out);
      console.log(`[${cond.name}/${idx}] -> ${out.status} iter=${out.iterations} usd=${out.usd_spent.toFixed(3)}`);
    }
    return results;
  } finally {
    await killServer(proc);
  }
}

async function main() {
  const allResults: RunResult[] = [];
  for (const cond of CONDITIONS) {
    const r = await runCondition(cond);
    allResults.push(...r);
  }

  const ts = Date.now();
  const dir = "/Users/roy/Workspace/agent/agent-curriculum/runs-recall-ablation/2026-05-01";
  mkdirSync(dir, { recursive: true });
  const out = {
    spec: "2026-05-01-recall-ablation-v2",
    timestamp: ts,
    runs: allResults,
    aggregate: aggregate(allResults),
  };
  const path = join(dir, `raw-${ts}.json`);
  writeFileSync(path, JSON.stringify(out, null, 2));
  console.log(`\nsaved: ${path}`);
  console.log("aggregate:");
  console.log(JSON.stringify(out.aggregate, null, 2));
}

function aggregate(results: RunResult[]) {
  const byCond: Record<string, any> = {};
  for (const cond of CONDITIONS) {
    const rs = results.filter((r) => r.cond === cond.name);
    const completed = rs.filter((r) => r.status === "completed");
    byCond[cond.name] = {
      runs: rs.length,
      completed: completed.length,
      one_iter_completion: rs.filter((r) => r.status === "completed" && r.iterations === 1).length,
      avg_iter: rs.reduce((s, r) => s + r.iterations, 0) / Math.max(1, rs.length),
      avg_tokens: rs.reduce((s, r) => s + r.tokens_used, 0) / Math.max(1, rs.length),
      avg_usd: rs.reduce((s, r) => s + r.usd_spent, 0) / Math.max(1, rs.length),
    };
  }
  return byCond;
}

main().catch((e) => { console.error(e); process.exit(1); });
