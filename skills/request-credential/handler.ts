export interface RequestCredentialInput {
  key: string;
  description: string;
}

/**
 * This handler is NEVER invoked directly. The agent recognizes `request_credential`
 * and routes approval through `/chat/approve`, where the user types the secret.
 * The function is kept here so the skill-loader codegen scanner finds the skill
 * and the LLM sees the tool definition.
 */
export async function execute(_args: RequestCredentialInput): Promise<string> {
  throw new Error(
    "request_credential must be handled via the HIL approve path; direct execution is not supported.",
  );
}
