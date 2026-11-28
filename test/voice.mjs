#!/usr/bin/env node
/**
 * Voice messages that arrive without WeChat's transcript (src/voice.ts and the
 * router's part in src/inbound.ts).
 *
 * Three layers:
 *   1. the pure pieces: what the bytes are, the WAV wrapper, the wording of
 *      the reply when nothing could be read;
 *   2. the router with a stand-in transcriber: where the transcript goes, what
 *      the agent is told, what the owner is told when there is none;
 *   3. on a Mac with the on-device speech models (macOS 26 and later), the
 *      real path end to end: synthetic speech (`say`) encoded the way WeChat
 *      encodes voice (SILK), decoded, and transcribed by the helper this file
 *      compiles into its own temporary folder.
 *
 * No WeChat, no model, no network. Nothing is recorded: the speech is the
 * system voice reading a sentence in this file. Layer 3 is skipped, with a
 * line saying why, where the system cannot do it.
 *
 *   npm run build && node test/voice.mjs
 *
 * Exits non-zero when any check fails.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { release, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
process.env.TZ = "America/New_York";
const STATE = mkdtempSync(join(tmpdir(), "clawbot-voice-test-"));
process.env.CLAWBOT_STATE_DIR = STATE;
// The plugin writes the audio it hands to the helper under the temp folder; give it one to look into.
const TMP = join(STATE, "tmp");
mkdirSync(TMP, { recursive: true });
process.env.TMPDIR = TMP;
process.on("exit", () => rmSync(STATE, { recursive: true, force: true }));

let pass = 0;
let fail = 0;
const results = [];
function check(name, ok, detail) {
  if (ok) { pass += 1; results.push(`  ✓ ${name}`); }
  else { fail += 1; results.push(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); }
}
const note = (text) => results.push(`  · ${text}`);
const lib = (p) => join(ROOT, "lib", p);

const { setLogLevel } = await import(lib("ilink/util/logger.js"));
setLogLevel?.("ERROR");
const { SpeechHelper, transcribeVoiceItem, voiceLacksTranscript, voiceNotice, voicePlatformSupported, pcmToWav, sniffAudio, playableAudio, decodeOpusRaw, tidyTranscript }
  = await import(lib("voice.js"));
const OpusScript = createRequire(lib("voice.js"))("opusscript");

/** WeChat's Opus voice container: the marker, the rate's index, the channel count, a zero; then each packet behind its 16-bit length. */
function opusRaw(rateIndex, channels, packets, reserved = 0) {
  const parts = [Buffer.from("#!OPUS_RAW_V1", "latin1"), Buffer.from([rateIndex, channels, reserved])];
  for (const packet of packets) {
    const length = Buffer.alloc(2);
    length.writeUInt16LE(packet.length);
    parts.push(length, packet);
  }
  return Buffer.concat(parts);
}
/** 16-bit PCM cut into frames and encoded, one Opus packet per frame. */
function opusPackets(pcm, sampleRate, channels, frameMs = 20) {
  const encoder = new OpusScript(sampleRate, channels, OpusScript.Application.VOIP);
  const frame = sampleRate * frameMs / 1000;
  const step = frame * channels * 2;
  const packets = [];
  try {
    for (let at = 0; at + step <= pcm.length; at += step) packets.push(encoder.encode(pcm.subarray(at, at + step), frame));
  } finally {
    encoder.delete();
  }
  return packets;
}
function tone(sampleRate, channels, seconds, hz = 440) {
  const pcm = Buffer.alloc(Math.round(sampleRate * seconds) * channels * 2);
  for (let i = 0; i < sampleRate * seconds; i += 1) {
    const value = Math.round(Math.sin(i * hz * 2 * Math.PI / sampleRate) * 8000);
    for (let c = 0; c < channels; c += 1) pcm.writeInt16LE(value, (i * channels + c) * 2);
  }
  return pcm;
}
const peakOf = (pcm) => { let peak = 0; for (let i = 0; i + 1 < pcm.length; i += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i))); return peak; };
const { InboundRouter, unreadableNotice } = await import(lib("inbound.js"));
const { PendingRegistry } = await import(lib("pending.js"));
const { normalizeConfig, HOT_FIELDS } = await import(lib("config.js"));

// ---------------------------------------------------------------- 1. the pieces
{
  check("a voice item with no text lacks a transcript", voiceLacksTranscript({ type: 3, voice_item: { playtime: 8000 } }));
  check("…and so does one whose text is blank", voiceLacksTranscript({ type: 3, voice_item: { text: "  " } }));
  check("a voice item with WeChat's transcript does not", !voiceLacksTranscript({ type: 3, voice_item: { text: "去北京。" } }));
  check("a text item is not a voice item", !voiceLacksTranscript({ type: 1, text_item: { text: "" } }));

  check("transcribing needs a Mac on macOS 26 (Darwin 25) or later",
    voicePlatformSupported("darwin", "25.0.0") && voicePlatformSupported("darwin", "26.2.0")
    && !voicePlatformSupported("darwin", "24.6.0") && !voicePlatformSupported("win32", "10.0.26100") && !voicePlatformSupported("linux", "6.8.0"));

  const silk = Buffer.concat([Buffer.from([0x02]), Buffer.from("#!SILK_V3"), Buffer.alloc(8)]);
  check("WeChat's SILK (one 0x02 byte, then the marker) is recognised", sniffAudio(silk) === "silk");
  check("standard SILK is recognised", sniffAudio(Buffer.from("#!SILK_V3\x0c\x00")) === "silk");
  check("WeChat's Opus container (#!OPUS_RAW_V1) is recognised", sniffAudio(opusRaw(2, 1, [Buffer.from([1, 2, 3])])) === "opus-raw");
  check("WAV, AMR, MP3 and M4A are told apart",
    sniffAudio(Buffer.from("RIFF\x00\x00\x00\x00WAVEfmt ")) === "wav" && sniffAudio(Buffer.from("#!AMR\n")) === "amr"
    && sniffAudio(Buffer.from("ID3\x04\x00")) === "mp3" && sniffAudio(Buffer.from([0xff, 0xfb, 0x90, 0x00])) === "mp3"
    && sniffAudio(Buffer.from("\x00\x00\x00\x20ftypM4A ", "latin1")) === "m4a");
  check("anything else is unknown", sniffAudio(Buffer.from("hello there")) === "unknown" && sniffAudio(Buffer.alloc(0)) === "unknown");

  const pcm = new Uint8Array(48000); // one second of silence at 24 kHz, 16-bit
  const wav = pcmToWav(pcm, 24000);
  check("the WAV wrapper: 44-byte header, mono, 16-bit, the rate it was given",
    wav.length === 44 + 48000 && wav.subarray(0, 4).toString() === "RIFF" && wav.subarray(8, 12).toString() === "WAVE"
    && wav.readUInt16LE(22) === 1 && wav.readUInt32LE(24) === 24000 && wav.readUInt16LE(34) === 16 && wav.readUInt32LE(40) === 48000
    && wav.readUInt32LE(4) === 36 + 48000);
  check("the wrapper's output reads back as WAV", sniffAudio(wav) === "wav");
  const stereoWav = pcmToWav(new Uint8Array(1920), 48000, 2);
  check("the WAV wrapper carries a channel count: stereo at 48 kHz is 4 bytes a frame",
    stereoWav.readUInt16LE(22) === 2 && stereoWav.readUInt32LE(24) === 48000 && stereoWav.readUInt32LE(28) === 192000 && stereoWav.readUInt16LE(32) === 4);

  // WeChat's Opus voice: the container, decoded packet by packet.
  {
    const packets = opusPackets(tone(16000, 1, 1), 16000, 1);
    const decoded = await decodeOpusRaw(opusRaw(2, 1, packets));
    check("Opus voice, 16 kHz mono (what WeChat sends): a second in, a second out, and it is the tone",
      decoded.sampleRate === 16000 && decoded.channels === 1 && decoded.pcm.length === 32000 && peakOf(decoded.pcm) > 4000,
      `${decoded.pcm.length} bytes, peak ${peakOf(decoded.pcm)}`);
    const withLost = await decodeOpusRaw(opusRaw(2, 1, [packets[0], Buffer.alloc(0), packets[1]]));
    check("…a lost packet (length 0) is 20 ms of silence, not the end of the message", withLost.pcm.length === 3 * 640);
    const stereo = await decodeOpusRaw(opusRaw(4, 2, opusPackets(tone(48000, 2, 0.2), 48000, 2)));
    check("…48 kHz stereo decodes with its own rate and channels",
      stereo.sampleRate === 48000 && stereo.channels === 2 && stereo.pcm.length === 0.2 * 48000 * 2 * 2);
    const long = await decodeOpusRaw(opusRaw(2, 1, opusPackets(tone(16000, 1, 0.6), 16000, 1, 60)));
    check("…60 ms packets decode as well as 20 ms ones", long.pcm.length === 0.6 * 32000, String(long.pcm.length));
    const cut = Buffer.concat([opusRaw(2, 1, packets.slice(0, 3)), Buffer.from([200, 0, 1, 2, 3])]);
    const kept = await decodeOpusRaw(cut);
    check("…a file cut off mid-packet keeps what came before", kept.pcm.length === 3 * 640);
    const playable = await playableAudio(opusRaw(2, 1, packets));
    check("…and it becomes a WAV the speech models can open",
      playable.ext === ".wav" && sniffAudio(playable.bytes) === "wav" && playable.bytes.readUInt32LE(24) === 16000 && playable.bytes.length === 44 + 32000);
    const refuses = async (bytes) => decodeOpusRaw(bytes).then(() => false, () => true);
    check("an unknown sample rate, three channels, a non-zero third byte: refused",
      await refuses(opusRaw(9, 1, packets)) && await refuses(opusRaw(2, 3, packets)) && await refuses(opusRaw(2, 1, packets, 1)));
    check("no packets, a first packet cut off, a packet no Opus packet can be: refused",
      await refuses(opusRaw(2, 1, [])) && await refuses(Buffer.concat([opusRaw(2, 1, []), Buffer.from([200, 0, 1])]))
      && await refuses(opusRaw(2, 1, [Buffer.alloc(4000)])));
    check("a later version of the container is named as such, not passed to the SILK decoder",
      await playableAudio(Buffer.from("#!OPUS_RAW_V2\x02\x01\x00\x03\x00abc", "latin1")).then(() => false, (err) => /Opus container/.test(String(err.message))));
  }

  // The newer model's spacing.
  check("a transcript loses the spaces the model puts around Chinese",
    tidyTranscript("明天下午 3:00提醒我交报告 ，然后帮我看一下周五的日程 ，感谢。") === "明天下午3:00提醒我交报告，然后帮我看一下周五的日程，感谢。",
    tidyTranscript("明天下午 3:00提醒我交报告 ，然后帮我看一下周五的日程 ，感谢。"));
  check("…and keeps the spaces between words in another script",
    tidyTranscript("  please remind  me to call\nthe dentist ") === "please remind me to call the dentist"
    && tidyTranscript("帮我看一下 open source 项目") === "帮我看一下open source项目");

  // The reply when a voice message has no transcript from either side.
  const reasons = ["off", "no-engine", "host-unprepared", "no-media", "download", "decode", "tools", "build", "language", "failed", "empty"];
  const notices = reasons.map((reason) => voiceNotice({ ok: false, reason }));
  check("every such reply calls it a voice message, never a video",
    notices.every((text) => text.startsWith("[DSH] ") && text.includes("语音") && !text.includes("视频")), notices.join(" | "));
  check("…and says what to do", notices.every((text) => /打字/.test(text)));
  check("the Mac's own models unusable (no command line tools) → the reply points at DSH's 语音输入 instead", /语音输入/.test(voiceNotice({ ok: false, reason: "tools" })));
  check("nothing understood → the reply says nothing was made out", /没听出/.test(voiceNotice({ ok: false, reason: "empty" })));

  // The reply by what the message was.
  check("a video is still called a video", /视频/.test(unreadableNotice({ item_list: [{ type: 5 }] }) ?? ""));
  check("a voice message is called a voice message",
    /语音/.test(unreadableNotice({ item_list: [{ type: 3, voice_item: {} }] }, { ok: false, reason: "failed" }) ?? "")
    && !/视频/.test(unreadableNotice({ item_list: [{ type: 3, voice_item: {} }] }, { ok: false, reason: "failed" }) ?? ""));
  check("a picture that could not be fetched is called a picture", /图片/.test(unreadableNotice({ item_list: [{ type: 2 }] }) ?? "")
    && !/视频/.test(unreadableNotice({ item_list: [{ type: 2 }] }) ?? ""));
  check("a file that could not be fetched is called a file", /文件/.test(unreadableNotice({ item_list: [{ type: 4 }] }) ?? "")
    && !/视频/.test(unreadableNotice({ item_list: [{ type: 4 }] }) ?? ""));
  check("something unknown is not called a video either", !/视频/.test(unreadableNotice({ item_list: [{ type: 99 }] }) ?? "视频")
    && (unreadableNotice({ item_list: [{ type: 99 }] }) ?? "").startsWith("[DSH] "));
  check("an empty text message gets no reply", unreadableNotice({ item_list: [{ type: 1, text_item: { text: "" } }] }) === null
    && unreadableNotice({ item_list: [] }) === null);

  // Settings.
  const defaults = normalizeConfig({});
  check("transcribing is on by default, in Chinese", defaults.voiceTranscribe === true && defaults.voiceLanguage === "zh-CN");
  check("both settings are hot (the card can write them, the next message reads them)",
    HOT_FIELDS.has("voiceTranscribe") && HOT_FIELDS.has("voiceLanguage"));
  check("a language tag is taken as typed; nonsense falls back",
    normalizeConfig({ voiceLanguage: "en_US" }).voiceLanguage === "en-US" && normalizeConfig({ voiceLanguage: " yue-CN " }).voiceLanguage === "yue-CN"
    && normalizeConfig({ voiceLanguage: "中文" }).voiceLanguage === "zh-CN" && normalizeConfig({ voiceLanguage: "; rm -rf" }).voiceLanguage === "zh-CN"
    && normalizeConfig({ voiceLanguage: 7 }).voiceLanguage === "zh-CN");
  check("the card has the switch", /set\("voiceTranscribe", next\)/.test(readFileSync(join(ROOT, "src/client.js"), "utf-8")));
}

// ---------------------------------------------------------------- 2. the router
{
  const make = (over = {}) => {
    const pending = new PendingRegistry();
    const notices = [];
    const enqueued = [];
    const asked = [];
    const incoming = [];
    const router = new InboundRouter({
      config: { allowFrom: [], ...(over.config ?? {}) },
      account: { accountId: "acc", userId: "u1", cdnBaseUrl: "http://127.0.0.1:9" },
      bridge: { enqueueMessage: async (...args) => { enqueued.push(args); }, noteIncoming: (_sender, delta) => { incoming.push(delta); } },
      pending,
      sendText: async (_to, text) => { notices.push(text); },
      ...(over.transcribeVoice === null ? {} : {
        transcribeVoice: async (item) => { asked.push(item); return (over.transcribeVoice ?? (() => ({ ok: true, text: "明天下午提醒我交报告。", engine: "dictation" })))(item); },
      }),
    });
    return { router, pending, notices, enqueued, asked, incoming };
  };
  const voiceOnly = () => ({ from_user_id: "u1", message_id: 1, item_list: [{ type: 3, voice_item: { playtime: 8000, media: { full_url: "http://127.0.0.1:9/x", aes_key: "AAAA" } } }] });

  {
    const h = make();
    await h.router.handle(voiceOnly());
    check("no transcript from WeChat → the voice message is transcribed here and goes to the agent",
      h.asked.length === 1 && h.enqueued.length === 1 && String(h.enqueued[0][1]).includes("明天下午提醒我交报告。"), JSON.stringify(h.enqueued));
    check("…the agent is told the text is this machine's transcript of a voice message",
      /语音/.test(String(h.enqueued[0]?.[1])) && /转写/.test(String(h.enqueued[0]?.[1])));
    check("…and the owner gets no canned reply", h.notices.length === 0, h.notices.join(" | "));
    check("…the reply tools were told a message was on its way while it was transcribed",
      h.incoming.join() === "1,-1");
  }
  {
    const h = make();
    const msg = voiceOnly();
    await h.router.handle(msg);
    check("the transcript is put where WeChat's would have been (the ledger and quotes read it there)",
      msg.item_list[0].voice_item.text === "明天下午提醒我交报告。" && msg.item_list[0].voice_item.playtime === 8000);
  }
  {
    const h = make();
    await h.router.handle({ from_user_id: "u1", item_list: [{ type: 3, voice_item: { text: "到楼下了", playtime: 2100 } }] });
    check("WeChat's own transcript is used as it always was: nothing is transcribed here, no note is added",
      h.asked.length === 0 && h.enqueued.length === 1 && h.enqueued[0][1] === "到楼下了", JSON.stringify(h.enqueued));
  }
  {
    const h = make({ transcribeVoice: () => ({ ok: false, reason: "failed", detail: "boom" }) });
    await h.router.handle(voiceOnly());
    check("no transcript from either side → the owner is told it is a voice message that could not be read",
      h.enqueued.length === 0 && h.notices.length === 1 && /语音/.test(h.notices[0]) && !/视频/.test(h.notices[0]), h.notices.join(" | "));
  }
  {
    const h = make({ transcribeVoice: () => { throw new Error("the transcriber fell over"); } });
    await h.router.handle(voiceOnly());
    check("a transcriber that throws does not take the message handler down",
      h.enqueued.length === 0 && h.notices.length === 1 && /语音/.test(h.notices[0]), h.notices.join(" | "));
  }
  {
    const h = make({ config: { voiceTranscribe: false } });
    await h.router.handle(voiceOnly());
    check("switched off → nothing is transcribed, and the reply says the bot cannot hear voice",
      h.asked.length === 0 && h.enqueued.length === 0 && h.notices.length === 1 && /听不了语音/.test(h.notices[0]), h.notices.join(" | "));
  }
  {
    const h = make();
    const answers = [];
    h.pending.push({ tag: "question", sender: "u1", resolve: (reply) => answers.push(reply) });
    await h.router.handle(voiceOnly());
    check("a voice reply without WeChat's transcript still answers the bot's pending question",
      answers.length === 1 && answers[0] === "明天下午提醒我交报告。" && h.enqueued.length === 0, JSON.stringify(answers));
  }
  {
    const h = make({ transcribeVoice: () => ({ ok: false, reason: "empty" }) });
    const answers = [];
    h.pending.push({ tag: "question", sender: "u1", resolve: (reply) => answers.push(reply) });
    await h.router.handle(voiceOnly());
    check("…and one nothing was made out of withdraws the question instead of answering it with nothing",
      answers.length === 1 && answers[0] === null && h.notices.length === 1 && /没听出/.test(h.notices[0]), `${JSON.stringify(answers)} ${h.notices.join(" | ")}`);
  }
  {
    const h = make();
    await h.router.handle({ from_user_id: "u1", item_list: [{ type: 5, video_item: { video_size: 10 } }] });
    check("a video is not sent to the transcriber and is still answered as a video",
      h.asked.length === 0 && h.notices.length === 1 && /视频/.test(h.notices[0]));
  }
  {
    // No stand-in: the real transcriber, on an item with nothing to download.
    const h = make({ transcribeVoice: null });
    await h.router.handle({ from_user_id: "u1", item_list: [{ type: 3, voice_item: { playtime: 3000 } }] });
    check("a voice item with no audio to fetch is answered at once, as a voice message",
      h.enqueued.length === 0 && h.notices.length === 1 && /语音/.test(h.notices[0]) && !/视频/.test(h.notices[0]), h.notices.join(" | "));
  }
  {
    // The raw log keeps the shape of a voice item and none of its content.
    const raw = readFileSync(join(STATE, "inbound-raw.jsonl"), "utf-8").trim().split("\n").map((line) => JSON.parse(line));
    const first = raw.find((row) => row.items?.[0]?.type === 3 && row.items[0].voice?.media !== null);
    check("the raw log records what a voice item carried (fields, length, whether there is audio), not its content",
      first !== undefined && first.items[0].voice.textChars === null && first.items[0].voice.playtime === 8000
      && first.items[0].voice.media.url === true && first.items[0].voice.media.key === true
      && !JSON.stringify(first).includes("AAAA") && !JSON.stringify(first).includes("127.0.0.1"), JSON.stringify(first));
    const withText = raw.find((row) => row.items?.[0]?.voice?.textChars === 4);
    check("…and for one WeChat transcribed, how long the transcript was", withText !== undefined && !JSON.stringify(withText).includes("到楼下了"));
  }
  {
    // A text message with a quote. At the default log level the raw log keeps its
    // lengths and fields only (PR 4: it used to keep a plaintext copy of every chat);
    // at logLevel debug a row carries the text and the quote as they came.
    const h = make();
    h.router.bridge.lookupQuoteByTime = () => undefined;   // no quote history in this test
    await h.router.handle({ from_user_id: "u1", message_id: 7, client_id: "c-text-1", item_list: [{ type: 1, text_item: { text: "周五下午三点见" },
      ref_msg: { title: "上次说的地方", message_item: { type: 1, text_item: { text: "老地方" } } } }] });
    const hd = make({ config: { logLevel: "debug" } });
    await hd.router.handle({ from_user_id: "u1", message_id: 8, client_id: "c-text-2", item_list: [{ type: 1, text_item: { text: "调试时留原文" } }] });
    const rows = readFileSync(join(STATE, "inbound-raw.jsonl"), "utf-8").trim().split("\n").map((line) => JSON.parse(line));
    const plain = rows.find((row) => row.clientId === "c-text-1");
    const dbg = rows.find((row) => row.clientId === "c-text-2");
    check("the raw log keeps a text message's length and quote fields, not the text or the quote",
      plain !== undefined && plain.items[0].textChars === 7 && !("text" in plain.items[0])
        && plain.items[0].ref?.titleChars === 6 && plain.items[0].ref?.item?.type === 1
        && !/周五|老地方|上次说的地方/.test(JSON.stringify(plain)), JSON.stringify(plain));
    check("…at logLevel debug a row carries the text as it came", dbg?.items?.[0]?.text === "调试时留原文", JSON.stringify(dbg));
    check("…and the file is private (0600)", (statSync(join(STATE, "inbound-raw.jsonl")).mode & 0o777) === 0o600);

    // A log written by an older version is 0644, and so are its rotated copies.
    const old = mkdtempSync(join(tmpdir(), "clawbot-rawlog-"));
    writeFileSync(join(old, "inbound-raw.jsonl"), "{}\n", { mode: 0o644 });
    writeFileSync(join(old, "inbound-raw.jsonl.1"), "{}\n", { mode: 0o644 });
    const probe = `const { InboundRouter } = await import(${JSON.stringify(new URL("../lib/inbound.js", import.meta.url).href)});
      const router = new InboundRouter({ config: { allowFrom: [] }, account: { accountId: "acc", userId: "u1", cdnBaseUrl: "http://127.0.0.1:9" },
        bridge: { enqueueMessage: async () => {}, noteIncoming: () => {} }, pending: { popFor: () => undefined }, sendText: async () => {},
        transcribeVoice: async () => ({ ok: false, reason: "no-engine" }) });
      await router.handle({ from_user_id: "u1", item_list: [{ type: 1, text_item: { text: "hi" } }] });`;
    execFileSync(process.execPath, ["--input-type=module", "-e", probe], { env: { ...process.env, CLAWBOT_STATE_DIR: old }, stdio: "pipe" });
    const modes = ["inbound-raw.jsonl", "inbound-raw.jsonl.1"].map((name) => statSync(join(old, name)).mode & 0o777);
    rmSync(old, { recursive: true, force: true });
    check("…and a log an older version left at 0644 is made 0600, rotated copies too", modes.every((mode) => mode === 0o600), modes.map((m) => m.toString(8)).join(","));
  }
}

// ------------------------------------------------- 3. outcomes without the helper
{
  const never = { transcribe: async () => { throw new Error("the helper must not be reached"); } };
  const item = { type: 3, voice_item: { playtime: 5000, media: { full_url: "http://127.0.0.1:9/voice", aes_key: "AAAA" } } };
  const base = { cdnBaseUrl: "http://127.0.0.1:9", language: "zh-CN", helper: never, platformSupported: () => true };

  const off = await transcribeVoiceItem(item, { ...base, platformSupported: () => false });
  check("not a Mac with the speech models, and no DSH speech recognition → no-engine, and nothing is downloaded", off.ok === false && off.reason === "no-engine");
  const noMedia = await transcribeVoiceItem({ type: 3, voice_item: { playtime: 5000 } }, base);
  check("no audio in the item → no-media", noMedia.ok === false && noMedia.reason === "no-media");
  const down = await transcribeVoiceItem(item, { ...base, download: async () => { throw new Error("CDN 404"); } });
  check("the download fails → download", down.ok === false && down.reason === "download");
  const startedSlow = Date.now();
  const slow = await transcribeVoiceItem(item, { ...base, downloadTimeoutMs: 60, download: () => new Promise(() => {}) });
  check("a download that never finishes is given up on (the next message is waiting behind it)",
    slow.ok === false && slow.reason === "download" && Date.now() - startedSlow < 2000, `${Date.now() - startedSlow} ms`);
  const empty = await transcribeVoiceItem(item, { ...base, download: async () => Buffer.alloc(0) });
  check("an empty download → download", empty.ok === false && empty.reason === "download");
  const junk = await transcribeVoiceItem(item, { ...base, download: async () => Buffer.from("this is not audio at all, not even close") });
  check("bytes that are not audio → decode (the helper is never started)", junk.ok === false && junk.reason === "decode", JSON.stringify(junk));
  check("nothing is left in the temporary folder", readdirSync(TMP).filter((name) => name.startsWith("clawbot-voice-")).length === 0);
}

// ------------------------------------------------- 4. the real path, on this Mac
const canRun = voicePlatformSupported() && existsSync("/usr/bin/say") && existsSync("/usr/bin/afconvert");
if (!canRun) {
  note(`skipped the on-device run: needs a Mac on macOS 26 or later (this is ${process.platform} ${release()})`);
} else {
  const helper = new SpeechHelper(join(STATE, "speech-helper"));
  let built = false;
  try {
    await helper.ensureBuilt();
    built = helper.isBuilt();
  } catch (err) {
    note(`skipped the on-device run: the helper could not be built here (${String(err.message ?? err).slice(0, 160)})`);
  }
  if (built) {
    check("the helper compiles from the plugin's Swift source", existsSync(helper.exePath) && statSync(helper.exePath).size > 10_000);
    const mtime = statSync(helper.exePath).mtimeMs;
    await helper.ensureBuilt();
    check("…and is not compiled again while the source is unchanged", statSync(helper.exePath).mtimeMs === mtime);

    // The system voices, by the language each one speaks.
    const voices = new Map();
    for (const line of execFileSync("/usr/bin/say", ["-v", "?"], { encoding: "utf-8" }).split("\n")) {
      const m = /^(.+?)\s+([a-z]{2,3}_[A-Z]{2})\s+#/.exec(line);
      if (m && !voices.has(m[2])) voices.set(m[2], m[1].trim());
    }
    const samples = [
      { language: "zh-CN", voice: voices.get("zh_CN"), say: "明天下午提醒我交报告，然后帮我看一下周五的日程。", expect: ["提醒我", "报告", "周五"] },
      { language: "en-US", voice: voices.get("en_US"), say: "Please remind me to call the dentist tomorrow morning.", expect: ["remind me", "dentist", "tomorrow"] },
    ];
    const silk = await import("silk-wasm");
    const encode = silk.encode ?? silk.default.encode;
    let ran = 0;
    for (const sample of samples) {
      const status = await helper.status(sample.language);
      if (status.ok !== true || typeof status.engine !== "string" || sample.voice === undefined) {
        note(`${sample.language}: skipped (no on-device model or no system voice here: speech=${status.speech}, dictation=${status.dictation})`);
        continue;
      }
      ran += 1;
      const aiff = join(STATE, `say-${sample.language}.aiff`);
      const wav = join(STATE, `say-${sample.language}.wav`);
      execFileSync("/usr/bin/say", ["-v", sample.voice, "-o", aiff, sample.say]);
      execFileSync("/usr/bin/afconvert", ["-f", "WAVE", "-d", "LEI16@24000", "-c", "1", aiff, wav]);
      // What WeChat sends: SILK, with Tencent's leading byte.
      const encoded = Buffer.from((await encode(readFileSync(wav), 0)).data);
      check(`${sample.language}: the test audio is SILK the way WeChat sends it`, sniffAudio(encoded) === "silk" && encoded[0] === 0x02,
        encoded.subarray(0, 10).toString("hex"));
      const playable = await playableAudio(encoded);
      // 24 kHz in, 16 kHz out: two thirds of the bytes for the same seconds.
      check(`${sample.language}: SILK decodes to a 16 kHz WAV of the same duration`,
        playable.ext === ".wav" && playable.canonical === true && playable.bytes.readUInt32LE(24) === 16000
        && Math.abs(playable.bytes.length - statSync(wav).size * 2 / 3) < statSync(wav).size * 0.07,
        `${playable.bytes.length} vs ${Math.round(statSync(wav).size * 2 / 3)}`);

      const item = { type: 3, voice_item: { playtime: 5000, encode_type: 6, media: { full_url: "http://127.0.0.1:9/voice", aes_key: "AAAA" } } };
      const started = Date.now();
      const outcome = await transcribeVoiceItem(item, {
        cdnBaseUrl: "http://127.0.0.1:9", language: sample.language, helper, download: async () => encoded,
      });
      const lowered = outcome.ok ? outcome.text.toLowerCase() : "";
      check(`${sample.language}: SILK voice → text, on this Mac (${outcome.ok ? `${outcome.engine}, ${Date.now() - started} ms` : outcome.reason})`,
        outcome.ok === true && sample.expect.every((word) => lowered.includes(word.toLowerCase())),
        outcome.ok ? outcome.text : JSON.stringify(outcome));
      check(`${sample.language}: the audio written for the helper is gone afterwards`,
        readdirSync(TMP).filter((name) => name.startsWith("clawbot-voice-")).length === 0);

      // The same sentence the way WeChat sends voice now: Opus at 16 kHz in its #!OPUS_RAW_V1 container.
      const raw16 = join(STATE, `say-${sample.language}-16k.wav`);
      execFileSync("/usr/bin/afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, raw16]);
      const wav16 = readFileSync(raw16);
      const pcm16 = wav16.subarray(wav16.indexOf("data") + 8);
      const container = opusRaw(2, 1, opusPackets(pcm16, 16000, 1));
      const viaOpus = await transcribeVoiceItem(
        { type: 3, voice_item: { playtime: 5000, encode_type: 7, sample_rate: 16000, media: { full_url: "http://127.0.0.1:9/voice", aes_key: "AAAA" } } },
        { cdnBaseUrl: "http://127.0.0.1:9", language: sample.language, helper, download: async () => container },
      );
      const loweredOpus = viaOpus.ok ? viaOpus.text.toLowerCase() : "";
      check(`${sample.language}: Opus voice (#!OPUS_RAW_V1, ${container.length} bytes) → text, on this Mac`,
        viaOpus.ok === true && sample.expect.every((word) => loweredOpus.includes(word.toLowerCase())),
        viaOpus.ok ? viaOpus.text : JSON.stringify(viaOpus));
    }
    if (ran === 0) note("no language could be run end to end on this Mac");

    // A second of silence: transcribed, and nothing was said.
    {
      const language = (await helper.status("zh-CN")).engine ? "zh-CN" : "en-US";
      const quiet = Buffer.from((await encode(pcmToWav(new Uint8Array(48000), 24000), 0)).data);
      const outcome = await transcribeVoiceItem(
        { type: 3, voice_item: { media: { full_url: "http://127.0.0.1:9/voice" } } },
        { cdnBaseUrl: "http://127.0.0.1:9", language, helper, download: async () => quiet },
      );
      check("a voice message with nothing said → empty, not an empty message to the agent",
        outcome.ok === false && outcome.reason === "empty", JSON.stringify(outcome));
    }
    // A language this Mac has no model for.
    {
      const outcome = await helper.transcribe(join(STATE, "say-missing.wav"), "xx-YY").catch((err) => ({ ok: false, reason: "threw", detail: String(err) }));
      check("an audio file that is not there → failed, with the helper's reason", outcome.ok === false && outcome.reason === "failed", JSON.stringify(outcome));
      writeFileSync(join(STATE, "quiet.wav"), pcmToWav(new Uint8Array(48000), 24000));
      const none = await helper.transcribe(join(STATE, "quiet.wav"), "xx-YY");
      check("a language with no on-device model → language", none.ok === false && none.reason === "language", JSON.stringify(none));
    }
    // A changed source is noticed (and rebuilt at the next use); a source that does not compile leaves the old build working.
    {
      const src = join(STATE, "main.swift");
      copyFileSync(join(ROOT, "native/macos-speech/main.swift"), src);
      const own = new SpeechHelper(join(STATE, "speech-helper"), src);
      check("a helper built from the same source counts as built", own.isBuilt());
      writeFileSync(src, `${readFileSync(src, "utf-8")}\nthis does not compile\n`);
      check("a changed source is noticed", !own.isBuilt());
      const before = statSync(own.exePath).mtimeMs;
      const status = await own.status("en-US");
      check("a rebuild that fails leaves the older build in place and in use",
        status.ok === true && statSync(own.exePath).mtimeMs === before, JSON.stringify(status));
    }
    // No build at all and a source that does not compile: the reason is "build", and it is remembered.
    {
      const src = join(STATE, "broken.swift");
      writeFileSync(src, "this does not compile\n");
      const broken = new SpeechHelper(join(STATE, "speech-helper-broken"), src);
      const item = { type: 3, voice_item: { media: { full_url: "http://127.0.0.1:9/voice" } } };
      const wavBytes = pcmToWav(new Uint8Array(4800), 24000);
      const first = await transcribeVoiceItem(item, { cdnBaseUrl: "x", language: "zh-CN", helper: broken, download: async () => wavBytes });
      const started = Date.now();
      const second = await transcribeVoiceItem(item, { cdnBaseUrl: "x", language: "zh-CN", helper: broken, download: async () => wavBytes });
      check("a helper that cannot be built → build", first.ok === false && first.reason === "build", JSON.stringify(first));
      check("…and the failed build is not retried on the next voice message", second.ok === false && second.reason === "build" && Date.now() - started < 500,
        `${Date.now() - started} ms`);
    }
  }
}

console.log(results.join("\n"));
console.log(`\n${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
