/**
 * Budget tracker (ADR-009 Phase 2).
 *
 * Goal 의 4 차원 limit (max_iterations / max_tokens / max_usd / wall_time_minutes)
 * 을 추적. 먼저 도달한 limit 이 controller 의 stop 트리거.
 *
 * Token → USD 계산은 모델별 price table. 초기엔 claude-sonnet-4-6 만 지원.
 * 모델 추가는 MODEL_PRICES 확장.
 */

import type { BudgetConfig, ProgressState } from "./types";

export interface BudgetCheckpoint {
  iterations: number;
  tokens_used: number;
  usd_spent: number;
  wall_time_elapsed_min: number;
  started_at: Date;
}

export type BudgetBreachReason =
  | "max_iterations"
  | "max_tokens"
  | "max_usd"
  | "wall_time_minutes";

export interface BudgetStatus {
  within_limits: boolean;
  breached?: BudgetBreachReason;
  checkpoint: BudgetCheckpoint;
}

const MODEL_PRICES: Record<string, { in_per_mtok: number; out_per_mtok: number }> = {
  "claude-sonnet-4-6": { in_per_mtok: 3, out_per_mtok: 15 },
  "claude-sonnet-4-5": { in_per_mtok: 3, out_per_mtok: 15 },
  "claude-opus-4-7": { in_per_mtok: 15, out_per_mtok: 75 },
  "claude-opus-4-6": { in_per_mtok: 15, out_per_mtok: 75 },
  "claude-haiku-4-5-20251001": { in_per_mtok: 0.8, out_per_mtok: 4 },
  "gpt-4o": { in_per_mtok: 2.5, out_per_mtok: 10 },
  "gpt-5.4": { in_per_mtok: 5, out_per_mtok: 15 },
};

export function usdForChat(
  model: string,
  tokens_in: number,
  tokens_out: number,
): number {
  const p = MODEL_PRICES[model];
  if (!p) {
    return (tokens_in * 15 + tokens_out * 75) / 1_000_000;
  }
  return (tokens_in * p.in_per_mtok + tokens_out * p.out_per_mtok) / 1_000_000;
}

export class BudgetTracker {
  private cp: BudgetCheckpoint;

  constructor(
    public readonly budget: BudgetConfig,
    initial?: ProgressState,
    startedAt: Date = new Date(),
  ) {
    this.cp = {
      iterations: initial?.iterations ?? 0,
      tokens_used: initial?.tokens_used ?? 0,
      usd_spent: initial?.usd_spent ?? 0,
      wall_time_elapsed_min: 0,
      started_at: startedAt,
    };
  }

  tickIteration(): BudgetStatus {
    this.cp.iterations += 1;
    return this.check();
  }

  addChatUsage(model: string, tokens_in: number, tokens_out: number): BudgetStatus {
    this.cp.tokens_used += tokens_in + tokens_out;
    this.cp.usd_spent += usdForChat(model, tokens_in, tokens_out);
    return this.check();
  }

  checkWallTime(now: Date = new Date()): BudgetStatus {
    this.cp.wall_time_elapsed_min =
      (now.getTime() - this.cp.started_at.getTime()) / 60_000;
    return this.check();
  }

  snapshot(): ProgressState {
    return {
      iterations: this.cp.iterations,
      tokens_used: this.cp.tokens_used,
      usd_spent: Number(this.cp.usd_spent.toFixed(4)),
      started_at: this.cp.started_at.toISOString(),
      last_updated: new Date().toISOString(),
      retry_count: 0,
    };
  }

  private check(): BudgetStatus {
    const b = this.budget;
    let breached: BudgetBreachReason | undefined;
    if (this.cp.iterations > b.max_iterations) breached = "max_iterations";
    else if (this.cp.tokens_used > b.max_tokens) breached = "max_tokens";
    else if (this.cp.usd_spent > b.max_usd) breached = "max_usd";
    else if (this.cp.wall_time_elapsed_min > b.wall_time_minutes) breached = "wall_time_minutes";
    return {
      within_limits: breached === undefined,
      breached,
      checkpoint: { ...this.cp },
    };
  }
}
