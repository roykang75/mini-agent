import { getSkillTools, executeSkill } from "./skills/loader";
import { loadSoul, type SoulRequest } from "./souls/loader";
import { createSession, type Session } from "./session";
import { createLLMClient } from "./llm/client";
import type { Message, ContentBlock } from "./llm/types";
import type { AgentEvent, PendingToolCall } from "./types";

const MODEL_ID = process.env.LLM_MODEL ?? "claude-sonnet-4-5";

const client = createLLMClient();

export async function* runAgent(
  userMessage: string,
  personaReq: SoulRequest = {},
): AsyncGenerator<AgentEvent> {
  const soul = await loadSoul(personaReq);
  yield {
    type: "persona_resolved",
    persona: soul.resolvedPersona,
    ref: soul.resolvedRef,
  };
  const messages: Message[] = [{ role: "user", content: userMessage }];
  yield* agentLoop(messages, soul.systemPrompt);
}

export async function* resumeAgent(
  session: Session,
  approved: boolean,
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
    yield* agentLoop(session.messages, session.systemPrompt);
    return;
  }

  const results: ContentBlock[] = [];
  for (const tc of session.pendingToolCalls) {
    const output = await executeSkill(tc.name, tc.args);
    yield { type: "tool_result", name: tc.name, output };
    results.push({
      type: "tool_result",
      tool_use_id: tc.toolUseId,
      content: output,
    });
  }
  session.messages.push({ role: "user", content: results });
  session.pendingToolCalls = [];
  yield* agentLoop(session.messages, session.systemPrompt);
}

async function* agentLoop(
  messages: Message[],
  systemPrompt: string,
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

      const session = createSession(messages, systemPrompt);
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