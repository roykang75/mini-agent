# Mini Agent TODO

## 완료

- [x] Hono 서버 가이드 문서 작성
- [x] Chat UI 기술 구현 가이드 문서 작성
- [x] Next.js + Tailwind CSS + shadcn/ui 프로젝트 세팅
- [x] Chat UI 컴포넌트 구현 (ChatContainer, MessageList, ChatInput)
- [x] Progressive Disclosure 블록 (ThinkingBlock, ToolCallBlock, ToolResultBlock)
- [x] Empty State + 예시 프롬프트 (onboard)
- [x] 터미널 에스테틱 적용 (typeset) — $ 프롬프트, 터미널 윈도우 크롬
- [x] 입력 영역 시각적 강화 (arrange) — 둥근 컨테이너, 상태 기반 전송 버튼
- [x] 시스템 상태 피드백 (animate) — TypingIndicator, 메시지 fade-in
- [x] Warm amber 색상 팔레트 (colorize) — neutrals에 hue 65 적용
- [x] Agent 백엔드 구현 — AsyncGenerator 루프, Anthropic SDK
- [x] 3개 툴 구현 — read_file, write_file, run_command
- [x] SSE 스트리밍 API — POST /chat Route Handler
- [x] Human-in-the-Loop (HIL) — 세션 기반 승인/거부, POST /chat/approve
- [x] 아키텍처 다이어그램 3종 — detail, simple, poster

## 다음 단계

### UX 개선
- [ ] Markdown 렌더링 — assistant 메시지에 `marked` 또는 `markdown-it` 적용
- [ ] 코드 하이라이팅 — `shiki` 또는 `highlight.js`로 코드 블록 처리
- [ ] 대화 히스토리 — localStorage 또는 서버 API로 이전 대화 저장/불러오기
- [ ] 메시지 복사 버튼 — assistant 메시지와 tool_result에 복사 기능
- [ ] 키보드 단축키 — 이전 명령 재실행, 메시지 탐색

### 안정성
- [ ] 컨텍스트 관리 — 대화가 길어질수록 메시지 요약/압축
- [ ] 스트림 재연결 — Run ID 기반 이벤트 재생
- [ ] 에러 재시도 — 네트워크 오류 시 자동 재시도 + UI 피드백
- [ ] 세션 영속화 — in-memory → Redis 또는 DB로 전환

### 기능 확장
- [ ] 툴 추가 — search_files (Grep), list_directory (ls -la), edit_file (patch)
- [ ] 툴 실행 병렬화 — 여러 tool_use가 동시에 올 때 Promise.all 처리
- [ ] MCP 연동 — 외부 도구(GitHub, DB 등) 확장
- [ ] 멀티 세션 — 여러 대화를 동시에 관리
- [ ] 사용자 인증 — API 키 관리, 세션 격리

### 배포
- [ ] Vercel 배포 설정
- [ ] 환경 변수 관리 (vercel env)
- [ ] 프로덕션 로깅 및 모니터링
