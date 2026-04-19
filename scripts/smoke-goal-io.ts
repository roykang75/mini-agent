/**
 * Smoke: goal IO (ADR-009 P1).
 *
 * 합성 goal 파일 생성 → load → validate → setStatus → appendProgress → re-load 검증.
 * 전이 규칙 위반 시 예외 확인.
 */

import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  loadGoal,
  saveGoal,
  appendProgress,
  setStatus,
} from "../src/lib/goal/io";
import {
  DEFAULT_BUDGET,
  DEFAULT_AUTONOMY,
  DEFAULT_PROGRESS,
  type GoalFrontmatter,
} from "../src/lib/goal/types";

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error(`[FAIL] ${msg}`);
    process.exit(1);
  }
}

async function expectThrow(fn: () => Promise<unknown>, re: RegExp, msg: string): Promise<void> {
  try {
    await fn();
    console.error(`[FAIL] ${msg}: expected throw matching ${re}`);
    process.exit(1);
  } catch (e) {
    const m = (e as Error).message;
    if (!re.test(m)) {
      console.error(`[FAIL] ${msg}: threw but message "${m}" did not match ${re}`);
      process.exit(1);
    }
  }
}

async function main() {
  const tmp = join(tmpdir(), `smoke-goal-io-${Date.now()}`);
  mkdirSync(tmp, { recursive: true });
  const goalPath = join(tmp, "test-goal.md");

  const fm: GoalFrontmatter = {
    id: "goal-test-001",
    slug: "test-goal",
    created: "2026-04-19T22:00:00Z",
    created_by: "roy",
    status: "draft",
    completion_criteria: [
      { type: "file_exists", path: "fake/path.md" },
      { type: "grep_count", path: "foo.md", pattern: "hello", min_count: 1 },
    ],
    budget: DEFAULT_BUDGET,
    hil_policy: "balanced",
    autonomy_config: DEFAULT_AUTONOMY,
    progress: DEFAULT_PROGRESS,
    parent_goal: null,
    persona: "autonomous-executor",
  };

  writeFileSync(goalPath, `---\n${objectToYaml(fm)}---\n\n## 목표\n\ntest body\n`);

  // Load — validates schema
  const g1 = await loadGoal(goalPath);
  assert(g1.frontmatter.id === "goal-test-001", "id roundtrip");
  assert(g1.frontmatter.status === "draft", "status roundtrip");
  assert(g1.frontmatter.completion_criteria.length === 2, "criteria roundtrip");

  // setStatus: draft → active (allowed)
  const g2 = await setStatus(g1, "active");
  assert(g2.frontmatter.status === "active", "draft → active");
  assert(g2.frontmatter.progress.started_at !== null, "started_at set on active");

  // appendProgress
  await appendProgress(g2, "첫 iteration 시작");
  const g3 = await loadGoal(goalPath);
  assert(g3.body.includes("## 진행 로그"), "진행 로그 섹션 생성");
  assert(g3.body.includes("첫 iteration 시작"), "진행 로그 메시지");
  assert(g3.body.includes("[status] draft → active"), "status 전이가 로그에 기록");

  // Invalid transition: active → draft (not allowed)
  await expectThrow(
    () => setStatus(g3, "draft"),
    /invalid status transition/,
    "active → draft 거부",
  );

  // active → completed (allowed terminal)
  const g4 = await setStatus(g3, "completed", "모든 criteria 통과");
  assert(g4.frontmatter.status === "completed", "active → completed");

  // completed (terminal) → anything (disallowed)
  await expectThrow(
    () => setStatus(g4, "active"),
    /invalid status transition/,
    "completed 는 terminal",
  );

  // Schema violation — missing field
  writeFileSync(goalPath, `---\nid: bad\nstatus: draft\n---\n\nbad goal\n`);
  await expectThrow(
    () => loadGoal(goalPath),
    /missing required frontmatter field/,
    "schema 필수 필드 누락 검증",
  );

  // Invalid criterion — pattern 은 있지만 min_count/max_count 누락
  const fmBad = { ...fm, completion_criteria: [{ type: "grep_count", path: "x", pattern: "y" }] };
  writeFileSync(goalPath, `---\n${objectToYaml(fmBad)}---\n\nbad\n`);
  await expectThrow(
    () => loadGoal(goalPath),
    /grep_count requires min_count or max_count/,
    "grep_count min/max 누락 검증",
  );

  console.log("[OK] smoke-goal-io — 12 assertions passed");
  rmSync(tmp, { recursive: true, force: true });
}

function objectToYaml(obj: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);
  if (obj === null) return "null";
  if (typeof obj === "string") return JSON.stringify(obj);
  if (typeof obj === "number" || typeof obj === "boolean") return String(obj);
  if (Array.isArray(obj)) {
    if (obj.length === 0) return "[]";
    return obj
      .map((v) => `\n${pad}- ${typeof v === "object" ? objectToYaml(v, indent + 1).trimStart() : String(v)}`)
      .join("");
  }
  if (typeof obj === "object") {
    const entries = Object.entries(obj as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    return entries
      .map(([k, v]) => {
        if (v === null) return `${pad}${k}: null`;
        if (typeof v === "object" && !Array.isArray(v)) {
          const inner = objectToYaml(v, indent + 1);
          return `${pad}${k}:\n${inner}`;
        }
        if (Array.isArray(v)) {
          if (v.length === 0) return `${pad}${k}: []`;
          if (v.every((x) => typeof x !== "object")) {
            return `${pad}${k}: [${v.map((x) => JSON.stringify(x)).join(", ")}]`;
          }
          return `${pad}${k}:${objectToYaml(v, indent + 1)}`;
        }
        return `${pad}${k}: ${typeof v === "string" ? JSON.stringify(v) : String(v)}`;
      })
      .join("\n") + "\n";
  }
  return String(obj);
}

main().then(() => process.exit(0));
