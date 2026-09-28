/**
 * Automatic memory extraction with a hybrid strategy:
 *   1. Cheap regex pre-filter: flag messages that MIGHT contain durable user
 *      facts (identity / preference / habit / reminder). Conservative: the
 *      regex only decides "worth a closer look", never writes directly.
 *   2. LLM confirmation: flagged messages go to **the same model the bot is
 *      already talking to** (injected as a `MemoryJudge` by the bridge, which
 *      builds it from the host `llm` service and the session's own route).
 *      The model decides whether it's a durable fact, rewrites it as a clean
 *      one-liner, and picks the section.
 *
 *      This used to be hardcoded to `api.deepseek.com`. That made the
 *      classifier a **second data destination**: the moment the bot moved to
 *      another provider, the most personal-looking snippets of a WeChat chat
 *      were still being shipped to DeepSeek while the conversation itself went
 *      elsewhere. Following the route removes that split — auto-memory now
 *      sends nothing anywhere the conversation isn't already going.
 *
 *      No judge (host `llm` absent, or the route unresolved) means **skip**,
 *      never "fall back to some other vendor".
 *
 * This replaces the old pure-regex capture: the regex was brittle
 * ("我在想…" false positives, "我喜欢这个颜色" dropped by task hints) and
 * duplicated what the model's remember_user_info tool already records.
 *
 * The LLM call is fire-and-forget from the caller's perspective (the bridge
 * already invokes captureTurnMemory asynchronously).
 */
import { appendMemoryEntry, STALE_BY_TOMORROW } from "./memory.js";
import { logger } from "./ilink/util/logger.js";

/** Section names the LLM may choose. */
/**
 * Sections the classifier may choose. There is deliberately NO "提醒事项":
 * one-off reminders belong to schedule_create, and memory.md is read into
 * EVERY system prompt — a stored "明天十点开会" is wrong the next day and
 * misleads the model's date math. The bot's own memory rules already say so
 * ("一次性的提醒和约定… 那是 schedule_create 的事"); this classifier used to
 * contradict them. Measured 2026-09-23: 16 of its 18 lifetime captures were
 * exactly such one-off reminders.
 */
const SECTIONS = ["基本档案", "偏好与习惯", "重要事实"] as const;

/** Pick the memory section for a captured fact (regex fallback). */
function pickSection(text: string): string {
  const map: Array<{ section: string; keywords: string[] }> = [
    { section: "偏好与习惯", keywords: ["喜欢", "偏好", "习惯", "不喜欢", "不要", "希望", "每次", "以后"] },
    { section: "基本档案", keywords: ["我是", "我在", "我读", "我学", "我从事", "我的名字", "我叫", "身份", "职业", "专业", "学校"] },
  ];
  for (const { section, keywords } of map) {
    if (keywords.some((k) => text.includes(k))) return section;
  }
  return "重要事实";
}

/**
 * A specific, one-off occasion: a relative day, or a clock time / countdown.
 * Recurring markers (每天 / 每周三) are deliberately absent — "每周三下午有组会"
 * is a durable fact.
 */
const ONE_OFF_TIME =
  /(?:今天|明天|后天|今晚|今早|明早|明晚|这周[一二三四五六日天]|下周[一二三四五六日天]?|\d+\s*[点:：]\d*|[一二三四五六七八九十两]+点|\d+\s*(?:分钟|小时)后|[一二三四五六七八九十两半]+(?:分钟|小时)后)/;

/**
 * Cheap pre-filter. Returns true when the message MIGHT contain a durable
 * user fact. Deliberately loose — the LLM does the final call. The previous
 * brittle exact-matching regex is gone; we only gate obvious noise.
 */
function mightContainFact(text: string): boolean {
  const cleaned = text.replace(/^\[微信消息(?: [\d-]+ [\d:]+)?\]\s*/, "").trim();
  if (!cleaned || cleaned.length > 120) return false;

  // Scheduling, not memory. An explicit "remind me" is always a job for
  // schedule_create; a nudge word (别忘了 / 记得) is only one when it comes with a
  // specific occasion — "别忘了明天十点开会" is a reminder, "请记得我对花生过敏"
  // is a fact. So the second rule needs BOTH halves, and a time on its own
  // ("我习惯晚上十点睡觉") passes.
  if (/(?:提醒我|提醒一下|记得提醒|到点|叫我起|闹钟|定个时|定时)/.test(cleaned)) return false;
  if (/(?:别忘了|记得|请记得)/.test(cleaned) && ONE_OFF_TIME.test(cleaned)) return false;

  // Hard noise: greetings, thanks, task commands, one-off questions.
  if (/^(你好|在吗|谢谢|好的|嗯|哈哈|晚安|辛苦了|拜拜|再见|嗨|hello|hi)\b/.test(cleaned)) return false;
  if (/(?:帮我|请帮我|查一下|查查|搜一下|搜搜|发给我|发一下|看一下|看看|找一下|找找|设置为|创建|删除|生成|写一个|做一个|转成|转换成|审阅|汇总|整理|列一下)/.test(cleaned)) return false;

  // Self-references or durable-time markers suggest a personal fact.
  // Use specific patterns, not bare single characters (是/在/叫 alone are
  // too broad: "那是什么", "在吗", "你叫什么" would all false-positive).
  // 「我」和动词之间允许一个语气副词。要求紧挨着会漏掉很自然的说法:
  // 2026-09-22 实测「你知道吗,我**其实**可以吃肉桂」整条被挡掉,而
  // 「我可以吃肉桂」能过 —— 差别只有那两个字。用显式副词表而不是通配的
  // `我.{0,3}`,后者会把「我们公司可以」这种也放进来。
  const ADV = "(?:其实|真的|确实|平常|一向|向来|从来|基本|大概|可能|也|都|还|就|才|只|挺|很|比较|不太)?";
  return new RegExp(
    `(?:我是|我叫|我读|我学|我从事|我住在|我在(?:读|学|做|从事)|我的`
    + `|我${ADV}(?:喜欢|偏好|习惯|不喜欢|讨厌|不能|不会|可以|平时|通常|一般|主要|希望|以后|每次|每周|每月|每天)`
    + `|(?:以后|每次|每周|每月|每天|请以后|尽量不要|不要再|请记得|别忘了)|咱|自己)`,
  ).test(cleaned);
}

/**
 * How the classifier reaches a model.
 *
 * Takes the fully rendered prompt, returns the model's raw text (or null when
 * the call failed). The bridge supplies one bound to the WeChat session's own
 * provider/model; tests supply a stub. Keeping it an injected function is what
 * lets this module stay free of any vendor URL, key, or wire format.
 */
export type MemoryJudge = (prompt: string) => Promise<string | null>;

/** Build the classification prompt for one candidate message. */
function judgePrompt(cleaned: string): string {
  return (
    `判断下面的用户消息是否包含"值得长期记住的个人信息"(身份/偏好/习惯/长期成立的重要事实)。` +
    `标准:一个月后这条还成立吗?不成立就不记。` +
    `忽略:一次性任务请求、问候、闲聊、对当前对话内容的指代;` +
    `**以及一次性的提醒和安排**(某个时间点要做的事、今天/明天/几点的计划)——那些由定时提醒功能处理,不进长期记忆。` +
    `固定的周期性安排(如"每周三下午组会")算长期事实,可以记。\n\n` +
    `消息: ${cleaned}\n\n` +
    `如果值得记住,输出一行 JSON: {"section": "基本档案|偏好与习惯|重要事实", "fact": "一句简洁的中文事实,第三人称描述用户,不要带今天/明天这类相对时间"}\n` +
    `如果不值得记住,输出: null\n` +
    `只输出 JSON 或 null,不要其他内容。`
  );
}

/**
 * Ask the bot's own model whether the message holds a durable user fact.
 *
 * Returns { section, fact } or null. Never throws: a classifier failure must
 * not cost the user their reply, so every error path degrades to "nothing
 * worth remembering".
 */
async function confirmWithLLM(
  text: string,
  judge: MemoryJudge | undefined,
): Promise<{ section: string; fact: string } | null> {
  if (judge === undefined) return null;
  const cleaned = text.replace(/^\[微信消息(?: [\d-]+ [\d:]+)?\]\s*/, "").trim();

  let raw: string | null;
  try {
    raw = await judge(judgePrompt(cleaned));
  } catch (err) {
    logger.warn(`memory-auto: judge threw: ${String(err).slice(0, 120)}`);
    return null;
  }
  if (raw === null) return null;

  // Models wrap JSON in fences often enough that not stripping them loses
  // real captures; the old DeepSeek-only path never saw this because
  // deepseek-chat happened not to fence. Any route may.
  const content = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  if (!content || content === "null") return null;

  try {
    const parsed = JSON.parse(content) as { section?: string; fact?: string };
    const fact = parsed.fact?.trim();
    if (!fact) return null;
    // Defence in depth: told not to, a model still occasionally files a one-off
    // reminder. Either tell-tale drops it rather than filing it elsewhere.
    if (parsed.section === "提醒事项" || STALE_BY_TOMORROW.test(fact)) return null;
    const section =
      parsed.section && SECTIONS.includes(parsed.section as (typeof SECTIONS)[number])
        ? parsed.section
        : pickSection(fact);
    return { section, fact };
  } catch {
    // A chatty model that ignored "只输出 JSON" is not an error worth logging
    // every turn — the pre-filter fires on plenty of messages that hold no fact.
    return null;
  }
}

/**
 * Scan the user messages of one just-finished turn; for each that passes the
 * cheap pre-filter, ask the LLM to confirm + rewrite, then append. Returns
 * how many facts were added. Never throws.
 */
export async function captureTurnMemory(
  userTexts: string[],
  judge?: MemoryJudge,
): Promise<number> {
  if (judge === undefined) {
    logger.warn("memory-auto: 没有可用的判定模型(宿主 llm 服务缺失或路由未解析),本轮跳过");
    return 0;
  }
  let added = 0;
  for (const text of userTexts) {
    if (!mightContainFact(text)) continue;
    const result = await confirmWithLLM(text, judge);
    if (!result) continue;
    if (appendMemoryEntry(result.section, result.fact)) {
      added += 1;
      logger.info(`memory-auto: LLM captured "${result.fact}" -> ${result.section}`);
    }
  }
  return added;
}

// Re-export for the evaluation suite and manual testing.
export { mightContainFact as extractMemoryCandidates, confirmWithLLM };
