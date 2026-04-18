---
name: ask_advisor
description: "Ask a more capable advisor model (Opus) when you recognize you are stuck and need help. Use this when you have tried your own reasoning and it's not working — e.g. you keep picking wrong tools, you don't understand the problem structure, or you've hit a conceptual block. You must decompose the problem: `question` is the specific thing you need answered, `context_summary` is your first-person account of the current state (what the user asked, what you've done so far, what's unclear), and `what_tried` is optional — approaches you already attempted and why they failed. The response is a short (3-5 paragraph) text answer you then read and act on. Do NOT include any `@vault:<ref>` tokens or raw secrets in the input — advisors cannot resolve them and must never see sensitive values."
input_schema:
  type: object
  properties:
    question:
      type: string
      description: The specific question to ask the advisor. Must be concrete and answerable (e.g. "How should I decompose this multi-step analysis?", not "Help me").
    context_summary:
      type: string
      description: First-person summary of the current state — what the user asked, what you've tried, what's confusing. This is your chance to show the advisor the shape of your stuckness.
    what_tried:
      type: string
      description: Optional. Approaches already attempted and why they didn't work. Helps the advisor avoid suggesting the same path.
  required:
    - question
    - context_summary
---

# ask_advisor

Agent 가 자기 한계를 인지했을 때 더 큰 모델 (Opus) 에게 도움을 청하는 도구.

## 언제 쓰는가

- 같은 tool 을 반복 호출하는데 결과가 안 맞을 때
- user 의 질문이 이해는 되지만 접근 방법이 안 잡힐 때
- 여러 가능한 경로가 있는데 판단이 안 설 때

반대로, **쓰지 말아야 할 때**:

- 쉬운 산수/문법 수준 — 자기 추론으로 풀 수 있는 것
- user 에게 되물어봐야 할 것 (명확화 질문) — advisor 가 아니라 user 에게
- @vault:<ref> 참조가 들어간 문맥 — advisor 는 ref 해결 못 하고 민감 정보 유출 위험

## 입력 구조

질문과 맥락을 **분리해서** 넣어야 한다. 이 분리는 agent 가 자기 상태를 1인칭으로 언어화하게 만드는 의도적 강제.

- `question`: 답을 받고 싶은 구체 질문
- `context_summary`: "나는 지금 이런 상태다" — user 가 뭘 물었고, 내가 뭘 했고, 뭐가 막혔나
- `what_tried` (선택): 이미 시도한 접근 + 왜 실패했나

## 출력

Advisor 의 응답 텍스트 (3~5 문단). 에러 시 구조화된 `tool_execution_failed` 로 돌아옴 (advisor call limit 초과 / vault ref 포함 / 네트워크 실패 등).

## 제약

- 세션당 호출 상한: `ADVISOR_CALL_LIMIT` env (기본 무제한)
- 같은 (question, context_summary) 반복 호출: 기존 `RETRY_LIMIT` 에 따라 차단
- @vault: 포함 입력은 handler 에서 거부
