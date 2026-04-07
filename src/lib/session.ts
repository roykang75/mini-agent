import type Anthropic from "@anthropic-ai/sdk";
import type { PendingToolCall } from "./types";

export interface Session {
  id: string;
  messages: Anthropic.MessageParam[];
  pendingToolCalls: PendingToolCall[];
  lastAssistantContent: Anthropic.ContentBlock[];
  createdAt: number;
}

const sessions = new Map<string, Session>();

// 30분 후 자동 만료
const SESSION_TTL_MS = 30 * 60 * 1000;

function cleanup() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.createdAt > SESSION_TTL_MS) {
      sessions.delete(id);
    }
  }
}

export function createSession(messages: Anthropic.MessageParam[]): Session {
  cleanup();
  const id = crypto.randomUUID();
  const session: Session = {
    id,
    messages,
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
