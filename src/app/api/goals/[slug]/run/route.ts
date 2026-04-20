/**
 * POST /api/goals/[slug]/run — goal 실행을 백그라운드 kick (ADR-010 P1).
 *
 * fire-and-forget: runGoal 을 await 하지 않고 202 즉시 반환. 진행은 goal.md
 * 에 land — UI 는 polling 으로 관찰.
 *
 * 같은 goal 중복 실행은 in-process Set 으로 차단. Process restart 시 Set 은
 * 초기화되지만, 실제 runner 도 같이 죽으므로 무해.
 */

import { NextResponse } from "next/server";

import { loadGoalBySlug } from "@/lib/goal/list";
import { loadGoal, setStatus } from "@/lib/goal/io";
import { runGoal } from "@/lib/goal/controller";
import { createAgentRunner } from "@/lib/goal/agent-runner";
import { createLogger } from "@/lib/log";

const log = createLogger("route");

export const dynamic = "force-dynamic";

const activeRuns = new Set<string>();

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const goal = await loadGoalBySlug(slug);
  if (!goal) {
    return NextResponse.json({ error: "goal not found", slug }, { status: 404 });
  }
  if (activeRuns.has(slug)) {
    return NextResponse.json(
      { error: "already running", slug },
      { status: 409 },
    );
  }

  // Auto-activate draft; paused 는 reset 이 필요 (명시적 Roy 승인).
  if (goal.frontmatter.status === "draft") {
    await setStatus(goal, "active", "UI auto-activate");
  } else if (goal.frontmatter.status !== "active") {
    return NextResponse.json(
      {
        error: `refuse: status must be active or draft, got "${goal.frontmatter.status}"`,
        hint: "POST /api/goals/[slug]/reset to transition paused → active",
      },
      { status: 409 },
    );
  }

  const workDir = process.env.GOAL_WORK_DIR ?? process.cwd();
  const reloaded = await loadGoal(goal.path);

  activeRuns.add(slug);
  // Fire-and-forget — Next.js dev 에서 Node process 가 long-lived 라 OK.
  void runGoal(reloaded.path, {
    runIteration: createAgentRunner({}),
    evaluatorContext: { workDir },
  })
    .then((result) => {
      log.info(
        {
          event: "goal_run_finished",
          slug,
          final_status: result.final_status,
          iterations: result.iterations_executed,
          reason: result.reason,
        },
        `goal ${slug} → ${result.final_status}`,
      );
    })
    .catch((e) => {
      log.warn(
        { event: "goal_run_threw", slug, err_message: (e as Error).message },
        `goal ${slug} run threw`,
      );
    })
    .finally(() => {
      activeRuns.delete(slug);
    });

  return NextResponse.json(
    {
      slug,
      goal_id: reloaded.frontmatter.id,
      status: "started",
      work_dir: workDir,
      started_at: new Date().toISOString(),
    },
    { status: 202 },
  );
}
