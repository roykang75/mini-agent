/**
 * Smoke: OpenAICompatClient 의 reasoning_content 수집.
 *
 * 세 시나리오:
 *   (A) non-stream + reasoning_content + completion_tokens_details.reasoning_tokens
 *   (B) stream + delta.reasoning_content → reasoning_delta 이벤트 yield,
 *       최종 response.reasoning 누적 일치
 *   (C) 서버가 reasoning 필드 미제공 (기존 provider) — response.reasoning 는
 *       undefined, 기존 code path 영향 없음 (backwards-compatible)
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";

import { OpenAICompatClient } from "../src/lib/llm/providers/openai-compat";

function fail(msg: string): never {
  console.error(`[FAIL] ${msg}`);
  process.exit(1);
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) fail(msg);
}

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

function startServer(handler: Handler): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => handler(req, res, Buffer.concat(chunks).toString("utf-8")));
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function baseURL(server: Server): string {
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function scenarioA_nonStreamReasoning(): Promise<void> {
  const server = await startServer((_req, res, _body) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "chatcmpl-test-A",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "2",
              reasoning_content: "1+1 을 계산한다. 결과는 2.",
              tool_calls: [],
            },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 18,
          completion_tokens_details: { reasoning_tokens: 15 },
        },
      }),
    );
  });

  try {
    const client = new OpenAICompatClient({ baseURL: baseURL(server) });
    const r = await client.chat({
      model: "qwen3.6-27b-mlx",
      max_tokens: 100,
      messages: [{ role: "user", content: "1+1=?" }],
    });

    assert(r.reasoning === "1+1 을 계산한다. 결과는 2.", `A: reasoning mismatch, got ${JSON.stringify(r.reasoning)}`);
    assert(r.usage.reasoning_tokens === 15, `A: reasoning_tokens 15 expected, got ${r.usage.reasoning_tokens}`);
    assert(r.usage.input_tokens === 10, `A: input_tokens`);
    assert(r.usage.output_tokens === 18, `A: output_tokens`);
    assert(
      r.content.length === 1 && r.content[0].type === "text" && r.content[0].text === "2",
      `A: visible content mismatch`,
    );
  } finally {
    server.close();
  }
}

async function scenarioB_streamReasoning(): Promise<void> {
  const server = await startServer((_req, res, _body) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunks: Array<Record<string, unknown>> = [
      { choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "생" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { reasoning_content: "각 " }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { reasoning_content: "중..." }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { content: "답: " }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { content: "2" }, finish_reason: null }] },
      {
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 7,
          completion_tokens_details: { reasoning_tokens: 5 },
        },
      },
    ];
    for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  });

  try {
    const client = new OpenAICompatClient({ baseURL: baseURL(server) });
    const reasoningDeltas: string[] = [];
    const textDeltas: string[] = [];
    let done: { type: "done"; response: Awaited<ReturnType<typeof client.chat>> } | undefined;

    for await (const ev of client.chatStream({
      model: "qwen3.6-27b-mlx",
      max_tokens: 50,
      messages: [{ role: "user", content: "1+1=?" }],
    })) {
      if (ev.type === "reasoning_delta") reasoningDeltas.push(ev.text);
      else if (ev.type === "text_delta") textDeltas.push(ev.text);
      else if (ev.type === "done") done = ev as typeof done;
    }

    assert(done, "B: no done event");
    assert(
      reasoningDeltas.join("") === "생각 중...",
      `B: reasoning delta accumulation ${JSON.stringify(reasoningDeltas)}`,
    );
    assert(textDeltas.join("") === "답: 2", `B: text delta accumulation ${JSON.stringify(textDeltas)}`);
    assert(done!.response.reasoning === "생각 중...", `B: response.reasoning ${JSON.stringify(done!.response.reasoning)}`);
    assert(done!.response.usage.reasoning_tokens === 5, `B: usage.reasoning_tokens ${done!.response.usage.reasoning_tokens}`);
    assert(
      done!.response.content.length === 1 &&
        done!.response.content[0].type === "text" &&
        (done!.response.content[0] as { text: string }).text === "답: 2",
      `B: content mismatch`,
    );
  } finally {
    server.close();
  }
}

async function scenarioC_backwardsCompat(): Promise<void> {
  const server = await startServer((_req, res, _body) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "chatcmpl-test-C",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "2", tool_calls: [] },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 1 },
      }),
    );
  });

  try {
    const client = new OpenAICompatClient({ baseURL: baseURL(server) });
    const r = await client.chat({
      model: "gpt-4o-mini",
      max_tokens: 20,
      messages: [{ role: "user", content: "1+1=?" }],
    });
    assert(r.reasoning === undefined, `C: reasoning should be undefined, got ${JSON.stringify(r.reasoning)}`);
    assert(r.usage.reasoning_tokens === undefined, `C: reasoning_tokens should be undefined`);
    assert(
      r.content.length === 1 && r.content[0].type === "text",
      `C: content path broken for non-thinking providers`,
    );
  } finally {
    server.close();
  }
}

async function main(): Promise<void> {
  await scenarioA_nonStreamReasoning();
  await scenarioB_streamReasoning();
  await scenarioC_backwardsCompat();
  console.log("[OK] smoke-reasoning-capture — 13 assertions passed");
}

main().then(() => process.exit(0));
