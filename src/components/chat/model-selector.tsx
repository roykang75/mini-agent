"use client";

import { useEffect, useState } from "react";
import { Cpu } from "lucide-react";

export interface PublicLlmProfile {
  name: string;
  label: string;
  model: string;
  recommended?: boolean;
  stability?: "stable" | "experimental";
  selectable?: boolean;
  blockedReason?: string;
}

interface ModelSelectorProps {
  value: string | null;
  onChange: (profileName: string) => void;
  compact?: boolean;
  disabled?: boolean;
}

export function ModelSelector({ value, onChange, compact, disabled }: ModelSelectorProps) {
  const [profiles, setProfiles] = useState<PublicLlmProfile[] | null>(null);
  const [defaultName, setDefaultName] = useState<string | null>(null);
  const [preferredLocal, setPreferredLocal] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/llm-profiles")
      .then((r) => r.json())
      .then((data: { default: string; preferredLocal?: string | null; profiles: PublicLlmProfile[] }) => {
        if (!alive) return;
        setProfiles(data.profiles);
        setDefaultName(data.default);
        setPreferredLocal(data.preferredLocal ?? null);
      })
      .catch((e) => {
        if (!alive) return;
        setError(`profile 로드 실패: ${(e as Error).message}`);
      });
    return () => {
      alive = false;
    };
  }, []);

  if (error) {
    return (
      <div className="text-xs text-destructive">{error}</div>
    );
  }
  if (!profiles) {
    return (
      <div className="text-xs text-muted-foreground">profile 로딩…</div>
    );
  }

  const current = value ?? defaultName ?? profiles[0]?.name ?? "";
  const currentProfile = profiles.find((p) => p.name === current) ?? null;
  const preferredLocalProfile = preferredLocal
    ? profiles.find((p) => p.name === preferredLocal) ?? null
    : null;
  const isExperimental = currentProfile?.stability === "experimental";
  const isBlocked = currentProfile?.selectable === false;
  const experimentalHint =
    isExperimental && preferredLocalProfile && preferredLocalProfile.name !== currentProfile?.name
      ? `실험용 local profile입니다. 권장 local-main: ${preferredLocalProfile.label}`
      : null;
  const selectorHint = isBlocked
    ? currentProfile?.blockedReason ?? "이 profile은 현재 비활성화되어 있습니다."
    : experimentalHint;
  const baseClass = compact
    ? "h-7 text-xs rounded border border-border bg-background px-2 py-0.5"
    : "h-9 text-sm rounded-md border border-border bg-background px-3 py-1.5";
  const selectClass = isBlocked
    ? `${baseClass} border-red-500/40 text-red-700`
    : isExperimental
      ? `${baseClass} border-amber-500/40 text-amber-700`
      : baseClass;

  function optionLabel(profile: PublicLlmProfile): string {
    if (profile.selectable === false) return `${profile.label} [disabled]`;
    if (profile.recommended) return `${profile.label} [recommended]`;
    return profile.label;
  }

  return (
    <div className={compact ? "inline-flex items-center gap-1.5" : "space-y-1"}>
      <label className="inline-flex items-center gap-1.5">
        <Cpu
          className={compact ? "size-3 text-muted-foreground" : "size-4 text-muted-foreground"}
        />
        <select
          value={current}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          title={selectorHint ?? undefined}
          className={`${selectClass} focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-60`}
        >
          {profiles.map((p) => (
            <option key={p.name} value={p.name} disabled={p.selectable === false}>
              {optionLabel(p)}
            </option>
          ))}
        </select>
      </label>
      {!compact && selectorHint ? (
        <p className={`text-[11px] leading-tight ${isBlocked ? "text-red-700" : "text-amber-700"}`}>
          {selectorHint}
        </p>
      ) : null}
    </div>
  );
}
