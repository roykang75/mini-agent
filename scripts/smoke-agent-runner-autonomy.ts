/**
 * Smoke: agent-runner auto-approve resume loop + live autonomy reload
 * (ADR-009 P3 blocker fix).
 *
 * Fake AgentLike 로 AgentInstance 실제 LLM 없이 runner 의 loop 을 검증:
 *   - 시나리오 A: write_file allowed → tool_approval_request → auto_approve →
 *                 resumeAfterApproval(true) → done. iteration_summary 채워짐.
 *   - 시나리오 B: write_file path denied → hil 승격. hil_trigger 에 path 표현.
 *   - 시나리오 C: agent 가 hil_checkpoint 호출 → agent 의 reason 이
 *                 hil_trigger 에 보존 (policy fallback 아님).
 *   - 시나리오 D: live reload — iter 시작 직후 goal 을 수정 시뮬레이션하여
 *                 loadAutonomyFn 이 반환하는 최신 값으로 판정되는지.
 */

import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { createAgentRunner, type AgentLike } from "../src/lib/goal/agent-runner";
import type { AgentEvent, PendingToolCall } from "../src/lib/types";
import type { LoadedGoal } from "../src/lib/goal/io";
import {
  DEFAULT_BUDGET,
  DEFAULT_AUTONOMY,
  DEFAULT_PROGRESS,
  type AutonomyConfig,
  type GoalFrontmatter,
} from "../src/lib/goal/types";

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error(`[FAIL] ${msg}`);
    process.exit(1);
  }
}

function makeLoadedGoal(autonomy: AutonomyConfig, pathOnDisk: string): LoadedGoal {
  const fm: GoalFrontmatter = {
    id: "goal-test",
    slug: "test",
    created: "2026-04-20T00:00:00Z",
    created_by: "roy",
    status: "active",
    completion_criteria: [{ type: "file_exists", path: "out.md" }],
    budget: DEFAULT_BUDGET,
    hil_policy: "balanced",
    autonomy_config: autonomy,
    progress: { ...DEFAULT_PROGRESS, started_at: "2026-04-20T00:00:00Z" },
    parent_goal: null,
    persona: "autonomous-executor",
  };
  return { path: pathOnDisk, frontmatter: fm, body: "" };
}

/** Build an AgentLike that emits a predetermined script of events per receive/resume. */
function fakeAgent(scripts: AgentEvent[][]): AgentLike {
  let turn = 0;
  async function* next(): AsyncGenerator<AgentEvent> {
    const batch = scripts[turn++] ?? [];
    for (const ev of batch) yield ev;
  }
  return {
    receive: () => next(),
    resumeAfterApproval: () => next(),
  };
}

function toolApproval(name: string, args: Record<string, unknown>): AgentEvent {
  const tc: PendingToolCall = {
    toolUseId: `tool_${randomUUID().slice(0, 8)}`,
    name,
    args,
  };
  return { type: "tool_approval_request", sessionId: `session_${randomUUID().slice(0, 8)}`, toolCalls: [tc] };
}

async function main() {
  const tmp = join(tmpdir(), `smoke-agent-runner-autonomy-${Date.now()}`);
  mkdirSync(tmp, { recursive: true });
  const goalPath = join(tmp, "goal.md");
  writeFileSync(goalPath, "placeholder (runner uses injected loadAutonomyFn in tests)");

  // ─── Scenario A: auto-approve resume ───
  {
    const autonomy: AutonomyConfig = {
      allow_fs_write: ["out.md"],
      deny_fs_write: ["**/.env*"],
      allow_shell: false,
      require_hil_before: [],
    };
    const goal = makeLoadedGoal(autonomy, goalPath);

    const agent = fakeAgent([
      // receive() → text + tool_call + tool_approval_request
      [
        { type: "text_delta", delta: "I'll write the file. " },
        { type: "tool_call", name: "write_file", args: { path: "out.md", content: "hello" } },
        toolApproval("write_file", { path: "out.md", content: "hello" }),
      ],
      // resume() → tool_result + final text + done
      [
        { type: "tool_result", name: "write_file", output: "ok" },
        { type: "message", content: "Done — file written." },
        { type: "done" },
      ],
    ]);

    const runner = createAgentRunner(
      {},
      {
        summonFn: async () => agent,
        loadAutonomyFn: async () => autonomy,
      },
    );
    const out = await runner({
      goal,
      iteration: 1,
      userMessage: "write a file",
      systemTail: "SYSTEM",
    });
    assert(out.hil_checkpoint_triggered === undefined, "A: no hil (auto approved)");
    assert(out.error === undefined, "A: no error");
    assert(
      out.iteration_summary.includes("Done") || out.iteration_summary.includes("write the file"),
      `A: summary captured: ${out.iteration_summary}`,
    );
  }

  // ─── Scenario B: denied path → hil ───
  {
    const autonomy: AutonomyConfig = {
      allow_fs_write: ["allowed/**"],
      deny_fs_write: ["**/.env*"],
      allow_shell: false,
      require_hil_before: [],
    };
    const goal = makeLoadedGoal(autonomy, goalPath);

    const agent = fakeAgent([
      [
        { type: "tool_call", name: "write_file", args: { path: "forbidden/.env" } },
        toolApproval("write_file", { path: "forbidden/.env" }),
      ],
    ]);

    const runner = createAgentRunner(
      {},
      { summonFn: async () => agent, loadAutonomyFn: async () => autonomy },
    );
    const out = await runner({
      goal,
      iteration: 1,
      userMessage: "try",
      systemTail: "SYSTEM",
    });
    assert(out.hil_checkpoint_triggered !== undefined, "B: hil triggered");
    assert(
      out.hil_checkpoint_triggered!.reason.includes("deny_fs_write"),
      `B: reason mentions deny_fs_write, got: ${out.hil_checkpoint_triggered!.reason}`,
    );
    assert(
      out.hil_checkpoint_triggered!.proposed_action.includes("forbidden/.env"),
      `B: proposed_action has path`,
    );
  }

  // ─── Scenario C: hil_checkpoint with rich reason preserved ───
  {
    const autonomy = DEFAULT_AUTONOMY;
    const goal = makeLoadedGoal(autonomy, goalPath);

    const agent = fakeAgent([
      [
        {
          type: "tool_call",
          name: "hil_checkpoint",
          args: { reason: "needs explicit approval", proposed_action: "delete orphan file" },
        },
        toolApproval("hil_checkpoint", {
          reason: "needs explicit approval",
          proposed_action: "delete orphan file",
        }),
      ],
    ]);

    const runner = createAgentRunner(
      {},
      { summonFn: async () => agent, loadAutonomyFn: async () => autonomy },
    );
    const out = await runner({
      goal,
      iteration: 1,
      userMessage: "ask",
      systemTail: "SYSTEM",
    });
    assert(out.hil_checkpoint_triggered !== undefined, "C: hil triggered");
    assert(
      out.hil_checkpoint_triggered!.reason === "needs explicit approval",
      `C: agent reason preserved: ${out.hil_checkpoint_triggered!.reason}`,
    );
    assert(
      out.hil_checkpoint_triggered!.proposed_action === "delete orphan file",
      `C: agent proposed_action preserved`,
    );
  }

  // ─── Scenario D: live reload — snapshot says allowed, fresh says denied ───
  {
    const snapshotAutonomy: AutonomyConfig = {
      allow_fs_write: ["**"],
      deny_fs_write: [],
      allow_shell: false,
      require_hil_before: [],
    };
    const liveAutonomy: AutonomyConfig = {
      allow_fs_write: ["**"],
      deny_fs_write: ["**/secret.md"],
      allow_shell: false,
      require_hil_before: [],
    };
    const goal = makeLoadedGoal(snapshotAutonomy, goalPath);

    const agent = fakeAgent([
      [
        { type: "tool_call", name: "write_file", args: { path: "secret.md" } },
        toolApproval("write_file", { path: "secret.md" }),
      ],
    ]);

    const runner = createAgentRunner(
      {},
      {
        summonFn: async () => agent,
        // 실행 시점에는 Roy 가 goal.md 를 live 수정 → deny 추가된 상태를 흉내낸다.
        loadAutonomyFn: async () => liveAutonomy,
      },
    );
    const out = await runner({
      goal,
      iteration: 1,
      userMessage: "x",
      systemTail: "SYSTEM",
    });
    assert(out.hil_checkpoint_triggered !== undefined, "D: live reload caught added deny");
    assert(
      out.hil_checkpoint_triggered!.reason.includes("deny_fs_write"),
      `D: reason from live config`,
    );
  }

  // ─── Scenario E: loadAutonomyFn throws → fail-closed (hil), Roy 철학 준수 ───
  {
    const autonomy: AutonomyConfig = {
      allow_fs_write: ["**"],
      deny_fs_write: [],
      allow_shell: false,
      require_hil_before: [],
    };
    const goal = makeLoadedGoal(autonomy, goalPath);

    const agent = fakeAgent([
      [
        { type: "tool_call", name: "read_file", args: { path: "x.md" } },
        toolApproval("read_file", { path: "x.md" }),
      ],
    ]);

    const runner = createAgentRunner(
      {},
      {
        summonFn: async () => agent,
        loadAutonomyFn: async () => {
          throw new Error("simulated reload failure");
        },
      },
    );
    const out = await runner({
      goal,
      iteration: 1,
      userMessage: "read",
      systemTail: "SYSTEM",
    });
    assert(out.hil_checkpoint_triggered !== undefined, "E: reload fail → hil (fail-closed)");
    assert(
      out.hil_checkpoint_triggered!.reason.includes("autonomy_reload_failed"),
      `E: reason mentions autonomy_reload_failed, got: ${out.hil_checkpoint_triggered!.reason}`,
    );
    assert(out.error === undefined, "E: runner does not crash on reload failure");
  }

  rmSync(tmp, { recursive: true, force: true });
  console.log("[OK] smoke-agent-runner-autonomy — 5 scenarios, 15 assertions passed");
}

main().then(() => process.exit(0));
