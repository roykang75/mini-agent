// Streaming smoke — exercises AnthropicClient.chatStream against a mock SSE
// endpoint. Verifies that text_delta events are yielded progressively and the
// final `done` event carries an LLMResponse with concatenated text +
// accumulated usage (including cache fields).

import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";

import { AnthropicClient } from "../src/lib/llm/providers/anthropic";

function fail(msg: string): never {
  console.error(`[FAIL] ${msg}`);
  process.exit(1);
}

function sseLine(obj: unknown): string {
  return `event: ${(obj as { type: string }).type}\ndata: ${JSON.stringify(obj)}\n\n`;
}

async function main() {
  const server: Server = createServer((req, res) => {
    if (!req.url?.includes("/v1/messages")) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });
    res.write(sseLine({
      type: "message_start",
      message: {
        usage: {
          input_tokens: 25,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 100,
        },
      },
    }));
    res.write(sseLine({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }));
    for (const chunk of ["Hel", "lo,", " world", "!"]) {
      res.write(sseLine({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: chunk },
      }));
    }
    res.write(sseLine({ type: "content_block_stop", index: 0 }));
    res.write(sseLine({
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 4 },
    }));
    res.write(sseLine({ type: "message_stop" }));
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const client = new AnthropicClient({
    apiKey: "sk-test-stream",
    baseURL: `http://127.0.0.1:${port}/v1/messages`,
  });

  const deltas: string[] = [];
  let finalResponse: Awaited<ReturnType<typeof client.chat>> | undefined;

  for await (const ev of client.chatStream({
    model: "claude-sonnet-4-6",
    max_tokens: 128,
    messages: [{ role: "user", content: "hi" }],
  })) {
    if (ev.type === "text_delta") deltas.push(ev.text);
    else if (ev.type === "done") finalResponse = ev.response;
  }

  server.close();

  if (deltas.length !== 4) fail(`expected 4 text_delta events, got ${deltas.length}: ${JSON.stringify(deltas)}`);
  console.log(`[ok]   4 text_delta events received: ${JSON.stringify(deltas)}`);

  if (!finalResponse) fail("stream ended without done event");
  if (finalResponse.content.length !== 1) fail(`expected 1 content block, got ${finalResponse.content.length}`);
  const block = finalResponse.content[0];
  if (block.type !== "text" || block.text !== "Hello, world!") {
    fail(`accumulated text wrong: ${JSON.stringify(block)}`);
  }
  console.log(`[ok]   accumulated text = "${block.text}"`);

  if (finalResponse.stop_reason !== "end_turn") fail(`stop_reason wrong: ${finalResponse.stop_reason}`);
  if (finalResponse.usage.input_tokens !== 25) fail(`input_tokens wrong: ${finalResponse.usage.input_tokens}`);
  if (finalResponse.usage.output_tokens !== 4) fail(`output_tokens wrong: ${finalResponse.usage.output_tokens}`);
  if (finalResponse.usage.cache_read_input_tokens !== 100) {
    fail(`cache_read_input_tokens wrong: ${finalResponse.usage.cache_read_input_tokens}`);
  }
  console.log(
    `[ok]   usage — in=${finalResponse.usage.input_tokens} out=${finalResponse.usage.output_tokens} cache_read=${finalResponse.usage.cache_read_input_tokens}`,
  );

  console.log("\nllm-stream smoke passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
