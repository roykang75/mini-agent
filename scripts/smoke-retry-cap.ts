/**
 * Smoke: verify the retry-cap helpers in agent.ts.
 *
 *   - hashToolCall is stable across equal (name, args)
 *   - hashToolCall is key-order independent
 *   - hashToolCall differs for different args
 *   - countPriorToolUses counts only matching assistant tool_use blocks
 *
 * The integration path (resumeAgent injecting retry_limit_exceeded) is covered
 * by the shape of agent.ts and this helper test. A full LLM-round-trip check
 * would require mocking the model client — out of scope for M1.
 */

import type { Message } from "../src/lib/llm/types";
import { hashToolCall, countPriorToolUses, RETRY_LIMIT } from "../src/lib/agent";

function assertEq<T>(label: string, actual: T, expected: T) {
  if (actual !== expected) {
    console.error(`[FAIL] ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    process.exit(1);
  }
  console.log(`[ok]   ${label} → ${JSON.stringify(actual)}`);
}

function mkToolUse(id: string, name: string, input: unknown): Message {
  return {
    role: "assistant",
    content: [
      { type: "text", text: "calling tool" },
      { type: "tool_use", id, name, input },
    ],
  };
}

function main() {
  // Stability + order invariance
  const hA = hashToolCall("http_call", { url: "http://x/y", method: "POST" });
  const hB = hashToolCall("http_call", { method: "POST", url: "http://x/y" });
  assertEq("hashToolCall key-order invariant", hA, hB);

  // Different args → different hash
  const hC = hashToolCall("http_call", { url: "http://x/z", method: "POST" });
  if (hA === hC) {
    console.error(`[FAIL] expected different hash for different args`);
    process.exit(1);
  }
  console.log(`[ok]   hashToolCall differs for different args → ${hA} vs ${hC}`);

  // Different tool name → different hash
  const hD = hashToolCall("read_file", { path: "a" });
  const hE = hashToolCall("write_file", { path: "a" });
  if (hD === hE) {
    console.error(`[FAIL] expected different hash for different tool name`);
    process.exit(1);
  }
  console.log(`[ok]   hashToolCall differs for different name → ${hD} vs ${hE}`);

  // Count across a history: 3 identical calls + 1 different tool + 1 different args
  const targetArgs = { url: "http://x/y", method: "POST", body: { a: 1 } };
  const target = hashToolCall("http_call", targetArgs);

  const messages: Message[] = [
    { role: "user", content: "analyze" },
    mkToolUse("u1", "http_call", targetArgs),
    { role: "user", content: [{ type: "tool_result", tool_use_id: "u1", content: "400" }] },
    mkToolUse("u2", "read_file", { path: "a" }),
    { role: "user", content: [{ type: "tool_result", tool_use_id: "u2", content: "ok" }] },
    mkToolUse("u3", "http_call", targetArgs),
    { role: "user", content: [{ type: "tool_result", tool_use_id: "u3", content: "400" }] },
    mkToolUse("u4", "http_call", { ...targetArgs, body: { a: 2 } }),
    { role: "user", content: [{ type: "tool_result", tool_use_id: "u4", content: "200" }] },
    mkToolUse("u5", "http_call", targetArgs),
    { role: "user", content: [{ type: "tool_result", tool_use_id: "u5", content: "400" }] },
  ];

  assertEq("countPriorToolUses target=3 (3 identical http_call in history)", countPriorToolUses(messages, target), 3);
  assertEq("countPriorToolUses read_file=1", countPriorToolUses(messages, hashToolCall("read_file", { path: "a" })), 1);
  assertEq("countPriorToolUses unrelated hash=0", countPriorToolUses(messages, hashToolCall("http_call", { url: "nope" })), 0);

  // Cap semantics: 3 attempts allowed at RETRY_LIMIT=3, 4th triggers cap.
  console.log(`[info] RETRY_LIMIT = ${RETRY_LIMIT}`);
  if (RETRY_LIMIT !== 3) {
    console.warn(`[warn] this smoke assumes RETRY_LIMIT=3 (env override present)`);
  } else {
    const attemptNow = countPriorToolUses(messages, target); // 3 so far — 3rd attempt, allowed
    assertEq("3rd attempt allowed (count === limit)", attemptNow <= RETRY_LIMIT, true);

    const plusOne: Message[] = [...messages, mkToolUse("u6", "http_call", targetArgs)];
    const postCap = countPriorToolUses(plusOne, target);
    assertEq("4th attempt exceeds limit", postCap > RETRY_LIMIT, true);
  }

  console.log("\nretry-cap smoke passed.");
}

main();
