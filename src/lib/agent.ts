import { createHash } from "node:crypto";
import { getSkillTools, executeSkill } from "./skills/loader";
import { loadSoul, type SoulRequest } from "./souls/loader";
import { createSession, type Session } from "./session";
import { createLLMClient } from "./llm/client";
import { vault, makeVaultRef, resolveVaultRefs } from "./vault";
import {
  appendRaw,
  closeRaw,
  newMemorySessionId,
  setPersona as rawSetPersona,
} from "./memory/raw";
import type { Message, ContentBlock } from "./llm/types";
import type { AgentEvent, PendingToolCall } from "./types";

const MODEL_ID = process.env.LLM_MODEL ?? "claude-sonnet-4-5";

const client = createLLMClient();

export const REQUEST_CREDENTIAL_TOOL = "request_credential";

/** Max allowed identical (name, args) tool attempts within a single agent session. */
export const RETRY_LIMIT = Number(process.env.RETRY_LIMIT ?? 3);

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(",")}}`;
}

export function hashToolCall(name: string, args: unknown): string {
  return createHash("sha256")
    .update(`${name}\u0000${canonicalize(args)}`)
    .digest("hex")
    .slice(0, 16);
}

/**
 * Count how many times a (name, args) tool_use with the given hash has appeared
 * in prior assistant messages. session.messages already contains the current
 * assistant response when this is checked, so the returned count includes the
 * current attempt — e.g. the very first time a tool is used, count === 1.
 */
export function countPriorToolUses(messages: Message[], hash: string): number {
  let count = 0;
  for (const m of messages) {
    if (m.role !== "assistant" || typeof m.content === "string") continue;
    for (const block of m.content) {
      if (block.type === "tool_use" && hashToolCall(block.name, block.input) === hash) {
        count++;
      }
    }
  }
  return count;
}

/**
 * Walk the tool-args object and replace any `@vault:<key>` tokens inside string
 * leaves with their resolved values. The raw secret only ever exists within the
 * object returned from this helper — message history and agent events still
 * carry the original `@vault:<key>` reference, satisfying AC4.
 */
async function resolveToolArgsVaultRefs(sid: string, value: unknown): Promise<unknown> {
  if (typeof value === "string") {
    return value.includes("@vault:") ? await resolveVaultRefs(sid, value) : value;
  }
  if (Array.isArray(value)) {
    return Promise.all(value.map((v) => resolveToolArgsVaultRefs(sid, v)));
  }
  if (value && typeof value === "object") {
    const entries = await Promise.all(
      Object.entries(value as Record<string, unknown>).map(async ([k, v]) => [
        k,
        await resolveToolArgsVaultRefs(sid, v),
      ] as const),
    );
    return Object.fromEntries(entries);
  }
  return value;
}

async function* withRawCapture(
  memoryId: string,
  source: AsyncGenerator<AgentEvent>,
): AsyncGenerator<AgentEvent> {
  try {
    for await (const ev of source) {
      if (ev.type === "persona_resolved") {
        rawSetPersona(memoryId, ev.persona, ev.ref);
      }
      await appendRaw(memoryId, ev.type, ev);
      yield ev;
      if (ev.type === "done" || ev.type === "error") {
        await closeRaw(memoryId);
      }
    }
  } catch (e) {
    await closeRaw(memoryId);
    throw e;
  }
}

export async function* runAgent(
  userMessage: string,
  sid: string,
  personaReq: SoulRequest = {},
): AsyncGenerator<AgentEvent> {
  const memoryId = newMemorySessionId();
  await appendRaw(memoryId, "user_message", { content: userMessage, sid });
  yield* withRawCapture(memoryId, runAgentInner(userMessage, sid, personaReq, memoryId));
}

async function* runAgentInner(
  userMessage: string,
  sid: string,
  personaReq: SoulRequest,
  memoryId: string,
): AsyncGenerator<AgentEvent> {
  const soul = await loadSoul(personaReq);
  yield {
    type: "persona_resolved",
    persona: soul.resolvedPersona,
    ref: soul.resolvedRef,
  };
  const messages: Message[] = [{ role: "user", content: userMessage }];
  yield* agentLoop(messages, soul.systemPrompt, sid, memoryId);
}

export async function* resumeAgent(
  session: Session,
  approved: boolean,
  credentials?: Record<string, string>,
): AsyncGenerator<AgentEvent> {
  yield* withRawCapture(session.memoryId, resumeAgentInner(session, approved, credentials));
}

async function* resumeAgentInner(
  session: Session,
  approved: boolean,
  credentials?: Record<string, string>,
): AsyncGenerator<AgentEvent> {
  if (!approved) {
    const results: ContentBlock[] = session.pendingToolCalls.map((tc) => ({
      type: "tool_result" as const,
      tool_use_id: tc.toolUseId,
      content: "사용자가 이 도구의 실행을 거부했습니다.",
      is_error: true,
    }));
    session.messages.push({ role: "user", content: results });

    for (const tc of session.pendingToolCalls) {
      yield { type: "tool_rejected", name: tc.name };
    }
    session.pendingToolCalls = [];
    yield* agentLoop(session.messages, session.systemPrompt, session.sid, session.memoryId);
    return;
  }

  const results: ContentBlock[] = [];
  for (const tc of session.pendingToolCalls) {
    let output: string;
    let isError = false;

    if (tc.name === REQUEST_CREDENTIAL_TOOL) {
      const key = typeof (tc.args as { key?: unknown }).key === "string"
        ? ((tc.args as { key: string }).key)
        : undefined;
      const credential = credentials?.[tc.toolUseId];
      if (!key) {
        output = "request_credential: 'key' 인자가 누락되었습니다.";
        isError = true;
      } else if (typeof credential !== "string" || credential.length === 0) {
        output = "request_credential: 사용자 입력값이 제공되지 않았습니다.";
        isError = true;
      } else {
        await vault.put(session.sid, key, credential);
        output = makeVaultRef(key);
      }
    } else {
      const hash = hashToolCall(tc.name, tc.args);
      const attemptCount = countPriorToolUses(session.messages, hash);
      if (attemptCount > RETRY_LIMIT) {
        output = JSON.stringify({
          error: "retry_limit_exceeded",
          tool: tc.name,
          limit: RETRY_LIMIT,
          attempts: attemptCount,
          hint: "같은 인자로 반복 호출하고 있습니다. 입력을 바꾸거나 다른 도구/접근으로 전환하세요.",
        });
        isError = true;
      } else {
        const resolvedArgs = await resolveToolArgsVaultRefs(session.sid, tc.args);
        output = await executeSkill(tc.name, resolvedArgs);
      }
    }

    yield { type: "tool_result", name: tc.name, output };
    results.push({
      type: "tool_result",
      tool_use_id: tc.toolUseId,
      content: output,
      ...(isError ? { is_error: true } : {}),
    });
  }
  session.messages.push({ role: "user", content: results });
  session.pendingToolCalls = [];
  yield* agentLoop(session.messages, session.systemPrompt, session.sid, session.memoryId);
}

async function* agentLoop(
  messages: Message[],
  systemPrompt: string,
  sid: string,
  memoryId: string,
): AsyncGenerator<AgentEvent> {
  while (true) {
    const response = await client.chat({
      model: MODEL_ID,
      max_tokens: 4096,
      system: systemPrompt,
      tools: getSkillTools(),
      messages,
    });

    messages.push({ role: "assistant", content: response.content });

    for (const block of response.content) {
      if (block.type === "text") {
        yield { type: "message", content: block.text };
      }
    }

    const toolUseBlocks = response.content.filter(
      (b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use",
    );

    if (toolUseBlocks.length > 0) {
      for (const block of toolUseBlocks) {
        yield {
          type: "tool_call",
          name: block.name,
          args: block.input as Record<string, unknown>,
        };
      }

      const pendingToolCalls: PendingToolCall[] = toolUseBlocks.map((block) => ({
        toolUseId: block.id,
        name: block.name,
        args: block.input as Record<string, unknown>,
      }));

      const session = createSession(messages, systemPrompt, sid, memoryId);
      session.pendingToolCalls = pendingToolCalls;
      session.lastAssistantContent = response.content;

      yield {
        type: "tool_approval_request",
        sessionId: session.id,
        toolCalls: pendingToolCalls,
      };
      return;
    }

    if (response.stop_reason !== "tool_use") {
      yield { type: "done" };
      break;
    }
  }
}