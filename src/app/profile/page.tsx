import Link from "next/link";
import { listProfileModels, loadProfile } from "@/lib/profile/load";

const CURRICULUM_DIR =
  process.env.CURRICULUM_DIR ?? "/Users/roy/Workspace/agent/agent-curriculum";

export const dynamic = "force-dynamic";

export default async function ProfileIndexPage() {
  const models = await listProfileModels(CURRICULUM_DIR);
  const profiles = await Promise.all(
    models.map((m) => loadProfile(m, CURRICULUM_DIR)),
  );

  return (
    <main className="mx-auto max-w-3xl px-6 py-10 font-sans">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">
          Creature profiles
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          ADR-006 v2 Phase 1/1.5 에서 생성된 L3 self-map. agent 자신이 읽는
          용도가 아니라 외부 관측자 (Roy) 의 도구 (ADR-008).
        </p>
      </header>
      <ul className="divide-y divide-border rounded-md border border-border">
        {profiles.filter(Boolean).map((p) => {
          const profile = p!;
          const weak = profile.cells.filter(
            (c) => c.behavior_mismatch_rate >= 0.5,
          ).length;
          const unstable = profile.cells.filter(
            (c) => c.behavior_mismatch_rate >= 0.2 && c.behavior_mismatch_rate < 0.5,
          ).length;
          return (
            <li key={profile.model}>
              <Link
                href={`/profile/${encodeURIComponent(profile.model)}`}
                className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-accent/50"
              >
                <div>
                  <div className="font-medium">{profile.model}</div>
                  <div className="text-xs text-muted-foreground">
                    {profile.cell_count} cells · generated{" "}
                    {profile.generated_at.slice(0, 19).replace("T", " ")}
                  </div>
                </div>
                <div className="flex items-center gap-2 text-xs">
                  {weak > 0 && (
                    <span className="rounded-full bg-red-500/15 px-2 py-0.5 font-medium text-red-600 dark:text-red-400">
                      {weak} weak
                    </span>
                  )}
                  {unstable > 0 && (
                    <span className="rounded-full bg-amber-500/15 px-2 py-0.5 font-medium text-amber-700 dark:text-amber-300">
                      {unstable} unstable
                    </span>
                  )}
                  {weak === 0 && unstable === 0 && (
                    <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 font-medium text-emerald-700 dark:text-emerald-400">
                      all stable
                    </span>
                  )}
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
      <footer className="mt-8 text-xs text-muted-foreground">
        source: <code>{CURRICULUM_DIR}/profiles/</code>
      </footer>
    </main>
  );
}
