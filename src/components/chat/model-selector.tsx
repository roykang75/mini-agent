"use client";

import { useEffect, useState } from "react";
import { Cpu } from "lucide-react";

export interface PublicLlmProfile {
  name: string;
  label: string;
  model: string;
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
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/llm-profiles")
      .then((r) => r.json())
      .then((data: { default: string; profiles: PublicLlmProfile[] }) => {
        if (!alive) return;
        setProfiles(data.profiles);
        setDefaultName(data.default);
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
  const baseClass = compact
    ? "h-7 text-xs rounded border border-border bg-background px-2 py-0.5"
    : "h-9 text-sm rounded-md border border-border bg-background px-3 py-1.5";

  return (
    <label className="inline-flex items-center gap-1.5">
      <Cpu
        className={compact ? "size-3 text-muted-foreground" : "size-4 text-muted-foreground"}
      />
      <select
        value={current}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className={`${baseClass} focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-60`}
      >
        {profiles.map((p) => (
          <option key={p.name} value={p.name}>
            {p.label}
          </option>
        ))}
      </select>
    </label>
  );
}
