/**
 * The settings card's 电脑权限 row: which program the system holds the bot's
 * file access against, whether that program has it, and two buttons that take
 * the owner to where it is given.
 *
 * macOS does not judge DSH by itself. Every process DSH starts — the bot's
 * shell commands too — is checked against DSH's "responsible" process: the
 * app that started it (Terminal, iTerm, VS Code …, DSH Desktop, the menu-bar
 * whale), or DSH's own node when nothing above it takes that role (node run
 * by launchd as a job, or started through a helper that disclaims it). Without
 * Full Disk Access the system asks about each protected folder in turn
 * (Downloads, Desktop, Documents, the Photos library …) with a dialog on the
 * Mac's screen, and the command waits for a click — with nobody at the Mac,
 * until it times out. Full Disk Access for that one program answers them all.
 * No program can give itself that access or ask for it in a dialog; the most
 * it can do is open the pane and show the program in Finder, so the owner can
 * drag it in. Those are the two buttons.
 *
 * Windows has nothing like it for desktop programs: DSH reads whatever the user
 * can. What can get in the way there is Controlled folder access (ransomware
 * protection, off unless turned on), which stops programs it does not trust
 * from creating or changing files in Documents, Pictures …
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";

import type { Context } from "@deepseek-ai/cordis";

import { logger } from "./ilink/util/logger.js";
import { cardRequestAllowed, localRequest } from "./secretary.js";

export const PERMISSIONS_PATH = "/plugins/clawbot/permissions";
export const PERMISSIONS_SETTINGS_PATH = "/plugins/clawbot/permissions/open-settings";
export const PERMISSIONS_REVEAL_PATH = "/plugins/clawbot/permissions/reveal";

// ------------------------------------------------------------------ programs

export type RunResult = { code: number; stdout: string; stderr: string };
/** Runs a program with an argument list (never a shell), in DSH's environment unless given one. A program that could not start answers code -1. */
export type Runner = (cmd: string, args: string[], timeoutMs?: number, env?: NodeJS.ProcessEnv) => Promise<RunResult>;

export const runProgram: Runner = (cmd, args, timeoutMs = 5000, env) =>
  new Promise((resolve) => {
    try {
      const child = execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true, ...(env !== undefined ? { env } : {}) }, (err, stdout, stderr) => {
        const code = err === null ? 0 : typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : -1;
        resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      });
      // Nothing is ever written to it, and an open stdin can keep a program (Windows PowerShell) waiting for more.
      child.stdin?.end();
    } catch (err) {
      // execFile throws instead of calling back for some bad arguments.
      resolve({ code: -1, stdout: "", stderr: String(err) });
    }
  });

/** DSH's own program, the way the system names it (symlinks resolved: Homebrew's bin/node is a link into its Cellar). */
export function ownProgram(): string {
  try {
    return fs.realpathSync(process.execPath);
  } catch {
    return process.execPath;
  }
}

// ----------------------------------------------------------- who started DSH

export type Found =
  | { kind: "app"; path: string }
  | { kind: "program"; path: string }
  | { kind: "unknown"; reason: string };

/** The app a program belongs to: the OUTERMOST bundle, so an app's helpers (Code Helper.app …) count as the app. */
export function appBundleOf(program: string): string | undefined {
  const at = program.indexOf(".app/");
  if (at > 0) return program.slice(0, at + 4);
  return program.endsWith(".app") ? program : undefined;
}

/**
 * Asks macOS itself. The kernel keeps a responsible process for every process,
 * and the privacy checks go by it; libquarantine reads it out without any
 * privileges: responsibility_get_responsible_for_pid(pid, &rpid, &uniqueid,
 * &len, path). The path stays once that process has exited — rpid then reads
 * as the process itself, and the system still holds the access to what the
 * path names. Node cannot call C, so the system's own Ruby does it through
 * Fiddle: /usr/bin/ruby is the real interpreter, not a stub that would offer to
 * install the Command Line Tools (/usr/bin/python3 is one).
 *
 * The call writes the whole path whatever len says (only 0 is refused —
 * measured on macOS 27), so the buffer has to stay at least MAXPATHLEN (1024);
 * 4096 is the most a process path can be.
 */
const RESPONSIBLE_RB = [
  `f = Fiddle::Function.new(Fiddle::Handle::DEFAULT["responsibility_get_responsible_for_pid"],`,
  `  [Fiddle::TYPE_INT, Fiddle::TYPE_VOIDP, Fiddle::TYPE_VOIDP, Fiddle::TYPE_VOIDP, Fiddle::TYPE_VOIDP], Fiddle::TYPE_INT)`,
  `rpid = Fiddle::Pointer.malloc(8); uid = Fiddle::Pointer.malloc(8); len = Fiddle::Pointer.malloc(8); path = Fiddle::Pointer.malloc(4096)`,
  `rpid[0, 8] = "\\0" * 8; uid[0, 8] = "\\0" * 8; len[0, 8] = [4096].pack("Q"); path[0, 4096] = "\\0" * 4096`,
  `exit 2 unless f.call(Integer(ARGV[0]), rpid, uid, len, path) == 0`,
  `print rpid[0, 4].unpack1("l"), "\\t", path.to_s`,
].join("\n");

/** What the Ruby above prints: `<responsible pid>\t<its program>`. */
export function parseResponsible(out: string): { pid: number; path: string } | undefined {
  const m = /^(\d+)\t(\/[^\0]*)$/.exec(out);
  return m && Number(m[1]) > 0 ? { pid: Number(m[1]), path: m[2] } : undefined;
}

/**
 * DSH's environment without the owner's Ruby settings. A shell set up for a
 * newer Ruby hands DSH options the system's Ruby 2.6 refuses to start with
 * (RUBYOPT=-W:no-deprecated, --yjit) or that print ahead of the answer (-v),
 * and RUBYLIB can put another fiddle in front of the system's.
 */
export function rubyEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean = { ...env };
  delete clean.RUBYOPT;
  delete clean.RUBYLIB;
  return clean;
}

/** `why` hears what went wrong when there is no answer: the reason the walk is used instead. */
export async function askResponsible(run: Runner, self: number, why?: (reason: string) => void): Promise<{ pid: number; path: string } | undefined> {
  const r = await run("/usr/bin/ruby", ["--disable=gems,rubyopt", "-rfiddle", "-e", RESPONSIBLE_RB, String(self)], 5000, rubyEnvironment());
  const answer = r.code === 0 ? parseResponsible(r.stdout) : undefined;
  if (answer === undefined) {
    const said = (r.code === 0 ? r.stdout : r.stderr).trim().split("\n")[0].slice(0, 160);
    why?.(`${r.code === 0 ? "unexpected answer" : `exit ${r.code}`}${said !== "" ? `: ${said}` : ""}`);
  }
  return answer;
}

/** The system's answer as the card names it: the app whose program it is, or the program itself. */
export function fromResponsible(program: string): Found {
  const app = appBundleOf(program);
  return app !== undefined ? { kind: "app", path: app } : { kind: "program", path: program };
}

// The fallback, for when the system cannot be asked: walk up the process tree.

export type Proc = { pid: number; ppid: number; command: string };

/** `ps -axo pid=,ppid=,comm=`. On macOS `comm` is argv[0] — usually the full path (spaces and all), a bare `node` when run through `#!/usr/bin/env node`. */
export function parseProcessTable(text: string): Map<number, Proc> {
  const table = new Map<number, Proc>();
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (m) table.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), command: m[3] });
  }
  return table;
}

/** PIDs launchd runs as this user's jobs (`launchctl list`): LaunchAgents, and each app LaunchServices opened. */
export function parseLaunchdJobs(text: string): Set<number> {
  const pids = new Set<number>();
  for (const line of text.split("\n")) {
    const m = /^(\d+)\s/.exec(line);
    if (m) pids.add(Number(m[1]));
  }
  return pids;
}

/** The system's own programs, which hand nothing down: node under a `zsh -c` job is its own (measured on macOS 27). */
const SYSTEM_PROGRAM = /^\/(?:bin|sbin|usr\/bin|usr\/sbin|usr\/libexec|System)\//;

/**
 * Walk up from DSH to what started it, when the system could not be asked.
 * Right for the usual cases, a guess for the rest — the system's answer is
 * the one to trust (askResponsible).
 *
 * The first app on the way up (Terminal above the shell above `dsh web`, DSH
 * Desktop above its host) is taken for it; DSH's own program is not looked at
 * — node run from inside some app's bundle, typed into Terminal, is still
 * Terminal's. Reaching launchd without an app: a launchd job running DSH (or a
 * shell that runs DSH) leaves the access with DSH's own program; anything else
 * cannot be told from here (tmux, screen, SSH, a restarted DSH, a starter that
 * has exited).
 */
export function findLauncher(table: Map<number, Proc>, self: number, jobs: Set<number>, own: string = ownProgram()): Found {
  const seen = new Set<number>();
  let pid = self;
  for (;;) {
    const proc = table.get(pid);
    if (proc === undefined || seen.has(pid)) return { kind: "unknown", reason: "进程表里找不到 DSH 的上级" };
    seen.add(pid);
    if (pid !== self) {
      const app = appBundleOf(proc.command);
      if (app !== undefined) return { kind: "app", path: app };
    }
    if (proc.ppid <= 1) {
      if (!jobs.has(pid)) {
        return { kind: "unknown", reason: "往上找不到 App，也不是 launchd 直接运行的：可能在 tmux、screen 或 SSH 里，DSH 重启过，或启动它的程序已经退出" };
      }
      // argv[0] is no path to go by for a program run through `#!/usr/bin/env node`.
      if (pid === self || SYSTEM_PROGRAM.test(proc.command)) return { kind: "program", path: own };
      return proc.command.startsWith("/")
        ? { kind: "program", path: proc.command }
        : { kind: "unknown", reason: `launchd 运行的「${proc.command}」找不到完整路径` };
    }
    pid = proc.ppid;
  }
}

export type Signing = "apple" | "developer" | "local" | "adhoc" | "unsigned" | "unknown";

/**
 * Who signed a program, from what `codesign -dv --verbose=2` prints (on
 * stderr). What matters is whether the system will know the next version as
 * the same program: ad-hoc and unsigned ones are known by their exact bytes,
 * so every update loses the access.
 */
export function parseSigning(text: string): Signing {
  if (/code object is not signed/i.test(text)) return "unsigned";
  if (/^Signature=adhoc$/im.test(text)) return "adhoc";
  // The system's own programs (macOS 27 calls the authority "macOS Software Signing"), and the App Store's.
  if (/^Platform identifier=/m.test(text) || /^Authority=(macOS Software Signing|Software Signing|Apple Mac OS Application Signing)$/m.test(text)) {
    return "apple";
  }
  if (/^Authority=(Developer ID Application|Apple Development|Apple Distribution|Mac Developer|3rd Party Mac Developer Application):/m.test(text)) {
    return "developer";
  }
  if (/^Authority=/m.test(text)) return "local";
  return "unknown";
}

/** "system": macOS said so; "walk": read off the process tree (see findLauncher). */
export type Via = "system" | "walk";

export type LauncherInfo =
  /**
   * `name`: the app's own name. `localName`: the one System Settings shows in Chinese, when it differs (终端 for
   * Terminal). `file`: the bundle as Finder lists it (DSHWhale.app for 「DSH小鲸鱼」). `dsh`: the app exists to run DSH.
   */
  | { kind: "app"; path: string; name: string; localName?: string; file: string; bundleId?: string; signing: Signing; dsh: boolean; via: Via }
  /** `own`: it is DSH's own program (node run by launchd, or started by something that disclaims it). */
  | { kind: "program"; path: string; name: string; signing: Signing; own: boolean; via: Via }
  | { kind: "unknown"; reason: string };

async function plistValue(file: string, key: string, run: Runner): Promise<string | undefined> {
  const r = await run("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", file]);
  const value = r.stdout.trim();
  return r.code === 0 && value !== "" ? value : undefined;
}

async function plistJson(file: string, run: Runner): Promise<Record<string, unknown> | undefined> {
  if (!fs.existsSync(file)) return undefined;
  const r = await run("/usr/bin/plutil", ["-convert", "json", "-o", "-", file]);
  if (r.code !== 0) return undefined;
  try {
    const value: unknown = JSON.parse(r.stdout);
    return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const CHINESE = ["zh_CN", "zh-Hans", "zh_Hans", "zh-CN", "zh"];

/** The app's Chinese name, from its localization table (newer system apps) or its lproj strings. */
async function chineseName(app: string, run: Runner): Promise<string | undefined> {
  const resources = path.join(app, "Contents/Resources");
  const pick = (table: Record<string, unknown> | undefined): string | undefined => {
    const name = table?.CFBundleDisplayName ?? table?.CFBundleName;
    return typeof name === "string" && name.trim() !== "" ? name.trim() : undefined;
  };
  const loctable = await plistJson(path.join(resources, "InfoPlist.loctable"), run);
  for (const lang of CHINESE) {
    const name = pick(loctable?.[lang] as Record<string, unknown> | undefined);
    if (name !== undefined) return name;
  }
  for (const lang of CHINESE) {
    const name = pick(await plistJson(path.join(resources, `${lang}.lproj/InfoPlist.strings`), run));
    if (name !== undefined) return name;
  }
  return undefined;
}

/**
 * Folders whose files only open once the owner allows it in a dialog, the way
 * the system's own folder checks go (see fullDiskProbes): Desktop, Documents,
 * Downloads, iCloud Drive, the Photos library under Pictures, and other disks.
 */
export function inGuardedFolder(file: string, home: string = os.homedir()): boolean {
  const guarded = ["Desktop", "Documents", "Downloads", "Library/Mobile Documents", "Pictures"].map((dir) => path.join(home, dir));
  return [...guarded, "/Volumes"].some((dir) => file === dir || file.startsWith(`${dir}/`));
}

export async function describeLauncher(found: Found, run: Runner, via: Via = "walk", own: string = ownProgram()): Promise<LauncherInfo> {
  if (found.kind === "unknown") return found;
  // A starter kept in one of those (an app built in a Documents folder, run from Downloads) is named by its
  // file name: reading it could put a dialog on the Mac's screen as DSH starts, with nobody there.
  if (inGuardedFolder(found.path)) {
    const file = path.basename(found.path);
    return found.kind === "app"
      ? { kind: "app", path: found.path, name: path.basename(file, ".app"), file, signing: "unknown", dsh: /DSHWhale|DeepSeek Harness/i.test(file), via }
      : { kind: "program", path: found.path, name: file, signing: "unknown", own: found.path === own, via };
  }
  if (found.kind === "program") {
    let real = found.path;
    try {
      real = fs.realpathSync(found.path);
    } catch { /* keep what was found */ }
    const signing = parseSigning((await run("/usr/bin/codesign", ["-dv", "--verbose=2", real])).stderr);
    return { kind: "program", path: real, name: path.basename(real), signing, own: real === own, via };
  }
  const plist = path.join(found.path, "Contents/Info.plist");
  const bundleId = await plistValue(plist, "CFBundleIdentifier", run);
  const name = (await plistValue(plist, "CFBundleDisplayName", run))
    ?? (await plistValue(plist, "CFBundleName", run))
    ?? path.basename(found.path, ".app");
  const localName = await chineseName(found.path, run);
  const signing = parseSigning((await run("/usr/bin/codesign", ["-dv", "--verbose=2", found.path])).stderr);
  const dsh = /dsh-whale|deepseek/i.test(bundleId ?? "") || /DeepSeek Harness|DSHWhale/i.test(name);
  return {
    kind: "app", path: found.path, name,
    ...(localName !== undefined && localName !== name ? { localName } : {}),
    file: path.basename(found.path),
    ...(bundleId !== undefined ? { bundleId } : {}),
    signing, dsh, via,
  };
}

/** `toldWhy`: the log already says why the system could not be asked (once per DSH process). */
type LauncherSlot = { pid: number; info?: LauncherInfo; pending?: Promise<LauncherInfo>; toldWhy?: boolean };
const LAUNCHER = Symbol.for("clawbot.permissions.launcher");
const slots = globalThis as unknown as Record<symbol, LauncherSlot | undefined>;

/**
 * Who DSH's access is held against. Asked of the system first; read off the
 * process tree when that fails. Found once per DSH process and kept on
 * globalThis, so the plugin's in-place reloads keep it too: the system's
 * answer cannot change while the process lives. The walk can lose its answer
 * (quit and reopen the whale and DSH carries on under launchd, its starter no
 * longer above it), so the plugin also asks as it starts, and asks again only
 * while the answer is unknown.
 */
export function detectLauncher(run: Runner = runProgram, self: number = process.pid): Promise<LauncherInfo> {
  let slot = slots[LAUNCHER];
  if (slot === undefined || slot.pid !== self) slot = slots[LAUNCHER] = { pid: self };
  if (slot.info !== undefined && slot.info.kind !== "unknown") return Promise.resolve(slot.info);
  if (slot.pending !== undefined) return slot.pending;
  const current = slot;
  current.pending = (async () => {
    try {
      const responsible = await askResponsible(run, self, (reason) => {
        if (current.toldWhy === true) return;
        current.toldWhy = true;
        logger.info(`permissions: could not ask macOS who DSH's file access is held against (${reason}); reading the process tree instead`);
      });
      let info: LauncherInfo;
      if (responsible !== undefined) {
        info = await describeLauncher(fromResponsible(responsible.path), run, "system");
      } else {
        const [ps, jobs] = await Promise.all([
          // In a UTF-8 locale: in the C locale ps prints a non-ASCII path (a renamed app, a Chinese folder) as escapes.
          run("/usr/bin/env", ["LC_ALL=en_US.UTF-8", "/bin/ps", "-axo", "pid=,ppid=,comm="]),
          run("/bin/launchctl", ["list"]),
        ]);
        info = await describeLauncher(findLauncher(parseProcessTable(ps.stdout), self, parseLaunchdJobs(jobs.stdout)), run, "walk");
      }
      current.info = info;
      return info;
    } finally {
      current.pending = undefined;
    }
  })();
  return current.pending;
}

// ------------------------------------------------------------ Full Disk Access

export type Access = "granted" | "denied" | "unknown";

/**
 * Folders only Full Disk Access opens, none of which ever brings up a dialog:
 * without the access they answer "Operation not permitted" and that is all.
 * (Downloads, Desktop, Documents and the Photos library are the opposite —
 * touching one is what puts the dialog on screen — so they are never probed.)
 * The first that answers decides. The system TCC folder is there on every
 * macOS with Full Disk Access (10.14 on); the rest are spares.
 */
export function fullDiskProbes(home: string = os.homedir()): string[] {
  return [
    "/Library/Application Support/com.apple.TCC",
    path.join(home, "Library/Safari"),
    path.join(home, "Library/Mail"),
    path.join(home, "Library/Messages"),
  ];
}

/** Through a new process DSH starts — the way the bot's commands reach files. */
export async function probeFullDisk(run: Runner = runProgram, dirs: string[] = fullDiskProbes()): Promise<Access> {
  for (const dir of dirs) {
    const r = await run("/bin/ls", [dir]);
    if (r.code === 0) return "granted";
    if (/operation not permitted/i.test(r.stderr)) return "denied";
  }
  return "unknown";
}

/** In DSH's own process — the way its file tools (read, glob, grep) reach files. EPERM is the system's refusal; EACCES is only file modes. */
export function probeFullDiskHere(dirs: string[] = fullDiskProbes()): Access {
  for (const dir of dirs) {
    try {
      fs.readdirSync(dir);
      return "granted";
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EPERM") return "denied";
    }
  }
  return "unknown";
}

/** The page of System Settings with the Full Disk Access list. System Settings (macOS 13, Darwin 22) names it by its extension. */
export function fullDiskSettingsUrl(release: string = os.release()): string {
  return Number(release.split(".")[0]) >= 22
    ? "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles"
    : "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles";
}

// --------------------------------------------------- Windows: Controlled folder access

export type FolderGuard = "on" | "off" | "audit" | "unknown";

/**
 * `(Get-MpPreference).EnableControlledFolderAccess`: 1 blocks writes into the
 * protected folders, 2 only records them; 3 and 4 are about raw disk sectors,
 * not folders.
 */
export function parseFolderGuard(out: string): FolderGuard {
  const value = out.trim().toLowerCase();
  if (value === "1" || value === "enabled") return "on";
  if (value === "2" || value === "auditmode") return "audit";
  if (["0", "3", "4", "disabled", "blockdiskmodificationonly", "auditdiskmodificationonly"].includes(value)) return "off";
  return "unknown";
}

/** By full path: a bare name is looked for in DSH's working folder first. */
function windowsProgram(...parts: string[]): string {
  return path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", ...parts);
}

/**
 * The setting, and whether Microsoft Defender enforces it: Controlled folder
 * access works only while Defender is the active antivirus (running mode
 * Normal) with real-time protection on. Another antivirus switches Defender
 * off, and the setting keeps reading 1. One line each, `key=value`, so a stray
 * warning line changes nothing.
 */
const FOLDER_GUARD_PS = "$p = Get-MpPreference; $s = $null; try { $s = Get-MpComputerStatus -ErrorAction Stop } catch {}; "
  + "\"cfa=$($p.EnableControlledFolderAccess)\"; \"mode=$($s.AMRunningMode)\"; \"rtp=$($s.RealTimeProtectionEnabled)\"";

export function parseDefender(out: string): FolderGuard {
  const value = (key: string): string => {
    const m = new RegExp(`^${key}=(.*)$`, "m").exec(out.replace(/\r/g, ""));
    return m ? m[1].trim() : "";
  };
  const guard = parseFolderGuard(value("cfa"));
  if (guard !== "on" && guard !== "audit") return guard;
  // Not answered (Get-MpComputerStatus failed): the setting is all there is to go by.
  const mode = value("mode");
  const rtp = value("rtp");
  if ((mode !== "" && mode.toLowerCase() !== "normal") || rtp.toLowerCase() === "false") return "off";
  return guard;
}

let folderGuard: { at: number; value: FolderGuard } | undefined;
let folderGuardPending: Promise<FolderGuard> | undefined;

/** Asked of Windows Security at most every five minutes, one PowerShell at a time: it takes a second or two to start. */
export function readFolderGuard(run: Runner = runProgram, now: number = Date.now()): Promise<FolderGuard> {
  if (folderGuard !== undefined && now - folderGuard.at < 300_000) return Promise.resolve(folderGuard.value);
  if (folderGuardPending !== undefined) return folderGuardPending;
  folderGuardPending = (async () => {
    try {
      const r = await run(windowsProgram("WindowsPowerShell", "v1.0", "powershell.exe"), [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", FOLDER_GUARD_PS,
      ], 20_000);
      const value = r.code === 0 ? parseDefender(r.stdout) : "unknown";
      folderGuard = { at: now, value };
      return value;
    } finally {
      folderGuardPending = undefined;
    }
  })();
  return folderGuardPending;
}

/** For tests: forget who started DSH and what Windows Security said. */
export function resetPermissionCaches(): void {
  slots[LAUNCHER] = undefined;
  folderGuard = undefined;
  folderGuardPending = undefined;
}

// ---------------------------------------------------------------- routes

let lastAccess: Access | undefined;

export async function permissionStatus(run: Runner = runProgram, platform: NodeJS.Platform = process.platform): Promise<Record<string, unknown>> {
  if (platform === "darwin") {
    const [launcher, fullDisk] = await Promise.all([detectLauncher(run), probeFullDisk(run)]);
    if (fullDisk !== lastAccess) {
      lastAccess = fullDisk;
      const who = launcher.kind === "unknown" ? `starter unknown: ${launcher.reason}` : `${launcher.path}, ${launcher.via === "system" ? "asked macOS" : "from the process tree"}`;
      logger.info(`permissions: full disk access ${fullDisk} (${who})`);
    }
    // `own`: what to add when the starter is unknown and DSH may hold the access itself.
    return { ok: true, platform, launcher, fullDisk, fullDiskHere: probeFullDiskHere(), own: ownProgram() };
  }
  if (platform === "win32") {
    return { ok: true, platform, folderGuard: await readFolderGuard(run), program: process.execPath };
  }
  return { ok: true, platform };
}

function reply(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

/** GET /plugins/clawbot/permissions — this machine's page only: it names programs and paths. */
export async function handlePermissionStatus(
  req: IncomingMessage, res: ServerResponse, run: Runner = runProgram, platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if ((req.method ?? "GET") !== "GET") return reply(res, 405, { ok: false, message: "use GET" });
  // Which system DSH runs on is all a page elsewhere hears: enough to leave out a row that computer does not have.
  if (!localRequest(req)) return reply(res, 403, { ok: false, message: "只接受本机设置卡片的请求", platform });
  try {
    reply(res, 200, await permissionStatus(run, platform));
  } catch (err) {
    reply(res, 500, { ok: false, message: String(err).slice(0, 200) });
  }
}

/**
 * POST …/open-settings and …/reveal — the card's buttons. They open things on
 * the computer DSH runs on, for the card's own request only
 * (cardRequestAllowed). What is shown in Finder is what this process found by
 * itself, never a path from the request.
 */
export async function handlePermissionAction(
  what: "settings" | "reveal",
  req: IncomingMessage, res: ServerResponse, run: Runner = runProgram, platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if ((req.method ?? "GET") !== "POST") return reply(res, 405, { ok: false, message: "use POST" });
  if (!cardRequestAllowed(req)) return reply(res, 403, { ok: false, message: "只接受设置卡片发来的请求" });
  try {
    let cmd: string;
    let args: string[];
    if (platform === "darwin" && what === "settings") {
      cmd = "/usr/bin/open";
      args = [fullDiskSettingsUrl()];
    } else if (platform === "darwin") {
      const launcher = await detectLauncher(run);
      if (launcher.kind === "unknown") {
        return reply(res, 409, { ok: false, message: `没认出是哪个程序启动了 DSH（${launcher.reason}）` });
      }
      cmd = "/usr/bin/open";
      args = ["-R", launcher.path];
    } else if (platform === "win32" && what === "settings") {
      // Windows Security's 勒索软件防护 page, where the allowed apps are. /d: no AutoRun from the registry.
      cmd = process.env.ComSpec || windowsProgram("cmd.exe");
      args = ["/d", "/c", "start", "", "windowsdefender://ransomwareprotection/"];
    } else {
      return reply(res, 404, { ok: false, message: "这台电脑上没有要打开的" });
    }
    const r = await run(cmd, args, 10_000);
    if (r.code !== 0) {
      return reply(res, 500, { ok: false, message: `没打开：${(r.stderr.trim() || `exit ${r.code}`).slice(0, 160)}` });
    }
    logger.info(`permissions: ${what === "settings" ? "opened the settings page" : "showed DSH's starter in Finder"} (settings card)`);
    reply(res, 200, { ok: true });
  } catch (err) {
    reply(res, 500, { ok: false, message: `没打开：${String(err).slice(0, 160)}` });
  }
}

type WebServerLike = {
  register: (route: {
    kind: "exact";
    path: string;
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
  }) => () => void;
};

export function registerPermissionRoutes(ctx: Context): void {
  ctx.inject(["webServer"], (scoped) => {
    const server = (scoped as unknown as { webServer: WebServerLike }).webServer;
    scoped.effect(
      () => server.register({ kind: "exact", path: PERMISSIONS_PATH, handler: (req, res) => handlePermissionStatus(req, res) }),
      "clawbot: permissions status route",
    );
    scoped.effect(
      () => server.register({ kind: "exact", path: PERMISSIONS_SETTINGS_PATH, handler: (req, res) => handlePermissionAction("settings", req, res) }),
      "clawbot: permissions settings route",
    );
    scoped.effect(
      () => server.register({ kind: "exact", path: PERMISSIONS_REVEAL_PATH, handler: (req, res) => handlePermissionAction("reveal", req, res) }),
      "clawbot: permissions reveal route",
    );
  });
  // Now, while whatever started DSH is still running above it, should the system not answer (see detectLauncher).
  if (process.platform === "darwin") {
    void detectLauncher()
      .then((info) => logger.info(`permissions: DSH's file access is held against ${info.kind === "unknown" ? `(unknown: ${info.reason})` : `${info.path} (${info.via === "system" ? "asked macOS" : "from the process tree"})`}`))
      .catch((err) => logger.warn(`permissions: could not tell who started DSH: ${String(err).slice(0, 200)}`));
  }
}
