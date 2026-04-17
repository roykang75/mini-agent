/**
 * E2E: CIA analyst scenario against the running mini-agent + cia-mock servers.
 *
 * Preconditions:
 *   - mini-agent dev server at MINI_AGENT_URL (default http://localhost:3000)
 *   - cia-mock server at CIA_MOCK_URL (default http://localhost:7777)
 *   - LLM credentials reachable from the mini-agent process (.env.local)
 *
 * The LLM is non-deterministic so this script uses shape-based assertions:
 *
 *   1. persona_resolved event shows persona === "cia-analyst"
 *   2. at least one tool_approval_request for `request_credential`
 *      → approved with a dummy token via POST /chat/approve
 *   3. at least one tool_approval_request for `http_call`
 *      → approved (all calls approved)
 *   4. at least one http_call tool_result body is parseable JSON and
 *      either has status:400+missing_fields or status:200+summary
 *   5. the final assistant `message` text mentions risk/영향/서비스
 *
 * Flakiness note: if the LLM decides not to emit request_credential or to
 * produce unusual tool args, the script prints the full event log and exits
 * non-zero. Re-run — if persistent, the SOUL prompt needs tightening.
 */

const MINI = process.env.MINI_AGENT_URL ?? "http://localhost:3000";
const MOCK = process.env.CIA_MOCK_URL ?? "http://localhost:7777";
const PERSONA = "cia-analyst";
const USER_MESSAGE =
  "impact-analysis.git 저장소의 abc1234 와 def5678 커밋 사이 영향을 CIA 서비스로 분석해줘.";
const TOKEN = "e2e-smoke-token-xyz";
const TOTAL_TIMEOUT_MS = 120_000;
const APPROVAL_BUDGET = 8;

type AgentEvent =
  | { type: "persona_resolved"; persona: string; ref: string }
  | { type: "memory_recalled"; count: number; ids: string[] }
  | { type: "thinking"; content: string }
  | { type: "tool_call"; name: string; args: Record<string, unknown> }
  | { type: "tool_approval_request"; sessionId: string; toolCalls: { toolUseId: string; name: string; args: Record<string, unknown> }[] }
  | { type: "tool_result"; name: string; output: string }
  | { type: "tool_rejected"; name: string }
  | { type: "message"; content: string }
  | { type: "done" }
  | { type: "error"; message: string };

async function preflight() {
  const h = await fetch(`${MOCK}/health`).catch((e) => {
    throw new Error(`cia-mock unreachable at ${MOCK}: ${(e as Error).message}`);
  });
  if (!h.ok) throw new Error(`cia-mock /health → ${h.status}`);

  const r = await fetch(MINI, { method: "GET" }).catch((e) => {
    throw new Error(`mini-agent unreachable at ${MINI}: ${(e as Error).message}`);
  });
  if (!r.ok) throw new Error(`mini-agent / → ${r.status}`);
  console.log(`[preflight] mini-agent ${MINI} + cia-mock ${MOCK} 응답 OK`);
}

async function* parseSSE(res: Response): AsyncGenerator<AgentEvent> {
  if (!res.body) throw new Error("no SSE body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const raw = line.slice(5).trim();
        if (!raw) continue;
        try {
          yield JSON.parse(raw) as AgentEvent;
        } catch {
          console.warn(`[sse] parse fail: ${raw}`);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function extractCookies(res: Response): string {
  const raw = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
  const parts = raw.length ? raw : [res.headers.get("set-cookie") ?? ""].filter(Boolean);
  return parts
    .map((h) => h.split(";")[0])
    .filter(Boolean)
    .join("; ");
}

interface CollectedEvents {
  persona?: { persona: string; ref: string };
  memoryRecalled?: { count: number; ids: string[] };
  toolCalls: { name: string; args: Record<string, unknown> }[];
  toolResults: { name: string; output: string }[];
  messages: string[];
  approvals: { sessionId: string; tools: { toolUseId: string; name: string; args: Record<string, unknown> }[] }[];
  errors: string[];
  rawTypes: string[];
}

function emptyCollected(): CollectedEvents {
  return {
    toolCalls: [],
    toolResults: [],
    messages: [],
    approvals: [],
    errors: [],
    rawTypes: [],
  };
}

async function consume(stream: Response, collected: CollectedEvents): Promise<"approval_needed" | "done" | "error"> {
  for await (const ev of parseSSE(stream)) {
    collected.rawTypes.push(ev.type);
    switch (ev.type) {
      case "persona_resolved":
        collected.persona = { persona: ev.persona, ref: ev.ref };
        console.log(`[evt] persona_resolved persona=${ev.persona} ref=${ev.ref}`);
        break;
      case "memory_recalled":
        collected.memoryRecalled = { count: ev.count, ids: ev.ids };
        console.log(`[evt] memory_recalled count=${ev.count} ids=${ev.ids.join(",")}`);
        break;
      case "tool_call":
        collected.toolCalls.push({ name: ev.name, args: ev.args });
        console.log(`[evt] tool_call ${ev.name} ${JSON.stringify(ev.args).slice(0, 200)}`);
        break;
      case "tool_approval_request":
        collected.approvals.push({ sessionId: ev.sessionId, tools: ev.toolCalls });
        console.log(`[evt] tool_approval_request sessionId=${ev.sessionId} tools=${ev.toolCalls.map((t) => t.name).join(",")}`);
        return "approval_needed";
      case "tool_result":
        collected.toolResults.push({ name: ev.name, output: ev.output });
        console.log(`[evt] tool_result ${ev.name} → ${ev.output.slice(0, 200)}`);
        break;
      case "message":
        collected.messages.push(ev.content);
        process.stdout.write(ev.content);
        break;
      case "error":
        collected.errors.push(ev.message);
        console.error(`[evt] error ${ev.message}`);
        return "error";
      case "done":
        console.log("\n[evt] done");
        return "done";
      case "thinking":
      case "tool_rejected":
        break;
    }
  }
  return "done";
}

async function approve(
  sessionId: string,
  credentials: Record<string, string> | undefined,
  cookie: string,
): Promise<Response> {
  const res = await fetch(`${MINI}/chat/approve`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
    },
    body: JSON.stringify({ sessionId, approved: true, credentials }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`approve HTTP ${res.status}: ${text}`);
  }
  return res;
}

async function main() {
  await preflight();

  const startRes = await fetch(`${MINI}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: USER_MESSAGE, persona: PERSONA }),
  });
  if (!startRes.ok) {
    throw new Error(`POST /chat → ${startRes.status}: ${await startRes.text().catch(() => "")}`);
  }

  const cookie = extractCookies(startRes);
  console.log(`[http] POST /chat OK, cookie=${cookie ? "set" : "none"}`);

  const collected = emptyCollected();
  let current: Response = startRes;
  let outcome = await consume(current, collected);

  let approvals = 0;
  const start = Date.now();

  while (outcome === "approval_needed" && approvals < APPROVAL_BUDGET) {
    approvals++;
    if (Date.now() - start > TOTAL_TIMEOUT_MS) {
      throw new Error(`scenario timeout after ${TOTAL_TIMEOUT_MS}ms`);
    }

    const approval = collected.approvals[collected.approvals.length - 1];
    if (!approval) throw new Error("approval stub missing");

    const credentials: Record<string, string> = {};
    for (const t of approval.tools) {
      if (t.name === "request_credential") credentials[t.toolUseId] = TOKEN;
    }
    const hasCreds = Object.keys(credentials).length > 0;
    console.log(
      `[approve #${approvals}] sid=${approval.sessionId} tools=${approval.tools.map((t) => t.name).join(",")} credentials=${hasCreds ? "yes" : "no"}`,
    );

    current = await approve(approval.sessionId, hasCreds ? credentials : undefined, cookie);
    outcome = await consume(current, collected);
  }

  if (approvals >= APPROVAL_BUDGET && outcome === "approval_needed") {
    throw new Error(`exceeded approval budget (${APPROVAL_BUDGET}); likely an agent loop`);
  }

  if (outcome === "error") {
    throw new Error(`agent emitted error(s): ${collected.errors.join(" | ")}`);
  }

  // --- assertions ---
  const problems: string[] = [];

  if (collected.persona?.persona !== PERSONA) {
    problems.push(`persona_resolved.persona expected "${PERSONA}", got ${JSON.stringify(collected.persona)}`);
  }

  const sawRequestCredential = collected.toolCalls.some((c) => c.name === "request_credential");
  if (!sawRequestCredential) {
    problems.push(`no request_credential tool_call observed — agent may have skipped HIL`);
  }

  const httpResults = collected.toolResults.filter((r) => r.name === "http_call");
  if (httpResults.length === 0) {
    problems.push(`no http_call tool_result observed`);
  }

  const anyHttpOk = httpResults.some((r) => {
    try {
      const body = JSON.parse(r.output) as { status?: number; ok?: boolean };
      return body.status === 200 && body.ok === true;
    } catch {
      return false;
    }
  });
  if (!anyHttpOk) {
    problems.push(`no successful (status=200) http_call response observed`);
  }

  const finalText = collected.messages.join("");
  const summaryKeywords = ["위험", "영향", "서비스"];
  const hitKeywords = summaryKeywords.filter((k) => finalText.includes(k));
  if (hitKeywords.length < 2) {
    problems.push(`final message lacks summary keywords (found ${hitKeywords.join(",") || "none"}) — message=${finalText.slice(0, 240)}`);
  }

  // Secret leak check — raw token must not appear in any message/tool_call event
  const leakInText = finalText.includes(TOKEN);
  const leakInTools = collected.toolCalls.some((c) => JSON.stringify(c.args).includes(TOKEN));
  if (leakInText || leakInTools) {
    problems.push(`secret leak detected — token present in ${leakInText ? "message" : ""} ${leakInTools ? "tool_call args" : ""}`);
  }

  console.log("\n--- summary ---");
  console.log(`events:      ${collected.rawTypes.length}`);
  console.log(`persona:     ${collected.persona?.persona}`);
  if (collected.memoryRecalled) {
    console.log(`recall:      ${collected.memoryRecalled.count} episode(s) — ${collected.memoryRecalled.ids.join(", ")}`);
  } else {
    console.log(`recall:      none (first session or idle-gated)`);
  }
  console.log(`tool_calls:  ${collected.toolCalls.map((c) => c.name).join(", ")}`);
  console.log(`approvals:   ${approvals}`);
  console.log(`http_call results: ${httpResults.length} (ok=${anyHttpOk})`);
  console.log(`final message length: ${finalText.length}`);
  console.log(`secret leak: ${leakInText || leakInTools ? "YES (FAIL)" : "no"}`);

  if (problems.length > 0) {
    console.error(`\n[FAIL] ${problems.length} assertion(s) failed:`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  console.log("\nCIA E2E scenario passed.");
}

main().catch((e) => {
  console.error(`\n[FAIL] ${(e as Error).message}`);
  process.exit(1);
});
