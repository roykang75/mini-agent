/**
 * Raw append middleware (Phase 8 T8.1).
 *
 * Writes agent events as JSONL to `<AGENT_MEMORY_DIR>/raw/YYYY/MM/DD/NNNN.jsonl`.
 * One memory session = one file. Append-only (RULES.md R1~R3). Schema per R5:
 *   { ts, session_id, event_type, payload, persona?, persona_ref? }
 *
 * Secret handling: payloads are expected to already be in `@vault:ref` state
 * (agent.ts only resolves refs at executeSkill boundary). Callers must not pass
 * resolved secrets in here — R4. http_call response bodies are trusted not to
 * echo credentials; handler-level sanitization is out of scope for M1.
 *
 * If AGENT_MEMORY_DIR is unset, all writes are no-ops (dev convenience).
 */

import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

export interface RawEvent {
  ts: string;
  session_id: string;
  event_type: string;
  payload: unknown;
  persona?: string;
  persona_ref?: string;
}

interface SessionState {
  stream: WriteStream;
  path: string;
  persona?: string;
  personaRef?: string;
}

const sessions = new Map<string, SessionState>();
let warnedNoDir = false;

function memoryDir(): string | undefined {
  const dir = process.env.AGENT_MEMORY_DIR;
  if (!dir) {
    if (!warnedNoDir) {
      console.warn("[memory/raw] AGENT_MEMORY_DIR not set — raw append skipped");
      warnedNoDir = true;
    }
    return undefined;
  }
  return dir;
}

export function newMemorySessionId(): string {
  const iso = new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15);
  const rand = crypto.randomUUID().slice(0, 8);
  return `${iso}Z-${rand}`;
}

async function openSessionFile(sessionId: string): Promise<SessionState | undefined> {
  const dir = memoryDir();
  if (!dir) return undefined;

  const now = new Date();
  const y = String(now.getUTCFullYear());
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  const rawDir = join(dir, "raw", y, m, d);
  await mkdir(rawDir, { recursive: true });

  const existing = await readdir(rawDir).catch(() => [] as string[]);
  const maxN = existing.reduce((acc, f) => {
    const m2 = f.match(/^(\d{4})\.jsonl$/);
    if (!m2) return acc;
    const n = parseInt(m2[1], 10);
    return n > acc ? n : acc;
  }, 0);
  const path = join(rawDir, `${String(maxN + 1).padStart(4, "0")}.jsonl`);
  const stream = createWriteStream(path, { flags: "a" });
  return { stream, path };
}

export function setPersona(sessionId: string, persona: string, ref: string): void {
  const existing = sessions.get(sessionId);
  if (existing) {
    existing.persona = persona;
    existing.personaRef = ref;
  }
}

export async function appendRaw(
  sessionId: string,
  eventType: string,
  payload: unknown,
): Promise<void> {
  let state = sessions.get(sessionId);
  if (!state) {
    const opened = await openSessionFile(sessionId);
    if (!opened) return;
    state = opened;
    sessions.set(sessionId, state);
  }

  const event: RawEvent = {
    ts: new Date().toISOString(),
    session_id: sessionId,
    event_type: eventType,
    payload,
    ...(state.persona ? { persona: state.persona, persona_ref: state.personaRef } : {}),
  };
  state.stream.write(JSON.stringify(event) + "\n");
}

export async function closeRaw(sessionId: string): Promise<void> {
  const state = sessions.get(sessionId);
  if (!state) return;
  sessions.delete(sessionId);
  await new Promise<void>((resolve) => state.stream.end(resolve));
}

export function rawPath(sessionId: string): string | undefined {
  return sessions.get(sessionId)?.path;
}
