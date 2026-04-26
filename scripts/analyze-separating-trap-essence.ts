#!/usr/bin/env tsx
/**
 * separating trap essence 검증 — pr005/mt007/mt009 의 wrong/partial vs correct
 * 답변 본문이 같은 epistemic dimension 측정인지 외부 LLM (Opus) 분석.
 */

import { readFileSync } from "node:fs";
import { askAdvisor } from "../src/lib/llm/advisor";

try {
  (process as unknown as { loadEnvFile?: (p?: string) => void }).loadEnvFile?.(".env.local");
} catch {}

async function main() {
  const samples = readFileSync("/tmp/trap-analysis-input.txt", "utf-8");

  const prompt = `당신은 epistemic discipline 측정 trap 카탈로그의 본질 분석을 의뢰받았다.

세 trap 의 답변 sample 을 보고 다음 4 질문에 정확히 답하라:

1. **pr005 wrong (N=13, Haiku 100% wrong) 의 frame 결여**: 답변에서 어떤 epistemic 작용이 부재한가? 한 두 단어로 핵심 결여를 명명하라.

2. **mt007/mt009 correct (각 N=4) 의 공통 frame 보유**: 답변에서 어떤 epistemic 작용이 일관 작동하는가? 한 두 단어로 핵심 보유를 명명하라.

3. **mt007/mt009 partial (각 N=6) 의 frame 부분 보유**: correct 와 다른 점은 무엇인가? 어떤 sub-차원이 빠지는가?

4. **결론**: pr005/mt007/mt009 가 같은 epistemic dimension (예: "외부 정보 critical evaluation 능력") 의 측정 trap 인가, 아니면 다른 차원 trap 인가? 단정하지 말고 증거 기반 평가하라. 만약 같은 차원이라면 capability gradient 측정 도구로 valid 한 카탈로그라고 볼 수 있고, 다른 차원이라면 각 trap 은 별개 능력 측정으로 분리된다.

# 분석 데이터 (각 outcome 별 2 sample)

${samples}

# 출력 포맷

JSON 만 출력:
{
  "pr005_wrong_missing": "<short label>",
  "mt007_mt009_correct_present": "<short label>",
  "mt007_mt009_partial_subdim_missing": "<short label>",
  "conclusion": "same_dimension" | "different_dimensions" | "partially_overlapping",
  "evidence": "<한 paragraph>",
  "confidence": 0.0-1.0
}`;

  console.log("[analyze] sending to Opus advisor...");
  const text = await askAdvisor({
    question: prompt,
    context_summary: "separating trap essence cross-validation",
    what_tried: "extracted sample answers from pr005 / mt007 / mt009 Haiku runs, comparing wrong vs correct vs partial frames",
  });

  console.log("\n=== Opus advisor response ===\n");
  console.log(text);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
