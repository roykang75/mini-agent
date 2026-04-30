import { spawn, type ChildProcess } from "node:child_process";

const HOST = process.env.RELEASE_CHECK_HOST ?? "127.0.0.1";
const PORT = process.env.RELEASE_CHECK_PORT ?? "3100";
const BASE_URL = process.env.MINI_AGENT_URL ?? `http://${HOST}:${PORT}`;
const PROFILE_NAME = process.env.PROFILE_NAME ?? "gemma-4-26b-a4b-it-mlx";
const READY_TIMEOUT_MS = Number(process.env.RELEASE_CHECK_READY_TIMEOUT_MS ?? "90000");

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHttpReady(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "unreachable";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(3000) });
      if (res.ok) return;
      lastError = `HTTP ${res.status}`;
    } catch (e) {
      lastError = (e as Error).message;
    }
    await sleep(1000);
  }
  throw new Error(`mini-agent dev server not ready at ${url}: ${lastError}`);
}

function spawnChecked(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  label: string,
  options?: { detached?: boolean; quiet?: boolean },
): ChildProcess {
  const child = spawn(cmd, args, {
    cwd: process.cwd(),
    env,
    stdio: options?.quiet ? ["ignore", "pipe", "pipe"] : "inherit",
    detached: options?.detached ?? false,
  });
  child.on("error", (err) => {
    console.error(`[${label}] spawn failed: ${err.message}`);
  });
  return child;
}

async function runCommand(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  label: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawnChecked(cmd, args, env, label);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`[${label}] exited with code=${code ?? "null"} signal=${signal ?? "null"}`));
    });
  });
}

async function startDevServer(): Promise<ChildProcess> {
  const env = {
    ...process.env,
    VERIFIER_HOOK: "on",
    VERIFIER_HOOK_AGENT_TURN: "on",
  };
  const child = spawnChecked(
    "npm",
    ["run", "dev", "--", "--hostname", HOST, "--port", PORT],
    env,
    "dev-server",
  );
  await waitForHttpReady(BASE_URL, READY_TIMEOUT_MS);
  console.log(JSON.stringify({ case: "dev server ready", ok: true, baseUrl: BASE_URL, profile: PROFILE_NAME }));
  return child;
}

async function stopDevServer(child: ChildProcess | null): Promise<void> {
  if (!child || child.killed) return;
  child.kill("SIGINT");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 5000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function main() {
  let server: ChildProcess | null = null;
  try {
    server = await startDevServer();

    await runCommand("npm", ["run", "test:llm-profiles"], process.env, "test:llm-profiles");
    await runCommand("npm", ["run", "test:openai-compat-stream"], process.env, "test:openai-compat-stream");
    await runCommand(
      "node",
      ["--experimental-strip-types", "scripts/agent-school/e2e-verifier-hook-cascade.ts"],
      {
        ...process.env,
        MINI_AGENT_URL: BASE_URL,
        PROFILE_NAME,
      },
      "e2e-verifier-hook-cascade",
    );

    console.log(JSON.stringify({ ok: true, baseUrl: BASE_URL, profile: PROFILE_NAME }));
  } finally {
    await stopDevServer(server);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
