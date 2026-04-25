// Night's Watch Phase 2 — end-to-end smoke against a running NW dev server.
//
// Prerequisites:
//   1. `cd night-watch && npm run dev` (3001)
//   2. Run this smoke: NW_BASE_URL=http://127.0.0.1:3001 npx tsx scripts/smoke-night-watch-e2e.ts
//
// 검증:
//   - NightWatchClient 가 실 서버 /api/ingest 에 batch 를 POST → 200 OK
//   - last_trace_ts (via /api/health) 가 ingest 후 진척
//   - traces 카운트가 +1 (간이 — health 엔드포인트만으로는 트레이스 단건 검증 한계.
//     운영시 Phase 3 viewer 로 확인하지만 여기선 last_trace_ts 만 비교)

import { randomUUID } from "node:crypto";
import { NightWatchClient } from "@/lib/observability/night-watch";
import {
  newTraceContext,
  recordLlmRequest,
  recordLlmResponse,
  withNightWatchTrace,
} from "@/lib/observability/nw-trace";
import type { AgentEvent } from "@/lib/types";
import type { LLMResponse } from "@/lib/llm/types";

function fail(msg: string): never {
  console.error(`[FAIL] ${msg}`);
  process.exit(1);
}

let assertions = 0;
function assert(cond: unknown, label: string): void {
  if (!cond) fail(label);
  assertions++;
}

interface HealthBody {
  status: string;
  version: string;
  schema_version: number;
  last_trace_ts: number | null;
  now: number;
  db_size: number;
}

async function fetchHealth(baseUrl: string): Promise<HealthBody> {
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/health`);
  if (!res.ok) fail(`/api/health returned ${res.status}`);
  return (await res.json()) as HealthBody;
}

async function main(): Promise<void> {
  const baseUrl = process.env.NW_BASE_URL ?? "http://127.0.0.1:3001";
  const before = await fetchHealth(baseUrl);
  console.log(`[info] before: last_trace_ts=${before.last_trace_ts}`);
  assert(before.status === "ok", "health.status === ok");

  // Real client → real server.
  const client = new NightWatchClient({
    enabled: true,
    baseUrl,
    token: null,
    agent: { name: "mini-agent", version: "e2e-smoke", hostname: "smoke-host" },
  });

  // Inject as the singleton so withNightWatchTrace picks up the same instance.
  const nwModule = await import("@/lib/observability/night-watch");
  nwModule.setNightWatchClient(client);

  // session_upsert (first time)
  const sessionId = `e2e-sid-${randomUUID().slice(0, 8)}`;
  const ctx = newTraceContext({ session_id: sessionId, agent_name: "mini-agent" });
  client.push({
    op: "session_upsert",
    session: {
      session_id: sessionId,
      agent_name: "mini-agent",
      sid: sessionId,
      started_at: Date.now(),
      last_active_at: Date.now(),
      profile_name: "claude-sonnet-4-6",
    },
  });

  // Mirror production order: withNightWatchTrace pushes trace_start on first
  // .next(), and the source (= agentLoop) calls recordLlmRequest/Response
  // INSIDE the iteration so they always land after trace_start in the batch.
  const fakeResp: LLMResponse = {
    content: [{ type: "text", text: "I read the file." }],
    stop_reason: "end_turn",
    usage: { input_tokens: 120, output_tokens: 40, cache_read_input_tokens: 90 },
  };
  async function* source(): AsyncGenerator<AgentEvent> {
    const reqHandle = recordLlmRequest(ctx, {
      model: "claude-sonnet-4-6",
      message_count: 1,
      tool_count: 1,
      system_chars: 500,
    });
    yield { type: "persona_resolved", persona: "cia-analyst", ref: "main" };
    yield {
      type: "chat_usage",
      model: "claude-sonnet-4-6",
      input_tokens: 120,
      output_tokens: 40,
      cache_read_input_tokens: 90,
    };
    yield { type: "tool_call", name: "fs_read", args: { path: "test.md" } };
    yield { type: "tool_result", name: "fs_read", output: "hello world" };
    yield { type: "message", content: "I read the file." };
    recordLlmResponse(ctx, reqHandle, fakeResp);
    yield { type: "done" };
  }

  const collected: AgentEvent[] = [];
  for await (const ev of withNightWatchTrace(
    ctx,
    {
      trace_id: ctx.trace_id,
      session_id: sessionId,
      agent_name: "mini-agent",
      started_at: ctx.startedAt,
      user_message: "read test.md please",
    },
    source(),
  )) {
    collected.push(ev);
  }

  // Force a flush to drain the queue.
  await client.flush();

  // Give the server a moment to commit (SQLite WAL).
  await new Promise((r) => setTimeout(r, 200));

  const after = await fetchHealth(baseUrl);
  console.log(`[info] after:  last_trace_ts=${after.last_trace_ts}`);
  console.log(`[info] db_size: ${before.db_size} → ${after.db_size}`);

  assert(
    after.last_trace_ts !== null && after.last_trace_ts >= ctx.startedAt,
    `last_trace_ts ${after.last_trace_ts} should be >= ctx.startedAt ${ctx.startedAt}`,
  );
  assert(
    after.last_trace_ts !== before.last_trace_ts,
    "last_trace_ts should advance after ingest",
  );
  assert(
    collected.length === 6,
    `caller observed ${collected.length} events (expected 6)`,
  );

  console.log(`[OK] smoke-night-watch-e2e — ${assertions} assertions passed`);
  console.log(`[OK] trace_id ingested: ${ctx.trace_id}`);

  nwModule.setNightWatchClient(null);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
