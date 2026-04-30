#!/usr/bin/env tsx
/**
 * e2e-verifier-hook-local-gemma — Gemma a4b main + agent_turn_hook ON
 * 조합의 v31 closing card 운영 이식 입증.
 *
 * 전제:
 *   1. LM Studio (192.168.1.13:1234) 가 켜져 있고 gemma-4-26b-a4b-it-mlx listed.
 *   2. mini-agent dev server: VERIFIER_HOOK=on VERIFIER_HOOK_AGENT_TURN=on pnpm dev
 *   3. ANTHROPIC_API_KEY env (verifier+plausibility 호출용).
 *
 * env:
 *   MINI_AGENT_URL  default http://localhost:3000
 *   LM_STUDIO_URL   default http://192.168.1.13:1234
 *   OUT_DIR         default mini-agent/.tmp/
 *   PROFILE_NAME    default gemma-4-26b-a4b-it-mlx
 */

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const MINI = process.env.MINI_AGENT_URL ?? "http://localhost:3000";
const LMS = process.env.LM_STUDIO_URL ?? "http://192.168.1.13:1234";
const OUT_DIR = process.env.OUT_DIR ?? ".tmp";
const PROFILE_NAME = process.env.PROFILE_NAME ?? "gemma-4-26b-a4b-it-mlx";
const TIMEOUT_MS = 180_000;

async function preflight(): Promise<void> {
  // mini-agent dev server reachability
  try {
    const r = await fetch(MINI, { method: "GET" });
    if (!r.ok) throw new Error(`status ${r.status}`);
  } catch (e) {
    console.error(`[preflight] mini-agent ${MINI} unreachable: ${(e as Error).message}`);
    console.error(`[preflight] hint: VERIFIER_HOOK=on VERIFIER_HOOK_AGENT_TURN=on pnpm dev`);
    process.exit(2);
  }
  console.log(`[preflight] mini-agent ${MINI} OK`);

  // LM Studio + Gemma a4b listed
  try {
    const r = await fetch(`${LMS}/v1/models`, { method: "GET" });
    if (!r.ok) throw new Error(`status ${r.status}`);
    const data = (await r.json()) as { data: Array<{ id: string }> };
    const ids = data.data.map((m) => m.id);
    if (!ids.includes(PROFILE_NAME)) {
      console.error(`[preflight] LM Studio missing model "${PROFILE_NAME}". listed: ${ids.join(", ")}`);
      process.exit(2);
    }
    console.log(`[preflight] LM Studio ${LMS} OK (gemma listed)`);
  } catch (e) {
    console.error(`[preflight] LM Studio ${LMS} unreachable: ${(e as Error).message}`);
    process.exit(2);
  }
}

type VerifyChainEvent = {
  type: "verify_chain";
  path: "plausibility_skip" | "verifier_applied" | "off";
  accepted: boolean;
  override_applied: boolean;
  strategy: "anthropic-best" | "local-gemma-current";
  category?: string;
  turn_index: number;
  plausibility_verdict?: "YES" | "NO" | "PARSE_FAIL";
  verifier_verdict?: "ACCEPT" | "REJECT" | "PARSE_FAIL";
  duration_ms: number;
};

type AgentEvent =
  | { type: "message"; content: string }
  | { type: "chat_usage"; model: string; input_tokens: number; output_tokens: number }
  | { type: "done" }
  | { type: "error"; message: string }
  | VerifyChainEvent
  | { type: string; [key: string]: unknown };

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

interface CaseOutcome {
  label: string;
  request: { message: string; profileName: string };
  finalMessage: string;
  done: boolean;
  errors: string[];
  verifyEvents: VerifyChainEvent[];
  rawEvents: AgentEvent[];
  sidCookie: string | null;
}

async function runCase(
  label: string,
  message: string,
  sidCookie: string | null,
): Promise<CaseOutcome> {
  console.log(`\n[${label}] POST /chat profile=${PROFILE_NAME} message="${message.slice(0, 50)}..."`);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (sidCookie) headers["Cookie"] = sidCookie;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  const res = await fetch(`${MINI}/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify({ message, persona: "default", profileName: PROFILE_NAME }),
    signal: ac.signal,
  });
  if (!res.ok) {
    clearTimeout(timer);
    throw new Error(`POST /chat → ${res.status}: ${await res.text().catch(() => "")}`);
  }
  const setCookie = res.headers.get("set-cookie");
  const nextSid = setCookie ? setCookie.split(";")[0] : sidCookie;

  const out: CaseOutcome = {
    label,
    request: { message, profileName: PROFILE_NAME },
    finalMessage: "",
    done: false,
    errors: [],
    verifyEvents: [],
    rawEvents: [],
    sidCookie: nextSid,
  };
  for await (const ev of parseSSE(res)) {
    out.rawEvents.push(ev);
    if (ev.type === "message" && typeof (ev as { content?: unknown }).content === "string") {
      out.finalMessage = (ev as { content: string }).content;
    } else if (ev.type === "verify_chain") {
      out.verifyEvents.push(ev as VerifyChainEvent);
    } else if (ev.type === "done") {
      out.done = true;
    } else if (ev.type === "error") {
      out.errors.push((ev as { message?: string }).message ?? "unknown");
    }
  }
  clearTimeout(timer);

  console.log(`  done=${out.done} errors=${out.errors.length} verify_chain=${out.verifyEvents.length}`);
  console.log(`  final="${out.finalMessage.slice(0, 80).replace(/\n/g, " ")}..."`);
  for (const v of out.verifyEvents) {
    console.log(
      `  verify: strategy=${v.strategy} path=${v.path} accepted=${v.accepted} category=${v.category} turn=${v.turn_index} pv=${v.plausibility_verdict} vv=${v.verifier_verdict}`,
    );
  }
  return out;
}

async function main(): Promise<void> {
  await preflight();

  // Scenario A — easy well-known 1-shot
  const A = await runCase("A: easy well-known", "대한민국 수도는 어디야?", null);

  // Scenario B — fab-prone 3-turn cascade. sid 쿠키 유지로 memory 공유.
  const B1 = await runCase(
    "B1: hassabis intro",
    "Demis Hassabis 가 어떤 사람이야?",
    null,
  );
  const B2 = await runCase(
    "B2: 그 사람 학부 대학",
    "그 사람이 다닌 학부 대학은?",
    B1.sidCookie,
  );
  const B3 = await runCase(
    "B3: 정확한 졸업 연도",
    "그 대학의 정확한 졸업 연도는?",
    B2.sidCookie,
  );

  // 합격선 (Q3 medium)
  const aVerify = A.verifyEvents[0];
  const aPass =
    A.done &&
    A.errors.length === 0 &&
    !!aVerify &&
    aVerify.strategy === "local-gemma-current" &&
    aVerify.path === "plausibility_skip" &&
    aVerify.accepted === true &&
    aVerify.category === "easy-cascade-baseline" &&
    /서울/.test(A.finalMessage);

  const bVerify = B3.verifyEvents.find(
    (v) =>
      v.strategy === "local-gemma-current" &&
      v.path === "verifier_applied" &&
      v.category !== "easy-cascade-baseline" &&
      v.turn_index >= 3,
  );
  const bPass = B3.done && B3.errors.length === 0 && !!bVerify;

  const dump = {
    spec: "2026-04-30-local-gemma-line-production-graft",
    profile: PROFILE_NAME,
    timestamp: Date.now(),
    scenarios: { A, B1, B2, B3 },
    verdict: {
      A_pass: aPass,
      B_pass: bPass,
      bonus_reject:
        B3.verifyEvents.some(
          (v) => v.verifier_verdict === "REJECT" || v.override_applied === true,
        ) ||
        B2.verifyEvents.some(
          (v) => v.verifier_verdict === "REJECT" || v.override_applied === true,
        ),
    },
  };
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const outPath = join(OUT_DIR, `e2e-verifier-hook-local-gemma-${dump.timestamp}.json`);
  writeFileSync(outPath, JSON.stringify(dump, null, 2));

  console.log(`\n=== verdict ===`);
  console.log(`  ${aPass ? "✓" : "✗"} A: easy well-known plausibility_skip`);
  console.log(`  ${bPass ? "✓" : "✗"} B: fab-prone cascade verifier_applied turn>=3`);
  console.log(`  bonus reject seen: ${dump.verdict.bonus_reject}`);
  console.log(`  artifact: ${outPath}`);
  process.exit(aPass && bPass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

export {};
