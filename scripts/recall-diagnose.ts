/**
 * recall-diagnose — composeCombinedRecall 직접 호출 진단 도구.
 *
 * dev server agent loop 안의 recall 이벤트 (memory_recalled / curriculum_recalled
 * / self_map_recalled / recent_sessions_recalled) 는 agent-runner 로 yield 되는
 * internal 신호라 console log 만으로는 발동 여부를 확인할 수 없다. 이 스크립트는
 * 동일 함수에 동일 인자를 주고 builder 별 hits 분포 + prompt preview 를 직접
 * 본다.
 *
 * 사용:
 *   npx tsx scripts/recall-diagnose.ts "<query text>" [model]
 *   npx tsx scripts/recall-diagnose.ts                # default query (15차 sample)
 *
 * env:
 *   AGENT_MEMORY_DIR (default /Users/roy/Workspace/agent/agent-memory)
 *   CURRICULUM_DIR   (default /Users/roy/Workspace/agent/agent-curriculum)
 *
 * 15차 ablation 1차 시도(2026-04-30)에서 처음 작성. 이후 임의 query / model 로
 * 재사용 가능.
 */

import { composeCombinedRecall, resetRecallClock } from "../src/lib/memory/recall";

const args = process.argv.slice(2);
const query = args[0]
  ?? `agent-curriculum/analyses/*.md (README.md 제외) 을 전부 read 하여 테마별 cluster 로 묶고, agent-memory/knowledge/analyses-index-allon-01.md 에 작성한다. 15차 ablation 실험 (allon 01).`;
const model = args[1] ?? "claude-sonnet-4-6";

const memoryDir =
  process.env.AGENT_MEMORY_DIR ?? "/Users/roy/Workspace/agent/agent-memory";
const curriculumDir =
  process.env.CURRICULUM_DIR ?? "/Users/roy/Workspace/agent/agent-curriculum";

(async () => {
  resetRecallClock();
  const res = await composeCombinedRecall(memoryDir, curriculumDir, model, query, {
    includeMemory: true,
    includeCurriculum: true,
    includeSelfMap: true,
    includeRecentSessions: true,
  });
  console.log(
    JSON.stringify(
      {
        query: query.slice(0, 200),
        model,
        memoryDir,
        curriculumDir,
        promptLen: res.prompt.length,
        promptPreview: res.prompt.slice(0, 600),
        memoryHits: res.memoryHits.length,
        curriculumHits: res.curriculumHits.length,
        selfMapHits: res.selfMapHits.length,
        recentSessionsHits: res.recentSessionsHits.length,
        memoryIds: res.memoryHits.map((h) => h.episode.id).slice(0, 5),
        curriculumIds: res.curriculumHits.map((h) => h.record.problem_id).slice(0, 5),
      },
      null,
      2,
    ),
  );
})().catch((e) => {
  console.error("err:", e);
  process.exit(1);
});
