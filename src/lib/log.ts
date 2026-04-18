// Node-only. Do not import from client components.
// ADR-003 (M1): pino to stdout. Dev=pretty, prod=raw JSON.
// Secrets go through `@vault:<key>` refs, never raw. `redact` is defense-in-depth
// for the case where someone accidentally puts a credential under a common key.

import pino, { type Logger, type LoggerOptions } from "pino";

export type Component = "agent" | "skill" | "vault" | "memory" | "llm" | "route" | "advisor";

const IS_DEV = process.env.NODE_ENV !== "production";

const baseOptions: LoggerOptions = {
  level: process.env.LOG_LEVEL ?? (IS_DEV ? "debug" : "info"),
  timestamp: () => `,"ts":"${new Date().toISOString()}"`,
  formatters: {
    level: (label) => ({ level: label }),
    bindings: ({ pid, hostname, ...rest }) => rest,
  },
  redact: {
    paths: [
      "password",
      "secret",
      "token",
      "api_key",
      "apiKey",
      "authorization",
      "*.password",
      "*.secret",
      "*.token",
      "*.api_key",
      "*.apiKey",
      "*.authorization",
      "headers.authorization",
      "headers.Authorization",
    ],
    censor: "[REDACTED]",
  },
};

const root: Logger = IS_DEV
  ? pino({
      ...baseOptions,
      transport: {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "HH:MM:ss.l", ignore: "pid,hostname" },
      },
    })
  : pino(baseOptions, pino.destination({ sync: true }));

export function createLogger(component: Component): Logger {
  return root.child({ component });
}
