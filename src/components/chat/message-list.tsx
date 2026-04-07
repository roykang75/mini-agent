"use client";

import { useEffect, useRef } from "react";
import { Bot, User, FileText, FolderOpen, TerminalSquare } from "lucide-react";
import type { ChatMessage } from "@/lib/types";
import { ThinkingBlock } from "./thinking-block";
import { ToolCallBlock } from "./tool-call-block";
import { ToolResultBlock } from "./tool-result-block";
import { TypingIndicator } from "./typing-indicator";
import { ToolApprovalBlock } from "./tool-approval-block";

const EXAMPLE_PROMPTS = [
  {
    icon: FolderOpen,
    label: "파일 목록 확인",
    prompt: "현재 디렉토리의 파일 목록을 알려줘",
  },
  {
    icon: FileText,
    label: "파일 내용 읽기",
    prompt: "package.json 파일 내용을 보여줘",
  },
  {
    icon: TerminalSquare,
    label: "명령어 실행",
    prompt: "git status 실행 결과를 보여줘",
  },
];

interface MessageListProps {
  messages: ChatMessage[];
  onSend?: (message: string) => void;
  onApproval?: (sessionId: string, approved: boolean) => void;
  isLoading?: boolean;
}

function isNearBottom(el: HTMLElement, threshold = 80): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
}

export function MessageList({ messages, onSend, onApproval, isLoading }: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const shouldAutoScroll = useRef(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const handleScroll = () => {
      shouldAutoScroll.current = isNearBottom(el);
    };
    el.addEventListener("scroll", handleScroll);
    return () => el.removeEventListener("scroll", handleScroll);
  }, []);

  useEffect(() => {
    if (shouldAutoScroll.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  if (messages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center px-4">
        <div className="w-full max-w-md space-y-8">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="font-mono text-muted-foreground text-xs select-none">$</span>
              <h1 className="text-lg font-semibold tracking-tight">Mini Agent</h1>
            </div>
            <p className="text-sm text-muted-foreground leading-relaxed">
              파일을 읽고, 쓰고, 명령어를 실행할 수 있는 AI Agent입니다.
            </p>
          </div>

          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              시작하기
            </p>
            <div className="grid gap-2">
              {EXAMPLE_PROMPTS.map((example) => (
                <button
                  key={example.label}
                  onClick={() => onSend?.(example.prompt)}
                  className="group flex items-center gap-3 rounded-lg border border-border px-4 py-3 text-left text-sm transition-colors hover:bg-accent hover:border-accent-foreground/20"
                >
                  <example.icon className="size-4 text-muted-foreground group-hover:text-foreground shrink-0 transition-colors" />
                  <div className="min-w-0">
                    <p className="font-medium text-foreground">{example.label}</p>
                    <p className="text-xs text-muted-foreground font-mono truncate">
                      {example.prompt}
                    </p>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  const grouped = groupMessages(messages);

  // typing indicator: 로딩 중이고, 마지막 메시지가 user인 경우 (아직 assistant 응답 시작 전)
  const lastMsg = messages[messages.length - 1];
  const showTyping = isLoading && lastMsg?.role === "user";

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl px-4 py-6 space-y-6">
        {grouped.map((group) => (
          <div key={group.id} className="animate-in fade-in duration-300">
            {group.role === "user" ? (
              <UserMessage content={group.messages[0].content} />
            ) : (
              <AssistantGroup messages={group.messages} onApproval={onApproval} isLoading={isLoading} />
            )}
          </div>
        ))}
        {showTyping && (
          <div className="mx-auto max-w-3xl">
            <TypingIndicator />
          </div>
        )}
      </div>
    </div>
  );
}

function UserMessage({ content }: { content: string }) {
  return (
    <div className="flex gap-3 justify-end">
      <div className="bg-primary text-primary-foreground rounded-2xl rounded-br-md px-4 py-2.5 max-w-[80%]">
        <p className="text-sm leading-relaxed whitespace-pre-wrap">{content}</p>
      </div>
      <div className="size-7 rounded-full bg-muted flex items-center justify-center shrink-0 mt-0.5">
        <User className="size-3.5 text-muted-foreground" />
      </div>
    </div>
  );
}

function AssistantGroup({
  messages,
  onApproval,
  isLoading,
}: {
  messages: ChatMessage[];
  onApproval?: (sessionId: string, approved: boolean) => void;
  isLoading?: boolean;
}) {
  return (
    <div className="flex gap-3">
      <div className="size-7 rounded-full bg-foreground flex items-center justify-center shrink-0 mt-0.5">
        <Bot className="size-3.5 text-background" />
      </div>
      <div className="flex-1 min-w-0 space-y-2">
        {messages.map((msg) => (
          <div key={msg.id}>
            {msg.role === "thinking" && (
              <ThinkingBlock content={msg.content} />
            )}
            {msg.role === "tool_call" && (
              <ToolCallBlock
                name={msg.toolName!}
                args={msg.toolArgs!}
              />
            )}
            {msg.role === "tool_approval" && msg.pendingToolCalls && (
              <ToolApprovalBlock
                toolCalls={msg.pendingToolCalls}
                onApprove={() => onApproval?.(msg.sessionId!, true)}
                onReject={() => onApproval?.(msg.sessionId!, false)}
                disabled={msg.content !== "" || isLoading}
              />
            )}
            {msg.role === "tool_result" && (
              <ToolResultBlock
                name={msg.toolName!}
                output={msg.content}
              />
            )}
            {msg.role === "tool_rejected" && (
              <p className="text-xs text-muted-foreground italic">
                {msg.content}
              </p>
            )}
            {msg.role === "assistant" && (
              <p className="text-sm leading-relaxed whitespace-pre-wrap">
                {msg.content}
              </p>
            )}
            {msg.role === "error" && (
              <p className="text-sm text-destructive leading-relaxed">
                {msg.content}
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// --- helpers ---

interface MessageGroup {
  id: string;
  role: "user" | "assistant";
  messages: ChatMessage[];
}

function groupMessages(messages: ChatMessage[]): MessageGroup[] {
  const groups: MessageGroup[] = [];

  for (const msg of messages) {
    if (msg.role === "user") {
      groups.push({ id: msg.id, role: "user", messages: [msg] });
    } else {
      const last = groups[groups.length - 1];
      if (last && last.role === "assistant") {
        last.messages.push(msg);
      } else {
        groups.push({ id: msg.id, role: "assistant", messages: [msg] });
      }
    }
  }

  return groups;
}
