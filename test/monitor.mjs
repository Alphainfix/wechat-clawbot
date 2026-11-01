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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

rmSync(DIR, { recursive: true, force: true });

if (failures.length > 0) {
  console.error(`monitor: ${pass} passed, ${failures.length} failed`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}
console.log(`monitor: ${pass} passed, 0 failed`);
