# Chat UI 개발 가이드

## 개요

Agent API 서버(`POST /chat`)와 통신하는 Chat UI의 기술 구현 가이드입니다.
SSE 스트리밍 수신, 이벤트 파싱, 메시지 렌더링, 입력 처리를 다룹니다.

---

## 아키텍처

```
브라우저 (Chat UI)                    API Server
    │                                     │
    │  POST /chat                         │
    │  { "message": "..." }               │
    │ ──────────────────────────────────► │
    │                                     │
    │  Response: ReadableStream (SSE)     │
    │ ◄─ data: {"type":"tool_call",...}   │
    │ ◄─ data: {"type":"tool_result",...} │
    │ ◄─ data: {"type":"message",...}     │
    │ ◄─ data: {"type":"done"}            │
```

- **요청**: `fetch`로 `POST /chat` 호출
- **응답**: SSE 형식의 스트리밍 응답을 `ReadableStream`으로 수신
- **렌더링**: 수신된 이벤트 타입에 따라 메시지 영역에 추가

---

## SSE 이벤트 타입

서버에서 수신하는 이벤트 구조:

```typescript
type AgentEvent =
  | { type: "thinking";     content: string }
  | { type: "tool_call";    name: string; args: Record<string, unknown> }
  | { type: "tool_result";  name: string; output: string }
  | { type: "message";      content: string }
  | { type: "done" }
  | { type: "error";        message: string }
```

각 이벤트의 역할:

| 이벤트 | 설명 | 렌더링 방식 |
|--------|------|-------------|
| `thinking` | LLM의 사고 과정 | 접을 수 있는 블록 |
| `tool_call` | 툴 호출 요청 | 툴 이름 + 인자 표시 |
| `tool_result` | 툴 실행 결과 | 결과 텍스트 (스크롤 가능) |
| `message` | LLM의 최종 응답 | 채팅 메시지 |
| `done` | 응답 완료 신호 | 입력 활성화 |
| `error` | 오류 발생 | 오류 메시지 표시 |

---

## 핵심 구현

### 1. SSE 스트리밍 수신

`EventSource`는 `GET`만 지원하므로, `fetch` + `ReadableStream`으로 `POST` 기반 SSE를 처리합니다.

```typescript
async function sendMessage(message: string) {
  const res = await fetch("/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop(); // 불완전한 마지막 줄은 버퍼에 유지

    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const json = line.slice("data:".length).trim();
      if (!json) continue;

      const event = JSON.parse(json);
      handleEvent(event);
    }
  }
}
```

**주의사항:**
- `decoder.decode(value, { stream: true })` — 멀티바이트 문자(한글 등)가 청크 경계에서 잘리는 것을 방지
- `lines.pop()` — SSE 데이터가 여러 청크에 걸쳐 올 수 있으므로 불완전한 줄은 다음 청크와 합침
- `event:` 라인은 무시하고 `data:` 라인만 파싱 (데이터에 `type` 필드가 이미 포함)

### 2. 이벤트 처리

```typescript
let currentAssistantMessage: HTMLElement | null = null;

function handleEvent(event: AgentEvent) {
  switch (event.type) {
    case "message":
      if (!currentAssistantMessage) {
        currentAssistantMessage = appendMessage("assistant", event.content);
      } else {
        // 같은 턴의 연속된 message 이벤트는 하나의 메시지에 누적
        currentAssistantMessage.textContent += event.content;
      }
      break;

    case "tool_call":
      currentAssistantMessage = null; // 다음 message는 새 버블로
      appendToolCall(event.name, event.args);
      break;

    case "tool_result":
      appendToolResult(event.name, event.output);
      break;

    case "thinking":
      appendThinking(event.content);
      break;

    case "error":
      appendMessage("error", event.message);
      break;

    case "done":
      currentAssistantMessage = null;
      setInputEnabled(true);
      break;
  }
}
```

**메시지 누적 로직:**
- `message` 이벤트가 연속으로 오면 하나의 메시지로 합침
- `tool_call`이 오면 `currentAssistantMessage`를 초기화하여 다음 `message`는 별도 메시지로 분리
- 이는 "텍스트 → 툴 호출 → 텍스트" 패턴에서 각 텍스트가 독립된 메시지로 표시되게 함

### 3. 한글 입력 처리 (IME)

```typescript
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.isComposing) {
    sendMessage();
  }
});
```

`e.isComposing` 체크가 없으면 한글 조합 중 Enter 시 미완성 글자가 전송됩니다.

### 4. 입력 상태 관리

```typescript
function setInputEnabled(enabled: boolean) {
  inputEl.disabled = !enabled;
  sendBtn.disabled = !enabled;
  if (enabled) inputEl.focus();
}

async function sendMessage() {
  const message = inputEl.value.trim();
  if (!message) return;

  inputEl.value = "";
  setInputEnabled(false);   // 응답 수신 중 입력 비활성화
  appendMessage("user", message);

  try {
    await streamResponse(message);
  } catch (e) {
    appendMessage("error", `연결 오류: ${e.message}`);
  } finally {
    setInputEnabled(true);  // 완료 후 입력 활성화
  }
}
```

---

## 서버 설정

### 정적 파일 서빙

Chat UI 파일을 `public/` 디렉토리에 두고 Hono에서 서빙합니다.

```typescript
import { serveStatic } from "hono/bun"; // Node.js: @hono/node-server/serve-static

app.use("/*", serveStatic({ root: "./public" }));
```

라우트 순서: `/chat` 엔드포인트를 정적 파일 서빙보다 **먼저** 등록하거나, 정적 파일 미들웨어가 매칭되지 않을 때 `next()`를 호출하도록 해야 합니다. Hono의 `serveStatic`은 파일이 없으면 자동으로 `next()`를 호출하므로 순서 무관합니다.

### CORS (개발 환경)

프론트엔드를 별도 dev server로 실행할 경우:

```typescript
import { cors } from "hono/cors";

app.use("/chat", cors());
```

---

## 에러 처리

### 네트워크 오류

```typescript
try {
  const res = await fetch("/chat", { ... });
  if (!res.ok) {
    handleEvent({ type: "error", message: `HTTP ${res.status}` });
    return;
  }
  // 스트림 처리...
} catch (e) {
  handleEvent({ type: "error", message: `네트워크 오류: ${e.message}` });
}
```

### 스트림 중단

서버가 응답 도중 연결을 끊으면 `reader.read()`가 `{ done: true }`를 반환합니다.
`done` 이벤트 없이 스트림이 종료되면 UI에서 적절히 처리해야 합니다.

```typescript
// 스트림 루프 종료 후
if (!receivedDoneEvent) {
  handleEvent({ type: "error", message: "응답이 중단되었습니다." });
}
```

### JSON 파싱 오류

```typescript
try {
  const event = JSON.parse(json);
  handleEvent(event);
} catch {
  console.warn("SSE 파싱 실패:", json);
}
```

---

## 프로젝트 구조

```
public/
└── index.html        # 단일 파일 (HTML + JS)
```

MVP에서는 빌드 도구 없이 단일 HTML 파일로 구현합니다.
프레임워크 도입이 필요해지면 다음 구조로 전환합니다:

```
client/
├── src/
│   ├── main.ts           # 진입점
│   ├── api.ts            # SSE 스트리밍 클라이언트
│   ├── events.ts         # 이벤트 핸들러
│   └── components/
│       ├── MessageList.ts
│       ├── ChatInput.ts
│       ├── ToolCallBlock.ts
│       └── ToolResultBlock.ts
├── index.html
└── package.json
```

---

## 확장 포인트

| 기능 | 구현 방향 |
|------|-----------|
| Markdown 렌더링 | `marked` 또는 `markdown-it` 라이브러리로 `message` 이벤트 렌더링 |
| 코드 하이라이팅 | `highlight.js` 또는 `shiki`로 코드 블록 처리 |
| 자동 스크롤 제어 | 사용자가 스크롤을 올렸으면 자동 스크롤 중지, 하단이면 유지 |
| 대화 히스토리 | `localStorage` 또는 서버 API로 이전 대화 저장/불러오기 |
| 재연결 | 스트림 중단 시 마지막 이벤트 ID 기반으로 재개 요청 |
| 요청 취소 | `AbortController`로 진행 중인 요청 취소 |
| 타이핑 인디케이터 | `thinking` 이벤트 수신 시 로딩 상태 표시 |

### 자동 스크롤 구현

```typescript
function isNearBottom(el: HTMLElement, threshold = 50): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
}

function scrollToBottomIfNeeded(el: HTMLElement) {
  if (isNearBottom(el)) {
    el.scrollTop = el.scrollHeight;
  }
}
```

### 요청 취소 구현

```typescript
let abortController: AbortController | null = null;

async function sendMessage(message: string) {
  abortController = new AbortController();

  const res = await fetch("/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
    signal: abortController.signal,
  });
  // ...
}

function cancelRequest() {
  abortController?.abort();
  abortController = null;
  setInputEnabled(true);
}
```
