import { NextResponse } from "next/server";
import { getSkillTools } from "@/lib/skills/loader";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const tools = getSkillTools();
  return NextResponse.json({
    count: tools.length,
    tools: tools.map((t) => ({ name: t.name, description: t.description })),
  });
}