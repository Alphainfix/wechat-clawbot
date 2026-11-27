/**
 * Voice messages that arrive without WeChat's transcript.
 *
 * WeChat transcribes a voice message itself and sends the text along with the
 * audio (`voice_item.text`); that text is all this plugin ever read. Some
 * evenings the text is simply not there — the item carries the audio and its
 * length, nothing else — and the message used to fall through to "unsupported".
 *
 * On a Mac the plugin now makes the transcript itself: download and decrypt
 * the audio, decode it, and hand a WAV to `clawbot-speech`
 * (native/macos-speech/main.swift), which runs the system's on-device speech
 * models. The audio stays on the machine, macOS asks for no permission, and
 * the WAV is deleted as soon as it has been read.
 *
 * Two things can do the transcribing, tried in this order:
 *   1. DSH's own speech recognition (`ctx.speechToText`, the experimental
 *      语音输入 bundle: a local SenseVoice model), when the owner has switched
 *      it on and its model is on disk. The same on macOS, Windows and Linux,
 *      which is what makes voice work alike for everyone.
 *   2. This Mac's on-device models, through `clawbot-speech`: nothing to set
 *      up, macOS 26 and later only.
 * With neither, the owner is told how to switch the first one on (the bot can
 * do it for them: voice-setup.ts).
 *
 * WeChat voice comes in two encodings. For years it was SILK (`silk-wasm`).
 * The messages that arrive without a transcript are the newer one: Opus
 * packets in a small container of WeChat's own, `#!OPUS_RAW_V1` (`opusscript`).
 *
 * Everything here answers with an outcome instead of throwing: a voice message
 * that cannot be transcribed is still a message the owner sent, and the router
 * tells them so in plain words.
 */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { downloadAndDecryptBuffer, downloadPlainCdnBuffer } from "./ilink/cdn/pic-decrypt.js";
import type { MessageItem } from "./ilink/api/types.js";
import { MessageItemType } from "./ilink/api/types.js";
import { resolveStateDir } from "./ilink/storage/state-dir.js";
import { logger } from "./ilink/util/logger.js";

/** Why a voice message got no transcript. */
export type VoiceFailure =
  /** The setting is off. */
  | "off"
  /** Nothing on this machine can transcribe: DSH's speech recognition is not switched on, and this is not a Mac with the on-device models. */
  | "no-engine"
  /** DSH's speech recognition is switched on, but its model is not on disk yet (or is on its way). */
  | "host-unprepared"
  /** The item has no audio to fetch. */
  | "no-media"
  | "download"
  | "decode"
  /** No Xcode command line tools to compile the helper with. */
  | "tools"
  | "build"
  /** No on-device model for the language on this Mac. */
  | "language"
  | "failed"
  /** Transcribed, and nothing was said (or nothing was understood). */
  | "empty";

export type VoiceOutcome =
  | { ok: true; text: string; engine: string }
  | { ok: false; reason: VoiceFailure; detail?: string; host?: HostSpeechStatus["state"] };

/** As much of DSH's speech recognition service (`ctx.speechToText`) as is used here. */
export type HostSpeech = {
  snapshot(): {
    providers: ReadonlyArray<{
      id: string;
      name?: string;
      location?: string;
      preparation?: { phase?: string; message?: string; completedBytes?: number; totalBytes?: number };
    }>;
    selection?: { providerId?: string; language?: string };
  };
  /** Pins the selected recognizer for one recording: a canonical 16 kHz mono 16-bit WAV. */
  resolve(request: { audio: Uint8Array }): unknown;
  transcribe(spec: unknown, signal: AbortSignal): Promise<{ text?: unknown }>;
  /** Start (or join) the download of the recognizer's model. */
  prepare?(id: string, options?: unknown): void;
};

/** Where DSH's speech recognition stands. */
export type HostSpeechStatus =
  /** The 语音输入 bundle is not switched on (or this DSH has none). */
  | { state: "absent" }
  | {
      /** ready: can transcribe now. preparing: the model is being fetched or loaded. unprepared: no model yet. */
      state: "ready" | "preparing" | "unprepared" | "failed";
      providerId: string;
      name: string;
      phase: string;
      /** Whether the recognizer runs on this machine (false: the owner configured a cloud one in DSH). */
      local: boolean;
      message?: string;
      completedBytes?: number;
      totalBytes?: number;
    };

/** Read DSH's speech recognition without trusting it to be there or to be the version this was written against. */
export function hostSpeechStatus(speech: HostSpeech | undefined): HostSpeechStatus {
  if (speech === undefined || speech === null || typeof speech.snapshot !== "function") return { state: "absent" };
  try {
    const snap = speech.snapshot();
    const wanted = snap.selection?.providerId;
    const provider = snap.providers.find((p) => p.id === wanted) ?? (wanted === undefined ? snap.providers[0] : undefined);
    if (provider === undefined) return { state: "absent" };
    const phase = String(provider.preparation?.phase ?? "ready");
    const state = phase === "ready" || phase === "standby" || phase === "waking"
      ? "ready"
      : phase === "downloading" || phase === "checking" || phase === "loading"
        ? "preparing"
        : phase === "failed" ? "failed" : "unprepared";
    return {
      state,
      providerId: String(provider.id),
      name: typeof provider.name === "string" && provider.name !== "" ? provider.name : String(provider.id),
      phase,
      local: provider.location !== "cloud",
      ...(typeof provider.preparation?.message === "string" ? { message: provider.preparation.message.slice(0, 200) } : {}),
      ...(typeof provider.preparation?.completedBytes === "number" ? { completedBytes: provider.preparation.completedBytes } : {}),
      ...(typeof provider.preparation?.totalBytes === "number" ? { totalBytes: provider.preparation.totalBytes } : {}),
    };
  } catch (err) {
    logger.warn(`voice: could not read DSH's speech recognition: ${String((err as Error).message ?? err).slice(0, 160)}`);
    return { state: "absent" };
  }
}

const HELPER_NAME = "clawbot-speech";
/** A failed build is not retried on every voice message. */
const BUILD_RETRY_MS = 10 * 60_000;
/** WeChat voice runs to a minute; anything far past that is not a voice message. */
const VOICE_MAX_BYTES = 20 * 1024 * 1024;
/** The message loop waits on a voice message this long for its audio, and this long for its text, at most. */
const DOWNLOAD_TIMEOUT_MS = 30_000;
const TRANSCRIBE_TIMEOUT_MS = 40_000;
/**
 * Voice is decoded to 16 kHz mono, whatever it was recorded at: what speech
 * models are trained on, and the one form DSH's recognizer accepts. Both
 * decoders resample to the rate they are asked for.
 */
const PCM_SAMPLE_RATE = 16_000;
/** DSH's recognizer gets this long for one voice message. */
const HOST_TRANSCRIBE_TIMEOUT_MS = 60_000;
/**
 * WeChat's Opus voice container: this marker, one byte for the sample rate (an
 * index into OPUS_RAW_RATES), one for the channel count, one zero byte; then
 * the packets, each behind its length as a little-endian 16-bit number. A
 * length of zero stands for a packet that was lost.
 */
const OPUS_RAW_MAGIC = "#!OPUS_RAW_V1";
const OPUS_RAW_HEADER_BYTES = 16;
const OPUS_RAW_RATES = [8000, 12000, 16000, 24000, 48000] as const;
/** The most one Opus packet can be (three 1276-byte frames). */
const OPUS_MAX_PACKET_BYTES = 3828;
/** Five minutes of audio is far past any voice message. */
const VOICE_MAX_SECONDS = 300;
/** macOS 26 is Darwin 25: the first with the on-device speech models. */
const MIN_DARWIN_MAJOR = 25;

class HelperError extends Error {
  constructor(readonly reason: VoiceFailure, message: string) {
    super(message);
  }
}

function execFileP(file: string, args: readonly string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, [...args], { timeout: timeoutMs, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
      if (err === null) resolve({ stdout, stderr });
      else reject(Object.assign(err, { stdout, stderr }));
    });
  });
}

/** True for a voice item WeChat sent without its transcript. */
export function voiceLacksTranscript(item: MessageItem | undefined): boolean {
  return !!item && item.type === MessageItemType.VOICE && !item.voice_item?.text?.trim();
}

/** Whether this machine can transcribe at all (a Mac on macOS 26 or later). */
export function voicePlatformSupported(platform: string = process.platform, release: string = os.release()): boolean {
  if (platform !== "darwin") return false;
  const major = Number.parseInt(release.split(".")[0] ?? "", 10);
  return Number.isFinite(major) && major >= MIN_DARWIN_MAJOR;
}

/**
 * A transcript as a person would have typed it. The newer speech model sets
 * Chinese apart with spaces of its own ("下午 3:00提醒我 ，然后"); none belongs
 * next to a Chinese character or Chinese punctuation. Spaces between words in
 * another script are left alone.
 */
export function tidyTranscript(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/(?<=[\p{Script=Han}，。！？；：、）》」』])\s+|\s+(?=[\p{Script=Han}，。！？；：、（《「『])/gu, "")
    .trim();
}

/** 16-bit little-endian PCM (mono unless told otherwise) in a WAV container. */
export function pcmToWav(pcm: Uint8Array, sampleRate: number, channels = 1): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.byteLength, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.byteLength, 40);
  return Buffer.concat([header, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)]);
}

export type AudioKind = "silk" | "opus-raw" | "wav" | "mp3" | "m4a" | "amr" | "unknown";

/** What the downloaded bytes are, by their first bytes (the item's encode_type is not always filled in). */
export function sniffAudio(buf: Buffer): AudioKind {
  const ascii = (start: number, length: number): string => buf.subarray(start, start + length).toString("latin1");
  // Tencent's SILK starts with one 0x02 byte before the standard marker.
  if (ascii(0, 9) === "#!SILK_V3" || (buf[0] === 0x02 && ascii(1, 9) === "#!SILK_V3")) return "silk";
  if (ascii(0, OPUS_RAW_MAGIC.length) === OPUS_RAW_MAGIC) return "opus-raw";
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WAVE") return "wav";
  if (ascii(0, 5) === "#!AMR") return "amr";
  if (ascii(4, 4) === "ftyp") return "m4a";
  if (ascii(0, 3) === "ID3" || (buf.length > 1 && buf[0] === 0xff && (buf[1]! & 0xe0) === 0xe0)) return "mp3";
  return "unknown";
}

type SilkModule = { decode: (input: Uint8Array, sampleRate: number) => Promise<{ data: Uint8Array; duration: number }> };

/** silk-wasm, loaded on first use: a plugin without it still starts, and only voice goes without. */
async function loadSilk(): Promise<SilkModule> {
  const loaded = (await import("silk-wasm")) as unknown as Partial<SilkModule> & { default?: Partial<SilkModule> };
  const decode = loaded.decode ?? loaded.default?.decode;
  if (typeof decode !== "function") throw new Error("silk-wasm has no decode()");
  return { decode };
}

type OpusDecoder = { decode(packet: Buffer): Buffer; delete(): void };
type OpusCtor = new (sampleRate: number, channels?: number) => OpusDecoder;

/** opusscript (libopus compiled to WebAssembly), loaded on first use like silk-wasm. */
async function loadOpus(): Promise<OpusCtor> {
  const loaded = (await import("opusscript")) as unknown as { default?: unknown };
  const ctor = typeof loaded.default === "function" ? loaded.default : loaded;
  if (typeof ctor !== "function") throw new Error("opusscript did not load");
  return ctor as OpusCtor;
}

/**
 * WeChat's `#!OPUS_RAW_V1` voice as 16-bit PCM with the channel count its
 * header names, at `outputRate` (Opus decodes to any of its rates; default:
 * the rate the header names).
 */
export async function decodeOpusRaw(buf: Buffer, outputRate?: number): Promise<{ pcm: Buffer; sampleRate: number; channels: number }> {
  if (buf.length < OPUS_RAW_HEADER_BYTES || buf.subarray(0, OPUS_RAW_MAGIC.length).toString("latin1") !== OPUS_RAW_MAGIC) {
    throw new Error("not an OPUS_RAW_V1 file");
  }
  const recordedRate = OPUS_RAW_RATES[buf[13]!];
  const channels = buf[14]!;
  if (recordedRate === undefined || (channels !== 1 && channels !== 2) || buf[15] !== 0) {
    throw new Error(`an OPUS_RAW_V1 header this version does not know (rate ${buf[13]}, channels ${buf[14]}, then ${buf[15]})`);
  }
  const sampleRate = outputRate ?? recordedRate;
  if (!(OPUS_RAW_RATES as readonly number[]).includes(sampleRate)) throw new Error(`Opus does not decode to ${sampleRate} Hz`);
  const Opus = await loadOpus();
  const decoder = new Opus(sampleRate, channels);
  const bytesPerSecond = sampleRate * channels * 2;
  // A packet that never arrived: 20 ms of silence where it would have been.
  const lost = Buffer.alloc(bytesPerSecond / 50);
  const pieces: Buffer[] = [];
  let total = 0;
  try {
    let pos = OPUS_RAW_HEADER_BYTES;
    while (pos + 2 <= buf.length) {
      const length = buf.readUInt16LE(pos);
      pos += 2;
      if (length > OPUS_MAX_PACKET_BYTES) throw new Error(`an Opus packet of ${length} bytes`);
      if (length > buf.length - pos) {
        // Cut off mid-packet: what was decoded before it still counts.
        if (total === 0) throw new Error("the first Opus packet is cut off");
        break;
      }
      const piece = length === 0 ? lost : decoder.decode(buf.subarray(pos, pos + length));
      pos += length;
      if (piece.length === 0) throw new Error("an Opus packet decoded to nothing");
      total += piece.length;
      if (total > bytesPerSecond * VOICE_MAX_SECONDS) throw new Error(`more than ${VOICE_MAX_SECONDS} s of audio`);
      pieces.push(piece);
    }
  } finally {
    decoder.delete();
  }
  if (total === 0) throw new Error("no Opus packets in the file");
  return { pcm: Buffer.concat(pieces), sampleRate, channels };
}

/** Two interleaved 16-bit channels averaged into one. */
export function stereoToMono(pcm: Buffer): Buffer {
  const mono = Buffer.alloc(Math.floor(pcm.length / 4) * 2);
  for (let i = 0; i + 3 < pcm.length; i += 4) {
    mono.writeInt16LE(Math.round((pcm.readInt16LE(i) + pcm.readInt16LE(i + 2)) / 2), i / 2);
  }
  return mono;
}

/** True for exactly the WAV DSH's recognizer takes: a 44-byte header, PCM, mono, 16 kHz, 16-bit, lengths that add up. */
export function isCanonicalWav(buf: Buffer): boolean {
  return buf.length > 44
    && buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 16).toString("latin1") === "WAVEfmt "
    && buf.readUInt32LE(4) === buf.length - 8 && buf.readUInt32LE(16) === 16
    && buf.readUInt16LE(20) === 1 && buf.readUInt16LE(22) === 1 && buf.readUInt32LE(24) === PCM_SAMPLE_RATE
    && buf.readUInt16LE(34) === 16 && buf.subarray(36, 40).toString("latin1") === "data"
    && buf.readUInt32LE(40) === buf.length - 44;
}

/**
 * The audio as a file a speech model can open: its bytes, the extension to
 * save them under, and whether it is the canonical WAV (16 kHz, mono, 16-bit)
 * that DSH's recognizer takes. WeChat's own two formats always come out that way.
 */
export async function playableAudio(buf: Buffer): Promise<{ bytes: Buffer; ext: string; canonical: boolean }> {
  const kind = sniffAudio(buf);
  if (kind === "wav") return { bytes: buf, ext: ".wav", canonical: isCanonicalWav(buf) };
  if (kind === "mp3" || kind === "m4a" || kind === "amr") return { bytes: buf, ext: `.${kind}`, canonical: false };
  if (kind === "opus-raw") {
    const decoded = await decodeOpusRaw(buf, PCM_SAMPLE_RATE);
    const mono = decoded.channels === 2 ? stereoToMono(decoded.pcm) : decoded.pcm;
    return { bytes: pcmToWav(mono, PCM_SAMPLE_RATE), ext: ".wav", canonical: true };
  }
  if (buf.subarray(0, 6).toString("latin1") === "#!OPUS") {
    throw new Error("an Opus container this version does not know");
  }
  // SILK, or something unnamed that WeChat only ever means SILK by.
  const silk = await loadSilk();
  const decoded = await silk.decode(buf, PCM_SAMPLE_RATE);
  if (decoded.data.byteLength === 0) throw new Error("the audio decoded to nothing");
  return { bytes: pcmToWav(decoded.data, PCM_SAMPLE_RATE), ext: ".wav", canonical: true };
}

/** Builds `clawbot-speech` on first use and runs it. */
export class SpeechHelper {
  private building: Promise<void> | null = null;
  private buildFailure: { fingerprint: string; at: number; error: HelperError } | null = null;

  constructor(
    private readonly root: string = path.join(resolveStateDir(), "speech-helper"),
    private readonly source: string = fileURLToPath(new URL("../native/macos-speech/main.swift", import.meta.url)),
  ) {}

  get exePath(): string {
    return path.join(this.root, HELPER_NAME);
  }

  private fingerprint(): string {
    return createHash("sha256").update(fs.readFileSync(this.source)).digest("hex");
  }

  /** Whether the helper exists and was built from the current source. */
  isBuilt(): boolean {
    try {
      return fs.existsSync(this.exePath)
        && fs.readFileSync(path.join(this.root, "source.sha256"), "utf-8").trim() === this.fingerprint();
    } catch {
      return false;
    }
  }

  /**
   * Compile the helper when it is missing or the plugin's Swift source changed.
   * No permission hangs on this binary, so a stale one is simply replaced; when
   * the rebuild fails, the old one goes on working.
   */
  async ensureBuilt(): Promise<void> {
    while (this.building !== null) await this.building.catch(() => undefined);
    if (this.isBuilt()) return;
    let print: string;
    try {
      print = this.fingerprint();
    } catch (err) {
      throw new HelperError("build", `转写小程序的源码读不到：${String((err as Error).message ?? err).slice(0, 200)}`);
    }
    const failed = this.buildFailure;
    if (failed !== null && failed.fingerprint === print && Date.now() - failed.at < BUILD_RETRY_MS) {
      if (fs.existsSync(this.exePath)) return;
      throw failed.error;
    }
    this.building = this.build(print)
      .then(() => { this.buildFailure = null; })
      .catch((err: unknown) => {
        const error = err instanceof HelperError ? err : new HelperError("build", String((err as Error).message ?? err));
        this.buildFailure = { fingerprint: print, at: Date.now(), error };
        if (fs.existsSync(this.exePath)) {
          logger.warn(`voice: could not rebuild ${HELPER_NAME} (${error.message}); the older build stays in use`);
          return;
        }
        throw error;
      })
      .finally(() => { this.building = null; });
    return this.building;
  }

  private async build(print: string): Promise<void> {
    // Ask where the tools are before calling one: with none installed, the
    // stand-ins in /usr/bin put macOS's "install the command line tools" dialog
    // up, and nobody asked for a dialog by sending a voice message.
    let developerDir = "";
    try {
      developerDir = (await execFileP("/usr/bin/xcode-select", ["-p"], 10_000)).stdout.trim();
    } catch {
      developerDir = "";
    }
    if (developerDir === "" || !fs.existsSync(developerDir)) {
      throw new HelperError("tools", "电脑上没有 Xcode 命令行工具（终端运行 xcode-select --install 可以装）");
    }
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const staging = path.join(this.root, `.build-${process.pid}-${randomUUID().slice(0, 8)}`);
    fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
    const exe = path.join(staging, HELPER_NAME);
    logger.info(`voice: building ${HELPER_NAME} (first use, or the plugin's Swift source changed)`);
    try {
      try {
        await execFileP("/usr/bin/xcrun", ["swiftc", "-O", this.source, "-o", exe], 600_000);
      } catch (err) {
        const e = err as { code?: unknown; stderr?: unknown };
        if (e.code === "ENOENT" || /xcrun: error|no developer tools|CommandLineTools/i.test(String(e.stderr ?? ""))) {
          throw new HelperError("tools", "电脑上的 Xcode 命令行工具用不了（终端运行 xcode-select --install 重装）");
        }
        throw new HelperError("build", `转写小程序没编译成：${String(e.stderr ?? err).trim().slice(-300)}`);
      }
      fs.renameSync(exe, this.exePath);
      fs.writeFileSync(path.join(this.root, "source.sha256"), print, { mode: 0o600 });
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
    logger.info(`voice: built ${this.exePath}`);
  }

  /** Run one helper command and read its JSON answer. */
  async run(args: readonly string[], timeoutMs: number): Promise<Record<string, unknown>> {
    await this.ensureBuilt();
    let stdout = "";
    try {
      stdout = (await execFileP(this.exePath, args, timeoutMs)).stdout;
    } catch (err) {
      const e = err as { killed?: boolean; stdout?: unknown; message?: unknown };
      if (e.killed === true) throw new HelperError("failed", `转写超过 ${Math.round(timeoutMs / 1000)} 秒没出结果`);
      stdout = typeof e.stdout === "string" ? e.stdout : "";
      if (stdout.trim() === "") throw new HelperError("failed", `转写小程序没跑起来：${String(e.message ?? err).slice(0, 200)}`);
    }
    const line = stdout.trim().split("\n").pop() ?? "";
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed !== null && typeof parsed === "object") return parsed as Record<string, unknown>;
    } catch {
      // fall through
    }
    throw new HelperError("failed", "转写小程序的回答读不懂");
  }

  /** What this Mac can transcribe `language` with, without transcribing anything. */
  status(language: string): Promise<Record<string, unknown>> {
    return this.run(["status", language], 30_000);
  }

  /**
   * Have macOS download the newer speech model's pack for `language` (a few
   * hundred megabytes from Apple). Only ever on the owner's word; transcribing
   * never calls this.
   */
  install(language: string): Promise<Record<string, unknown>> {
    return this.run(["install", language], 60 * 60_000);
  }

  /** Transcribe one audio file. */
  async transcribe(file: string, language: string, timeoutMs = TRANSCRIBE_TIMEOUT_MS): Promise<VoiceOutcome> {
    const res = await this.run(["transcribe", language, file], timeoutMs);
    if (res.ok === true) {
      const text = typeof res.text === "string" ? tidyTranscript(res.text) : "";
      if (text === "") return { ok: false, reason: "empty" };
      return { ok: true, text, engine: typeof res.engine === "string" ? res.engine : "speech" };
    }
    const code = typeof res.code === "string" ? res.code : "";
    const detail = typeof res.error === "string" ? res.error.slice(0, 300) : undefined;
    if (code === "unsupported_os") return { ok: false, reason: "no-engine", detail };
    if (code === "unsupported_language" || code === "model_missing") return { ok: false, reason: "language", detail };
    return { ok: false, reason: "failed", detail };
  }
}

/** One helper for the process: a rebuilt listener keeps its build, and its memory of a failed one. */
let shared: SpeechHelper | null = null;
export function sharedSpeechHelper(): SpeechHelper {
  return (shared ??= new SpeechHelper());
}

let warmed = false;
/**
 * Compile the helper ahead of the first voice message that needs it, so that
 * message waits for a transcript and not for a compiler. Once per process, a
 * little after start, and quietly: a Mac without the tools just goes without.
 */
export function prewarmSpeechHelper(delayMs = 30_000): void {
  if (warmed || !voicePlatformSupported()) return;
  warmed = true;
  const timer = setTimeout(() => {
    const helper = sharedSpeechHelper();
    if (helper.isBuilt()) return;
    void helper.ensureBuilt().catch((err: unknown) => {
      logger.info(`voice: on-device transcription is not set up (${String((err as Error).message ?? err).slice(0, 200)})`);
    });
  }, delayMs);
  timer.unref?.();
}

export type VoiceDeps = {
  cdnBaseUrl: string;
  /** BCP 47 tag of the language people speak to the bot in. */
  language: string;
  helper: SpeechHelper;
  /** DSH's speech recognition, looked up per message: the owner can switch it on or off while DSH runs. */
  hostSpeech?: () => HostSpeech | undefined;
  /** Tests stand in for the CDN and the platform. */
  download?: (item: MessageItem) => Promise<Buffer>;
  downloadTimeoutMs?: number;
  platformSupported?: () => boolean;
};

/** One recording through DSH's recognizer. Throws when it does. */
async function transcribeWithHost(speech: HostSpeech, wav: Buffer): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`no transcript after ${HOST_TRANSCRIBE_TIMEOUT_MS / 1000} s`)), HOST_TRANSCRIBE_TIMEOUT_MS);
  try {
    const result = await speech.transcribe(speech.resolve({ audio: wav }), controller.signal);
    return typeof result?.text === "string" ? tidyTranscript(result.text) : "";
  } finally {
    clearTimeout(timer);
  }
}

async function downloadVoice(item: MessageItem, cdnBaseUrl: string): Promise<Buffer> {
  const media = item.voice_item?.media;
  if (!media) throw new Error("no media");
  return media.aes_key
    ? downloadAndDecryptBuffer(media.encrypt_query_param ?? "", media.aes_key, cdnBaseUrl, "inbound voice", media.full_url)
    : downloadPlainCdnBuffer(media.encrypt_query_param ?? "", cdnBaseUrl, "inbound voice-plain", media.full_url);
}

/**
 * Transcribe a voice item on this machine: DSH's speech recognition when it is
 * ready, else this Mac's own. Never throws. For the Mac's helper the audio is
 * written to a private temporary folder and removed afterwards; DSH's
 * recognizer takes it from memory.
 */
export async function transcribeVoiceItem(item: MessageItem, deps: VoiceDeps): Promise<VoiceOutcome> {
  let speech: HostSpeech | undefined;
  try {
    speech = deps.hostSpeech?.();
  } catch {
    speech = undefined;
  }
  const host = hostSpeechStatus(speech);
  const mac = (deps.platformSupported ?? voicePlatformSupported)();
  // Nothing here can transcribe: say so before fetching anything.
  if (host.state !== "ready" && !mac) {
    return { ok: false, reason: host.state === "absent" ? "no-engine" : "host-unprepared", host: host.state };
  }
  const media = item.voice_item?.media;
  if (!media?.encrypt_query_param && !media?.full_url) return { ok: false, reason: "no-media" };
  const started = Date.now();
  const seconds = (): string => ((Date.now() - started) / 1000).toFixed(1);

  let raw: Buffer;
  let timer: NodeJS.Timeout | undefined;
  try {
    // The CDN fetch has no time limit of its own, and the next message waits behind this one.
    raw = await Promise.race([
      (deps.download ?? ((it) => downloadVoice(it, deps.cdnBaseUrl)))(item),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no audio after ${DOWNLOAD_TIMEOUT_MS / 1000} s`)), deps.downloadTimeoutMs ?? DOWNLOAD_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    clearTimeout(timer);
    logger.warn(`voice: download failed: ${String((err as Error).message ?? err).slice(0, 200)}`);
    return { ok: false, reason: "download" };
  }
  clearTimeout(timer);
  if (raw.length === 0 || raw.length > VOICE_MAX_BYTES) {
    logger.warn(`voice: ${raw.length} bytes of audio is not a voice message`);
    return { ok: false, reason: "download" };
  }

  let audio: { bytes: Buffer; ext: string; canonical: boolean };
  try {
    audio = await playableAudio(raw);
  } catch (err) {
    // The first bytes name the format (a header, a length); they say nothing of what was said.
    logger.warn(
      `voice: could not decode ${raw.length} bytes (starts ${raw.subarray(0, 24).toString("hex")}, encode_type=${String(item.voice_item?.encode_type ?? "?")}): `
        + String((err as Error).message ?? err).slice(0, 200),
    );
    return { ok: false, reason: "decode" };
  }

  // 1. DSH's own speech recognition: the same on every platform.
  let hostFailure: string | undefined;
  if (host.state === "ready" && speech !== undefined && audio.canonical) {
    try {
      const text = await transcribeWithHost(speech, audio.bytes);
      if (text === "") {
        logger.info(`voice: WeChat sent no transcript; DSH's ${host.name} heard nothing in it (${seconds()}s)`);
        return { ok: false, reason: "empty" };
      }
      // Length only: the log is not the place for what the owner said.
      logger.info(`voice: WeChat sent no transcript; transcribed by DSH's ${host.name} (${seconds()}s) -> ${[...text].length} chars`);
      return { ok: true, text, engine: host.providerId };
    } catch (err) {
      hostFailure = String((err as Error).message ?? err).slice(0, 200);
      logger.warn(`voice: DSH's ${host.name} failed (${hostFailure})${mac ? "; trying this Mac's own" : ""}`);
    }
  }
  if (!mac) {
    return hostFailure === undefined
      ? { ok: false, reason: "no-engine", host: host.state }
      : { ok: false, reason: "failed", detail: hostFailure, host: host.state };
  }

  // 2. This Mac's on-device models.
  let dir = "";
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawbot-voice-"));
    const file = path.join(dir, `voice${audio.ext}`);
    fs.writeFileSync(file, audio.bytes, { mode: 0o600 });
    const outcome = await deps.helper.transcribe(file, deps.language);
    if (outcome.ok) {
      logger.info(`voice: WeChat sent no transcript; transcribed by this Mac (${outcome.engine}, ${deps.language}, ${seconds()}s) -> ${[...outcome.text].length} chars`);
      return outcome;
    }
    logger.warn(`voice: WeChat sent no transcript and this Mac made none (${outcome.reason}${outcome.detail ? `: ${outcome.detail}` : ""}, ${seconds()}s)`);
    return { ...outcome, host: host.state };
  } catch (err) {
    const reason: VoiceFailure = err instanceof HelperError ? err.reason : "failed";
    const detail = String((err as Error).message ?? err).slice(0, 300);
    logger.warn(`voice: WeChat sent no transcript and this Mac made none (${reason}: ${detail})`);
    return { ok: false, reason, detail, host: host.state };
  } finally {
    if (dir !== "") fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** What the bot answers to when asked to switch DSH's speech recognition on (voice-setup.ts). */
export const VOICE_SETUP_PHRASE = "打开语音输入";

/**
 * What to tell the sender when a voice message has no transcript from either
 * side. Says it is a voice message (it used to be called a video), why there
 * is no text, and what to do — above all how to get voice working: DSH's own
 * 语音输入, which the bot can switch on for the owner.
 */
export function voiceNotice(outcome: VoiceOutcome | undefined): string {
  const head = "[DSH] 这条语音微信没有附上转写的文字，";
  const typeIt = "这条麻烦先打字发给我。";
  const retry = "麻烦打字发给我，或者再发一次。";
  const how = `DSH 自带一个「语音输入」插件，打开后语音就在这台电脑上转成文字。回我「${VOICE_SETUP_PHRASE}」我来替你开，或者自己在电脑的 DSH 网页里点「插件」→「语音输入」。`;
  if (outcome === undefined || outcome.ok) return `${head}我听不了语音。${retry}`;
  switch (outcome.reason) {
    case "off":
      return `${head}我听不了语音。${retry}`;
    case "empty":
      return `${head}电脑转写也没听出内容。${retry}`;
    case "host-unprepared":
      return outcome.host === "preparing"
        ? `${head}电脑上的语音识别模型还在下载，好了我会告诉你。${typeIt}`
        : `${head}DSH 的「语音输入」开着，但语音识别模型还没下载。回我「${VOICE_SETUP_PHRASE}」我来接着下载，或者在电脑的 DSH 网页里点「插件」→「语音输入」→「下载并准备」。${typeIt}`;
    case "no-engine":
    case "tools":
    case "build":
    case "language":
      return `${head}电脑上也还没有语音识别，所以我没听到内容。${how}${typeIt}`;
    case "no-media":
    case "download":
      return `${head}语音本身也没能下载下来。${retry}`;
    case "decode":
      return `${head}电脑也没认出这条语音的格式（微信可能又换了格式）。${typeIt}`;
    default:
      return `${head}电脑这边也没转写成。${retry}`;
  }
}
