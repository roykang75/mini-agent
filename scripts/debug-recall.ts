import { composeCombinedRecall } from "../src/lib/memory/recall";

import { readFileSync } from "node:fs";
import matter from "gray-matter";
const pid = process.env.DEBUG_PROBLEM ?? "curr-2026-04-18-m002";
const pfile = `/Users/roy/Workspace/agent/agent-curriculum/problems/2026-04-18/${pid}.md`;
const pdoc = matter(readFileSync(pfile, "utf8"));
const userMessage = String(pdoc.data.prompt ?? "");
console.log(`problem: ${pid}`);
console.log(`prompt: ${userMessage.slice(0, 80)}...`);

(async () => {
  const model = process.env.DEBUG_MODEL ?? "claude-sonnet-4-6";
  console.log(`model filter: ${model}`);
  const res = await composeCombinedRecall(
    "/Users/roy/Workspace/agent/agent-memory",
    "/Users/roy/Workspace/agent/agent-curriculum",
    model,
    userMessage,
  );
  console.log("promptLen:", res.prompt.length);
  console.log("memoryHits:", res.memoryHits.length);
  console.log("curriculumHits:", res.curriculumHits.length);
  for (const h of res.curriculumHits) {
    console.log(
      `  - ${h.record.problem_id}  score=${h.score}  matched=[${h.matchedTokens.slice(0, 8).join(",")}]`,
    );
  }
  if (res.prompt.length > 0) {
    console.log("---PROMPT---");
    console.log(res.prompt.slice(0, 1200));
  }
  process.exit(0);
})();
