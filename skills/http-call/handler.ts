export interface HttpCallInput {
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  query?: Record<string, string>;
  timeout_ms?: number;
}

interface HttpCallResult {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  body: unknown;
}

const DEFAULT_TIMEOUT = 15_000;

export async function execute(args: HttpCallInput): Promise<string> {
  if (!args || typeof args.method !== "string" || typeof args.url !== "string") {
    throw new Error("http_call: method and url are required");
  }

  let url = args.url;
  if (args.query && Object.keys(args.query).length > 0) {
    const qs = new URLSearchParams(args.query).toString();
    url += (url.includes("?") ? "&" : "?") + qs;
  }

  const headers: Record<string, string> = { ...(args.headers ?? {}) };
  const init: RequestInit = { method: args.method, headers };

  const hasBody = args.body !== undefined && args.method !== "GET" && args.method !== "DELETE";
  if (hasBody) {
    if (typeof args.body === "string") {
      init.body = args.body;
    } else {
      init.body = JSON.stringify(args.body);
      if (!Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) {
        headers["Content-Type"] = "application/json";
      }
    }
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), args.timeout_ms ?? DEFAULT_TIMEOUT);
  init.signal = controller.signal;

  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (e) {
    clearTimeout(timeoutId);
    const name = (e as Error).name;
    const message = name === "AbortError" ? "timeout" : (e as Error).message;
    return JSON.stringify({
      status: 0,
      ok: false,
      headers: {},
      body: { error: "network_error", message },
    } satisfies HttpCallResult);
  }
  clearTimeout(timeoutId);

  const text = await res.text();
  let parsedBody: unknown;
  try {
    parsedBody = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    parsedBody = text;
  }

  const respHeaders: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    respHeaders[k] = v;
  });

  const result: HttpCallResult = {
    status: res.status,
    ok: res.ok,
    headers: respHeaders,
    body: parsedBody,
  };
  return JSON.stringify(result);
}
