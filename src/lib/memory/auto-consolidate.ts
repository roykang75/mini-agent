/**
 * Auto-consolidate trigger (ADR-007 P1 자동화).
 *
 * 한 receive() 가 끝나면 withRawCapture 가 closeRaw 로 jsonl 을 flush 한다.
 * 거기서 반환된 raw path 를 이 모듈이 받아 fire-and-forget 로 consolidate CLI
 * 를 spawn 한다. 런타임 비용은 spawn overhead (수 ms) 뿐이고 Sonnet 호출은
 * 자식 프로세스에서 비동기 수행.
 *
 * Policy:
 *   - env `AUTO_CONSOLIDATE` 가 "on" / "1" / "true" 일 때만 발동 (default: off).
 *     smoke 테스트가 tmp AGENT_MEMORY_DIR 로 inadvertent 호출을 피하기 위해
 *     **명시 opt-in** 을 택했다. 실 dev 서버는 `.env.local` 에 한 줄 추가.
 *   - `AGENT_MEMORY_DIR` / `rawPath` 중 하나라도 비면 no-op.
 *   - spawn 실패는 warn 로그만 — 세션 흐름에 영향 없음.
 *   - `detached: true` + `unref()` 로 부모 이벤트 루프에서 완전히 분리.
 */

import { spawn } from "node:child_process";
import { createLogger } from "../log";

const log = createLogger("memory");

export function maybeSpawnConsolidate(
  rawPath: string | undefined,
  memoryDir: string | undefined,
): void {
  if (!rawPath || !memoryDir) return;
  const flag = (process.env.AUTO_CONSOLIDATE ?? "off").toLowerCase();
  if (flag !== "on" && flag !== "1" && flag !== "true") return;

  try {
    const child = spawn("npx", ["tsx", "scripts/consolidate.ts", rawPath], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, AGENT_MEMORY_DIR: memoryDir },
      cwd: process.cwd(),
    });
    child.unref();
    log.info(
      { event: "auto_consolidate_spawned", pid: child.pid, raw_path: rawPath },
      "auto consolidate spawned",
    );
  } catch (e) {
    log.warn(
      {
        event: "auto_consolidate_spawn_failed",
        err_message: (e as Error).message,
        raw_path: rawPath,
      },
      "failed to spawn consolidate — skipping",
    );
  }
}
