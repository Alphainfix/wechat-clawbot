/**
 * Clean up outbound WeChat text. The model is unreliable at following "no
 * emoji" instructions, so the plugin enforces the policy deterministically
 * rather than trusting the prompt.
 *
 * Two different things, with two different rules:
 *
 *   - **Unicode emoji** (😊 ✅ 🎉) are a matter of taste, so they follow the
 *     `stripEmoji` setting. The prompt's rule C.3 flips with the same setting,
 *     so the model is not told to produce something that gets stripped on the
 *     way out.
 *
 *   - **WeChat's own bracket codes** (`[捂脸]`, `[好的]`) are removed
 *     unconditionally. They are WeChat's internal notation, and sending them
 *     through this bridge does NOT turn them into a picture on the recipient's
 *     client — he just sees the literal brackets. They are never right, so
 *     there is no setting for them.
 */

// Common emoji / symbol ranges (and variation selectors). CJK and CJK
// punctuation are outside these ranges, so Chinese text is never damaged.
const EMOJI_RE =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2190}-\u{21FF}\u{2E80}-\u{2EFF}\u{FE0F}\u{200D}\u{2B50}\u{2764}\u{2763}\u{2705}\u{274C}\u{274E}\u{2728}\u{00A9}\u{00AE}\u{203C}\u{2049}\u{2122}\u{2139}]/gu;

/**
 * WeChat native emoji codes: a bracketed run of 1–4 Han characters, which is
 * what every code in that set looks like (`[捂脸]`, `[偷笑]`, `[再见]`).
 *
 * Deliberately narrow rather than a blanket `\[.*?\]`. The inbound markers this
 * bridge itself uses are longer or carry punctuation (`[定时任务触发]`,
 * `[图片: /path]`, `[引用: …]`), so none of them match. The trailing lookahead
 * spares a markdown link: `[点这里](https://…)` used to lose its label and
 * leave a bare `(url)` dangling — caught by testing exactly that string.
 *
 * A genuine short Han bracket in prose — `[参考]`, say — would still be caught,
 * which is a fair trade for never shipping a broken emoji code.
 */
const WECHAT_CODE_RE = /\[\p{Script=Han}{1,4}\](?!\()/gu;

/** Collapse the whitespace a removal leaves behind. */
function tidy(text: string): string {
  return text
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();
}

/**
 * Remove WeChat's bracket emoji codes. Applied to every outbound message,
 * whatever the emoji setting says, because they render as literal text.
 */
export function stripWechatCodes(text: string): string {
  return tidy(text.replace(WECHAT_CODE_RE, ""));
}

/** Remove Unicode emoji characters (and the bracket codes along the way). */
export function stripEmoji(text: string): string {
  return tidy(text.replace(EMOJI_RE, "").replace(WECHAT_CODE_RE, ""));
}
