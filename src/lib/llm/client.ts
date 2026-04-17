import type { LLMRequest, LLMResponse } from "./types";
import { AnthropicClient } from "./providers/anthropic";

export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "done"; response: LLMResponse };

export interface LLMClient {
  chat(req: LLMRequest): Promise<LLMResponse>;
  chatStream(req: LLMRequest): AsyncGenerator<StreamEvent, void, void>;
}

export function createLLMClient(): LLMClient {
  const provider = process.env.LLM_PROVIDER ?? "anthropic";
  switch (provider) {
    case "anthropic":
      return new AnthropicClient();
    default:
      throw new Error(`Unknown LLM provider: ${provider}`);
  }
}