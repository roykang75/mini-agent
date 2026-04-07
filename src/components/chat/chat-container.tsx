"use client";

import { useState, useCallback, useRef } from "react";
import type { ChatMessage } from "@/lib/types";
import { streamChat } from "@/lib/sse-client";
import { MessageList } from "./message-list";
import { ChatInput } from "./chat-input";

let messageId = 0;
function nextId() {
  return `msg-${++messageId}-${Date.now()}`;
}

export function ChatContainer() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const handleSend = useCallback(async (text: string) => {
    setIsLoading(true);

    setMessages((prev) => [
      ...prev,
      { id: nextId(), role: "user", content: text, timestamp: Date.now() },
    ]);

    const controller = new AbortController();
    abortRef.current = controller;

    // 현재 assistant 메시지의 id를 추적 (연속 message 이벤트 누적용)
    let currentAssistantId: string | null = null;

    try {
      for await (const event of streamChat(text, controller.signal)) {
        switch (event.type) {
          case "thinking":
            currentAssistantId = null;
            setMessages((prev) => [
              ...prev,
              { id: nextId(), role: "thinking", content: event.content, timestamp: Date.now() },
            ]);
            break;

          case "tool_call":
            currentAssistantId = null;
            setMessages((prev) => [
              ...prev,
              {
                id: nextId(),
                role: "tool_call",
                content: JSON.stringify(event.args),
                toolName: event.name,
                toolArgs: event.args,
                timestamp: Date.now(),
              },
            ]);
            break;

          case "tool_result":
            currentAssistantId = null;
            setMessages((prev) => [
              ...prev,
              {
                id: nextId(),
                role: "tool_result",
                content: event.output,
                toolName: event.name,
                timestamp: Date.now(),
              },
            ]);
            break;

          case "message": {
            if (currentAssistantId) {
              // 기존 메시지에 누적
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === currentAssistantId
                    ? { ...m, content: m.content + event.content }
                    : m,
                ),
              );
            } else {
              const id = nextId();
              currentAssistantId = id;
              setMessages((prev) => [
                ...prev,
                { id, role: "assistant", content: event.content, timestamp: Date.now() },
              ]);
            }
            break;
          }

          case "error":
            currentAssistantId = null;
            setMessages((prev) => [
              ...prev,
              { id: nextId(), role: "error", content: event.message, timestamp: Date.now() },
            ]);
            break;

          case "done":
            break;
        }
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        setMessages((prev) => [
          ...prev,
          { id: nextId(), role: "error", content: `연결 오류: ${(e as Error).message}`, timestamp: Date.now() },
        ]);
      }
    } finally {
      abortRef.current = null;
      setIsLoading(false);
    }
  }, []);

  const handleCancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return (
    <div className="flex flex-col h-full">
      <MessageList messages={messages} onSend={handleSend} isLoading={isLoading} />
      <ChatInput onSend={handleSend} onCancel={handleCancel} isLoading={isLoading} />
    </div>
  );
}
