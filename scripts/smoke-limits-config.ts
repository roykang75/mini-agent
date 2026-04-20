/**
 * Smoke: runtime-limits config loader (Roy 의 "config 파일 중심 관리" 원칙).
 *
 * config 파일 → env override → default fallback 세 경로를 다 검증.
 */

import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  loadRuntimeLimits,
  __resetRuntimeLimitsCache,
} from "../src/lib/config/limits";

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error(`[FAIL] ${msg}`);
    process.exit(1);
  }
}

function withEnv(key: string, value: string | undefined, fn: () => void): void {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}

async function main() {
  const tmp = join(tmpdir(), `smoke-limits-config-${Date.now()}`);
  mkdirSync(tmp, { recursive: true });
  const cfgPath = join(tmp, "runtime-limits.json");

  // ─── 1. File 읽기: 정상 값 ───
  writeFileSync(cfgPath, JSON.stringify({
    retry: {
      tool_call_retry_limit: 5,
      advisor_call_limit: 7,
      goal_retry_max: 4,
      approval_safety_limit: 64,
    },
  }));
  withEnv("RUNTIME_LIMITS_PATH", cfgPath, () => {
    withEnv("RETRY_LIMIT", undefined, () => {
      withEnv("ADVISOR_CALL_LIMIT", undefined, () => {
        withEnv("APPROVAL_SAFETY_LIMIT", undefined, () => {
          __resetRuntimeLimitsCache();
          const l = loadRuntimeLimits();
          assert(l.retry.tool_call_retry_limit === 5, "file: tool_call_retry_limit=5");
          assert(l.retry.advisor_call_limit === 7, "file: advisor_call_limit=7");
          assert(l.retry.goal_retry_max === 4, "file: goal_retry_max=4");
          assert(l.retry.approval_safety_limit === 64, "file: approval_safety_limit=64");
        });
      });
    });
  });

  // ─── 2. advisor_call_limit: null → Infinity ───
  writeFileSync(cfgPath, JSON.stringify({
    retry: { advisor_call_limit: null },
  }));
  withEnv("RUNTIME_LIMITS_PATH", cfgPath, () => {
    withEnv("ADVISOR_CALL_LIMIT", undefined, () => {
      __resetRuntimeLimitsCache();
      const l = loadRuntimeLimits();
      assert(l.retry.advisor_call_limit === Infinity, "null → Infinity");
    });
  });

  // ─── 3. env override ───
  writeFileSync(cfgPath, JSON.stringify({
    retry: { tool_call_retry_limit: 5, advisor_call_limit: 7, approval_safety_limit: 64 },
  }));
  withEnv("RUNTIME_LIMITS_PATH", cfgPath, () => {
    withEnv("RETRY_LIMIT", "10", () => {
      withEnv("ADVISOR_CALL_LIMIT", "20", () => {
        withEnv("APPROVAL_SAFETY_LIMIT", "100", () => {
          __resetRuntimeLimitsCache();
          const l = loadRuntimeLimits();
          assert(l.retry.tool_call_retry_limit === 10, "env RETRY_LIMIT override → 10");
          assert(l.retry.advisor_call_limit === 20, "env ADVISOR_CALL_LIMIT override → 20");
          assert(l.retry.approval_safety_limit === 100, "env APPROVAL_SAFETY_LIMIT override → 100");
        });
      });
    });
  });

  // ─── 4. env "infinity" 문자열 → Infinity ───
  writeFileSync(cfgPath, JSON.stringify({ retry: { advisor_call_limit: 7 } }));
  withEnv("RUNTIME_LIMITS_PATH", cfgPath, () => {
    withEnv("ADVISOR_CALL_LIMIT", "infinity", () => {
      __resetRuntimeLimitsCache();
      const l = loadRuntimeLimits();
      assert(l.retry.advisor_call_limit === Infinity, "env 'infinity' → Infinity");
    });
  });

  // ─── 5. File 누락 → defaults ───
  const missing = join(tmp, "no-such-file.json");
  withEnv("RUNTIME_LIMITS_PATH", missing, () => {
    withEnv("RETRY_LIMIT", undefined, () => {
      withEnv("ADVISOR_CALL_LIMIT", undefined, () => {
        withEnv("APPROVAL_SAFETY_LIMIT", undefined, () => {
          __resetRuntimeLimitsCache();
          const l = loadRuntimeLimits();
          assert(l.retry.tool_call_retry_limit === 3, "default tool_call_retry_limit=3");
          assert(l.retry.advisor_call_limit === Infinity, "default advisor unlimited");
          assert(l.retry.goal_retry_max === 3, "default goal_retry_max=3");
          assert(l.retry.approval_safety_limit === 32, "default approval_safety_limit=32");
        });
      });
    });
  });

  // ─── 6. 불량 값 (negative / non-number) → fallback ───
  writeFileSync(cfgPath, JSON.stringify({
    retry: { tool_call_retry_limit: -1, goal_retry_max: "bad", approval_safety_limit: null },
  }));
  withEnv("RUNTIME_LIMITS_PATH", cfgPath, () => {
    withEnv("RETRY_LIMIT", undefined, () => {
      withEnv("APPROVAL_SAFETY_LIMIT", undefined, () => {
        __resetRuntimeLimitsCache();
        const l = loadRuntimeLimits();
        assert(l.retry.tool_call_retry_limit === 3, "negative → default 3");
        assert(l.retry.goal_retry_max === 3, "non-number → default 3");
        assert(l.retry.approval_safety_limit === 32, "null-on-non-limit-field → default 32");
      });
    });
  });

  // ─── 7. Cache 작동 확인: 같은 config 경로 두 번 호출 → 같은 객체 ───
  writeFileSync(cfgPath, JSON.stringify({ retry: { tool_call_retry_limit: 9 } }));
  withEnv("RUNTIME_LIMITS_PATH", cfgPath, () => {
    withEnv("RETRY_LIMIT", undefined, () => {
      __resetRuntimeLimitsCache();
      const a = loadRuntimeLimits();
      const b = loadRuntimeLimits();
      assert(a === b, "cached reference identity");
      assert(a.retry.tool_call_retry_limit === 9, "cached value 9");
    });
  });

  // Final reset so other smoke/tests starts clean
  __resetRuntimeLimitsCache();
  rmSync(tmp, { recursive: true, force: true });

  console.log("[OK] smoke-limits-config — 7 scenarios, 18 assertions passed");
}

main().then(() => process.exit(0));
