import { resumeAgent } from "@/lib/agent";
import { getSession, deleteSession } from "@/lib/session";
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

export async function POST(request: Request) {
  const { sessionId, approved } = await request.json();

  if (!sessionId || typeof approved !== "boolean") {
    return new Response(
      JSON.stringify({ error: "sessionId and approved are required" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const session = getSession(sessionId);
  if (!session) {
    return new Response(
      JSON.stringify({ error: "session not found or expired" }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    );
  }

  const stream = createSSEStream(resumeAgent(session, approved));

  // 세션 정리는 스트림 완료 후
  // (resumeAgent 내에서 새 세션이 필요하면 자동 생성됨)
  deleteSession(sessionId);

  return new Response(stream, { headers: SSE_HEADERS });
}
