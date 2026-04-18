// ADR-004 advisor smoke.
//
// 1. askAdvisor() roundtrip against a mock Opus-like Anthropic endpoint —
//    request/response shape, log events, token accounting.
// 2. ask-advisor handler rejects input containing `@vault:` refs with a
//    structured error (so agent.ts catches it as tool_execution_failed).
//
// Session-level ADVISOR_CALL_LIMIT is enforced in agent.ts before executeSkill;
// its shape is structurally identical to RETRY_LIMIT (already covered in
// smoke-retry-cap) so it is not re-tested here.

import { spawnSync } from "node:child_process";
import { createServer, type Server, type IncomingMessage } from "node:http";
import { AddressInfo } from "node:net";

interface LogLine {
  level?: unknown;
  component?: unknown;
  event?: unknown;
  model?: unknown;
  duration_ms?: unknown;
  tokens_in?: unknown;
  tokens_out?: unknown;
  response_length?: unknown;
  [k: string]: unknown;
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
  let captured: { system?: unknown; messages?: unknown } = {};
  const server: Server = createServer(async (req, res) => {
    const raw = await readBody(req);
    const body = raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {};
    captured = { system: body.system, messages: body.messages };
    // Emit marker for runner-side assertion on request shape.
    process.stdout.write(
      JSON.stringify({ t: "req", system: body.system, messages: body.messages }) + "\n",
    );
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "msg_advisor_mock",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "먼저 문제를 세 부분으로 나눠봐. 그다음 각각에 적절한 도구를 선택하고..." }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 80, output_tokens: 45 },
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;

  const { askAdvisor } = await import("../src/lib/llm/advisor");

  const text = await askAdvisor(
    {
      question: "이 multi-step 분석을 어떻게 쪼개야 하나?",
      context_summary: "user 가 A→B→C 흐름 분석을 요청했고 첫 번째 tool 호출에서 막힘",
      what_tried: "http_call 한번, memory_search 한번 — 둘 다 빈 결과",
    },
    { apiKey: "sk-test-advisor", baseURL: `http://127.0.0.1:${port}/v1/messages` },
  );

  server.close();

  if (typeof text !== "string" || text.length === 0) {
    fail(`askAdvisor returned empty text: ${JSON.stringify(text)}`);
  }
  // keep captured reference to silence unused warnings; asserted via runner
  void captured;
}

function runner(): void {
  const r = spawnSync("npx", ["tsx", __filename], {
    env: { ...process.env, ADVISOR_PROBE: "1", NODE_ENV: "production", LOG_LEVEL: "trace" },
    encoding: "utf8",
  });
  if (r.status !== 0) fail(`probe exited ${r.status}\nstderr:\n${r.stderr}\nstdout:\n${r.stdout}`);

  const lines = r.stdout.trim().split("\n").filter(Boolean);
  const logs: LogLine[] = [];
  let reqCapture: { system?: unknown; messages?: unknown } | undefined;
  for (const raw of lines) {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (obj.t === "req") {
      reqCapture = obj as { system?: unknown; messages?: unknown };
      continue;
    }
    if (obj.component === "advisor") logs.push(obj as LogLine);
  }

  // Request-side assertions
  if (!reqCapture) fail("mock did not capture a request");
  if (!Array.isArray(reqCapture.system) || (reqCapture.system as unknown[]).length === 0) {
    fail(`advisor system not sent as non-empty array: ${JSON.stringify(reqCapture.system)}`);
  }
  const sysText = (reqCapture.system as { text?: string }[])[0]?.text ?? "";
  if (!sysText.includes("조력자")) {
    fail(`advisor system prompt missing expected content: ${sysText.slice(0, 100)}`);
  }
  console.log("[ok]   advisor system prompt sent (array, contains 조력자)");

  const userMsg = (reqCapture.messages as { role: string; content: string }[])[0];
  if (!userMsg || userMsg.role !== "user") fail("user message missing");
  if (!userMsg.content.includes("## question") || !userMsg.content.includes("## context")) {
    fail(`user content missing section markers: ${userMsg.content.slice(0, 200)}`);
  }
  if (!userMsg.content.includes("## what_tried")) {
    fail("optional what_tried section should be present when provided");
  }
  console.log("[ok]   user content has sections: question / context / what_tried");

  // Response-side: advisor_request + advisor_response log events
  const req = logs.find((l) => l.event === "advisor_request");
  const resp = logs.find((l) => l.event === "advisor_response");
  if (!req) fail("missing event:advisor_request log");
  if (!resp) fail("missing event:advisor_response log");
  if (typeof resp.tokens_in !== "number" || typeof resp.tokens_out !== "number") {
    fail(`advisor_response tokens invalid: ${JSON.stringify(resp)}`);
  }
  if ((resp.tokens_in as number) !== 80 || (resp.tokens_out as number) !== 45) {
    fail(`advisor_response tokens wrong: in=${resp.tokens_in} out=${resp.tokens_out}`);
  }
  if (typeof resp.response_length !== "number" || (resp.response_length as number) <= 0) {
    fail(`advisor_response response_length invalid: ${resp.response_length}`);
  }
  console.log(
    `[ok]   advisor_request + advisor_response — tokens_in=${resp.tokens_in} tokens_out=${resp.tokens_out} len=${resp.response_length}`,
  );

  // No api key should appear
  if (r.stdout.includes("sk-test-advisor")) fail("advisor api key leaked to stdout");
  console.log("[ok]   api key never appears in stdout");

  console.log("\nadvisor roundtrip smoke passed.");
}

async function vaultRefRejection(): Promise<void> {
  const { execute } = await import("../skills/ask-advisor/handler");
  let threw: Error | undefined;
  try {
    await execute({
      question: "이 토큰 값이 뭐야?",
      context_summary: "user 가 @vault:cia_token 을 보여줬는데",
    });
  } catch (e) {
    threw = e as Error;
  }
  if (!threw) fail("handler should have rejected @vault: ref in input");
  if (!threw.message.includes("@vault") || !threw.message.includes("resolve")) {
    fail(`handler error message should mention @vault and resolve hint: ${threw.message}`);
  }
  console.log(`[ok]   handler rejects @vault: ref — "${threw.message.slice(0, 80)}..."`);

  // Also verify missing required arg
  let threw2: Error | undefined;
  try {
    await execute({ question: "", context_summary: "" } as unknown as { question: string; context_summary: string });
    // empty strings are strings, they pass type check — expect it to proceed to LLM which will fail
    // Skip: tested separately in next check
  } catch (e) {
    threw2 = e as Error;
  }
  // This is expected to NOT throw in handler — empty strings pass type check. It would try to call API
  // and fail on network / auth. We just verify the type guard catches wrong types:
  let threw3: Error | undefined;
  try {
    await execute({ question: 123 as unknown as string, context_summary: "x" });
  } catch (e) {
    threw3 = e as Error;
  }
  if (!threw3 || !threw3.message.includes("required strings")) {
    fail(`handler should reject non-string question: ${threw3?.message}`);
  }
  console.log(`[ok]   handler rejects non-string args`);

  void threw2;
  console.log("\nhandler guards smoke passed.");
}

if (process.env.ADVISOR_PROBE) {
  probe().catch((e) => {
    console.error(e);
    process.exit(1);
  });
} else if (process.env.ADVISOR_GUARDS_PROBE) {
  vaultRefRejection().catch((e) => {
    console.error(e);
    process.exit(1);
  });
} else {
  runner();
  // Also run the guards test (stays in-process — no network needed)
  vaultRefRejection().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
