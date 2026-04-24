import { summonAgent } from "@/lib/agent/registry";
import { PersonaValidationError, validatePersona } from "@/lib/souls/loader";
import { getOrCreateSid, sidCookieHeader } from "@/lib/sid";
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

function sseHeaders(setCookie?: string): HeadersInit {
  const base: Record<string, string> = {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  };
  if (setCookie) base["Set-Cookie"] = setCookie;
  return base;
}

export async function POST(request: Request) {
  const body = await request.json();
  const { message, persona, persona_ref: personaRef, profileName } = body;

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

  if (profileName !== undefined && typeof profileName !== "string") {
    return new Response(JSON.stringify({ error: "profileName must be a string" }), {
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

  const { sid, isNew } = getOrCreateSid(request);
  const agent = await summonAgent(sid);
  const stream = createSSEStream(
    agent.receive(message, { persona, personaRef }, profileName),
  );
  return new Response(stream, {
    headers: sseHeaders(isNew ? sidCookieHeader(sid) : undefined),
  });
}
