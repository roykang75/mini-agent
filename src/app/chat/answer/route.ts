import { summonAgent } from "@/lib/agent/registry";
import { readSidFromCookieHeader } from "@/lib/sid";
import type { AgentEvent, UserInputAnswer } from "@/lib/types";

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

function validateAnswer(
  raw: unknown,
): { ok: true; value: UserInputAnswer } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "answer must be an object" };
  }
  const obj = raw as Record<string, unknown>;
  if (obj.kind === "cancel") {
    return { ok: true, value: { kind: "cancel" } };
  }
  if (obj.kind === "confirm") {
    if (typeof obj.confirmed !== "boolean") {
      return { ok: false, error: "answer.confirmed must be a boolean" };
    }
    return { ok: true, value: { kind: "confirm", confirmed: obj.confirmed } };
  }
  if (obj.kind === "choose") {
    const s = obj.selected;
    if (typeof s === "string" && s.length > 0) {
      return { ok: true, value: { kind: "choose", selected: s } };
    }
    if (Array.isArray(s) && s.length > 0 && s.every((x) => typeof x === "string" && x.length > 0)) {
      return { ok: true, value: { kind: "choose", selected: s as string[] } };
    }
    return {
      ok: false,
      error: "answer.selected must be a non-empty string or non-empty string array",
    };
  }
  return { ok: false, error: "answer.kind must be 'choose' | 'confirm' | 'cancel'" };
}

export async function POST(request: Request) {
  const body = await request.json();
  const { sessionId, answer } = body;

  if (typeof sessionId !== "string" || !sessionId) {
    return jsonError("sessionId is required", 400);
  }
  const validated = validateAnswer(answer);
  if (!validated.ok) {
    return jsonError(validated.error, 400);
  }

  const cookieSid = readSidFromCookieHeader(request.headers.get("cookie"));
  if (!cookieSid) {
    return jsonError("sid cookie missing", 403);
  }

  const agent = await summonAgent(cookieSid);
  if (agent.pendingUserInputSessionId !== sessionId) {
    return jsonError("user_input sessionId does not match agent's pending state", 404);
  }

  const expectedKind = agent.pendingUserInputKind;
  // cancel 은 pending.kind 와 무관하게 허용.
  if (validated.value.kind !== "cancel" && expectedKind !== validated.value.kind) {
    return jsonError(
      `answer.kind "${validated.value.kind}" does not match pending "${expectedKind}"`,
      400,
    );
  }

  // Shape / id validation for choose.
  if (validated.value.kind === "choose") {
    const multi = agent.pendingUserInputMulti;
    const allowed = agent.pendingUserInputOptionIds;
    const selected = validated.value.selected;
    if (multi) {
      if (!Array.isArray(selected)) {
        return jsonError("answer.selected must be an array when multi=true", 400);
      }
      if (allowed) {
        for (const id of selected) {
          if (!allowed.includes(id)) {
            return jsonError(`answer.selected contains unknown id "${id}"`, 400);
          }
        }
      }
    } else {
      if (typeof selected !== "string") {
        return jsonError("answer.selected must be a string when multi=false", 400);
      }
      if (allowed && !allowed.includes(selected)) {
        return jsonError(`answer.selected "${selected}" is not a known option id`, 400);
      }
    }
  }

  const stream = createSSEStream(
    agent.resumeAfterUserInput(sessionId, validated.value),
  );

  return new Response(stream, { headers: SSE_HEADERS });
}
