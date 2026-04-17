import { REQUEST_CREDENTIAL_TOOL, resumeAgent } from "@/lib/agent";
import { getSession, deleteSession } from "@/lib/session";
import { readSidFromCookieHeader } from "@/lib/sid";
import type { AgentEvent } from "@/lib/types";

function createSSEStream(events: AsyncGenerator<AgentEvent>) {
  const encoder = new TextEncoder();

  return new ReadableStream({
    async start(controller) {
      try {
        for await (const event of events) {
          const data = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
          controller.enqueue(encoder.encode(data));
        }
      } catch (e) {
        const errorEvent = { type: "error", message: (e as Error).message };
        const data = `event: error\ndata: ${JSON.stringify(errorEvent)}\n\n`;
        controller.enqueue(encoder.encode(data));
      } finally {
        controller.close();
      }
    },
  });
}

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
};

function jsonError(message: string, status: number) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function POST(request: Request) {
  const body = await request.json();
  const { sessionId, approved, credentials } = body;

  if (!sessionId || typeof approved !== "boolean") {
    return jsonError("sessionId and approved are required", 400);
  }

  if (credentials !== undefined && (typeof credentials !== "object" || credentials === null)) {
    return jsonError("credentials must be an object map", 400);
  }

  const session = getSession(sessionId);
  if (!session) {
    return jsonError("session not found or expired", 404);
  }

  const cookieSid = readSidFromCookieHeader(request.headers.get("cookie"));
  if (!cookieSid || cookieSid !== session.sid) {
    return jsonError("sid cookie missing or does not match approval session", 403);
  }

  if (approved) {
    for (const tc of session.pendingToolCalls) {
      if (tc.name !== REQUEST_CREDENTIAL_TOOL) continue;
      const provided = (credentials as Record<string, unknown> | undefined)?.[tc.toolUseId];
      if (typeof provided !== "string" || provided.length === 0) {
        return jsonError(
          `credentials.${tc.toolUseId} is required for ${REQUEST_CREDENTIAL_TOOL}`,
          400,
        );
      }
    }
  }

  const stream = createSSEStream(
    resumeAgent(session, approved, credentials as Record<string, string> | undefined),
  );

  deleteSession(sessionId);

  return new Response(stream, { headers: SSE_HEADERS });
}
