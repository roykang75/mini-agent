"use client";

import { ChevronDown, UserCircle } from "lucide-react";
import { PERSONAS, PERSONA_META, type PersonaName } from "@/lib/souls/registry.generated";

interface PersonaSelectorProps {
  value: PersonaName;
  onChange: (persona: PersonaName) => void;
  disabled?: boolean;
  compact?: boolean;
}

export function PersonaSelector({ value, onChange, disabled, compact }: PersonaSelectorProps) {
  return (
    <label
      className={`inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/40 ${
        compact ? "px-2 py-1 text-xs" : "px-2.5 py-1.5 text-xs"
      } hover:bg-muted transition-colors ${disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
      title={PERSONA_META[value]?.description}
    >
      <UserCircle className="size-3.5 text-muted-foreground" />
      <span className="font-mono text-muted-foreground">persona</span>
      <span className="text-muted-foreground/60">=</span>
      <div className="relative inline-flex items-center">
        <select
          disabled={disabled}
          value={value}
          onChange={(e) => onChange(e.target.value as PersonaName)}
          className="appearance-none bg-transparent pr-4 font-mono focus:outline-none disabled:cursor-not-allowed"
        >
          {PERSONAS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <ChevronDown className="size-3 absolute right-0 pointer-events-none text-muted-foreground" />
      </div>
    </label>
  );
}
