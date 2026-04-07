# Mini Agent API Server 개발 가이드

## 개요

이 문서는 Claude Code와 유사한 **Mini Agent**를 직접 구현해보기 위한 개발 가이드입니다.
사용자 명령을 받아 LLM에 전달하고, 툴 호출을 처리하며, 중간 결과를 실시간으로 스트리밍하는 API 서버를 만드는 것이 목표입니다.

---

## 핵심 설계 원칙

### API 구조: REST + SSE

- **명령 전달**: REST API (`POST /chat`)
- **중간 결과 수신**: SSE (Server-Sent Events)

```
클라이언트                    API Server                    Agent (LLM)
    │                             │                            │
    │  POST /chat                 │                            │
    │  { "message": "..." }       │                            │
    │ ──────────────────────────► │   LLM 호출 시작            │
    │                             │ ──────────────────────────►│
    │  SSE Stream 시작            │                            │
    │ ◄─ event: thinking ──────── │ ◄── 중간 결과 ─────────── │
    │ ◄─ event: tool_call ──────  │                            │
    │ ◄─ event: tool_result ───── │                            │
    │ ◄─ event: message ────────  │                            │
    │ ◄─ event: done ───────────  │                            │
```

### Agent의 본질: 단순 루프

```typescript
while (true) {
  const response = await llm.call(messages, tools);

  if (response.isToolCall) {
    const result = await executeTool(response.tool);
    messages.push(result);
    continue; // 다시 LLM에게
  }

  if (response.isDone) {
    break;
  }
}
```

**이게 전부입니다.** Claude Code도, Cursor도 결국 이 루프입니다.

---

## MVP 범위

### 엔드포인트

```
POST /chat   →  SSE stream 반환
```

### SSE 이벤트 타입

```typescript
type AgentEvent =
  | { type: "thinking";     content: string }
  | { type: "tool_call";    name: string; args: Record<string, unknown> }
  | { type: "tool_result";  name: string; output: string }
  | { type: "message";      content: string }
  | { type: "done" }
  | { type: "error";        message: string }
```

### 툴 (3개만)

| 툴 이름 | 설명 |
|---------|------|
| `read_file` | 파일 내용 읽기 |
| `write_file` | 파일 내용 쓰기 |
| `run_command` | 쉘 명령 실행 |

---

## 기술 스택

```
TypeScript  - 언어
Hono        - API 서버 (SSE 내장 지원)
Anthropic SDK - LLM 호출 (@anthropic-ai/sdk)
zod         - 툴 입력 검증
tsx         - 실행 (ts-node 대신)
```

---

## 프로젝트 구조

```
mini-agent/
├── src/
│   ├── index.ts          # Hono 서버 진입점
│   ├── agent.ts          # Agent 루프 핵심 로직
│   ├── tools/
│   │   ├── index.ts      # 툴 목록 export
│   │   ├── read_file.ts
│   │   ├── write_file.ts
│   │   └── run_command.ts
│   └── types.ts          # 공통 타입 정의
├── public/
│   └── index.html        # Chat UI
├── package.json
├── tsconfig.json
└── .env                  # ANTHROPIC_API_KEY
```

---

## 구현 가이드

### 1. 서버 진입점 (`src/index.ts`)

```typescript
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { serveStatic } from "hono/bun"; // Node.js라면 @hono/node-server/serve-static
import { runAgent } from "./agent";

const app = new Hono();

// 정적 파일 서빙 (Chat UI)
app.use("/*", serveStatic({ root: "./public" }));

app.post("/chat", async (c) => {
  const { message } = await c.req.json();

  return streamSSE(c, async (stream) => {
    for await (const event of runAgent(message)) {
      await stream.writeSSE({
        data: JSON.stringify(event),
        event: event.type,
      });
    }
  });
});

export default app;
```

### 2. Agent 루프 (`src/agent.ts`)

```typescript
import Anthropic from "@anthropic-ai/sdk";
import { tools, executeTool } from "./tools";
import { AgentEvent } from "./types";

const client = new Anthropic();

export async function* runAgent(userMessage: string): AsyncGenerator<AgentEvent> {
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userMessage },
  ];

  while (true) {
    const response = await client.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 4096,
      tools,
      messages,
    });

    // 메시지 추가
    messages.push({ role: "assistant", content: response.content });

    for (const block of response.content) {
      if (block.type === "text") {
        yield { type: "message", content: block.text };
      }

      if (block.type === "tool_use") {
        yield { type: "tool_call", name: block.name, args: block.input as Record<string, unknown> };

        // 툴 실행
        const output = await executeTool(block.name, block.input);
        yield { type: "tool_result", name: block.name, output };

        // 툴 결과를 메시지에 추가
        messages.push({
          role: "user",
          content: [{ type: "tool_result", tool_use_id: block.id, content: output }],
        });
      }
    }

    // 종료 조건
    if (response.stop_reason === "end_turn") {
      yield { type: "done" };
      break;
    }

    // 툴 호출이 없으면 종료
    if (response.stop_reason !== "tool_use") {
      yield { type: "done" };
      break;
    }
  }
}
```

### 3. 툴 정의 예시 (`src/tools/read_file.ts`)

```typescript
import { readFile } from "fs/promises";
import { z } from "zod";

export const readFileTool = {
  name: "read_file",
  description: "파일의 내용을 읽어서 반환합니다.",
  input_schema: {
    type: "object" as const,
    properties: {
      path: { type: "string", description: "읽을 파일의 경로" },
    },
    required: ["path"],
  },
};

const InputSchema = z.object({ path: z.string() });

export async function executeReadFile(input: unknown): Promise<string> {
  const { path } = InputSchema.parse(input);
  try {
    return await readFile(path, "utf-8");
  } catch (e) {
    return `Error: 파일을 읽을 수 없습니다 - ${path}`;
  }
}
```

### 4. 툴 통합 (`src/tools/index.ts`)

```typescript
import { readFileTool, executeReadFile } from "./read_file";
import { writeFileTool, executeWriteFile } from "./write_file";
import { runCommandTool, executeRunCommand } from "./run_command";

export const tools = [readFileTool, writeFileTool, runCommandTool];

export async function executeTool(name: string, input: unknown): Promise<string> {
  switch (name) {
    case "read_file":    return executeReadFile(input);
    case "write_file":   return executeWriteFile(input);
    case "run_command":  return executeRunCommand(input);
    default:             return `Error: 알 수 없는 툴 - ${name}`;
  }
}
```

### 5. Chat UI (`public/index.html`)

단일 HTML 파일로 구현합니다. 별도의 빌드 도구 없이 브라우저에서 바로 동작합니다.

```html
<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Mini Agent</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #1a1a2e;
      color: #eee;
      height: 100vh;
      display: flex;
      flex-direction: column;
    }

    header {
      padding: 16px 24px;
      background: #16213e;
      border-bottom: 1px solid #0f3460;
      font-size: 18px;
      font-weight: 600;
    }

    #messages {
      flex: 1;
      overflow-y: auto;
      padding: 24px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .msg {
      max-width: 720px;
      padding: 12px 16px;
      border-radius: 12px;
      line-height: 1.6;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .msg.user {
      align-self: flex-end;
      background: #0f3460;
    }

    .msg.assistant {
      align-self: flex-start;
      background: #16213e;
      border: 1px solid #0f3460;
    }

    .msg.tool-call {
      align-self: flex-start;
      background: #1a1a2e;
      border: 1px solid #e94560;
      font-family: monospace;
      font-size: 13px;
      color: #e94560;
    }

    .msg.tool-result {
      align-self: flex-start;
      background: #1a1a2e;
      border: 1px solid #0f3460;
      font-family: monospace;
      font-size: 13px;
      color: #aaa;
      max-height: 200px;
      overflow-y: auto;
    }

    .msg .label {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      margin-bottom: 4px;
      opacity: 0.7;
    }

    #input-area {
      padding: 16px 24px;
      background: #16213e;
      border-top: 1px solid #0f3460;
      display: flex;
      gap: 12px;
    }

    #input-area input {
      flex: 1;
      padding: 12px 16px;
      border-radius: 8px;
      border: 1px solid #0f3460;
      background: #1a1a2e;
      color: #eee;
      font-size: 15px;
      outline: none;
    }

    #input-area input:focus {
      border-color: #e94560;
    }

    #input-area button {
      padding: 12px 24px;
      border-radius: 8px;
      border: none;
      background: #e94560;
      color: #fff;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
    }

    #input-area button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
  </style>
</head>
<body>
  <header>Mini Agent</header>
  <div id="messages"></div>
  <div id="input-area">
    <input id="input" type="text" placeholder="메시지를 입력하세요..." autofocus />
    <button id="send">전송</button>
  </div>

  <script>
    const messagesEl = document.getElementById("messages");
    const inputEl = document.getElementById("input");
    const sendBtn = document.getElementById("send");

    function addMessage(type, content) {
      const div = document.createElement("div");
      div.className = `msg ${type}`;
      div.textContent = content;
      messagesEl.appendChild(div);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      return div;
    }

    function addToolCall(name, args) {
      const div = document.createElement("div");
      div.className = "msg tool-call";
      div.innerHTML = `<div class="label">Tool: ${name}</div>${JSON.stringify(args, null, 2)}`;
      messagesEl.appendChild(div);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function addToolResult(name, output) {
      const div = document.createElement("div");
      div.className = "msg tool-result";
      div.innerHTML = `<div class="label">Result: ${name}</div>${output}`;
      messagesEl.appendChild(div);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    async function sendMessage() {
      const message = inputEl.value.trim();
      if (!message) return;

      inputEl.value = "";
      sendBtn.disabled = true;
      addMessage("user", message);

      // 스트리밍 응답을 위한 현재 assistant 메시지
      let assistantDiv = null;

      try {
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
          buffer = lines.pop(); // 마지막 불완전한 줄은 버퍼에 유지

          for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            const json = line.slice("data:".length).trim();
            if (!json) continue;

            const event = JSON.parse(json);

            switch (event.type) {
              case "message":
                if (!assistantDiv) {
                  assistantDiv = addMessage("assistant", event.content);
                } else {
                  assistantDiv.textContent += event.content;
                }
                break;
              case "tool_call":
                assistantDiv = null; // 다음 메시지는 새 버블로
                addToolCall(event.name, event.args);
                break;
              case "tool_result":
                addToolResult(event.name, event.output);
                break;
              case "done":
                break;
              case "error":
                addMessage("assistant", `Error: ${event.message}`);
                break;
            }
          }
        }
      } catch (e) {
        addMessage("assistant", `연결 오류: ${e.message}`);
      } finally {
        sendBtn.disabled = false;
        inputEl.focus();
      }
    }

    sendBtn.addEventListener("click", sendMessage);
    inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) sendMessage();
    });
  </script>
</body>
</html>
```

**핵심 포인트:**

- **SSE 파싱**: `fetch` + `ReadableStream`으로 `data:` 라인을 실시간 파싱
- **이벤트별 렌더링**: `message`는 채팅 버블, `tool_call`/`tool_result`는 모노스페이스 블록
- **한글 입력 처리**: `e.isComposing` 체크로 IME 조합 중 전송 방지

---

## 개발 순서

```
1단계: 기본 뼈대
  ☐ Hono 서버 세팅
  ☐ POST /chat 엔드포인트 (echo만)
  ☐ SSE 스트리밍 테스트

2단계: LLM 연동
  ☐ Anthropic SDK 설치 및 단순 호출
  ☐ 스트리밍 없이 응답 확인

3단계: Agent 루프
  ☐ 기본 루프 구현
  ☐ SSE로 이벤트 흘려주기

4단계: 툴 추가
  ☐ read_file 구현 및 테스트
  ☐ write_file 구현 및 테스트
  ☐ run_command 구현 및 테스트

5단계: Chat UI
  ☐ public/index.html 작성
  ☐ 정적 파일 서빙 설정
  ☐ SSE 이벤트 수신 및 렌더링 확인

6단계: 검증
  ☐ curl로 E2E 테스트
  ☐ 브라우저에서 Chat UI 테스트
  ☐ 에러 케이스 처리
```

---

## 테스트 방법

### 브라우저에서 Chat UI 테스트

```
1. 서버 실행: npx tsx src/index.ts
2. 브라우저에서 http://localhost:3000 접속
3. 메시지 입력 후 전송
4. tool_call → tool_result → message 순서로 표시되는지 확인
```

### curl로 SSE 테스트

```bash
curl -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "현재 디렉토리의 파일 목록을 알려줘"}' \
  --no-buffer
```

### 예상 출력

```
event: tool_call
data: {"type":"tool_call","name":"run_command","args":{"command":"ls -la"}}

event: tool_result
data: {"type":"tool_result","name":"run_command","output":"total 32\ndrwxr-xr-x ..."}

event: message
data: {"type":"message","content":"현재 디렉토리에는 다음 파일들이 있습니다: ..."}

event: done
data: {"type":"done"}
```

---

## 초기 설정

```bash
mkdir mini-agent && cd mini-agent
npm init -y
npm install hono @anthropic-ai/sdk zod
npm install -D typescript tsx @types/node

# tsconfig.json 생성
npx tsc --init

# .env
echo "ANTHROPIC_API_KEY=your_key_here" > .env

# 실행
npx tsx src/index.ts
```

---

## 다음 단계 (MVP 이후)

이 구조를 완성하면 자연스럽게 다음 문제들을 맞닥뜨리게 됩니다.
그때 하나씩 추가하면 됩니다.

| 문제 | 해결 방향 |
|------|-----------|
| 대화가 길어질수록 컨텍스트 폭발 | 메시지 요약/압축 |
| 위험한 명령 실행 | Human-in-the-loop (승인 요청) |
| 클라이언트 재연결 | Run ID 기반 이벤트 재생 |
| 여러 사용자 동시 사용 | 세션 격리 |
| 툴 실행 병렬화 | Promise.all 기반 병렬 툴 실행 |

---

## 참고: MCP와의 관계

이 API는 MCP와 **레이어가 다릅니다**.

```
[사용자 / 서비스]
      ↕  ← 우리가 만드는 API (Agent 제어)
   [Agent]
      ↕  ← MCP (툴 확장)
[GitHub / DB / FileSystem ...]
```

- **우리 API**: 사람이 Agent에게 명령, Agent 실행 관리
- **MCP**: Agent가 외부 도구 사용, 능력 확장
