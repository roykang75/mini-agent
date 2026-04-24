# ask_user Tool — 설계 문서

- 작성일: 2026-04-24
- 상태: 설계 확정, 구현 미착수
- 작성 맥락: mini-agent 의 HIL(Human-in-the-Loop) 인터랙션을 "승인/거부" 한 축에서
  "모호성 해소(선택/확인)" 축까지 확장할 필요가 생김. 현재 `tool_approval_request`
  단일 블록에 조건 분기를 계속 추가하면 `ToolApprovalBlock` 내부가 금방 지저분해져서
  처음부터 **보안 게이트 vs UX 게이트** 를 분리하는 방향으로 설계함.

---

## 1. 배경

현재 mini-agent HIL 은 **tool 실행 전 "위험 동작 게이트"** 하나뿐:

- `src/lib/agent/instance.ts` 의 `agentLoop()` 가 `tool_use` 블록을 감지하면
  `this.pending` 에 상태를 저장하고 `tool_approval_request` 이벤트로 스트림을 끊음
- UI 는 `ToolApprovalBlock` 에서 승인/거부 + (필요 시) `request_credential` 패스워드
  입력까지 한 블록 안에서 분기

그런데 에이전트가 사용자에게 **"여러 옵션 중 하나를 골라줘"** 혹은 **"이 설정이 맞아?"**
같이 되묻는 경우가 늘어나면, 이 블록에 조건 분기를 계속 박아넣게 됨.
이건 의미론적으로도 다른 일 — 보안 gate 가 아니라 **모호성 해소** 라서, 같은 경로에
두면 semantics 가 섞임.

## 2. 결정 사항

### 2.1 `ask_user` 라는 새 built-in tool 을 도입한다

LLM 이 사용자에게 되묻고 싶을 때 호출하는 단일 tool.
이름/동작은 Claude Code 의 `AskUserQuestion` 패턴을 참고.

### 2.2 단일 tool + `kind` discriminator

`ask_user_choose`, `ask_user_confirm` 으로 나누지 않고 하나의 tool 에 `kind` 필드로 분기.

- LLM discoverability 관점에서 tool 1 개가 유리
- 스키마 확장 (form, order, multi 등) 시 tool 목록이 안 늘어남

### 2.3 approval 인프라와 **완전히 분리**

보안 게이트(`tool_approval_request`) 와 UX 게이트(`user_input_request`) 를 별도
이벤트·상태 필드·엔드포인트·UI 블록으로 둠.

| 구분            | tool_approval_request              | user_input_request (신규)          |
| --------------- | ---------------------------------- | ---------------------------------- |
| 목적            | 위험 동작 게이트                   | 모호성 해소                        |
| Pending 상태    | `this.pending`                     | `this.pendingUserInput` (별도 필드) |
| 이벤트          | `tool_approval_request`            | `user_input_request`               |
| 엔드포인트      | `POST /chat/approve`               | `POST /chat/answer`                |
| UI 블록         | `tool-approval-block.tsx`          | `user-input-block.tsx`             |

`agentLoop` 에서 `tool_use` 감지 시 `ask_user` 인지 **먼저** 체크 → 맞으면
approval 경로를 스킵하고 `user_input_request` 를 yield 한 뒤 return.

### 2.4 실행 경로는 **built-in tool** (skill registry 미사용)

`REQUEST_CREDENTIAL_TOOL` 이 `executeSkill` 경로를 타지 않고 `runResume` 안에서
특별 분기되는 패턴과 동일하게 처리.
`ask_user` 는 "실행할 외부 동작이 없는 사용자 입력 대기" 이므로 skill registry 에 둘
이유가 없고, agent instance 가 직접 가로채는 built-in 쪽이 분기가 깔끔함.

### 2.5 `order` (순서 정하기) 는 첫 버전에 포함하지 않는다 (YAGNI)

현재 구체 유스케이스가 없음. `choose` + `confirm` 으로 출시하고 실제 쓰임새가
생기면 스키마에 추가. kind discriminator 구조라 나중 확장 비용이 낮음.

## 3. Tool 스키마

```ts
ask_user({
  kind: "choose" | "confirm",
  question: string,

  // kind === "choose"
  options?: { id: string; label: string; description?: string }[],
  multi?: boolean, // true 면 체크박스, false 면 라디오 (기본값 false)

  // kind === "confirm"
  // 추가 필드 없음 — question 하나로 OK/Cancel 을 물음
})
```

향후 확장 여지 (지금 구현 X):
- `kind: "order"` + `items: { id, label }[]`
- `kind: "form"` + `fields: [...]`

## 4. 응답 형식 (`/chat/answer` 요청 body)

```ts
// kind === "choose" (single)
{ sessionId, answer: { kind: "choose", selected: "opt-2" } }

// kind === "choose" (multi)
{ sessionId, answer: { kind: "choose", selected: ["opt-1", "opt-3"] } }

// kind === "confirm"
{ sessionId, answer: { kind: "confirm", confirmed: true } }
```

서버는 이 `answer` 를 `ask_user` 의 `tool_result` 로 변환해 agent messages 에 push
하고 `agentLoop` 를 재개. LLM 입장에선 평범한 tool 리턴.

## 5. 프로토콜 흐름

```
Agent Loop → tool_use 감지
    │
    ├─ tool.name === "ask_user"?
    │       │
    │       └─ YES → user_input_request 이벤트 yield → return (approval 스킵)
    │                            │
    │                            ▼
    │                  UI: user-input-block 렌더
    │                            │
    │                            ▼
    │                  사용자가 선택/확인
    │                            │
    │                            ▼
    │              POST /chat/answer { sessionId, answer }
    │                            │
    │                            ▼
    │              resumeAfterUserInput(sessionId, answer)
    │                  = answer → tool_result → messages push
    │                  → agentLoop 재진입
    │
    └─ NO → 기존 tool_approval_request 흐름
```

세션 격리는 기존과 동일하게 **sid 쿠키** 로 AgentInstance 를 찾고,
재생 안전성은 **sessionId 매칭** (`pendingUserInput.sessionId === body.sessionId`)
으로 보장.

## 6. 구현 범위 (파일 단위)

### agent

- `src/lib/agent/instance.ts`
  - `pendingUserInput: { sessionId, toolUseId, memoryId, lastAssistantContent } | null` 필드 추가
  - `ASK_USER_TOOL = "ask_user"` 상수 export
  - `agentLoop` 에서 `tool_use` 중 `ask_user` 가 있으면 해당 블록 기준으로 분기
    (같은 턴에 `ask_user` + 다른 tool 을 LLM 이 섞어 부르는 경우는 일단 금지 — 시스템
    프롬프트에 명시하고, 런타임에서도 감지되면 에러 tool_result 로 내려서 LLM 재시도 유도)
  - `resumeAfterUserInput(sessionId, answer): AsyncGenerator<AgentEvent>` 추가
  - 기존 `resumeAfterApproval` 과 동일한 `persist()` finally 패턴 유지
  - `__resetForTest()` / `dispose()` 에 `pendingUserInput` 도 초기화
- `src/lib/agent/store.ts`
  - `SerializedAgentState` 에 `pendingUserInput` 직렬화 필드 추가
- `src/lib/types.ts`
  - `AgentEvent` 에 `user_input_request` 추가
    ```ts
    | { type: "user_input_request"; sessionId: string; toolUseId: string;
        kind: "choose" | "confirm"; question: string;
        options?: { id: string; label: string; description?: string }[];
        multi?: boolean }
    ```
  - `ChatMessage` role 에 `"user_input"` 추가
  - 필요 시 `UserInputAnswer` union 타입 정의

### server

- `src/app/chat/answer/route.ts` — 신규
  - body: `{ sessionId, answer }`
  - sid 쿠키 → `summonAgent(sid)` → `agent.pendingUserInput?.sessionId === sessionId`
    검증 (mismatch 면 404) → `agent.resumeAfterUserInput(sessionId, answer)` 를
    SSE 로 스트리밍

### client

- `src/lib/sse-client.ts` — `streamAnswer(sessionId, answer, signal)` 추가
- `src/components/chat/user-input-block.tsx` — 신규
  - `kind === "choose"` + `multi=false` → 라디오
  - `kind === "choose"` + `multi=true` → 체크박스 + "전송" 버튼
  - `kind === "confirm"` → OK / Cancel 버튼
  - 전송 후 `disabled` 상태로 잠금 (재클릭 방지)
- `src/components/chat/chat-container.tsx`
  - `user_input_request` 이벤트를 받아 `role: "user_input"` 메시지 push
  - `handleAnswer(sessionId, answer)` 추가 → `streamAnswer` 호출
  - 응답 도착 시 해당 블록 비활성화 (`tool_approval` 과 동일 패턴)
- `src/components/chat/message-list.tsx` — `user_input` role 분기 추가

## 7. 안전장치 / 엣지 케이스

- **같은 턴에 `ask_user` + 다른 tool 혼합 호출**: 런타임에서 거절하는 tool_result 로
  내려보내 LLM 이 `ask_user` 만 단독 호출하도록 유도. 시스템 프롬프트에도 명시.
- **`ask_user` 가 또 다른 `ask_user` 를 물고 오는 루프**: 기존 `RETRY_LIMIT` 은
  `hash(name, args)` 기반이라 같은 질문 반복은 차단됨. 다른 질문이면 허용 (정상 흐름).
- **세션 타임아웃**: 현재 in-memory store TTL 에 의존. 사용자가 응답 안 하고 떠나면
  자연 소멸. 명시적 `/cancel` 은 후속 과제.
- **options[].id 중복**: tool 쪽에서 LLM 이 잘못 만들 수 있으므로 서버 검증.

## 8. 시스템 프롬프트 가이드

`ask_user` 는 LLM 관점에서 "판단 책임을 낮은 비용으로 사용자에게 넘길 수 있는"
도구라 그대로 두면 되묻기 안티패턴으로 기운다. 호출 기준·금지 조건·options 규칙을
시스템 프롬프트에 명시해서 기본값을 **"자력 해결"** 쪽으로 편향시켜야 한다.

### 8.1 호출 원칙 (세 기준을 모두 충족할 때만)

1. **모호성이 실재함** — context / 파일 / 과거 메시지 / 관례로 좁혀지지 않고,
   합리적 해석이 둘 이상 공존.
2. **오판 비용 > 되묻는 비용** — 한쪽을 골라 진행했을 때의 롤백 비용이 한 번의
   round-trip 보다 큼.
3. **되묻기로 결정이 수렴함** — 사용자의 한 마디 답변으로 다음 행동이 확정.
   답을 받아도 또 같은 축에서 되물어야 한다면 `ask_user` 가 아니라 스펙 대화가
   필요한 국면.

### 8.2 Do / Don't

| Do                                                             | Don't                                                                 |
| -------------------------------------------------------------- | --------------------------------------------------------------------- |
| 여러 유효 해석이 공존하고 context 로 좁혀지지 않을 때          | 파일·깃·과거 메시지에서 확인 가능한 정보를 되묻기                     |
| 비가역 결정 (삭제 대상 선택, 스키마 변경 등) 의 **의도** 확인  | 파괴적 동작의 실행 가드 — 그건 `tool_approval_request` 영역           |
| 관례가 없거나 충돌해서 기본값을 못 고를 때                     | 기본값이 명백한데 취향 확인차 되묻기                                  |
| 관련 질문을 `multi=true` 또는 한 개 `choose` 로 묶어서         | 같은 턴에 `ask_user` 를 여러 번 호출                                  |
| 한 번의 질문으로 결정이 수렴할 때                              | 매 tool 호출마다 "이렇게 할까요?" 를 끼워넣기 (ping-pong)             |

### 8.3 options 구성 체크리스트

- **개수**: 2~5개. 1개면 `confirm` 으로 전환, 6개 이상이면 범주를 다시 묶기.
- **상호배타성**: `multi=false` 일 때 항목 하나 선택으로 결정이 끝나야 함.
  의미가 겹치는 옵션 금지.
- **id**: 의미 있는 slug (`overwrite`, `skip`, `rename`). `opt-1`, `a` 같은
  익명 id 금지.
- **label**: 40자 이하, 동사형 권장 ("덮어쓰기", "건너뛰기").
- **description**: 필요한 경우에만, 한 줄로 결과·부작용만. label 반복 금지.
- **"기타" 항목**: 원칙적으로 넣지 않음. 진짜 열린 선택이 필요한 상황이면
  `ask_user` 의 범위를 벗어난 것이므로 평문 질문으로 다루는 게 맞음.

### 8.4 confirm 사용 규칙

- **용도**: "내가 X 로 이해했는데 맞아?" 형태로 **의도 해석의 일치 여부**만 묻기.
- **금지**: 파괴적 tool 의 실행 가드로 쓰지 않음. `tool_approval_request` 경로와
  역할이 겹치면 approval flow 의 semantics 가 약해짐.
- **질문 형식**: 상태 서술 + "— 맞아?" / "계속할까?". Yes/No 각각의 다음 행동이
  분명해야 함.

### 8.5 운영 제약

- **혼합 호출 금지**: 같은 턴에 `ask_user` + 다른 tool 조합 금지. 런타임에서도
  거절 tool_result 로 막히지만, 프롬프트 레벨에서도 명시.
- **반복 질문 금지**: 동일·유사 질문 연속 호출 금지. `RETRY_LIMIT` 이 hash 로
  차단하지만, 우회 시도하지 말 것.
- **빈도 상한 (권고)**: 단일 사용자 요청 처리 중 `ask_user` 2회 이하를 목표.
  3회를 넘으면 요청이 과도하게 넓거나 에이전트가 결정을 회피하고 있다는 신호.

### 8.6 시스템 프롬프트 초안

실제 에이전트 프롬프트에 주입할 축약본:

```
당신은 `ask_user` tool 로 사용자에게 되물을 수 있지만, 기본값은 "스스로 해결"이다.
되묻기 전에 먼저 파일·깃·과거 메시지·관례를 확인한다.

[호출 조건 — 세 기준 모두 충족해야 함]
- context 로 좁혀지지 않는 실제 모호성
- 오판 시 롤백 비용 > 되묻는 비용
- 사용자의 한 마디 답변으로 결정이 수렴

[금지]
- 파일/깃/메시지에서 확인 가능한 정보 되묻기
- 파괴적 동작의 실행 확인 (approval flow 소관)
- 명백한 기본값을 취향 확인차 되묻기
- 같은 턴에 `ask_user` + 다른 tool 혼합 호출
- 동일 요청 처리 중 3회 이상 호출

[choose 옵션]
- 2~5개, 상호배타, id 는 의미 있는 slug
- label 40자 이하 동사형
- description 은 결과·부작용 한 줄만

[confirm]
- "X 로 이해했는데 맞아?" 형태, 의도 해석만 확인
- 파괴적 동작 가드로 쓰지 않음
```

## 9. 후속 / 열린 질문

- **`order` / `form` kind 추가 시점**: 실제 요구가 생기면 tool 스키마에 필드 추가 +
  UI 블록 케이스 추가만으로 확장 가능 (이벤트/엔드포인트는 공용). 보류.
- **~~audit log~~**: ✅ **이미 작동 중** — `withRawCapture` 가 모든 `AgentEvent`
  (text_delta 제외) 를 memory raw 에 append 하므로 `user_input_request` 이벤트와
  사용자 응답 (`tool_result` name=ask_user) 이 동일 memoryId 의 jsonl 에 쌍으로
  기록된다. 별도 구현 불필요. trajectory 분석 시 `event_type==user_input_request`
  → 직후 `event_type==tool_result && payload.name=="ask_user"` 로 매칭.
- **~~goal-runner 연계~~**: ✅ **처리됨** — `agent-runner.ts` 의 event loop 가
  `user_input_request` 를 HIL 로 승격 (`hil = { reason: "agent_asked_user (<kind>)",
  proposed_action: "<question> options=[...]" }`). Goal 은 paused 로 전이, Roy 가
  goal.md 를 clarify 해 재실행하면 다음 iteration 의 `agent.receive()` 가
  pendingUserInput 을 auto-cancel 하므로 상태 leak 없음.
