/**
 * GET /api/goals/[slug] — 단일 goal 의 frontmatter + body 반환 (ADR-010 P1).
 *
 * UI 가 polling 으로 진행 로그 diff 를 받기 위한 엔드포인트.
 */

import { NextResponse } from "next/server";

import { loadGoalBySlug } from "@/lib/goal/list";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const goal = await loadGoalBySlug(slug);
  if (!goal) {
    return NextResponse.json({ error: "goal not found", slug }, { status: 404 });
  }
  return NextResponse.json({
    path: goal.path,
    frontmatter: goal.frontmatter,
    body: goal.body,
    fetched_at: new Date().toISOString(),
  });
}
