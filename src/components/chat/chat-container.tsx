"use client";

import { useState, useCallback, useRef } from "react";
import type { ChatMessage, AgentEvent } from "@/lib/types";
import { streamChat, streamApproval } from "@/lib/sse-client";
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

  // SSE 이벤트 스트림을 처리하는 공통 함수
  const processEvents = useCallback(async (events: AsyncGenerator<AgentEvent>, signal: AbortSignal) => {
    let currentAssistantId: string | null = null;

    for await (const event of events) {
      if (signal.aborted) break;

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

        case "tool_approval_request":
          currentAssistantId = null;
          setMessages((prev) => [
            ...prev,
            {
              id: nextId(),
              role: "tool_approval",
              content: "",
              sessionId: event.sessionId,
              pendingToolCalls: event.toolCalls,
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

        case "tool_rejected":
          currentAssistantId = null;
          setMessages((prev) => [
            ...prev,
            {
              id: nextId(),
              role: "tool_rejected",
              content: `${event.name} 실행이 거부되었습니다.`,
              toolName: event.name,
              timestamp: Date.now(),
            },
          ]);
          break;

        case "message": {
          if (currentAssistantId) {
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
  }, []);

  const handleSend = useCallback(async (text: string) => {
    setIsLoading(true);

    setMessages((prev) => [
      ...prev,
      { id: nextId(), role: "user", content: text, timestamp: Date.now() },
    ]);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await processEvents(streamChat(text, controller.signal), controller.signal);
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
  }, [processEvents]);

  const handleApproval = useCallback(async (sessionId: string, approved: boolean) => {
    setIsLoading(true);

    // 승인/거부 후 해당 approval 블록을 비활성화
    setMessages((prev) =>
      prev.map((m) =>
        m.role === "tool_approval" && m.sessionId === sessionId
          ? { ...m, content: approved ? "approved" : "rejected" }
          : m,
      ),
    );

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await processEvents(streamApproval(sessionId, approved, controller.signal), controller.signal);
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
  }, [processEvents]);

  const handleCancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return (
    <div className="flex flex-col h-full">
      <MessageList
        messages={messages}
        onSend={handleSend}
        onApproval={handleApproval}
        isLoading={isLoading}
      />
      <ChatInput onSend={handleSend} onCancel={handleCancel} isLoading={isLoading} />
    </div>
  );
}
