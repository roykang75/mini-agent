import { LLMError } from "./types";

const RETRYABLE_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const max = opts.maxAttempts ?? 3;
  const base = opts.baseDelayMs ?? 500;
  const cap = opts.maxDelayMs ?? 8000;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= max; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const retryable = e instanceof LLMError && RETRYABLE_STATUSES.has(e.status);
      if (attempt === max || !retryable) throw e;
      const hinted = e instanceof LLMError ? e.retryAfter : undefined;
      const backoff = Math.min(cap, base * 2 ** (attempt - 1));
      const delay = hinted != null && Number.isFinite(hinted) ? Math.max(hinted * 1000, backoff) : backoff;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}