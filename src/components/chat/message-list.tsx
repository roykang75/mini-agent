"use client";

import { useEffect, useRef } from "react";
import { Bot, User, FileText, FolderOpen, TerminalSquare, KeyRound, GitCompare } from "lucide-react";
import type { ChatMessage, UserInputAnswer } from "@/lib/types";
import type { PersonaName } from "@/lib/souls/registry.generated";
import { ThinkingBlock } from "./thinking-block";
import { ToolCallBlock } from "./tool-call-block";
import { ToolResultBlock } from "./tool-result-block";
import { TypingIndicator } from "./typing-indicator";
import { ToolApprovalBlock } from "./tool-approval-block";
import { UserInputBlock } from "./user-input-block";
import { PersonaSelector } from "./persona-selector";
import { ModelSelector } from "./model-selector";

interface ExamplePrompt {
  icon: typeof FolderOpen;
  label: string;
  prompt: string;
}

const EXAMPLE_PROMPTS_BY_PERSONA: Record<PersonaName, ExamplePrompt[]> = {
  default: [
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
  ],
  "cia-analyst": [
    {
      icon: KeyRound,
      label: "CIA 토큰 요청 테스트",
      prompt:
        "CIA 분석을 시작하기 전에 request_credential 도구로 사용자에게 CIA API 토큰을 요청해줘. key는 \"cia_token\", description은 \"CIA API 토큰\" 으로.",
    },
    {
      icon: GitCompare,
      label: "두 commit 사이 영향 분석",
      prompt:
        "impact-analysis.git 저장소의 abc1234 와 def5678 commit 사이의 영향도를 분석해줘.",
    },
  ],
};

interface MessageListProps {
  messages: ChatMessage[];
  onSend?: (message: string) => void;
  onApproval?: (sessionId: string, approved: boolean, credentials?: Record<string, string>) => void;
  onAnswer?: (sessionId: string, answer: UserInputAnswer) => void;
  isLoading?: boolean;
  persona: PersonaName;
  onPersonaChange: (persona: PersonaName) => void;
  profileName: string | null;
  onProfileChange: (name: string) => void;
  profileLocked: boolean;
}

function isNearBottom(el: HTMLElement, threshold = 80): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
}

export function MessageList({
  messages,
  onSend,
  onApproval,
  onAnswer,
  isLoading,
  persona,
  onPersonaChange,
  profileName,
  onProfileChange,
  profileLocked,
}: MessageListProps) {
  const examples = EXAMPLE_PROMPTS_BY_PERSONA[persona] ?? EXAMPLE_PROMPTS_BY_PERSONA.default;
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
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="font-mono text-muted-foreground text-xs select-none">$</span>
              <h1 className="text-lg font-semibold tracking-tight">Mini Agent</h1>
            </div>
            <p className="text-sm text-muted-foreground leading-relaxed">
              파일을 읽고, 쓰고, 명령어를 실행할 수 있는 AI Agent입니다.
            </p>
            <div className="space-y-2">
              <PersonaSelector value={persona} onChange={onPersonaChange} />
              <ModelSelector
                value={profileName}
                onChange={onProfileChange}
                disabled={profileLocked}
              />
            </div>
          </div>

          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              시작하기
            </p>
            <div className="grid gap-2">
              {examples.map((example) => (
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
      <div className="mx-auto max-w-3xl px-4 py-4 flex justify-end items-center gap-2">
        <ModelSelector
          value={profileName}
          onChange={onProfileChange}
          compact
          disabled={profileLocked || isLoading}
        />
        <PersonaSelector value={persona} onChange={onPersonaChange} compact disabled={isLoading} />
      </div>
      <div className="mx-auto max-w-3xl px-4 pb-6 space-y-6">
        {grouped.map((group) => (
          <div key={group.id} className="animate-in fade-in duration-300">
            {group.role === "user" ? (
              <UserMessage content={group.messages[0].content} />
            ) : (
              <AssistantGroup
                messages={group.messages}
                onApproval={onApproval}
                onAnswer={onAnswer}
                isLoading={isLoading}
              />
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
  onAnswer,
  isLoading,
}: {
  messages: ChatMessage[];
  onApproval?: (sessionId: string, approved: boolean, credentials?: Record<string, string>) => void;
  onAnswer?: (sessionId: string, answer: UserInputAnswer) => void;
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
                onApprove={(credentials) => onApproval?.(msg.sessionId!, true, credentials)}
                onReject={() => onApproval?.(msg.sessionId!, false)}
                disabled={msg.content !== "" || isLoading}
              />
            )}
            {msg.role === "user_input" && msg.userInput && (
              <UserInputBlock
                kind={msg.userInput.kind}
                question={msg.userInput.question}
                options={msg.userInput.options}
                multi={msg.userInput.multi}
                onAnswer={(answer) => onAnswer?.(msg.sessionId!, answer)}
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
