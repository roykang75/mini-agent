/**
 * hil_checkpoint skill handler (ADR-009 P2).
 *
 * 이 handler 는 **실제 작업을 수행하지 않는다** — 호출 자체가 signal 이다.
 * Controller 가 tool_use event 를 감지해 goal 을 paused 로 전이.
 * Handler 는 agent 에게 "paused 요청을 접수했다" 는 tool_result 를 돌려준다.
 */

export interface HilCheckpointArgs {
  reason: string;
  proposed_action: string;
  goal_id: string;
}

export interface HilCheckpointResult {
  acknowledged: boolean;
  message: string;
}

export async function handler(args: HilCheckpointArgs): Promise<HilCheckpointResult> {
  return {
    acknowledged: true,
    message: `HIL checkpoint 요청 접수: goal_id=${args.goal_id} reason="${args.reason}". Goal 은 paused 로 전이될 것이고, Roy 가 승인 후 resume 된다. 이 iteration 은 여기서 종료하라.`,
  };
}
