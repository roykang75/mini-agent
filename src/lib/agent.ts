/**
 * Thin shim — after ADR-005 the real implementation lives in `./agent/instance.ts`
 * and `./agent/registry.ts`. This file re-exports the stable surface for
 * modules that still import from `@/lib/agent`.
 */

export {
  AgentInstance,
  REQUEST_CREDENTIAL_TOOL,
  ASK_ADVISOR_TOOL,
  RETRY_LIMIT,
  ADVISOR_CALL_LIMIT,
  hashToolCall,
  countPriorToolUses,
} from "./agent/instance";
export type { AgentIntrospection } from "./agent/instance";

export { summonAgent, getAgent, disposeAgent, sweepIdle } from "./agent/registry";
