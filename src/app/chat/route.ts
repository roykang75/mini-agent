import { runAgent } from "@/lib/agent";
import { PersonaValidationError, validatePersona } from "@/lib/souls/loader";
import type { AgentEvent } from "@/lib/types";

const REF_RE = /^[a-zA-Z0-9_.\-/]{1,64}$/;

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
  const body = await request.json();
  const { message, persona, persona_ref: personaRef } = body;

  if (!message || typeof message !== "string") {
    return new Response(JSON.stringify({ error: "message is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (persona !== undefined && typeof persona !== "string") {
    return new Response(JSON.stringify({ error: "persona must be a string" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (personaRef !== undefined && typeof personaRef !== "string") {
    return new Response(JSON.stringify({ error: "persona_ref must be a string" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    validatePersona(persona);
  } catch (e) {
    if (e instanceof PersonaValidationError) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw e;
  }

  if (personaRef !== undefined && !REF_RE.test(personaRef)) {
    return new Response(JSON.stringify({ error: `Invalid persona_ref: ${personaRef}` }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const stream = createSSEStream(runAgent(message, { persona, personaRef }));
  return new Response(stream, { headers: SSE_HEADERS });
}
