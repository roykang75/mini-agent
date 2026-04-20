import Link from "next/link";

import { listGoals, summarizeBudget } from "@/lib/goal/list";

export const dynamic = "force-dynamic";

const STATUS_COLOR: Record<string, string> = {
  draft: "bg-slate-100 text-slate-700",
  active: "bg-blue-100 text-blue-800",
  paused: "bg-amber-100 text-amber-800",
  completed: "bg-emerald-100 text-emerald-800",
  failed: "bg-rose-100 text-rose-800",
  aborted: "bg-neutral-200 text-neutral-700",
};

export default async function GoalsIndexPage() {
  const goals = await listGoals();

  return (
    <main className="mx-auto max-w-4xl px-6 py-10 font-sans">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Goals</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          ADR-009 autonomous goal execution. 각 카드를 눌러 상세/실행.
          HIL 로 paused 된 goal 은 상세에서 Reset → Run.
        </p>
      </header>

      {goals.length === 0 ? (
        <div className="rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
          goals/ 디렉토리가 비어 있거나 파싱 가능한 goal md 파일이 없습니다.
          <br />
          <code className="text-xs">AGENT_MEMORY_DIR</code> 확인:{" "}
          <code className="text-xs">{process.env.AGENT_MEMORY_DIR ?? "(unset)"}</code>
        </div>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {goals.map((g) => {
            const b = summarizeBudget(g);
            const cls =
              STATUS_COLOR[g.frontmatter.status] ?? "bg-slate-100 text-slate-700";
            return (
              <li key={g.frontmatter.id}>
                <Link
                  href={`/goals/${encodeURIComponent(g.frontmatter.slug)}`}
                  className="flex flex-col gap-2 px-4 py-3 hover:bg-accent/50"
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="font-mono text-sm">{g.frontmatter.slug}</span>
                    <span
                      className={`inline-block rounded-md px-2 py-0.5 text-xs font-medium ${cls}`}
                    >
                      {g.frontmatter.status}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <span>iter {b.iterations}</span>
                    <span>wall {b.wall}</span>
                    <span>cost {b.usd}</span>
                    <span>criteria {g.frontmatter.completion_criteria.length}</span>
                    {g.frontmatter.progress.last_updated && (
                      <span>
                        last{" "}
                        {new Date(
                          g.frontmatter.progress.last_updated,
                        ).toLocaleString("ko-KR")}
                      </span>
                    )}
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      <footer className="mt-8 text-xs text-muted-foreground">
        <p>
          새 goal 은 파일로 직접 작성:{" "}
          <code>agent-memory/goals/YYYY-MM-DD-&lt;slug&gt;.md</code>
        </p>
      </footer>
    </main>
  );
}
