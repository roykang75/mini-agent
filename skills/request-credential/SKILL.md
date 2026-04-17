---
name: request_credential
description: "Request a secret value (token, API key, password) from the user via a human-in-the-loop prompt. Returns a vault reference of the form '@vault:<key>' that can be passed to other tools. The raw value is stored only in the server vault, never in the message history."
input_schema:
  type: object
  properties:
    key:
      type: string
      description: Short snake_case identifier under which the secret is stored in the vault (e.g. "cia_token").
    description:
      type: string
      description: Human-readable explanation shown to the user so they know what to enter (e.g. "CIA API 토큰").
  required:
    - key
    - description
---

# request_credential

에이전트가 외부 호출에 필요한 비밀값을 가지고 있지 않을 때 사용자에게 값을 요청한다.

동작:

1. 에이전트가 이 도구를 호출하면 UI 에서 **password 입력 프롬프트** 가 뜬다.
2. 사용자가 값을 입력하면 서버 vault 에 `sid + key` 로 저장된다.
3. tool_result 로 `@vault:<key>` 참조 문자열만 에이전트에게 돌려준다.

이후 에이전트는 `http-call` 등 다른 도구에 `@vault:<key>` 참조만 넘긴다. 실제 값 치환은 handler 내부에서만 일어나 LLM 에 원문이 노출되지 않는다.
