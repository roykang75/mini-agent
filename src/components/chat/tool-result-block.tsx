"use client";

import { ChevronRight, CheckCircle2 } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useState } from "react";

interface ToolResultBlockProps {
  name: string;
  output: string;
}

export function ToolResultBlock({ name, output }: ToolResultBlockProps) {
  const [open, setOpen] = useState(false);
  const lines = output.split("\n").length;
  const truncated = lines > 3;
  const preview = truncated
    ? output.split("\n").slice(0, 3).join("\n") + "..."
    : output;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex items-center gap-2 text-sm hover:bg-accent/50 transition-colors py-1.5 px-2 -mx-2 rounded-md group w-full">
        <ChevronRight
          className="size-3.5 text-muted-foreground transition-transform duration-200 group-data-[state=open]:rotate-90"
        />
        <CheckCircle2 className="size-3.5 text-emerald-600" />
        <span className="font-mono text-xs font-medium">{name}</span>
        <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 font-mono">
          result
        </Badge>
        {!open && truncated && (
          <span className="text-[10px] text-muted-foreground ml-auto">
            {lines} lines
          </span>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ScrollArea className="ml-7 mt-1 max-h-[200px]">
          <pre className="text-xs font-mono bg-muted/50 border border-border rounded-md p-3 overflow-x-auto leading-relaxed whitespace-pre-wrap">
            {output}
          </pre>
        </ScrollArea>
      </CollapsibleContent>
      {!open && (
        <pre className="ml-7 mt-1 text-xs font-mono text-muted-foreground truncate max-w-full">
          {preview}
        </pre>
      )}
    </Collapsible>
  );
}
