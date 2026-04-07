# Chat UI 디자인 리뷰 리포트

> 리뷰 대상: Mini Agent Chat UI (Empty State + 컴포넌트 코드)  
> 리뷰 기준: `.impeccable.md` 디자인 컨텍스트  
> 일시: 2026-04-08

---

## Design Health Score (Nielsen's Heuristics)

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 2 | 스트리밍 중 로딩 인디케이터 없음. 전송 후 시각적 피드백 부족 |
| 2 | Match System / Real World | 3 | 한글 UI, Agent/Tool 개념이 개발자에게 친숙 |
| 3 | User Control and Freedom | 3 | AbortController 취소 구현됨. 단, 취소 버튼 인지성 낮음 |
| 4 | Consistency and Standards | 3 | shadcn 컴포넌트 일관성 확보. 내부 패턴 통일 |
| 5 | Error Prevention | 2 | 빈 메시지 전송 방지됨. 그러나 IME 외 엣지케이스 미비 |
| 6 | Recognition Rather Than Recall | 1 | Empty state에 예시 프롬프트 없음. 사용자가 뭘 할 수 있는지 추론해야 함 |
| 7 | Flexibility and Efficiency | 1 | 키보드 단축키 없음. 메시지 복사/재전송 불가 |
| 8 | Aesthetic and Minimalist Design | 2 | 과도하게 비어 있음. 미니멀이 아니라 미완성에 가까움 |
| 9 | Error Recovery | 2 | 에러 메시지 표시는 되나, 재시도 액션 없음 |
| 10 | Help and Documentation | 1 | 도움말, 사용법 안내 전무 |
| **Total** | | **20/40** | **Baseline — 핵심 기능은 동작하나 UX 개선 필요** |

---

## Anti-Patterns Verdict

**판정: AI 생성물로 보일 가능성 — 중간**

AI slop의 전형적 징후(다크 모드 글로우, 그라데이션 텍스트, 글래스모피즘)는 없다. 그러나 다른 방향의 문제가 있다:

- **과도한 공백**: 화면의 90%가 빈 공간. "미니멀"이 아니라 "비어 있음"
- **기본 shadcn 그대로**: 커스터마이징 없는 기본 테마는 "AI가 스캐폴딩한 것" 느낌
- **아이콘 + 제목 + 부제 중앙 정렬 패턴**: 가장 흔한 empty state 패턴
- **순수 무채색 팔레트**: 디자인 결정이 아니라 결정 회피로 읽힘

---

## Overall Impression

기술적 기반은 탄탄하다. SSE 스트리밍, 메시지 그룹핑, Collapsible 블록, 자동 스크롤, 취소 기능 — 코드 구조가 잘 잡혀 있다. 그러나 **시각적으로 아무 결정도 내리지 않은 상태**다. 현재는 "작동하는 프로토타입"이지 "디자인된 인터페이스"가 아니다.

가장 큰 기회: **Empty state를 온보딩 경험으로 전환**하고, **터미널 에스테틱을 실제로 구현**하는 것.

---

## What's Working

1. **컴포넌트 아키텍처**: `ChatContainer` → `MessageList` → 개별 블록 구조가 깔끔. HIL 컴포넌트 삽입이 용이한 구조
2. **Progressive Disclosure**: tool_call, tool_result, thinking 모두 Collapsible로 구현. 정보 과부하 방지
3. **메시지 그룹핑**: 연속된 assistant 이벤트를 하나의 아바타 그룹으로 묶는 로직이 올바름

---

## Priority Issues

### [P0] Empty State가 사용자를 안내하지 않음

**현재**: Bot 아이콘 + "Mini Agent" + "무엇을 도와드릴까요?" — 끝.

**문제**: 사용자가 이 Agent로 무엇을 할 수 있는지 알 수 없다. 특히 3개 툴(read_file, write_file, run_command)의 존재를 모른다. 첫 경험이 "빈 화면 앞에서 뭘 쳐야 하지?"가 된다.

**해결 방향**:
- 예시 프롬프트 3~4개를 클릭 가능한 버튼으로 제공
- 예: "현재 디렉토리 파일 목록 보기", "package.json 내용 확인", "README.md 작성하기"
- `/onboard` 커맨드로 개선

### [P1] 터미널 에스테틱이 구현되지 않음

**현재**: 디자인 원칙에 "Terminal Aesthetic"을 명시했으나, 실제 UI는 기본 shadcn 라이트 테마 그대로.

**문제**: `.impeccable.md`의 핵심 방향("터미널처럼 기술적인 느낌")과 실제 구현 사이에 간극이 크다. 모노스페이스 폰트 활용, 코드 블록 스타일링 등 터미널 감성이 부재.

**해결 방향**:
- 입력 영역에 터미널 프롬프트(`>` 또는 `$`) 시각적 힌트
- tool_call/tool_result 블록에 터미널 윈도우 스타일 적용
- 전체적으로 Geist Mono 비중 확대
- `/bolder` 또는 `/typeset` 커맨드로 개선

### [P1] 입력 영역의 시각적 존재감 부족

**현재**: 배경과 거의 구분 안 되는 얇은 border-top, ghost 버튼의 전송 아이콘.

**문제**: 채팅 UI에서 가장 중요한 인터랙션 포인트가 시각적으로 가장 약하다. 전송 버튼이 비활성화 상태처럼 보인다.

**해결 방향**:
- 입력 영역에 미묘한 배경색 차이 또는 그림자 부여
- 전송 버튼에 최소한의 시각적 강조 (텍스트 입력 시 활성화 애니메이션)
- `/arrange` 커맨드로 개선

### [P2] 시스템 상태 피드백 부족

**현재**: 메시지 전송 후 → SSE 응답이 오기 전까지 시각적 피드백 없음. 입력만 비활성화될 뿐.

**문제**: LLM 호출은 수 초 걸릴 수 있다. 이 기간 동안 사용자는 "보냈나? 작동하나?"를 모른다.

**해결 방향**:
- 전송 후 typing indicator (점 3개 애니메이션 또는 skeleton)
- thinking 이벤트 수신 시 "thinking..." 인디케이터
- `/animate` 커맨드로 개선

### [P2] 색상 활용 부재

**현재**: 순수 무채색(흑/백/회). 유일한 색상은 tool_call의 amber-600과 tool_result의 emerald-600 (코드에만 존재, 화면에서 미확인).

**문제**: "밝고 경쾌한 톤"이라는 디자인 방향에 부합하지 않음. 무채색만으로는 Light & Bright 원칙 충족 불가.

**해결 방향**:
- 브랜드 액센트 색상 1개 도입 (따뜻한 계열 권장)
- 이벤트 타입별 색상 코딩 강화
- `/colorize` 커맨드로 개선

---

## Persona Red Flags

### 개발자 (본인 사용 — Power User)

- 키보드만으로 모든 작업 불가 (메시지 복사, 이전 명령 재실행 등)
- 코드 블록에 syntax highlighting 없음
- tool_result의 긴 출력을 빠르게 스캔하기 어려움 (라인 넘버 없음)
- 이전 대화 히스토리 없음 (새로고침하면 모든 대화 소멸)

### 첫 방문자 (데모/공유 시)

- Empty state가 기능 안내를 하지 않음 — "이게 뭐하는 앱이지?"
- 어떤 종류의 명령을 입력해야 하는지 힌트 없음
- 에러 발생 시 "연결 오류" 외에 다음 행동 안내 없음

---

## Minor Observations

- **메시지 타임스탬프**: 코드에 `timestamp` 필드가 있으나 UI에 표시하지 않음. 디버깅 시 유용할 수 있음
- **사용자 아바타**: User 아이콘이 muted 스타일로 너무 약함. 자기 메시지 인지가 느림
- **tool_result 미리보기**: 닫힌 상태에서 `<pre>` 태그로 미리보기 텍스트가 나오는데, Collapsible 밖에 있어서 레이아웃 이중 구조
- **`messageId` 전역 변수**: module-level `let messageId = 0`은 HMR 시 리셋됨. `useRef` 또는 `crypto.randomUUID()` 권장
- **max-width 720px/3xl**: 좁은 뷰포트에서는 적절하나, 와이드 모니터에서 공간 낭비가 큼
