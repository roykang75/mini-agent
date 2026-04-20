"use client";

import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";

interface GoalResponse {
  path: string;
  frontmatter: {
    id: string;
    slug: string;
    status: string;
    budget: { max_iterations: number; max_tokens: number; max_usd: number; wall_time_minutes: number };
    progress: { iterations: number; tokens_used: number; usd_spent: number; started_at: string | null; last_updated: string | null; retry_count: number };
    completion_criteria: Array<{ type: string } & Record<string, unknown>>;
    autonomy_config: { allow_fs_write: string[]; deny_fs_write: string[]; allow_shell: boolean | string[]; require_hil_before: string[] };
    hil_policy: string;
    persona: string;
  };
  body: string;
  fetched_at: string;
}

const STATUS_COLOR: Record<string, string> = {
  draft: "bg-slate-100 text-slate-700",
  active: "bg-blue-100 text-blue-800",
  paused: "bg-amber-100 text-amber-800",
  completed: "bg-emerald-100 text-emerald-800",
  failed: "bg-rose-100 text-rose-800",
  aborted: "bg-neutral-200 text-neutral-700",
};

export default function GoalDetailPage() {
  const params = useParams<{ slug: string }>();
  const slug = params.slug;
  const [goal, setGoal] = useState<GoalResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"run" | "reset" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const logRef = useRef<HTMLPreElement | null>(null);

  async function fetchGoal() {
    try {
      const r = await fetch(`/api/goals/${encodeURIComponent(slug)}`, { cache: "no-store" });
      if (!r.ok) {
        setError(`fetch failed: ${r.status}`);
        return;
      }
      const j = (await r.json()) as GoalResponse;
      setGoal(j);
      setError(null);
    } catch (e) {
      setError(`network: ${(e as Error).message}`);
    }
  }

  useEffect(() => {
    fetchGoal();
    const t = setInterval(fetchGoal, 2500);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [goal?.body]);

  async function postAction(action: "run" | "reset") {
    setBusy(action);
    setMessage(null);
    try {
      const r = await fetch(`/api/goals/${encodeURIComponent(slug)}/${action}`, {
        method: "POST",
      });
      const j = await r.json();
      if (!r.ok) {
        setMessage(`${action} failed (${r.status}): ${j.error ?? "unknown"}${j.hint ? ` — ${j.hint}` : ""}`);
      } else {
        setMessage(`${action} OK${j.goal_id ? ` (${j.goal_id})` : ""}`);
      }
      await fetchGoal();
    } catch (e) {
      setMessage(`${action} network error: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  if (error && !goal) {
    return (
      <main className="mx-auto max-w-4xl px-6 py-10 font-sans">
        <Link href="/goals" className="text-sm text-muted-foreground underline">
          ← goals
        </Link>
        <div className="mt-8 rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900">
          {error}
        </div>
      </main>
    );
  }

  if (!goal) {
    return (
      <main className="mx-auto max-w-4xl px-6 py-10 font-sans text-sm text-muted-foreground">
        loading {slug}…
      </main>
    );
  }

  const fm = goal.frontmatter;
  const b = fm.budget;
  const p = fm.progress;
  const elapsedMin = p.started_at ? (Date.now() - new Date(p.started_at).getTime()) / 60_000 : 0;
  const cls = STATUS_COLOR[fm.status] ?? "bg-slate-100 text-slate-700";

  const progressSectionMatch = goal.body.match(/## 진행 로그\n([\s\S]*)$/);
  const progressLog = progressSectionMatch?.[1]?.trim() ?? "(no entries yet)";

  const pausedReasonMatch = fm.status === "paused"
    ? goal.body.match(/\[hil\][^\n]*\n?[^\n]*\[status\] active → paused \(([^)]+)\)/)
    : null;

  return (
    <main className="mx-auto max-w-4xl px-6 py-10 font-sans">
      <Link href="/goals" className="text-sm text-muted-foreground underline">
        ← goals
      </Link>

      <header className="mt-4 mb-6 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="font-mono text-xl">{fm.slug}</h1>
          <p className="mt-1 text-xs text-muted-foreground">{fm.id} · persona: {fm.persona}</p>
        </div>
        <span className={`inline-block rounded-md px-2 py-0.5 text-xs font-medium ${cls}`}>
          {fm.status}
        </span>
      </header>

      {fm.status === "paused" && (
        <section className="mb-6 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm">
          <div className="font-semibold text-amber-900">Paused</div>
          <div className="mt-1 text-amber-800">
            {pausedReasonMatch?.[1] ?? "HIL 또는 budget breach. goal.md 의 진행 로그 참고."}
          </div>
          <div className="mt-2 text-xs text-amber-700">
            autonomy_config 를 편집해 정책을 바꾸거나 Reset 후 Run 으로 재개.
          </div>
        </section>
      )}

      <section className="mb-6 grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
        <Stat label="Iterations" value={`${p.iterations} / ${b.max_iterations}`} />
        <Stat label="Wall time" value={`${elapsedMin.toFixed(1)}m / ${b.wall_time_minutes}m`} />
        <Stat label="Spend" value={`$${p.usd_spent.toFixed(2)} / $${b.max_usd.toFixed(2)}`} />
        <Stat label="Retry" value={`${p.retry_count}`} />
      </section>

      <section className="mb-6 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy !== null || (fm.status !== "draft" && fm.status !== "active")}
          onClick={() => postAction("run")}
          className="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:bg-slate-300 disabled:text-slate-500"
          title={fm.status === "paused" ? "Reset 먼저" : "fire-and-forget 실행"}
        >
          {busy === "run" ? "kicking…" : "Run"}
        </button>
        <button
          type="button"
          disabled={busy !== null || fm.status !== "paused"}
          onClick={() => postAction("reset")}
          className="rounded-md border border-amber-500 px-4 py-1.5 text-sm font-medium text-amber-700 hover:bg-amber-50 disabled:border-slate-200 disabled:text-slate-400"
        >
          {busy === "reset" ? "resetting…" : "Reset to active"}
        </button>
        <span className="ml-auto text-xs text-muted-foreground self-center">
          polled {new Date(goal.fetched_at).toLocaleTimeString("ko-KR")}
        </span>
      </section>

      {message && (
        <div className="mb-4 rounded-md bg-slate-100 px-3 py-2 text-xs text-slate-700">
          {message}
        </div>
      )}

      <section className="mb-6">
        <h2 className="mb-2 text-sm font-semibold">Progress log</h2>
        <pre
          ref={logRef}
          className="max-h-[360px] overflow-auto rounded-md bg-neutral-950 px-3 py-2 font-mono text-xs leading-relaxed text-neutral-100"
        >
{progressLog}
        </pre>
      </section>

      <section className="mb-6">
        <h2 className="mb-2 text-sm font-semibold">Completion criteria</h2>
        <ul className="list-disc pl-5 text-xs text-muted-foreground">
          {fm.completion_criteria.map((c, i) => (
            <li key={i} className="font-mono">
              {JSON.stringify(c)}
            </li>
          ))}
        </ul>
      </section>

      <section className="mb-6">
        <h2 className="mb-2 text-sm font-semibold">Autonomy config</h2>
        <pre className="rounded-md bg-slate-50 px-3 py-2 font-mono text-xs leading-relaxed">
{`hil_policy: ${fm.hil_policy}
allow_fs_write: ${JSON.stringify(fm.autonomy_config.allow_fs_write)}
deny_fs_write:  ${JSON.stringify(fm.autonomy_config.deny_fs_write)}
allow_shell:    ${JSON.stringify(fm.autonomy_config.allow_shell)}
require_hil_before: ${JSON.stringify(fm.autonomy_config.require_hil_before)}`}
        </pre>
      </section>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-0.5 font-mono text-sm">{value}</div>
    </div>
  );
}
