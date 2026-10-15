#!/usr/bin/env node
/**
 * Build Clawbot-Calendar.app for real and talk to it through LaunchServices,
 * the way the plugin does — without ever asking for calendar access, so it
 * shows no permission prompt and reads no events. macOS with the Xcode command
 * line tools only; anywhere else it says why it skipped.
 *
 *   node test/mac-calendar.mjs
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); }
};

if (process.platform !== "darwin") {
  console.log("跳过:只在 macOS 上跑");
  process.exit(0);
}
try {
  execFileSync("xcrun", ["--find", "swiftc"], { stdio: "ignore" });
} catch {
  console.log("跳过:没有 Xcode 命令行工具(xcode-select --install)");
  process.exit(0);
}

const { setLogLevel } = await import(join(ROOT, "lib/ilink/util/logger.js"));
setLogLevel("error");
const { CalendarHelper, HELPER_NAME } = await import(join(ROOT, "lib/mac-calendar.js"));
const root = join(tmpdir(), `clawbot-calendar-build-${process.pid}`);
const helper = new CalendarHelper(root, join(ROOT, "native/macos-calendar/main.swift"));

const started = Date.now();
await helper.ensureBuilt();
const app = helper.appPath;
check(`builds ${HELPER_NAME}.app (${Math.round((Date.now() - started) / 1000)} s)`, existsSync(join(app, "Contents", "MacOS", HELPER_NAME)));
check("rebuilding is skipped while the source is unchanged", helper.isBuilt());

const plist = readFileSync(join(app, "Contents", "Info.plist"), "utf-8");
check("the permission prompt has its explanation (full access, and the older key)",
  /NSCalendarsFullAccessUsageDescription/.test(plist) && /NSCalendarsUsageDescription/.test(plist));
check("it runs without a Dock icon", /<key>LSUIElement<\/key><true\/>/.test(plist));
check(`the prompt names it ${HELPER_NAME}`, plist.includes(`<key>CFBundleDisplayName</key><string>${HELPER_NAME}</string>`));
let signed = true;
try {
  execFileSync("codesign", ["--verify", "--strict", app], { stdio: "pipe" });
} catch (err) {
  signed = false;
  check("the bundle is signed", false, String(err.stderr ?? err));
}
if (signed) check("the bundle is signed", true);

// One real round trip through `open`: status never prompts.
const status = await helper.call({ cmd: "status" }, 30_000);
check("a request goes out and the answer comes back through LaunchServices",
  status.ok === true && typeof status.authorization === "string", JSON.stringify(status));
console.log(`      (authorization for this build: ${status.authorization})`);
if (status.authorization !== "fullAccess") {
  const events = await helper.call({ cmd: "events", from: "2026-10-14", to: "2026-10-15" }, 30_000);
  check("without the permission, reading says not_authorized instead of returning nothing",
    events.ok === false && events.code === "not_authorized", JSON.stringify(events));
}
// EventKit's real date rules, on events that are never saved (no permission needed).
const self = await helper.call({ cmd: "selftest", cases: [
  { name: "one all-day day", fields: { start: "2026-10-15" } },
  { name: "three all-day days", fields: { start: "2026-10-15", end: "2026-10-17" } },
  { name: "timed, default hour", fields: { start: "2026-10-15 14:00" } },
  { name: "timed moved by a date keeps its time", setup: { start: "2026-10-15 14:00", end: "2026-10-15 15:00" }, fields: { start: "2026-10-20" } },
  { name: "all-day moved keeps its length", setup: { start: "2026-10-15", end: "2026-10-16" }, fields: { start: "2026-10-18" } },
  { name: "all-day to timed", setup: { start: "2026-10-15" }, fields: { allDay: false, start: "2026-10-15 09:00" } },
  { name: "impossible date", fields: { start: "2026-09-31 14:00" } },
  { name: "notes appended", setup: { start: "2026-10-15 14:00", notes: "第一行" }, fields: { addNotes: "带电脑" } },
] }, 30_000);
const r = Object.fromEntries((self.results ?? []).map((x) => [x.name, x]));
check("EventKit: a one-day all-day event ends on that same day (23:59:59, not the next day)",
  r["one all-day day"]?.allDay === true && r["one all-day day"]?.end === "2026-10-15T23:59:59-04:00", JSON.stringify(r["one all-day day"]));
check("EventKit: 10-15 to 10-17 all-day is three days", r["three all-day days"]?.end === "2026-10-17T23:59:59-04:00");
check("EventKit: a timed event without an end lasts an hour", r["timed, default hour"]?.end === "2026-10-15T15:00:00-04:00");
check("EventKit: moving a timed event by a date keeps its clock time (it does not turn all-day)",
  r["timed moved by a date keeps its time"]?.allDay === false && r["timed moved by a date keeps its time"]?.start === "2026-10-20T14:00:00-04:00");
check("EventKit: moving an all-day event keeps its number of days",
  r["all-day moved keeps its length"]?.start === "2026-10-18T00:00:00-04:00" && r["all-day moved keeps its length"]?.end === "2026-10-19T23:59:59-04:00");
check("EventKit: all-day to timed gets an hour", r["all-day to timed"]?.allDay === false && r["all-day to timed"]?.end === "2026-10-15T10:00:00-04:00");
check("EventKit: 2026-09-31 is refused, not rolled over to October", r["impossible date"]?.error === "bad_request");
check("EventKit: add_notes appends on a new line", r["notes appended"]?.notes === "第一行\n带电脑");
const shanghai = await helper.call({ cmd: "selftest", timeZone: "Asia/Shanghai", cases: [{ name: "d", fields: { start: "2026-10-15" } }] }, 30_000);
check("EventKit: all-day dates follow the zone the plugin sends (EventKit's default zone is set to it)",
  shanghai.results?.[0]?.start === "2026-10-15T00:00:00+08:00" && shanghai.results?.[0]?.end === "2026-10-15T23:59:59+08:00",
  JSON.stringify(shanghai.results));

const bad = await helper.call({ cmd: "nonsense" }, 30_000);
check("an unknown command is a clear error", bad.ok === false && bad.code === "bad_request", JSON.stringify(bad));
check("no request or response files are left behind",
  !existsSync(join(root, "calls")) || readdirSync(join(root, "calls")).length === 0);

rmSync(root, { recursive: true, force: true });
console.log(`\n${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
