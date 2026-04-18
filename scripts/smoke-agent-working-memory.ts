// ADR-005 smoke — working memory persists across user turns.
//
// 같은 sid 로 summonAgent 를 두 번 불러 두 user 메시지를 연속으로 receive.
// Mock Anthropic 엔드포인트가 **두 번째 요청의 messages 배열을 capture**
// 해서 runner 가 검증: 두 번째 request 의 messages 에 첫 user 메시지가
// 존재하는가 + assistant 의 첫 응답이 존재하는가 = agent 가 working
// memory 를 보존하고 있다는 증거.

import { spawnSync } from "node:child_process";
import { createServer, type Server, type IncomingMessage } from "node:http";
import { AddressInfo } from "node:net";

function fail(msg: string): never {
  console.error(`[FAIL] ${msg}`);
  process.exit(1);
}

function sseLine(obj: unknown): string {
  return `event: ${(obj as { type: string }).type}\ndata: ${JSON.stringify(obj)}\n\n`;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

interface ChatRequestBody {
  messages: { role: string; content: unknown }[];
}

function respondStream(res: import("node:http").ServerResponse, text: string, inputTokens: number) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  res.write(sseLine({
    type: "message_start",
    message: { usage: { input_tokens: inputTokens } },
  }));
  res.write(sseLine({
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  }));
  res.write(sseLine({
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text },
  }));
  res.write(sseLine({ type: "content_block_stop", index: 0 }));
  res.write(sseLine({
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { output_tokens: text.length },
  }));
  res.write(sseLine({ type: "message_stop" }));
  res.end();
}

async function probe(): Promise<void> {
  let turnCount = 0;
  const server: Server = createServer(async (req, res) => {
    if (!req.url?.includes("/v1/messages")) {
      res.writeHead(404);
      res.end();
      return;
    }
    turnCount++;
    const raw = await readBody(req);
    const body = JSON.parse(raw) as ChatRequestBody;
    // emit capture marker for runner
    process.stdout.write(
      JSON.stringify({ t: "turn", n: turnCount, messageCount: body.messages.length, messages: body.messages }) + "\n",
    );
    if (turnCount === 1) {
      respondStream(res, "첫 응답입니다.", 10);
    } else {
      respondStream(res, "두 번째 응답입니다.", 20);
    }
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;

  // Force AnthropicClient (used by agentLoop internally via createLLMClient)
  // to route to our mock. This must be set BEFORE importing instance/registry
  // so the env is read by createLLMClient on module init.
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}/v1/messages`;
  process.env.ANTHROPIC_API_KEY = "sk-test-working-memory";

  const { summonAgent, __clearAllAgents } = await import("../src/lib/agent/registry");
  __clearAllAgents();

  const sid = "wm-test-sid-0001";
  const agent = summonAgent(sid);

  // --- Turn 1 ---
  const events1: string[] = [];
  for await (const ev of agent.receive("첫 번째 질문 입니다. 기억해 주세요.", { persona: "default" })) {
    events1.push(ev.type);
  }
  if (!events1.includes("done")) fail(`turn 1 missing done event: ${events1.join(",")}`);

  const introspect1 = agent.introspect();
  if (introspect1.messageCount === 0) fail("turn 1: agent.messages empty after receive");
  // 1 user + 1 assistant = 2 messages minimum after turn 1
  if (introspect1.messageCount < 2) fail(`turn 1: expected >= 2 messages, got ${introspect1.messageCount}`);
  console.log(`[ok]   turn 1 done — agent.messageCount=${introspect1.messageCount}`);

  // --- Turn 2 ---
  const events2: string[] = [];
  for await (const ev of agent.receive("방금 제가 뭐라고 했는지 기억나세요?", { persona: "default" })) {
    events2.push(ev.type);
  }
  if (!events2.includes("done")) fail(`turn 2 missing done event: ${events2.join(",")}`);

  const introspect2 = agent.introspect();
  // Should have grown by another user + assistant
  if (introspect2.messageCount < introspect1.messageCount + 2) {
    fail(`turn 2: expected messageCount to grow by >=2, went ${introspect1.messageCount} → ${introspect2.messageCount}`);
  }
  console.log(`[ok]   turn 2 done — agent.messageCount=${introspect2.messageCount}`);

  server.close();
}

function runner(): void {
  const r = spawnSync("npx", ["tsx", __filename], {
    env: { ...process.env, WM_PROBE: "1", NODE_ENV: "production", LOG_LEVEL: "error" },
    encoding: "utf8",
  });
  if (r.status !== 0) fail(`probe exited ${r.status}\nstderr:\n${r.stderr}\nstdout:\n${r.stdout}`);

  const lines = r.stdout.trim().split("\n").filter(Boolean);
  interface TurnMarker {
    t: "turn";
    n: number;
    messageCount: number;
    messages: { role: string; content: unknown }[];
  }
  const turns: TurnMarker[] = [];
  const okLines: string[] = [];
  for (const raw of lines) {
    try {
      const obj = JSON.parse(raw) as unknown;
      if (typeof obj === "object" && obj !== null && (obj as { t?: string }).t === "turn") {
        turns.push(obj as TurnMarker);
        continue;
      }
    } catch {
      // probably [ok] line
    }
    if (raw.startsWith("[ok]")) okLines.push(raw);
  }

  if (turns.length !== 2) {
    fail(`expected 2 turn captures, got ${turns.length}\nstdout:\n${r.stdout}`);
  }

  // --- Turn 1 request ---
  // Should contain 1 user message.
  const t1 = turns[0];
  if (t1.messageCount !== 1) fail(`turn 1 request should have 1 message (user), got ${t1.messageCount}`);
  const t1user = t1.messages[0];
  if (t1user.role !== "user" || t1user.content !== "첫 번째 질문 입니다. 기억해 주세요.") {
    fail(`turn 1 first message wrong: ${JSON.stringify(t1user)}`);
  }
  console.log("[ok]   turn 1 LLM request had only 1 user message (expected, fresh agent)");

  // --- Turn 2 request ---
  // Should contain: 1 user (turn 1) + 1 assistant (turn 1 response) + 1 user (turn 2) = >=3
  const t2 = turns[1];
  if (t2.messageCount < 3) {
    fail(`turn 2 request should have >=3 messages (showing working memory), got ${t2.messageCount}\nmessages:\n${JSON.stringify(t2.messages, null, 2)}`);
  }
  const hasFirstUser = t2.messages.some(
    (m) => m.role === "user" && m.content === "첫 번째 질문 입니다. 기억해 주세요.",
  );
  const hasAssistantResponse = t2.messages.some((m) => m.role === "assistant");
  const hasSecondUser = t2.messages.some(
    (m) => m.role === "user" && m.content === "방금 제가 뭐라고 했는지 기억나세요?",
  );
  if (!hasFirstUser) fail("turn 2 request missing first user message — working memory NOT preserved");
  if (!hasAssistantResponse) fail("turn 2 request missing assistant response from turn 1");
  if (!hasSecondUser) fail("turn 2 request missing second user message");
  console.log("[ok]   turn 2 LLM request includes turn 1 user + turn 1 assistant + turn 2 user");
  console.log("[ok]   WORKING MEMORY CONFIRMED — agent remembers across user turns");

  // Echo probe's [ok] lines too
  for (const l of okLines) console.log(l);

  console.log("\nagent working-memory smoke passed.");
}

if (process.env.WM_PROBE) {
  probe().catch((e) => {
    console.error(e);
    process.exit(1);
  });
} else {
  runner();
}
