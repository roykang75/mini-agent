/**
 * Post-goal hook — ADR-007 P3 자동화 (ADR-009 goal 종료 전이 hook).
 *
 * goal-controller 가 completed / paused / aborted 전이 직후 이 함수를 호출한다.
 * fire-and-forget 로 `scripts/post-goal-hook.ts <goalPath>` 를 spawn →
 * 자식 프로세스가 잠시 대기 후 최근 N 개 episode 에 대해 grade-real-session
 * (Opus 3-인칭 관찰) 을 실행한다. 실 비용은 Opus 호출 N 회 (goal 당 ~$0.05).
 *
 * Policy (auto-consolidate 와 동일한 규약):
 *   - env `POST_GOAL_HOOK=on` (or "1"/"true") 일 때만 발동. default off.
 *     smoke 테스트가 inadvertent API 호출을 피하기 위한 명시 opt-in.
 *   - AGENT_MEMORY_DIR + CURRICULUM_DIR 필요 — 둘 중 하나라도 비면 no-op.
 *   - detached + unref 로 부모 이벤트 루프에서 분리.
 *   - spawn 실패는 warn 로그만.
 */

import { spawn } from "node:child_process";
import { createLogger } from "../log";

const log = createLogger("agent");

export function maybeSpawnPostGoalHook(goalPath: string): void {
  const flag = (process.env.POST_GOAL_HOOK ?? "off").toLowerCase();
  if (flag !== "on" && flag !== "1" && flag !== "true") return;

  const memoryDir = process.env.AGENT_MEMORY_DIR;
  const curriculumDir = process.env.CURRICULUM_DIR;
  if (!memoryDir || !curriculumDir) {
    log.warn(
      { event: "post_goal_hook_env_missing", memoryDir: !!memoryDir, curriculumDir: !!curriculumDir },
      "POST_GOAL_HOOK on but AGENT_MEMORY_DIR or CURRICULUM_DIR unset — skipping",
    );
    return;
  }

  try {
    const child = spawn("npx", ["tsx", "scripts/post-goal-hook.ts", goalPath], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env },
      cwd: process.cwd(),
    });
    child.unref();
    log.info(
      { event: "post_goal_hook_spawned", pid: child.pid, goal_path: goalPath },
      "post-goal hook spawned",
    );
  } catch (e) {
    log.warn(
      {
        event: "post_goal_hook_spawn_failed",
        err_message: (e as Error).message,
        goal_path: goalPath,
      },
      "failed to spawn post-goal hook — skipping",
    );
  }
}
