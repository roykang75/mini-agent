/**
 * Session cookie (`mini_agent_sid`) helpers.
 *
 * The sid scopes the vault and is independent of the short-lived tool-approval
 * Session ids. Read from the Cookie header on request; set via Set-Cookie when
 * missing. Keep the cookie HttpOnly (LLM in the browser must not read it) and
 * SameSite=Lax. Secure flag is off because M1 runs inside a private network.
 */

export const SID_COOKIE = "mini_agent_sid";
const SID_RE = /^[a-f0-9-]{36}$/;
const SID_MAX_AGE_SEC = 60 * 60 * 24; // 24h

export function makeSid(): string {
  return crypto.randomUUID();
}

export function readSidFromCookieHeader(cookieHeader: string | null): string | undefined {
  if (!cookieHeader) return undefined;
  const parts = cookieHeader.split(";");
  for (const p of parts) {
    const [k, v] = p.trim().split("=");
    if (k === SID_COOKIE && v && SID_RE.test(v)) return v;
  }
  return undefined;
}

export function getOrCreateSid(request: Request): { sid: string; isNew: boolean } {
  const existing = readSidFromCookieHeader(request.headers.get("cookie"));
  if (existing) return { sid: existing, isNew: false };
  return { sid: makeSid(), isNew: true };
}

export function sidCookieHeader(sid: string): string {
  return `${SID_COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SID_MAX_AGE_SEC}`;
}
