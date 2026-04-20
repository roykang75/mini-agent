/**
 * POST /api/goals/[slug]/reset — paused → active 전이 (ADR-010 P1).
 *
 * HIL 이나 budget breach 로 paused 된 goal 을 Roy 가 UI 에서 "Reset" 버튼으로
 * 재개 가능하게 하는 엔드포인트. setStatus 의 전이 규칙에 위배되면 400.
 */

import { NextResponse } from "next/server";

import { loadGoalBySlug } from "@/lib/goal/list";
import { loadGoal, resetProgress, setStatus } from "@/lib/goal/io";

export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const goal = await loadGoalBySlug(slug);
  if (!goal) {
    return NextResponse.json({ error: "goal not found", slug }, { status: 404 });
  }
  if (goal.frontmatter.status !== "paused") {
    return NextResponse.json(
      {
        error: `refuse: status must be paused, got "${goal.frontmatter.status}"`,
      },
      { status: 409 },
    );
  }
  const reloaded = await loadGoal(goal.path);
  try {
    // 1) progress 클리어 (started_at/iterations/usd/tokens → 0). retry_count 보존.
    //    이게 없으면 이전 started_at 이 유지되어 BudgetTracker 가 옛 wall clock 으로
    //    출발 → 즉시 wall_time exceeded 루프.
    const afterReset = await resetProgress(reloaded);
    // 2) paused → active 전이.
    await setStatus(afterReset, "active", "UI reset (human approval)");
  } catch (e) {
    return NextResponse.json(
      { error: `setStatus failed: ${(e as Error).message}` },
      { status: 400 },
    );
  }
  const after = await loadGoalBySlug(slug);
  return NextResponse.json({
    slug,
    status: after?.frontmatter.status,
    reset_at: new Date().toISOString(),
  });
}
