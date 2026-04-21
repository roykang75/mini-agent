/**
 * Goal Controller (ADR-009 Phase 2).
 *
 * runGoal(goalPath): goal 을 load → iteration loop 를 돌며 AgentInstance 에게
 * context 를 전달 → 각 iter 후 completion/budget 검증 → complete or paused.
 *
 * AgentInstance 통합은 initial 버전에서 **injected dependency** 로 추상화 —
 * 실제 AgentInstance 연결은 run-goal.ts CLI (Phase 3) 에서. Phase 2 smoke 는
 * mock AgentInstance 로 검증.
 */

import type { LoadedGoal } from "./io";
import { loadGoal, saveGoal, appendProgress, setStatus } from "./io";
import type { CompletionReport } from "./completion/evaluate";
import { evaluateCompletion } from "./completion/evaluate";
import type { EvaluatorContext } from "./completion/types";
import { BudgetTracker, type BudgetBreachReason } from "./budget";
import { buildGoalSystemTail, buildIterationUserMessage, type IterationContext } from "./context";
import { loadRuntimeLimits } from "../config/limits";
import { maybeSpawnPostGoalHook } from "./post-goal-hook";

export interface IterationInput {
  goal: LoadedGoal;
  iteration: number;
  userMessage: string;
  systemTail: string;
}

export interface IterationOutput {
  iteration_summary: string;
  tokens_in: number;
  tokens_out: number;
  model: string;
  hil_checkpoint_triggered?: { reason: string; proposed_action: string };
  error?: string;
}

export type AgentRunner = (input: IterationInput) => Promise<IterationOutput>;

export interface RunGoalOptions {
  runIteration: AgentRunner;
  evaluatorContext: EvaluatorContext;
  now?: () => Date;
}

export interface RunGoalResult {
  final_status: "completed" | "paused" | "aborted";
  reason?: string;
  iterations_executed: number;
  budget_breached?: BudgetBreachReason;
  completion_report?: CompletionReport;
  hil_request?: { reason: string; proposed_action: string };
}

export async function runGoal(
  goalPath: string,
  opts: RunGoalOptions,
): Promise<RunGoalResult> {
  const now = opts.now ?? (() => new Date());

  let goal = await loadGoal(goalPath);
  if (goal.frontmatter.status !== "active") {
    throw new Error(`runGoal: goal status is "${goal.frontmatter.status}", must be "active"`);
  }
  const goalRetryMax = loadRuntimeLimits().retry.goal_retry_max;
  if (goal.frontmatter.progress.retry_count > goalRetryMax) {
    throw new Error(
      `runGoal: retry_count ${goal.frontmatter.progress.retry_count} > goal_retry_max ${goalRetryMax}. Human must reset.`,
    );
  }

  const tracker = new BudgetTracker(
    goal.frontmatter.budget,
    goal.frontmatter.progress,
    goal.frontmatter.progress.started_at
      ? new Date(goal.frontmatter.progress.started_at)
      : now(),
  );

  const systemTail = buildGoalSystemTail(goal, opts.evaluatorContext.workDir);
  let lastSummary: string | undefined;
  let lastHint: string | undefined;

  while (true) {
    const tickStatus = tracker.tickIteration();
    if (!tickStatus.within_limits) {
      await pauseGoal(goal, `budget breached: ${tickStatus.breached}`, now());
      maybeSpawnPostGoalHook(goalPath);
      return {
        final_status: "paused",
        reason: `budget_${tickStatus.breached}`,
        iterations_executed: tickStatus.checkpoint.iterations - 1,
        budget_breached: tickStatus.breached,
      };
    }
    const iteration = tickStatus.checkpoint.iterations;

    const wtStatus = tracker.checkWallTime(now());
    if (!wtStatus.within_limits) {
      await pauseGoal(goal, `wall_time exceeded`, now());
      maybeSpawnPostGoalHook(goalPath);
      return {
        final_status: "paused",
        reason: "budget_wall_time_minutes",
        iterations_executed: iteration - 1,
        budget_breached: "wall_time_minutes",
      };
    }

    const userMessage = buildIterationUserMessage(
      goal,
      { iteration, last_iteration_summary: lastSummary, completion_check_hint: lastHint },
      tickStatus.checkpoint,
    );

    let out: IterationOutput;
    try {
      out = await opts.runIteration({ goal, iteration, userMessage, systemTail });
    } catch (e) {
      await appendProgress(goal, `[iter ${iteration}] agent error: ${(e as Error).message}`, now());
      await pauseGoal(goal, `agent_error: ${(e as Error).message}`, now());
      maybeSpawnPostGoalHook(goalPath);
      return {
        final_status: "paused",
        reason: `agent_error: ${(e as Error).message}`,
        iterations_executed: iteration,
      };
    }

    tracker.addChatUsage(out.model, out.tokens_in, out.tokens_out);

    await appendProgress(
      goal,
      `[iter ${iteration}] ${out.iteration_summary.slice(0, 300)}`,
      now(),
    );
    lastSummary = out.iteration_summary;

    if (out.hil_checkpoint_triggered) {
      await appendProgress(
        goal,
        `[hil] reason: "${out.hil_checkpoint_triggered.reason}" proposed_action: "${out.hil_checkpoint_triggered.proposed_action}"`,
        now(),
      );
      await pauseGoal(goal, `hil_checkpoint: ${out.hil_checkpoint_triggered.reason}`, now());
      maybeSpawnPostGoalHook(goalPath);
      return {
        final_status: "paused",
        reason: `hil: ${out.hil_checkpoint_triggered.reason}`,
        iterations_executed: iteration,
        hil_request: out.hil_checkpoint_triggered,
      };
    }

    goal = await loadGoal(goalPath);
    const report = await evaluateCompletion(goal.frontmatter.completion_criteria, opts.evaluatorContext);
    if (report.passed) {
      await appendProgress(goal, `[completion] all criteria passed`, now());
      goal = await loadGoal(goalPath);
      await persistProgress(goal, tracker);
      await setStatus(await loadGoal(goalPath), "completed", "completion_criteria all pass", now());
      maybeSpawnPostGoalHook(goalPath);
      return {
        final_status: "completed",
        iterations_executed: iteration,
        completion_report: report,
      };
    } else {
      lastHint = `실패한 criterion ${report.failed_criteria.length}개:\n${report.failed_criteria
        .slice(0, 5)
        .map((f, i) => `${i + 1}. ${f.detail}`)
        .join("\n")}`;
      await appendProgress(
        goal,
        `[completion] ${report.failed_criteria.length} criteria failed`,
        now(),
      );
    }

    goal = await loadGoal(goalPath);
    await persistProgress(goal, tracker);
  }
}

async function pauseGoal(goal: LoadedGoal, reason: string, now: Date): Promise<void> {
  const loaded = await loadGoal(goal.path);
  await setStatus(loaded, "paused", reason, now);
}

async function persistProgress(goal: LoadedGoal, tracker: BudgetTracker): Promise<void> {
  const snap = tracker.snapshot();
  const updated: LoadedGoal = {
    ...goal,
    frontmatter: {
      ...goal.frontmatter,
      progress: {
        ...snap,
        retry_count: goal.frontmatter.progress.retry_count,
      },
    },
  };
  await saveGoal(updated);
}
