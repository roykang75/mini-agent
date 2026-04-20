/**
 * hil_checkpoint skill handler (ADR-009 P2).
 *
 * 이 handler 는 **실제 작업을 수행하지 않는다** — 호출 자체가 signal 이다.
 * Controller 가 tool_use event 를 감지해 goal 을 paused 로 전이.
 * Handler 는 agent 에게 "paused 요청을 접수했다" 는 tool_result 를 돌려준다.
 */

import { z } from "zod";

const InputSchema = z.object({
  reason: z.string(),
  proposed_action: z.string(),
  goal_id: z.string(),
});
type HilCheckpointInput = z.infer<typeof InputSchema>;

export async function execute(args: HilCheckpointInput): Promise<string> {
  const { reason, proposed_action, goal_id } = InputSchema.parse(args);
  return JSON.stringify({
    acknowledged: true,
    goal_id,
    reason,
    proposed_action,
    message: `HIL checkpoint 요청 접수: goal_id=${goal_id} reason="${reason}". Goal 은 paused 로 전이되고, Roy 가 승인 후 resume 된다. 이 iteration 은 여기서 종료하라.`,
  });
}
