/**
 * Tool auto-approval policy for ADR-009 autonomous execution.
 *
 * AgentRunner 가 tool_approval_request 이벤트를 받으면 이 모듈로 판정.
 *  - auto_approve → 같은 턴에 resumeAfterApproval(true) 호출
 *  - hil → goal 을 paused 로 승격하고 iteration 종료
 *
 * Policy 원천은 goal.frontmatter.autonomy_config. Agent 는 정책을 모르고
 * tool_use 를 그대로 요청하며, AgentRunner 가 외부 판정자. ADR-009 원칙
 * "HIL 정책은 학습 대상 아님" 의 기계 표현.
 *
 * 지원 규칙:
 *  - hil_checkpoint          → 항상 hil (controller 가 hil signal 로 승격)
 *  - require_hil_before 매치 → hil
 *  - request_credential      → hil (user 입력 필요)
 *  - write_file              → deny_fs_write 매치 | allow_fs_write 빈 배열 | 매치 없음 → hil
 *                              deny 가 allow 보다 우선
 *  - run_command             → allow_shell=false → hil
 *                              true → auto
 *                              string[] → command 첫 토큰 매치
 *  - 그 외 (read_file, memory_search, http_call, ask_advisor...) → auto
 */

import { resolve as resolvePath, relative as relativePath } from "node:path";

import type { AutonomyConfig } from "./types";
import type { PendingToolCall } from "../types";

export const HIL_CHECKPOINT_TOOL = "hil_checkpoint";

export interface DecideOptions {
  /** Base working directory used to normalize `write_file` paths. Default: process.cwd(). */
  cwd?: string;
  /**
   * goal 전용 working notes 파일의 cwd-relative 경로. 매치 시 deny_fs_write 는
   * 여전히 체크하되 allow_fs_write 없이도 auto-approve. Stage 5 (2026-04-21) —
   * agent 가 iter 간 자기 노트를 축적할 수 있도록 하는 fixed scratchpad slot.
   */
  workingNotesPath?: string;
}

export interface ApprovalDecision {
  decision: "auto_approve" | "hil";
  /** Set when decision === "hil": the first tool that tripped HIL. */
  hil_trigger?: {
    tool: string;
    reason: string;
    proposed_action: string;
  };
  /** Per-call trace for logging / debugging. */
  trace: Array<{ tool: string; decision: "auto" | "hil"; reason: string }>;
}

export function decideToolApproval(
  toolCalls: readonly PendingToolCall[],
  autonomy: AutonomyConfig,
  opts: DecideOptions = {},
): ApprovalDecision {
  const cwd = opts.cwd ?? process.cwd();
  const workingNotesPath = opts.workingNotesPath;
  const trace: ApprovalDecision["trace"] = [];
  let hilFirst: ApprovalDecision["hil_trigger"];

  for (const tc of toolCalls) {
    const r = evaluateOne(tc, autonomy, cwd, workingNotesPath);
    trace.push({ tool: tc.name, decision: r.allow ? "auto" : "hil", reason: r.reason });
    if (!r.allow && !hilFirst) {
      hilFirst = {
        tool: tc.name,
        reason: r.reason,
        proposed_action: describeAction(tc),
      };
    }
  }

  return {
    decision: hilFirst ? "hil" : "auto_approve",
    hil_trigger: hilFirst,
    trace,
  };
}

interface SingleEval {
  allow: boolean;
  reason: string;
}

function evaluateOne(
  tc: PendingToolCall,
  autonomy: AutonomyConfig,
  cwd: string,
  workingNotesPath?: string,
): SingleEval {
  if (tc.name === HIL_CHECKPOINT_TOOL) {
    return { allow: false, reason: "hil_checkpoint — explicit agent request" };
  }
  if (autonomy.require_hil_before.includes(tc.name)) {
    return { allow: false, reason: `tool "${tc.name}" in require_hil_before list` };
  }
  if (tc.name === "request_credential") {
    return { allow: false, reason: "credential input requires user" };
  }

  if (tc.name === "write_file") {
    const rawPath = typeof tc.args.path === "string" ? tc.args.path : "";
    if (!rawPath) return { allow: false, reason: "write_file missing path arg" };

    // Normalize to cwd-relative so absolute-path bypass is closed.
    // `/Users/.../agent-memory/goals/x` → `agent-memory/goals/x` 매칭.
    // cwd 밖 (`..` 로 시작) 은 무조건 hil — 명시적으로 허용 안 된 영역.
    const abs = resolvePath(cwd, rawPath);
    const norm = relativePath(cwd, abs);
    if (norm.startsWith("..") || norm === "") {
      return { allow: false, reason: `path escapes workdir: "${rawPath}"` };
    }

    const denied = autonomy.deny_fs_write.find((g) => globMatch(g, norm));
    if (denied) return { allow: false, reason: `path matches deny_fs_write "${denied}"` };

    // Stage 5 — working notes 고정 slot. deny 는 체크했고, 여기서만 allow 우회.
    if (workingNotesPath && norm === workingNotesPath) {
      return { allow: true, reason: `working_notes slot "${workingNotesPath}"` };
    }

    if (autonomy.allow_fs_write.length === 0) {
      return { allow: false, reason: "allow_fs_write empty — no writes permitted" };
    }
    const allowed = autonomy.allow_fs_write.find((g) => globMatch(g, norm));
    if (!allowed) return { allow: false, reason: `path outside allow_fs_write` };

    return { allow: true, reason: `write allowed by "${allowed}"` };
  }

  if (tc.name === "run_command") {
    if (autonomy.allow_shell === false) return { allow: false, reason: "shell disabled" };
    if (autonomy.allow_shell === true) return { allow: true, reason: "shell open" };
    // 주의: 여기의 string[] allowlist 는 "첫 토큰" 만 매칭한다.
    // `grep foo && rm -rf /` / `bash -c '...'` / `FOO=bar rm file` 처럼 shell
    // operator 나 wrapper 로 쉽게 우회된다. 즉 이 경로는 "완전 open 보다 약간의
    // hint" 수준의 가드일 뿐 안전 샌드박스가 아니다. 안전 실행이 필요하면
    // run_command 를 require_hil_before 로 돌려 HIL 을 강제하라.
    const cmd = typeof tc.args.command === "string" ? tc.args.command.trim() : "";
    if (!cmd) return { allow: false, reason: "run_command missing command arg" };
    const first = cmd.split(/\s+/)[0]!;
    if (autonomy.allow_shell.includes(first)) {
      return { allow: true, reason: `command "${first}" in allow_shell` };
    }
    return { allow: false, reason: `command "${first}" not in allow_shell` };
  }

  return { allow: true, reason: "default auto (read/network/introspection)" };
}

function describeAction(tc: PendingToolCall): string {
  if (tc.name === "write_file") {
    const p = typeof tc.args.path === "string" ? tc.args.path : "?";
    return `write_file path="${p}"`;
  }
  if (tc.name === "run_command") {
    const c = typeof tc.args.command === "string" ? tc.args.command : "?";
    return `run_command "${c.slice(0, 120)}"`;
  }
  if (tc.name === HIL_CHECKPOINT_TOOL) {
    const r = typeof tc.args.reason === "string" ? tc.args.reason : "?";
    const a = typeof tc.args.proposed_action === "string" ? tc.args.proposed_action : "?";
    return `hil_checkpoint reason="${r}" action="${a}"`;
  }
  return `${tc.name}(${JSON.stringify(tc.args).slice(0, 120)})`;
}

// ─────────────────────────── glob helpers ───────────────────────────

/**
 * Minimal glob-to-regex for path matching.
 *   - `**` matches any characters including `/`
 *   - `**\/` collapses zero-or-more path segments
 *   - `*`  matches any non-slash chars
 *   - `?`  matches exactly one non-slash char
 * No brace expansion, no extglob. Case-sensitive. Leading "./" stripped.
 */
export function globMatch(pattern: string, path: string): boolean {
  const p = path.startsWith("./") ? path.slice(2) : path;
  const re = globToRegex(pattern);
  return re.test(p);
}

function globToRegex(pattern: string): RegExp {
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 3;
          continue;
        }
        out += ".*";
        i += 2;
        continue;
      }
      out += "[^/]*";
      i++;
      continue;
    }
    if (c === "?") {
      out += "[^/]";
      i++;
      continue;
    }
    if (/[.+^${}()|[\]\\]/.test(c)) {
      out += "\\" + c;
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return new RegExp(`^${out}$`);
}
