"use client";

import { SendHorizontal, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useRef, useCallback, useState } from "react";

interface ChatInputProps {
  onSend: (message: string) => void;
  onCancel: () => void;
  isLoading: boolean;
}

export function ChatInput({ onSend, onCancel, isLoading }: ChatInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [hasValue, setHasValue] = useState(false);

  const handleSend = useCallback(() => {
    const value = textareaRef.current?.value.trim();
    if (!value || isLoading) return;
    onSend(value);
    if (textareaRef.current) textareaRef.current.value = "";
    setHasValue(false);
    resizeTextarea();
  }, [onSend, isLoading]);

  const resizeTextarea = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  };

  const handleInput = () => {
    resizeTextarea();
    setHasValue(!!textareaRef.current?.value.trim());
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="px-4 py-4 bg-background">
      <div className="mx-auto max-w-3xl">
        <div className="flex items-end gap-2 rounded-xl border border-border bg-muted/40 px-3 py-2 shadow-sm focus-within:border-foreground/20 focus-within:shadow-md transition-all">
          <span className="select-none font-mono text-sm text-muted-foreground pb-1.5 shrink-0" aria-hidden>
            $
          </span>
          <textarea
            ref={textareaRef}
            placeholder="메시지를 입력하세요..."
            rows={1}
            disabled={isLoading}
            onKeyDown={handleKeyDown}
            onInput={handleInput}
            className="flex-1 resize-none bg-transparent font-mono text-sm leading-relaxed placeholder:text-muted-foreground placeholder:font-sans focus:outline-none disabled:opacity-50 py-1.5"
            autoFocus
          />
          {isLoading ? (
            <Button
              variant="ghost"
              size="icon"
              onClick={onCancel}
              className="shrink-0 size-8 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10"
            >
              <Square className="size-3.5" />
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="icon"
              onClick={handleSend}
              disabled={!hasValue}
              className={`shrink-0 size-8 rounded-lg transition-all ${
                hasValue
                  ? "bg-foreground text-background hover:bg-foreground/90"
                  : "text-muted-foreground"
              }`}
            >
              <SendHorizontal className="size-3.5" />
            </Button>
          )}
        </div>
        <p className="text-[10px] text-muted-foreground/60 mt-2 text-center">
          Enter로 전송, Shift+Enter로 줄바꿈
        </p>
      </div>
    </div>
  );
}
