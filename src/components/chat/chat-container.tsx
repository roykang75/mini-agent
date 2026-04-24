"use client";

import { useState, useCallback, useRef } from "react";
import type { ChatMessage, AgentEvent, UserInputAnswer } from "@/lib/types";
import { streamChat, streamApproval, streamAnswer } from "@/lib/sse-client";
import type { PersonaName } from "@/lib/souls/registry.generated";
import { MessageList } from "./message-list";
import { ChatInput } from "./chat-input";

let messageId = 0;
function nextId() {
  return `msg-${++messageId}-${Date.now()}`;
}

export function ChatContainer() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [persona, setPersona] = useState<PersonaName>("default");
  const [profileName, setProfileName] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // profileName 은 대화 세션이 시작된 후 (messages.length > 0) 에는 서버 쪽에서
  // 무시됨 (instance.ts 의 first-turn lock). UI 에선 메시지 있으면 selector 를
  // 잠가서 Roy 가 혼동하지 않게 한다.
  const profileLocked = messages.length > 0;

  // SSE 이벤트 스트림을 처리하는 공통 함수
  const processEvents = useCallback(async (events: AsyncGenerator<AgentEvent>, signal: AbortSignal) => {
    let currentAssistantId: string | null = null;
    // Tracks assistant bubbles that accumulated text via text_delta so the
    // subsequent (full-text) `message` event can be suppressed without losing
    // non-streaming backward compatibility.
    const streamedBubbles = new Set<string>();

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

        case "user_input_request":
          currentAssistantId = null;
          setMessages((prev) => [
            ...prev,
            {
              id: nextId(),
              role: "user_input",
              content: "",
              sessionId: event.sessionId,
              userInput: {
                toolUseId: event.toolUseId,
                kind: event.kind,
                question: event.question,
                options: event.options,
                multi: event.multi,
              },
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

        case "text_delta": {
          if (currentAssistantId) {
            const idForClosure = currentAssistantId;
            setMessages((prev) =>
              prev.map((m) =>
                m.id === idForClosure
                  ? { ...m, content: m.content + event.delta }
                  : m,
              ),
            );
          } else {
            const id = nextId();
            currentAssistantId = id;
            streamedBubbles.add(id);
            setMessages((prev) => [
              ...prev,
              { id, role: "assistant", content: event.delta, timestamp: Date.now() },
            ]);
          }
          break;
        }

        case "message": {
          // If this bubble was already built via text_delta, the full text is
          // already present — skip to avoid duplication. The `message` event is
          // kept for non-streaming providers / fallbacks.
          if (currentAssistantId && streamedBubbles.has(currentAssistantId)) {
            break;
          }
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
      await processEvents(
        streamChat(text, persona, profileName ?? undefined, controller.signal),
        controller.signal,
      );
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
  }, [processEvents, persona, profileName]);

  const handleApproval = useCallback(async (sessionId: string, approved: boolean, credentials?: Record<string, string>) => {
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
      await processEvents(streamApproval(sessionId, approved, credentials, controller.signal), controller.signal);
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

  const handleAnswer = useCallback(async (sessionId: string, answer: UserInputAnswer) => {
    setIsLoading(true);

    // 응답 전송 후 해당 user_input 블록을 비활성화 (content 가 비어있지 않으면 disabled).
    setMessages((prev) =>
      prev.map((m) =>
        m.role === "user_input" && m.sessionId === sessionId
          ? { ...m, content: JSON.stringify(answer) }
          : m,
      ),
    );

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await processEvents(streamAnswer(sessionId, answer, controller.signal), controller.signal);
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
        onAnswer={handleAnswer}
        isLoading={isLoading}
        persona={persona}
        onPersonaChange={setPersona}
        profileName={profileName}
        onProfileChange={setProfileName}
        profileLocked={profileLocked}
      />
      <ChatInput onSend={handleSend} onCancel={handleCancel} isLoading={isLoading} />
    </div>
  );
}
