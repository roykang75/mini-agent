import Link from "next/link";
import { notFound } from "next/navigation";
import { loadProfile, type ProfileCell } from "@/lib/profile/load";

const CURRICULUM_DIR =
  process.env.CURRICULUM_DIR ?? "/Users/roy/Workspace/agent/agent-curriculum";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ model: string }>;
}

function severity(c: ProfileCell): "weak" | "unstable" | "stable" {
  if (c.behavior_mismatch_rate >= 0.5) return "weak";
  if (c.behavior_mismatch_rate >= 0.2) return "unstable";
  return "stable";
}

function severityStyle(s: ReturnType<typeof severity>): string {
  switch (s) {
    case "weak":
      return "border-l-red-500 bg-red-500/5";
    case "unstable":
      return "border-l-amber-500 bg-amber-500/5";
    case "stable":
      return "border-l-emerald-500 bg-emerald-500/5";
  }
}

function pct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

export default async function ProfileModelPage({ params }: PageProps) {
  const { model } = await params;
  const decoded = decodeURIComponent(model);
  const profile = await loadProfile(decoded, CURRICULUM_DIR);
  if (!profile) notFound();

  const sorted = [...profile.cells].sort(
    (a, b) => b.behavior_mismatch_rate - a.behavior_mismatch_rate,
  );

  return (
    <main className="mx-auto max-w-4xl px-6 py-10 font-sans">
      <header className="mb-8">
        <Link
          href="/profile"
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          ← all profiles
        </Link>
        <h1 className="mt-2 font-mono text-xl font-semibold">{profile.model}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {profile.cell_count} cells · generated{" "}
          {profile.generated_at.slice(0, 19).replace("T", " ")}
        </p>
        <p className="mt-3 text-xs text-muted-foreground">
          명령조 금지 — 이 자료는 agent 를 교정하는 용도가 아니라, Roy 가
          모델의 L3 default 를 관찰하는 용도 (ADR-008).
        </p>
      </header>

      <ul className="space-y-3">
        {sorted.map((cell) => {
          const sev = severity(cell);
          return (
            <li
              key={cell.problem_id}
              className={`rounded-md border border-border border-l-4 px-4 py-3 ${severityStyle(sev)}`}
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div>
                  <div className="font-mono text-sm">{cell.problem_id}</div>
                  <div className="text-sm">{cell.short}</div>
                </div>
                <div className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-muted-foreground">
                  <span className="rounded bg-muted px-1.5 py-0.5">{cell.domain}</span>
                  <span className="rounded bg-muted px-1.5 py-0.5">
                    default: {cell.default_behavior}
                  </span>
                </div>
              </div>

              <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-4">
                <Stat label="mismatch" value={pct(cell.behavior_mismatch_rate)} bold />
                <Stat label="called" value={pct(cell.advisor_called_rate)} />
                <Stat label="needed" value={pct(cell.advisor_needed_rate)} />
                <Stat label="correct" value={pct(cell.correct_rate)} />
                <Stat label="partial" value={pct(cell.partial_rate)} />
                <Stat label="wrong" value={pct(cell.wrong_rate)} />
                <Stat label="conf" value={cell.mean_confidence.toFixed(2)} />
                <Stat label="runs" value={String(cell.runs_total)} />
              </dl>

              {cell.note && (
                <p className="mt-2 text-xs text-muted-foreground">{cell.note}</p>
              )}
            </li>
          );
        })}
      </ul>

      <footer className="mt-8 flex items-center justify-between text-xs text-muted-foreground">
        <span>sorted by mismatch (desc)</span>
        <code className="text-[10px]">{profile.path}</code>
      </footer>
    </main>
  );
}

function Stat({
  label,
  value,
  bold,
}: {
  label: string;
  value: string;
  bold?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={`font-mono ${bold ? "font-semibold" : ""}`}>{value}</dd>
    </div>
  );
}
