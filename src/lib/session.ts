import type { Message, ContentBlock } from "./llm/types";
import type { PendingToolCall } from "./types";

export interface Session {
  id: string;
  messages: Message[];
  systemPrompt: string;
  pendingToolCalls: PendingToolCall[];
  lastAssistantContent: ContentBlock[];
  createdAt: number;
}

const sessions = new Map<string, Session>();

const SESSION_TTL_MS = 30 * 60 * 1000;

function cleanup() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.createdAt > SESSION_TTL_MS) {
      sessions.delete(id);
    }
  }
}

export function createSession(messages: Message[], systemPrompt: string): Session {
  cleanup();
  const id = crypto.randomUUID();
  const session: Session = {
    id,
    messages,
    systemPrompt,
    pendingToolCalls: [],
    lastAssistantContent: [],
    createdAt: Date.now(),
  };
  sessions.set(id, session);
  return session;
}

export function getSession(id: string): Session | undefined {
  cleanup();
  return sessions.get(id);
}

export function deleteSession(id: string): void {
  sessions.delete(id);
}