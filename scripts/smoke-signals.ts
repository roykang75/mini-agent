/**
 * Smoke: signal detector (Phase 8 T8.2).
 *
 * Part 1: synthetic events cover all four signal kinds.
 * Part 2: load the most recent real JSONL (AGENT_MEMORY_DIR) and print detected
 *         signals — informational, helps calibrate thresholds.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import type { RawEvent } from "../src/lib/memory/raw";
import { compactSignals, detectSignals } from "../src/lib/memory/signals";

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error(`[FAIL] ${msg}`);
    process.exit(1);
  }
}

function e(
  offsetSec: number,
  event_type: string,
  payload: unknown,
  persona?: string,
): RawEvent {
  const base = Date.parse("2026-04-17T00:00:00Z");
  return {
    ts: new Date(base + offsetSec * 1000).toISOString(),
    session_id: "test",
    event_type,
    payload,
    ...(persona ? { persona, persona_ref: "HEAD" } : {}),
  };
}

function synthetic() {
  const events: RawEvent[] = [
    e(0, "user_message", { content: "CIA 분석 부탁" }),
    e(1, "persona_resolved", { persona: "cia-analyst" }, "cia-analyst"),
    e(2, "tool_call", { name: "http_call" }, "cia-analyst"),
    e(3, "tool_result", { name: "http_call", output: '{"status":400,"ok":false,"body":{"error":"missing_fields"}}' }, "cia-analyst"),
    e(4, "tool_result", { name: "http_call", output: '{"status":500,"ok":false,"body":{"error":"boom"}}' }, "cia-analyst"),
    e(5, "tool_result", { name: "http_call", output: '{"status":502,"ok":false,"body":{"error":"bad gateway"}}' }, "cia-analyst"),
    // 35 분 후 재개 → idle_gap
    e(5 + 35 * 60, "user_message", { content: "이제 다른 얘기인데 파일 좀 봐줘" }),
    e(5 + 35 * 60 + 1, "persona_resolved", { persona: "default" }, "default"),
    e(5 + 35 * 60 + 2, "tool_call", { name: "read_file" }, "default"),
    e(5 + 35 * 60 + 3, "tool_result", { name: "read_file", output: "ok — file content" }, "default"),
  ];

  const signals = detectSignals(events);
  console.log(`[synthetic] ${signals.length} signals detected:`);
  for (const s of signals) console.log(`  #${s.index}  ${s.reason}  sev=${s.severity.toFixed(2)}  ${s.detail}`);

  const kinds = new Set(signals.map((s) => s.reason));
  assert(kinds.has("tool_error_streak"), "tool_error_streak 미검출");
  assert(kinds.has("idle_gap"), "idle_gap 미검출");
  assert(kinds.has("persona_diff"), "persona_diff 미검출");
  assert(kinds.has("meta_phrase"), "meta_phrase 미검출");
  console.log("[ok]   4 signal kinds all fired");

  const compacted = compactSignals(signals);
  assert(compacted.length <= signals.length, "compact didn't reduce or keep");
  const byIndex = new Set(compacted.map((s) => s.index));
  assert(byIndex.size === compacted.length, "compact left duplicates");
  console.log(`[ok]   compactSignals → ${compacted.length} unique indices`);
}

async function realSessionReport() {
  const dir = process.env.AGENT_MEMORY_DIR;
  if (!dir) {
    console.log("[info] AGENT_MEMORY_DIR unset — skipping real-session report");
    return;
  }
  const now = new Date();
  const y = String(now.getUTCFullYear());
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  const rawDir = join(dir, "raw", y, m, d);
  const files = await readdir(rawDir).catch(() => [] as string[]);
  if (files.length === 0) {
    console.log(`[info] no raw files under ${rawDir} — skipping report`);
    return;
  }
  const latest = files.sort().at(-1)!;
  const path = join(rawDir, latest);
  const raw = await readFile(path, "utf-8");
  const events: RawEvent[] = raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RawEvent);

  const signals = detectSignals(events);
  console.log(`\n[real] ${path} (${events.length} events) → ${signals.length} signals`);
  for (const s of signals) console.log(`  #${s.index}  ${s.reason}  sev=${s.severity.toFixed(2)}  ${s.detail}`);
  if (signals.length === 0) {
    console.log("  (no boundaries — expected for a focused single-task session)");
  }
}

async function main() {
  synthetic();
  await realSessionReport();
  console.log("\nsignals smoke passed.");
}

main().catch((e2) => {
  console.error(e2);
  process.exit(1);
});
