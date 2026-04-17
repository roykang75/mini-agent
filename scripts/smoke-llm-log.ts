// ADR-003 M1 — LLM chat structured logging + prompt caching smoke.
//
// Self-spawns in probe mode, spins up a mock Anthropic endpoint. The mock
// inspects each request body so we can assert our code sends `system` as a
// cache-controlled array. It also returns usage with cache_creation_input_tokens
// on the first call and cache_read_input_tokens on the second, letting us
// assert the logger surfaces both fields.

import { spawnSync } from "node:child_process";
import { createServer, type Server, type IncomingMessage } from "node:http";
import { AddressInfo } from "node:net";

interface LogLine {
  ts?: unknown;
  level?: unknown;
  component?: unknown;
  event?: unknown;
  model?: unknown;
  duration_ms?: unknown;
  tokens_in?: unknown;
  tokens_out?: unknown;
  cache_creation_tokens?: unknown;
  cache_read_tokens?: unknown;
  status?: unknown;
  [k: string]: unknown;
}

interface CaptureLine {
  t: "req_sys";
  system: unknown;
}

function fail(msg: string): never {
  console.error(`[FAIL] ${msg}`);
  process.exit(1);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function probe(): Promise<void> {
  let callCount = 0;
  const server: Server = createServer(async (req, res) => {
    callCount++;
    const raw = await readBody(req);
    const body = raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {};

    if (callCount === 1) {
      // stdout marker so the runner can inspect what our code actually sent.
      process.stdout.write(
        JSON.stringify({ t: "req_sys", system: body.system } satisfies CaptureLine) + "\n",
      );
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "msg_c1",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "hello" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: {
            input_tokens: 42,
            output_tokens: 7,
            cache_creation_input_tokens: 50,
            cache_read_input_tokens: 0,
          },
        }),
      );
      return;
    }
    if (callCount === 2) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "msg_c2",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "hi again" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: {
            input_tokens: 12,
            output_tokens: 5,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 50,
          },
        }),
      );
      return;
    }
    // Non-retryable so withRetry gives up immediately → one chat_error log.
    res.writeHead(400, { "content-type": "text/plain" });
    res.end("bad request");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  const { AnthropicClient } = await import("../src/lib/llm/providers/anthropic");
  const client = new AnthropicClient({
    apiKey: "sk-test-smoke",
    baseURL: `http://127.0.0.1:${port}/v1/messages`,
  });

  const SYS = "You are a cached-system test. This block should be cacheable.";
  const SYSTEM_ARR = [{ type: "text" as const, text: SYS, cache_control: { type: "ephemeral" as const } }];

  await client.chat({
    model: "claude-sonnet-4-6",
    max_tokens: 128,
    system: SYSTEM_ARR,
    messages: [{ role: "user", content: "hi" }],
  });

  await client.chat({
    model: "claude-sonnet-4-6",
    max_tokens: 128,
    system: SYSTEM_ARR,
    messages: [{ role: "user", content: "hi once more" }],
  });

  try {
    await client.chat({
      model: "claude-sonnet-4-6",
      max_tokens: 128,
      messages: [{ role: "user", content: "trigger 400" }],
    });
    fail("expected 400 to throw LLMError");
  } catch (e) {
    if ((e as Error).name !== "LLMError") {
      fail(`expected LLMError, got ${(e as Error).name}: ${(e as Error).message}`);
    }
  }

  server.close();
}

function runner(): void {
  const r = spawnSync("npx", ["tsx", __filename], {
    env: { ...process.env, LLM_LOG_PROBE: "1", NODE_ENV: "production", LOG_LEVEL: "trace" },
    encoding: "utf8",
  });
  if (r.status !== 0) fail(`probe exited ${r.status}\nstderr:\n${r.stderr}\nstdout:\n${r.stdout}`);

  const lines = r.stdout.trim().split("\n").filter(Boolean);
  const llmLines: LogLine[] = [];
  let capturedSystem: unknown;
  for (const raw of lines) {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (obj.t === "req_sys") {
      capturedSystem = obj.system;
      continue;
    }
    if (obj.component === "llm") llmLines.push(obj as LogLine);
  }
  if (llmLines.length !== 3) {
    fail(`expected 3 llm.* log lines, got ${llmLines.length}\nfull stdout:\n${r.stdout}`);
  }

  // Request-side: system sent as array with cache_control on the last block.
  if (!Array.isArray(capturedSystem) || capturedSystem.length === 0) {
    fail(`system should have been sent as non-empty array, got: ${JSON.stringify(capturedSystem)}`);
  }
  const last = capturedSystem[capturedSystem.length - 1] as { cache_control?: { type?: string } };
  if (last?.cache_control?.type !== "ephemeral") {
    fail(`last system block missing cache_control:{type:ephemeral} — got: ${JSON.stringify(last)}`);
  }
  console.log("[ok]   request system sent as array with cache_control:ephemeral on last block");

  // Response-side: the two successful chat events should surface cache fields.
  const successLines = llmLines.filter((l) => l.event === "chat");
  if (successLines.length !== 2) fail(`expected 2 event:chat lines, got ${successLines.length}`);
  const first = successLines[0];
  const second = successLines[1];
  if (first.cache_creation_tokens !== 50) {
    fail(`first call cache_creation_tokens expected 50, got ${first.cache_creation_tokens}`);
  }
  if (first.cache_read_tokens !== 0) {
    fail(`first call cache_read_tokens expected 0, got ${first.cache_read_tokens}`);
  }
  console.log(`[ok]   call 1 — cache_creation=${first.cache_creation_tokens} cache_read=${first.cache_read_tokens}`);
  if (second.cache_creation_tokens !== 0) {
    fail(`second call cache_creation_tokens expected 0, got ${second.cache_creation_tokens}`);
  }
  if (second.cache_read_tokens !== 50) {
    fail(`second call cache_read_tokens expected 50, got ${second.cache_read_tokens}`);
  }
  console.log(`[ok]   call 2 — cache_creation=${second.cache_creation_tokens} cache_read=${second.cache_read_tokens}`);

  // Baseline token/duration fields still intact.
  for (const l of successLines) {
    if (typeof l.tokens_in !== "number" || typeof l.tokens_out !== "number") {
      fail(`tokens_in/out invalid: ${JSON.stringify(l)}`);
    }
    if (typeof l.duration_ms !== "number" || (l.duration_ms as number) < 0) {
      fail(`duration_ms invalid: ${l.duration_ms}`);
    }
    if (l.stop_reason !== "end_turn") fail(`stop_reason wrong: ${l.stop_reason}`);
    if (l.level !== "info") fail(`success level expected info, got ${l.level}`);
  }

  const err = llmLines.find((l) => l.event === "chat_error");
  if (!err) fail("missing event:chat_error log");
  if (err.status !== 400) fail(`chat_error status wrong: ${err.status}`);
  if (err.level !== "warn") fail(`error level expected warn, got ${err.level}`);
  console.log(`[ok]   event:chat_error — status=${err.status}, duration_ms=${err.duration_ms}, level=warn`);

  // No api key / message content / system text ever appears in logs.
  if (r.stdout.includes("sk-test-smoke")) fail("api key leaked to logs");
  if (r.stdout.includes('"hi"') || r.stdout.includes('"trigger 400"')) {
    fail("user message content leaked to logs");
  }
  console.log("[ok]   no api key / message content in log stream");

  console.log("\nllm-log smoke passed.");
}

if (process.env.LLM_LOG_PROBE) {
  probe().catch((e) => {
    console.error(e);
    process.exit(1);
  });
} else {
  runner();
}
