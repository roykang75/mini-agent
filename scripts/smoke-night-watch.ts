// Night's Watch Phase 2 — observer client smoke.
//
// Spins up a fake ingest server on 127.0.0.1, points NightWatchClient at it,
// and verifies:
//   1. NW_ENABLED=off → no fetch happens (queue stays empty after push)
//   2. Batch flush after push >= BATCH_MAX → POST /api/ingest with full envelope
//   3. Batch flush via timer (FLUSH_INTERVAL_MS) → POST after smaller queue
//   4. agent-event-mapper round-trip — chosen AgentEvent kinds map correctly
//   5. withNightWatchTrace generator wrapper emits trace_start + events +
//      trace_end with status inferred from terminal event
//   6. recordLlmRequest / recordLlmResponse / recordLlmError sequence

import { createServer, type Server, type IncomingMessage } from "node:http";
import { AddressInfo } from "node:net";
import {
  NightWatchClient,
  setNightWatchClient,
  getNightWatchClient,
} from "@/lib/observability/night-watch";
import { mapAgentEvent } from "@/lib/observability/agent-event-mapper";
import {
  newTraceContext,
  recordLlmError,
  recordLlmRequest,
  recordLlmResponse,
  withNightWatchTrace,
} from "@/lib/observability/nw-trace";
import type { IngestBatch } from "@/lib/observability/wire";
import type { AgentEvent } from "@/lib/types";
import type { LLMResponse } from "@/lib/llm/types";

interface ReceivedBatch {
  url: string;
  authHeader: string | undefined;
  body: IngestBatch;
}

function fail(msg: string): never {
  console.error(`[FAIL] ${msg}`);
  process.exit(1);
}

let assertCount = 0;
function assert(cond: unknown, label: string): void {
  if (!cond) fail(label);
  assertCount++;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function startServer(received: ReceivedBatch[]): Promise<{
  server: Server;
  baseUrl: string;
}> {
  const server: Server = createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/api/ingest") {
      const raw = await readBody(req);
      const body = JSON.parse(raw) as IngestBatch;
      received.push({
        url: req.url,
        authHeader: (req.headers["authorization"] as string | undefined) ?? undefined,
        body,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ accepted: body.items.length, skipped: 0, errors: [] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

function makeClient(baseUrl: string, enabled: boolean, token?: string): NightWatchClient {
  return new NightWatchClient({
    enabled,
    baseUrl,
    token: token ?? null,
    agent: { name: "mini-agent", version: "test", hostname: "smoke" },
  });
}

async function main(): Promise<void> {
  const received: ReceivedBatch[] = [];
  const { server, baseUrl } = await startServer(received);
  try {
    /* ---- 1. disabled client → no-op ---- */
    {
      const client = makeClient(baseUrl, false);
      client.push({
        op: "trace_start",
        trace: {
          trace_id: "t-disabled",
          agent_name: "mini-agent",
          started_at: Date.now(),
        },
      });
      assert(client.pendingCount() === 0, "1.a disabled push should not enqueue");
      await client.flush();
      assert(received.length === 0, "1.b disabled flush should not POST");
    }

    /* ---- 2. flush via push() reaching BATCH_MAX (32) ---- */
    {
      const client = makeClient(baseUrl, true, "secret-token");
      for (let i = 0; i < 32; i++) {
        client.push({
          op: "event",
          event: {
            event_id: `e-${i}`,
            trace_id: "t-batch",
            seq: i,
            kind: "message",
            ts: Date.now(),
            payload_summary: `batch ${i}`,
          },
        });
      }
      // Reaching BATCH_MAX schedules a microtask flush. Wait for it.
      await new Promise((r) => setTimeout(r, 50));
      assert(received.length === 1, `2.a expected 1 batch POST, got ${received.length}`);
      const last = received[received.length - 1]!;
      assert(last.body.schema_version === 1, "2.b schema_version=1");
      assert(last.body.agent.name === "mini-agent", "2.c agent.name");
      assert(last.body.items.length === 32, "2.d 32 items");
      assert(last.authHeader === "Bearer secret-token", "2.e auth header set");
    }

    /* ---- 3. flush via timer ---- */
    {
      received.length = 0;
      const client = makeClient(baseUrl, true);
      client.push({
        op: "session_upsert",
        session: {
          session_id: "s-timer",
          agent_name: "mini-agent",
          started_at: Date.now(),
          last_active_at: Date.now(),
        },
      });
      // FLUSH_INTERVAL_MS = 250 in client.
      await new Promise((r) => setTimeout(r, 400));
      assert(received.length === 1, `3.a expected timer flush 1 batch, got ${received.length}`);
      assert(received[0]!.body.items.length === 1, "3.b 1 item");
      assert(received[0]!.body.items[0]!.op === "session_upsert", "3.c op");
    }

    /* ---- 4. agent-event-mapper round-trip ---- */
    {
      let seq = 0;
      const ctx = { trace_id: "t-map", nextSeq: () => seq++ };
      const samples: AgentEvent[] = [
        { type: "persona_resolved", persona: "cia-analyst", ref: "main" },
        { type: "memory_recalled", count: 2, ids: ["a", "b"] },
        {
          type: "chat_usage",
          model: "claude-sonnet-4-6",
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 80,
        },
        { type: "tool_call", name: "fs_read", args: { path: "x.md" } },
        { type: "tool_result", name: "fs_read", output: "hello".repeat(2000) },
        { type: "message", content: "ok done" },
        { type: "done" },
      ];
      const recs = samples.map((ev) => mapAgentEvent(ev, ctx));
      assert(recs.every((r) => r !== null), "4.a all mapped events non-null");
      assert(recs[2]!.tokens_in === 100, "4.b chat_usage tokens_in");
      assert(recs[2]!.cache_read_tokens === 80, "4.c chat_usage cache_read");
      assert(
        (recs[4]!.payload as { truncated: boolean }).truncated === true,
        "4.d tool_result long output truncated flag",
      );
      assert(recs[6]!.kind === "done", "4.e done event mapped");
      // text_delta drops to null
      const td = mapAgentEvent({ type: "text_delta", delta: "x" }, ctx);
      assert(td === null, "4.f text_delta dropped");
    }

    /* ---- 5. withNightWatchTrace wrapper ---- */
    {
      received.length = 0;
      const client = makeClient(baseUrl, true);
      setNightWatchClient(client);
      try {
        const ctx = newTraceContext({ session_id: "sid-1", agent_name: "mini-agent" });
        async function* source(): AsyncGenerator<AgentEvent> {
          yield { type: "persona_resolved", persona: "cia-analyst", ref: "main" };
          yield { type: "tool_call", name: "fs_read", args: {} };
          yield { type: "done" };
        }
        const out: AgentEvent[] = [];
        for await (const ev of withNightWatchTrace(
          ctx,
          {
            trace_id: ctx.trace_id,
            session_id: "sid-1",
            agent_name: "mini-agent",
            started_at: ctx.startedAt,
            user_message: "hi",
          },
          source(),
        )) {
          out.push(ev);
        }
        await client.flush();
        assert(out.length === 3, "5.a yields 3 events to caller");
        assert(received.length === 1, `5.b 1 batch POST, got ${received.length}`);
        const items = received[0]!.body.items;
        const ops = items.map((i) => i.op);
        assert(ops[0] === "trace_start", `5.c first op trace_start (got ${ops[0]})`);
        assert(ops[ops.length - 1] === "trace_end", `5.d last op trace_end (got ${ops[ops.length - 1]})`);
        const traceEnd = items.find((i) => i.op === "trace_end")!;
        assert(traceEnd.op === "trace_end" && traceEnd.status === "ok", "5.e status=ok");
        assert(ctx.tool_call_count === 1, "5.f tool_call_count accumulated");
      } finally {
        setNightWatchClient(null);
      }
    }

    /* ---- 6. wrapper status inference: hil_paused / user_input_pending / error ---- */
    {
      received.length = 0;
      const client = makeClient(baseUrl, true);
      setNightWatchClient(client);
      try {
        const ctxA = newTraceContext({ session_id: "sid-a", agent_name: "mini-agent" });
        async function* hilSource(): AsyncGenerator<AgentEvent> {
          yield {
            type: "tool_approval_request",
            sessionId: "ar-1",
            toolCalls: [{ toolUseId: "u1", name: "fs_write", args: {} }],
          };
          // generator returns without `done` — caller broke out for HIL.
        }
        for await (const _ of withNightWatchTrace(
          ctxA,
          {
            trace_id: ctxA.trace_id,
            session_id: "sid-a",
            agent_name: "mini-agent",
            started_at: ctxA.startedAt,
          },
          hilSource(),
        )) void _;
        await client.flush();
        const tA = received[received.length - 1]!.body.items.find((i) => i.op === "trace_end")!;
        assert(
          tA.op === "trace_end" && tA.status === "hil_paused",
          `6.a hil_paused status (got ${tA.op === "trace_end" ? tA.status : "?"})`,
        );

        received.length = 0;
        const ctxB = newTraceContext({ session_id: "sid-b", agent_name: "mini-agent" });
        async function* errSource(): AsyncGenerator<AgentEvent> {
          yield { type: "error", message: "boom" };
        }
        for await (const _ of withNightWatchTrace(
          ctxB,
          {
            trace_id: ctxB.trace_id,
            session_id: "sid-b",
            agent_name: "mini-agent",
            started_at: ctxB.startedAt,
          },
          errSource(),
        )) void _;
        await client.flush();
        const tB = received[received.length - 1]!.body.items.find((i) => i.op === "trace_end")!;
        assert(
          tB.op === "trace_end" && tB.status === "error",
          `6.b error status (got ${tB.op === "trace_end" ? tB.status : "?"})`,
        );
      } finally {
        setNightWatchClient(null);
      }
    }

    /* ---- 7. recordLlmRequest / Response / Error ---- */
    {
      received.length = 0;
      const client = makeClient(baseUrl, true);
      setNightWatchClient(client);
      try {
        const ctx = newTraceContext({ session_id: "sid-llm", agent_name: "mini-agent" });
        const handle = recordLlmRequest(ctx, {
          model: "claude-sonnet-4-6",
          message_count: 3,
          tool_count: 2,
          system_chars: 1234,
        });
        assert(handle.event_id.length > 0, "7.a request handle has event_id");

        const fakeResponse: LLMResponse = {
          content: [{ type: "text", text: "done" }],
          stop_reason: "end_turn",
          usage: {
            input_tokens: 200,
            output_tokens: 60,
            cache_read_input_tokens: 150,
          },
          reasoning: "i think therefore",
        };
        recordLlmResponse(ctx, handle, fakeResponse);

        const handle2 = recordLlmRequest(ctx, {
          model: "qwen3.6",
          message_count: 5,
          tool_count: 3,
          system_chars: 800,
        });
        const err: Error & { status?: number } = Object.assign(new Error("503 upstream"), {
          status: 503,
        });
        recordLlmError(ctx, handle2, err);

        await client.flush();
        assert(received.length === 1, `7.b 1 batch flushed, got ${received.length}`);
        const items = received[0]!.body.items;
        const eventItems = items.filter((i) => i.op === "event") as Extract<
          (typeof items)[number],
          { op: "event" }
        >[];
        const kinds = eventItems.map((i) => i.event.kind);
        assert(kinds.includes("llm_request"), "7.c llm_request emitted");
        assert(kinds.includes("llm_response"), "7.d llm_response emitted");
        assert(kinds.includes("llm_reasoning"), "7.e llm_reasoning emitted (when reasoning present)");
        assert(kinds.includes("llm_error"), "7.f llm_error emitted");
        const respEvent = eventItems.find((i) => i.event.kind === "llm_response")!;
        assert(respEvent.event.parent_event_id === handle.event_id, "7.g llm_response parent linkage");
        assert(respEvent.event.tokens_in === 200, "7.h llm_response tokens_in");
        assert(respEvent.event.cache_read_tokens === 150, "7.i llm_response cache_read");
        const errEvent = eventItems.find((i) => i.event.kind === "llm_error")!;
        assert(
          errEvent.event.payload?.http_status === 503,
          "7.j llm_error http_status preserved",
        );
        assert(errEvent.event.parent_event_id === handle2.event_id, "7.k llm_error parent linkage");
        assert(ctx.error_count === 1, "7.l ctx.error_count incremented");
      } finally {
        setNightWatchClient(null);
      }
    }

    console.log(`[OK] smoke-night-watch passed ${assertCount} assertions`);
  } finally {
    server.close();
    // singleton hygiene — prevent leak into other smoke runs.
    setNightWatchClient(null);
    void getNightWatchClient;
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
