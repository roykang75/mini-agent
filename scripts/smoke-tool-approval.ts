/**
 * Smoke: tool-approval policy (ADR-009 P3 — auto-approve).
 *
 * decideToolApproval 의 각 규칙 단위 검증 + glob edge cases.
 */

import {
  decideToolApproval,
  globMatch,
  HIL_CHECKPOINT_TOOL,
} from "../src/lib/goal/tool-approval";
import { DEFAULT_AUTONOMY, type AutonomyConfig } from "../src/lib/goal/types";
import type { PendingToolCall } from "../src/lib/types";

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error(`[FAIL] ${msg}`);
    process.exit(1);
  }
}

function call(name: string, args: Record<string, unknown> = {}): PendingToolCall {
  return { toolUseId: `tool_${Math.random().toString(36).slice(2, 8)}`, name, args };
}

async function main() {
  // ─── glob matching ───
  assert(globMatch("**/.env*", ".env"), "glob: .env matches **/.env*");
  assert(globMatch("**/.env*", "apps/.env.local"), "glob: .env.local matches");
  assert(globMatch("**/.env*", ".env.production"), "glob: .env.production matches");
  assert(globMatch("**/*.key", "vault/private.key"), "glob: **/*.key nested");
  assert(globMatch("**/*secret*", "data/mysecretfile.md"), "glob: **/*secret* partial");
  assert(globMatch("agent-memory/goals/**", "agent-memory/goals/topic.md"), "glob: prefix dir");
  assert(!globMatch("agent-memory/goals/**", "agent-memory/knowledge/x.md"), "glob: wrong prefix");
  assert(globMatch("agent-memory/knowledge/**", "agent-memory/knowledge/a/b.md"), "glob: deep nest");
  assert(!globMatch("**/*.key", "key.txt"), "glob: .key anchor");
  assert(globMatch("foo.md", "./foo.md"), "glob: leading ./ stripped");

  // ─── hil_checkpoint always hil ───
  const r1 = decideToolApproval(
    [call(HIL_CHECKPOINT_TOOL, { reason: "user approval", proposed_action: "delete x" })],
    DEFAULT_AUTONOMY,
  );
  assert(r1.decision === "hil", "hil_checkpoint → hil");
  assert(r1.hil_trigger?.tool === HIL_CHECKPOINT_TOOL, "hil_trigger.tool");
  assert(r1.hil_trigger!.proposed_action.includes("delete x"), "hil_trigger carries agent reason");

  // ─── require_hil_before match ───
  const r2 = decideToolApproval([call("fs_delete", { path: "x" })], DEFAULT_AUTONOMY);
  assert(r2.decision === "hil", "fs_delete → hil (default require_hil_before)");
  assert(r2.hil_trigger!.reason.includes("require_hil_before"), "reason mentions require_hil_before");

  // ─── request_credential always hil ───
  const r3 = decideToolApproval(
    [call("request_credential", { key: "cia_token", description: "CIA token" })],
    DEFAULT_AUTONOMY,
  );
  assert(r3.decision === "hil", "request_credential → hil");

  // ─── write_file: deny beats allow ───
  const cfgAllowAll: AutonomyConfig = {
    allow_fs_write: ["**"],
    deny_fs_write: ["**/.env*"],
    allow_shell: false,
    require_hil_before: [],
  };
  const r4 = decideToolApproval([call("write_file", { path: "apps/.env" })], cfgAllowAll);
  assert(r4.decision === "hil", "write_file to .env → hil (deny match)");
  assert(r4.hil_trigger!.reason.includes("deny_fs_write"), "reason mentions deny_fs_write");

  // ─── write_file: allow match ───
  const r5 = decideToolApproval(
    [call("write_file", { path: "agent-memory/knowledge/topic.md" })],
    {
      ...cfgAllowAll,
      allow_fs_write: ["agent-memory/knowledge/**"],
      deny_fs_write: DEFAULT_AUTONOMY.deny_fs_write,
    },
  );
  assert(r5.decision === "auto_approve", "write_file allowed by glob → auto");

  // ─── write_file: empty allow → hil ───
  const r6 = decideToolApproval(
    [call("write_file", { path: "out.md" })],
    DEFAULT_AUTONOMY, // allow_fs_write: []
  );
  assert(r6.decision === "hil", "write_file with empty allow → hil");
  assert(r6.hil_trigger!.reason.includes("empty"), "reason mentions empty");

  // ─── write_file: allow non-empty but path outside ───
  const r7 = decideToolApproval(
    [call("write_file", { path: "other/foo.md" })],
    { ...DEFAULT_AUTONOMY, allow_fs_write: ["agent-memory/**"] },
  );
  assert(r7.decision === "hil", "write_file outside allow_fs_write → hil");
  assert(r7.hil_trigger!.reason.includes("outside"), "reason mentions outside");

  // ─── run_command with allow_shell=false ───
  const r8 = decideToolApproval(
    [call("run_command", { command: "ls -la" })],
    DEFAULT_AUTONOMY,
  );
  assert(r8.decision === "hil", "run_command with shell disabled → hil");

  // ─── run_command with allow_shell=true ───
  const r9 = decideToolApproval(
    [call("run_command", { command: "ls -la" })],
    { ...DEFAULT_AUTONOMY, allow_shell: true, require_hil_before: [] },
  );
  assert(r9.decision === "auto_approve", "run_command shell=true → auto");

  // ─── run_command with list — match ───
  const r10 = decideToolApproval(
    [call("run_command", { command: "grep -rn foo src/" })],
    { ...DEFAULT_AUTONOMY, allow_shell: ["grep", "ls"], require_hil_before: [] },
  );
  assert(r10.decision === "auto_approve", "grep in allow_shell list → auto");

  // ─── run_command with list — miss ───
  const r11 = decideToolApproval(
    [call("run_command", { command: "rm -rf /" })],
    { ...DEFAULT_AUTONOMY, allow_shell: ["grep", "ls"], require_hil_before: [] },
  );
  assert(r11.decision === "hil", "rm not in allow_shell list → hil");

  // ─── default auto: read_file / memory_search / http_call / ask_advisor ───
  for (const name of ["read_file", "memory_search", "http_call", "ask_advisor"]) {
    const r = decideToolApproval([call(name, {})], DEFAULT_AUTONOMY);
    assert(r.decision === "auto_approve", `${name} → auto by default`);
  }

  // ─── multi-call: all auto → auto ───
  const r12 = decideToolApproval(
    [call("read_file", { path: "a" }), call("memory_search", { query: "x" })],
    DEFAULT_AUTONOMY,
  );
  assert(r12.decision === "auto_approve", "all-auto batch → auto");

  // ─── multi-call: one hil → whole batch hil, first hil marked ───
  const r13 = decideToolApproval(
    [
      call("read_file", { path: "a" }),
      call("write_file", { path: "out.md" }), // hil (allow empty)
      call("read_file", { path: "b" }),
    ],
    DEFAULT_AUTONOMY,
  );
  assert(r13.decision === "hil", "batch with one hil → hil");
  assert(r13.hil_trigger!.tool === "write_file", "first hil = write_file");
  assert(r13.trace.length === 3, "trace all 3 calls");
  assert(r13.trace[0]!.decision === "auto", "trace[0] auto");
  assert(r13.trace[1]!.decision === "hil", "trace[1] hil");
  assert(r13.trace[2]!.decision === "auto", "trace[2] auto");

  // ─── write_file without path arg ───
  const r14 = decideToolApproval([call("write_file", {})], { ...DEFAULT_AUTONOMY, allow_fs_write: ["**"] });
  assert(r14.decision === "hil", "write_file missing path → hil");
  assert(r14.hil_trigger!.reason.includes("missing path"), "reason missing path");

  // ─── run_command empty command ───
  const r15 = decideToolApproval(
    [call("run_command", {})],
    { ...DEFAULT_AUTONOMY, allow_shell: ["grep"], require_hil_before: [] },
  );
  assert(r15.decision === "hil", "run_command missing command → hil");

  // ─── absolute path that resolves inside cwd → deny glob must match ───
  {
    const cwd = "/tmp/smoke-test-cwd";
    const r = decideToolApproval(
      [call("write_file", { path: `${cwd}/agent-memory/goals/hijack.md` })],
      {
        allow_fs_write: ["**"],
        deny_fs_write: ["agent-memory/goals/**"],
        allow_shell: false,
        require_hil_before: [],
      },
      { cwd },
    );
    assert(r.decision === "hil", "absolute-path bypass blocked: cwd-relative deny glob matches");
    assert(
      r.hil_trigger!.reason.includes("deny_fs_write"),
      `absolute-path deny reason surfaces: ${r.hil_trigger!.reason}`,
    );
  }

  // ─── path outside cwd → hil (escapes workdir) ───
  {
    const r = decideToolApproval(
      [call("write_file", { path: "/etc/passwd" })],
      { allow_fs_write: ["**"], deny_fs_write: [], allow_shell: false, require_hil_before: [] },
      { cwd: "/tmp/smoke-test-cwd" },
    );
    assert(r.decision === "hil", "cwd-escape path → hil");
    assert(
      r.hil_trigger!.reason.includes("escapes workdir"),
      `escape reason: ${r.hil_trigger!.reason}`,
    );
  }

  // ─── relative "../" path also escapes ───
  {
    const r = decideToolApproval(
      [call("write_file", { path: "../../../outside.md" })],
      { allow_fs_write: ["**"], deny_fs_write: [], allow_shell: false, require_hil_before: [] },
      { cwd: "/tmp/smoke-test-cwd" },
    );
    assert(r.decision === "hil", "../../.. relative escape → hil");
  }

  console.log("[OK] smoke-tool-approval — 37 assertions passed");
}

main().then(() => process.exit(0));
