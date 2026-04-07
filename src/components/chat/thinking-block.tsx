"use client";

import { ChevronRight, BrainCircuit } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { useState } from "react";

interface ThinkingBlockProps {
  content: string;
}

export function ThinkingBlock({ content }: ThinkingBlockProps) {
  const [open, setOpen] = useState(false);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors py-1 group">
        <ChevronRight
          className="size-3 transition-transform duration-200 group-data-[state=open]:rotate-90"
        />
        <BrainCircuit className="size-3" />
        <span>Thinking...</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="ml-5 mt-1 text-xs text-muted-foreground font-mono leading-relaxed whitespace-pre-wrap border-l-2 border-border pl-3 py-1">
          {content}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
