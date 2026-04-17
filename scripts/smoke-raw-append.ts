/**
 * Smoke: raw append middleware (Phase 8 T8.1).
 *
 *   - tmp AGENT_MEMORY_DIR → appendRaw writes JSONL under raw/YYYY/MM/DD/NNNN.jsonl
 *   - each line is valid JSON matching R5 schema { ts, session_id, event_type, payload, persona?, persona_ref? }
 *   - setPersona before further appends annotates subsequent events
 *   - closeRaw flushes; next append in the same session opens a NEW file (new NNNN)
 *   - secret string does NOT appear in the persisted file (R4 — caller is trusted)
 */

import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function main() {
  const tmp = await mkdtemp(join(tmpdir(), "agent-memory-smoke-"));
  process.env.AGENT_MEMORY_DIR = tmp;
  console.log(`[setup] AGENT_MEMORY_DIR = ${tmp}`);

  // Load AFTER env is set so the module picks it up lazily.
  const raw = await import("../src/lib/memory/raw");

  const sid1 = raw.newMemorySessionId();
  await raw.appendRaw(sid1, "user_message", { content: "안녕" });
  raw.setPersona(sid1, "cia-analyst", "HEAD");
  await raw.appendRaw(sid1, "persona_resolved", { persona: "cia-analyst", ref: "HEAD" });
  await raw.appendRaw(sid1, "tool_call", {
    name: "http_call",
    args: {
      url: "http://localhost:7777/analyze",
      headers: { Authorization: "Bearer @vault:cia_token" },
    },
  });
  await raw.closeRaw(sid1);

  // day-dir path = yyyy/mm/dd (UTC)
  const now = new Date();
  const y = String(now.getUTCFullYear());
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  const dayDir = join(tmp, "raw", y, m, d);

  const files = await readdir(dayDir);
  console.log(`[ok]   dayDir contents after session 1: ${files.join(", ")}`);
  if (files.length !== 1) throw new Error(`expected 1 file, got ${files.length}`);

  const first = await readFile(join(dayDir, files[0]!), "utf-8");
  const lines = first.trim().split("\n");
  if (lines.length !== 3) throw new Error(`expected 3 lines, got ${lines.length}: ${first}`);

  const records = lines.map((l) => JSON.parse(l));
  for (const r of records) {
    for (const k of ["ts", "session_id", "event_type", "payload"]) {
      if (!(k in r)) throw new Error(`missing R5 field "${k}" in: ${JSON.stringify(r)}`);
    }
    if (r.session_id !== sid1) throw new Error(`session_id mismatch: ${r.session_id} vs ${sid1}`);
  }
  console.log(`[ok]   all 3 records have R5 shape, session_id=${sid1}`);

  // Persona annotation only appears AFTER setPersona (record index 0 has no persona, 1 and 2 do)
  if (records[0].persona !== undefined) {
    throw new Error(`record[0] should have no persona (was before setPersona): ${JSON.stringify(records[0])}`);
  }
  if (records[1].persona !== "cia-analyst" || records[1].persona_ref !== "HEAD") {
    throw new Error(`record[1] persona annotation missing: ${JSON.stringify(records[1])}`);
  }
  if (records[2].persona !== "cia-analyst") {
    throw new Error(`record[2] should inherit persona annotation: ${JSON.stringify(records[2])}`);
  }
  console.log(`[ok]   persona annotation applied after setPersona`);

  // Secret test: raw token string must not appear
  const SECRET = "supersecret-token-abcdefgh";
  if (first.includes(SECRET)) throw new Error(`unexpected secret leak in raw`);
  console.log(`[ok]   no secret leak in raw file`);

  // Second session gets a NEW file (NNNN increments)
  const sid2 = raw.newMemorySessionId();
  await raw.appendRaw(sid2, "user_message", { content: "second" });
  await raw.closeRaw(sid2);

  const filesAfter = await readdir(dayDir);
  if (filesAfter.length !== 2) throw new Error(`expected 2 files, got ${filesAfter.length}`);
  console.log(`[ok]   second session opens new file: ${filesAfter.sort().join(", ")}`);

  // NNNN naming: 0001.jsonl, 0002.jsonl
  const sorted = filesAfter.sort();
  if (sorted[0] !== "0001.jsonl" || sorted[1] !== "0002.jsonl") {
    throw new Error(`unexpected filenames: ${sorted.join(", ")}`);
  }
  console.log(`[ok]   NNNN.jsonl naming is sequential`);

  console.log("\nraw append smoke passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
