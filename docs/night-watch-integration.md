# Night's Watch 연계 (요약)

Autonomous agent observability 서비스 [`night-watch`](../../night-watch) 가 별도
레포로 분리됨. mini-agent 는 **dual-write** 로 관측 데이터를 전송:
- 기존 `agent-memory/raw/YYYY/MM/DD/NNNN.jsonl` — agent-memory consolidate 경로
  (불변 유지)
- 추가로 `POST http://localhost:3001/api/ingest` — Night's Watch ingest API
  (fire-and-forget)

전체 설계 / 스키마 / UI / phase 는 night-watch 레포의
[docs/plan.md](../../night-watch/docs/plan.md) 참조.

## 관련 변경 지점 (mini-agent 쪽)

- `src/lib/observability/night-watch.ts` — Observer client (Phase 2 에서 추가)
- `src/lib/llm/providers/{anthropic,openai-compat}.ts` — llm_request /
  llm_response capture hook (Phase 2)
- `src/lib/agent/instance.ts` — trace start / end, event append (Phase 2)
- `src/lib/goal/agent-runner.ts` — tool_approval_decision 이벤트 추가 (Phase 2)

## 환경 변수

- `NW_ENABLED` (default false in test, true in dev): 관측 client 활성화
- `NW_BASE_URL` (default `http://localhost:3001`): Night's Watch 주소
- `NW_INGEST_TOKEN` (prod only): 인증 토큰

## 관측이 꺼져 있어도 mini-agent 는 영향 없음

`NW_ENABLED=false` 또는 Night's Watch 가 down 이어도 mini-agent 는 그대로 동작.
client 는 fire-and-forget + 2s timeout + try/catch 로 main flow 를 절대 block
하지 않는다.
