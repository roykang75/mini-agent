// ADR-003 M1 — LLM chat structured logging smoke.
//
// Spins up a tiny mock Anthropic endpoint, points AnthropicClient at it, runs
// two chat calls (success + non-retryable error), captures log stdout via
// self-spawn, and asserts the llm.chat / llm.chat_error events carry
// { model, duration_ms, tokens_in/out, status } as expected.

import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
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
  status?: unknown;
  [k: string]: unknown;
}

function fail(msg: string): never {
  console.error(`[FAIL] ${msg}`);
  process.exit(1);
}

async function probe(): Promise<void> {
  let callCount = 0;
  const server: Server = createServer((req, res) => {
    callCount++;
    if (callCount === 1) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "msg_smoke",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "hello" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 42, output_tokens: 7 },
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

  await client.chat({
    model: "claude-sonnet-4-6",
    max_tokens: 128,
    messages: [{ role: "user", content: "hi" }],
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
  for (const raw of lines) {
    let obj: LogLine;
    try {
      obj = JSON.parse(raw);
    } catch {
      continue;
    }
    if (obj.component === "llm") llmLines.push(obj);
  }
  if (llmLines.length !== 2) {
    fail(`expected 2 llm.* log lines, got ${llmLines.length}\nfull stdout:\n${r.stdout}`);
  }

  const ok = llmLines.find((l) => l.event === "chat");
  if (!ok) fail("missing event:chat success log");
  if (ok.model !== "claude-sonnet-4-6") fail(`chat model wrong: ${ok.model}`);
  if (ok.tokens_in !== 42 || ok.tokens_out !== 7) {
    fail(`tokens wrong: in=${ok.tokens_in} out=${ok.tokens_out}`);
  }
  if (typeof ok.duration_ms !== "number" || (ok.duration_ms as number) < 0) {
    fail(`duration_ms invalid: ${ok.duration_ms}`);
  }
  if (ok.stop_reason !== "end_turn") fail(`stop_reason wrong: ${ok.stop_reason}`);
  if (ok.level !== "info") fail(`success level expected info, got ${ok.level}`);
  console.log(`[ok]   event:chat — model, tokens_in=${ok.tokens_in}, tokens_out=${ok.tokens_out}, duration_ms=${ok.duration_ms}, stop_reason`);

  const err = llmLines.find((l) => l.event === "chat_error");
  if (!err) fail("missing event:chat_error log");
  if (err.status !== 400) fail(`chat_error status wrong: ${err.status}`);
  if (typeof err.duration_ms !== "number") fail(`chat_error duration_ms invalid: ${err.duration_ms}`);
  if (err.level !== "warn") fail(`error level expected warn, got ${err.level}`);
  console.log(`[ok]   event:chat_error — status=${err.status}, duration_ms=${err.duration_ms}, level=warn`);

  // No request body / system prompt / api key ever appears in logs.
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
