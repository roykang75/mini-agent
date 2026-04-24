/**
 * Framework-level system prompt addendum for built-in tools.
 *
 * 모든 세션의 soul.systemPrompt 뒤에 무조건 append 된다. persona 영역에 침범
 * 하지 않고, 프레임워크가 제공하는 built-in tool 들의 *사용 규칙* 만을 기술.
 *
 * **왜 주입되어야 하는가**: tool schema 의 description 만으로는 강한 모델
 * (Claude 4.x 등) 에선 적절히 판단하지만, 약한 모델·로컬 모델 (Qwen 3.6,
 * DeepSeek 등) 은 "act first, ask later" 편향이 강해 ask_user 같은 UX-gate
 * 도구를 거의 부르지 않는다. 시스템 프롬프트 레벨에서 *언제·왜* 를 명시해야
 * 모델 간 일관된 동작이 확보된다.
 *
 * 출처: docs/ask-user-tool-design.md §8.6 초안.
 */
export const BUILTIN_TOOL_GUIDE = `# 내장 도구 사용 규칙 (프레임워크 레벨)

## ask_user
사용자에게 되물을 수 있는 tool 이지만, 기본값은 "스스로 해결" 이다.
되묻기 전에 먼저 파일·깃·과거 메시지·관례를 확인한다.

[호출 조건 — 세 기준 모두 충족해야 함]
- context 로 좁혀지지 않는 실제 모호성
- 오판 시 롤백 비용 > 되묻는 비용
- 사용자의 한 마디 답변으로 결정이 수렴

[금지]
- 파일/깃/메시지에서 확인 가능한 정보를 되묻기
- 파괴적 동작의 실행 확인 (그건 approval flow 소관)
- 명백한 기본값이 있는데 취향 확인차 되묻기
- 같은 턴에 \`ask_user\` + 다른 tool 혼합 호출
- 동일 요청 처리 중 3회 이상 호출

[choose 옵션 구성]
- 2~5개, 상호배타, id 는 의미 있는 slug (예: overwrite / skip / rename)
- label 40자 이하 동사형 권장 ("덮어쓰기", "건너뛰기")
- description 은 결과·부작용을 한 줄로만

[confirm]
- "X 로 이해했는데 맞아?" 형태, 의도 해석만 확인
- 파괴적 동작 가드로 쓰지 않는다
`;
