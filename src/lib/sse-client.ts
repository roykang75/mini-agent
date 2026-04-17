import type { AgentEvent } from "./types";

async function* parseSSEStream(
  res: Response,
): AsyncGenerator<AgentEvent> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop()!;

      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const json = line.slice("data:".length).trim();
        if (!json) continue;

        try {
          yield JSON.parse(json) as AgentEvent;
        } catch {
          console.warn("SSE parse error:", json);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export async function* streamChat(
  message: string,
  persona?: string,
  signal?: AbortSignal,
): AsyncGenerator<AgentEvent> {
  const res = await fetch("/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, persona }),
    signal,
  });

  if (!res.ok) {
    yield { type: "error", message: `HTTP ${res.status}: ${res.statusText}` };
    return;
  }

  yield* parseSSEStream(res);
}

export async function* streamApproval(
  sessionId: string,
  approved: boolean,
  credentials?: Record<string, string>,
  signal?: AbortSignal,
): AsyncGenerator<AgentEvent> {
  const res = await fetch("/chat/approve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, approved, credentials }),
    signal,
  });

  if (!res.ok) {
    yield { type: "error", message: `HTTP ${res.status}: ${res.statusText}` };
    return;
  }

  yield* parseSSEStream(res);
}
