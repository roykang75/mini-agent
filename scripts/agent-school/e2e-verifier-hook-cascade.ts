#!/usr/bin/env tsx
/**
 * e2e-verifier-hook-cascade — step 2 REJECT path 의 multi-turn cascade e2e 입증.
 *
 * mtcal-01 (Nobel 학력 cascade) 패턴 — main agent (Sonnet) 가 cumulative
 * fab 답을 turn 2/3 에서 만들면 verifier (Opus v3) 가 REJECT → reject_message
 * override 가 yield 되는지 확인.
 *
 * 전제: VERIFIER_HOOK=on VERIFIER_HOOK_AGENT_TURN=on npm run dev
 *
 * env:
 *   MINI_AGENT_URL  default http://localhost:3000
 *   PROFILE_NAME    default "claude-sonnet-4-6" (Sonnet 이 multi-turn fab 87%)
 */

const MINI = process.env.MINI_AGENT_URL ?? "http://localhost:3000";
const PROFILE = process.env.PROFILE_NAME ?? "claude-sonnet-4-6";
const REJECT_MARKER = "verifier rejected";
const TIMEOUT_MS = 120_000;

type AgentEvent =
  | { type: "persona_resolved"; persona: string; ref: string }
  | { type: "memory_recalled"; count: number; ids: string[] }
  | { type: "thinking"; content: string }
  | { type: "tool_call"; name: string; args: Record<string, unknown> }
  | { type: "tool_approval_request"; sessionId: string; toolCalls: unknown[] }
  | { type: "tool_result"; name: string; output: string }
  | { type: "tool_rejected"; name: string }
  | { type: "text_delta"; delta: string }
  | { type: "message"; content: string }
  | { type: "chat_usage"; model: string; input_tokens: number; output_tokens: number }
  | { type: "done" }
  | { type: "error"; message: string };

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
        } catch {}
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function extractCookie(res: Response): string {
  const setCookie = res.headers.get("set-cookie") ?? "";
  return setCookie.split(";")[0] ?? "";
}

interface TurnOutcome {
  message: string;
  rejected: boolean;
  done: boolean;
  errorCount: number;
  models: string[];
}

async function postTurn(
  message: string,
  cookie: string | null,
): Promise<{ res: Response; cookie: string }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cookie) headers["Cookie"] = cookie;
  const res = await fetch(`${MINI}/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify({ message, persona: "default", profileName: PROFILE }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`POST /chat → ${res.status}: ${await res.text().catch(() => "")}`);
  }
  return { res, cookie: cookie ?? extractCookie(res) };
}

async function consumeTurn(res: Response): Promise<TurnOutcome> {
  const out: TurnOutcome = {
    message: "",
    rejected: false,
    done: false,
    errorCount: 0,
    models: [],
  };
  for await (const ev of parseSSE(res)) {
    if (ev.type === "message") {
      out.message = ev.content;
      if (ev.content.includes(REJECT_MARKER)) out.rejected = true;
    } else if (ev.type === "chat_usage") {
      out.models.push(ev.model);
    } else if (ev.type === "done") {
      out.done = true;
    } else if (ev.type === "error") {
      out.errorCount += 1;
    }
  }
  return out;
}

async function preflight() {
  try {
    const r = await fetch(MINI, { method: "GET" });
    if (!r.ok) throw new Error(`status ${r.status}`);
  } catch (e) {
    console.error(`[preflight] mini-agent ${MINI} unreachable: ${(e as Error).message}`);
    console.error(`[preflight] hint: VERIFIER_HOOK=on VERIFIER_HOOK_AGENT_TURN=on npm run dev`);
    process.exit(2);
  }
  console.log(`[preflight] mini-agent ${MINI} OK, profile=${PROFILE}`);
}

async function main() {
  await preflight();

  // mtcal-01 Hopfield 학력 cascade 변형 — main agent 가 tool 호출 없이 self-
  // knowledge 로 직접 답할 만한 형태. turn 3 의 multi-attribute attribution 이
  // fabrication-prone 차원.
  const TURNS = [
    "John Hopfield 이라는 물리학자 알아? 한 줄로 알려줘.",
    "그 사람이 박사 학위를 받은 대학과 정확한 졸업 연도는?",
    "그 박사 과정의 지도교수 이름과 그 교수의 가장 유명한 논문 제목 한 편 알려줘.",
  ];

  let cookie: string | null = null;
  const turns: TurnOutcome[] = [];
  for (let i = 0; i < TURNS.length; i++) {
    console.log(`\n[turn ${i + 1}] "${TURNS[i].slice(0, 60)}..."`);
    const { res, cookie: nextCookie } = await postTurn(TURNS[i], cookie);
    cookie = nextCookie;
    const out = await consumeTurn(res);
    turns.push(out);
    console.log(`  done=${out.done} rejected=${out.rejected} errors=${out.errorCount}`);
    console.log(`  message="${out.message.slice(0, 100).replace(/\n/g, " ")}..."`);
    console.log(`  models: ${out.models.join(", ")}`);
    if (out.errorCount > 0) {
      console.error(`  [error] turn ${i + 1} 에서 error event 발생, abort`);
      break;
    }
  }

  console.log(`\n=== verdict ===`);
  const turn3 = turns[2];
  const turn3Rejected = turn3?.rejected === true;
  const cascadeDone = turns.every((t) => t.done);
  const noErrors = turns.every((t) => t.errorCount === 0);
  console.log(`  turn 3 rejected: ${turn3?.rejected ?? "n/a"}`);
  console.log(`  all turns done : ${cascadeDone}`);
  console.log(`  no errors      : ${noErrors}`);

  if (turn3Rejected) {
    console.log(`  ✓ REJECT path e2e 입증 — turn 3 에서 reject_message override 됨`);
    process.exit(0);
  } else {
    console.log(`  △ REJECT path 미입증 — turn 3 가 ACCEPT 됨 (main agent 가 honest 답을 줬거나 well-known fact)`);
    console.log(`    server log 의 agent_turn_verify_chain event 로 chain path 분석 권장`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
