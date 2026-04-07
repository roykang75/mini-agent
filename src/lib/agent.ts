import Anthropic from "@anthropic-ai/sdk";
import { tools, executeTool } from "./tools";
import type { AgentEvent } from "./types";

const client = new Anthropic();

const SYSTEM_PROMPT = `당신은 사용자의 파일 시스템과 쉘에 접근할 수 있는 AI Agent입니다.
사용 가능한 도구: read_file, write_file, run_command.
사용자의 요청을 수행하기 위해 도구를 적극적으로 활용하세요.
응답은 한국어로 해주세요.`;

export async function* runAgent(userMessage: string): AsyncGenerator<AgentEvent> {
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userMessage },
  ];

  while (true) {
    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools,
      messages,
    });

    // assistant 응답을 메시지 히스토리에 추가
    messages.push({ role: "assistant", content: response.content });

    // content blocks 순회
    for (const block of response.content) {
      if (block.type === "text") {
        yield { type: "message", content: block.text };
      }

      if (block.type === "tool_use") {
        yield {
          type: "tool_call",
          name: block.name,
          args: block.input as Record<string, unknown>,
        };

        // 툴 실행
        const output = await executeTool(block.name, block.input);
        yield { type: "tool_result", name: block.name, output };

        // 툴 결과를 메시지 히스토리에 추가
        messages.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: block.id,
              content: output,
            },
          ],
        });
      }
    }

    // 종료 조건: end_turn이면 완료
    if (response.stop_reason === "end_turn") {
      yield { type: "done" };
      break;
    }

    // tool_use가 아니면 종료
    if (response.stop_reason !== "tool_use") {
      yield { type: "done" };
      break;
    }
  }
}
