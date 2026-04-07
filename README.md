# Mini Agent

Claude Code와 유사한 AI Agent를 직접 구현한 프로젝트입니다.
사용자 명령을 받아 LLM에 전달하고, 툴 호출을 처리하며, 중간 결과를 실시간으로 스트리밍합니다.

## 아키텍처

```
브라우저 (Chat UI)                    Next.js API Route              Anthropic API
    │                                     │                              │
    │  POST /chat                         │                              │
    │  { "message": "..." }               │   Agent Loop                 │
    │ ──────────────────────────────────► │ ───────────────────────────► │
    │                                     │                              │
    │  SSE Stream                         │   tool_use / end_turn        │
    │ ◄─ event: tool_call                │ ◄─────────────────────────── │
    │ ◄─ event: tool_result              │                              │
    │ ◄─ event: message                  │   Tool Execution             │
    │ ◄─ event: done                     │   (read_file, write_file,    │
    │                                     │    run_command)              │
```

## 기술 스택

| 영역 | 기술 |
|------|------|
| Frontend | Next.js (App Router), Tailwind CSS, shadcn/ui |
| Backend | Next.js Route Handler, Anthropic SDK |
| Agent | AsyncGenerator 기반 루프, SSE 스트리밍 |
| Tools | read_file, write_file, run_command |
| UI 라이브러리 | Lucide Icons, CVA, tw-animate-css |

## 프로젝트 구조

```
src/
├── app/
│   ├── chat/route.ts            # POST /chat → SSE 스트리밍 API
│   ├── layout.tsx               # 루트 레이아웃
│   ├── page.tsx                 # Chat UI 페이지
│   └── globals.css              # 테마 (warm amber tint)
├── components/
│   ├── chat/
│   │   ├── chat-container.tsx   # 상태 관리 + SSE 오케스트레이션
│   │   ├── chat-input.tsx       # 터미널 스타일 입력 ($ 프롬프트)
│   │   ├── message-list.tsx     # 메시지 그룹핑 + 자동 스크롤
│   │   ├── thinking-block.tsx   # 접을 수 있는 thinking 블록
│   │   ├── tool-call-block.tsx  # 터미널 윈도우 스타일 툴 호출
│   │   ├── tool-result-block.tsx # 터미널 윈도우 스타일 툴 결과
│   │   └── typing-indicator.tsx # 3dot pulse 로딩 인디케이터
│   └── ui/                      # shadcn 컴포넌트
├── lib/
│   ├── agent.ts                 # Agent 루프 (AsyncGenerator)
│   ├── sse-client.ts            # 프론트엔드 SSE 클라이언트
│   ├── types.ts                 # 공유 타입 (AgentEvent, ChatMessage)
│   ├── tools/
│   │   ├── index.ts             # 툴 레지스트리
│   │   ├── read-file.ts         # 파일 읽기
│   │   ├── write-file.ts        # 파일 쓰기
│   │   └── run-command.ts       # 쉘 명령 실행
│   └── utils.ts
└── docs/
    ├── agent-api-server-guide.md  # API 서버 개발 가이드
    ├── chat-ui-guide.md           # Chat UI 기술 구현 가이드
    └── chat-ui-critique.md        # UI/UX 디자인 리뷰 리포트
```

## 시작하기

### 1. 의존성 설치

```bash
npm install
```

### 2. 환경 변수 설정

```bash
cp .env.local.example .env.local
```

`.env.local` 파일을 열고 `ANTHROPIC_API_KEY`에 실제 API 키를 입력합니다.

### 3. 개발 서버 실행

```bash
npm run dev
```

http://localhost:3000 에서 접속합니다.

## Agent 동작 방식

Agent의 핵심은 단순한 루프입니다:

```typescript
while (true) {
  const response = await llm.call(messages, tools);

  if (response.isToolCall) {
    const result = await executeTool(response.tool);
    messages.push(result);
    continue;
  }

  if (response.isDone) break;
}
```

1. 사용자 메시지를 LLM에 전달
2. LLM이 툴 호출을 반환하면 해당 툴을 실행하고 결과를 다시 LLM에 전달
3. LLM이 최종 응답을 반환하면 루프 종료
4. 모든 중간 과정은 SSE로 실시간 스트리밍

## SSE 이벤트 타입

| 이벤트 | 설명 |
|--------|------|
| `message` | LLM의 텍스트 응답 |
| `tool_call` | 툴 호출 요청 (이름 + 인자) |
| `tool_result` | 툴 실행 결과 |
| `thinking` | LLM의 사고 과정 |
| `done` | 응답 완료 |
| `error` | 오류 발생 |

## 사용 가능한 툴

| 툴 | 설명 |
|----|------|
| `read_file` | 파일 내용 읽기 |
| `write_file` | 파일 내용 쓰기 (디렉토리 자동 생성) |
| `run_command` | 쉘 명령 실행 (30초 타임아웃) |
