#!/usr/bin/env tsx
/**
 * smoke-verifier-hook — verifier+plausibility hook 의 lib + advisor wire smoke test.
 *
 * 운영 integration step 1 의 final 단계 (NEXT.md 18-세션). v16 best 조합이
 * 라이브러리로 추출된 게 정상 동작하는지 + advisor flow 가 깨지지 않았는지
 * 동시에 확인.
 *
 * 시나리오:
 *   1. config 로딩 (env override + file fallback) — API 호출 없음
 *   2. 정상 advisor 흐름 (verify off) — Opus 답이 그대로 통과
 *   3. fab-prone (q, a) 직접 verify chain — REJECT 기대
 *   4. well-known (q, a) 직접 verify chain — plausibility=YES skip 기대
 *
 * env:
 *   ANTHROPIC_API_KEY  required for 2,3,4
 *   SMOKE_DRY_RUN=1    skip API 호출 (1만 실행)
 */

import { runVerifyChain, runPlausibilityCheck, runVerifierCheck } from "../../src/lib/llm/verify";
import { askAdvisor } from "../../src/lib/llm/advisor";
import {
  loadVerifierHookConfig,
  isAdvisorHookActive,
  isAgentTurnHookActive,
  __resetVerifierHookConfigCache,
} from "../../src/lib/config/verifier";

try {
  (process as unknown as { loadEnvFile?: (p?: string) => void }).loadEnvFile?.(".env.local");
} catch {}

const DRY_RUN = process.env.SMOKE_DRY_RUN === "1";

interface CaseResult {
  name: string;
  ok: boolean;
  detail: string;
}

const results: CaseResult[] = [];
function record(name: string, ok: boolean, detail: string) {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "✓" : "✗"} ${name} — ${detail}`);
}

async function step1_configLoading() {
  console.log("\n[1] config loading");
  __resetVerifierHookConfigCache();
  const cfgDefault = loadVerifierHookConfig();
  record(
    "default (file) loaded",
    cfgDefault.enabled === false &&
      cfgDefault.plausibility.depth_limit === 2 &&
      cfgDefault.plausibility.model.includes("haiku") &&
      cfgDefault.verifier.model === "claude-opus-4-7" &&
      cfgDefault.verifier.prompt_version === "v3" &&
      cfgDefault.runtime_policy.strategy === "auto" &&
      cfgDefault.runtime_policy.skip_policy === "easy-only-depth",
    `enabled=${cfgDefault.enabled}, plaus=${cfgDefault.plausibility.model}, depth=${cfgDefault.plausibility.depth_limit}, verifier=${cfgDefault.verifier.model}, version=${cfgDefault.verifier.prompt_version}, strategy=${cfgDefault.runtime_policy.strategy}, skip=${cfgDefault.runtime_policy.skip_policy}`,
  );

  __resetVerifierHookConfigCache();
  process.env.VERIFIER_HOOK = "on";
  process.env.PLAUSIBILITY_DEPTH_LIMIT = "5";
  process.env.VERIFIER_STRATEGY = "local-gemma-current";
  process.env.VERIFIER_HISTORY_TURNS = "6";
  const cfgEnv = loadVerifierHookConfig();
  record(
    "env override applied",
    cfgEnv.enabled === true &&
      cfgEnv.plausibility.depth_limit === 5 &&
      cfgEnv.runtime_policy.strategy === "local-gemma-current" &&
      cfgEnv.runtime_policy.history_turns === 6,
    `enabled=${cfgEnv.enabled}, depth=${cfgEnv.plausibility.depth_limit}, strategy=${cfgEnv.runtime_policy.strategy}, history_turns=${cfgEnv.runtime_policy.history_turns}`,
  );
  delete process.env.VERIFIER_HOOK;
  delete process.env.PLAUSIBILITY_DEPTH_LIMIT;
  delete process.env.VERIFIER_STRATEGY;
  delete process.env.VERIFIER_HISTORY_TURNS;
  __resetVerifierHookConfigCache();

  // master OFF → 둘 다 비활성
  __resetVerifierHookConfigCache();
  const cfgMasterOff = loadVerifierHookConfig();
  record(
    "master OFF → both hooks inactive",
    !isAdvisorHookActive(cfgMasterOff) && !isAgentTurnHookActive(cfgMasterOff),
    `advisor_active=${isAdvisorHookActive(cfgMasterOff)}, agent_turn_active=${isAgentTurnHookActive(cfgMasterOff)}`,
  );

  // master ON, individual default true → 둘 다 활성
  process.env.VERIFIER_HOOK = "on";
  __resetVerifierHookConfigCache();
  const cfgMasterOn = loadVerifierHookConfig();
  record(
    "master ON → both hooks active (default)",
    isAdvisorHookActive(cfgMasterOn) && isAgentTurnHookActive(cfgMasterOn),
    `advisor_active=${isAdvisorHookActive(cfgMasterOn)}, agent_turn_active=${isAgentTurnHookActive(cfgMasterOn)}`,
  );

  // master ON + agent_turn OFF → advisor 만 ON
  process.env.VERIFIER_HOOK_AGENT_TURN = "off";
  __resetVerifierHookConfigCache();
  const cfgPartial = loadVerifierHookConfig();
  record(
    "master ON + agent_turn OFF → advisor only",
    isAdvisorHookActive(cfgPartial) && !isAgentTurnHookActive(cfgPartial),
    `advisor_active=${isAdvisorHookActive(cfgPartial)}, agent_turn_active=${isAgentTurnHookActive(cfgPartial)}`,
  );

  delete process.env.VERIFIER_HOOK;
  delete process.env.VERIFIER_HOOK_AGENT_TURN;
  __resetVerifierHookConfigCache();
}

async function step2_normalAdvisorFlow() {
  console.log("\n[2] 정상 advisor flow (verify=off)");
  if (DRY_RUN) {
    record("normal advisor flow", true, "skipped (SMOKE_DRY_RUN=1)");
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    record("normal advisor flow", false, "ANTHROPIC_API_KEY missing");
    return;
  }
  try {
    const text = await askAdvisor(
      {
        question: "한 줄로 인사해줘.",
        context_summary: "smoke test 중. 짧은 응답이면 충분.",
      },
      { model: "claude-haiku-4-5-20251001", maxTokens: 100, verify: "off" },
    );
    record(
      "normal advisor flow",
      text.length > 0 && !text.includes("verifier rejected"),
      `len=${text.length}, head="${text.slice(0, 40).replace(/\n/g, " ")}..."`,
    );
  } catch (e) {
    record("normal advisor flow", false, `err: ${(e as Error).message.slice(0, 100)}`);
  }
}

async function step3_fabProneVerifyChain() {
  console.log("\n[3] fab-prone (q,a) — verifier REJECT 기대");
  if (DRY_RUN) {
    record("fab-prone REJECT", true, "skipped (SMOKE_DRY_RUN=1)");
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    record("fab-prone REJECT", false, "ANTHROPIC_API_KEY missing");
    return;
  }
  // mtcal-style: cross-context entity confusion (Hassabis 가 받은 노벨상은 화학상이지만 물리학상으로 단정)
  const question = "2024년 노벨 물리학상을 수상한 Demis Hassabis 의 학부 졸업 대학은?";
  const fabricated = "Demis Hassabis 는 University of Cambridge 에서 컴퓨터과학으로 학부를 졸업했습니다.";
  try {
    const result = await runVerifyChain(question, fabricated, {
      category: "fabrication-cascade",
      tier: "T3",
      turn_index: 3,
      depth_limit: 2,
    });
    const rejected = result.path === "verifier_applied" && !result.accepted;
    record(
      "fab-prone REJECT",
      rejected,
      `path=${result.path}, accepted=${result.accepted}, plaus=${result.plausibility?.verdict}, verifier=${result.verifier?.verdict}, final="${result.final_answer.slice(0, 40)}..."`,
    );
  } catch (e) {
    record("fab-prone REJECT", false, `err: ${(e as Error).message.slice(0, 100)}`);
  }
}

async function step4_wellKnownVerifyChain() {
  console.log("\n[4] well-known (q,a) — plausibility skip 기대");
  if (DRY_RUN) {
    record("well-known skip", true, "skipped (SMOKE_DRY_RUN=1)");
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    record("well-known skip", false, "ANTHROPIC_API_KEY missing");
    return;
  }
  const question = "대한민국의 수도는?";
  const wellKnown = "대한민국의 수도는 서울입니다.";
  try {
    const result = await runVerifyChain(question, wellKnown, {
      category: "easy-cascade-baseline",
      tier: "T1",
      turn_index: 1,
      depth_limit: 2,
    });
    const skipped = result.path === "plausibility_skip" && result.accepted;
    record(
      "well-known skip",
      skipped,
      `path=${result.path}, accepted=${result.accepted}, plaus=${result.plausibility?.verdict}, final="${result.final_answer.slice(0, 40)}..."`,
    );
  } catch (e) {
    record("well-known skip", false, `err: ${(e as Error).message.slice(0, 100)}`);
  }
}

async function step5_individualPrimitives() {
  console.log("\n[5] runPlausibilityCheck / runVerifierCheck primitives");
  if (DRY_RUN) {
    record("primitives", true, "skipped (SMOKE_DRY_RUN=1)");
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    record("primitives", false, "ANTHROPIC_API_KEY missing");
    return;
  }
  try {
    const plaus = await runPlausibilityCheck("프랑스의 수도는?", "파리입니다.");
    const verif = await runVerifierCheck(
      "이 영화의 감독이 5년 전 만든 영화의 제작국은?",
      "프랑스입니다.",
      { category: "fabrication-cascade", tier: "T3" },
    );
    record(
      "primitives",
      ["YES", "NO", "PARSE_FAIL"].includes(plaus.verdict) &&
        ["ACCEPT", "REJECT", "PARSE_FAIL"].includes(verif.verdict),
      `plaus=${plaus.verdict}, verif=${verif.verdict}`,
    );
  } catch (e) {
    record("primitives", false, `err: ${(e as Error).message.slice(0, 100)}`);
  }
}

async function main() {
  console.log(`[smoke-verifier-hook] DRY_RUN=${DRY_RUN}, ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY ? "set" : "missing"}`);

  await step1_configLoading();
  await step2_normalAdvisorFlow();
  await step3_fabProneVerifyChain();
  await step4_wellKnownVerifyChain();
  await step5_individualPrimitives();

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log(`\n=== ${passed}/${results.length} passed${failed > 0 ? `, ${failed} failed` : ""} ===`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
