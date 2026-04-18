import { askAdvisor, type AdvisorAskInput } from "../../src/lib/llm/advisor";

export async function execute(args: AdvisorAskInput): Promise<string> {
  if (!args || typeof args.question !== "string" || typeof args.context_summary !== "string") {
    throw new Error("ask_advisor: question and context_summary are required strings");
  }
  if (args.what_tried !== undefined && typeof args.what_tried !== "string") {
    throw new Error("ask_advisor: what_tried must be a string when provided");
  }

  // Vault ref detection — advisor is stateless and cannot resolve refs.
  // Agent must surface semantic content, not raw references. If it slips a
  // ref through, we surface a structured error so the agent can re-compose
  // the question without the ref (and we avoid leaking refs to Opus).
  const combined = `${args.question}\n${args.context_summary}\n${args.what_tried ?? ""}`;
  if (combined.includes("@vault:")) {
    throw new Error(
      "ask_advisor: input contains @vault:<ref>. Advisors cannot resolve vault references. Rephrase the question without the ref — describe the value's role, not its identifier.",
    );
  }

  return askAdvisor(args);
}
