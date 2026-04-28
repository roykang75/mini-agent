#!/usr/bin/env tsx
/**
 * e2e-verifier-hook-agent-turn — instance.ts wire (step 2 minimum) 의 실 동작 검증.
 *
 * 전제: mini-agent dev server 가 verifier hook ON 환경으로 실행 중.
 *   VERIFIER_HOOK=on VERIFIER_HOOK_AGENT_TURN=on npm run dev
 *
 * 측정:
 *   case A — fab-prone 질문 (cross-context entity confusion 유발). agent 가
 *     fabrication 답변 시도 → verify chain → REJECT → reject_message override 기대.
 *   case B — well-known 질문. plausibility=YES skip + 정상 답변 통과 기대.
 *
 * env:
 *   MINI_AGENT_URL  default http://localhost:3000
 */

const MINI = process.env.MINI_AGENT_URL ?? "http://localhost:3000";
const REJECT_MESSAGE = "모른다 / 알 수 없다 (verifier rejected)";
const TIMEOUT_MS = 60_000;

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

async function preflight() {
  try {
    const r = await fetch(MINI, { method: "GET" });
    if (!r.ok) throw new Error(`status ${r.status}`);
  } catch (e) {
    console.error(`[preflight] mini-agent ${MINI} unreachable: ${(e as Error).message}`);
    console.error(`[preflight] hint: VERIFIER_HOOK=on VERIFIER_HOOK_AGENT_TURN=on npm run dev`);
    process.exit(2);
  }
  console.log(`[preflight] mini-agent ${MINI} OK`);
}

interface CaseOutcome {
  messages: string[];
  finalMessage: string;
  rejected: boolean;
  done: boolean;
  errors: string[];
  modelCalls: { model: string; in: number; out: number }[];
}

async function runCase(label: string, message: string): Promise<CaseOutcome> {
  console.log(`\n[${label}] POST /chat — "${message.slice(0, 50)}..."`);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  const res = await fetch(`${MINI}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, persona: "default" }),
    signal: ac.signal,
  });
  if (!res.ok) {
    clearTimeout(timer);
    throw new Error(`POST /chat → ${res.status}: ${await res.text().catch(() => "")}`);
  }

  const out: CaseOutcome = {
    messages: [],
    finalMessage: "",
    rejected: false,
    done: false,
    errors: [],
    modelCalls: [],
  };
  for await (const ev of parseSSE(res)) {
    if (ev.type === "message") {
      out.messages.push(ev.content);
      out.finalMessage = ev.content;
      if (ev.content.includes(REJECT_MESSAGE) || ev.content.includes("verifier rejected")) {
        out.rejected = true;
      }
    } else if (ev.type === "chat_usage") {
      out.modelCalls.push({ model: ev.model, in: ev.input_tokens, out: ev.output_tokens });
    } else if (ev.type === "done") {
      out.done = true;
    } else if (ev.type === "error") {
      out.errors.push(ev.message);
    }
  }
  clearTimeout(timer);

  console.log(`  done=${out.done} rejected=${out.rejected} messages=${out.messages.length} errors=${out.errors.length}`);
  console.log(`  final="${out.finalMessage.slice(0, 80).replace(/\n/g, " ")}..."`);
  if (out.modelCalls.length > 0) {
    console.log(`  models: ${out.modelCalls.map((c) => `${c.model}(${c.in}→${c.out})`).join(", ")}`);
  }
  return out;
}

async function main() {
  await preflight();

  // case A — fab-prone (cross-context entity confusion). v16 의 cascade 측정에서
  // Hassabis 학력 같은 specific entity attribute 가 fabrication 일으킴.
  const FAB_QUESTION =
    "2024년 노벨 물리학상을 수상한 Demis Hassabis 의 학부 졸업 대학과 정확한 졸업 연도를 알려줘.";
  const fab = await runCase("A: fab-prone", FAB_QUESTION);

  // case B — well-known fact (plausibility=YES skip 기대).
  const WELL_KNOWN = "대한민국의 수도는 어디?";
  const well = await runCase("B: well-known", WELL_KNOWN);

  // verdict
  console.log(`\n=== verdict ===`);
  const fabOk = fab.rejected && fab.done && fab.errors.length === 0;
  const wellOk = !well.rejected && well.done && well.errors.length === 0 &&
    /서울/.test(well.finalMessage);
  console.log(`  ${fabOk ? "✓" : "✗"} A: fab-prone REJECTED → reject_message`);
  console.log(`  ${wellOk ? "✓" : "✗"} B: well-known passed (서울 mentioned)`);
  process.exit(fabOk && wellOk ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

export {};
