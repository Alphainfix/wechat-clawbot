#!/usr/bin/env node
/**
 * Offline checks for the monitor's at-least-once bookkeeping (`src/monitor.ts`).
 *
 * The cursor fix only works if a replayed batch is recognised, so the two keys
 * it relies on are pinned here: the client id (stable) is preferred, `seq` is
 * namespaced, and the numeric `message_id` is never used — it exceeds 2^53 and
 * arrives rounded, which would make two different messages look identical.
 *
 *   node test/monitor.mjs
 *
 * Exits non-zero when any check fails.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

const { messageKey, SeenSet } = await import(join(ROOT, "lib/monitor.js"));

let pass = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) pass += 1;
  else failures.push(`${name}${detail === undefined ? "" : `\n      ${detail}`}`);
}
function equal(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ---------------------------------------------------------------- the key

equal("client id wins", messageKey({ client_id: "mmassistant_1", seq: 7 }), "mmassistant_1");
equal("seq is namespaced", messageKey({ seq: 7 }), "seq:7");
equal("an empty client id falls back to seq", messageKey({ client_id: "  ", seq: 8 }), "seq:8");
equal("no id at all", messageKey({}), null);
// The whole point: the rounded numeric id must never be the key.
equal("message_id is not used", messageKey({ message_id: 7522692611398973000 }), null);

// ---------------------------------------------------------------- the set

const DIR = mkdtempSync(join(tmpdir(), "clawbot-seen-"));
const FILE = join(DIR, "sync-buf.json.seen.json");

const seen = new SeenSet(FILE);
check("nothing seen yet", seen.has("a") === false);
seen.add("a");
check("an added key is seen", seen.has("a"));
check("it reaches the disk", readFileSync(FILE, "utf-8").includes('"a"'));

const reopened = new SeenSet(FILE);
check("a new instance remembers", reopened.has("a"));
reopened.add("b");
check("and keeps growing", reopened.has("a") && reopened.has("b"));

// The set is bounded: the oldest ids fall off, the newest stay.
const big = new SeenSet(join(DIR, "big.json"));
for (let i = 0; i < 600; i++) big.add(`key-${i}`);
check("the newest survives", big.has("key-599"));
check("the oldest is forgotten", big.has("key-0") === false);
check("the file stays bounded", JSON.parse(readFileSync(join(DIR, "big.json"), "utf-8")).ids.length === 500);

// Adding the same key twice must not grow the set or rewrite differently.
const twice = new SeenSet(join(DIR, "twice.json"));
twice.add("x");
twice.add("x");
equal("duplicates collapse", JSON.parse(readFileSync(join(DIR, "twice.json"), "utf-8")).ids, ["x"]);

// A corrupt file degrades to "nothing seen" — at-least-once, never a crash.
writeFileSync(join(DIR, "bad.json"), "not json at all", "utf-8");
const broken = new SeenSet(join(DIR, "bad.json"));
check("a corrupt file yields an empty set", broken.has("a") === false);
broken.add("a");
check("and recovers on the next write", JSON.parse(readFileSync(join(DIR, "bad.json"), "utf-8")).ids.includes("a"));

// A directory that does not exist yet is created on the first write.
const nested = new SeenSet(join(DIR, "deep", "deeper", "seen.json"));
nested.add("z");
check("nested paths are created", nested.has("z"));

check("the seen file is private (0600)", (statSync(join(DIR, "twice.json")).mode & 0o777) === 0o600);

rmSync(DIR, { recursive: true, force: true });

// ---------------------------------------------------------------- the loop
// runMonitor against a fake iLink server on this machine: a batch interrupted
// by a stop does not move the cursor, the replay is absorbed by the seen set,
// a handler that throws does not wedge later messages, and a cursor that
// cannot be written does not stop the loop. No WeChat, no network beyond
// 127.0.0.1.
{
  const STATE = mkdtempSync(join(tmpdir(), "clawbot-monitor-loop-"));
  process.env.CLAWBOT_STATE_DIR = STATE;
  const { runMonitor } = await import(join(ROOT, "lib/monitor.js"));
  const { getSyncBufFilePath, loadGetUpdatesBuf } = await import(join(ROOT, "lib/ilink/storage/sync-buf.js"));
  const { setLogLevel } = await import(join(ROOT, "lib/ilink/util/logger.js"));
  setLogLevel("error");

  const msg = (n) => ({ seq: n, client_id: `client-${n}`, message_id: 7522692611398973000 + n, from_user_id: "u1",
    item_list: [{ type: 1, text_item: { text: `m${n}` } }] });
  // What the fake server answers for each cursor; anything else is an empty poll.
  let batches = { "": { msgs: [msg(1), msg(2), msg(3)], next: "buf-1" } };
  const asked = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (!req.url.endsWith("/ilink/bot/getupdates")) { res.end('{"ret":0}'); return; }
      const cursor = JSON.parse(body).get_updates_buf ?? "";
      asked.push(cursor);
      const batch = batches[cursor];
      if (batch) { res.end(JSON.stringify({ ret: 0, msgs: batch.msgs, get_updates_buf: batch.next })); return; }
      setTimeout(() => res.end(JSON.stringify({ ret: 0, msgs: [], get_updates_buf: cursor })), 30);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const account = { accountId: "loop-test", baseUrl: `http://127.0.0.1:${server.address().port}`, cdnBaseUrl: "http://127.0.0.1:9",
    token: "t", enabled: true, configured: true };
  const syncPath = getSyncBufFilePath(account.accountId);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const run = async (onMessage, until) => {
    const controller = new AbortController();
    const handled = [];
    const done = runMonitor({ account, signal: controller.signal, onStop: () => {},
      onMessage: async (m) => { handled.push(m.client_id); await onMessage(m, controller); } });
    for (let i = 0; i < 200 && !until(handled, controller); i++) await sleep(10);
    controller.abort();
    let rejected = null;
    await done.catch((err) => { rejected = err; });
    return { handled, rejected };
  };

  // 1. Stopped while handling the second message of three.
  const first = await run(async (m, controller) => { if (m.client_id === "client-2") controller.abort(); },
    (_handled, controller) => controller.signal.aborted);
  check("loop: a stop in the middle of a batch leaves the rest of it unhandled",
    first.handled.join(",") === "client-1,client-2", first.handled.join(","));
  check("loop: …and does not move the cursor past it", loadGetUpdatesBuf(syncPath) === undefined || loadGetUpdatesBuf(syncPath) === "",
    String(loadGetUpdatesBuf(syncPath)));

  // 2. The next start gets the same batch again: the two handled ones are skipped.
  const second = await run(async () => {}, () => asked.includes("buf-1"));
  check("loop: the next start replays the batch and answers only the message it never handled",
    second.handled.join(",") === "client-3", second.handled.join(","));
  check("loop: …then the cursor moves on", loadGetUpdatesBuf(syncPath) === "buf-1", String(loadGetUpdatesBuf(syncPath)));
  check("loop: the seen file next to the cursor is private (0600)",
    (statSync(`${syncPath}.seen.json`).mode & 0o777) === 0o600);

  // 3. A message whose handler throws is skipped, not retried forever, and the next one is answered.
  batches = { "buf-1": { msgs: [msg(4), msg(5)], next: "buf-2" } };
  const third = await run(async (m) => { if (m.client_id === "client-4") throw new Error("broken media"); },
    () => asked.includes("buf-2"));
  check("loop: a handler that throws does not hold up the next message or the cursor",
    third.handled.join(",") === "client-4,client-5" && loadGetUpdatesBuf(syncPath) === "buf-2" && third.rejected === null,
    JSON.stringify({ handled: third.handled, cursor: loadGetUpdatesBuf(syncPath), rejected: String(third.rejected) }));

  // 4. The cursor file cannot be written (a directory in its place): the loop keeps polling.
  // (With no readable cursor the next start asks from the beginning.)
  rmSync(syncPath, { force: true });
  mkdirSync(syncPath);
  batches = { "": { msgs: [msg(6)], next: "buf-3" } };
  const polls = asked.length;
  const fourth = await run(async () => {}, () => asked.includes("buf-3"));
  check("loop: a cursor that cannot be saved is logged, and polling goes on",
    fourth.rejected === null && fourth.handled.join(",") === "client-6" && asked.slice(polls).includes("buf-3"),
    JSON.stringify({ handled: fourth.handled, rejected: String(fourth.rejected), asked: asked.slice(polls) }));

  await new Promise((resolve) => server.close(resolve));
  rmSync(STATE, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`monitor: ${pass} passed, ${failures.length} failed`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}
console.log(`monitor: ${pass} passed, 0 failed`);
