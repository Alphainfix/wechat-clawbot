#!/usr/bin/env node
/**
 * Exercise the Claude Code peer tools against the real `~/.claude` on this
 * machine — no DSH, no model, no WeChat.
 *
 * These tools read another program's private-ish state, so the failure mode
 * worth guarding is not "it crashed" but "it silently returned nothing": a
 * registry key that got renamed, a transcript shape that changed, a stale pid
 * counted as live. Every check below is about that.
 *
 * `send_to_claude_session` is registered but deliberately NEVER invoked here —
 * it spawns a process and delivers a message into a real live session. Its
 * argument handling is checked through the paths that reject before any spawn.
 *
 *   node test/claude-peer.mjs
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let pass = 0;
let fail = 0;
const lines = [];
const check = (name, ok, detail) => {
  if (ok) { pass += 1; lines.push(`  ✓ ${name}`); }
  else { fail += 1; lines.push(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); }
};

// A stub context that only does what these tools use: collect registrations.
const tools = new Map();
const stubCtx = { tools: { register: (tool) => tools.set(tool.name, tool) } };

const { registerClaudePeerTools } = await import(join(ROOT, "lib/claude-peer.js"));
registerClaudePeerTools(stubCtx);

check("registers exactly the three peer tools",
  [...tools.keys()].sort().join(",") === "list_claude_sessions,read_claude_session,send_to_claude_session",
  `got ${[...tools.keys()].join(", ")}`);

// Every tool must render its own output — without a render the model sees the
// raw stored value, which is how a tool result turns into noise.
for (const [name, tool] of tools) {
  check(`${name} declares an output render`, typeof tool.output?.render === "function");
  check(`${name} has a non-trivial description`, (tool.description ?? "").length > 60);
}

// ------------------------------------------------------------------ listing
const listed = await tools.get("list_claude_sessions").execute({});
check("list returns a count and a summary",
  typeof listed.count === "number" && typeof listed.summary === "string", JSON.stringify(listed).slice(0, 160));

// Ground truth: this very process is a Claude Code session, so its registry row
// exists and the tool must see at least it. A zero here means the registry
// layout moved and the tool would be quietly useless.
const registry = join(homedir(), ".claude", "sessions");
const rows = existsSync(registry) ? readdirSync(registry).filter((f) => f.endsWith(".json")) : [];
check("registry has rows to find", rows.length > 0, `no *.json under ${registry}`);
check("list finds at least one live session", listed.count > 0,
  `count=${listed.count} while ${rows.length} registry rows exist — key names may have changed`);

// Stale rows must be filtered, not counted: a crashed session leaves its json.
const liveByPid = rows.filter((f) => {
  try {
    const { pid } = JSON.parse(readFileSync(join(registry, f), "utf-8"));
    try { process.kill(pid, 0); return true; } catch { return false; }
  } catch { return false; }
}).length;
// Stale rows are still filtered — a crashed session leaves its json behind, and
// counting it would offer a socket target that cannot be reached. What changed
// in 2026-09 is that `count` also covers CLOSED sessions, which are reachable by
// a different mechanism (--resume), so the live figure is read off the header
// line rather than off `count`.
const liveFromHeader = Number((listed.summary.match(/本机有 (\d+) 个开着的/) ?? [])[1] ?? NaN);
check("the live figure counts live pids only, not every registry row",
  liveFromHeader === liveByPid,
  `header says ${liveFromHeader}, live pids are ${liveByPid}, rows on disk ${rows.length}`);
const closedCount = (listed.summary.match(/已关闭/g) ?? []).length;
check("count is live plus closed, and both are accounted for",
  listed.count === liveFromHeader + closedCount,
  `count=${listed.count} header-live=${liveFromHeader} closed rows=${closedCount}`);

// ------------------------------------------------------------------ reading
// Resolve this process's own session name from the registry, so the read test
// targets something guaranteed to exist rather than a hardcoded name.
let selfName;
for (const f of rows) {
  try {
    const row = JSON.parse(readFileSync(join(registry, f), "utf-8"));
    if (row.pid === process.ppid || row.pid === process.pid) { selfName = row.name; break; }
    if (selfName === undefined && row.name !== undefined) selfName = row.name;
  } catch { /* skip */ }
}
check("could name a session to read", selfName !== undefined);

if (selfName !== undefined) {
  const read = await tools.get("read_claude_session").execute({ session: selfName, limit: 3 });
  check("read succeeds for a live session", read.ok === true, read.summary?.slice(0, 200));
  check("read returns actual conversation text", (read.summary ?? "").length > 80,
    `summary was ${(read.summary ?? "").length} chars — transcript shape may have changed`);
  check("read labels turns as 用户 / Claude",
    /\[(用户|Claude) /.test(read.summary ?? ""), (read.summary ?? "").slice(0, 200));
  // limit must actually bound the output, or a 12MB transcript floods the reply.
  const big = await tools.get("read_claude_session").execute({ session: selfName, limit: 1 });
  check("limit bounds the number of turns",
    (big.summary.match(/\[(用户|Claude) /g) ?? []).length <= 1,
    `limit 1 produced ${(big.summary.match(/\[(用户|Claude) /g) ?? []).length} turns`);
}

// ------------------------------------------------ run state / queue / clock
// The original defect: the listing carried no run state and no queue, so the
// bot answered "两边都没有正在运行的任务" about a session that was mid-tool-call.
// An absent field does not read as "unknown" to a model — it reads as "nothing".
// Three states now, not two: a CLOSED session is neither running nor idle-but-
// open, and calling it 空闲 would invite the socket path, which cannot reach it.
check("every listed session states a run state explicitly",
  listed.count === 0
  || listed.summary.split("\n").filter((l) => l.startsWith("- "))
       .every((l) => /^- \[(运行中|空闲|已关闭)\]/.test(l)),
  listed.summary.slice(0, 300));
check("the listing always speaks about the queue, even when empty",
  /队列空|队列 \d+ 条待处理/.test(listed.summary) && /排队中的消息|没有排队中的消息/.test(listed.summary),
  listed.summary.slice(-200));

// A synthetic transcript with known answers, so queue accounting, the clock and
// the idle path are all asserted against arithmetic rather than against whatever
// the machine happens to be doing.
//
// The session id here does NOT appear in the live registry, so resolve() would
// reject it — the transcript is read directly instead, exercising the same
// readTail the tools use.
{
  const sid = "00000000-0000-4000-8000-000000000abc";
  const dir = join(homedir(), ".claude", "projects", "-tmp-clawbot-peer-test");
  const file = join(dir, `${sid}.jsonl`);
  mkdirSync(dir, { recursive: true });

  // 2023-11-14T22:13:20Z — deliberately a UTC evening, so any timezone west of
  // Greenwich renders a visibly different hour.
  const iso = new Date(1700000000000).toISOString();
  const q = (operation, content) =>
    JSON.stringify({ type: "queue-operation", operation, content, sessionId: sid, timestamp: iso });
  writeFileSync(file, [
    q("enqueue", "one"), q("enqueue", "two"), q("enqueue", "three"),
    q("dequeue", null),   // delivers the head, "one"
    q("remove", "three"), // withdraws "three" BY CONTENT — not the head
    JSON.stringify({ type: "ai-title", aiTitle: "synthetic", sessionId: sid }),
    JSON.stringify({
      type: "assistant", sessionId: sid, timestamp: iso,
      message: { content: [{ type: "text", text: "finished talking" }] },
    }),
  ].join("\n") + "\n", "utf-8");

  const { readTranscriptForTest } = await import(join(ROOT, "lib/claude-peer.js"));
  const state = readTranscriptForTest(file, 5);

  // THE bug: `remove` withdraws an item, so counting only enqueue/dequeue
  // reports every withdrawn message as still waiting. The real session measured
  // enqueue=15 dequeue=9 remove=6 — that is 0 pending, not 6.
  check("queue accounting honours remove, not just dequeue",
    state.queued.length === 1 && state.queued[0] === "two",
    `expected exactly ["two"]; got ${JSON.stringify(state.queued)}`);

  // A last turn that is plain assistant text means the model finished and is
  // waiting on the human. Plus this stamp is from 2023, so the freshness gate
  // must hold even if the shape were misread.
  check("an old, text-only last turn reads as idle", state.running === false);

  // The clock. Slicing "…T22:13:20Z" to "22:13" is what showed a 16:33 message
  // as 20:33. Rendered output must match the host's own local formatting.
  const expected = new Date(1700000000000)
    .toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const turn = state.turns[state.turns.length - 1];
  check("turn times render in local time, not the UTC substring",
    turn !== undefined && turn.at === iso,
    "readTranscriptForTest should hand back the raw stamp for the renderer");
  check(`local rendering of a known UTC stamp is "${expected}"`,
    new Date(Date.parse(iso)).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) === expected
    && (new Date().getTimezoneOffset() === 0 || expected !== iso.slice(11, 16)),
    `UTC slice is ${iso.slice(11, 16)}, local is ${expected} — they must differ off UTC`);

  rmSync(dir, { recursive: true, force: true });
}

// ------------------------------------------------------- refusal before spawn
const unknown = await tools.get("read_claude_session").execute({ session: "definitely-not-a-session" });
check("an unknown session is a readable refusal, not a throw",
  unknown.ok === false && /找不到/.test(unknown.summary), JSON.stringify(unknown).slice(0, 200));

// A miss must hand back the whole mapping, not just "not found". The caller is a
// model choosing what to do next: a bare refusal makes it guess again, while the
// roster lets it pick correctly without a second tool call.
check("a miss returns the full roster with ids and titles",
  /当前会话:/.test(unknown.summary)
  && /id=[0-9a-f]{8}/.test(unknown.summary)
  && /\[(运行中|空闲|已关闭)\]/.test(unknown.summary),
  (unknown.summary ?? "").slice(0, 260));

// Titles are matchable BECAUSE names churn — one session went proj-96 →
// proj-35 → proj-ef → claude-44 → claude-90 in a day, while its title kept
// meaning the same conversation. Resolving by title is what makes the tool
// usable from a phone.
if (selfName !== undefined) {
  const viaName = await tools.get("read_claude_session").execute({ session: selfName, limit: 1 });
  const title = (viaName.summary.match(/「([^」]{2,})」/) ?? [])[1];
  if (title !== undefined) {
    const word = title.split(/\s+/)[0].slice(0, 6);
    const viaTitle = await tools.get("read_claude_session").execute({ session: word, limit: 1 });
    check(`a title fragment resolves ("${word}")`, viaTitle.ok === true,
      (viaTitle.summary ?? "").slice(0, 200));
  }
  // The id comes from the LISTING, which is the output that carries `id=`; the
  // read header does not, so scraping it there found nothing and fell through to
  // a literal "x".
  const anyId = (listed.summary.match(/id=([0-9a-f]{8})/) ?? [])[1];
  if (anyId !== undefined) {
    const viaId = await tools.get("read_claude_session").execute({ session: anyId, limit: 1 });
    check("an id prefix resolves", viaId.ok === true, (viaId.summary ?? "").slice(0, 160));
  }
}

const empty = await tools.get("send_to_claude_session").execute({ session: "whatever", text: "   " });
check("send refuses empty text before resolving or spawning",
  empty.ok === false && /空/.test(empty.summary), JSON.stringify(empty).slice(0, 200));

const noTarget = await tools.get("send_to_claude_session").execute({
  session: "definitely-not-a-session", text: "hello",
});
check("send refuses an unknown target without spawning",
  noTarget.ok === false && /找不到/.test(noTarget.summary) && /当前会话:/.test(noTarget.summary),
  JSON.stringify(noTarget).slice(0, 200));

// Structural: the helper must never be handed a shell string, and its tool
// allowlist must stay minimal whatever the relayed text says.
const src = readFileSync(join(ROOT, "lib/claude-peer.js"), "utf-8");
check("the helper is spawned with an argv array, never a shell string",
  /"-p",\s*prompt/.test(src) && !/exec\(`/.test(src) && !/shell:\s*true/.test(src));
check("the helper's tool allowlist is only ListAgents,SendMessage",
  /"ListAgents,SendMessage"/.test(src));
check("the send has a timeout",
  // `src` is the COMPILED js, so the type annotation is gone: match what tsc emits.
  /timeout:\s*timeoutMs/.test(src) && /timeoutMs = SEND_TIMEOUT_MS/.test(src),
  "the ceiling became a parameter so a resume can have a longer one; it must still default to the relay's");

// The binary is DISCOVERED, never taken from PATH. This is the bug that took
// the feature down in production: the harness ran under nvm's newest node
// (v24.19.0, chosen by the menu-bar app) while `claude` was installed under an
// older one (v24.16.0), so PATH did not contain it and every send failed with a
// bare "Command failed" naming no cause.
check("the claude binary is resolved, not looked up on PATH",
  /findClaude\(\)/.test(src) && !/run\(\s*"claude"/.test(src),
  "a bare execFile(\"claude\") depends on PATH agreeing with where the CLI lives");
{
  const { resolveClaudeBinaryForTest } = await import(join(ROOT, "lib/claude-peer.js"));
  const bin = resolveClaudeBinaryForTest();
  check("claude is findable on this machine", typeof bin === "string" && existsSync(bin),
    `got ${String(bin)} — install Claude Code, or the search list needs another location`);
  // Specifically: findable even from an environment whose PATH lacks it, which
  // is the harness's actual situation.
  const savedPath = process.env.PATH;
  process.env.PATH = "/usr/bin:/bin";
  const withoutPath = resolveClaudeBinaryForTest();
  process.env.PATH = savedPath;
  check("claude is still found when PATH does not contain it",
    typeof withoutPath === "string" && existsSync(withoutPath),
    "the nvm / global-location fallbacks are what make the harness work");
}

// An execFile rejection is "Command failed: <entire command>\n<stderr>", and the
// prompt is ~300 chars — slicing the head keeps the echo and drops the reason,
// which is how an ENOENT was logged as a sentence trailing off mid-word.
// Comments are stripped before the negative half, because the comment that
// explains the fix quotes the broken form verbatim — and matched itself.
const code = src.replace(/^\s*\/\/.*$/gm, "");
check("failure detail keeps stderr's tail, not the command echo",
  /stderr\.slice\(-240\)/.test(code) && !/String\(err\)\.slice\(0,\s*240\)/.test(code),
  "the diagnosis is at the END of stderr");

// execFile hands the child an stdin pipe and never closes it, so `claude -p`
// waited 3s for piped input on every single send, warned, and buried the real
// error under the warning.
check("the helper's stdin is closed immediately",
  /child\.stdin\?\.end\(\)/.test(code),
  "without this every send pays a 3s stdin timeout");

// `claude` prints its auth failure to STDOUT and exits 0, so a check that only
// reads stderr — or only runs in the catch — never fires.
check("the auth check reads stdout too, on both paths",
  (code.match(/looksUnauthenticated\(/g) ?? []).length >= 3
  && /looksUnauthenticated\(`\$\{stdout\}/.test(code),
  "auth arrives on stdout with exit 0, i.e. on the success path");

// Found the hard way: a bare /sent/i search scores Claude Code's own failure
// text as success. Its real refusal reads "Session X is not reachable…", and
// "the message was not sent" is an equally plausible variant — either would
// report a delivery that never happened. The match must be anchored.
check("delivery success is detected with an anchored match, not a substring",
  /\/\^sent\\b\/i/.test(src) && !/\/sent\/i\.test/.test(src),
  "an unanchored /sent/ would treat \"was not sent\" as a successful delivery");

// -------------------------------------------------- sessions that are closed
// The bug this fixes: the registry under ~/.claude/sessions is keyed by pid and
// only describes RUNNING processes, so the roster went empty the moment the user
// closed their terminal — "session 没开，读取不到" — which is exactly when
// messaging one from WeChat is most useful. Transcripts live forever, and
// `claude -p --resume <id>` reaches them (verified live 2026-09-04: a session
// created, exited, then resumed recalled a codeword from before it died and
// appended the new turn to the SAME transcript file).
{
  const listing = await tools.get("list_claude_sessions").execute({});

  check("closed sessions are listed, not just running ones",
    /已关闭/.test(listing.summary) || /没有 Claude Code 会话/.test(listing.summary),
    (listing.summary ?? "").slice(0, 200));

  // Each closed row has to carry enough to be chosen from a phone: which
  // conversation it was, where it lived, and how stale it is.
  if (/已关闭/.test(listing.summary)) {
    const row = listing.summary.split("\n").find((l) => l.includes("已关闭")) ?? "";
    check("a closed row carries id, last-activity and cwd",
      /id=[0-9a-f]{8}/.test(row) && /最后活动/.test(row) && /cwd=\//.test(row), row.slice(0, 220));
    check("the closed group says how a message will be delivered",
      /--resume/.test(listing.summary));
  }

  // A dormant session must be resolvable the way a person refers to it: by the
  // project folder. It has no name at all, and its title may not have landed in
  // the metadata window.
  const dormantRow = listing.summary.split("\n").find((l) => l.includes("已关闭"));
  if (dormantRow !== undefined) {
    const cwd = (dormantRow.match(/cwd=(\S+)/) ?? [])[1];
    const folder = cwd === undefined ? undefined : cwd.split("/").filter(Boolean).pop();
    if (folder !== undefined && folder.length >= 4) {
      const viaFolder = await tools.get("read_claude_session").execute({ session: folder, limit: 1 });
      check(`a closed session resolves by its folder ("${folder}")`,
        viaFolder.ok === true || /同时匹配到/.test(viaFolder.summary ?? ""),
        (viaFolder.summary ?? "").slice(0, 200));
    }
  }

  // The old empty-roster message named only running sessions, which read as
  // "you cannot do this" rather than "nothing exists".
  check("the empty-roster message no longer says only-running",
    !/^本机没有正在运行的 Claude Code 会话$/m.test(src),
    "that wording is what told the user a closed session was unreachable");
}

// ------------------------------------------------ not offering our own exhaust
// Every relay spawns a headless `claude -p` to call SendMessage, and that run
// leaves a transcript of its own. 32 had piled up, five of them crowding the
// user's real conversations out of the eight-row list — and being offered to the
// model as sessions it could message.
{
  const peerMod = await import(join(ROOT, "lib/claude-peer.js"));
  const tmp = join(process.env.TMPDIR ?? "/tmp", `peer-helper-${process.pid}`);
  mkdirSync(tmp, { recursive: true });
  // Padded so the signature is FAR from the end: a real helper transcript's last
  // 64KB is its attachment records, which is why the first attempt at this —
  // matching the tail-derived title — silently caught nothing.
  const pad = JSON.stringify({ type: "attachment", pad: "x".repeat(80 * 1024) });
  const helper = join(tmp, "helper.jsonl");
  writeFileSync(helper, [
    JSON.stringify({ type: "user", message: { content: [{ type: "text",
      text: 'Use SendMessage to deliver the following message verbatim to the session named "x".' }] } }),
    pad,
  ].join("\n") + "\n");
  const real = join(tmp, "real.jsonl");
  writeFileSync(real, [
    JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "帮我看看这个 notebook" }] } }),
    pad,
  ].join("\n") + "\n");

  check("a relay-helper transcript is recognised as ours",
    peerMod.isRelayHelperTranscriptForTest(helper) === true,
    "every relay leaves one; 32 had piled up and five were crowding the user's own sessions out");
  check("a real conversation is not mistaken for ours",
    peerMod.isRelayHelperTranscriptForTest(real) === false);
  rmSync(tmp, { recursive: true, force: true });

  const listing = await tools.get("list_claude_sessions").execute({});
  check("the roster shows no relay-helper session right now",
    !/Use SendMessage to deliver/.test(listing.summary));
}

// ------------------------------------------- reviving instead of impersonating
// The closed case used to run the turn ITSELF (`claude -p --resume`), which made
// it a second mechanism with its own failure modes — and on 2026-09-09 that bill
// came due: the turn executes inside the CLI process, so a stale binary got
// "400 … does not support this model" where the relay path was unaffected.
// Now it revives the session as a real background session (which registers as a
// peer: peerProtocol 1, a messagingSocketPath, kind: bg — verified live) and
// delivers through the ordinary relay.
{
  const peer = await import(join(ROOT, "lib/claude-peer.js"));

  check("a closed session is revived with --bg, under the same id",
    /"--bg", "--resume", target\.sessionId, "--permission-mode", mode/.test(src),
    "--bg --resume continues the session under the same ID and registers it as a peer");
  check("delivery then goes through the SAME relay as an open session",
    /return await relayToLive\(\s*agentCtx, bin, live, body,/.test(src),
    "one mechanism, or the closed case drifts again");
  // A background session is EXCLUSIVE: while it runs, that conversation cannot
  // be opened in the desktop app — Claude Code refuses, the app's child exits 1,
  // and the app reports "Claude Code crashed". That happened to the user minutes
  // after this path first shipped. The trade is inherent to --bg; the surprise
  // is not, so the reply must always carry the way out.
  check("a revive reply says how to hand the session back",
    /claude attach \$\{shortId\}/.test(src) && /claude stop \$\{shortId\}/.test(src),
    "without these the user hits 'Claude Code crashed' with no idea why");
  check("the tool description warns the model to pass those on",
    /cannot be opened in the desktop app/.test(src) && /pass them on to the/.test(src));
  check("the revive waits for the peer to register before relaying",
    /REVIVE_REGISTER_TIMEOUT_MS/.test(src) && /listSessions\(\)\.find/.test(src),
    "registration lags the command returning; relaying early fails as 'not reachable'");
  check("the old headless path survives, but only as a fallback",
    /fallback: run the turn headlessly/.test(src)
    && /"-p", body, "--resume", target\.sessionId, "--permission-mode", mode/.test(src),
    "an older CLI without --bg still has to work");

  // The mode decision, on real inputs rather than by grep.
  const modeOf = (configured, recorded) => peer.resolveReviveModeForTest(configured, recorded);
  check("an explicit setting is used as given",
    modeOf("bypassPermissions", undefined).mode === "bypassPermissions");
  check("no recorded mode falls back, and says so",
    modeOf("inherit", undefined).mode === "acceptEdits"
    && /没记录过/.test(modeOf("inherit", undefined).why),
    JSON.stringify(modeOf("inherit", undefined)));
  check("a workable recorded mode is honoured",
    modeOf("inherit", "auto").mode === "auto" && /沿用/.test(modeOf("inherit", "auto").why),
    JSON.stringify(modeOf("inherit", "auto")));
  // The whole point of the design: "manual" is what the user said they did NOT
  // want, and a background session has nobody to answer its prompts.
  check("a mode that needs a human is not inherited into the background",
    modeOf("inherit", "manual").mode === "acceptEdits"
    && /要人盯着批/.test(modeOf("inherit", "manual").why),
    JSON.stringify(modeOf("inherit", "manual")));

  // A synthetic transcript, because the two facts a revive needs are exactly the
  // ones a real file may hide: `permissionMode` is only written on a change, and
  // `cwd` can fall outside a fixed tail window when one attachment record is
  // tens of KB. On a real 155KB transcript the last 64KB held two records,
  // neither with a cwd — the session came back with no directory at all.
  const tmp = join(process.env.TMPDIR ?? "/tmp", `peer-facts-${process.pid}`);
  mkdirSync(tmp, { recursive: true });
  const filler = "x".repeat(70 * 1024);
  const f = join(tmp, "big.jsonl");
  writeFileSync(f, [
    JSON.stringify({ type: "mode", permissionMode: "default" }),
    JSON.stringify({ type: "user", cwd: "/tmp/the/real/place", permissionMode: "auto" }),
    JSON.stringify({ type: "attachment", pad: filler }),   // pushes both out of a 64KB tail
    JSON.stringify({ type: "last-prompt" }),
  ].join("\n") + "\n");
  const facts = peer.reviveFactsForTest(f);
  check("the backwards scan grows past 64KB to find the mode",
    facts.mode === "auto", JSON.stringify(facts));
  check("...and finds the cwd a fixed tail window would have missed",
    facts.cwd === "/tmp/the/real/place", JSON.stringify(facts));
  rmSync(tmp, { recursive: true, force: true });
}

// The two delivery mechanisms must stay distinct: a live session is reached over
// its socket, a closed one by replaying its transcript.
check("a closed session is delivered to by --resume, in its own cwd",
  /"--resume", target\.sessionId/.test(src) && /target\.cwd/.test(src),
  "resume has to run in the session's directory or it gets another project's context");
// This started as a read-only tool allowlist and that was the wrong dial: in a
// workspace the user trusts, the session should use their normal approval mode.
// But "pass no mode" is NOT that — measured 2026-09-04, a headless run with no
// mode replies "Please approve the permission prompt to proceed" and writes
// nothing, because there is nobody to prompt. So a mode must be named, and it
// comes from settings rather than from a constant in here.
check("the resume path names an approval mode from settings",
  /"--permission-mode", mode/.test(src)
  && !/"--allowed-tools", "Read,Grep,Glob"/.test(src),
  "a resume with no mode stalls on a prompt nobody can answer");
check("the mode is read per send, not captured at registration",
  /config\.claudeResumePermissionMode/.test(src),
  "the settings page writes into the live config object; a copy would pin the mode");
{
  const cfg = readFileSync(join(ROOT, "lib/config.js"), "utf-8");
  check("the mode list is exactly the CLI's own --permission-mode choices",
    /"acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"/.test(cfg),
    "a value the CLI does not accept would fail at the spawn instead of in settings");
  check("the default follows the session's own permissions",
    /claudeResumePermissionMode: "inherit"/.test(cfg),
    "asked for explicitly: a revived session should behave like its own workspace");
  check("inherit is offered alongside the real modes",
    /CLAUDE_RESUME_MODES = \["inherit", \.\.\.CLAUDE_PERMISSION_MODES\]/.test(cfg));
  check("the mode is hot, so changing it applies to the next message",
    /"claudeResumePermissionMode",/.test(cfg));
}
check("the relay path still uses SendMessage for a live session",
  /"ListAgents,SendMessage"/.test(src));
// 2026-09-09: two resumes failed and the only thing that reached WeChat was
// "exit=1". The reason was on STDOUT — "API Error: 400 Claude Code 2.1.246 does
// not support this model; version 2.1.251 or newer is required" — and this
// block read stderr only, even though the auth check three lines above it
// already knew `claude` reports on stdout. A bare exit code is a dead end.
check("a resume failure reports stdout, not just stderr and the exit code",
  /outText === "" \? "" : `输出: \$\{outText\.slice\(-320\)\}`/.test(src),
  "claude puts the real reason on stdout; stderr came back empty");
check("a stale CLI is named as such, with the fix",
  /does not support this model\|version \[\\d\.\]\+ or newer is required/.test(src)
  && /claude update/.test(src),
  "a 400 in a WeChat reply is not something to interpret from a phone");

check("a resume gets a longer ceiling than a relay",
  /RESUME_TIMEOUT_MS = 300_000/.test(src) && /RESUME_TIMEOUT_MS\)/.test(src),
  "replaying a long transcript takes minutes; the relay's 120s would call that a failure");
// The dormant scan must not read whole transcripts: this machine has 61 of
// them totalling 206MB, one 62MB, and the roster is rebuilt on every resolve.
check("the dormant scan reads only a tail, not whole transcripts",
  /META_TAIL_BYTES = 64 \* 1024/.test(src) && /fs\.readSync\(/.test(src),
  "readTail reads the file whole — fine for 2 live sessions, hopeless for 206MB");
check("the dormant list is capped and newest-first",
  /DORMANT_LIMIT = 8/.test(src) && /found\.sort\(\(a, b\) => b\.mtime - a\.mtime\)/.test(src));
// A closed session reported as running would be sent to over the socket, which
// cannot reach it.
check("a dormant candidate is never reported as running",
  /running: false,\n      \};/.test(src) || /      running: false,/.test(src));

console.log(lines.join("\n"));
console.log(`\n${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
