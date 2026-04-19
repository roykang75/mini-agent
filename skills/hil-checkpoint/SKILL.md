---
name: hil_checkpoint
description: 자율 실행 중 HIL (human-in-the-loop) 승인이 필요한 action 직전에 호출. Roy 의 승인까지 goal 을 paused 상태로 전환.
input_schema:
  type: object
  properties:
    reason:
      type: string
      description: 왜 HIL 이 필요한가 — "irreversible fs_delete", "shell_run destructive", "new http host" 등.
    proposed_action:
      type: string
      description: 다음에 하려는 구체 action 설명. Roy 가 이걸 읽고 승인/거부.
    goal_id:
      type: string
      description: 현재 실행 중인 goal.id.
  required: [reason, proposed_action, goal_id]
---

# hil_checkpoint

ADR-009 HIL (human-in-the-loop) checkpoint skill. Autonomous goal executor 가 irreversible 또는 위험 action 직전에 호출.

## 언제 호출

Goal 의 `autonomy_config.require_hil_before` 리스트에 해당하는 skill / action 을 수행하기 전:
- `fs_delete` — 파일 삭제
- `shell_run` — 임의 shell 명령
- `http_call_new_host` — 새 external host 호출
- 기타 goal 에 지정된 action

## 효과

Controller 가 이 skill 호출을 감지하면:
1. Goal status 를 `active` → `paused` 로 전이
2. 진행 로그에 `[hil] reason: ... proposed_action: ...` 기록
3. Iteration loop 종료
4. Roy 에게 notification (UI 또는 log)

Roy 는 goal 파일을 열어 상황 확인 → 승인 시 status 를 `active` 로 되돌림 / 거부 시 `aborted`.
