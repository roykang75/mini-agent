"use client";

import { ChevronRight, CheckCircle2 } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useState } from "react";

interface ToolResultBlockProps {
  name: string;
  output: string;
}

export function ToolResultBlock({ name, output }: ToolResultBlockProps) {
  const [open, setOpen] = useState(false);
  const outputLines = output.split("\n");
  const lineCount = outputLines.length;
  const truncated = lineCount > 3;
  const preview = truncated
    ? outputLines.slice(0, 2).join("\n")
    : output;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex items-center gap-1.5 text-sm hover:bg-accent/50 transition-colors py-1 px-2 -mx-2 rounded-md group w-full">
        <ChevronRight
          className="size-3 text-muted-foreground transition-transform duration-200 group-data-[state=open]:rotate-90"
        />
        <CheckCircle2 className="size-3.5 text-emerald-600" />
        <span className="font-mono text-xs font-medium text-emerald-700">{name}</span>
        <span className="font-mono text-[10px] text-muted-foreground">
          exit 0
        </span>
        {truncated && (
          <span className="text-[10px] text-muted-foreground ml-auto tabular-nums">
            {lineCount} lines
          </span>
        )}
      </CollapsibleTrigger>

      {/* Collapsed preview */}
      {!open && (
        <pre className="ml-5 mt-1 text-[11px] font-mono text-muted-foreground leading-relaxed truncate max-w-full">
          {preview}
          {truncated && <span className="text-muted-foreground/50"> ...</span>}
        </pre>
      )}

      {/* Expanded full output */}
      <CollapsibleContent>
        <div className="ml-5 mt-1 rounded-md border border-border overflow-hidden">
          <div className="flex items-center gap-1.5 px-3 py-1.5 bg-muted/70 border-b border-border">
            <span className="size-2 rounded-full bg-red-400/60" />
            <span className="size-2 rounded-full bg-yellow-400/60" />
            <span className="size-2 rounded-full bg-green-400/60" />
            <span className="ml-2 font-mono text-[10px] text-muted-foreground">output</span>
          </div>
          <ScrollArea className="max-h-[240px]">
            <pre className="text-[11px] font-mono bg-muted/20 p-3 overflow-x-auto leading-relaxed whitespace-pre-wrap">
              {output}
            </pre>
          </ScrollArea>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
