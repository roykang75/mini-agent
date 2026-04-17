import { getSkillTools, executeSkill } from "./skills/loader";
import { createSession, type Session } from "./session";
import { createLLMClient } from "./llm/client";
import type { Message, ContentBlock } from "./llm/types";
import type { AgentEvent, PendingToolCall } from "./types";

const MODEL_ID = process.env.LLM_MODEL ?? "claude-sonnet-4-5";

const client = createLLMClient();

const SYSTEM_PROMPT = `당신은 사용자의 파일 시스템과 쉘에 접근할 수 있는 AI Agent입니다.
사용 가능한 도구: read_file, write_file, run_command.
사용자의 요청을 수행하기 위해 도구를 적극적으로 활용하세요.
응답은 한국어로 해주세요.`;

export async function* runAgent(userMessage: string): AsyncGenerator<AgentEvent> {
  const messages: Message[] = [{ role: "user", content: userMessage }];
  yield* agentLoop(messages);
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
    yield* agentLoop(session.messages);
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
  yield* agentLoop(session.messages);
}

async function* agentLoop(messages: Message[]): AsyncGenerator<AgentEvent> {
  while (true) {
    const response = await client.chat({
      model: MODEL_ID,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
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

      const session = createSession(messages);
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