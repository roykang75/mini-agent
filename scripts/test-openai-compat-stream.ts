import http from "node:http";
import { OpenAICompatClient } from "../src/lib/llm/providers/openai-compat";
import { LLMError } from "../src/lib/llm/types";

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("failed to resolve ephemeral port");
  }
  return addr.port;
}

async function collectStream(client: OpenAICompatClient, model: string) {
  const events: string[] = [];
  let doneText = "";
  let usage = { input_tokens: 0, output_tokens: 0 };

  for await (const ev of client.chatStream({
    model,
    max_tokens: 32,
    messages: [{ role: "user", content: "hello" }],
  })) {
    if (ev.type === "text_delta") events.push(ev.text);
    if (ev.type === "done") {
      doneText = ev.response.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");
      usage = ev.response.usage;
    }
  }

  return { text: events.join(""), doneText, usage };
}

async function main() {
  let hits = 0;
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404).end();
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model?: string };
    hits += 1;

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    if (body.model === "empty-stream-model") {
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    res.write(
      'data: {"choices":[{"index":0,"delta":{"content":"안녕"},"finish_reason":null}]}\n\n',
    );
    res.write(
      'data: {"choices":[{"index":0,"delta":{"content":"하세요"},"finish_reason":null}]}\n\n',
    );
    res.write(
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n',
    );
    res.write("data: [DONE]\n\n");
    res.end();
  });

  const port = await listen(server);
  const client = new OpenAICompatClient({ apiKey: "test", baseURL: `http://127.0.0.1:${port}` });

  try {
    const ok = await collectStream(client, "ok-stream-model");
    const okPassed =
      ok.text === "안녕하세요" &&
      ok.doneText === "안녕하세요" &&
      ok.usage.input_tokens === 5 &&
      ok.usage.output_tokens === 2;
    console.log(
      JSON.stringify({
        case: "stream success",
        ok: okPassed,
        text: ok.text,
        doneText: ok.doneText,
        usage: ok.usage,
      }),
    );
    if (!okPassed) process.exitCode = 1;

    let emptyPassed = false;
    try {
      await collectStream(client, "empty-stream-model");
    } catch (e) {
      emptyPassed =
        e instanceof LLMError &&
        e.status === 502 &&
        e.body.includes("empty streamed response from openai-compat upstream");
      console.log(
        JSON.stringify({
          case: "empty stream guard",
          ok: emptyPassed,
          status: e instanceof LLMError ? e.status : null,
          message: String(e),
        }),
      );
    }

    if (!emptyPassed) {
      console.log(
        JSON.stringify({
          case: "empty stream guard",
          ok: false,
          message: "expected LLMError(502) for empty stream",
        }),
      );
      process.exitCode = 1;
    }
  } finally {
    server.close();
  }

  console.log(JSON.stringify({ ok: process.exitCode !== 1, hits }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
