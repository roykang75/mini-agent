/**
 * Advisor module (ADR-004).
 *
 * Agent 가 자기 한계를 인지하고 `ask_advisor` skill 을 부를 때 호출되는
 * 상위 모델 (기본 Opus) 경로. 일반 LLMRequest 를 AnthropicClient 에
 * 넘기되 별도 API key 와 모델을 쓴다.
 *
 * Advisor 는 stateless — SOUL / memory / tools 없음. question +
 * context_summary (+ what_tried) 만 받아서 free-form 답을 돌려준다.
 *
 * 로그 이벤트 (component=advisor):
 *   - advisor_request  (질문/맥락 길이만, 본문은 미포함)
 *   - advisor_response (duration, tokens, response_length)
 *   - advisor_error    (status, 메시지 head)
 */

import { AnthropicClient } from "./providers/anthropic";
import type { LLMResponse } from "./types";
import { createLogger } from "../log";

const log = createLogger("advisor");

const ADVISOR_SYSTEM_PROMPT = `당신은 다른 agent 가 막혔을 때 도움을 주는 조력자다. agent 는 자신의 한계를 인지하고 당신에게 도움을 청했다. question 과 context 를 읽고 구체적이고 실행 가능한 답을 주어라. 단 agent 가 그 답을 소화해야 하니 너무 긴 설명은 피하고 핵심만 3~5 문단 이내로.`;

export interface AdvisorAskInput {
  question: string;
  context_summary: string;
  what_tried?: string;
}

export interface AdvisorClientOptions {
  apiKey?: string;
  baseURL?: string;
  model?: string;
  maxTokens?: number;
}

export async function askAdvisor(
  input: AdvisorAskInput,
  opts: AdvisorClientOptions = {},
): Promise<string> {
  const apiKey = opts.apiKey ?? process.env.ADVISOR_API_KEY ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("askAdvisor: ADVISOR_API_KEY or ANTHROPIC_API_KEY is required");
  }
  const model = opts.model ?? process.env.ADVISOR_MODEL ?? "claude-opus-4-7";
  const maxTokens = opts.maxTokens ?? Number(process.env.ADVISOR_MAX_TOKENS ?? 4096);

  const client = new AnthropicClient({ apiKey, baseURL: opts.baseURL });

  const userContent = [
    `## question\n${input.question}`,
    `## context\n${input.context_summary}`,
    input.what_tried ? `## what_tried\n${input.what_tried}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const started = Date.now();
  log.info(
    {
      event: "advisor_request",
      model,
      question_length: input.question.length,
      context_length: input.context_summary.length,
      what_tried_length: input.what_tried?.length ?? 0,
    },
    "advisor called",
  );

  let resp: LLMResponse;
  try {
    resp = await client.chat({
      model,
      max_tokens: maxTokens,
      system: [{ type: "text", text: ADVISOR_SYSTEM_PROMPT }],
      messages: [{ role: "user", content: userContent }],
    });
  } catch (e) {
    const err = e as Error;
    log.warn(
      {
        event: "advisor_error",
        model,
        duration_ms: Date.now() - started,
        err_name: err.name,
        err_message: err.message.slice(0, 200),
      },
      "advisor call failed",
    );
    throw e;
  }

  const text = resp.content
    .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  log.info(
    {
      event: "advisor_response",
      model,
      duration_ms: Date.now() - started,
      tokens_in: resp.usage.input_tokens,
      tokens_out: resp.usage.output_tokens,
      cache_creation_tokens: resp.usage.cache_creation_input_tokens ?? 0,
      cache_read_tokens: resp.usage.cache_read_input_tokens ?? 0,
      response_length: text.length,
      stop_reason: resp.stop_reason,
    },
    "advisor responded",
  );

  return text;
}
