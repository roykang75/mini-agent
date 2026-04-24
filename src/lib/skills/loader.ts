import type { ToolDef } from "../llm/types";
import { tools as generatedTools, executors as generatedExecutors } from "./registry.generated";

/**
 * Built-in tool name for HIL user-input requests (ADR-???). skill registry 를
 * 거치지 않고 `AgentInstance` 내부에서 특별 분기된다. LLM 가시성을 위해 schema
 * 만 `getSkillTools()` 결과에 append 한다.
 */
export const ASK_USER_TOOL = "ask_user";

export const ASK_USER_TOOL_DEF: ToolDef = {
  name: ASK_USER_TOOL,
  description:
    "사용자에게 되묻기. 기본은 '스스로 해결' — 파일·깃·과거 메시지·관례로 확인 가능한 정보는 되묻지 말 것. " +
    "호출 조건 세 가지 모두 충족 시에만: " +
    "(1) context 로 좁혀지지 않는 실제 모호성, " +
    "(2) 오판 시 롤백 비용 > 되묻는 비용, " +
    "(3) 사용자의 한 마디 답변으로 결정이 수렴. " +
    "같은 턴에 다른 tool 과 섞어 호출 금지. " +
    "파괴적 동작의 실행 가드로 쓰지 말 것 (그건 approval flow 소관).",
  input_schema: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        enum: ["choose", "confirm"],
        description:
          "'choose' 는 options 에서 하나(또는 여럿) 선택. 'confirm' 은 내 의도 해석이 맞는지 yes/no.",
      },
      question: {
        type: "string",
        description:
          "사용자에게 보여줄 질문. confirm 은 상태 서술 + '— 맞아?' 형태 권장.",
      },
      options: {
        type: "array",
        description:
          "kind='choose' 일 때 필수. 2~5개, 상호배타적, id 는 의미 있는 slug.",
        items: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "의미 있는 slug (예: 'overwrite', 'skip', 'rename').",
            },
            label: {
              type: "string",
              description: "40자 이하, 동사형 권장 ('덮어쓰기', '건너뛰기').",
            },
            description: {
              type: "string",
              description: "선택적. 결과·부작용을 한 줄로.",
            },
          },
          required: ["id", "label"],
        },
      },
      multi: {
        type: "boolean",
        description:
          "kind='choose' 전용. true 면 다중 선택(체크박스), 생략/false 는 단일 선택(라디오).",
      },
    },
    required: ["kind", "question"],
  },
};

export function getSkillTools(): readonly ToolDef[] {
  return [...generatedTools, ASK_USER_TOOL_DEF];
}

export async function executeSkill(name: string, args: unknown): Promise<string> {
  const fn = generatedExecutors[name];
  if (!fn) throw new Error(`Unknown skill: ${name}`);
  return fn(args);
}