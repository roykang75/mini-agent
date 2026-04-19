/**
 * Goal schema types (ADR-009 Phase 1).
 *
 * Goal 은 markdown 파일로 persist — frontmatter 가 이 타입 집합을 serialize.
 * Status 전이 / subgoals / 진행 로그는 body 에서 관리.
 */

export type GoalStatus =
  | "draft"     // 작성 중, 아직 실행 불가
  | "active"    // controller 실행 중
  | "paused"    // budget 초과 / HIL / 실패 pending
  | "completed" // completion_criteria 전부 통과
  | "failed"    // controller 가 failed 로 마감 (paused 이후 human 판단)
  | "aborted";  // human 이 명시적 중단

export type HilPolicy = "strict" | "balanced" | "permissive";

export interface BudgetConfig {
  max_iterations: number;
  max_tokens: number;
  max_usd: number;
  wall_time_minutes: number;
}

export interface AutonomyConfig {
  allow_fs_write: string[];  // glob patterns
  deny_fs_write: string[];   // glob patterns (deny overrides allow)
  allow_shell: boolean | string[];  // true/false or explicit command list
  require_hil_before: string[];     // skill / action names
}

export interface ProgressState {
  iterations: number;
  tokens_used: number;
  usd_spent: number;
  started_at: string | null;   // ISO8601
  last_updated: string | null; // ISO8601
  retry_count: number;
}

// Completion criteria — discriminated union

export interface FileExistsCriterion {
  type: "file_exists";
  path: string;
}

export interface FileNotExistsCriterion {
  type: "file_not_exists";
  path: string;
}

export interface GrepCountCriterion {
  type: "grep_count";
  path: string;
  pattern: string;            // plain substring (v1) — regex 는 future
  min_count?: number;
  max_count?: number;
}

export interface GrepAbsentCriterion {
  type: "grep_absent";
  path: string;
  pattern: string;
}

export interface LlmPredicateCriterion {
  type: "llm_predicate";
  description: string;         // 자연어로 agent 가 평가할 명제
}

export type CompletionCriterion =
  | FileExistsCriterion
  | FileNotExistsCriterion
  | GrepCountCriterion
  | GrepAbsentCriterion
  | LlmPredicateCriterion;

export interface GoalFrontmatter {
  id: string;              // content-addressed hash
  slug: string;
  created: string;         // ISO8601
  created_by: string;      // "roy" | "agent:<sid>" (Phase 1 은 roy 만)
  status: GoalStatus;
  completion_criteria: CompletionCriterion[];
  budget: BudgetConfig;
  hil_policy: HilPolicy;
  autonomy_config: AutonomyConfig;
  progress: ProgressState;
  parent_goal: string | null;   // parent goal id (subgoal 의 경우), 최상위는 null
  persona: string;              // 기본 "autonomous-executor"
  final_approval?: "required" | "optional";
}

// Defaults — Roy 결정 반영 (iter 10 / $5 / 10 min, balanced, retry max 3)
export const DEFAULT_BUDGET: BudgetConfig = {
  max_iterations: 10,
  max_tokens: 200000,
  max_usd: 5.0,
  wall_time_minutes: 10,
};

export const DEFAULT_AUTONOMY: AutonomyConfig = {
  allow_fs_write: [],
  deny_fs_write: ["agent-memory/goals/**", "**/.env*", "**/*secret*", "**/*.key"],
  allow_shell: false,
  require_hil_before: ["fs_delete", "shell_run", "http_call_new_host"],
};

export const DEFAULT_PROGRESS: ProgressState = {
  iterations: 0,
  tokens_used: 0,
  usd_spent: 0,
  started_at: null,
  last_updated: null,
  retry_count: 0,
};

export const MAX_RETRY_COUNT = 3;
