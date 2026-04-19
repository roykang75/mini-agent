#!/usr/bin/env tsx
/**
 * cell-canonicalize — ADR-007 post-hoc cell clustering (N=43 baseline 의 1순위 후속).
 *
 * agent-curriculum/observations/* 와 agent-memory/episodes/* (v2) 로부터 모든
 * unique cell_id 수집 → Sonnet 에게 semantic clustering 요청 → canonical 그룹 +
 * cell_id → canonical 매핑을 agent-curriculum/cell-canonical.json 에 기록.
 *
 * audit-retrospection.ts 가 이 파일을 옵션으로 읽어 per-session cell_id 를
 * canonical 로 projection → 의미 있는 per-cell 통계 확보.
 *
 * LLM 의존: AnthropicClient (fetch only, ADR-001 정합). 1 회 호출, ~$0.01.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import matter from "gray-matter";

try {
  (process as unknown as { loadEnvFile?: (p?: string) => void }).loadEnvFile?.(".env.local");
} catch {
  // file missing — chat call will error clearly.
}

import { createLLMClient } from "../src/lib/llm/client";

const MODEL = process.env.CANON_MODEL ?? "claude-sonnet-4-6";

interface CellRecord {
  cell_id: string;
  domain: string;
  sample_count: number;
}

interface CanonicalGroup {
  canonical: string;
  domain: string;
  members: string[];
  rationale: string;
}

interface CanonicalOutput {
  generated_at: string;
  model: string;
  input_cell_count: number;
  canonical_group_count: number;
  canonical_groups: CanonicalGroup[];
  mapping: Record<string, string>;
}

async function collectCells(memoryDir: string, curDir: string): Promise<CellRecord[]> {
  const counter = new Map<string, { domain: string; count: number }>();

  const obsDir = join(curDir, "observations");
  const obsFiles = await readdir(obsDir).catch(() => [] as string[]);
  for (const f of obsFiles.filter((x) => x.endsWith(".md"))) {
    const raw = await readFile(join(obsDir, f), "utf-8");
    const p = matter(raw);
    const fm = p.data as Record<string, unknown>;
    const cells = Array.isArray(fm.cells_observed)
      ? (fm.cells_observed as Array<Record<string, unknown>>)
      : [];
    for (const c of cells) {
      const id = String(c.cell_id ?? "");
      if (!id) continue;
      const cur = counter.get(id) ?? { domain: String(c.domain ?? ""), count: 0 };
      cur.count += 1;
      counter.set(id, cur);
    }
  }

  const epDir = join(memoryDir, "episodes");
  const epFiles = await readdir(epDir).catch(() => [] as string[]);
  for (const f of epFiles.filter((x) => x.endsWith(".md"))) {
    const raw = await readFile(join(epDir, f), "utf-8");
    const p = matter(raw);
    const fm = p.data as Record<string, unknown>;
    const pv = ((fm.consolidation ?? {}) as Record<string, unknown>).prompt_version;
    if (pv !== "v2") continue;
    const l3 = Array.isArray(fm.l3_observations)
      ? (fm.l3_observations as Array<Record<string, unknown>>)
      : [];
    for (const c of l3) {
      const id = String(c.cell_id ?? "");
      if (!id) continue;
      const cur = counter.get(id) ?? { domain: String(c.domain ?? ""), count: 0 };
      cur.count += 1;
      counter.set(id, cur);
    }
  }

  return Array.from(counter.entries())
    .map(([cell_id, v]) => ({ cell_id, domain: v.domain, sample_count: v.count }))
    .sort((a, b) => b.sample_count - a.sample_count || a.cell_id.localeCompare(b.cell_id));
}

async function canonicalize(cells: CellRecord[]): Promise<CanonicalOutput> {
  const systemPrompt = `당신은 agent 의 L3 행동 cell 분석가입니다. 주어진 cell_id 리스트를 받아 **의미적으로 동등한 것끼리** canonical 그룹으로 묶으세요.

"의미적 동등" 기준:
- 같은 agent task type (예: "NPC 개념 설명" 과 "agent 정체성 비교" 는 모두 meta-topic "NPC vs agent 정체성")
- 같은 L3 행동 class (예: "도움 요청 없이 직접 풀이" 와 "자체 해결 시도" 는 모두 strategy "solve_direct")
- cell_id 문자열이 달라도 의미가 겹치면 합친다

**각 canonical 그룹**:
- canonical: 간결한 canonical 이름, \`<domain>:<concept>\` 형식
- domain: 대표 domain
- members: 이 그룹에 속하는 원본 cell_id 리스트 (1 개 싱글톤도 허용)
- rationale: 1 줄 근거

**규칙**:
- 모든 입력 cell_id 가 정확히 하나의 canonical 에 속해야 한다 (coverage 필수, 중복 금지).
- 출력은 JSON code block 하나만. 다른 설명 금지.`;

  const cellList = cells
    .map((c) => `- ${c.cell_id} (domain=${c.domain}, seen=${c.sample_count})`)
    .join("\n");

  const userMessage = `다음 ${cells.length} 개 cell_id 를 canonical 그룹으로 묶어주세요:

${cellList}

출력 형식:
\`\`\`json
{
  "canonical_groups": [
    {
      "canonical": "<domain>:<concept>",
      "domain": "<domain>",
      "members": ["orig_cell_id_1", "orig_cell_id_2"],
      "rationale": "..."
    }
  ]
}
\`\`\``;

  const client = createLLMClient();
  const res = await client.chat({
    model: MODEL,
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  });
  const text = (res.content as Array<{ type: string; text?: string }>)
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n");

  const m = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  const jsonText = m ? m[1]!.trim() : text.trim();
  const parsed = JSON.parse(jsonText) as { canonical_groups: CanonicalGroup[] };

  const mapping: Record<string, string> = {};
  const seen = new Set<string>();
  for (const g of parsed.canonical_groups) {
    for (const mem of g.members) {
      if (seen.has(mem)) throw new Error(`cell_id ${mem} in multiple canonical groups`);
      seen.add(mem);
      mapping[mem] = g.canonical;
    }
  }
  for (const c of cells) {
    if (!mapping[c.cell_id]) throw new Error(`cell_id ${c.cell_id} missing from any canonical group`);
  }

  return {
    generated_at: new Date().toISOString(),
    model: MODEL,
    input_cell_count: cells.length,
    canonical_group_count: parsed.canonical_groups.length,
    canonical_groups: parsed.canonical_groups,
    mapping,
  };
}

async function main() {
  const memoryDir = process.env.AGENT_MEMORY_DIR ?? "/Users/roy/Workspace/agent/agent-memory";
  const curDir = process.env.AGENT_CURRICULUM_DIR ?? "/Users/roy/Workspace/agent/agent-curriculum";

  const cells = await collectCells(memoryDir, curDir);
  console.log(`[canonicalize] collected ${cells.length} unique cells`);

  const output = await canonicalize(cells);
  console.log(`[canonicalize] → ${output.canonical_group_count} canonical groups`);

  const outPath = join(curDir, "cell-canonical.json");
  await writeFile(outPath, JSON.stringify(output, null, 2), "utf-8");
  console.log(`[canonicalize] wrote ${outPath}`);

  for (const g of output.canonical_groups) {
    console.log(`  ${g.canonical.padEnd(50)} ← ${g.members.length} members`);
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("cell-canonicalize failed:", e);
  process.exit(1);
});
