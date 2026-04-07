"use client";

import { ChevronRight, Terminal } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Badge } from "@/components/ui/badge";
import { useState } from "react";

interface ToolCallBlockProps {
  name: string;
  args: Record<string, unknown>;
}

export function ToolCallBlock({ name, args }: ToolCallBlockProps) {
  const [open, setOpen] = useState(false);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex items-center gap-2 text-sm hover:bg-accent/50 transition-colors py-1.5 px-2 -mx-2 rounded-md group w-full">
        <ChevronRight
          className="size-3.5 text-muted-foreground transition-transform duration-200 group-data-[state=open]:rotate-90"
        />
        <Terminal className="size-3.5 text-amber-600" />
        <span className="font-mono text-xs font-medium">{name}</span>
        <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 font-mono">
          call
        </Badge>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="ml-7 mt-1 text-xs font-mono bg-muted/50 border border-border rounded-md p-3 overflow-x-auto leading-relaxed">
          {JSON.stringify(args, null, 2)}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  );
}
