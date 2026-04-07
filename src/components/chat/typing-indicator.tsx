"use client";

import { Bot } from "lucide-react";

export function TypingIndicator() {
  return (
    <div className="flex gap-3 animate-in fade-in duration-300">
      <div className="size-7 rounded-full bg-foreground flex items-center justify-center shrink-0 mt-0.5">
        <Bot className="size-3.5 text-background" />
      </div>
      <div className="flex items-center gap-1 py-2">
        <span className="size-1.5 rounded-full bg-muted-foreground/60 animate-pulse" style={{ animationDelay: "0ms" }} />
        <span className="size-1.5 rounded-full bg-muted-foreground/60 animate-pulse" style={{ animationDelay: "150ms" }} />
        <span className="size-1.5 rounded-full bg-muted-foreground/60 animate-pulse" style={{ animationDelay: "300ms" }} />
      </div>
    </div>
  );
}
