/**
 * Long-term user memory for the WeChat agent (Claude-Desktop-style memory):
 *
 * - Memory lives in ONE readable/editable Markdown file
 *   (`~/.dsh/clawbot/memory.md`), grouped into sections.
 * - The agent can APPEND new facts via the `remember_user_info` tool
 *   (registered in tool.ts); the memory text is injected into the system
 *   prompt dynamically on every turn (see prompt.ts registerMemorySection),
 *   so the agent grows familiar with the user over time — even across
 *   session resets.
 * - The file is plain Markdown the user can open, edit, or delete anytime.
 */
import fs from "node:fs";
import path from "node:path";

import { resolveStateDir } from "./ilink/storage/state-dir.js";
import { logger } from "./ilink/util/logger.js";
import { zonedDate } from "./localtime.js";

/** Sections the memory file is organized into. */
export const MEMORY_SECTIONS = ["基本档案", "偏好与习惯", "重要事实", "提醒事项"] as const;
export type MemorySection = (typeof MEMORY_SECTIONS)[number];

export const MEMORY_MAX_LINES = 500;

/** Path of the memory file: <state-dir>/memory.md. */
export function memoryFilePath(): string {
  return path.join(resolveStateDir(), "memory.md");
}

/**
 * Ensure the memory file exists; when absent (fresh install), seed it with
 * a starter template so the file is immediately visible/editable.
 */
export function ensureMemoryFile(): void {
  const p = memoryFilePath();
  try {
    if (fs.existsSync(p)) return;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, seedMemoryText(), "utf-8");
    logger.info("memory: seeded fresh memory.md");
  } catch (err) {
    logger.warn(`memory: seed failed err=${String(err)}`);
  }
}

/** The starter content for a brand-new memory file. */
function seedMemoryText(): string {
  const now = zonedDate();
  return `# 用户记忆（长期）

> 这是微信 agent 的长期记忆文件。agent 会在对话中发现新信息时自动追加条目；
> 你也可以随时手动编辑。每次对话开始时会读取本文件注入提示词。

## 基本档案
- 创建于 ${now}

## 偏好与习惯
（待发现：语言、回复风格、常用工作流等）

## 重要事实
（待发现：身份、项目、家庭、长期成立的安排等）
`;
}

/** Read the current memory text (empty string when absent/unreadable). */
export function loadMemoryText(): string {
  try {
    const p = memoryFilePath();
    if (!fs.existsSync(p)) return "";
    const raw = fs.readFileSync(p, "utf-8");
    return raw.trim();
  } catch (err) {
    logger.warn(`memory: load failed err=${String(err)}`);
    return "";
  }
}

/** Pick the section a raw section label maps to (case/format tolerant). */
function resolveSection(label: string | undefined): MemorySection {
  if (!label) return "基本档案";
  const norm = label.trim();
  for (const s of MEMORY_SECTIONS) {
    if (s === norm) return s;
  }
  const lower = norm.toLowerCase();
  if (lower.includes("偏好") || lower.includes("习惯") || lower.includes("prefer")) return "偏好与习惯";
  if (lower.includes("事实") || lower.includes("fact") || lower.includes("档案") || lower.includes("profile")) return "基本档案";
  if (lower.includes("提醒") || lower.includes("remind")) return "提醒事项";
  return "基本档案";
}

/**
 * Words that make a memory entry go stale by tomorrow. memory.md is read into
 * EVERY system prompt, so "明天十点开会" is actively wrong the next day and
 * misleads the model's date math.
 */
export const STALE_BY_TOMORROW = /(?:今天|明天|后天|今晚|今早|明早|明晚|这周|下周|刚才|待会|等会|分钟后|小时后)/;

/**
 * Why an entry must NOT go into long-term memory, or null when it may.
 *
 * One-off reminders belong to schedule_create. This is the single write
 * chokepoint for both writers — the auto-memory classifier and the model's own
 * remember_user_info — because each broke the rule on its own: measured
 * 2026-09-23, the classifier filed 16 one-off reminders and the tool 2, the
 * tool because its own description invited "reminders for later".
 */
export function oneOffReminderReason(section: string | undefined, content: string): string | null {
  if (resolveSection(section) === "提醒事项") {
    return "一次性提醒不进长期记忆:请用 schedule_create 设定时提醒。长期记忆只收一个月后仍成立的事实。";
  }
  if (STALE_BY_TOMORROW.test(content)) {
    return "这条带「今天/明天/几分钟后」这类相对时间,明天就过期了,不进长期记忆。要到点提醒就用 schedule_create;要记的是长期事实就去掉时间重写一句。";
  }
  return null;
}

/**
 * Append one memory entry to a section (creating the section when missing).
 * Entries are bullet lines; duplicates (same text already present anywhere)
 * are skipped so the file does not grow unboundedly from repeated facts.
 * Returns whether the file changed.
 */
export function appendMemoryEntry(section: string, content: string): boolean {
  const text = content.trim();
  if (!text) return false;
  const refused = oneOffReminderReason(section, text);
  if (refused !== null) {
    logger.info(`memory: refused one-off entry section=${section} content=${text}`);
    return false;
  }
  const p = memoryFilePath();
  ensureMemoryFile();
  let body: string;
  try {
    body = fs.readFileSync(p, "utf-8");
  } catch {
    body = "";
  }
  // Dedupe: ignore if the exact content already appears on any bullet line
  // (entries carry a "[date] " prefix, so strip bullet + date before compare).
  const existing = new Set(
    body
      .split("\n")
      .map((l) => l.replace(/^[-*]\s*/, "").replace(/^\[\d{4}-\d{2}-\d{2}\]\s*/, "").trim())
      .filter(Boolean),
  );
  if (existing.has(text)) return false;

  const target = resolveSection(section);
  const now = zonedDate();
  const entry = `- [${now}] ${text}`;
  const lines = body.length ? body.split("\n") : seedMemoryText().split("\n");

  // Find the target heading; insert the entry right after the heading.
  let inserted = false;
  const out: string[] = [];
  for (const line of lines) {
    out.push(line);
    if (!inserted && line.trim().startsWith("## ") && line.includes(target)) {
      out.push(entry);
      inserted = true;
    }
  }
  if (!inserted) {
    // Section missing → append at the end.
    if (out.length && out[out.length - 1].trim() !== "") out.push("");
    out.push(`## ${target}`, entry);
  }

  // Cap total lines: keep the head (sections/older context) and newest tail.
  let final = out;
  if (out.length > MEMORY_MAX_LINES) {
    final = out.slice(0, Math.floor(MEMORY_MAX_LINES * 0.7)).concat(out.slice(-Math.floor(MEMORY_MAX_LINES * 0.3)));
  }
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, final.join("\n") + "\n", "utf-8");
    fs.renameSync(tmp, p);
    logger.info(`memory: appended entry to "${target}"`);
    return true;
  } catch (err) {
    logger.warn(`memory: append failed err=${String(err)}`);
    return false;
  }
}

/** Human-readable summary of the memory file state (for logs/tests). */
export function memoryStats(): { lines: number; sections: string[] } {
  const text = loadMemoryText();
  const sections = text
    .split("\n")
    .filter((l) => l.trim().startsWith("## "))
    .map((l) => l.trim().replace(/^##\s*/, ""));
  return { lines: text ? text.split("\n").length : 0, sections };
}
