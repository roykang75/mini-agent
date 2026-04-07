"use client";

import { SendHorizontal, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useRef, useCallback } from "react";

interface ChatInputProps {
  onSend: (message: string) => void;
  onCancel: () => void;
  isLoading: boolean;
}

export function ChatInput({ onSend, onCancel, isLoading }: ChatInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = useCallback(() => {
    const value = textareaRef.current?.value.trim();
    if (!value || isLoading) return;
    onSend(value);
    if (textareaRef.current) textareaRef.current.value = "";
    resizeTextarea();
  }, [onSend, isLoading]);

  const resizeTextarea = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="border-t border-border bg-background px-4 py-3">
      <div className="mx-auto max-w-3xl flex items-end gap-2">
        <textarea
          ref={textareaRef}
          placeholder="메시지를 입력하세요..."
          rows={1}
          disabled={isLoading}
          onKeyDown={handleKeyDown}
          onInput={resizeTextarea}
          className="flex-1 resize-none bg-transparent text-sm leading-relaxed placeholder:text-muted-foreground focus:outline-none disabled:opacity-50 py-2"
          autoFocus
        />
        {isLoading ? (
          <Button
            variant="ghost"
            size="icon"
            onClick={onCancel}
            className="shrink-0 size-8 text-muted-foreground hover:text-destructive"
          >
            <Square className="size-4" />
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="icon"
            onClick={handleSend}
            className="shrink-0 size-8 text-muted-foreground hover:text-foreground"
          >
            <SendHorizontal className="size-4" />
          </Button>
        )}
      </div>
    </div>
  );
}
