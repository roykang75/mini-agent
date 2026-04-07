import Anthropic from "@anthropic-ai/sdk";
import { tools, executeTool } from "./tools";
import { createSession, type Session } from "./session";
import type { AgentEvent, PendingToolCall } from "./types";

const client = new Anthropic();

const SYSTEM_PROMPT = `당신은 사용자의 파일 시스템과 쉘에 접근할 수 있는 AI Agent입니다.
사용 가능한 도구: read_file, write_file, run_command.
사용자의 요청을 수행하기 위해 도구를 적극적으로 활용하세요.
응답은 한국어로 해주세요.`;

/**
 * 새 대화 시작: LLM 호출 → 툴 승인 요청 또는 완료
 */
export async function* runAgent(userMessage: string): AsyncGenerator<AgentEvent> {
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userMessage },
  ];

  yield* agentLoop(messages);
}

/**
 * 승인 후 재개: 툴 실행 → LLM 재호출 → 반복
 */
export async function* resumeAgent(session: Session, approved: boolean): AsyncGenerator<AgentEvent> {
  if (!approved) {
    // 거부: 각 pending tool에 대해 거부 결과를 메시지에 추가
    const toolResults: Anthropic.ToolResultBlockParam[] = session.pendingToolCalls.map((tc) => ({
      type: "tool_result" as const,
      tool_use_id: tc.toolUseId,
      content: "사용자가 이 도구의 실행을 거부했습니다.",
      is_error: true,
    }));

    session.messages.push({ role: "user", content: toolResults });

    for (const tc of session.pendingToolCalls) {
      yield { type: "tool_rejected", name: tc.name };
    }

    session.pendingToolCalls = [];

    // 거부 후 LLM에게 알려서 대안 응답 생성
    yield* agentLoop(session.messages);
    return;
  }

  // 승인: 각 pending tool 실행
  const toolResults: Anthropic.ToolResultBlockParam[] = [];

  for (const tc of session.pendingToolCalls) {
    const output = await executeTool(tc.name, tc.args);
    yield { type: "tool_result", name: tc.name, output };

    toolResults.push({
      type: "tool_result" as const,
      tool_use_id: tc.toolUseId,
      content: output,
    });
  }

  session.messages.push({ role: "user", content: toolResults });
  session.pendingToolCalls = [];

  // 툴 결과를 LLM에 전달하고 루프 계속
  yield* agentLoop(session.messages);
}

/**
 * Agent 핵심 루프: LLM 호출 → 텍스트 출력 / 툴 승인 요청
 */
async function* agentLoop(messages: Anthropic.MessageParam[]): AsyncGenerator<AgentEvent> {
  while (true) {
    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools,
      messages,
    });

    messages.push({ role: "assistant", content: response.content });

    // 텍스트 블록 먼저 출력
    for (const block of response.content) {
      if (block.type === "text") {
        yield { type: "message", content: block.text };
      }
    }

    // 툴 호출이 있는지 확인
    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    if (toolUseBlocks.length > 0) {
      // 툴 호출 이벤트 발행
      for (const block of toolUseBlocks) {
        yield {
          type: "tool_call",
          name: block.name,
          args: block.input as Record<string, unknown>,
        };
      }

      // 세션 생성 후 승인 요청
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

      // 승인을 기다려야 하므로 여기서 중단
      return;
    }

    // 종료 조건
    if (response.stop_reason === "end_turn" || response.stop_reason !== "tool_use") {
      yield { type: "done" };
      break;
    }
  }
}
