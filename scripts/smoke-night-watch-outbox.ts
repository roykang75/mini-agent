// Night's Watch outbox + retry smoke (Phase 2 잔여).
//
// Verifies:
//   1. flush 실패 시 batch 가 .observer-outbox 디스크에 적재됨
//   2. reapOutbox 가 서버 살아있을 때 파일을 발송 후 삭제
//   3. 서버 죽어 있는 상태에서는 retry 카운터가 파일명에 누적
//   4. retry 가 MAX 도달하면 dead/ 디렉토리로 이동
//
// fake server 가 mode 변수로 동적으로 200 / 503 사이 토글.

import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NightWatchClient } from "@/lib/observability/night-watch";

const ASSERT_TAG = "smoke-night-watch-outbox";
let assertions = 0;
function assertEq<T>(name: string, got: T, want: T): void {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) {
    console.error(`[FAIL] ${name}: got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
    process.exit(1);
  }
  assertions += 1;
}
function assertGte(name: string, got: number, want: number): void {
  if (got < want) {
    console.error(`[FAIL] ${name}: got=${got} want>=${want}`);
    process.exit(1);
  }
  assertions += 1;
}

async function main(): Promise<void> {
  let mode: "ok" | "fail" = "fail";

  const server: Server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/ingest") {
      if (mode === "fail") {
        res.statusCode = 503;
        res.end("server down");
        return;
      }
      res.statusCode = 200;
      res.end(JSON.stringify({ accepted: 1, skipped: 0, errors: [] }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const outboxDir = mkdtempSync(join(tmpdir(), "nw-outbox-"));

  const client = new NightWatchClient({
    enabled: true,
    baseUrl,
    token: null,
    agent: { name: "mini-agent", version: "0.0.0", hostname: "host" },
    outboxDir,
    outboxEnabled: true,
  });

  // --- 1. flush 실패 → 파일 적재 ---
  client.push({ op: "trace_start", trace: { trace_id: "t1", agent_name: "a", started_at: 1 } });
  await client.flush();
  await new Promise((r) => setTimeout(r, 50));
  let files = readdirSync(outboxDir).filter((f) => f.endsWith(".jsonl"));
  assertEq("1.outbox file count after fail", files.length, 1);
  assertEq("1.first file ends with -r0.jsonl", /-r0\.jsonl$/.test(files[0]), true);

  // --- 2. server 죽어있는 상태에서 reap → retry 카운터 +1 ---
  let r = await client.reapOutbox();
  assertEq("2.tried 1", r.tried, 1);
  assertEq("2.failed 1", r.failed, 1);
  files = readdirSync(outboxDir).filter((f) => f.endsWith(".jsonl"));
  assertEq("2.file still exists", files.length, 1);
  assertEq("2.now -r1.jsonl", /-r1\.jsonl$/.test(files[0]), true);

  // --- 3. server 부활 → reap 으로 파일 사라짐 ---
  mode = "ok";
  r = await client.reapOutbox();
  assertEq("3.ok 1", r.ok, 1);
  files = readdirSync(outboxDir).filter((f) => f.endsWith(".jsonl"));
  assertEq("3.file removed", files.length, 0);

  // --- 4. 다시 fail 모드 → MAX_RETRY 까지 reap 반복 → dead/ 로 이동 ---
  mode = "fail";
  client.push({ op: "trace_start", trace: { trace_id: "t2", agent_name: "a", started_at: 2 } });
  await client.flush();
  await new Promise((res) => setTimeout(res, 50));
  for (let i = 0; i < 6; i++) await client.reapOutbox();
  const liveFiles = readdirSync(outboxDir).filter((f) => f.endsWith(".jsonl"));
  assertEq("4.no live file", liveFiles.length, 0);
  const deadFiles = readdirSync(join(outboxDir, "dead"));
  assertGte("4.dead has 1", deadFiles.length, 1);

  // teardown
  client.stopReaper();
  rmSync(outboxDir, { recursive: true, force: true });
  await new Promise<void>((r) => server.close(() => r()));

  console.log(`[OK] ${ASSERT_TAG} passed ${assertions} assertions`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
