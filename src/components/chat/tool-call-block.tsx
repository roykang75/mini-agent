"use client";

import { ChevronRight, Terminal } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { useState } from "react";

interface ToolCallBlockProps {
  name: string;
  args: Record<string, unknown>;
}

export function ToolCallBlock({ name, args }: ToolCallBlockProps) {
  const [open, setOpen] = useState(false);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex items-center gap-1.5 text-sm hover:bg-accent/50 transition-colors py-1 px-2 -mx-2 rounded-md group w-full">
        <ChevronRight
          className="size-3 text-muted-foreground transition-transform duration-200 group-data-[state=open]:rotate-90"
        />
        <Terminal className="size-3.5 text-amber-600" />
        <span className="font-mono text-xs font-medium text-amber-700">{name}</span>
        <span className="font-mono text-[10px] text-muted-foreground">(</span>
        {!open && (
          <span className="font-mono text-[10px] text-muted-foreground truncate">
            {Object.keys(args).join(", ")}
          </span>
        )}
        <span className="font-mono text-[10px] text-muted-foreground">)</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="ml-5 mt-1 rounded-md border border-border overflow-hidden">
          <div className="flex items-center gap-1.5 px-3 py-1.5 bg-muted/70 border-b border-border">
            <span className="size-2 rounded-full bg-red-400/60" />
            <span className="size-2 rounded-full bg-yellow-400/60" />
            <span className="size-2 rounded-full bg-green-400/60" />
            <span className="ml-2 font-mono text-[10px] text-muted-foreground">{name}</span>
          </div>
          <pre className="text-xs font-mono bg-muted/20 p-3 overflow-x-auto leading-relaxed">
            {JSON.stringify(args, null, 2)}
          </pre>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
