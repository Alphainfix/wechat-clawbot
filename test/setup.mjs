#!/usr/bin/env node
/**
 * Getting set up: voice through DSH's own speech recognition (src/voice.ts),
 * the bot switching it on at the owner's word (src/voice-setup.ts), and the
 * first-time checklist (src/onboarding.ts).
 *
 * No WeChat, no model, no network, nothing downloaded. DSH's speech service
 * and plugin manager are stand-ins that record what they were asked; where
 * the host's real speech service can be loaded from the DSH this machine
 * runs, the same calls are made against it as well, with a recognizer of this
 * file's own registered in it. The owner's WeChat is a list.
 *
 *   npm run build && node test/setup.mjs
 *
 * Exits non-zero when any check fails.
 */
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
process.env.TZ = "America/New_York";
const STATE = mkdtempSync(join(tmpdir(), "clawbot-setup-test-"));
process.env.CLAWBOT_STATE_DIR = STATE;
process.on("exit", () => rmSync(STATE, { recursive: true, force: true }));

let pass = 0;
let fail = 0;
const results = [];
function check(name, ok, detail) {
  if (ok) { pass += 1; results.push(`  ✓ ${name}`); }
  else { fail += 1; results.push(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); }
}
const note = (text) => results.push(`  · ${text}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const lib = (p) => join(ROOT, "lib", p);

const { setLogLevel } = await import(lib("ilink/util/logger.js"));
setLogLevel?.("error");
const { transcribeVoiceItem, hostSpeechStatus, voiceNotice, pcmToWav, isCanonicalWav, stereoToMono, playableAudio, VOICE_SETUP_PHRASE }
  = await import(lib("voice.js"));
const { enableVoiceInput, voiceStatus, describeVoice, consentQuestion, hostSpeech, isPlainYes, resetVoiceSetupForTests, VOICE_BUNDLE, VOICE_BY_HAND, VOICE_TOOL }
  = await import(lib("voice-setup.js"));
const { Onboarding, SETUP_TOOL } = await import(lib("onboarding.js"));
const { InboundRouter, unreadableNotice } = await import(lib("inbound.js"));
const { PendingRegistry } = await import(lib("pending.js"));
const OpusScript = createRequire(lib("voice.js"))("opusscript");
const silk = await import(pathToFileURL(createRequire(lib("voice.js")).resolve("silk-wasm")).href);
const silkEncode = silk.encode ?? silk.default.encode;

const OWNER = "owner@im.wechat";
const FRIEND = "friend@im.wechat";

// ------------------------------------------------------------------ stand-ins
/** DSH's speech service as the plugin sees it: one selected recognizer with a preparation phase. */
function fakeSpeech(phase = "ready", over = {}) {
  const speech = {
    phase,
    message: undefined,
    heard: [],
    prepared: [],
    reply: "今天下午 三点 开会 。",
    snapshot() {
      return {
        providers: [{
          id: "sensevoice-local", name: "SenseVoice", location: "host-local",
          preparation: { phase: speech.phase, ...(speech.message ? { message: speech.message } : {}), ...(over.bytes ?? {}) },
        }],
        selection: { providerId: "sensevoice-local", language: "auto" },
      };
    },
    resolve(request) { return { pinned: "sensevoice-local", audio: request.audio }; },
    async transcribe(spec, signal) {
      if (signal.aborted) throw new Error("aborted");
      speech.heard.push(Buffer.from(spec.audio));
      if (over.fail) throw new Error(over.fail);
      return { text: speech.reply, audioSeconds: 1, inferenceSeconds: 0.1 };
    },
    prepare(id) { speech.prepared.push(id); if (over.onPrepare) over.onPrepare(speech); else speech.phase = "downloading"; },
  };
  return speech;
}
function tone(sampleRate, channels, seconds) {
  const pcm = Buffer.alloc(Math.round(sampleRate * seconds) * channels * 2);
  for (let i = 0; i < sampleRate * seconds; i += 1) {
    const value = Math.round(Math.sin(i * 440 * 2 * Math.PI / sampleRate) * 8000);
    for (let c = 0; c < channels; c += 1) pcm.writeInt16LE(value, (i * channels + c) * 2);
  }
  return pcm;
}
function opusRaw(rateIndex, channels, pcm, sampleRate) {
  const encoder = new OpusScript(sampleRate, channels, OpusScript.Application.VOIP);
  const frame = sampleRate / 50;
  const step = frame * channels * 2;
  const parts = [Buffer.from("#!OPUS_RAW_V1", "latin1"), Buffer.from([rateIndex, channels, 0])];
  try {
    for (let at = 0; at + step <= pcm.length; at += step) {
      const packet = encoder.encode(pcm.subarray(at, at + step), frame);
      const length = Buffer.alloc(2);
      length.writeUInt16LE(packet.length);
      parts.push(length, packet);
    }
  } finally { encoder.delete(); }
  return Buffer.concat(parts);
}
const OPUS_16K = opusRaw(2, 1, tone(16000, 1, 1), 16000);
const OPUS_48K_STEREO = opusRaw(4, 2, tone(48000, 2, 0.5), 48000);
const SILK_24K = Buffer.from((await silkEncode(pcmToWav(tone(24000, 1, 1), 24000), 0)).data);
const item = () => ({ type: 3, voice_item: { playtime: 1000, media: { full_url: "http://127.0.0.1:9/voice", aes_key: "AAAA" } } });
const neverHelper = { transcribe: async () => { throw new Error("the Mac's helper must not be reached"); } };

// ------------------------------------------------- 1. which recognizer is used
{
  check("no speech service → absent", hostSpeechStatus(undefined).state === "absent");
  const phases = { ready: "ready", standby: "ready", waking: "ready", downloading: "preparing", checking: "preparing", loading: "preparing",
    unprepared: "unprepared", cancelled: "unprepared", failed: "failed" };
  check("the recognizer's phases read as ready / preparing / unprepared / failed",
    Object.entries(phases).every(([phase, state]) => hostSpeechStatus(fakeSpeech(phase)).state === state),
    Object.keys(phases).map((p) => `${p}:${hostSpeechStatus(fakeSpeech(p)).state}`).join(" "));
  check("a service that throws, or names a recognizer it does not have, reads as absent, not as a crash",
    hostSpeechStatus({ snapshot() { throw new Error("gone"); } }).state === "absent"
    && hostSpeechStatus({ snapshot: () => ({ providers: [], selection: { providerId: "x" } }) }).state === "absent");

  const speech = fakeSpeech("ready");
  const base = { cdnBaseUrl: "x", language: "zh-CN", helper: neverHelper, hostSpeech: () => speech };
  const viaHost = await transcribeVoiceItem(item(), { ...base, platformSupported: () => false, download: async () => OPUS_16K });
  check("DSH's speech recognition ready → it transcribes, on a machine that is not a Mac too",
    viaHost.ok === true && viaHost.engine === "sensevoice-local" && speech.heard.length === 1, JSON.stringify(viaHost));
  check("…the transcript is tidied like any other", viaHost.ok === true && viaHost.text === "今天下午三点开会。", viaHost.text);
  check("…and what it was given is the WAV it takes: 16 kHz, mono, 16-bit, about the second that was said",
    isCanonicalWav(speech.heard[0]) && Math.abs(speech.heard[0].length - 44 - 32000) < 3200, String(speech.heard[0]?.length));

  await transcribeVoiceItem(item(), { ...base, platformSupported: () => false, download: async () => SILK_24K });
  check("the older SILK voice reaches it in the same form", isCanonicalWav(speech.heard[1]) && Math.abs(speech.heard[1].length - 44 - 32000) < 3200,
    String(speech.heard[1]?.length));
  await transcribeVoiceItem(item(), { ...base, platformSupported: () => false, download: async () => OPUS_48K_STEREO });
  check("stereo voice recorded at 48 kHz is brought down to one channel at 16 kHz",
    isCanonicalWav(speech.heard[2]) && Math.abs(speech.heard[2].length - 44 - 16000) < 1600, String(speech.heard[2]?.length));
  check("two channels average into one", stereoToMono(Buffer.from([0x10, 0x00, 0x30, 0x00, 0xf0, 0xff, 0x10, 0x00])).equals(Buffer.from([0x20, 0x00, 0x00, 0x00])));

  const onMac = await transcribeVoiceItem(item(), { ...base, platformSupported: () => true, download: async () => OPUS_16K });
  check("on a Mac with both, DSH's recognizer comes first (the Mac's helper is not started)", onMac.ok === true && onMac.engine === "sensevoice-local");

  const quiet = fakeSpeech("ready");
  quiet.reply = "  ";
  const empty = await transcribeVoiceItem(item(), { ...base, hostSpeech: () => quiet, platformSupported: () => true, download: async () => OPUS_16K });
  check("it hears nothing → empty, and the Mac's helper is not asked for a second opinion", empty.ok === false && empty.reason === "empty");

  const broken = fakeSpeech("ready", { fail: "worker exited" });
  const macCalls = [];
  const macHelper = { transcribe: async (file, language) => { macCalls.push([existsSync(file), language]); return { ok: true, text: "这台电脑听到的", engine: "speech" }; } };
  const fellBack = await transcribeVoiceItem(item(), { ...base, helper: macHelper, hostSpeech: () => broken, platformSupported: () => true, download: async () => OPUS_16K });
  check("DSH's recognizer fails → on a Mac its own models take over",
    fellBack.ok === true && fellBack.engine === "speech" && macCalls.length === 1 && macCalls[0][0] === true, JSON.stringify(fellBack));
  const noFallback = await transcribeVoiceItem(item(), { ...base, hostSpeech: () => broken, platformSupported: () => false, download: async () => OPUS_16K });
  check("…elsewhere the failure is reported as one", noFallback.ok === false && noFallback.reason === "failed" && /worker exited/.test(noFallback.detail ?? ""));

  let downloads = 0;
  const count = async () => { downloads += 1; return OPUS_16K; };
  const none = await transcribeVoiceItem(item(), { ...base, hostSpeech: () => undefined, platformSupported: () => false, download: count });
  check("nothing to transcribe with → no-engine, and the audio is not even fetched", none.ok === false && none.reason === "no-engine" && downloads === 0);
  const unprepared = await transcribeVoiceItem(item(), { ...base, hostSpeech: () => fakeSpeech("unprepared"), platformSupported: () => false, download: count });
  check("DSH's recognizer switched on without its model → host-unprepared",
    unprepared.ok === false && unprepared.reason === "host-unprepared" && unprepared.host === "unprepared" && downloads === 0);
  const coming = await transcribeVoiceItem(item(), { ...base, hostSpeech: () => fakeSpeech("downloading"), platformSupported: () => false, download: count });
  check("…its model on the way → host-unprepared, marked as preparing", coming.ok === false && coming.host === "preparing");
  const macOnly = await transcribeVoiceItem(item(), { ...base, helper: macHelper, hostSpeech: () => fakeSpeech("unprepared"), platformSupported: () => true, download: async () => OPUS_16K });
  check("…while a Mac goes on using its own models", macOnly.ok === true && macOnly.engine === "speech");
  const thrower = await transcribeVoiceItem(item(), { ...base, helper: macHelper, hostSpeech: () => { throw new Error("no such service"); }, platformSupported: () => true, download: async () => OPUS_16K });
  check("a lookup of the service that throws counts as no service", thrower.ok === true && thrower.engine === "speech");

  // What the sender is told.
  const told = voiceNotice({ ok: false, reason: "no-engine", host: "absent" });
  check("nothing can transcribe → the reply says what to switch on, where, and that the bot can do it",
    told.includes("语音输入") && told.includes("插件") && told.includes(`回我「${VOICE_SETUP_PHRASE}」`) && told.includes("语音") && !told.includes("视频"), told);
  check("…the same advice when the Mac's own models cannot be used",
    ["tools", "build", "language"].every((reason) => voiceNotice({ ok: false, reason }).includes(`回我「${VOICE_SETUP_PHRASE}」`)));
  check("switched on without its model → the reply says the model is what is missing",
    /模型还没下载/.test(voiceNotice({ ok: false, reason: "host-unprepared", host: "unprepared" })) && /下载并准备/.test(voiceNotice({ ok: false, reason: "host-unprepared", host: "unprepared" })));
  check("the model on its way → the reply says to wait", /还在下载/.test(voiceNotice({ ok: false, reason: "host-unprepared", host: "preparing" })));
  check("an unknown audio format is said to be one", /格式/.test(voiceNotice({ ok: false, reason: "decode" })));

  // Through the router: the notice reaches the sender, the service is looked up per message.
  let speechNow;
  const notices = [];
  const enqueued = [];
  const router = new InboundRouter({
    config: { allowFrom: [], voiceLanguage: "zh-CN" },
    account: { accountId: "acc", userId: OWNER, cdnBaseUrl: "http://127.0.0.1:9" },
    bridge: { enqueueMessage: async (...args) => { enqueued.push(args); }, noteIncoming: () => {} },
    pending: new PendingRegistry(),
    sendText: async (_to, text) => { notices.push(text); },
    hostSpeech: () => speechNow,
  });
  const bare = () => ({ from_user_id: OWNER, item_list: [{ type: 3, voice_item: { playtime: 2000 } }] });
  if (process.platform !== "darwin") {
    await router.handle(bare());
    check("the router, with no recognizer anywhere: the sender is pointed at 语音输入", notices.length === 1 && notices[0].includes("语音输入"), notices.join(" | "));
  }
  speechNow = fakeSpeech("ready");
  check("the router reads DSH's speech service anew for each message (it can be switched on while DSH runs)",
    hostSpeechStatus(speechNow).state === "ready" && unreadableNotice(bare(), { ok: false, reason: "no-media" }).includes("没能下载"));
}

// --------------------------------------------- 2. the bot switches it on, asked
{
  const make = (over = {}) => {
    resetVoiceSetupForTests();
    const asked = [];
    const told = [];
    const calls = [];
    const world = { speech: over.speech };
    const manager = over.manager === null ? undefined : {
      async setBundleEnabled(name, enabled) {
        calls.push([name, enabled]);
        if (over.managerThrows) throw new Error(over.managerThrows);
        const application = over.application ?? "applied";
        if (application === "applied") world.speech = over.appears === false ? undefined : (over.then ?? fakeSpeech("unprepared"));
        return { changed: true, application, stage: "enable", target: name };
      },
    };
    const deps = {
      ctx: { get: (name) => (name === "speechToText" ? world.speech : name === "pluginManager" ? manager : undefined) },
      config: { voiceTranscribe: true, voiceLanguage: "zh-CN", allowFrom: [] },
      getAccount: () => (over.noOwner ? { userId: "" } : { userId: OWNER }),
      activeSender: () => over.sender ?? OWNER,
      askOwner: async (question) => { asked.push(question); return over.answer ?? { status: "answered", reply: "好" }; },
      tellOwner: async (text) => { told.push(text); },
      pollMs: 5, appearMs: 80, watchMs: over.watchMs ?? 2000,
      macReady: async () => over.mac ?? "unsupported",
    };
    return { deps, asked, told, calls, world };
  };

  {
    const h = make();
    const result = await enableVoiceInput(h.deps);
    check("off → the owner is asked first, in the plugin's own fixed words", h.asked.length === 1 && h.asked[0] === consentQuestion({ state: "absent" }));
    const q = h.asked[0];
    check("…the question says what will change: a DSH plugin, the download and its size, where the audio stays, the microphone button, how to undo it, and that only 好 goes ahead",
      /DSH/.test(q) && /实验性/.test(q) && /240 MB/.test(q) && /不上传/.test(q) && /麦克风/.test(q) && /关掉/.test(q) && /回「好」/.test(q) && /不动/.test(q), q);
    check("a yes → DSH's voice-input bundle is switched on through its plugin manager",
      h.calls.length === 1 && h.calls[0][0] === VOICE_BUNDLE && h.calls[0][1] === true && VOICE_BUNDLE === "@deepseek-ai/dsh-experimental-voice-input-bundle");
    check("…the model's download is started", h.world.speech.prepared.join() === "sensevoice-local");
    check("…and the bot is told to say it is downloading, not that voice works yet",
      result.ok === true && /正在下载/.test(result.summary) && /还听不了/.test(result.summary) && /不要说已经能听/.test(result.summary), result.summary);
    check("nothing is told to the owner while it downloads", h.told.length === 0);
    h.world.speech.phase = "ready";
    await sleep(60);
    check("when the model is ready the owner gets one message saying so", h.told.length === 1 && /准备好了/.test(h.told[0]), h.told.join(" | "));
    await sleep(40);
    check("…once", h.told.length === 1);
  }
  for (const [reply, label] of [["不用了", "a no"], ["嗯", "a bare 嗯"], ["等会儿再说", "anything else"]]) {
    const h = make({ answer: { status: "answered", reply } });
    const result = await enableVoiceInput(h.deps);
    check(`${label} → nothing is changed`, result.ok === false && h.calls.length === 0 && /什么都没改/.test(result.summary), result.summary);
  }
  check("a plain yes in the usual words counts (好 / 好的。/ 可以 / 打开吧 / OK)",
    ["好", "好的。", "可以", "打开吧", " OK "].every((reply) => isPlainYes(reply)));
  check("…and nothing short of one does (嗯 / 是 / 对 / 好像不用 / silence)",
    ["嗯", "是", "对", "好像不用", "打开什么", "", null].every((reply) => !isPlainYes(reply)));
  for (const status of ["undelivered", "timeout", "stopped"]) {
    const h = make({ answer: { status, detail: "x" } });
    const result = await enableVoiceInput(h.deps);
    check(`the question ${status} → nothing is changed`, result.ok === false && h.calls.length === 0);
  }
  {
    const h = make({ sender: FRIEND });
    const result = await enableVoiceInput(h.deps);
    check("someone else on the allow list cannot have the owner's DSH changed: not even asked", result.ok === false && h.asked.length === 0 && h.calls.length === 0, result.summary);
    const g = make({ sender: null });
    g.deps.activeSender = () => undefined;
    await enableVoiceInput(g.deps);
    check("the owner at the computer (no WeChat sender) can", g.asked.length === 1);
    const n = make({ noOwner: true });
    check("no known owner → refused", (await enableVoiceInput(n.deps)).ok === false && n.asked.length === 0);
  }
  {
    const h = make({ manager: null });
    const result = await enableVoiceInput(h.deps);
    check("a DSH without the plugin manager → the by-hand steps, and no question about something that cannot be done",
      result.ok === false && h.asked.length === 0 && result.summary.includes(VOICE_BY_HAND), result.summary);
  }
  {
    const h = make({ application: "restart-required" });
    const result = await enableVoiceInput(h.deps);
    check("a DSH that applies changes at restart → the owner is told to restart, nothing is watched", result.ok === true && /重启/.test(result.summary) && h.told.length === 0);
    const f = make({ application: "failed" });
    const failed = await enableVoiceInput(f.deps);
    check("the switch refused → the by-hand steps", failed.ok === false && failed.summary.includes(VOICE_BY_HAND), failed.summary);
    const t = make({ managerThrows: "profile locked" });
    const thrown = await enableVoiceInput(t.deps);
    check("the switch throwing → the reason and the by-hand steps", thrown.ok === false && /profile locked/.test(thrown.summary) && thrown.summary.includes(VOICE_BY_HAND));
    const a = make({ appears: false });
    const absent = await enableVoiceInput(a.deps);
    check("switched on but the service does not come up → said so, with what to do", absent.ok === true && /还没起来/.test(absent.summary), absent.summary);
  }
  {
    const h = make({ speech: fakeSpeech("ready") });
    const result = await enableVoiceInput(h.deps);
    check("already working → nothing is asked or changed", result.ok === true && h.asked.length === 0 && h.calls.length === 0 && /已经可以用/.test(result.summary));
    const d = make({ speech: fakeSpeech("downloading", { bytes: { completedBytes: 50 * 1024 * 1024, totalBytes: 239 * 1024 * 1024 } }) });
    const downloading = await enableVoiceInput(d.deps);
    check("already downloading → nothing is asked; the progress is given", downloading.ok === true && d.asked.length === 0 && /50 MB \/ 239 MB/.test(downloading.summary), downloading.summary);
    d.world.speech.phase = "failed";
    d.world.speech.message = "network";
    await sleep(60);
    check("a download that fails → the owner is told, with how to try again", d.told.length === 1 && /没准备成/.test(d.told[0]) && d.told[0].includes(VOICE_SETUP_PHRASE), d.told.join(" | "));
  }
  {
    const speech = fakeSpeech("unprepared");
    const h = make({ speech });
    const result = await enableVoiceInput(h.deps);
    check("switched on already, model missing → asked about the download alone, then it is started",
      h.asked.length === 1 && h.asked[0] === consentQuestion(hostSpeechStatus(fakeSpeech("unprepared"))) && /240 MB/.test(h.asked[0]) && !/麦克风/.test(h.asked[0])
      && h.calls.length === 0 && speech.prepared.length === 1 && result.ok === true);
    const cached = make({ then: fakeSpeech("ready") });
    const instant = await enableVoiceInput(cached.deps);
    check("switched on with the model already on disk → working at once", instant.ok === true && /现在就能用/.test(instant.summary) && cached.told.length === 0);
    const off = make();
    await enableVoiceInput(off.deps);
    off.world.speech = undefined;
    await sleep(60);
    check("the plugin switched off again while the model downloads → the watch ends quietly", off.told.length === 0);
    const slow = make({ watchMs: 30 });
    await enableVoiceInput(slow.deps);
    await sleep(120);
    check("a download that never ends → one message saying so", slow.told.length === 1 && /很久/.test(slow.told[0]), slow.told.join(" | "));
  }
  {
    const status = await voiceStatus({ ctx: { get: () => undefined }, config: { voiceTranscribe: true, voiceLanguage: "zh-CN" }, macReady: async () => "ready" });
    check("status: a Mac with nothing switched on uses its own models", status.engine === "mac" && /这台 Mac 自带/.test(describeVoice(status)));
    const dsh = await voiceStatus({ ctx: { get: (n) => (n === "speechToText" ? fakeSpeech("standby") : undefined) }, config: { voiceTranscribe: true, voiceLanguage: "zh-CN" }, macReady: async () => "ready" });
    check("status: DSH's recognizer ready → that is what is used", dsh.engine === "dsh" && /语音输入/.test(describeVoice(dsh)) && /在这台电脑上运行/.test(describeVoice(dsh)));
    const none = await voiceStatus({ ctx: { get: () => undefined }, config: { voiceTranscribe: true, voiceLanguage: "zh-CN" }, macReady: async () => "unsupported" });
    check("status: neither → cannot hear voice, and why", none.engine === null && /还听不了/.test(describeVoice(none)) && /没开/.test(describeVoice(none)));
    const off = await voiceStatus({ ctx: { get: (n) => (n === "speechToText" ? fakeSpeech("ready") : undefined) }, config: { voiceTranscribe: false, voiceLanguage: "zh-CN" }, macReady: async () => "ready" });
    check("status: the plugin's own switch off → nothing is used", off.engine === null && /开关关着/.test(describeVoice(off)));
    check("the service is read through ctx.get, and a ctx that throws is no service", hostSpeech({ get: () => { throw new Error("x"); } }) === undefined);
  }
}

// --------------------------------------------------- 3. the first-time checklist
{
  let n = 0;
  const make = (over = {}) => {
    const told = [];
    const file = join(STATE, `onboarding-${n += 1}.json`);
    const config = { provider: over.provider, model: over.model };
    const onboarding = new Onboarding({
      voice: {
        ctx: { get: (name) => (name === "speechToText" ? over.speech : undefined) },
        config: { voiceTranscribe: true, voiceLanguage: "zh-CN" },
        macReady: async () => over.mac ?? "unsupported",
      },
      config,
      getAccount: () => ({ userId: OWNER }),
      activeSender: () => OWNER,
      tellOwner: async (text) => { if (over.sendFails?.()) throw new Error("not now"); told.push(text); },
      file,
      platform: over.platform ?? "darwin",
      permissions: async () => ({ fullDisk: over.fullDisk ?? "denied", launcher: { kind: "app", name: "Terminal", localName: "终端" } }),
      usedBefore: () => over.usedBefore === true,
    });
    return { onboarding, told, file, config };
  };

  {
    const h = make();
    const state = h.onboarding.state();
    check("a new pairing starts with nothing done and is not marked as an existing user", state.v === 1 && state.legacy === undefined && Object.keys(state.items).length === 0);
    check("the state is kept in a private file", (statSync(h.file).mode & 0o777) === 0o600);
    const lines = await h.onboarding.lines();
    check("on a Mac with nothing set up: voice, file access, a fixed model, names — in that order, all to do",
      lines.map((l) => l.key).join() === "voice,files,model,names" && lines.every((l) => l.state === "todo"), JSON.stringify(lines.map((l) => [l.key, l.state])));
    const intro = Onboarding.intro(lines);
    check("the list names each item with why it matters, and how to start or put it off",
      /^第一次用，有 4 件事/.test(intro) && /1\. 语音：让我能听懂你发的语音/.test(intro) && /2\. 文件权限/.test(intro) && /3\. 固定模型/.test(intro)
      && /4\. 称呼/.test(intro) && /回「开始」/.test(intro) && /「以后再说」/.test(intro) && /跳过/.test(intro), intro);
    check("the voice item tells the bot to use the tool that asks the owner itself", lines[0].how.includes(VOICE_TOOL) && lines[0].how.includes(VOICE_BY_HAND));
    check("the file-access item names the program to switch on, in the system's own words", lines[1].how.includes("「终端」") && lines[1].how.includes("完全磁盘访问权限"));
  }
  {
    const h = make({ platform: "win32" });
    const lines = await h.onboarding.lines();
    check("on Windows there is no file-access item", lines.map((l) => l.key).join() === "voice,model,names");
    const done = make({ mac: "ready", fullDisk: "granted", provider: "p", model: "m" });
    const doneLines = await done.onboarding.lines();
    check("what already works is marked done from the machine's real state: voice on a Mac, full disk access, a fixed model",
      doneLines.filter((l) => l.state === "done").map((l) => l.key).join() === "voice,files,model", JSON.stringify(doneLines.map((l) => [l.key, l.state])));
    check("one item left → a one-line list", /^第一次用，有一件事建议设置一下：称呼/.test(Onboarding.intro(doneLines)), Onboarding.intro(doneLines));
    check("nothing left → no list", Onboarding.intro(doneLines.map((l) => ({ ...l, state: "done" }))) === null);
    const viaDsh = make({ speech: fakeSpeech("ready"), platform: "win32" });
    check("voice counts as done on Windows once DSH's recognizer is ready", (await viaDsh.onboarding.lines())[0].state === "done");
  }
  {
    const h = make();
    await h.onboarding.afterReply(FRIEND);
    check("someone else's message does not bring the owner's list out", h.told.length === 0);
    await h.onboarding.afterReply(OWNER);
    check("after the bot's first reply to a new owner, the list is sent", h.told.length === 1 && /^第一次用/.test(h.told[0]));
    await h.onboarding.afterReply(OWNER);
    await h.onboarding.afterReply(OWNER);
    check("…once", h.told.length === 1 && typeof h.onboarding.state().intro === "string");
  }
  {
    const h = make({ usedBefore: true });
    check("someone already using the bot is marked so", h.onboarding.state().legacy === true);
    await h.onboarding.afterReply(OWNER);
    check("…and is not sent the list", h.told.length === 0);
    check("…but can still ask what there is to set up", /新手清单/.test(await h.onboarding.guide("", "")));
  }
  {
    let failing = true;
    const h = make({ sendFails: () => failing });
    await h.onboarding.afterReply(OWNER);
    check("a list that could not be sent is not counted as sent", h.told.length === 0 && h.onboarding.state().intro === undefined);
    failing = false;
    await h.onboarding.afterReply(OWNER);
    check("…and goes out after the next reply", h.told.length === 1);
    const done = make({ mac: "ready", fullDisk: "granted", provider: "p", model: "m" });
    writeFileSync(done.file, JSON.stringify({ v: 1, since: "x", items: { names: "done" } }));
    await done.onboarding.afterReply(OWNER);
    check("nothing left to set up → no message, and it is not looked at again", done.told.length === 0 && typeof done.onboarding.state().intro === "string");
  }
  {
    const h = make();
    const first = await h.onboarding.guide("", "");
    check("the guide lists every item with where it stands and how it is done, and names the next one",
      /新手清单（4 项，0 项已经好了）/.test(first) && /⬜ 语音/.test(first) && /怎么做：/.test(first) && /下一项：语音。/.test(first) && /一次只讲一项/.test(first), first);
    const skipped = await h.onboarding.guide("voice", "skip");
    check("skip → that item is passed over and the next one is up", /⏭ 语音：用户说跳过/.test(skipped) && /下一项：文件权限。/.test(skipped) && h.onboarding.state().items.voice === "skipped", skipped);
    const claimed = await h.onboarding.guide("files", "done");
    check("done is not taken on trust for what the computer can answer: the item stays open",
      /⬜ 文件权限/.test(claimed) && /以电脑上实际的状态为准/.test(claimed) && h.onboarding.state().items.files === undefined, claimed);
    const named = await h.onboarding.guide("names", "done");
    check("names is the one item the bot marks done itself", /✅ 称呼/.test(named) && h.onboarding.state().items.names === "done");
    const later = await h.onboarding.guide("", "later");
    check("later → noted, and the guide stops being brought up", /以后再说/.test(later) && typeof h.onboarding.state().later === "string" && !/一次只讲一项/.test(later));
    const blank = await h.onboarding.guide("voice", "");
    check("an empty set changes nothing (models fill in every parameter)", h.onboarding.state().items.voice === "skipped" && /新手清单/.test(blank));
    const nonsense = await h.onboarding.guide("everything", "done");
    check("an item that does not exist changes nothing", JSON.stringify(h.onboarding.state().items) === JSON.stringify({ voice: "skipped", names: "done" }) && /新手清单/.test(nonsense));
    const fresh = make();
    await fresh.onboarding.guide("", "later");
    await fresh.onboarding.afterReply(OWNER);
    check("later before the list was ever sent → it is never sent", fresh.told.length === 0);
  }
  {
    const h = make({ mac: "ready", fullDisk: "granted", provider: "p", model: "m" });
    await h.onboarding.guide("names", "done");
    const all = await h.onboarding.guide("", "");
    check("everything done → the guide says so and points at the optional extras", /没有待办的了/.test(all) && /日历/.test(all) && !/下一项/.test(all), all);
    writeFileSync(h.file, "{ this is not json");
    check("an unreadable state file starts over instead of failing", h.onboarding.state().v === 1);
  }
}

// ----------------------------------------------------------------- 4. wiring
{
  const read = (f) => readFileSync(join(ROOT, f), "utf-8");
  const bridge = read("src/bridge.ts");
  check("wiring: the WeChat agent gets both setup tools, and losing them cannot take the WeChat tools down",
    /try \{\s*registerVoiceSetupTools\(agentCtx, this\.voiceSetupDeps\(\)\);\s*registerSetupGuideTool\(agentCtx, this\.onboarding/.test(bridge)
    && /the setup tools did not register \(the rest did\)/.test(bridge));
  check("wiring: the list goes out after the reply, behind anything WeChat kept back",
    bridge.indexOf("this.deliverBacklog(first.sender);") < bridge.indexOf("void this.onboarding.afterReply(first.sender)")
    && bridge.indexOf("void this.onboarding.afterReply(first.sender)") > 0);
  check("wiring: new or existing owner is decided when the listener starts, before any message", /this\.onboarding\.state\(\);/.test(bridge));
  check("wiring: the question to the owner is the bridge's own (delivered before listening, owner only)",
    /askOwner: \(question, signal\) => this\.askOwner\(question, 600_000, signal\)/.test(bridge));
  check("wiring: the router is given DSH's speech service to look up per message",
    /hostSpeech: \(\) => hostSpeech\(ctx\)/.test(read("src/index.ts")) && /hostSpeech: deps\.hostSpeech/.test(read("src/inbound.ts")));
  check("the two tools have the names the texts use", VOICE_TOOL === "enable_voice_input" && SETUP_TOOL === "setup_guide");
}

// ------------------------------------ 5. the host's real speech service, if here
{
  // The DSH this machine runs: the bucket whose launcher is newest (as the regression suite picks it), or DSH_NPX.
  const hostModules = (() => {
    if (process.env.DSH_NPX) return process.env.DSH_NPX;
    const root = join(homedir(), ".npm/_npx");
    let best;
    for (const bucket of existsSync(root) ? readdirSync(root) : []) {
      try {
        const mtime = lstatSync(join(root, bucket, "node_modules/.bin/dsh")).mtimeMs;
        if (!best || mtime > best.mtime) best = { mtime, dir: join(root, bucket, "node_modules") };
      } catch { /* not a dsh bucket */ }
    }
    return best?.dir;
  })();
  const entry = hostModules && join(hostModules, "@deepseek-ai/dsh-experimental-speech-to-text/lib/index.js");
  if (!entry || !existsSync(entry)) {
    note("skipped the check against DSH's real speech service: no DSH with it was found on this machine");
  } else {
    const version = JSON.parse(readFileSync(join(hostModules, "@deepseek-ai/dsh/package.json"), "utf-8")).version;
    try {
      const { default: SpeechToText } = await import(pathToFileURL(entry).href);
      const { Context } = await import(pathToFileURL(join(hostModules, "@deepseek-ai/cordis/lib/index.js")).href);
      const live = (value) => ({ get: () => value });
      const service = new SpeechToText(new Context(), { defaultProvider: live("test-local"), language: live("auto") });
      const heard = [];
      let phase = "unprepared";
      const prepared = [];
      const dispose = service.register({
        info: { id: "test-local", name: "Test recognizer", location: "host-local", languages: ["auto", "zh"] },
        preparation: { snapshot: () => ({ phase }), subscribe: () => () => {}, prepare: () => { prepared.push(1); phase = "ready"; }, cancel: async () => {} },
        async transcribe(input) { heard.push([Buffer.from(input.audio), input.language]); return { text: "真的 服务 听到了 。", audioSeconds: 1, inferenceSeconds: 0.01 }; },
      });
      check(`DSH ${version}'s own speech service: the plugin reads its state (a recognizer without its model)`,
        hostSpeechStatus(service).state === "unprepared" && hostSpeechStatus(service).providerId === "test-local" && hostSpeechStatus(service).local === true,
        JSON.stringify(hostSpeechStatus(service)));
      service.prepare("test-local");
      check("…starts its preparation the way the tool does", prepared.length === 1 && hostSpeechStatus(service).state === "ready");
      const outcome = await transcribeVoiceItem(item(), {
        cdnBaseUrl: "x", language: "zh-CN", helper: neverHelper, hostSpeech: () => service, platformSupported: () => false, download: async () => OPUS_16K,
      });
      check("…and transcribes through it: resolve, then transcribe, with the WAV it accepts",
        outcome.ok === true && outcome.text === "真的服务听到了。" && outcome.engine === "test-local" && heard.length === 1 && isCanonicalWav(heard[0][0]) && heard[0][1] === "auto",
        JSON.stringify(outcome));
      try {
        const { validateWave } = await import(pathToFileURL(join(hostModules, "@deepseek-ai/dsh-experimental-speech-to-text/lib/types/wave.js")).href);
        const seconds = validateWave(heard[0][0], 120);
        check("…DSH's own check of the recording accepts it", Math.abs(seconds - 1) < 0.1, String(seconds));
      } catch (err) {
        note(`DSH's WAV check could not be run here (${String(err.message ?? err).slice(0, 100)})`);
      }
      await dispose();
      check("…a recognizer taken away reads as no service to use", hostSpeechStatus(service).state === "absent");
    } catch (err) {
      note(`skipped the check against DSH ${version}'s real speech service: it could not be set up outside DSH (${String(err.message ?? err).slice(0, 140)})`);
    }
  }
}

console.log(results.join("\n"));
console.log(`\n${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
