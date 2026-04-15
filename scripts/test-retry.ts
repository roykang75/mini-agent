import http from "node:http";
import { AnthropicClient } from "../src/lib/llm/providers/anthropic";

async function main() {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    if (hits < 3) {
      res.writeHead(529, { "content-type": "application/json", "retry-after": "0" });
      res.end(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "overloaded" } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "msg_mock",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "ok from mock" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const baseURL = `http://127.0.0.1:${port}/v1/messages`;

  const client = new AnthropicClient({ apiKey: "test", baseURL });

  try {
    const started = Date.now();
    const resp = await client.chat({
      model: "claude-sonnet-4-5",
      max_tokens: 10,
      messages: [{ role: "user", content: "hi" }],
    });
    const elapsed = Date.now() - started;
    console.log(JSON.stringify({ ok: true, hits, elapsedMs: elapsed, content: resp.content }));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, hits, error: String(e) }));
    process.exitCode = 1;
  } finally {
    server.close();
  }
}

main();