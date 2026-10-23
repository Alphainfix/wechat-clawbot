#!/usr/bin/env node
/**
 * Offline regression checks for the settings/vision/emoji work.
 *
 * Everything here runs against the built `lib/` and the host's own packages —
 * no model calls, no network, no WeChat. That is the point: the parts of this
 * plugin that used to break silently (a schema that rejects a field the
 * attachment store just added, a strip rule that eats a markdown link, a
 * "hot" setting that is actually read once at boot) are all checkable without
 * spending a token.
 *
 *   node test/regression.mjs
 *
 * Exits non-zero when any check fails, so it can gate a build.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, statSync, lstatSync, readdirSync, rmSync, symlinkSync, chmodSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
// The fixtures are written for one time zone (dates and offsets at UTC−4/−5): pin it, so the
// suite gives the same answers on any machine. Set before any of the plugin's modules load.
process.env.TZ = "America/New_York";
// The host these checks compare against. Used to be a hard-coded bucket, which
// quietly kept testing 0.1.1-rc.2 through three upgrades. Now: the bucket whose
// `.bin/dsh` is newest — the same rule the menu-bar whale boots by — or
// DSH_NPX=<bucket>/node_modules to test a host before cutting over to it.
function currentHostModules() {
  if (process.env.DSH_NPX) return process.env.DSH_NPX;
  const root = join(homedir(), ".npm/_npx");
  let best;
  for (const bucket of existsSync(root) ? readdirSync(root) : []) {
    const bin = join(root, bucket, "node_modules/.bin/dsh");
    try {
      const mtime = lstatSync(bin).mtimeMs;
      if (!best || mtime > best.mtime) best = { mtime, dir: join(root, bucket, "node_modules") };
    } catch { /* not a dsh bucket */ }
  }
  return best?.dir ?? join(root, "missing/node_modules");
}
const NPX = currentHostModules();
const HOST_VERSION = (() => {
  try { return JSON.parse(readFileSync(join(NPX, "@deepseek-ai/dsh/package.json"), "utf-8")).version; }
  catch { return "?"; }
})();

let pass = 0;
let fail = 0;
const results = [];

function check(name, ok, detail) {
  if (ok) { pass += 1; results.push(`  ✓ ${name}`); }
  else { fail += 1; results.push(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); }
}

// ---------------------------------------------------------------- emoji rules
{
  const { stripEmoji, stripWechatCodes } = await import(join(ROOT, "lib/emoji.js"));
  const cases = [
    // [input, expected-changed?, why]
    ["好的 [捂脸] 明天见", true, "WeChat bracket code must go — it renders literally"],
    ["收到 [好的]", true, "same"],
    ["[定时任务触发] 提醒内容:交学费", false, "our own inbound marker must survive"],
    ["看这个 [图片: /Users/a/b.jpg] 行吗", false, "inbound media marker must survive"],
    ["参考 [引用: 明天晴] 那条", false, "quote marker must survive"],
    ["点 [这里](https://x.com) 看", false, "markdown link label must survive"],
    ["地图 [City Library](https://maps.example/x)", false, "latin markdown label"],
  ];
  for (const [input, shouldChange, why] of cases) {
    const out = stripWechatCodes(input);
    const changed = out !== input.replace(/[ \t]+/g, " ").trim();
    check(`bracket strip: ${JSON.stringify(input.slice(0, 24))} (${why})`, changed === shouldChange,
      `got ${JSON.stringify(out)}`);
  }
  check("stripEmoji removes unicode emoji", stripEmoji("收到 😊 好") === "收到 好");
  check("stripWechatCodes keeps unicode emoji", stripWechatCodes("收到 😊 好") === "收到 😊 好");
}

// -------------------------------------------------------------- config schema
{
  const cfg = await import(join(ROOT, "lib/config.js"));
  const { Config, DEFAULT_CONFIG, HOT_FIELDS, normalizeConfig } = cfg;

  // The schema must cover every field, or `Schema.object()` silently drops the
  // ones it does not declare — deleting them from the composed cordis row the
  // first time the settings page writes the section back.
  const resolved = Config({});
  const declared = new Set(Object.keys(resolved));
  const missing = Object.keys(DEFAULT_CONFIG).filter(
    (k) => DEFAULT_CONFIG[k] !== undefined && !declared.has(k));
  check("schema declares every defaulted field", missing.length === 0, `missing: ${missing.join(", ")}`);

  // Explicit values in the cordis row must survive schema resolution.
  const row = { autoStart: true, sessionId: "wechat-main", forwardQuestions: false };
  const out = Config(row);
  check("schema preserves explicit row values",
    out.autoStart === true && out.sessionId === "wechat-main" && out.forwardQuestions === false);

  for (const bad of [{ imageQuality: 500 }, { logLevel: "chatty" }, { maxImageEdge: -1 }]) {
    let threw = false;
    try { Config(bad); } catch { threw = true; }
    check(`schema rejects ${JSON.stringify(bad)}`, threw);
  }

  // A hot field is one the running plugin can adopt WITHOUT a restart, which
  // means the code must read it at the moment it is used. Grep the sources for
  // each: a field only ever read inside apply() is not hot, whatever the set says.
  // Every source that reads config at a call site. claude-peer.ts joined the
  // list in 2026-09 with claudeResumePermissionMode — the suite caught its
  // absence, which is the check working: a field can only be called hot if some
  // file here reads it live.
  const sources = ["src/index.ts", "src/bridge.ts", "src/inbound.ts", "src/tool.ts", "src/approvals.ts",
    "src/prompt.ts", "src/mcp-route.ts", "src/claude-peer.ts", "src/codex-peer.ts", "src/mac-calendar.ts"]
    .filter((f) => existsSync(join(ROOT, f)))
    .map((f) => readFileSync(join(ROOT, f), "utf-8")).join("\n");
  for (const field of HOT_FIELDS) {
    // Reading through `config.X` / `this.config.X` / `deps.config.X` at a call
    // site is what makes in-place mutation visible.
    const read = new RegExp(`config\\.${field}\\b`).test(sources);
    check(`hot field is read at use time: ${field}`, read,
      "declared hot but never read through a live config reference");
  }
  check("cold fields are not in HOT_FIELDS",
    !HOT_FIELDS.has("sessionId") && !HOT_FIELDS.has("apiBaseUrl") && !HOT_FIELDS.has("autoStart"));

  // Empty strings must normalize to undefined, or an empty box in the settings
  // card would pin the model to "" instead of following the deployment default.
  const blanked = normalizeConfig({ provider: "  ", model: "", reasoningEffort: "" });
  check("blank model fields normalize to undefined",
    blanked.provider === undefined && blanked.model === undefined && blanked.reasoningEffort === undefined);
}

// ------------------------------------------- attachment ref vs output schema
{
  // The real reason this file exists. dsh-attachment 0.1.1-rc.2 added
  // `originalDimensions` to the ref, and `look_at_image` declares its image
  // object with `additionalProperties: false` — so an undeclared field fails
  // the whole tool call. Save an oversized image through the host's own store
  // and assert every key it returns is one the schema knows.
  const attachmentPath = join(NPX, "@deepseek-ai/dsh-attachment-local/lib/index.js");
  if (!existsSync(attachmentPath)) {
    check("attachment ref keys are all declared (host package present)", false, "host dsh-attachment-local not found");
  } else {
    const A = await import(attachmentPath);
    const sharp = (await import(join(NPX, "sharp/dist/index.cjs"))).default;
    const limits = {
      maxImageBytes: A.DEFAULT_MAX_IMAGE_BYTES,
      maxImageDimension: A.DEFAULT_MAX_IMAGE_DIMENSION,
      maxImagePixels: A.DEFAULT_MAX_IMAGE_PIXELS,
      maxImagesPerMessage: A.DEFAULT_MAX_IMAGES_PER_MESSAGE,
      maxMessageImageBytes: A.DEFAULT_MAX_MESSAGE_IMAGE_BYTES,
      mediaTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"],
    };
    const policy = {
      maxDimension: A.DEFAULT_NORMALIZED_IMAGE_MAX_DIMENSION,
      maxBytes: A.DEFAULT_NORMALIZED_IMAGE_MAX_BYTES,
      // 0.1.7-rc.2 added a pixel-count ceiling and raised the per-side one to 8192.
      ...(A.DEFAULT_NORMALIZED_IMAGE_MAX_PIXELS !== undefined
        ? { maxPixels: A.DEFAULT_NORMALIZED_IMAGE_MAX_PIXELS } : {}),
    };
    // Deliberately larger than the normalization ceiling, which is what makes
    // the store record `originalDimensions`. This is reachable in production
    // now that 图片长边上限 is a user-settable field. Sized from whichever
    // ceiling binds first, so it still passes source admission (twice the
    // per-side ceiling is 16384×8192 on rc.2 — over the 64 MP admission limit).
    const side = policy.maxPixels !== undefined
      ? Math.min(policy.maxDimension, Math.floor(Math.sqrt(policy.maxPixels)))
      : policy.maxDimension;
    const big = await sharp({
      create: { width: side * 2, height: side, channels: 3,
                background: { r: 200, g: 120, b: 60 } },
    }).jpeg({ quality: 85 }).toBuffer();

    const root = join(tmpdir(), `clawbot-regression-${process.pid}`);
    mkdirSync(root, { recursive: true });
    const ref = await A.saveImageFile(root, { data: new Uint8Array(big), mediaType: "image/jpeg", name: "big.jpg" }, limits, policy);

    check("store downscales and records originalDimensions", ref.originalDimensions !== undefined,
      `ref = ${JSON.stringify(Object.keys(ref))}`);

    // The declared property names, read straight out of the built tool so the
    // assertion cannot drift from the shipped schema. Indentation in the
    // compiled output does not match the source, so this brace-matches from
    // `image: {` instead of anchoring on column counts (which is exactly how
    // the first version of this check produced a false failure).
    const toolSrc = readFileSync(join(ROOT, "lib/tool.js"), "utf-8");
    const declaredKeys = new Set();
    const start = toolSrc.indexOf("look_at_image");
    const imageAt = toolSrc.indexOf("image: {", start);
    if (imageAt >= 0) {
      let depth = 0;
      let end = imageAt;
      for (let i = toolSrc.indexOf("{", imageAt); i < toolSrc.length; i += 1) {
        if (toolSrc[i] === "{") depth += 1;
        else if (toolSrc[i] === "}") { depth -= 1; if (depth === 0) { end = i; break; } }
      }
      const body = toolSrc.slice(imageAt, end);
      // Direct children of `properties:` are the declared field names; nested
      // ones (originalDimensions' own width/height) are matched too, which is
      // harmless for a superset check.
      for (const m of body.matchAll(/^\s*(\w+):\s*\{/gm)) declaredKeys.add(m[1]);
      for (const m of body.matchAll(/^\s*(\w+):\s*\{ type:/gm)) declaredKeys.add(m[1]);
    }
    check("could read look_at_image's declared image keys", declaredKeys.size > 0,
      `parsed: ${[...declaredKeys].join(", ")}`);
    const undeclared = Object.keys(ref).filter((k) => !declaredKeys.has(k));
    check("every attachment-ref key is declared in look_at_image's schema", undeclared.length === 0,
      `undeclared: ${undeclared.join(", ")} — additionalProperties:false would reject the tool result`);
  }
}

// ----------------------------------------------------- prompt / emoji setting
{
  const { buildWechatSystemPrompt } = await import(join(ROOT, "lib/prompt.js"));
  const strict = buildWechatSystemPrompt(false);
  const loose = buildWechatSystemPrompt(true);
  check("prompt forbids emoji when stripEmoji is on", /绝不使用 Unicode emoji/.test(strict));
  check("prompt allows emoji when stripEmoji is off", /可以偶尔用一个 Unicode emoji/.test(loose));
  check("prompt never tells the bot to send bracket codes", !/偶尔一个 \[/.test(strict) && !/想表达情绪时用微信原生表情代码/.test(strict));
  check("prompt explains why bracket codes are banned", /方括号表情代码/.test(strict) && /方括号表情代码/.test(loose));
  check("prompt names look_at_image, not the retired preview tool",
    /look_at_image/.test(strict) && !/preview_wechat_image/.test(strict));
}

// ------------------------------------------------------- vision probe honesty
// The vision line exists so a photo that was not attached can be diagnosed
// without asking for another photo. It reads `currentRoute()`, whose first
// source is the LAST request's header — so right after a model change, before
// any turn has run under it, it names the OLD model. That once made a freshly
// switched bot log the previous provider/model while the selection log on the
// line above already said `deepseek-official/deepseek-flash`. Reporting where
// the number came from is what turns that from misleading into merely stale.
{
  const bridge = readFileSync(join(ROOT, "lib/bridge.js"), "utf-8");
  check("currentRoute reports which source it read",
    /source: string/.test(readFileSync(join(ROOT, "src/bridge.ts"), "utf-8"))
    && /"上一轮请求头"/.test(bridge) && /"部署默认"/.test(bridge)
    && /"agent options"/.test(bridge),
    "the three sources have different authority and different staleness");
  const labelled = (bridge.match(/按\$\{route\.source\}/g) ?? []).length;
  check(`every route-naming log line says its source (${labelled} of 4)`,
    labelled >= 4,
    "a line that names a model without saying where it came from is the bug this fixes");
}

// ------------------------------------------------------------ local wall clock
// Every one of these pins a bug that actually shipped. The reminder failures
// were never "the model was not told the time" — the session log proves the
// right time was in the prompt — they were the prompt asking for arithmetic a
// no-reasoning route cannot do (reasoningEffort forced off), and the history
// offering a stale date as the only alternative.
{
  const lt = await import(join(ROOT, "lib/localtime.js"));
  const { buildWechatSystemPrompt } = await import(join(ROOT, "lib/prompt.js"));
  const prompt = buildWechatSystemPrompt(false);

  // 22:31 at UTC−4 on Aug 31 is already Sep 1 in UTC. A memory entry stamped
  // then read `[2026-09-01]`, so the agent saw a fact dated in the future.
  const lateEvening = new Date("2026-08-31T22:31:00-04:00");
  const utcWouldSay = lateEvening.toISOString().slice(0, 10);
  const zoned = lt.zonedDate(lateEvening);
  check("zonedDate does not drift to the UTC date late in the evening",
    zoned === "2026-08-31" && utcWouldSay === "2026-09-01",
    `zoned=${zoned} utc=${utcWouldSay}`);
  check("no source file stamps dates from toISOString",
    ["lib/memory.js", "lib/prompt.js", "lib/bridge.js"].every(
      (f) => !/toISOString\(\)\.slice\(0, ?10\)/.test(readFileSync(join(ROOT, f), "utf-8"))));

  // Stepping the calendar, not adding 24h: 2026-03-08 is a DST spring-forward
  // date in the suite's zone, where +24h would land on the same date at 23:00.
  check("zonedDatePlus steps whole calendar days across a DST boundary",
    lt.zonedDatePlus(1, new Date("2026-03-07T20:00:00-05:00")) === "2026-03-08"
    && lt.zonedDatePlus(2, new Date("2026-03-07T20:00:00-05:00")) === "2026-03-09");
  check("zonedWeekday reads the right day", lt.zonedWeekday("2026-08-31") === "周一",
    lt.zonedWeekday("2026-08-31"));
  check("zonedStamp is MM-DD HH:mm", /^\d{2}-\d{2} \d{2}:\d{2}$/.test(lt.zonedStamp()),
    lt.zonedStamp());

  // The clock section has to make the decision, not delegate it. Each of these
  // is a thing the model got wrong when it had to work it out itself.
  check("clock section spells out today, tomorrow and the day after",
    /今天:\d{4}-\d{2}-\d{2}\(周./.test(prompt) && /明天:\d{4}-\d{2}-\d{2}\(周./.test(prompt)
    && /后天:\d{4}-\d{2}-\d{2}\(周./.test(prompt));
  check("clock section forbids copying dates out of the chat history",
    /绝不要从聊天记录里抄日期/.test(prompt));

  // 记忆文件每轮整份进提示词,所以"别写什么"和"写什么"一样重要:
  // 2026-09-12 清理时它攒了 26 条过期的一次性提醒 + 6 份目录结构罗列,
  // 2681 tok 里约 1950 是垃圾 —— 而且满是旧日期,正是模型抄错日期的土壤。
  check("memory rules forbid one-off reminders (those belong to schedule_create)",
    /一次性的提醒/.test(prompt) && /schedule_create/.test(prompt));
  check("memory rules forbid directory listings",
    /文件\/目录结构/.test(prompt));
  check("memory rules state the whole file rides in every prompt",
    /每一轮都整份进提示词/.test(prompt));
  check("clock section resolves today-vs-tomorrow without arithmetic",
    /钟点晚于这条消息的 HH:mm/.test(prompt));
  // 「现在」来自正在回的那条消息,不是提示词。**提示词里不能有钟点** ——
  // deepseek-flash 声明了 systemPromptUpdate: "in-history",宿主的实现是
  // 「渲染结果和上一份不一样就把整份追加进历史」,所以一个带秒的时钟 = 每一步
  // 往历史里塞一份 24KB 的提示词。2026-09-12 实测:14 轮 35 步塞了 35 份,
  // 上下文 519k tok 而真实对话只有 54k,累计输入 7.3M。
  check("clock section takes \"now\" from the message being answered",
    /\[微信消息 MM-DD HH:mm\]/.test(prompt) && /历史消息里的时间戳都是过去的/.test(prompt));
  check("the prompt carries no wall clock at all (it must be stable all day)",
    !/现在:\d|\d{2}:\d{2}:\d{2}/.test(prompt),
    "带钟点的提示词每一步都会被整份追加进历史");
  check("a turn without a message stamp is told to run `date` instead of guessing",
    /跑一下 `date`/.test(prompt));

  // 这条是上面那些规则的**执行检查**:提示词必须一天之内逐字节不变。
  // 宿主对 systemPromptUpdate:"in-history" 的实现是「和上一份不一样就把整份
  // 追加进历史」,所以任何每轮会变的字符(时钟、随机 id、计数器)都会让历史
  // 每一步长出一份完整提示词。渲染两次比对是能抓住这件事的最便宜的办法。
  // 隔 1.1 秒再渲染一次:带秒的时钟会在这里露馅,同一毫秒内比对则抓不到。
  // 这 1.1 秒是这个套件里唯一的等待,买的是本插件最贵的一类 bug。
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const again = buildWechatSystemPrompt(false);
  check("the prompt renders byte-identical 1.1s later",
    again === prompt,
    "任何每轮变化的内容都会被整份追加进历史 —— 一步一份 24KB");

  // The 08-31 failure ended with the bot telling the user "it is already past
  // 11pm" at 22:30, because that is how it read the tool's `not_future` error.
  check("rule G5 explains not_future as a wrong date, not a passed time",
    /not_future/.test(prompt) && /不要把它转述成/.test(prompt));
  check("rule G5 warns that scheduledAt comes back in UTC",
    /scheduledAt/.test(prompt) && /UTC/.test(prompt));
}

// ------------------------------------------------------- inbound marker format
{
  const bridgeSrc = readFileSync(join(ROOT, "lib/bridge.js"), "utf-8");
  check("inbound messages carry a local timestamp",
    /\[微信消息 \$\{zonedStamp\(\)\}\]/.test(bridgeSrc));

  // The marker is stripped before the memory heuristics see it. A regex that
  // only matched the old bare form would feed "08-31 22:30" into the fact text.
  const autoSrc = readFileSync(join(ROOT, "lib/memory-auto.js"), "utf-8");
  const { extractMemoryCandidates } = await import(join(ROOT, "lib/memory-auto.js"));
  const strip = /\[微信消息(?: [\d-]+ [\d:]+)?\]\s*/;
  check("memory-auto strips both marker shapes",
    autoSrc.includes("[微信消息(?: [\\d-]+ [\\d:]+)?\\]"),
    "regex not found in built lib");
  check("...and that regex actually strips both",
    "[微信消息 08-31 22:30] 我是大学生".replace(strip, "") === "我是大学生"
    && "[微信消息] 我是大学生".replace(strip, "") === "我是大学生");

  // 一句「你知道吗,我**其实**可以吃辣」曾被预筛整条挡掉 ——
  // 老正则要求「我」和动词紧挨着,中间夹一个副词就漏判。
  // 这几条钉住「副词可以夹在中间」,同时钉住不能因此把「我们…」放进来。
  const shouldPass = [
    "你知道吗，我其实可以吃辣，只是家里人不太能吃。",
    "我真的不喜欢香菜",
    "我平时都喝美式",
    "我不能喝酒",
  ];
  const shouldBlock = ["帮我查一下明天的天气", "哈哈哈那太好了", "我们公司可以报销"];
  check("预筛允许「我」和动词之间夹语气副词",
    shouldPass.every((t) => extractMemoryCandidates(t)),
    shouldPass.filter((t) => !extractMemoryCandidates(t)).join(" / ") || "");
  check("放宽之后仍然挡住任务请求和「我们…」",
    shouldBlock.every((t) => !extractMemoryCandidates(t)),
    shouldBlock.filter((t) => extractMemoryCandidates(t)).join(" / ") || "");
}

// ------------------------------------------------------------- mcp bridge
{
  // The bridge routes let an outside process drive sessions and reach the
  // owner's phone, so the properties worth pinning are the ones that keep that
  // narrow: who can be messaged, and which channel a session message goes out on.
  const routeSrc = readFileSync(join(ROOT, "lib/mcp-route.js"), "utf-8");

  check("all four bridge routes are registered",
    ["/plugins/clawbot/mcp/sessions", "/plugins/clawbot/mcp/read",
     "/plugins/clawbot/mcp/send", "/plugins/clawbot/mcp/notify"]
      .every((p) => routeSrc.includes(p)));

  // Structural, not advisory: with no `to` read from the body, "message someone
  // other than the owner" cannot be expressed at all.
  const notifyAt = routeSrc.indexOf("async notify(");
  const notifyBody = notifyAt < 0 ? "" : routeSrc.slice(notifyAt, notifyAt + 1200);
  // The send itself moved to owner-notify.ts (shared with notify_wechat).
  const ownerSrc = readFileSync(join(ROOT, "lib/owner-notify.js"), "utf-8");
  const ownerAt = ownerSrc.indexOf("async function notifyOwner(");
  const ownerBody = ownerAt < 0 ? "" : ownerSrc.slice(ownerAt, ownerAt + 1500);
  check("notify sends only to account.userId",
    /account\.userId/.test(ownerBody) && /deps\.sendText\(owner, text\)/.test(ownerBody)
      && /notifyOwner\(ctx, deps,/.test(notifyBody),
    "the recipient must come from the QR-linked account, never from the request");
  check("notify reads no recipient from the request body",
    notifyAt >= 0 && !/requireString\(body,\s*"(to|recipient|userId)"/.test(notifyBody),
    "a `to` parameter would make messaging a third party representable");

  // The WeChat/GUI split hangs on this exact string: the bridge's session
  // listener forwards to WeChat only for its own inbound turns and `schedule`.
  // Tag an injected message as "wechat-clawbot" and it would start reaching
  // the phone, which is the one thing the owner asked never to happen.
  // DSH 0.1.7 (session format v4) retired the `{ kind: "plugin", plugin }`
  // wrapper and REJECTS it on append; the producer's own kind is now the
  // tag — `plugin:clawbot-mcp`, the exact string the v3→v4 converter gives
  // this producer's history. The invariant is unchanged: MCP-injected turns
  // carry clawbot-mcp, never the plugin's own inbound tag.
  check("injected session messages use the clawbot-mcp source tag",
    /kind:\s*"plugin:clawbot-mcp"/.test(routeSrc),
    "GUI-only isolation for dsh_send_to_session depends on this source tag");
  check("injected session messages are NOT tagged as the plugin's own inbound",
    !/kind:\s*"plugin:wechat-clawbot"/.test(routeSrc),
    "tagging an MCP message as inbound would start forwarding it to the phone");
  // Comments are stripped first: the explanation of WHY the wrapper is gone
  // quotes it, and a check fooled by its own documentation proves nothing.
  const codeOnly = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  check("no source still uses the retired v3 plugin wrapper (v4 rejects it)",
    ["lib/mcp-route.js", "lib/bridge.js", "lib/inbound.js", "lib/tool.js"]
      .every((f) => !/kind:\s*"plugin"\s*,/.test(codeOnly(readFileSync(join(ROOT, f), "utf-8")))),
    "a v4 session throws on { kind: \"plugin\" } — every such append would fail");

  // The status route is intentionally NOT behind the token — the settings card
  // is a browser page and cannot hold a secret. That makes "does it leak the
  // token" the question worth pinning, not "is it authenticated".
  const statusAt = routeSrc.indexOf('path: "/plugins/clawbot/mcp/status"');
  const statusBody = statusAt < 0 ? "" : routeSrc.slice(statusAt, statusAt + 900);
  check("a status route exists for the settings card", statusAt >= 0);
  check("status reports the token's path but never its value",
    /tokenPath\(\)/.test(statusBody) && !/\btoken,/.test(statusBody) && !/token:\s*token\b/.test(statusBody),
    "an unauthenticated route must not echo the secret");
  check("status is outside the mcpBridge gate",
    statusAt >= 0 && statusAt < routeSrc.indexOf("deps.config.mcpBridge !== true"),
    "\"is it off?\" is the question you ask when it is off, so the gate must not hide it");

  check("every bridge route is behind the bearer check",
    /secretEquals\(bearer\(req\), token\)/.test(routeSrc));

  // 0600 on create is not enough: `mode` is ignored when the file already
  // exists, so a token left world-readable by an older build would stay that way.
  check("the token file is chmodded unconditionally",
    (routeSrc.match(/chmodSync\([^)]*0o600\)/g) ?? []).length >= 2,
    "chmod must run on the read path too, not only at creation");

  // Real behaviour, not just a grep: minting into a temp state dir must produce
  // a 32-byte hex secret in a 0600 file.
  const tmpState = join(tmpdir(), `clawbot-mcp-token-${process.pid}`);
  mkdirSync(tmpState, { recursive: true });
  process.env.CLAWBOT_STATE_DIR = tmpState;
  const { ensureMcpToken } = await import(join(ROOT, "lib/mcp-route.js"));
  const minted = ensureMcpToken();
  const tokenFile = join(tmpState, "mcp-token");
  check("minted token is 64 hex chars", /^[0-9a-f]{64}$/.test(minted), `got ${minted.slice(0, 12)}…`);
  check("token file is 0600",
    (statSync(tokenFile).mode & 0o777) === 0o600,
    `mode ${(statSync(tokenFile).mode & 0o777).toString(8)}`);
  check("a second call returns the same token", ensureMcpToken() === minted);
  unlinkSync(tokenFile);
  delete process.env.CLAWBOT_STATE_DIR;
}

// ------------------------------------------------------- reset script hygiene
{
  const script = readFileSync(join(ROOT, "scripts/reset-wechat-session.sh"), "utf-8");
  // 桶名必须从 $HOME 推导:写死任何 /Users/<name>/ 字面路径都过不了这一关,
  // 也因此不会把作者的用户名带进仓库。
  check("reset script derives the session bucket from $HOME", !/\/Users\//.test(script));
  check("reset script finds node instead of pinning an nvm version", !/versions\/node\/v\d/.test(script));
  check("reset script still refuses to run while dsh is up",
    /if lsof -nP -iTCP:3080 -sTCP:LISTEN[^\n]*then[\s\S]{0,200}?exit 1/.test(script));
  // 会话文件名带格式版本号(0.1.5 起是 session.v3.jsonl.zstd)。写死其中一个,
  // 换版本之后脚本会「完成」却什么都没删 —— 最坏的一种失败:看起来成功了。
  check("reset script globs session files instead of pinning one name",
    /session\*\.jsonl\.zstd/.test(script) && !/\/session\.jsonl\.zstd"/.test(script),
    "DSH renamed it to session.v3.jsonl.zstd in 0.1.5");
}

// -------------------------------------------------------------- no PII in git
{
  const files = ["scripts/bot-sim-scenarios.mjs", "scripts/reset-wechat-session.sh", "test/memory-eval-cases.ts"];
  for (const f of files) {
    const p = join(ROOT, f);
    if (!existsSync(p)) continue;
    const text = readFileSync(p, "utf-8");
    // bot-sim 的 stub 里约定用 "/Users/you/…" 作占位;任何**别的**真实用户名的
    // 绝对路径都不该出现。
    check(`no personal paths in ${f}`, !/\/Users\/(?!you\b)[A-Za-z0-9._-]+(\/|$)/.test(text),
      "a shared plugin should not carry the author's home directory");
  }
}

// --------------------------------- 路由自检:插件钉的模型比「上一轮」更权威
{
  const bridge = readFileSync(join(ROOT, "src/bridge.ts"), "utf-8");
  // 请求头记的是上一轮的模型。刚在设置页换完模型、还没跑过一轮时,两者不一致 ——
  // 而 routeTakesImages() 也读这个函数来决定附不附图,读错就可能把图挡掉。
  check("the pinned config outranks the last request header",
    /const provider = pinned\?\.provider \?\? routed\?\.provider/.test(bridge)
    && /const model = pinned\?\.model \?\? routed\?\.model/.test(bridge),
    "settings-page provider+model is installed onto the agent, so it is what the next turn uses");
  check("the route reports 插件配置 as its own source", /"插件配置"/.test(bridge));
}

// ------------------------------- 自动记忆是"第二个数据去向",必须默认关 + 披露
{
  const cfg = readFileSync(join(ROOT, "src/config.ts"), "utf-8");
  // 它会把像个人信息的消息**原文**发到 api.deepseek.com,用的还是插件自己从
  // 凭证文件里读出来的 key。自用没问题,发布出去就必须是"用户自己选择开启"。
  // 0.9.4: flipped to ON at the owner's call — the classifier has used the
  // session's own route since 0.9.3, so there is no second destination left.
  check("autoMemory defaults to on", /autoMemory: true/.test(cfg),
    "默认值是机主定的(0.9.4):开。判定走会话自己的模型,没有第二家;要改回关先问机主");
  const bridge = readFileSync(join(ROOT, "src/bridge.ts"), "utf-8");
  check("the classifier is actually gated on the flag",
    /if \(this\.config\.autoMemory\)/.test(bridge));
  for (const doc of ["README.md", "README.zh.md"]) {
    const text = readFileSync(join(ROOT, doc), "utf-8");
    check(`${doc} 说明了自动记忆的数据去向`,
      /autoMemory/.test(text) && /(follows your bot|跟着 bot|本\n?会话的路由|session's route|session's own route|the same model|同一个模型)/.test(text),
      "未披露的数据去向是发布前必须拦住的东西");
  }

  // 0.9.3 起判定走宿主 llm 服务。这三条是防回退:任何人把厂商 URL / 密钥名 /
  // 模型名写回 memory-auto.ts,就等于重新造出那个「第二数据去向」。
  const auto = readFileSync(join(ROOT, "lib/memory-auto.js"), "utf-8");
  const code = auto.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  check("分类器不再硬编码任何厂商 endpoint",
    !/https?:\/\/[^"'`\s]*api\./.test(code),
    "memory-auto 的代码里不该出现任何 vendor URL");
  check("分类器不再自己读 API key",
    !/DEEPSEEK_API_KEY|credentials\.yaml/.test(code),
    "密钥解析是宿主 llm 服务的事");
  check("分类器改成注入式判定函数",
    /MemoryJudge/.test(auto) && /judge/.test(code),
    "judge 注入是「跟着 bot 路由走」的实现方式");
  const bridgeSrc = readFileSync(join(ROOT, "lib/bridge.js"), "utf-8");
  check("judge 绑定到当前会话的路由",
    /memoryJudge/.test(bridgeSrc) && /currentRoute\(\)/.test(bridgeSrc),
    "judge 必须用 currentRoute(),否则又会发去别的模型");
  check("judge 关掉思考",
    /reasoningEffort:\s*"off"/.test(bridgeSrc),
    "分类不需要推敲,而且思考会吃掉 maxTokens 让 message 全空");
}

// ------------------------------------------- 自动记忆不收一次性提醒(2026-09-23)
{
  const auto = await import(join(ROOT, "lib/memory-auto.js"));
  const { extractMemoryCandidates: pre, confirmWithLLM } = auto;
  // 预筛选:明确的定时请求、「提醒词 + 具体时间」直接挡掉;提醒词单独出现不挡。
  check("预筛选挡掉明确的定时请求", !pre("三分钟后提醒我来找你") && !pre("到点提醒我喝水"));
  check("预筛选挡掉「别忘了 + 具体时间」", !pre("别忘了明天上午十点开会"));
  check("「请记得 + 事实」照常送判定", pre("请记得我对花生过敏"));
  check("带时间的习惯照常送判定", pre("我习惯晚上十点睡觉") && pre("我每周三下午都有例会"));

  // 兜底:模型被告知不要,仍然偶尔会把提醒归档。用假判定函数模拟它不听话。
  const say = (out) => async () => out;
  const r1 = await confirmWithLLM("我每周三下午都有例会", say('{"section":"提醒事项","fact":"用户每周三下午有例会"}'));
  check("兜底:模型返回「提醒事项」就丢弃，而不是改塞进别的分类", r1 === null);
  const r2 = await confirmWithLLM("我喜欢喝茶", say('{"section":"重要事实","fact":"用户明天上午十点有会议"}'));
  check("兜底:事实里带「明天」这类相对时间就丢弃", r2 === null);
  const r3 = await confirmWithLLM("今天开始我戒奶茶了", say('{"section":"偏好与习惯","fact":"用户戒了奶茶"}'));
  check("兜底:改写后不带相对时间的事实照常保留", r3?.fact === "用户戒了奶茶" && r3?.section === "偏好与习惯");
  const src = readFileSync(join(ROOT, "lib/memory-auto.js"), "utf-8");
  check("分类器的可选分类里没有「提醒事项」",
    !/SECTIONS\s*=\s*\[[^\]]*提醒事项/.test(src));

  // 写入口把关:分类器和 remember_user_info 最终都走 appendMemoryEntry,
  // 两条路当初各自写进过过期提醒(16 + 2 条),所以在这一个地方统一拦。
  // 只测纯函数 —— appendMemoryEntry 会写真实的 memory.md。
  const mem = await import(join(ROOT, "lib/memory.js"));
  const why = mem.oneOffReminderReason;
  check("写入口:「提醒事项」分类一律拒收", why("提醒事项", "用户要记得交作业") !== null && why("remind", "x") !== null);
  check("写入口:带相对时间的条目拒收", why("重要事实", "用户明天上午十点有会议") !== null);
  check("写入口:长期事实照常放行",
    why("重要事实", "用户每周三下午有例会") === null && why("偏好与习惯", "用户喜欢喝茶") === null);
  check("写入口:拒收理由指向 schedule_create（模型读得到，才知道该换工具）",
    /schedule_create/.test(why("提醒事项", "x") ?? ""));
  const memSrc = readFileSync(join(ROOT, "lib/memory.js"), "utf-8");
  check("新建记忆文件的模板里没有「提醒事项」一节", !/## 提醒事项/.test(memSrc));
  const toolSrc = readFileSync(join(ROOT, "lib/tool.js"), "utf-8");
  check("remember_user_info 的说明不再邀请它记提醒", !/reminders for later/.test(toolSrc) && /schedule_create/.test(toolSrc));
}

// ------------------------------------------------ DSH 0.1.7 settings / session v4
{
  const cfg = await import(join(ROOT, "lib/config.js"));
  const { Config, BaseConfig, HOT_FIELDS, snapshotConfig, liveValue, normalizeConfig } = cfg;
  const dict = Config.dict ?? {};
  const hotVolatile = [...HOT_FIELDS].every((k) => dict[k]?.meta?.volatile === true);
  const coldPlain = Object.keys(dict).filter((k) => !HOT_FIELDS.has(k)).every((k) => !dict[k]?.meta?.volatile);
  check("0.1.7: every HOT field is .volatile() in the exported Config", hotVolatile);
  check("0.1.7: no COLD field is volatile (a cold edit must restart the fiber)", coldPlain);
  check("0.1.7: BaseConfig stays plain values", !Object.values(BaseConfig.dict ?? {}).some((f) => f?.meta?.volatile));

  // The host hands hot fields over as live `{ get() }` references. Normalising
  // one directly would fall back to the default — the bot would boot on the
  // harness model with none of its settings. snapshotConfig must unwrap first.
  const raw = { provider: { get: () => "zhipu" }, model: { get: () => "glm-5.3-flash" }, autoStart: true };
  const norm = normalizeConfig(snapshotConfig(raw));
  check("0.1.7: live references are unwrapped before normalising",
    norm.provider === "zhipu" && norm.model === "glm-5.3-flash" && norm.autoStart === true);
  check("0.1.7: liveValue passes plain values through", liveValue("x") === "x" && liveValue(undefined) === undefined);

  const codeOnly = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const idx = codeOnly(readFileSync(join(ROOT, "lib/index.js"), "utf-8"));
  const brg = codeOnly(readFileSync(join(ROOT, "lib/bridge.js"), "utf-8"));
  const rte = codeOnly(readFileSync(join(ROOT, "lib/mcp-route.js"), "utf-8"));
  check("0.1.7: no import of the removed installSettingsSection", !/installSettingsSection/.test(idx));
  check("0.1.7: live edits are adopted on loader/volatile-update", /loader\/volatile-update/.test(idx));
  check("0.1.7: no import of the deleted dsh-agent-presets package",
    !/dsh-agent-presets/.test(brg) && !/dsh-agent-presets/.test(idx));
  // Only `Session.events` was removed (→ `snapshotEvents()`). `sessionQuery
  // .readSurface()` still returns `{ events }`, and mcp-route reads that — a
  // bare /\.events/ would flag a correct call.
  check("0.1.7: nothing reads the removed Session.events",
    !/\bsession\.events\b/.test(brg) && !/\bsession\.events\b/.test(rte));
  // Without this, every reminder is answered in the web UI and never reaches
  // WeChat — silently, because the old `source.plugin === "schedule"` is just false.
  check("0.1.7: scheduled reminders are recognised by kind === \"schedule\"",
    /kind\s*===\s*"schedule"/.test(brg));
}

// ------------------------------------------- 宿主改名不能把整份限制/整页打掉
{
  const bridge = readFileSync(join(ROOT, "src/bridge.ts"), "utf-8");
  // DSH 0.1.5 把 subagent 改名成 subagent_fork。restrict() 遇到不认识的名字会抛,
  // 而原来是一次性传整份 deny —— 于是**一条都没生效**,send_message 又回到了
  // bot 的工具表里(那正是 158 步烧掉 4.5M token 的触发器)。
  check("deny list no longer names the renamed tool \"subagent\"",
    !/^\s+"subagent",$/m.test(bridge),
    "the host renamed it to subagent_fork; an unknown name throws");
  check("tools are restricted one name at a time",
    /tools\.restrict\(\{ deny: \[name\] \}\)/.test(bridge),
    "one unknown name must not take the whole deny list down with it");

  const client = readFileSync(join(ROOT, "lib/client.js"), "utf-8");
  // 客户端模块表里查不到的名字会抛,而客户端 bundle 没有隔离:一抛就是整页
  // 「Failed to load plugins」。0.1.5 把 createSnapshotStore 搬了家,所以两个
  // 名字都要试。
  check("client bundle tries the 0.1.5 snapshot-store name first",
    /"@deepseek-ai\/dsh-client-store"/.test(client));
  check("client bundle still falls back to the pre-0.1.5 name",
    /"@deepseek-ai\/dsh-client-runtime\/client"/.test(client));
  check("the snapshot-store lookup is wrapped so a miss cannot blank the page",
    /try \{[\s\S]{0,200}createSnapshotStore[\s\S]{0,80}\} catch/.test(client));
}

// ------------------------------- 0.1.7-rc.2:旧提醒不会自己搬进宿主任务表
{
  const M = await import(join(ROOT, "lib/schedule-migrate.js"));
  const NOW = Date.parse("2026-01-10T12:00:00.000Z");
  const ev = (data) => ({ type: "schedule/change", data });
  const create = (schedule) => ev({ version: 1, operation: "create", schedule });
  const events = [
    { type: "user/message", data: {} },
    create({ id: "schedule-1", kind: "at", prompt: "提醒:交房租", scheduledAt: "2026-01-11T14:00:00.000Z" }),
    create({ id: "schedule-2", kind: "at", prompt: "提醒:取快递", scheduledAt: "2026-01-09T10:00:00.000Z" }),
    ev({ version: 1, operation: "dispatch", id: "schedule-2" }),
    create({ id: "schedule-3", kind: "after", prompt: "提醒:关烤箱", afterSeconds: 600, scheduledAt: "2026-01-10T11:30:00.000Z" }),
    create({ id: "schedule-4", kind: "at", prompt: "提醒:旧事", scheduledAt: "2026-01-01T09:00:00.000Z" }),
    create({ id: "schedule-5", kind: "at", prompt: "提醒:删掉的", scheduledAt: "2026-02-01T09:00:00.000Z" }),
    ev({ version: 1, operation: "delete", id: "schedule-5" }),
    create({ id: "schedule-6", kind: "every", prompt: "喝水", everySeconds: 3600, scheduledAt: "2026-01-10T10:00:00.000Z" }),
    ev({ version: 1, operation: "dispatch", id: "schedule-6", acceptedAt: "2026-01-10T10:00:05.000Z" }),
    ev({ version: 2, operation: "create", schedule: { id: "schedule-9" } }),
  ];
  const active = M.foldLegacyReminders(events);
  const ids = active.map((r) => r.id).sort().join(",");
  check("legacy fold: dispatched one-shots and deletes drop out, the rest stay",
    ids === "schedule-1,schedule-3,schedule-4,schedule-6", `got ${ids}`);
  check("legacy fold: an every reminder advances past its accepted dispatch",
    active.find((r) => r.id === "schedule-6")?.scheduledAt === "2026-01-10T11:00:00.000Z");

  check("title drops the 提醒: lead-in", M.reminderTitle("提醒:交房租") === "交房租");
  check("title never comes out empty", M.reminderTitle("提醒：") === "提醒");
  check("title stays within the host's 120-char limit", [...M.reminderTitle("长".repeat(500))].length <= 120);

  const plan = M.planLegacyMigration(active, [], new Set(), NOW);
  const by = Object.fromEntries(plan.map((step) => [step.legacy.id, step]));
  check("future one-shot is recreated at the same instant",
    by["schedule-1"]?.action === "create" && by["schedule-1"].request.at === "2026-01-11T14:00:00.000Z"
      && by["schedule-1"].request.title === "交房租");
  check("one-shot that came due within a day is delivered late, like rc.1's catch-up",
    by["schedule-3"]?.action === "create" && by["schedule-3"].request.after_seconds === 60);
  check("one-shot overdue by more than a day is skipped, not fired",
    by["schedule-4"]?.action === "skip");
  check("every reminder is recreated with its interval",
    by["schedule-6"]?.action === "create" && by["schedule-6"].request.every_seconds === 3600);
  check("a request never carries more than one timing selector",
    plan.filter((s) => s.action === "create").every((s) =>
      ["at", "after_seconds", "every_seconds"].filter((k) => k in s.request).length === 1));
  const again = M.planLegacyMigration(active,
    [{ prompt: "提醒:交房租", scheduledAt: "2026-01-11T14:00:00.000Z" }], new Set(["schedule-3"]), NOW);
  check("already-handled ids and hand-made duplicates are not created again",
    !again.some((s) => s.legacy.id === "schedule-3")
      && again.find((s) => s.legacy.id === "schedule-1")?.action === "present");

  check("rc.1 composition (no schedule service) is never mistaken for rc.2",
    !M.isHostSchedule(undefined) && !M.isHostSchedule({ create() {} }));

  // End to end against a fake host service: once, and only once.
  const made = [];
  const fake = {
    async create(sessionId, request) {
      made.push({ sessionId, request });
      return { id: `schedule-host-${made.length}`, scheduledAt: request.at ?? "2026-01-10T12:01:00.000Z" };
    },
    async list() { return []; },
    async catalog() { return []; },
  };
  check("fake host service passes the rc.2 shape check", M.isHostSchedule(fake));
  const dir = join(tmpdir(), `clawbot-migrate-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  const markerPath = join(dir, "schedule-migration.json");
  const first = await M.migrateLegacyReminders({ schedule: fake, sessionId: "wechat-test", events, markerPath, now: () => NOW });
  check("first start recreates the three live reminders in their own session",
    first.created.length === 3 && made.every((m) => m.sessionId === "wechat-test"),
    JSON.stringify(first));
  const second = await M.migrateLegacyReminders({ schedule: fake, sessionId: "wechat-test", events, markerPath, now: () => NOW });
  check("second start creates nothing (marker file)", made.length === 3 && second.created.length === 0,
    JSON.stringify(second));
  const marker = JSON.parse(readFileSync(markerPath, "utf-8"));
  check("marker keeps the skip reason for the stale one",
    marker.sessions["wechat-test"]["schedule-4"]?.status === "skipped");
  rmSync(dir, { recursive: true, force: true });

  // The loader half: with no host `schedule` service the callback never fires.
  const index = readFileSync(join(ROOT, "src/index.ts"), "utf-8");
  check("carry-over is gated on the optional schedule service, not a hard inject",
    /ctx\.inject\(\["schedule"\]/.test(index) && !/export const inject = \[[^\]]*"schedule"/.test(index));
}

// ------------------------------------------- 重置脚本:判活看端口,提醒不进记忆
{
  const reset = readFileSync(join(ROOT, "scripts/reset-wechat-session.sh"), "utf-8");
  const code = reset.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
  check("reset script checks the port, not pgrep -f (self-match trap)",
    !/pgrep\s+-f/.test(code) && /lsof -nP -iTCP:3080 -sTCP:LISTEN/.test(code));
  check("reset script never writes reminders into memory.md",
    !/appendMemoryEntry/.test(code));
  check("reset script never spills the decompressed chat log into /tmp",
    !/\/tmp\//.test(code));
}

// ------------------------------------ 子代理钉的模型必须在宿主目录里真实存在
{
  const index = readFileSync(join(ROOT, "src/index.ts"), "utf-8");
  const pinned = /registerSubagentModelPolicy\(ctx, \{[\s\S]*?provider: "([^"]+)",\s*model: "([^"]+)"/.exec(index);
  const catalogSrc = (() => {
    try { return readFileSync(join(NPX, "@deepseek-ai/dsh-llm-deepseek/lib/index.js"), "utf-8"); }
    catch { return ""; }
  })();
  const builtIn = [...catalogSrc.matchAll(/^\s*id: "([^"]+)",$/gm)].map((m) => m[1]);
  check(`subagent policy model is in the host's DeepSeek catalog (host ${HOST_VERSION})`,
    pinned?.[1] === "deepseek-official" && builtIn.includes(pinned?.[2]),
    `pinned ${pinned?.[1]}/${pinned?.[2]}, catalog [${builtIn.join(", ")}]`);
}

// ---------------------------------------------------- 「对方正在输入…」
{
  const { TypingIndicator } = await import(join(ROOT, "lib/typing.js"));
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const make = (overrides = {}) => {
    const calls = [];
    const state = { configCalls: 0, waiting: false, fail: false };
    const typing = new TypingIndicator({
      getAccount: () => ({ baseUrl: "http://127.0.0.1:9", token: "t" }),
      getContextToken: () => "ctx",
      isWaitingFor: () => state.waiting,
      keepaliveMs: 40,
      api: {
        getConfig: async () => { state.configCalls += 1; return { ret: 0, typing_ticket: "ticket" }; },
        sendTyping: async ({ body }) => {
          if (state.fail) throw new Error("offline");
          calls.push(`${body.ilink_user_id}:${body.status}`);
        },
      },
      ...overrides,
    });
    return { typing, calls, state };
  };
  {
    const h = make();
    h.typing.start("u1"); await sleep(10);
    check("typing shows as soon as a turn starts", h.calls.join() === "u1:1", h.calls.join());
    await sleep(95);
    check("typing is kept alive while the turn runs", h.calls.filter((c) => c === "u1:1").length >= 3, h.calls.join());
    check("the typing ticket is fetched once and reused", h.state.configCalls === 1);
    h.typing.stop(); await sleep(10);
    check("stop cancels the indicator", h.calls.at(-1) === "u1:2", h.calls.join());
    const n = h.calls.length; await sleep(90);
    check("nothing is sent after stop", h.calls.length === n);
  }
  {
    // 2026-10-10: a reply takes the indicator down at once; the wrap-up model
    // call that follows every reply must not keep it up or bring it back.
    const h = make({ quietMs: 120 });
    h.typing.start("u1"); await sleep(10);
    h.typing.noteDelivered("u1"); await sleep(5);
    check("a reply takes typing down at once", h.calls.at(-1) === "u1:2", h.calls.join());
    const n = h.calls.length; await sleep(70);
    check("…and keeps it down through a short wrap-up (no flash after the answer)", h.calls.length === n, h.calls.join());
    await sleep(80);
    check("a long think after a reply brings it back once the quiet window ends", h.calls.slice(n).includes("u1:1"), h.calls.join());
    h.typing.stop();
  }
  {
    const h = make({ quietMs: 500 });
    h.typing.start("u1"); await sleep(10);
    h.typing.noteDelivered("u1"); await sleep(5);
    const n = h.calls.length;
    h.typing.noteWorking("u1"); await sleep(10);
    check("real work after a reply (a tool call) brings typing back right away", h.calls.slice(n).join() === "u1:1", h.calls.join());
    h.typing.noteDelivered("u1"); await sleep(5);
    const m = h.calls.length;
    h.typing.start("u1"); await sleep(10);
    check("a new message from the user after a reply brings it back right away", h.calls.slice(m).join() === "u1:1", h.calls.join());
    h.typing.noteWorking("u1"); await sleep(10);
    check("noteWorking while typing already shows sends nothing extra", h.calls.slice(m).join() === "u1:1", h.calls.join());
    h.typing.stop();
  }
  {
    // 2026-10-20: getconfig turned down requests carrying the context token
    // (ret=-1 "invalid request", no ticket) but answers without it, so typing
    // had silently stopped. The ticket request never carries the token now.
    const asked = [];
    const calls = [];
    const typing = new TypingIndicator({
      getAccount: () => ({ baseUrl: "http://127.0.0.1:9", token: "t" }),
      isWaitingFor: () => false,
      keepaliveMs: 40,
      api: {
        getConfig: async ({ contextToken }) => {
          asked.push(contextToken ?? "none");
          return contextToken ? { ret: -1, errmsg: "invalid request" } : { ret: 0, typing_ticket: "ticket" };
        },
        sendTyping: async ({ body }) => { calls.push(`${body.ilink_user_id}:${body.status}:${body.typing_ticket}`); },
      },
    });
    typing.start("u1"); await sleep(10);
    check("the typing ticket is asked for without the context token (iLink rejects it with one)",
      calls.join() === "u1:1:ticket" && asked.join() === "none", `${asked.join()} | ${calls.join()}`);
    typing.stop();
  }
  {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const calls = [];
    const typing = new TypingIndicator({
      getAccount: () => ({ baseUrl: "http://127.0.0.1:9", token: "t" }),
      getContextToken: () => "ctx",
      isWaitingFor: () => false,
      keepaliveMs: 40,
      quietMs: 500,
      api: {
        getConfig: async () => ({ ret: 0, typing_ticket: "ticket" }),
        sendTyping: async ({ body }) => {
          if (body.status === 1) await gate;
          calls.push(`${body.ilink_user_id}:${body.status}`);
        },
      },
    });
    typing.start("u1"); await sleep(10);
    typing.noteDelivered("u1");
    release(); await sleep(10);
    check("a TYPING still in flight when the reply lands is taken back down", calls.at(-1) === "u1:2", calls.join());
    typing.stop();
  }
  {
    const h = make();
    h.typing.start("u1"); await sleep(10);
    h.state.waiting = true; await sleep(50);
    check("waiting for the user's answer takes typing down", h.calls.at(-1) === "u1:2", h.calls.join());
    const n = h.calls.length; await sleep(90);
    check("no typing while the bot waits on the user", h.calls.slice(n).every((c) => c !== "u1:1"));
    h.state.waiting = false; await sleep(50);
    check("typing comes back once the user has answered", h.calls.at(-1) === "u1:1", h.calls.join());
    h.typing.stop();
  }
  {
    const h = make();
    h.state.fail = true;
    h.typing.start("u1"); await sleep(250);
    check("repeated failures give up instead of retrying forever",
      h.calls.length === 0 && h.state.configCalls <= 3, `configCalls=${h.state.configCalls}`);
    h.typing.stop();
  }
  {
    const h = make();
    h.typing.start("u1"); await sleep(10);
    h.typing.start("u2"); await sleep(10);
    check("a new sender takes over and the old one is cancelled first",
      h.calls.includes("u1:2") && h.calls.at(-1) === "u2:1", h.calls.join());
    h.typing.stop();
  }
  {
    const h = make({ getAccount: () => null });
    h.typing.start("u1"); await sleep(60);
    check("without a bound account nothing is sent and nothing throws", h.calls.length === 0);
    h.typing.stop();
  }
  const bridgeSrc = readFileSync(join(ROOT, "src/bridge.ts"), "utf-8");
  check("typing starts for queued turns, steered messages and reminder turns",
    (bridgeSrc.match(/this\.typing\.start\(/g) ?? []).length >= 3);
  check("a tool call other than a reply brings typing back (noteWorking)",
    /event\.type === "tool\/call" && this\.currentSender[\s\S]{0,200}!REPLY_TOOLS\.has\(name\)\) this\.typing\.noteWorking/.test(bridgeSrc));
  check("talking to the user is not work: text, files and questions keep typing down",
    /REPLY_TOOLS = new Set\(\["send_wechat_text", "send_wechat_file", "ask_user_question"\]\)/.test(bridgeSrc));
  check("typing stops when the queue drains and when a turn nobody drives ends",
    /if \(this\.queue\.length === 0\) \{?\s*this\.typing\.stop\(\)/.test(bridgeSrc)
      && /event\.type === "turn\/end" && !this\.worker\) \{?\s*this\.typing\.stop\(\)/.test(bridgeSrc));
}

// ------------------------------- 宿主的版本门禁(0.1.7 起):peer 范围要放行宿主
// 0.2.0-rc.2 上 `^0.1.7-rc.1` 不再成立,门禁把整个 bundle 跳过——微信监听、MCP 路由、
// 提醒那一行全没了,只在 stderr 留一行 `skipping profile bundle`,dsh 本身照常运行。
// 这里直接调宿主自己的 evaluatePluginCompatibility。检查的是一张**固定的**版本表
// (README 写的支持范围)加上当前宿主——只看当前宿主的话,切换前/回滚后桶是 0.1.7,
// 0.2.0 上会被跳过的 manifest 也能过。
{
  const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
  const SUPPORTED = ["0.1.7-rc.2", "0.2.0-rc.2", "0.2.0"];
  let gate;
  let importError;
  try {
    ({ evaluatePluginCompatibility: gate } = await import(join(NPX, "@deepseek-ai/dsh-app-boot/lib/index.js")));
  } catch (error) { importError = error; }
  if (typeof gate !== "function") {
    // The gate arrived with 0.1.7; older hosts have nothing to check.
    const [, major, minor, patch] = /^(\d+)\.(\d+)\.(\d+)/.exec(HOST_VERSION) ?? [];
    const before017 = major !== undefined && Number(major) === 0 && (Number(minor) < 1 || (Number(minor) === 1 && Number(patch) < 7));
    check(`the host's plugin version gate is importable (host ${HOST_VERSION})`, before017,
      importError ? String(importError.message ?? importError) : "no evaluatePluginCompatibility export");
  } else {
    for (const runtime of new Set([HOST_VERSION, ...SUPPORTED])) {
      const issue = gate(manifest, {}, runtime);
      check(`peerDependencies pass the host's version gate on dsh ${runtime}`, issue === undefined,
        issue && JSON.stringify(issue.peers));
    }
  }
}

// ------------------------- 等回答的那一条不能比等它的人活得久(否则吞下一条消息)
// 回合被停掉/超时之后,登记的问题要从队列里撤掉;不然用户下一条微信会被当成
// 「那个问题的回答」吃掉,既到不了 agent,审批还会多回一句「已批准/已拒绝」。
{
  const { PendingRegistry } = await import(join(ROOT, "lib/pending.js"));
  const { WechatBridge } = await import(join(ROOT, "lib/bridge.js"));
  const { ApprovalRelay } = await import(join(ROOT, "lib/approvals.js"));
  const { InboundRouter } = await import(join(ROOT, "lib/inbound.js"));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // A pending wait must not hold the suite open when a broken build ignores it.
  const within = (promise, ms) => Promise.race([promise, sleep(ms).then(() => "still waiting")]);
  const fakeBridge = (pending, sent) => ({
    currentSender: "u1",
    deps: { pending, getAccount: () => ({ userId: "u1" }) },
    sendTextTo: (_to, text) => { sent.push(text); return true; },
  });

  {
    const pending = new PendingRegistry();
    const sent = [];
    const stop = new AbortController();
    const asked = WechatBridge.prototype.askWechat.call(fakeBridge(pending, sent), "去哪?", 3_000, stop.signal);
    check("a question the bot asks is registered for the sender", pending.hasFor("u1") && sent.length === 1);
    stop.abort();
    // Abort listeners run before abort() returns, so this is synchronous.
    check("stopping the turn withdraws the question at once (the next message is a new turn)", !pending.hasFor("u1"));
    const first = await within(asked, 50);
    check("stopping the turn resolves the question with null right away", first === null, String(first));
  }
  {
    const pending = new PendingRegistry();
    const approval = { tag: "approval", sender: "u1", resolve: () => {} };
    pending.push(approval);
    const asked = WechatBridge.prototype.askWechat.call(fakeBridge(pending, []), "去哪?", 20);
    check("an unanswered question times out with null", (await within(asked, 500)) === null);
    check("a timed-out question withdraws only itself, not the sender's other pending items",
      pending.popFor("u1") === approval && !pending.hasFor("u1"));
  }
  const relayWith = (pending, sendText) => new ApprovalRelay({
    config: { approvalTimeoutMs: 0 },
    getBridge: () => ({ isWechatSession: () => true, activeSender: "u1" }),
    pending,
    sendText,
  });
  const approvalRequest = (signal) => ({ agent: { id: "a1" }, toolName: "bash", reason: "测试", signal });
  {
    const pending = new PendingRegistry();
    const sent = [];
    const relay = relayWith(pending, async (_to, text) => { sent.push(text); });
    const stop = new AbortController();
    const outcome = relay.answer(approvalRequest(stop.signal), async () => "allowed-once");
    await sleep(5);
    check("an approval request waits on the WeChat sender", pending.hasFor("u1"));
    stop.abort();
    check("an aborted approval settles as cancelled", (await within(outcome, 500)) === "cancelled");
    check("an aborted approval leaves the queue", !pending.hasFor("u1"));
    const late = pending.popFor("u1");
    check("no stray 已批准/已拒绝 is sent for a withdrawn approval",
      late === undefined && !sent.some((t) => /已批准|已拒绝/.test(t)), sent.join(" | "));
  }
  {
    // The iLink send can take seconds; a turn stopped meanwhile has already
    // fired its abort, and a listener added after that never runs.
    const pending = new PendingRegistry();
    const relay = relayWith(pending, () => sleep(40));
    const stop = new AbortController();
    const outcome = relay.answer(approvalRequest(stop.signal), async () => "allowed-once");
    await sleep(10);
    stop.abort();
    check("an approval stopped while its question is still being sent settles as cancelled",
      (await within(outcome, 500)) === "cancelled");
    check("…and never enters the queue", !pending.hasFor("u1"));
  }

  // 每轮 10 条的上限:提醒那一轮也是新的一轮;被丢掉的那条要让调用方知道。
  {
    const fake = {
      sessionId: "S", worker: undefined, turnMessageCount: 10, currentSender: undefined,
      typing: { start() {}, stop() {} },
      deps: { getAccount: () => ({ userId: "owner" }) },
      ctx: { agents: { get: () => undefined } },
      installSelection() {}, ensureTools() {},
    };
    WechatBridge.prototype.onSessionEvent.call(fake, { id: "S" },
      { type: "user/message", seq: 1, data: { source: { kind: "schedule" } } });
    check("a reminder turn goes to the owner with a fresh 10-message budget",
      fake.currentSender === "owner" && fake.turnMessageCount === 0, `count=${fake.turnMessageCount}`);
  }
  {
    const out = [];
    const fake = {
      turnMessageCount: 10, sendChain: Promise.resolve(),
      sendText: async (_to, text) => { out.push(text); },
      typing: { noteDelivered() {} },
    };
    const dropped = WechatBridge.prototype.sendTextTo.call(fake, "u1", "第 11 条");
    const asked = WechatBridge.prototype.sendTextTo.call(fake, "u1", "要继续吗?", { uncapped: true });
    await fake.sendChain;
    check("past the per-turn cap a message is dropped and the caller is told so", dropped === false);
    check("a question the bot then waits on is never dropped by the cap",
      asked === true && out.join() === "要继续吗?", out.join());
  }
  const toolSrc = readFileSync(join(ROOT, "src/tool.ts"), "utf-8");
  check("send_wechat_text reports a capped message as not sent",
    /if \(!bridge\.sendTextTo\(sender, finalText\)\)\s*\{\s*return \{ ok: false/.test(toolSrc));
  check("the WeChat ask_user_question forwards the turn's abort signal",
    /askWechat\(q, undefined, exec\.signal\)/.test(toolSrc));

  // 等回答时,语音回复也算回答;没有文字的(视频、图片)不算回答,但也不能被吃掉。
  {
    const state = join(tmpdir(), `clawbot-inbound-${process.pid}`);
    mkdirSync(state, { recursive: true });
    const prevState = process.env.CLAWBOT_STATE_DIR;
    process.env.CLAWBOT_STATE_DIR = state;
    try {
      const make = () => {
        const pending = new PendingRegistry();
        const notices = [];
        const enqueued = [];
        const router = new InboundRouter({
          config: { allowFrom: [] },
          account: { accountId: "acc", userId: "u1", cdnBaseUrl: "http://127.0.0.1:9" },
          bridge: { enqueueMessage: async (...args) => { enqueued.push(args); }, noteIncoming: () => {} },
          pending,
          sendText: async (_to, text) => { notices.push(text); },
        });
        const answers = [];
        pending.push({ tag: "question", sender: "u1", resolve: (reply) => answers.push(reply) });
        return { router, pending, notices, enqueued, answers };
      };
      {
        const h = make();
        await h.router.handle({ from_user_id: "u1", item_list: [{ type: 3, voice_item: { text: "去北京。" } }] });
        check("a voice reply answers the pending question with WeChat's transcript",
          h.answers.length === 1 && h.answers[0] === "去北京。" && h.enqueued.length === 0, JSON.stringify(h.answers));
      }
      {
        const h = make();
        await h.router.handle({ from_user_id: "u1", item_list: [{ type: 5 }] });
        check("a reply with no text withdraws the question as unanswered", h.answers.length === 1 && h.answers[0] === null
          && !h.pending.hasFor("u1"));
        check("…and the message itself still goes through the normal path (not swallowed)",
          h.notices.some((t) => /视频/.test(t)), h.notices.join(" | "));
      }
    } finally {
      if (prevState === undefined) delete process.env.CLAWBOT_STATE_DIR; else process.env.CLAWBOT_STATE_DIR = prevState;
      rmSync(state, { recursive: true, force: true });
    }
  }
}

// ------------------------------------------------ 空闲时整理对话(2026-10-04)
// 宿主的自动压缩挂在 agent/pre-step:机主的消息一来就先压,回复要等(那天等了 17 秒)。
// clawbot 改成回复结束、安静一段时间后,趁空闲用宿主自己的 /compact 压掉。
{
  const { IdleCompactor, hostCompactionThreshold } = await import(join(ROOT, "lib/idle-compact.js"));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  check("host threshold, 400k window: 301,696 (why 296k never compacted)", hostCompactionThreshold(400000, 32768) === 301696);
  check("host threshold, 340k window: 241,696", hostCompactionThreshold(340000, 32768) === 241696);
  check("host threshold, 1M window: capped at 80%", hostCompactionThreshold(1000000, 32768) === 800000);
  check("host threshold: none when the window leaves no budget", hostCompactionThreshold(64000, 32768) === undefined);

  const make = (over = {}) => {
    const calls = [];
    const compactor = new IdleCompactor({
      enabled: () => true,
      isBusy: () => false,
      lastRequestTokens: () => 230000,
      hostThreshold: async () => 241696,
      compact: async () => { calls.push(1); return { ok: true, text: "Compacted 10 history items" }; },
      delayMs: 20,
      ...over,
    });
    return { compactor, calls };
  };
  {
    const h = make();
    h.compactor.noteIdle(); await sleep(5);
    check("idle compaction waits for the quiet period", h.calls.length === 0);
    await sleep(40);
    check("after the quiet period a session near the threshold is compacted once", h.calls.length === 1);
  }
  {
    const h = make({ lastRequestTokens: () => 150000 });
    h.compactor.noteIdle(); await sleep(40);
    check("a session well below the threshold is left alone", h.calls.length === 0);
  }
  {
    const h = make();
    h.compactor.noteIdle(); await sleep(5); h.compactor.noteActivity(); await sleep(40);
    check("a message during the quiet period cancels the check", h.calls.length === 0);
  }
  {
    const h = make({ isBusy: () => true });
    h.compactor.noteIdle(); await sleep(40);
    check("a busy session (turn running, queued, or waiting on an answer) is not compacted", h.calls.length === 0);
  }
  {
    const h = make({ enabled: () => false });
    h.compactor.noteIdle(); await sleep(40);
    check("the idleCompaction switch turns it off", h.calls.length === 0);
  }
  {
    const h = make();
    h.compactor.noteIdle(); await sleep(5); h.compactor.noteIdle(); await sleep(5); h.compactor.noteIdle(); await sleep(40);
    check("several turns ending in a row compact at most once", h.calls.length === 1);
  }
  {
    let used = 230000;
    const h = make({ lastRequestTokens: () => used, onCompacted: () => { used = undefined; } });
    await h.compactor.check(); await h.compactor.check();
    check("after compacting, the stale size is forgotten (no second compaction)", h.calls.length === 1);
  }
  {
    const h = make({ compact: async () => { throw new Error("boom"); } });
    let threw = false;
    try { await h.compactor.check(); } catch { threw = true; }
    check("a failing compaction never throws into the bridge", !threw);
  }
  // idleCompactionTokens (2026-10-19): the bot's own trigger, so the model's window — shared with the
  // web UI — can stay large. A model with a 1M window and 384K output → host threshold 550,464.
  check("host threshold, 1M window with 384K output: 550,464", hostCompactionThreshold(1000000, 384000) === 550464);
  {
    const h = make({ lastRequestTokens: () => 310000, hostThreshold: async () => 550464, fixedTrigger: () => 300000 });
    await h.compactor.check();
    check("a configured trigger compacts at its own size, well below 85% of a large host threshold", h.calls.length === 1);
  }
  {
    const h = make({ lastRequestTokens: () => 230000, hostThreshold: async () => 241696, fixedTrigger: () => 300000 });
    await h.compactor.check();
    check("a configured trigger above the size leaves the session alone even when 85% of the host threshold would compact",
      h.calls.length === 0);
  }
  {
    const h = make({ lastRequestTokens: () => 310000, hostThreshold: async () => { throw new Error("no route"); }, fixedTrigger: () => 300000 });
    await h.compactor.check();
    check("a configured trigger still works when the host threshold cannot be read", h.calls.length === 1);
  }
  {
    const h = make({ lastRequestTokens: () => 230000, fixedTrigger: () => undefined });
    await h.compactor.check();
    check("without a configured trigger it stays 85% of the host threshold", h.calls.length === 1);
  }
  const bridgeSrc = readFileSync(join(ROOT, "src/bridge.ts"), "utf-8");
  check("the quiet-period clock starts when the queue drains and when a turn nobody drives ends",
    (bridgeSrc.match(/this\.idleCompact\.noteIdle\(\)/g) ?? []).length >= 2);
  check("an inbound message or a new turn cancels the pending check",
    /async enqueueMessage\([^)]*\)[^{]*\{\s*this\.idleCompact\.noteActivity\(\)/.test(bridgeSrc)
      && /"turn\/start"\) this\.idleCompact\.noteActivity\(\)/.test(bridgeSrc));
  check("it runs the host's own /compact through the command registry",
    /commands\.execute\(agent, "\/compact", \[\], signal\)/.test(bridgeSrc));
  check("the request size is the provider-reported usage", /usage\?: \{ totalTokens\?/.test(bridgeSrc));
  const clientSrc = readFileSync(join(ROOT, "src/client.js"), "utf-8");
  check("the settings card has the switch", /set\("idleCompaction", next\)/.test(clientSrc));
  const cfgMod = await import(join(ROOT, "lib/config.js"));
  check("idleCompaction is on by default and takes effect without a restart",
    cfgMod.DEFAULT_CONFIG.idleCompaction === true && cfgMod.HOT_FIELDS.has("idleCompaction"));
  const norm = (v) => cfgMod.normalizeConfig({ ...cfgMod.DEFAULT_CONFIG, idleCompactionTokens: v }).idleCompactionTokens;
  check("idleCompactionTokens: unset by default, hot, on the card, and 0 / junk mean \"automatic\"",
    cfgMod.DEFAULT_CONFIG.idleCompactionTokens === undefined && cfgMod.HOT_FIELDS.has("idleCompactionTokens")
      && /num\("idleCompactionTokens", e\.target\.value, 10000\)/.test(clientSrc)
      && norm(300000) === 300000 && norm(0) === undefined && norm(-5) === undefined && norm("300000") === undefined,
    JSON.stringify([norm(300000), norm(0), norm(-5), norm("300000")]));
  check("the bridge hands the configured trigger to the compactor", /fixedTrigger: \(\) => this\.config\.idleCompactionTokens/.test(bridgeSrc));
}

// ------------------------------------------- 宿主的时钟读数不进微信会话(DSH 0.2.1,2026-10-17)
// 0.2.1 把 dsh-time-context 放进了标准预设:微信消息没有浏览器时区,读数永远写着
// 「unavailable. Ask the user to clarify」,bot 会反问时区。它是 prepend 的 pre-step 监听器,
// 挂在 agent 自己的作用域里;cordis 的 waterfall 从外往里调、prepend 插到最前面,
// 所以只有在预设挂好之后才挂的过滤器在它外面。
{
  const tc = await import(join(ROOT, "lib/time-context.js"));
  const reading = { id: "r1", role: "user", source: { kind: "time-context" }, content: [{ type: "text", text: "2026-10-17T15:00 … unavailable. Ask the user to clarify" }] };
  const wechat = { id: "w1", role: "user", source: { kind: "plugin:wechat-clawbot" }, content: [{ type: "text", text: "[微信消息] 明天下午三点提醒我" }] };
  const kept = tc.stripClockReadings({ kind: "continue", messages: [wechat, reading] });
  check("clock readings: only the reading is dropped", kept.dropped === 1 && kept.decision.messages.length === 1 && kept.decision.messages[0] === wechat);
  const reject = { kind: "reject", messages: [reading] };
  check("clock readings: a rejected step is left as it is", tc.stripClockReadings(reject).decision === reject);

  // cordis semantics, as read in its source: listeners run in list order, the
  // first one outermost; `prepend` unshifts.
  const bus = () => {
    const list = [];
    const ctx = { on: (name, listener, options) => { const entry = { name, listener }; options?.prepend ? list.unshift(entry) : list.push(entry); return () => list.splice(list.indexOf(entry), 1); } };
    const run = async (args) => {
      const queue = list.filter((e) => e.name === "agent/pre-step").map((e) => e.listener);
      const next = () => (queue.shift() ?? (async () => ({ kind: "continue", messages: [wechat] })))(args, next);
      return next();
    };
    return { ctx, run };
  };
  const clock = async (_args, next) => { const d = await next(); return { ...d, messages: [...d.messages, reading] }; };
  const isWechat = (id) => id === "wechat-main";
  {
    const { ctx, run } = bus();
    ctx.on("agent/pre-step", clock, { prepend: true });            // the preset mounts first …
    tc.registerClockReadingFilter(ctx, isWechat);                    // … ensureTools afterwards
    const d = await run({ agent: { id: "wechat-main" } });
    check("clock readings: registered after the preset, the filter keeps the reading out of the WeChat step",
      d.messages.length === 1 && d.messages[0] === wechat);
    const web = await run({ agent: { id: "session-web" } });
    check("clock readings: other sessions keep them", web.messages.some((m) => m.source.kind === "time-context"));
  }
  {
    const { ctx, run } = bus();
    tc.registerClockReadingFilter(ctx, isWechat);                    // registered first (as at plugin start) …
    ctx.on("agent/pre-step", clock, { prepend: true });            // … the clock ends up outside it
    const d = await run({ agent: { id: "wechat-main" } });
    check("clock readings: a filter registered before the preset cannot see them (why it lives in ensureTools)",
      d.messages.some((m) => m.source.kind === "time-context"));
  }
  const bridgeSrc = readFileSync(join(ROOT, "src/bridge.ts"), "utf-8");
  check("clock readings: ensureTools registers the filter on the agent's scope, after the preset mount, and takes it back on dispose",
    /await agentPresets\.mount\(agentCtx\);[\s\S]{0,1200}this\.ensureTools\(agentCtx\);/.test(bridgeSrc)
    && /const offClock = registerClockReadingFilter\(target, \(id\) => this\.isWechatSession\(id\)\);\s*if \(typeof offClock === "function"\) this\.toolDisposers\.push/.test(bridgeSrc));
  const hostClock = join(NPX, "@deepseek-ai/dsh-time-context/lib/index.js");
  if (existsSync(hostClock)) {
    const { name } = await import(hostClock);
    check(`clock readings: the host's dsh-time-context still tags its readings "${tc.TIME_CONTEXT_KIND}"`, name === tc.TIME_CONTEXT_KIND, `host says ${name}`);
  }
}

// ------------------------------- 工作目录说明文件不进微信会话(可选,2026-10-04)
// DSH 的 agent-instructions:工具碰过某个目录,就把那里的 CLAUDE.md / AGENTS.md 塞进对话,
// 之后文件每改一次再塞一整份。一份常改的长说明文件,几次下来微信会话里就攒了好几份全文(~14 万字)。
{
  const { stripWorkspaceInstructions, registerWorkspaceInstructionsFilter, isWorkspaceInstructions } =
    await import(join(ROOT, "lib/workspace-instructions.js"));
  const instr = (id, scope) => ({ id, role: "user", content: [{ type: "text", text: "<system-reminder>…" }],
    source: { kind: "agent-instructions", form: "instructions", changes: [{ action: "replace", scope }] } });
  const userMsg = { id: "u1", role: "user", content: [{ type: "text", text: "[微信消息] 你好" }], source: { kind: "plugin:wechat-clawbot" } };
  const makeAgent = (id, parked = []) => {
    const nextStep = [...parked];
    return { id, inbox: { get nextStep() { return [...nextStep]; }, remove: (mid) => { const i = nextStep.findIndex((m) => m.id === mid); if (i >= 0) nextStep.splice(i, 1); }, _list: nextStep } };
  };
  {
    const agent = makeAgent("wechat-main", [instr("p1", "project\u0000CLAUDE.md")]);
    const { decision, dropped } = stripWorkspaceInstructions(agent,
      { kind: "continue", messages: [userMsg, instr("m1", "project\u0000CLAUDE.md")] });
    check("instruction files spliced into the step are dropped", decision.messages.length === 1 && decision.messages[0] === userMsg);
    check("instruction files parked in the next-step inbox are dropped", agent.inbox._list.length === 0);
    check("the log names the files, not their content", dropped.length === 2 && dropped.every((s) => s === "project/CLAUDE.md"));
  }
  {
    const d = { kind: "reject" };
    check("a rejected step is left exactly as the host decided", stripWorkspaceInstructions(makeAgent("wechat-main"), d).decision === d);
    const plain = { kind: "continue", messages: [userMsg] };
    check("a step without instruction files keeps the same decision object", stripWorkspaceInstructions(makeAgent("wechat-main"), plain).decision === plain);
    check("only agent-instructions messages count", isWorkspaceInstructions(instr("x", "a")) && !isWorkspaceInstructions(userMsg));
  }
  {
    let registered;
    const fakeCtx = { on(name, listener, options) { registered = { name, listener, options }; } };
    let strip = true;
    registerWorkspaceInstructionsFilter(fakeCtx, (id) => strip && id === "wechat-main");
    check("the filter hooks agent/pre-step as the outermost listener (prepend)",
      registered.name === "agent/pre-step" && registered.options?.prepend === true);
    const hostDecision = () => Promise.resolve({ kind: "continue", messages: [userMsg, instr("m2", "project\u0000CLAUDE.md")] });
    const mine = await registered.listener({ agent: makeAgent("wechat-main") }, hostDecision);
    check("the WeChat session's step goes out without the instruction file", mine.messages.length === 1);
    const web = await registered.listener({ agent: makeAgent("session-web-1") }, hostDecision);
    check("any other session keeps it (web, subagents)", web.messages.length === 2);
    strip = false;
    const on = await registered.listener({ agent: makeAgent("wechat-main") }, hostDecision);
    check("with workspaceInstructions on (the default) nothing is filtered", on.messages.length === 2);
    strip = true;
    const broken = await registered.listener({ agent: { id: "wechat-main", inbox: { get nextStep() { throw new Error("boom"); }, remove() {} } } }, hostDecision);
    check("a surprise inside the filter leaves the host's decision untouched", broken.messages.length === 2);
  }
  const cfgMod2 = await import(join(ROOT, "lib/config.js"));
  check("workspaceInstructions defaults to the host's behaviour and is hot",
    cfgMod2.DEFAULT_CONFIG.workspaceInstructions === true && cfgMod2.HOT_FIELDS.has("workspaceInstructions"));
  const indexSrc = readFileSync(join(ROOT, "src/index.ts"), "utf-8");
  check("only the WeChat session is filtered, and only when the owner turned it off",
    /config\.workspaceInstructions === false && \(bridge\?\.isWechatSession\(agentId\)/.test(indexSrc));
  check("the settings card has the switch", /set\("workspaceInstructions", next\)/.test(readFileSync(join(ROOT, "src/client.js"), "utf-8")));
}

// ----------------------------------------- Codex 联动默认关、关着不占 token(0.9.9)
// PR #1 把 5 个 Codex 工具和一条 G14 规则无条件塞进每次微信请求(~3.35k 字),开关只拦调用。
// 现在:默认关;关着时工具不注册、提示词里没有 Codex 规则;开关是冷字段(改动重启监听、重建工具表)。
{
  const cfgMod3 = await import(join(ROOT, "lib/config.js"));
  check("codexPeer is off by default", cfgMod3.DEFAULT_CONFIG.codexPeer === false && cfgMod3.normalizeConfig({}).codexPeer === false);
  // Hot since 2026-10-14: the card can only write volatile fields (as a cold
  // field the switch silently did nothing), and a flip restarts the WeChat
  // listener in place, which rebuilds the tool list.
  check("codexPeer flips rebuild the tool list (hot field + listener restart)",
    cfgMod3.HOT_FIELDS.has("codexPeer") && /key === "macCalendar" \|\| key === "codexPeer"/.test(readFileSync(join(ROOT, "src/index.ts"), "utf-8")));
  const bridgeSrc = readFileSync(join(ROOT, "src/bridge.ts"), "utf-8");
  check("Codex tools are registered only when the switch is on",
    /const codex = this\.deps\.codexPeer !== undefined && this\.config\.codexPeer === true;\s*if \(codex\) registerCodexPeerTools/.test(bridgeSrc));
  const promptSrc = readFileSync(join(ROOT, "src/prompt.ts"), "utf-8");
  check("the system prompt carries no Codex rule (guidance lives in the tool descriptions)",
    !/G14|codex_session|codex_progress|list_codex/.test(promptSrc));
  const peerSrc = readFileSync(join(ROOT, "src/codex-peer.ts"), "utf-8");
  check("the folded guidance is in the tool descriptions",
    /never guess/.test(peerSrc) && /before reporting a result/.test(peerSrc) && /when each report was updated/.test(peerSrc));
  check("the settings card shows the switch as default-off", /on: v\.codexPeer === true/.test(readFileSync(join(ROOT, "src/client.js"), "utf-8")));
  const rpcSrc = readFileSync(join(ROOT, "src/codex-rpc.ts"), "utf-8");
  check("ws is not a value import on the plugin's load path (a missing ws cannot take the bot down)",
    !/^import WebSocket from "ws"/m.test(rpcSrc) && /import\("ws"\)/.test(rpcSrc));
  const mcpSrc = readFileSync(join(ROOT, "src/mcp-server.ts"), "utf-8");
  check("clawbot-mcp: driving a DSH session is marked destructive + open-world (Codex asks first)",
    /const drives = \{[^}]*destructiveHint: true[^}]*openWorldHint: true/.test(mcpSrc) && /annotations: drives/.test(mcpSrc));
  check("clawbot-mcp: the WeChat notification is marked open-world", /const messages = \{[^}]*openWorldHint: true/.test(mcpSrc) && /annotations: messages/.test(mcpSrc));
}

// ------------------------------- 同一进程只留一个 clawbot 实例(2026-10-08)
// DSH 就地重载插件(改冷字段 / 热重载代码)时从来没调用过我们的卸载函数:10-07 改了两次设置,
// 三套微信长轮询同时在跑,每条消息被处理三遍,旧实例的「正在输入」永远停不下来。
{
  const { claimInstance } = await import(join(ROOT, "lib/instance-guard.js"));
  claimInstance(async () => {}).release(); // start from an empty slot
  const stopped = [];
  const first = claimInstance(async (reason) => { stopped.push(["first", reason]); });
  await first.ready;
  check("the first instance starts without waiting for anyone", stopped.length === 0 && first.isCurrent());
  let releaseThirdStop;
  const slowStop = new Promise((resolve) => { releaseThirdStop = resolve; });
  const second = claimInstance(async (reason) => { stopped.push(["second", reason]); });
  check("a newer instance takes the slot at once", second.isCurrent() && !first.isCurrent());
  await second.ready;
  check("…and retires the older one before it may start", stopped.length === 1 && stopped[0][0] === "first"
    && stopped[0][1] === `superseded by instance #${second.id}`);
  const third = claimInstance(async () => { await slowStop; throw new Error("boom"); });
  const fourth = claimInstance(async () => {});
  let fourthReady = false;
  void fourth.ready.then(() => { fourthReady = true; });
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  check("the second one was retired too", stopped.length === 2 && stopped[1][0] === "second");
  check("a newer instance waits until the older one has actually stopped", fourthReady === false);
  releaseThirdStop();
  await fourth.ready;
  check("a stop that throws still lets the new instance start", fourthReady === true && third.id < fourth.id);
  third.release();
  check("releasing a slot you no longer hold changes nothing", fourth.isCurrent());
  fourth.release();
  const fifth = claimInstance(async () => {});
  await fifth.ready;
  check("after our own unload the next instance starts fresh", fifth.isCurrent());
  fifth.release();
  // An instance started by a version whose slot key carried the package name
  // (the dev name, or the public one) is retired too.
  const legacyStopped = [];
  for (const name of [["dsh", "plugin", "clawbot"].join("-"), "wechat-clawbot"]) {
    globalThis[Symbol.for(`${name}/active-instance`)] = { seq: 7, active: { id: 7, stop: async (reason) => { legacyStopped.push([name, reason]); } } };
  }
  const sixth = claimInstance(async () => {});
  await sixth.ready;
  check("an instance left under an old package-name key is retired as well",
    legacyStopped.length === 2 && legacyStopped.every(([, reason]) => reason === `superseded by instance #${sixth.id}`)
    && globalThis[Symbol.for("wechat-clawbot/active-instance")].active === undefined);
  sixth.release();
  const indexSrc = readFileSync(join(ROOT, "src/index.ts"), "utf-8");
  check("the monitor starts only after the older instance stopped, and only while current",
    /void claim\.ready\.then\(\(\) => \{\s*if \(claim\.isCurrent\(\)\) startMonitor\(\);/.test(indexSrc));
  check("a retired or unloaded instance never starts a monitor again", /if \(monitorTask \|\| superseded\) return;/.test(indexSrc));
  check("retiring stops the monitor, the Codex peer and the account watcher",
    /claimInstance\(async \(reason\) => \{\s*superseded = true;[\s\S]{0,200}watcher\.close\(\);\s*codexPeer\.close\(\);\s*await stopMonitor\(reason\);/.test(indexSrc));
  check("our own unload gives the slot up", /claim\.release\(\);/.test(indexSrc));
}

// ----------------------------- 连着发的几条一起回复(机主选的混合方式,参照 Claude Code)
// 2026-10-12:机主先发图再打字,bot 4 秒内就回了图(字一般 7 秒后才到),再单独回字。机主定的:图片马上处理、
// 不等;bot 还在第一次思考(没调工具、没发东西)时来了新消息,立刻打断重想(Claude Code 的 Ctrl+Enter);
// 已经在干活就等这一步做完再读(Claude Code 的回车);要发回复时先读完新消息。
{
  const { mayRestartTurn, shouldHoldReply, MAX_RESTARTS, MAX_HOLDS, TOGETHER_HINT, HOLD_MESSAGE } = await import(join(ROOT, "lib/coalesce.js"));
  const base = { wechatTurn: true, turnSender: "u1", sender: "u1", recorded: true, toolCalls: 0, restarts: 0 };
  check("still on its first thought: a newer message restarts the turn", mayRestartTurn(base));
  check("…only once the host has written the first message into the history (else it is lost)", !mayRestartTurn({ ...base, recorded: false }));
  check("once the bot has called a tool (work or a reply) it is steered in instead", !mayRestartTurn({ ...base, toolCalls: 1 }));
  check("a message from someone else never restarts the turn", !mayRestartTurn({ ...base, sender: "u2" }));
  check("reminder and web-UI turns are never restarted", !mayRestartTurn({ ...base, wechatTurn: false }));
  check("restarts are capped so a long burst still gets answered", !mayRestartTurn({ ...base, restarts: MAX_RESTARTS }));
  check("a reply waits while the recipient has a message the next step will read", shouldHoldReply({ unread: true, holds: 0 }));
  check("nothing unread: the reply goes out", !shouldHoldReply({ unread: false, holds: 0 }));
  check("holds are capped too", !shouldHoldReply({ unread: true, holds: MAX_HOLDS }));
  check("the hint asks for one answer; a held reply says not to resend it as is",
    /一次回复/.test(TOGETHER_HINT) && /别把这条原样重发/.test(HOLD_MESSAGE));
  const bridgeSrc = readFileSync(join(ROOT, "src/bridge.ts"), "utf-8");
  const toolSrc = readFileSync(join(ROOT, "src/tool.ts"), "utf-8");
  const cancelAt = bridgeSrc.indexOf("live.cancel({ kind: \"hook\"");
  const followAt = bridgeSrc.indexOf("live.followup(restart)");
  check("restart cancels with the inbox kept, as a plugin (hook) cancellation",
    cancelAt > 0 && /keepInbox: true/.test(bridgeSrc.slice(cancelAt, cancelAt + 200)));
  check("…and follows up only after cancelling (the other order leaves the message unwoken)", followAt > cancelAt);
  check("merge into a waiting message is tried before a restart",
    bridgeSrc.indexOf("this.mergeIntoWaitingTurn(live, sender, parts, text)") > 0
      && bridgeSrc.indexOf("this.mergeIntoWaitingTurn(live, sender, parts, text)") < bridgeSrc.indexOf("mayRestartTurn({"));
  check("the turn's message counts as recorded only when the host writes it, pinned to that turn and step",
    /event\.type === "user\/message" && this\.turnMessage !== undefined[\s\S]{0,120}=== this\.turnMessage\.id\)/.test(bridgeSrc)
      && /recordedAt: \{ turn: this\.hostTurn, step: this\.hostStep \}/.test(bridgeSrc)
      && /this\.turnMessage\.recordedAt\.turn === this\.hostTurn && this\.turnMessage\.recordedAt\.step === this\.hostStep/.test(bridgeSrc));
  check("no waiting for a caption any more", !/CaptionHold|mediaCaptionWaitMs|mediaOnly/.test(bridgeSrc)
    && !/mediaOnly/.test(readFileSync(join(ROOT, "src/inbound.ts"), "utf-8"))
    && !/mediaCaptionWaitMs/.test(readFileSync(join(ROOT, "src/config.ts"), "utf-8")));
  check("all three reply tools read before replying",
    (toolSrc.match(/if \(await bridge\.holdReply\(sender, exec\?\.signal\)\) return \{ ok: false, held: true, message: bridge\.holdMessage \};/g) ?? []).length === 2
      && /if \(recipient && await bridge\.holdReply\(recipient, exec\.signal\)\) return \{ ok: false, message: bridge\.holdMessage \};/.test(toolSrc));
  check("…and send nothing once the turn has been stopped while they waited",
    (toolSrc.match(/if \(exec\?\.signal\?\.aborted\) return \{ ok: false, message: "这一轮已经停止/g) ?? []).length === 2
      && /if \(exec\.signal\?\.aborted\) return \{ ok: false, message: "这一轮已经停止，没有提问。" \};/.test(toolSrc));
  check("unread = waiting for the next step (a message queued for a later turn does not hold a reply)",
    /const waiting = new Set<string>\(\(inbox\?\.nextStep \?\? \[\]\)\.map\(\(m\) => m\.id\)\);/.test(bridgeSrc));
  check("queued messages from one sender go into one turn",
    /while \(this\.queue\.length > 0 && this\.queue\[0\]\.sender === first\.sender\) batch\.push/.test(bridgeSrc));
  // The host behaviour this relies on, read from dsh-agent-loop / dsh-agent.
  const loopPath = join(NPX, "@deepseek-ai/dsh-agent-loop/lib/index.js");
  const loopSrc = existsSync(loopPath) ? readFileSync(loopPath, "utf-8") : "";
  check("host: a wake after an abort opens the next turn (cancel → followup restarts)",
    /wakingAfterAbort/.test(loopSrc) && /keepInbox/.test(loopSrc) && /wakeRequested = true/.test(loopSrc));
  check("host: a claimed message is written into the history only when its step starts (why a restart waits)",
    /this\.inbox\.claim\(target, position\.turn\)/.test(loopSrc) && /if \(firstAttempt\) for \(const message of decision\.messages\)/.test(loopSrc));
  check("host: steer goes to the next step, and a step boundary takes every steered message at once",
    /steer\(input\) \{\s*this\.send\(input, "next-step", true\);/.test(loopSrc)
      && /const claimed = this\.mutate\("next-step", 0, this\.nextStep\.length, \[\], false\);/.test(loopSrc));
  check("host: a turn goes on while steered input waits (it does not end with it unread)",
    /if \(turnEnds && this\.inbox\.nextStep\.length === 0\) break;/.test(loopSrc));
  const agentTypesPath = join(NPX, "@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts");
  const agentTypes = existsSync(agentTypesPath) ? readFileSync(agentTypesPath, "utf-8") : "";
  check("host: agents expose the inbox (nextStep, replace)",
    /readonly inbox: Inbox;/.test(agentTypes) && /readonly nextStep: readonly UserMessage\[\];/.test(agentTypes)
      && /replace\(messageId: MessageId, newMessage: UserMessage\): boolean;/.test(agentTypes));
}

// ------------------------- 同一套路由,接一个照宿主语义写的假 agent 整条跑一遍
// 宿主 0.2.0 的 agent-loop:一轮开始就把消息从 inbox 里取走,到这一步真正开始才写进历史;steer 进 next-step,
// 下一步开始时连同其他 steer 一起取走;cancel 中止当前活动,中止后再 wake 的消息排到下一轮并被记住;whenIdle
// 跟到接替的那一轮;维护任务(压缩)期间 wake 进来的消息先等着。假 agent 的「回复」走真 bridge 的 holdReply。
{
  const { WechatBridge } = await import(join(ROOT, "lib/bridge.js"));
  const { Backlog } = await import(join(ROOT, "lib/backlog.js"));
  const { setLogLevel } = await import(join(ROOT, "lib/ilink/util/logger.js"));
  const { DEFAULT_CONFIG } = await import(join(ROOT, "lib/config.js"));
  const { TOGETHER_HINT, MAX_HOLDS, MAX_RESTARTS } = await import(join(ROOT, "lib/coalesce.js"));
  setLogLevel("error");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const abortableSleep = (ms, signal) => new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  const textOf = (m) => m.content.filter((b) => b.type === "text").map((b) => b.text.replace(/^\[微信消息 [^\]]*\] /, "")).join(" ");

  class HostLikeAgent {
    constructor(bridge, sessionId, { recordDelayMs = 5, thinkMs = 80, workMs = 0, sender = "u1", failAfterWork = false, textOnlyFirstStep = false } = {}) {
      Object.assign(this, { bridge, sessionId, recordDelayMs, thinkMs, workMs, sender, failAfterWork, textOnlyFirstStep });
      this.turnNo = 0;
      this.failNext = false;
      this.phase = { kind: "idle" };
      this.lists = { "next-turn": [], "next-step": [] };
      this.activityDone = Promise.resolve();
      this.recorded = [];
      this.replies = [];
      this.unread = [];
      this.held = 0;
      this.aborts = 0;
      this.sentTo = [];
      this.onReply = undefined;
      const lists = this.lists;
      this.inbox = {
        get nextStep() { return lists["next-step"]; },
        get nextTurn() { return lists["next-turn"]; },
        replace(id, message) {
          for (const list of Object.values(lists)) {
            const i = list.findIndex((m) => m.id === id);
            if (i >= 0) { list[i] = message; return true; }
          }
          return false;
        },
        remove(id) {
          for (const list of Object.values(lists)) {
            const i = list.findIndex((m) => m.id === id);
            if (i >= 0) { list.splice(i, 1); return true; }
          }
          return false;
        },
      };
    }
    get status() { return this.phase.kind === "running" ? "running" : "idle"; }
    get hasPending() { return this.lists["next-turn"].length + this.lists["next-step"].length > 0; }
    emit(type, data) { this.bridge.onSessionEvent({ id: this.sessionId }, { type, data, seq: 0 }); }
    followup(m) { this.send(m, "next-turn", true); }
    steer(m) { this.send(m, "next-step", true); }
    inject(m) { this.send(m, "next-step", false); }
    send(m, target, wake) {
      const afterAbort = wake && this.phase.kind === "running" && this.phase.abort.signal.aborted;
      this.lists[afterAbort ? "next-turn" : target].push(m);
      if (wake) this.wakeDriver(afterAbort);
    }
    cancel(cause, opts = {}) {
      if (!opts.keepInbox) {
        this.lists["next-turn"].length = 0;
        this.lists["next-step"].length = 0;
        if (this.phase.kind !== "idle") this.phase.wakeRequested = false;
      }
      if (this.phase.kind !== "idle") this.phase.abort.abort(cause);
    }
    wakeDriver(afterAbort = false) {
      if (this.phase.kind !== "idle") {
        if (this.phase.kind === "maintenance" || afterAbort) this.phase.wakeRequested = true;
        return;
      }
      const driver = Promise.withResolvers();
      this.activityDone = driver.promise;
      this.phase = { kind: "running", abort: new AbortController(), wakeRequested: false };
      this.kick().then(driver.resolve, driver.reject);
    }
    async whenIdle() { let a; do await (a = this.activityDone); while (a !== this.activityDone); }
    /** A between-turn task (compaction) holding the agent for `ms`. */
    maintain(ms) {
      const done = Promise.withResolvers();
      const phase = { kind: "maintenance", abort: new AbortController(), wakeRequested: false };
      this.phase = phase;
      this.activityDone = done.promise;
      setTimeout(() => {
        this.phase = { kind: "idle" };
        if (phase.wakeRequested && this.hasPending) this.wakeDriver();
        done.resolve();
      }, ms);
    }
    async kick() {
      try { while (await this.turn()); } catch { /* contained, like the host */ } finally {
        const { wakeRequested } = this.phase;
        this.phase = { kind: "idle" };
        if (wakeRequested && this.hasPending) this.wakeDriver();
      }
    }
    async turn() {
      const phase = this.phase;
      const { signal } = phase.abort;
      signal.throwIfAborted();
      const turnNo = ++this.turnNo;
      this.emit("turn/start", { turn: turnNo });
      let claimed = [...this.lists["next-step"].splice(0), ...this.lists["next-turn"].splice(0, 1)];
      let worked = false;
      let step = 0;
      try {
        while (true) {
          step += 1;
          this.emit("step/start", { turn: turnNo, step });
          await abortableSleep(this.recordDelayMs, signal); // pre-step hooks, request preparation
          for (const m of claimed) { this.recorded.push(textOf(m)); this.unread.push(textOf(m)); this.emit("user/message", m); }
          await abortableSleep(this.thinkMs, signal); // the model's request
          if (this.failNext) { this.failNext = false; throw new Error("llm request failed"); }
          if (step === 1 && this.textOnlyFirstStep) {
            // The model answered in plain text, no tool call: the step ends, and
            // the host goes on only because steered input is waiting.
            if (this.lists["next-step"].length === 0) break;
          } else if (this.unread.length > 0 && this.workMs > 0 && !worked) {
            this.emit("tool/call", { name: "read" }); // work the model chose: it runs to the end
            await sleep(this.workMs);
            this.emit("tool/result", {});
            worked = true;
            if (this.failAfterWork) { this.failAfterWork = false; throw new Error("llm request failed"); }
          } else if (this.unread.length > 0) {
            this.emit("tool/call", { name: "send_wechat_text" });
            const to = this.bridge.activeSender ?? this.sender; // how the reply tools address it
            if (await this.bridge.holdReply(to)) {
              this.held += 1; // not sent; the next step reads what came in
            } else {
              const text = this.unread.splice(0).join(" + ");
              this.replies.push(text);
              this.sentTo.push({ to, text });
              this.bridge.noteAnswered(); // what send_wechat_text's sendTextTo does
              this.onReply?.(text);
            }
            this.emit("tool/result", {});
          } else if (this.lists["next-step"].length === 0) break;
          claimed = this.lists["next-step"].splice(0);
        }
      } catch (error) {
        if (signal.aborted) this.aborts += 1;
        this.emit("turn/end", {});
        throw error;
      }
      this.emit("turn/end", {});
      if (!this.hasPending) return false;
      phase.abort = new AbortController();
      phase.wakeRequested = false;
      return true;
    }
  }

  const setup = (agentOpts, { sendText = async () => {}, backlog } = {}) => {
    const config = { ...DEFAULT_CONFIG, sessionId: "sim-wechat", autoMemory: false, idleCompaction: false };
    let agent;
    const deps = { getAccount: () => null, getContextToken: () => "", pending: { hasFor: () => false, size: 0, popFor: () => undefined }, backlog };
    const bridge = new WechatBridge({ agents: { get: () => agent } }, config, sendText, deps);
    agent = new HostLikeAgent(bridge, "sim-wechat", agentOpts);
    bridge.ensureAgent = async () => agent;
    const settle = async () => {
      for (let i = 0; i < 400; i++) {
        await sleep(10);
        if (agent.phase.kind === "idle" && bridge.worker === null) return;
      }
    };
    const say = (text, sender = "u1") => bridge.enqueueMessage(sender, text, undefined);
    return { bridge, agent, settle, say };
  };
  const show = (a) => JSON.stringify({ replies: a.replies, recorded: a.recorded, held: a.held, aborts: a.aborts });
  const covers = (reply, ...parts) => reply !== undefined && parts.every((p) => reply.includes(p));

  {
    const { agent, settle, say, bridge } = setup();
    await say("[图1]");
    await sleep(40);
    await say("这是什么");
    await settle();
    check("flow: a photo is taken up at once; its text arrives during the first thought → restarted, one reply",
      agent.replies.length === 1 && covers(agent.replies[0], "图1", "这是什么") && agent.aborts === 1 && agent.held === 0, show(agent));
    check("flow: …and the text is marked to be answered together", agent.recorded.some((t) => /这是什么/.test(t) && t.includes(TOGETHER_HINT)), show(agent));
    await bridge.dispose();
  }
  {
    const { agent, settle, say, bridge } = setup();
    const t0 = Date.now();
    await say("[图1]");
    await settle();
    check("flow: a lone photo is answered without waiting for a caption",
      agent.replies.length === 1 && agent.aborts === 0 && Date.now() - t0 < 600, show(agent));
    await bridge.dispose();
  }
  {
    const { agent, settle, say, bridge } = setup({ recordDelayMs: 60 });
    await say("问题一");
    await sleep(20);
    await say("补充二");
    await settle();
    check("flow: a message before the host recorded the first → no cancel (nothing lost), read before the reply",
      agent.aborts === 0 && agent.held === 1 && agent.replies.length === 1 && covers(agent.replies[0], "问题一", "补充二"), show(agent));
    await bridge.dispose();
  }
  {
    const { agent, settle, say, bridge } = setup();
    await say("问题一");
    await sleep(40);
    void say("补充二");
    void say("补充三");
    await settle();
    check("flow: two arriving together during the first thought → one restart, merged, one reply covering all",
      agent.aborts === 1 && agent.replies.length === 1 && covers(agent.replies[0], "问题一", "补充二", "补充三"), show(agent));
    check("flow: …with the hint once", agent.recorded.join(" ").split("一次回复").length === 2, show(agent));
    await bridge.dispose();
  }
  {
    const { agent, settle, say, bridge } = setup();
    agent.maintain(150);
    await say("问题一");
    await sleep(40);
    await say("补充二");
    await settle();
    check("flow: compaction holding the agent → the next message merges into the waiting one, one reply",
      agent.aborts === 0 && agent.replies.length === 1 && agent.recorded.length === 1 && covers(agent.replies[0], "问题一", "补充二"), show(agent));
    await bridge.dispose();
  }
  {
    const { agent, settle, say, bridge } = setup({ workMs: 120 });
    await say("[文件 report.pdf]");
    await sleep(110);
    await say("帮我看看第三页");
    await settle();
    check("flow: a message while the bot's own work runs is not cut short: read after that tool, one reply",
      agent.aborts === 0 && agent.replies.length === 1 && covers(agent.replies[0], "report.pdf", "第三页"), show(agent));
    await bridge.dispose();
  }
  {
    const { agent, settle, say, bridge } = setup({ workMs: 40, thinkMs: 80 });
    await say("[文件 report.pdf]");
    await sleep(150);
    await say("还有第五页");
    await settle();
    check("flow: after the work, while the bot is thinking up its reply → read before replying, one reply",
      agent.aborts === 0 && agent.held === 1 && agent.replies.length === 1 && covers(agent.replies[0], "report.pdf", "第五页"), show(agent));
    await bridge.dispose();
  }
  {
    const { agent, settle, say, bridge } = setup({ thinkMs: 60 });
    await say("问题一");
    await sleep(100);
    await say("补充二");
    await settle();
    check("flow: after the bot has replied, a newer message is a follow-up: no hint, its own reply",
      agent.aborts === 0 && agent.replies.length === 2 && covers(agent.replies[0], "问题一") && covers(agent.replies[1], "补充二")
        && !agent.recorded.some((t) => t.includes(TOGETHER_HINT)), show(agent));
    await bridge.dispose();
  }
  {
    const { agent, settle, say, bridge } = setup();
    await say("[图1]");
    await sleep(25);
    await say("[图2]");
    await sleep(25);
    await say("[图3]");
    await sleep(25);
    await say("这三张哪张好");
    await settle();
    check("flow: three photos then the text → one reply covering all four",
      agent.replies.length === 1 && covers(agent.replies[0], "图1", "图2", "图3", "哪张好"), show(agent));
    await bridge.dispose();
  }
  {
    const { agent, settle, say, bridge } = setup({ thinkMs: 50 });
    await say("一");
    for (const t of ["二", "三", "四", "五", "六", "七"]) { await sleep(30); await say(t); }
    await settle();
    check(`flow: someone who keeps typing still gets answered (≤${MAX_RESTARTS} restarts, ≤${MAX_HOLDS} holds); nothing lost`,
      agent.aborts <= MAX_RESTARTS && agent.held <= MAX_HOLDS && agent.replies.length >= 1
        && covers(agent.replies.join(" | "), "一", "二", "三", "四", "五", "六", "七"), show(agent));
    await bridge.dispose();
  }
  {
    const { agent, settle, say, bridge } = setup();
    await say("我的消息", "u1");
    await sleep(20);
    await say("别人的消息", "u2");
    await settle();
    check("flow: another sender's message waits for its own turn: each answer goes to the right person, nothing held",
      agent.aborts === 0 && agent.held === 0 && JSON.stringify(agent.sentTo) === JSON.stringify([{ to: "u1", text: "我的消息" }, { to: "u2", text: "别人的消息" }]),
      JSON.stringify(agent.sentTo));
    await bridge.dispose();
  }
  {
    const { agent, settle, say, bridge } = setup({ thinkMs: 60 });
    await say("看看这个");
    bridge.noteIncoming("u1", 1); // the photo reached clawbot and is still downloading
    await sleep(150); // the bot has thought it over and wants to reply meanwhile
    await say("[图1]");
    bridge.noteIncoming("u1", -1);
    await settle();
    check("flow: text, then a photo still downloading when the bot wants to reply → it waits for the photo, one reply",
      agent.replies.length === 1 && covers(agent.replies[0], "看看这个", "图1") && agent.held === 1, show(agent));
    await bridge.dispose();
  }
  {
    const { agent, settle, say, bridge } = setup({ workMs: 120, failAfterWork: true });
    await say("[文件 report.pdf]");
    await sleep(140); // the bot is already reading the file (its first tool) when this arrives
    await say("帮我看看第三页");
    await settle();
    check("flow: a turn that fails with a steered message still unread → that message is answered next, not left behind",
      agent.aborts === 0 && agent.lists["next-step"].length === 0 && covers(agent.replies.join(" | "), "第三页"), show(agent));
    await bridge.dispose();
  }
  {
    // Timeline (thinkMs 120): the worker's turn records 问题一 at 5 ms, replies at ~125, its closing
    // step thinks until ~250; the reminder turn then records at ~255 and thinks until ~375.
    const { agent, settle, say, bridge } = setup({ thinkMs: 120 });
    await say("问题一");
    await sleep(40);
    const { createUserMessage } = await import(join(NPX, "@deepseek-ai/dsh-llm/lib/index.js")).catch(() => ({}));
    const reminder = createUserMessage
      ? createUserMessage({ content: [{ type: "text", text: "提醒：10 点去取快递" }], source: { kind: "schedule" } })
      : { id: "rem-1", role: "user", content: [{ type: "text", text: "提醒：10 点去取快递" }], source: { kind: "schedule" } };
    agent.followup(reminder); // dsh-schedule follows up while the worker's turn runs: the host runs it next, same driver
    await sleep(270); // ~310 ms: the reminder turn is on its first thought
    await say("谢谢");
    await settle();
    check("flow: a reminder the host runs next in the worker's driver is never cancelled by a newer message",
      agent.aborts === 0 && agent.recorded.some((t) => /取快递/.test(t)) && covers(agent.replies.join(" | "), "取快递", "谢谢"), show(agent));
    await bridge.dispose();
  }
  {
    const { agent, settle, say, bridge } = setup({ recordDelayMs: 60, textOnlyFirstStep: true });
    await say("问题一");
    await sleep(20);
    await say("补充二"); // inside step 1's claim window: steered
    await sleep(140); // step 1 ended with no tool call; step 2 has claimed 补充二 but not recorded it yet
    await say("补充三");
    await settle();
    check("flow: no restart while a later step holds a claimed message (nothing lost)",
      agent.aborts === 0 && covers(agent.recorded.join(" "), "问题一", "补充二", "补充三") && covers(agent.replies.join(" | "), "问题一", "补充二", "补充三"), show(agent));
    await bridge.dispose();
  }
  {
    const { bridge } = setup();
    bridge.noteIncoming("u1", 1);
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 50);
    const t0 = Date.now();
    const held = await bridge.holdReply("u1", stop.signal);
    check("flow: a reply waiting for a download stops waiting the moment the turn is stopped", held === false && Date.now() - t0 < 1_000);
    bridge.noteIncoming("u1", -1);
    await bridge.dispose();
  }
  {
    const { agent, settle, say, bridge } = setup({ thinkMs: 80 });
    agent.failNext = true;
    agent.followup({ id: "web-1", role: "user", content: [{ type: "text", text: "网页上的问题" }], source: { kind: "user" } }); // a web turn the worker does not drive
    await sleep(40);
    await say("微信里补一句");
    await settle();
    await sleep(100);
    await settle();
    check("flow: a web or reminder turn that fails with a WeChat message unread → that message is still answered",
      agent.aborts === 0 && covers(agent.replies.join(" | "), "微信里补一句"), show(agent));
    await bridge.dispose();
  }
  {
    // A reminder while WeChat will not let the bot write first; the owner writes again later.
    const sent = [];
    let windowOpen = false;
    const sendText = async (_to, text) => {
      if (!windowOpen) throw new Error("sendMessage ret=-2 errmsg=prepare failed");
      sent.push(text);
    };
    const dir = join(tmpdir(), `clawbot-flow-backlog-${process.pid}`);
    rmSync(dir, { recursive: true, force: true });
    const backlog = new Backlog(join(dir, "backlog.json"));
    const { agent, settle, say, bridge } = setup({}, { sendText, backlog });
    agent.onReply = (text) => bridge.sendTextTo("u1", `回复：${text}`);
    bridge.sendTextTo("u1", "记得 10 点去取快递。");
    bridge.sendTextTo("u1", "要回答的问题？", { uncapped: true, transient: true });
    await sleep(30);
    check("flow: a reminder WeChat refused is kept (a transient question is not)",
      backlog.peek("u1").length === 1 && backlog.peek("u1")[0].text === "记得 10 点去取快递。" && sent.length === 0);
    bridge.onSessionEvent({ id: "sim-wechat" }, { type: "turn/end", data: {}, seq: 0 });
    await sleep(30);
    check("flow: nothing is retried before they write again", sent.length === 0 && backlog.peek("u1").length === 1);
    windowOpen = true;
    await say("早");
    await settle();
    await sleep(50);
    check("flow: they write again → the reply first, then one digest with the kept reminder and when it was due",
      sent.length === 2 && sent[0].startsWith("回复：") && sent[1].startsWith("有 1 条消息当时没能发出")
        && /〔\d\d-\d\d 周. \d\d:\d\d〕\n记得 10 点去取快递。/.test(sent[1]), JSON.stringify(sent));
    check("flow: delivered → the backlog is empty, and the bot is told what went out late",
      backlog.peek("u1").length === 0 && agent.lists["next-step"].some((m) => /\[补发\]/.test(textOf(m))));
    await bridge.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
  setLogLevel("info");
}

// ------------------------- 微信不让 bot 先开口时,消息先存着,对方下次发消息、回复完之后合并补发
// 2026-10-12:iLink 只在对方最后一条消息之后约 24 小时内让 bot 主动发(日志:失败全在 24.8–53 小时,
// 成功的提醒全在 20.5 小时以内)。以前 send_wechat_text 先说「已发送」,真发失败只进日志,提醒等于丢了。
{
  const bl = await import(join(ROOT, "lib/backlog.js"));
  check("closed window: ret=-2 with or without errmsg",
    bl.isSendWindowClosed(new Error("sendMessage ret=-2 errmsg=prepare failed"))
      && bl.isSendWindowClosed("sendMessage ret=-2 errmsg=(empty); context_token was included …")
      && !bl.isSendWindowClosed(new Error("sendMessage ret=-14 errmsg=session expired"))
      && !bl.isSendWindowClosed(new Error("CDN upload server error: 500")));
  check("due time reads like 10-13 周一 09:00", /^\d\d-\d\d 周[日一二三四五六] \d\d:\d\d$/.test(bl.dueStamp(new Date())));
  check("one sentence: the first line, without its trailing colon",
    bl.oneSentence("【clawbot】已部署到本机（还没发布）：\n1. 先发图再打字…") === "【clawbot】已部署到本机（还没发布）");
  check("one sentence: cut at the first sentence end", bl.oneSentence("全部测试通过。顺带修了两个问题。") === "全部测试通过。");
  check("one sentence: a long line is capped with …", bl.oneSentence("很".repeat(200), 60).length === 60 && bl.oneSentence("很".repeat(200), 60).endsWith("…"));
  const at = (iso) => new Date(iso).toISOString();
  const items = [
    { id: "b", kind: "notice", at: at("2026-10-13T20:40:00Z"), source: "Claude", summary: "连发合并已部署到本机。" },
    { id: "a", kind: "text", at: at("2026-10-13T13:00:00Z"), text: "记得 10 点去取快递。" },
    { id: "c", kind: "file", at: at("2026-10-14T13:00:00Z"), path: "/tmp/x/photo.png", caption: "今天拍的照片" },
    { id: "d", kind: "file", at: at("2026-10-14T13:05:00Z"), path: "/tmp/x/report.pdf", caption: "季度报告" },
  ];
  const digest = bl.formatDigest(items, { fileExists: (p) => p.endsWith(".png") });
  const one = digest.join("\n\n");
  check("digest: one message, the reason first, the owner's chosen wording",
    digest.length === 1 && one.startsWith("有 4 条消息当时没能发出（微信不允许 bot 在你一段时间没说话时主动发消息），按原定时间补上："));
  check("digest: items in time order, each with when it was due",
    one.indexOf("取快递") < one.indexOf("连发合并") && one.indexOf("连发合并") < one.indexOf("photo.png")
      && (one.match(/〔\d\d-\d\d 周. \d\d:\d\d〕/g) ?? []).length === 4);
  check("digest: a text entry is its due time, then the text on the next line", /〔[^〕]+〕\n记得 10 点去取快递。/.test(one));
  check("digest: a notification keeps who sent it and one sentence", /〔[^〕]+〕Claude 的通知\n连发合并已部署到本机。/.test(one));
  check("digest: files say they follow, or that they are gone",
    /图片 photo\.png（随后补发）/.test(one) && /文件 report\.pdf（文件已经不在了，没法补发）/.test(one));
  check("digest: a file that follows carries its own caption; a gone file's caption is kept in the digest",
    !one.includes("今天拍的照片") && /文件 report\.pdf（文件已经不在了，没法补发）\n季度报告/.test(one));
  const long = Array.from({ length: 6 }, (_, i) => ({ id: String(i), kind: "text", at: at(`2026-10-1${i}T13:00:00Z`), text: "字".repeat(300) }));
  const parts = bl.formatDigest(long, { fileExists: () => true, maxChars: 800 });
  check("digest: a long one splits between entries, the header only once",
    parts.length > 1 && parts.every((p) => p.length <= 800) && parts.filter((p) => p.startsWith("有 6 条")).length === 1
      && parts.join("").split("字".repeat(300)).length === 7);
  check("digest: a file an earlier digest announced is not announced again",
    bl.digestChunks([{ id: "f", kind: "file", at: at("2026-10-13T13:00:00Z"), path: "/tmp/x/a.png", announced: true }], { fileExists: () => true }).length === 0);
  const chunks = bl.digestChunks(long, { fileExists: () => true, maxChars: 800 });
  check("digest: each part knows which items it carries (forgotten as it goes out)",
    chunks.length === parts.length && chunks.flatMap((c) => c.ids).join() === long.map((i) => i.id).join());
  const dir = join(tmpdir(), `clawbot-backlog-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  const file = join(dir, "backlog.json");
  const store = new bl.Backlog(file);
  const kept = store.add("u1", { kind: "text", at: at("2026-10-13T13:00:00Z"), text: "一" });
  store.add("u1", { kind: "text", at: at("2026-10-13T14:00:00Z"), text: "二" });
  store.add("u2", { kind: "text", at: at("2026-10-13T15:00:00Z"), text: "别人的" });
  check("backlog: kept per recipient, oldest first, on disk with mode 0600",
    store.peek("u1").map((i) => i.text).join() === "一,二" && new bl.Backlog(file).peek("u2").length === 1
      && (statSync(file).mode & 0o777) === 0o600);
  store.remove("u1", [kept.id]);
  check("backlog: removing by id leaves what came in meanwhile", store.peek("u1").map((i) => i.text).join() === "二");
  for (let i = 0; i < bl.BACKLOG_LIMIT + 5; i++) store.add("u3", { kind: "text", at: at("2026-10-13T13:00:00Z"), text: String(i) });
  check("backlog: capped, dropping the oldest", store.peek("u3").length === bl.BACKLOG_LIMIT && store.peek("u3")[0].text === "5");
  rmSync(dir, { recursive: true, force: true });
  const bridgeSrc = readFileSync(join(ROOT, "src/bridge.ts"), "utf-8");
  check("a reply WeChat refused is kept; a question or upload notice is not",
    /if \(!opts\?\.transient && isSendWindowClosed\(err\)\) this\.keep\(sender, \{ kind: "text", at: due, text \}\)/.test(bridgeSrc)
      && /this\.sendTextTo\(sender, question, \{ uncapped: true, transient: true \}\)/.test(bridgeSrc)
      && /bridge\.sendTextTo\(sender, label, \{ transient: true \}\)/.test(readFileSync(join(ROOT, "src/tool.ts"), "utf-8")));
  check("the digest goes out only after they wrote again, and after the reply",
    /if \(\(this\.lastInbound\.get\(to\) \?\? 0\) <= newest\) return;/.test(bridgeSrc)
      && /this\.typing\.stop\(\);\s*this\.idleCompact\.noteIdle\(\);\s*\/\/ Answered[^\n]*\n\s*this\.deliverBacklog\(first\.sender\);/.test(bridgeSrc));
  const toolSrc = readFileSync(join(ROOT, "src/tool.ts"), "utf-8");
  check("send_wechat_file keeps a file WeChat refused and tells the model not to retry",
    /if \(upload\.windowClosed\) \{[\s\S]{0,200}bridge\.keepFile\(sender, \{ path: resolved, caption, original \}\);[\s\S]{0,200}不用重试/.test(toolSrc));
  const notifySrc = readFileSync(join(ROOT, "src/owner-notify.ts"), "utf-8");
  check("an MCP notification WeChat refused is kept as one sentence and reported as deferred",
    /if \(!isSendWindowClosed\(err\) \|\| deps\.backlog === undefined\) throw err;/.test(notifySrc)
      && /kind: "notice"/.test(notifySrc) && /deferred: true/.test(notifySrc)
      && /await notifyOwner\(ctx, deps,/.test(readFileSync(join(ROOT, "src/mcp-route.ts"), "utf-8")));
}

// ------------------------- 补发的几处边界(2026-10-12 审查):一次只补发一份;文件失败分「永远不行」和「下次再试」
{
  const { WechatBridge } = await import(join(ROOT, "lib/bridge.js"));
  const { Backlog, FILE_ATTEMPTS } = await import(join(ROOT, "lib/backlog.js"));
  const { setLogLevel } = await import(join(ROOT, "lib/ilink/util/logger.js"));
  const { DEFAULT_CONFIG } = await import(join(ROOT, "lib/config.js"));
  setLogLevel("error");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const dir = join(tmpdir(), `clawbot-backlog-edges-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const photo = join(dir, "photo.png");
  writeFileSync(photo, "png");
  const make = ({ sendText, sendFile }) => {
    const backlog = new Backlog(join(dir, `backlog-${Math.random().toString(36).slice(2)}.json`));
    const injected = [];
    const agent = { inbox: { nextStep: [], nextTurn: [] }, inject: (m) => injected.push(m), status: "idle" };
    const config = { ...DEFAULT_CONFIG, sessionId: "sim-wechat", autoMemory: false, idleCompaction: false };
    const deps = { getAccount: () => null, getContextToken: () => "", pending: { hasFor: () => false, size: 0, popFor: () => undefined }, backlog, sendFile };
    const bridge = new WechatBridge({ agents: { get: () => agent } }, config, sendText, deps);
    return { bridge, backlog, injected };
  };
  const past = new Date(Date.now() - 60_000).toISOString();
  {
    const sent = [];
    const { bridge, backlog } = make({ sendText: async (_to, t) => { await sleep(40); sent.push(t); } });
    backlog.add("u1", { kind: "text", at: past, text: "一" });
    bridge.lastInbound.set("u1", Date.now());
    bridge.deliverBacklog("u1");
    bridge.deliverBacklog("u1");
    await sleep(150);
    check("backlog: two triggers while one delivery runs → the digest goes out once", sent.length === 1 && backlog.peek("u1").length === 0, JSON.stringify(sent));
    await bridge.dispose();
  }
  {
    let calls = 0;
    const sent = [];
    const { bridge, backlog, injected } = make({
      sendText: async (_to, t) => { sent.push(t); },
      sendFile: async () => { calls += 1; return { ok: false, windowClosed: false, permanent: false, message: "CDN upload server error: 500" }; },
    });
    backlog.add("u1", { kind: "file", at: past, path: photo });
    for (let i = 0; i < FILE_ATTEMPTS; i++) {
      bridge.lastInbound.set("u1", Date.now() + i);
      bridge.deliverBacklog("u1");
      await sleep(30);
      if (i === 0) check("backlog: a file that fails for a passing reason is kept for the next message, marked as announced",
        backlog.peek("u1").length === 1 && backlog.peek("u1")[0].attempts === 1 && backlog.peek("u1")[0].announced === true);
    }
    const digests = sent.filter((t) => t.startsWith("有 "));
    check("backlog: a retried file is announced once, not in a new digest every time", digests.length === 1, JSON.stringify(sent));
    check(`backlog: …given up after ${FILE_ATTEMPTS} tries with one line to the user and a note to the bot`,
      calls === FILE_ATTEMPTS && backlog.peek("u1").length === 0
        && sent.some((t) => /图片 photo\.png 补发了 3 次都没发出去，没能补发。/.test(t))
        && injected.length === 1 && /没能补发/.test(JSON.stringify(injected[0].content)), JSON.stringify(sent));
    await bridge.dispose();
  }
  {
    const { bridge, backlog } = make({
      sendText: async () => {},
      sendFile: async () => ({ ok: false, windowClosed: false, permanent: true, message: "too big" }),
    });
    backlog.add("u1", { kind: "file", at: past, path: photo });
    bridge.lastInbound.set("u1", Date.now());
    bridge.deliverBacklog("u1");
    await sleep(30);
    check("backlog: a file WeChat will never take (over the CDN ceiling) is dropped at once", backlog.peek("u1").length === 0);
    await bridge.dispose();
  }
  {
    const sent = [];
    const { bridge, backlog } = make({ sendText: async (_to, t) => { sent.push(t); } });
    backlog.add("u1", { kind: "text", at: new Date().toISOString(), text: "一" });
    bridge.lastInbound.set("u1", Date.now() - 120_000);
    bridge.deliverBacklog("u1");
    await sleep(30);
    check("backlog: nothing is sent unless they wrote after the last refusal", sent.length === 0 && backlog.peek("u1").length === 1);
    await bridge.dispose();
  }
  {
    const sent = [];
    const { bridge, backlog } = make({ sendText: async (_to, t) => { sent.push(t); } });
    backlog.add("u1", { kind: "text", at: past, text: "一" });
    bridge.lastInbound.set("u1", Date.now());
    await bridge.dispose();
    bridge.deliverBacklog("u1");
    await sleep(30);
    check("backlog: a disposed (superseded) bridge leaves the delivery to the new one", sent.length === 0 && backlog.peek("u1").length === 1);
  }
  const bridgeSrc = readFileSync(join(ROOT, "src/bridge.ts"), "utf-8");
  const { occurrenceAt } = await import(join(ROOT, "lib/backlog.js"));
  check("backlog: a reminder's own due time is read from dsh-schedule's message (even if it fired late)",
    occurrenceAt("[SCHEDULE REMINDER]\nThis is a scheduled message from the user\noccurrence_at: 2026-10-06T17:30:00.000Z\nreminder_prompt_json: \"x\"") === "2026-10-06T17:30:00.000Z"
      && occurrenceAt("没有时间") === undefined && occurrenceAt("occurrence_at: 不是时间") === undefined);
  check("backlog: a refused reminder is stamped with that due time",
    /this\.reminderDueAt = occurrenceAt\(messageText\(event\.data\)\) \?\? new Date\(\)\.toISOString\(\);/.test(bridgeSrc) && /const due = this\.reminderDueAt \?\? new Date\(\)\.toISOString\(\);/.test(bridgeSrc));
  check("backlog: a message counts as received once it reaches the bot (not while an image still downloads)",
    bridgeSrc.indexOf("this.lastInbound.set(sender, Date.now());") > bridgeSrc.indexOf("const task: QueuedMessage = { sender, text, message, parts };"));
  check("backlog: after a reminder or web turn, unread messages are answered first, then the backlog goes out",
    /if \(senders\.length > 0\) this\.afterOtherTurn\(senders\);/.test(bridgeSrc) && /this\.requeueUnread\(live\);\s*if \(this\.queue\.length > 0\) \{\s*this\.runWorker\(\);/.test(bridgeSrc));
  check("backlog: detached work never leaves a rejection unhandled (DSH exits on one)",
    /void this\.sendKeptFiles\(to, items\)\s*\.catch\(/.test(bridgeSrc) && /\.catch\(\(err: unknown\) => logger\.warn\(`afterOtherTurn: /.test(bridgeSrc));
  rmSync(dir, { recursive: true, force: true });
  setLogLevel("info");
}

// ------------------------- bot 看得到 DSH 会话、DSH 会话能发微信(2026-10-13)
{
  const { setLogLevel } = await import(join(ROOT, "lib/ilink/util/logger.js"));
  setLogLevel("error");
  const ds = await import(join(ROOT, "lib/dsh-sessions.js"));
  const on = await import(join(ROOT, "lib/owner-notify.js"));
  const bl = await import(join(ROOT, "lib/backlog.js"));

  // A host with three conversations: the WeChat one, one running, one closed.
  const steered = [], followed = [], appended = [], woken = [];
  const mkAgent = (id, status, cwd) => ({
    status,
    session: { id, seq: 7, header: { cwd }, append: (type, msg) => appended.push({ id, type, msg }) },
    steer: (m) => steered.push({ id, m }),
    followup: (m) => followed.push({ id, m }),
  });
  const agents = new Map([
    ["wechat-main", mkAgent("wechat-main", "idle", "/work")],
    ["s-run-1111", mkAgent("s-run-1111", "running", "/work/plugin")],
  ]);
  const records = [
    { header: { id: "wechat-main", createdAt: 1, cwd: "/work" }, live: true, persisted: true },
    { header: { id: "s-run-1111", createdAt: 3, cwd: "/work/plugin" }, live: true, persisted: true },
    { header: { id: "s-old-2222", createdAt: 2, cwd: "/work/weather" }, live: false, persisted: true },
  ];
  const titles = { "wechat-main": "微信", "s-run-1111": "插件发布", "s-old-2222": "天气预报" };
  const services = {
    sessionQuery: {
      listSessions: async () => records,
      readTitleSnapshots: async (ids) => ids.map((id) => ({ status: "fulfilled", value: { title: { title: titles[id] } } })),
      readSurface: async (id) => ({ capturedThroughSeq: null, events: [
        { type: "user/message", seq: 1, time: Date.parse("2026-10-13T14:00:00Z"), data: { content: [{ type: "text", text: `问 ${id}` }] } },
        { type: "assistant/message", seq: 2, time: Date.parse("2026-10-13T14:01:00Z"), data: { message: { content: [{ type: "text", text: "答好了" }] } } },
      ] }),
    },
    sessionController: {
      resolveAgent: async (id) => {
        woken.push(String(id));
        const a = mkAgent(String(id), "idle", "/work/weather");
        agents.set(String(id), a);
        return { agent: a };
      },
    },
  };
  const globalTools = new Map();
  const rootCtx = {
    agents: { list: () => [...agents.values()], get: (id) => agents.get(String(id)) },
    get: (name) => services[name],
    tools: { register: (t) => globalTools.set(t.name, t) },
  };
  const botTools = new Map();
  ds.registerDshSessionTools({ tools: { register: (t) => botTools.set(t.name, t) } }, rootCtx, "wechat-main");
  check("the bot gets list/read/send for DSH conversations",
    ["list_dsh_sessions", "read_dsh_session", "send_to_dsh_session"].every((n) => botTools.has(n)));
  const listed = await botTools.get("list_dsh_sessions").execute({});
  check("the list covers every folder, running first, and leaves out the WeChat conversation",
    /2 个会话\(1 个正在运行\)/.test(listed.summary) && listed.summary.indexOf("插件发布") < listed.summary.indexOf("天气预报")
      && !listed.summary.includes("微信 —") && /weather/.test(listed.summary), listed.summary);
  const read = await botTools.get("read_dsh_session").execute({ session: "天气" });
  check("a conversation is found by title words and read as user/DSH lines",
    read.ok && /会话「天气预报」/.test(read.summary) && /用户:问 s-old-2222/.test(read.summary) && /DSH:答好了/.test(read.summary), read.summary);
  const sentRun = await botTools.get("send_to_dsh_session").execute({ session: "s-run", text: "用户在微信里说:继续" });
  check("a running conversation is steered", sentRun.ok && steered.length === 1 && steered[0].id === "s-run-1111", sentRun.summary);
  const sentOld = await botTools.get("send_to_dsh_session").execute({ session: "weather", text: "用户在微信里说:跑一下" });
  check("…a closed one is woken through the host's session controller, then followed up",
    sentOld.ok && woken.join() === "s-old-2222" && followed.length === 1 && /已唤醒/.test(sentOld.summary), sentOld.summary);
  check("…with a plugin source the WeChat listener does not forward", followed[0]?.m?.source?.kind === "plugin:clawbot-wechat",
    JSON.stringify(followed[0]?.m?.source));
  const ambiguous = await botTools.get("read_dsh_session").execute({ session: "s-" });
  check("an ambiguous name comes back with the candidates", !ambiguous.ok && /对上了 2 个会话/.test(ambiguous.summary), ambiguous.summary);

  // notify_wechat: global, refuses the WeChat conversation, names its sender, waits when WeChat refuses.
  const dir = join(tmpdir(), `clawbot-notify-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  const backlog = new bl.Backlog(join(dir, "backlog.json"));
  const sentTexts = [];
  let refuse = false;
  on.registerOwnerNotifyTool(rootCtx, {
    config: { sessionId: "wechat-main" },
    sendText: async (to, text) => {
      if (refuse) throw new Error("sendMessage ret=-2 errmsg=prepare failed");
      sentTexts.push({ to, text });
    },
    getAccount: () => ({ configured: true, userId: "owner@im.wechat" }),
    backlog,
  });
  const notify = globalTools.get("notify_wechat");
  check("notify_wechat is registered on the root context, so every DSH conversation gets it", notify !== undefined);
  const self = await notify.execute({ text: "hi" }, { agent: { session: { id: "wechat-main" } } });
  check("…the WeChat conversation itself is refused (it has send_wechat_text)", !self.ok && sentTexts.length === 0);
  const ok = await notify.execute({ text: "插件 2.0 打包好了" }, { agent: { session: { id: "s-run-1111" } } });
  check("…another conversation's message goes to the QR-linked owner only",
    ok.ok && sentTexts.length === 1 && sentTexts[0].to === "owner@im.wechat", ok.summary);
  check("…and the bot's history gets a copy naming the sending conversation",
    appended.some((a) => a.id === "wechat-main" && /\[DSH 会话「插件发布」发给用户的\] 插件 2\.0 打包好了/.test(a.msg.content?.[0]?.text ?? "")));
  refuse = true;
  const kept = await notify.execute({ text: "天气预报跑完了，明天晴。明细见网页。", summary: "天气预报:明天晴" },
    { agent: { session: { id: "s-old-2222" } } });
  const item = backlog.peek("owner@im.wechat")[0];
  check("…a message WeChat refuses is kept with its sender and one sentence",
    kept.ok && /已存下/.test(kept.summary) && item?.kind === "notice" && item.source === "DSH" && item.origin === "天气预报"
      && item.summary === "天气预报:明天晴", JSON.stringify(item));
  check("…and the digest says which conversation it came from",
    /DSH 会话「天气预报」的通知\n天气预报:明天晴/.test(bl.formatDigest([item], { fileExists: () => true })[0] ?? ""));
  rmSync(dir, { recursive: true, force: true });
  const bridgeSrc = readFileSync(join(ROOT, "src/bridge.ts"), "utf-8");
  check("the WeChat conversation hides notify_wechat and gets the DSH session tools",
    /const deny = \[[^\]]*NOTIFY_TOOL,/.test(bridgeSrc) && /registerDshSessionTools\(agentCtx, this\.ctx, this\.config\.sessionId\);/.test(bridgeSrc));
  const indexSrc = readFileSync(join(ROOT, "src/index.ts"), "utf-8");
  check("notify_wechat is registered before the bridge exists (so the deny list knows the name)",
    indexSrc.indexOf("registerOwnerNotifyTool(ctx,") > 0
      && indexSrc.indexOf("registerOwnerNotifyTool(ctx,") < indexSrc.indexOf("bridge = new WechatBridge("));
  setLogLevel("info");
}

// ------------------------- bot 给 Claude 会话发消息:用最新的 claude、拉活失败要收拾、干完交还桌面版(2026-10-13)
{
  const { setLogLevel } = await import(join(ROOT, "lib/ilink/util/logger.js"));
  setLogLevel("error");
  // A fake home with an OLD npm install under nvm (found first) and a NEW native install.
  const home = join(tmpdir(), `clawbot-claude-home-${process.pid}`);
  rmSync(home, { recursive: true, force: true });
  const pkg = join(home, ".nvm/versions/node/v22.1.0/lib/node_modules/@anthropic-ai/claude-code");
  mkdirSync(join(pkg, "bin"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-code", version: "2.1.229" }));
  writeFileSync(join(pkg, "bin/claude.exe"), "#!/bin/sh\n", { mode: 0o755 });
  mkdirSync(join(home, ".nvm/versions/node/v22.1.0/bin"), { recursive: true });
  symlinkSync(join(pkg, "bin/claude.exe"), join(home, ".nvm/versions/node/v22.1.0/bin/claude"));
  mkdirSync(join(home, ".local/share/claude/versions"), { recursive: true });
  writeFileSync(join(home, ".local/share/claude/versions/2.1.296"), "#!/bin/sh\n", { mode: 0o755 });
  mkdirSync(join(home, ".local/bin"), { recursive: true });
  symlinkSync(join(home, ".local/share/claude/versions/2.1.296"), join(home, ".local/bin/claude"));
  const saved = { HOME: process.env.HOME, PATH: process.env.PATH };
  process.env.HOME = home;
  process.env.PATH = "/usr/bin:/bin";
  let chosen;
  try {
    const fresh = await import(`${pathToFileURL(join(ROOT, "lib/claude-peer.js")).href}?newest=${process.pid}`);
    chosen = fresh.resolveClaudeBinaryForTest();
  } finally {
    process.env.HOME = saved.HOME;
    process.env.PATH = saved.PATH;
  }
  check("the newest claude wins over the first one found (an old nvm install sorts first)",
    chosen === join(home, ".local/bin/claude"), `got ${chosen}`);
  rmSync(home, { recursive: true, force: true });

  const { strayJobs, releaseStep } = await import(join(ROOT, "lib/claude-peer.js"));
  const target = { sessionId: "11112222-x", cwd: "/w/manual" };
  const before = [{ id: "aaaa1111", sessionId: "aaaa1111-x", cwd: "/w/other" }];
  const after = [...before,
    { id: "33334444", sessionId: "33334444-x", cwd: "/w/manual" },   // forked by an old CLI
    { id: "11112222", sessionId: "11112222-x", cwd: "/w/manual" },   // the conversation itself
    { id: "bbbb2222", sessionId: "bbbb2222-x", cwd: "/w/elsewhere" }];
  check("a revive that never registered: its leftovers (same id, or forked in its folder) are stopped, others are not",
    strayJobs(before, after, target).map((j) => j.id).join() === "33334444,11112222");
  check("…and without a before-picture only the conversation itself is stopped (the rest may be the owner's)",
    strayJobs(undefined, after, target).map((j) => j.id).join() === "11112222"
      && strayJobs(before, after, { sessionId: "11112222-x" }).map((j) => j.id).join() === "11112222");

  const t0 = 1_000_000;
  let st = { sawBusy: false };
  let r = releaseStep(st, "busy", t0, t0); st = r.state;
  r = releaseStep(st, "idle", t0 + 5_000, t0); st = r.state;
  const early = r.release;
  r = releaseStep(st, "idle", t0 + 36_000, t0);
  check("a woken conversation is handed back once it has worked and then stayed idle for 30 s",
    early === false && r.release === true);
  let quick = releaseStep({ sawBusy: false }, "idle", t0 + 10_000, t0);
  quick = releaseStep(quick.state, "idle", t0 + 95_000, t0);
  check("…one that answered between two looks is handed back after 90 s of quiet",
    quick.release === true && releaseStep({ sawBusy: false }, "idle", t0 + 40_000, t0).release === false);
  check("…and one still busy is left alone", releaseStep({ sawBusy: true }, "busy", t0 + 9_000_000, t0).release === false);
  const peerSrc = readFileSync(join(ROOT, "src/claude-peer.ts"), "utf-8");
  check("a relay that fails after a revive stops the background session again",
    /wokenByUs\.delete\(live\.sessionId\);\s*const stopped = await stopBackground\(bin, job, "the relay into it failed"\);/.test(peerSrc));
  check("one revive per conversation at a time",
    /const prior = reviving\.get\(target\.sessionId\);/.test(peerSrc) && /reviving\.set\(target\.sessionId, run\);/.test(peerSrc));
  setLogLevel("info");
}

// ------------------------- Mac 日历:读全部、专用日历自主、别的日历先问、只对机主(2026-10-14)
{
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const { setLogLevel } = await import(join(ROOT, "lib/ilink/util/logger.js"));
  setLogLevel("error");
  const cal = await import(join(ROOT, "lib/mac-calendar.js"));
  const cfgMod = await import(join(ROOT, "lib/config.js"));
  check("calendar: off by default, with no name",
    cfgMod.DEFAULT_CONFIG.macCalendar === false && cfgMod.DEFAULT_CONFIG.macCalendarName === "");
  check("calendar: the tool switches are hot (the card can only write volatile fields), and flipping one restarts the listener",
    cfgMod.HOT_FIELDS.has("macCalendar") && cfgMod.HOT_FIELDS.has("codexPeer") && cfgMod.HOT_FIELDS.has("macCalendarName")
      && /const toolSwitches = hot\.filter\(\(key\) => key === "macCalendar" \|\| key === "codexPeer"\);[\s\S]{0,400}await stopMonitor\([\s\S]{0,80}startMonitor\(\);/
        .test(readFileSync(join(ROOT, "src/index.ts"), "utf-8")));
  {
    // The host's settings form refuses writes to non-volatile fields (silently,
    // for the card): every field the card writes must be hot.
    const clientSrc = readFileSync(join(ROOT, "src/client.js"), "utf-8");
    const written = [...new Set([...clientSrc.matchAll(/\b(?:set|clear|num)\("([A-Za-z]+)"/g)].map((m) => m[1]))];
    const cold = written.filter((f) => !cfgMod.HOT_FIELDS.has(f));
    check("settings card: every field it writes is volatile (the host drops the rest without a word)",
      written.length > 10 && cold.length === 0, `cold: ${cold.join(", ")}`);
  }

  // A fake helper with EventKit's own conventions: an all-day event ends at
  // 23:59:59 of its LAST day.
  const calls = [];
  const work = { id: "c-work", title: "工作", account: "iCloud", accountType: "caldav", writable: true };
  const hol = { id: "c-hol", title: "节假日", account: "订阅", accountType: "subscribed", writable: false };
  const planCal = { id: "c-planCal", title: "规划", account: "iCloud", accountType: "caldav", writable: true };
  const gPlanCal = { id: "c-gplanCal", title: "规划", account: "Google", accountType: "caldav", writable: true };
  let calendars = [work, hol];
  const events = [
    { id: "ev-meet", calendarId: "c-work", calendar: "工作", account: "iCloud", title: "例会", start: "2026-10-15T14:00:00-04:00",
      end: "2026-10-15T15:00:00-04:00", allDay: false, recurring: true, occurrence: "2026-10-15T14:00:00-04:00",
      location: "会议室 A", notes: "带上周的图\n链接 https://example.com/zoom", attendees: 5, organizerIsMe: true },
    { id: "ev-block", calendarId: "c-planCal", calendar: "规划", account: "iCloud", title: "写报告", start: "2026-10-15T09:00:00-04:00",
      end: "2026-10-15T10:30:00-04:00", allDay: false, recurring: false },
    { id: "ev-hol", calendarId: "c-hol", calendar: "节假日", account: "订阅", title: "重阳节", start: "2026-10-16T00:00:00-04:00",
      end: "2026-10-16T23:59:59-04:00", allDay: true, recurring: false },
    { id: "ev-trip", calendarId: "c-work", calendar: "工作", account: "iCloud", title: "开会出差", start: "2026-10-17T00:00:00-04:00",
      end: "2026-10-18T23:59:59-04:00", allDay: true, recurring: false },
    { id: "ev-g", calendarId: "c-gplanCal", calendar: "规划", account: "Google", title: "同名日历里的事", start: "2026-10-15T20:00:00-04:00",
      end: "2026-10-15T21:00:00-04:00", allDay: false, recurring: false },
  ];
  let authorization = "fullAccess";
  const runner = async (req) => {
    calls.push(req);
    if (authorization !== "fullAccess" && req.cmd !== "status" && req.cmd !== "request") return { ok: false, code: "not_authorized", error: authorization };
    switch (req.cmd) {
      case "status": return { ok: true, authorization };
      case "request": return { ok: true, authorization };
      case "calendars": return { ok: true, calendars };
      case "events": return { ok: true, events, calendars };
      case "ensureCalendar": {
        if (req.knownId && calendars.some((c) => c.id === req.knownId)) return { ok: true, calendar: calendars.find((c) => c.id === req.knownId), created: false };
        if (req.adoptId) return { ok: true, calendar: calendars.find((c) => c.id === req.adoptId), created: false };
        const same = calendars.filter((c) => c.title === req.name && c.writable);
        if (same.length > 0) return { ok: false, code: "name_taken", calendars: same };
        calendars = [...calendars, planCal];
        return { ok: true, calendar: planCal, created: true };
      }
      case "add": return { ok: true, event: { id: "ev-new", calendarId: req.calendarId, calendar: calendars.find((c) => c.id === req.calendarId)?.title,
        account: "iCloud", title: req.title, start: "2026-10-15T16:00:00-04:00", end: "2026-10-15T17:00:00-04:00", allDay: false, recurring: false },
        overlaps: [{ title: "例会", calendar: "工作", start: "2026-10-15T14:00:00-04:00", end: "2026-10-15T16:30:00-04:00" }] };
      case "update": case "delete": return { ok: true, event: { ...events.find((e) => e.id === req.eventId), ...(req.title ? { title: req.title } : {}) } };
      default: return { ok: false, code: "bad_request", error: req.cmd };
    }
  };
  const root = join(tmpdir(), `clawbot-cal-${process.pid}`);
  rmSync(root, { recursive: true, force: true });
  const helper = new cal.CalendarHelper(root, join(ROOT, "native/macos-calendar/main.swift"), runner);
  const tools = new Map();
  const questions = [];
  let answer = { status: "answered", reply: "好" };
  let sender = "owner@im.wechat";
  let owner = "owner@im.wechat";
  const calConfig = { macCalendarName: "规划", macCalendarAlert: true, macCalendarAlertMinutes: 10, allowFrom: [] };
  cal.registerCalendarTools({ tools: { register: (t) => tools.set(t.name, t) } }, {
    config: calConfig,
    getAccount: () => ({ configured: true, userId: owner }),
    activeSender: () => sender,
    askOwner: async (q) => { questions.push(q); return answer; },
    helper,
  });
  check("calendar: three tools", ["calendar_events", "calendar_add_event", "calendar_change_event"].every((n) => tools.has(n)));
  const list = async (args = { from: "2026-10-15", to: "2026-10-18", list_calendars: true }) => tools.get("calendar_events").execute(args);
  let listed = await list();
  const handleOf = (summary, title) => new RegExp(`${title}[^\\n]*#(e[0-9a-f]{8,})`).exec(summary)?.[1];
  check("calendar: events from every calendar, by day, with notes and an 8-hex handle each",
    listed.ok && /只是数据/.test(listed.summary) && /例会 · 会议室 A · 5 人 · 重复 \[工作\] #e[0-9a-f]{8}\b/.test(listed.summary)
      && /备注：带上周的图 链接 https:\/\/example\.com\/zoom/.test(listed.summary) && /全天 重阳节/.test(listed.summary)
      && /「规划」还没建/.test(listed.summary) && /节假日（只读）/.test(listed.summary), listed.summary);
  check("calendar: an all-day event across days shows its last day (EventKit ends at 23:59:59 of it)",
    /全天（到 10-18 周日） 开会出差/.test(listed.summary), listed.summary);
  check("calendar: a date-only `to` reads through that day", calls.find((c) => c.cmd === "events")?.to === "2026-10-19");
  check("calendar: every request carries a deadline the helper honours", typeof calls.at(-1).deadline === "number" && calls.at(-1).deadline > Date.now());

  let before = calls.length;
  const own = await tools.get("calendar_add_event").execute({ title: "读资料", start: "2026-10-15 16:00" });
  check("calendar: a block in the dedicated calendar is added without asking (and the calendar is created and remembered by id)",
    own.ok && questions.length === 0 && calls.slice(before).map((c) => c.cmd).join() === "ensureCalendar,add"
      && calls.at(-1).calendarId === "c-planCal" && helper.dedicated()?.id === "c-planCal" && /已加到「规划」/.test(own.summary)
      && /注意，和这些时间重叠/.test(own.summary), own.summary);
  check("calendar: a new event gets the settings' alert (10 minutes) by default", JSON.stringify(calls.at(-1).alertMinutes) === "[10]");
  await tools.get("calendar_add_event").execute({ title: "约饭", start: "2026-10-15 18:00", alert: "30" });
  check("calendar: …the owner's own lead time wins", JSON.stringify(calls.at(-1).alertMinutes) === "[30]");
  await tools.get("calendar_add_event").execute({ title: "开始就提醒", start: "2026-10-15 18:00", alert: "0" });
  check("calendar: …\"0\" is an alert at the start, \"none\" is no alert", JSON.stringify(calls.at(-1).alertMinutes) === "[0]");
  await tools.get("calendar_add_event").execute({ title: "不提醒", start: "2026-10-15 18:00", alert: "none" });
  check("calendar: …none", calls.at(-1).alertMinutes === undefined);
  // The kind of call some models make: every optional parameter
  // filled with an empty value. alert_minutes: 0 then meant "at the start" and
  // overrode the setting; now nothing empty may change anything.
  calConfig.macCalendarAlertMinutes = 15;
  await tools.get("calendar_add_event").execute({ title: "示例日程", start: "2026-10-15 10:00", end: "2026-10-15 11:00",
    all_day: false, location: "", notes: "", calendar: "", alert: "", alert_minutes: 0 });
  check("calendar: a model that fills every optional field with an empty value still gets the setting's alert (15)",
    JSON.stringify(calls.at(-1).alertMinutes) === "[15]" && calls.at(-1).location === undefined && calls.at(-1).notes === undefined
      && calls.at(-1).allDay === undefined && calls.at(-1).calendarId === "c-planCal", JSON.stringify(calls.at(-1)));
  await tools.get("calendar_add_event").execute({ title: "请假", start: "2026-10-16", all_day: false, alert: "" });
  check("calendar: …and a date-only start with a filled all_day:false is still all-day", calls.at(-1).allDay === undefined && calls.at(-1).alertMinutes === undefined);
  calConfig.macCalendarAlertMinutes = 10;
  await tools.get("calendar_add_event").execute({ title: "假期", start: "2026-10-16" });
  check("calendar: …an all-day event gets no default alert", calls.at(-1).cmd === "add" && calls.at(-1).alertMinutes === undefined);
  calConfig.macCalendarAlert = false;
  await tools.get("calendar_add_event").execute({ title: "跑步", start: "2026-10-15 07:00" });
  check("calendar: …and with alerts switched off, none (read live: no restart)", calls.at(-1).alertMinutes === undefined);
  calConfig.macCalendarAlert = true;
  check("calendar: the add tool tells the model a calendar alert does not replace its WeChat reminder",
    /still create one with schedule_create; both firing is fine/.test(tools.get("calendar_add_event").description));
  check("calendar: …and that a plain reminder stays a WeChat reminder, out of the calendar",
    /A plain reminder[\s\S]{0,300}do NOT put it in the calendar/.test(tools.get("calendar_add_event").description));

  // Another calendar: asked first; the answer decides; a non-yes reaches the model word for word.
  answer = { status: "answered", reply: "不，改到周五下午三点" };
  before = calls.length;
  const refusedAdd = await tools.get("calendar_add_event").execute({ title: "评审彩排", start: "2026-10-15 16:00", calendar: "工作" });
  check("calendar: another calendar asks the owner first; a no adds nothing and passes their words on",
    !refusedAdd.ok && questions.length === 1 && /加到你的「工作」日历（iCloud）吗/.test(questions[0])
      && /机主回复「不，改到周五下午三点」/.test(refusedAdd.summary) && !calls.slice(before).some((c) => c.cmd === "add"), refusedAdd.summary);
  answer = { status: "timeout" };
  const silent = await tools.get("calendar_add_event").execute({ title: "评审彩排", start: "2026-10-15 16:00", calendar: "工作" });
  check("calendar: silence is reported as silence, not as a refusal", !silent.ok && /10 分钟没回复/.test(silent.summary));
  answer = { status: "undelivered", detail: "微信现在不让 bot 主动发消息" };
  const undelivered = await tools.get("calendar_add_event").execute({ title: "评审彩排", start: "2026-10-15 16:00", calendar: "工作" });
  check("calendar: a question that never arrived executes nothing", !undelivered.ok && /问题没发到机主微信/.test(undelivered.summary));
  answer = { status: "answered", reply: "好的。" };
  const okAdd = await tools.get("calendar_add_event").execute({ title: "评审彩排", start: "2026-10-15 16:00", calendar: "工作" });
  check("calendar: …and a yes adds it there", okAdd.ok && calls.at(-1).cmd === "add" && calls.at(-1).calendarId === "c-work");
  const asked = questions.length;
  const readOnly = await tools.get("calendar_add_event").execute({ title: "x", start: "2026-10-15 16:00", calendar: "节假日" });
  check("calendar: a read-only calendar is refused before asking", !readOnly.ok && /只读/.test(readOnly.summary) && questions.length === asked);

  // Changes.
  listed = await list();
  const block = handleOf(listed.summary, "写报告");
  const moved = await tools.get("calendar_change_event").execute({ event: `#${block}`, action: "update", start: "2026-10-15 11:00" });
  check("calendar: moving its own block needs no question, and the helper is told where the event should be",
    moved.ok && questions.length === asked && calls.at(-1).cmd === "update" && calls.at(-1).expectCalendarId === "c-planCal"
      && calls.at(-1).currentStart === "2026-10-15T09:00:00-04:00", moved.summary);
  const sameName = handleOf(listed.summary, "同名日历里的事");
  const other = await tools.get("calendar_change_event").execute({ event: sameName, action: "delete" });
  check("calendar: a different calendar that merely shares the name is not the bot's: it asks",
    questions.length === asked + 1 && /删掉你「规划」日历里的「同名日历里的事」/.test(questions.at(-1)), other.summary);
  answer = { status: "answered", reply: "好" };
  await tools.get("calendar_change_event").execute({ event: handleOf(listed.summary, "例会"), action: "delete" });
  check("calendar: deleting one occurrence says only this one, and deletes it at its own occurrence",
    /（只这一次）/.test(questions.at(-1)) && /5 位参与者/.test(questions.at(-1))
      && calls.at(-1).cmd === "delete" && calls.at(-1).span === "this" && calls.at(-1).occurrence === "2026-10-15T14:00:00-04:00", questions.at(-1));
  listed = await list();
  await tools.get("calendar_change_event").execute({ event: handleOf(listed.summary, "例会"), action: "delete", scope: "future" });
  check("calendar: …deleting the series says so in the question",
    /连同之后的每一次一起删掉/.test(questions.at(-1)) && calls.at(-1).span === "future", questions.at(-1));
  listed = await list();
  const meeting2 = handleOf(listed.summary, "例会");
  const replace = await tools.get("calendar_change_event").execute({ event: meeting2, action: "update", notes: "带电脑" });
  check("calendar: shortened notes are not replaced wholesale by accident", !replace.ok && /add_notes/.test(replace.summary));
  await tools.get("calendar_change_event").execute({ event: meeting2, action: "update", add_notes: "带电脑" });
  check("calendar: …adding a line is appended by the helper", calls.at(-1).addNotes === "带电脑" && calls.at(-1).notes === undefined
    && /备注里加一句「带电脑」/.test(questions.at(-1)));
  listed = await list();
  await tools.get("calendar_change_event").execute({ event: handleOf(listed.summary, "写报告"), action: "update", scope: "this",
    title: "写报告第二章", start: "", end: "", all_day: false, location: "", clear_location: false, notes: "", clear_notes: false,
    add_notes: "", replace_notes: false, calendar: "", alert: "" });
  {
    const c = calls.at(-1);
    check("calendar: a change filled with empty values changes only what was asked (no wiped location, notes or alert, no all-day flip)",
      c.cmd === "update" && c.title === "写报告第二章" && !("location" in c) && !("notes" in c) && !("allDay" in c) && !("alertMinutes" in c) && !("start" in c),
      JSON.stringify(c));
  }
  listed = await list();
  await tools.get("calendar_change_event").execute({ event: handleOf(listed.summary, "写报告"), action: "update", clear_location: true, alert: "none" });
  check("calendar: removing a location or the alert takes an explicit clear_location / alert:none",
    calls.at(-1).location === "" && JSON.stringify(calls.at(-1).alertMinutes) === "[]");
  check("calendar: parseAlert", cal.parseAlert("") === undefined && cal.parseAlert(0) === undefined && cal.parseAlert("0") === 0
    && cal.parseAlert("15") === 15 && cal.parseAlert("30分钟") === 30 && cal.parseAlert("none") === "none" && cal.parseAlert("不要") === "none"
    && cal.parseAlert("soon") === undefined && cal.parseAlert(20) === 20);
  const unknown = await tools.get("calendar_change_event").execute({ event: "#e00000000", action: "delete" });
  check("calendar: an unknown handle says to look again", !unknown.ok && /先用 calendar_events/.test(unknown.summary));

  // The owner can switch the asking off (macCalendarAsk, read live): their
  // writable calendars are then changed directly, a change other attendees
  // would be told about still asks, and read-only calendars stay refused.
  calConfig.macCalendarAsk = false;
  listed = await list();
  {
    const askedBefore = questions.length;
    const add = await tools.get("calendar_add_event").execute({ title: "评审彩排", start: "2026-10-15 16:00", calendar: "工作" });
    check("calendar: with asking off, another calendar gets the event without a question",
      add.ok && questions.length === askedBefore && calls.at(-1).cmd === "add" && calls.at(-1).calendarId === "c-work", add.summary);
    const change = await tools.get("calendar_change_event").execute({ event: handleOf(listed.summary, "开会出差"), action: "update", title: "出差" });
    const drop = await tools.get("calendar_change_event").execute({ event: handleOf(listed.summary, "同名日历里的事"), action: "delete" });
    check("calendar: …and its events are changed or deleted without one",
      change.ok && drop.ok && questions.length === askedBefore && calls.at(-1).cmd === "delete", `${change.summary} / ${drop.summary}`);
    await tools.get("calendar_change_event").execute({ event: handleOf(listed.summary, "例会"), action: "update", start: "2026-10-15 15:00" });
    check("calendar: …but a change other attendees would be told about still asks",
      questions.length === askedBefore + 1 && /5 位参与者/.test(questions.at(-1)), questions.at(-1));
    const readOnly2 = await tools.get("calendar_add_event").execute({ title: "x", start: "2026-10-15 16:00", calendar: "节假日" });
    check("calendar: …and a read-only calendar is still refused", !readOnly2.ok && /只读/.test(readOnly2.summary));
    check("calendar: the tools tell the model never to ask on its own (the tool asks when it has to)",
      /never ask separately/.test(tools.get("calendar_add_event").description) && /never ask separately/.test(tools.get("calendar_change_event").description));
  }
  delete calConfig.macCalendarAsk;

  // A calendar with the chosen name that the bot did not create: asked once, remembered by id.
  {
    const root2 = join(tmpdir(), `clawbot-cal2-${process.pid}`);
    rmSync(root2, { recursive: true, force: true });
    const helper2 = new cal.CalendarHelper(root2, join(ROOT, "native/macos-calendar/main.swift"), runner);
    const tools2 = new Map();
    const q2 = [];
    let reply2 = { status: "answered", reply: "不要" };
    calendars = [work, hol, gPlanCal];
    cal.registerCalendarTools({ tools: { register: (t) => tools2.set(t.name, t) } }, {
      config: { macCalendarName: "规划" }, getAccount: () => ({ configured: true, userId: "owner@im.wechat" }),
      activeSender: () => "owner@im.wechat", askOwner: async (q) => { q2.push(q); return reply2; }, helper: helper2,
    });
    const no = await tools2.get("calendar_add_event").execute({ title: "a", start: "2026-10-15 16:00" });
    check("calendar: an existing calendar with the chosen name is not adopted silently; a no leaves it alone",
      !no.ok && /已经有一个叫「规划」的日历（Google）/.test(q2[0]) && helper2.dedicated() === null && /换个没用过的名字/.test(no.summary), no.summary);
    reply2 = { status: "answered", reply: "好" };
    const yes = await tools2.get("calendar_add_event").execute({ title: "a", start: "2026-10-15 16:00" });
    check("calendar: …a yes adopts it, remembered by its id", yes.ok && helper2.dedicated()?.id === "c-gplanCal" && calls.at(-1).calendarId === "c-gplanCal");
    rmSync(root2, { recursive: true, force: true });
    calendars = [work, hol, planCal];
  }

  sender = "friend@im.wechat";
  before = calls.length;
  const friend = await tools.get("calendar_events").execute({});
  check("calendar: only the owner — a friend is refused before anything is read",
    !friend.ok && /只对机主开放/.test(friend.summary) && calls.length === before);
  sender = undefined;
  const gui = await tools.get("calendar_events").execute({ from: "2026-10-15" });
  check("calendar: the owner using the bot's session from the web UI is allowed", gui.ok);
  calConfig.allowFrom = ["owner@im.wechat", "friend@im.wechat"];
  const shared = await tools.get("calendar_events").execute({});
  check("calendar: with others on the allow list (one shared conversation) the tools refuse", !shared.ok && /白名单里还有别人/.test(shared.summary));
  calConfig.allowFrom = [];
  owner = undefined;
  const nobody = await tools.get("calendar_events").execute({});
  check("calendar: with no known owner id the tools fail closed", !nobody.ok && /不知道机主是谁/.test(nobody.summary));
  owner = "owner@im.wechat";
  sender = "owner@im.wechat";

  authorization = "denied";
  const denied = await tools.get("calendar_events").execute({});
  check("calendar: a refusal says where to turn it on", !denied.ok && /系统设置 → 隐私与安全性 → 日历/.test(denied.summary) && /Clawbot-Calendar/.test(denied.summary));
  authorization = "notDetermined";
  before = calls.length;
  const undecided = await tools.get("calendar_events").execute({});
  await sleep(20);
  check("calendar: not authorized yet: it points at 一键授权 at the Mac, and puts up no prompt by itself (nobody may be there)",
    !undecided.ok && /一键授权/.test(undecided.summary) && /Mac 前/.test(undecided.summary)
      && !calls.slice(before).some((c) => c.cmd === "request" || c.cmd === "status"), undecided.summary);
  authorization = "fullAccess";

  check("calendar: a yes is a clear yes; silence and maybes are no",
    cal.isYes("好") && cal.isYes("好的。") && cal.isYes("OK") && !cal.isYes(null) && !cal.isYes("不要") && !cal.isYes("好吧不行") && !cal.isYes("等一下"));
  check("calendar: when() reads EventKit's inclusive all-day end as that same day",
    cal.when("2026-10-15T00:00:00-04:00", "2026-10-15T23:59:59-04:00", true).endsWith("全天")
      && !cal.when("2026-10-15T00:00:00-04:00", "2026-10-15T23:59:59-04:00", true).includes("至"));
  const bridgeSrc = readFileSync(join(ROOT, "src/bridge.ts"), "utf-8");
  check("calendar: the tools exist only when switched on, on a Mac, and use the owner-only question",
    /this\.config\.macCalendar === true\s*&& process\.platform === "darwin"/.test(bridgeSrc)
      && /askOwner: \(question, signal\) => this\.askOwner\(question, 600_000, signal\)/.test(bridgeSrc));
  check("calendar: every tool the bridge registers is taken back when it goes (so a switched-off tool really goes)",
    /this\.releaseTools\(\);\s*\/\/ Dispose the agent first/.test(bridgeSrc) && /const agentCtx = this\.trackingTools\(target\);/.test(bridgeSrc));
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
  check("calendar: the Swift source ships in the npm package", pkg.files.includes("native")
    && existsSync(join(ROOT, "native/macos-calendar/main.swift")));
  rmSync(root, { recursive: true, force: true });

  // The owner-only question on a real bridge: to the owner, after delivery, and never a stale yes.
  {
    const { WechatBridge } = await import(join(ROOT, "lib/bridge.js"));
    const { PendingRegistry } = await import(join(ROOT, "lib/pending.js"));
    const { DEFAULT_CONFIG } = await import(join(ROOT, "lib/config.js"));
    const sent = [];
    let failSend = false;
    const pending = new PendingRegistry();
    const config = { ...DEFAULT_CONFIG, sessionId: "sim-wechat", autoMemory: false, idleCompaction: false };
    const deps = { getAccount: () => ({ configured: true, userId: "owner@im.wechat" }), getContextToken: () => "", pending };
    const bridge = new WechatBridge({ agents: { get: () => undefined } }, config, async (to, text) => {
      if (failSend) throw new Error("sendMessage ret=-2 errmsg=prepare failed");
      sent.push({ to, text });
    }, deps);
    const asking = bridge.askOwner("要删掉吗？", 2_000);
    await sleep(20);
    const entry = pending.popFor("owner@im.wechat");
    check("askOwner: the question goes to the account owner, and only then waits for an answer",
      sent.length === 1 && sent[0].to === "owner@im.wechat" && entry !== undefined);
    entry?.resolve("好");
    const got = await asking;
    check("askOwner: …the reply comes back as an answer", got.status === "answered" && got.reply === "好");
    failSend = true;
    const lost = await bridge.askOwner("要删掉吗？", 2_000);
    check("askOwner: a question WeChat refused is reported as undelivered, and nothing is left waiting for the next message",
      lost.status === "undelivered" && pending.popFor("owner@im.wechat") === undefined);
    failSend = false;
    const late = await bridge.askOwner("要删掉吗？", 30);
    check("askOwner: no answer in time is a timeout, and the question is withdrawn",
      late.status === "timeout" && pending.popFor("owner@im.wechat") === undefined);
    await bridge.dispose();
  }
  setLogLevel("info");
}

// ------------------------------------------------------------- 全天候秘书 · 闹钟(2026-10-22)
// 闹钟 = 「提醒事项」里的紧急提醒:到点像闹钟一样响(响在「查找」里作为“我的位置”的设备上,一般是 iPhone),
// 不靠微信。放在机器人自己的闹钟清单里,第一次按「<日历名> 闹钟」建,之后按编号认;小程序经私有的
// ReminderKit 去设(这里用假的小程序,不碰真的提醒事项)。
{
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const { setLogLevel } = await import(join(ROOT, "lib/ilink/util/logger.js"));
  setLogLevel("error");
  const calA = await import(join(ROOT, "lib/mac-calendar.js"));
  const alarmsMod = await import(join(ROOT, "lib/mac-alarms.js"));
  const { zonedDate } = await import(join(ROOT, "lib/localtime.js"));
  const { createHash } = await import("node:crypto");
  const aCalls = [];
  let reminders = "fullAccess";
  let lists = [];
  let items = []; // { listId, id, title, due?, urgent, completed, notes? }
  let oldHelper = false;
  let urgentWorks = true;
  let dropNext = false;
  /** Answered once instead of the real thing (a thrown value when it is null or an Error). */
  let failNext = null;
  let nextId = 0;
  const shown = (a) => {
    const { listId: _listId, ...rest } = a;
    return rest;
  };
  const aRunner = async (req) => {
    aCalls.push(req);
    if (failNext !== null && failNext.cmd === req.cmd) {
      const res = failNext.res;
      failNext = null;
      if (res === null || res instanceof Error) throw res;
      return res;
    }
    if (oldHelper && (req.cmd.startsWith("alarm") || req.cmd === "ensureAlarmList")) return { ok: false, code: "bad_request", error: `unknown command ${req.cmd}` };
    if (req.cmd === "status") return { ok: true, authorization: "fullAccess", reminders, protocol: 3, alarms: "supported" };
    if (reminders !== "fullAccess") return { ok: false, code: "reminders_not_authorized", error: reminders };
    switch (req.cmd) {
      case "ensureAlarmList": {
        const known = lists.find((l) => l.id === req.knownId);
        if (known) return { ok: true, list: known, created: false };
        const same = lists.find((l) => l.name === req.name);
        if (same) return { ok: true, list: same, created: false, adopted: true };
        const list = { id: `L${++nextId}`, name: req.name, account: "iCloud" };
        lists.push(list);
        return { ok: true, list, created: true };
      }
      case "alarmAdd": {
        if (dropNext) { dropNext = false; lists = []; }
        if (!lists.some((l) => l.id === req.listId)) return { ok: false, code: "no_list", error: "the alarm list is gone" };
        const a = {
          listId: req.listId, id: `R${++nextId}`, title: req.title, urgent: urgentWorks,
          due: /(?:Z|[+-]\d{2}:\d{2})$/.test(req.due) ? alarmsMod.isoAt(new Date(req.due)) : alarmsMod.isoAt(alarmsMod.parseAlarmTime(req.due).at),
          completed: false, ...(req.notes ? { notes: req.notes } : {}),
        };
        items.push(a);
        return { ok: true, alarm: shown(a) };
      }
      case "alarms":
        if (!lists.some((l) => l.id === req.listId)) return { ok: false, code: "no_list", error: "the alarm list is gone" };
        return { ok: true, alarms: items.filter((a) => a.listId === req.listId).map(shown), list: lists.find((l) => l.id === req.listId) };
      case "alarmDelete": {
        const a = items.find((x) => x.id === req.id && x.listId === req.listId);
        if (a === undefined) return { ok: false, code: "no_alarm", error: "gone" };
        items = items.filter((x) => x !== a);
        return { ok: true, alarm: shown(a) };
      }
      case "alarmComplete": {
        let n = 0;
        for (const a of items) if (a.listId === req.listId && req.ids.includes(a.id) && !a.completed) { a.completed = true; n += 1; }
        return { ok: true, completed: n };
      }
      default: return { ok: false, code: "bad_request", error: `unknown command ${req.cmd}` };
    }
  };
  const aRoot = join(tmpdir(), `clawbot-alarms-${process.pid}`);
  rmSync(aRoot, { recursive: true, force: true });
  const aHelper = new calA.CalendarHelper(aRoot, join(ROOT, "native/macos-calendar/main.swift"), aRunner);
  const aConfig = { macCalendarName: "", allowFrom: [] };
  const service = new alarmsMod.AlarmService(aHelper, () => aConfig.macCalendarName);
  const aTools = new Map();
  let aSender = "owner@im.wechat";
  let aOwner = "owner@im.wechat";
  alarmsMod.registerAlarmTools({ tools: { register: (t) => aTools.set(t.name, t) } }, {
    config: aConfig, getAccount: () => ({ configured: true, userId: aOwner }), activeSender: () => aSender, alarms: service,
  });
  check("alarms: three tools", ["alarm_set", "alarm_list", "alarm_cancel"].every((n) => aTools.has(n)));
  const set = (args) => aTools.get("alarm_set").execute(args);
  const listAlarms = () => aTools.get("alarm_list").execute({});
  const cancel = (alarm) => aTools.get("alarm_cancel").execute({ alarm });
  const tagOf = (summary, title) => new RegExp(`「${title}」[^\\n]*#(a[0-9a-f]{8,})`).exec(summary)?.[1];
  // Days from today, so the tests keep working whenever they run.
  const day = (n) => zonedDate(new Date(Date.now() + n * 86_400_000));
  const at = (n, hm) => `${day(n)} ${hm}`;
  const when = (text) => alarmsMod.alarmWhen(alarmsMod.parseAlarmTime(text).at);

  let r = await set({ time: at(30, "07:00"), title: "起床" });
  check("alarms: no calendar name yet: it says where to set one, and touches nothing",
    !r.ok && /专用日历还没起名字/.test(r.summary) && /全天候秘书/.test(r.summary) && aCalls.length === 0, r.summary);
  aConfig.macCalendarName = "规划";
  r = await set({ time: "", title: "", note: "" });
  check("alarms: a time is required (an empty one counts as missing)", !r.ok && /要给出响的时间/.test(r.summary) && aCalls.length === 0);
  r = await set({ time: day(30) });
  check("alarms: a date alone is not an alarm time", !r.ok && /一定要有钟点/.test(r.summary));
  r = await set({ time: "2027-02-30 07:00" });
  check("alarms: a date that does not exist is refused, not rolled over", !r.ok && /不是一个真实存在的时间/.test(r.summary));
  r = await set({ time: "2020-01-01 07:00" });
  check("alarms: a time in the past is refused", !r.ok && /已经过了/.test(r.summary) && aCalls.length === 0);
  r = await set({ time: at(500, "07:00") });
  check("alarms: more than a year ahead is refused (that belongs in the calendar)", !r.ok && /一年多以后/.test(r.summary) && aCalls.length === 0);

  r = await set({ time: at(30, "07:00"), title: "起床", note: "" });
  const add1 = aCalls.find((c) => c.cmd === "alarmAdd");
  check("alarms: the first alarm makes the list 「规划 闹钟」, looks at what is set, and sends the wall clock (macOS works out the instant)",
    r.ok && aCalls[0].cmd === "ensureAlarmList" && aCalls[0].name === "规划 闹钟" && aCalls[0].knownId === undefined
      && aCalls[1].cmd === "alarms" && add1 !== undefined && add1.due === `${day(30)}T07:00` && add1.title === "起床" && !("notes" in add1)
      && add1.listId === lists[0].id, JSON.stringify(add1));
  check("alarms: the answer gives the day, the time, the list and a handle — and promises nothing about a phone it cannot see",
    r.summary.includes(`已设闹钟：${when(at(30, "07:00"))}「起床」`) && /#a[0-9a-f]{8}\b/.test(r.summary) && /「规划 闹钟」/.test(r.summary)
      && !/iPhone 上响/.test(r.summary), r.summary);
  check("alarms: the list is remembered by id, with the name Reminders gave it",
    aHelper.alarmList()?.id === lists[0].id && aHelper.alarmList()?.name === "规划 闹钟");
  aCalls.length = 0;
  r = await set({ time: `${day(29)}T06:30`, title: "", note: "带护照" });
  const add2 = aCalls.find((c) => c.cmd === "alarmAdd");
  check("alarms: the next one asks for the known list; an empty title becomes 闹钟; a note goes along",
    r.ok && aCalls[0].knownId === lists[0].id && add2?.title === "闹钟" && add2?.notes === "带护照", r.summary);

  // The same alarm twice (a retry after a timeout, a routine run twice): found, not set again.
  aCalls.length = 0;
  r = await set({ time: at(30, "07:00"), title: "起床" });
  check("alarms: the same time and title is not set twice; it says it is already set",
    r.ok && /已经设过了/.test(r.summary) && !aCalls.some((c) => c.cmd === "alarmAdd")
      && items.filter((a) => a.title === "起床").length === 1, r.summary);
  r = await set({ time: at(30, "07:00"), title: "吃药" });
  check("alarms: …a different title at the same minute is a different alarm", r.ok && /已设闹钟/.test(r.summary), r.summary);

  // What alarm_list shows.
  const listId = lists[0].id;
  const iso = (ms) => new Date(ms).toISOString();
  items.push({ listId, id: "Rdone", title: "旧的", due: iso(Date.now() - 30 * 86_400_000), urgent: true, completed: true });
  items.push({ listId, id: "Rplain", title: "普通提醒", due: alarmsMod.parseAlarmTime(at(31, "08:00")).at.toISOString(), urgent: false, completed: false });
  items.push({ listId, id: "Rnotime", title: "护照放包里", urgent: true, completed: false });
  items.push({ listId, id: "Rrang", title: "刚响过", due: iso(Date.now() - 3_600_000), urgent: true, completed: false });
  items.push({ listId, id: "Rold", title: "很早响过", due: iso(Date.now() - 3 * 3_600_000), urgent: true, completed: false });
  items.push({ listId, id: "Rtodo", title: "自己的待办", due: iso(Date.now() - 4 * 3_600_000), urgent: false, completed: false });
  items.push({ listId, id: "Rforeign", title: "别人设的紧急提醒", due: iso(Date.now() - 5 * 3_600_000), urgent: true, completed: false });
  aHelper.rememberCreatedAlarm("Rold");
  aCalls.length = 0;
  const listed = await listAlarms();
  check("alarms: the list shows what has not rung yet, soonest first; completed ones are left out",
    listed.ok && /还没响的闹钟（4 个）/.test(listed.summary)
      && listed.summary.indexOf("06:30") < listed.summary.indexOf("「起床」") && !/旧的/.test(listed.summary), listed.summary);
  check("alarms: …one that is not urgent says it will only notify", /普通提醒」（不是紧急提醒，只会通知/.test(listed.summary));
  check("alarms: …one without a time is listed with a handle, not counted as rung",
    /没有时间、不会响的（1 个）/.test(listed.summary) && tagOf(listed.summary, "护照放包里") !== undefined, listed.summary);
  check("alarms: …ones whose time passed but are still open are listed with handles too",
    /时间已经过了、还没勾掉的（4 个）/.test(listed.summary) && tagOf(listed.summary, "刚响过") !== undefined, listed.summary);
  await sleep(20);
  const tidied = aCalls.find((c) => c.cmd === "alarmComplete");
  check("alarms: alarms the plugin set that rang hours ago are marked done in the background (not one that just rang, a to-do, or one it did not set)",
    tidied !== undefined && tidied.ids.length === 1 && tidied.ids[0] === "Rold" && items.find((a) => a.id === "Rold").completed === true
      && items.find((a) => a.id === "Rrang").completed === false && items.find((a) => a.id === "Rtodo").completed === false
      && items.find((a) => a.id === "Rforeign").completed === false && !aHelper.createdAlarms().has("Rold"), JSON.stringify(tidied));
  const tag = tagOf(listed.summary, "起床");
  r = await cancel(`#${tag}`);
  check("alarms: cancel by handle removes that one alarm",
    r.ok && r.summary.includes(`已取消闹钟：${when(at(30, "07:00"))}「起床」`) && !items.some((a) => a.title === "起床"), r.summary);
  r = await cancel(`#${tag}`);
  check("alarms: the same handle again (or an unknown one) says to look again", !r.ok && /先用 alarm_list/.test(r.summary));
  r = await cancel(`＃${tagOf(listed.summary, "吃药").toUpperCase()}`);
  check("alarms: a handle typed in capitals, or with a full-width ＃, still works", r.ok, r.summary);

  // The calendar renamed on the card: the alarms already set stay reachable (the list is kept by id).
  r = await set({ time: at(40, "05:30"), title: "赶飞机" });
  aConfig.macCalendarName = "计划";
  aCalls.length = 0;
  const afterRename = await listAlarms();
  check("alarms: after renaming the calendar, the alarms already set are still listed (the list is kept by id)",
    afterRename.ok && /「赶飞机」/.test(afterRename.summary) && aCalls[0].knownId === listId && lists.length === 1, afterRename.summary);
  r = await cancel(`#${tagOf(afterRename.summary, "赶飞机")}`);
  check("alarms: …and can be cancelled", r.ok && !items.some((a) => a.title === "赶飞机"), r.summary);
  r = await set({ time: at(41, "05:30"), title: "又一个" });
  check("alarms: …new ones go in the same list, named as Reminders has it",
    r.ok && /「规划 闹钟」/.test(r.summary) && aHelper.alarmList()?.name === "规划 闹钟" && lists.length === 1, r.summary);

  // The list deleted on the phone: the next alarm makes a new one, under the name now on the card.
  lists = [];
  items = [];
  aCalls.length = 0;
  r = await set({ time: at(42, "07:00"), title: "开会" });
  check("alarms: a list deleted on the phone is made again (under the current name), and the alarm still lands",
    r.ok && lists.length === 1 && lists[0].name === "计划 闹钟" && aHelper.alarmList()?.id === lists[0].id && /「计划 闹钟」/.test(r.summary), r.summary);
  dropNext = true;
  aCalls.length = 0;
  r = await set({ time: at(42, "08:00"), title: "开会2" });
  check("alarms: a list that vanishes between the check and the write is made again once",
    r.ok && aCalls.filter((c) => c.cmd === "ensureAlarmList").length === 2 && aCalls.filter((c) => c.cmd === "alarmAdd").length === 2, r.summary);

  urgentWorks = false;
  r = await set({ time: at(43, "07:00"), title: "试试" });
  check("alarms: when Reminders did not keep it urgent, the model is told to say so", r.ok && /没能设成紧急提醒/.test(r.summary));
  urgentWorks = true;

  // Timeouts say what may have happened, for what was being done.
  const late = { ok: false, code: "timeout", error: "Clawbot-Calendar 没在 30 秒内回应" };
  failNext = { cmd: "alarmAdd", res: late };
  r = await set({ time: at(44, "07:00"), title: "超时" });
  check("alarms: a set that timed out says it may be set, and that setting it again is safe",
    !r.ok && /可能已经设上了/.test(r.summary) && /不会设两个/.test(r.summary), r.summary);
  const l2 = await listAlarms();
  failNext = { cmd: "alarmDelete", res: late };
  r = await cancel(`#${tagOf(l2.summary, "开会2")}`);
  check("alarms: a cancel that timed out says it may be cancelled (not 'set')", !r.ok && /可能已经取消了/.test(r.summary) && !/设上了/.test(r.summary), r.summary);
  failNext = { cmd: "alarms", res: late };
  r = await listAlarms();
  check("alarms: a listing that timed out just says to try later", !r.ok && /稍后再试/.test(r.summary) && !/alarm_list/.test(r.summary), r.summary);

  // Helper answers that make no sense are reported, not thrown.
  failNext = { cmd: "ensureAlarmList", res: { ok: true } };
  r = await set({ time: at(45, "07:00"), title: "坏回答" });
  check("alarms: an answer without the list is a message, not a crash", !r.ok && /回答不完整/.test(r.summary), r.summary);
  failNext = { cmd: "alarms", res: { ok: true, alarms: { not: "a list" } } };
  r = await listAlarms();
  check("alarms: alarms that are not a list read as none", r.ok && /没有还没响的闹钟/.test(r.summary), r.summary);
  failNext = { cmd: "alarmAdd", res: { ok: true } };
  r = await set({ time: at(45, "07:30"), title: "坏回答2" });
  check("alarms: a set answered without the alarm says to look before trying again", !r.ok && /alarm_list/.test(r.summary), r.summary);
  failNext = { cmd: "ensureAlarmList", res: null };
  r = await set({ time: at(45, "08:00"), title: "抛了个空" });
  check("alarms: a runner that throws no error at all is still a message", !r.ok && /闹钟操作失败/.test(r.summary), r.summary);

  reminders = "notDetermined";
  r = await set({ time: at(46, "07:00") });
  check("alarms: no Reminders permission yet: it points at 一键授权, at the Mac", !r.ok && /一键授权/.test(r.summary) && /Mac 前/.test(r.summary), r.summary);
  reminders = "denied";
  r = await set({ time: at(46, "07:00") });
  check("alarms: a refused permission says where to turn it on", !r.ok && /隐私与安全性 → 提醒事项/.test(r.summary));
  reminders = "fullAccess";
  oldHelper = true;
  r = await set({ time: at(46, "07:00") });
  check("alarms: a helper built before the alarms says to update it with 一键授权", !r.ok && /旧版/.test(r.summary) && /一键授权/.test(r.summary), r.summary);
  oldHelper = false;

  // While the Reminders prompt is on the Mac's screen, alarms answer "waiting" at once; the calendar goes ahead.
  const calShared = globalThis[Symbol.for("clawbot.calendar")];
  calShared.pending = { calendar: false, reminders: true };
  aCalls.length = 0;
  r = await set({ time: at(46, "07:00") });
  await aHelper.call({ cmd: "events", from: "2026-10-15", to: "2026-10-16" });
  calShared.pending = undefined;
  check("alarms: while the Reminders prompt is up, alarm tools say so at once; the calendar's commands still go through",
    !r.ok && /正在等 Mac 上的授权/.test(r.summary) && aCalls.every((c) => c.cmd === "events") && aCalls.length === 1, r.summary);

  aSender = "friend@im.wechat";
  r = await set({ time: at(46, "07:00") });
  check("alarms: only the owner — and the refusal speaks of alarms, not the calendar", !r.ok && /闹钟只对机主开放/.test(r.summary));
  aSender = undefined;
  r = await listAlarms();
  check("alarms: the owner using the bot's session from the web UI is allowed", r.ok, r.summary);
  aSender = "owner@im.wechat";
  aConfig.allowFrom = ["owner@im.wechat", "friend@im.wechat"];
  r = await listAlarms();
  check("alarms: with others on the allow list the tools refuse", !r.ok && /闹钟工具不开放/.test(r.summary));
  aConfig.allowFrom = [];
  aOwner = "";
  r = await listAlarms();
  check("alarms: with no known owner id the tools fail closed", !r.ok && /不知道机主是谁/.test(r.summary));
  aOwner = "owner@im.wechat";

  // Two sets of the same alarm at once (a retry racing the first try): one alarm, not two.
  const [same1, same2] = await Promise.all([set({ time: at(47, "06:00"), title: "同时" }), set({ time: at(47, "06:00"), title: "同时" })]);
  check("alarms: two sets of the same alarm at once make one alarm (the look and the add do not interleave)",
    same1.ok && same2.ok && [same1, same2].filter((x) => /已经设过了/.test(x.summary)).length === 1
      && items.filter((a) => a.title === "同时").length === 1, `${same1.summary} / ${same2.summary}`);

  const desc = aTools.get("alarm_set").description;
  check("alarms: the tool says when an alarm is right, where it rings, that it is never set twice, and how to move one",
    /闹钟, 叫醒/.test(desc) && /stays a WeChat reminder \(schedule_create\)/.test(desc) && /does not go through WeChat/.test(desc)
      && /Find My/.test(desc) && /never set twice/.test(desc) && /set the new time first, then cancel the old one/.test(desc));

  // Times: the owner's wall clock in, the exact instant (with its offset) out to the helper.
  check("alarms: parseAlarmTime takes a space or a T, and ignores seconds",
    alarmsMod.parseAlarmTime("2027-01-15 07:00").wall === "2027-01-15T07:00" && alarmsMod.parseAlarmTime("2027-1-5T7:05:30").wall === "2027-01-05T07:05");
  check("alarms: isoAt names the very same instant, with the owner's offset",
    [0, 1, 2, 3, 4, 5, 6, 7].every((k) => {
      const t = new Date(Date.UTC(2027, 0, 15 + k * 45, 12, 0));
      return new Date(alarmsMod.isoAt(t)).getTime() === t.getTime() && /[+-]\d{2}:\d{2}$/.test(alarmsMod.isoAt(t));
    }));
  check("alarms: a due time the helper reports is shown by its own wall clock (macOS's time-zone rules, not Node's)",
    alarmsMod.dueWhen("2026-11-15T07:00:00-05:00", new Date("2026-10-22T12:00:00Z")) === "11-15 周日 07:00"
      && alarmsMod.dueWhen("2027-01-02T06:30:00+08:00", new Date("2026-10-22T12:00:00Z")) === "2027-01-02 周六 06:30"
      && alarmsMod.dueWhen("nonsense") === "（没有时间）");
  check("alarms: alarmWhen shows the year only when it is not this year's (so a year slip shows)",
    alarmsMod.alarmWhen(new Date("2027-10-24T12:00:00Z"), new Date("2027-01-02T12:00:00Z")).startsWith("10-24 ")
      && alarmsMod.alarmWhen(new Date("2027-10-24T12:00:00Z"), new Date("2026-10-22T12:00:00Z")).startsWith("2027-10-24 "));
  {
    check("alarms: the hour skipped when the clocks go forward is not a time (New York, 2027-03-14 02:30)",
      "error" in alarmsMod.parseAlarmTime("2027-03-14 02:30") && !("error" in alarmsMod.parseAlarmTime("2027-03-14 03:30")));
    check("alarms: a winter time reads back with the winter offset", alarmsMod.parseAlarmTime("2027-01-15 07:00").at.toISOString() === "2027-01-15T12:00:00.000Z");
    const rep = alarmsMod.parseAlarmTime("2026-11-01 01:30");
    check("alarms: a time in the hour repeated when the clocks go back names two instants; the first is used (New York, 2026-11-01 01:30)",
      rep.at.toISOString() === "2026-11-01T05:30:00.000Z" && rep.repeated?.toISOString() === "2026-11-01T06:30:00.000Z"
        && alarmsMod.isoAt(rep.at) === "2026-11-01T01:30:00-04:00" && alarmsMod.isoAt(rep.repeated) === "2026-11-01T01:30:00-05:00");
    // In that hour, a time whose first instant has passed cannot be set: Reminders would read it back as the first.
    const realNow = Date.now;
    try {
      Date.now = () => Date.parse("2026-11-01T06:05:00Z"); // 01:05 EST, the second time round
      aCalls.length = 0;
      r = await set({ time: "2026-11-01 01:40", title: "重复的那一小时" });
      const refusedRepeat = !r.ok && /夏令时结束/.test(r.summary) && aCalls.length === 0;
      Date.now = () => Date.parse("2026-11-01T05:05:00Z"); // 01:05 EDT, the first time round
      r = await set({ time: "2026-11-01 01:40", title: "重复的那一小时" });
      const addRepeat = aCalls.find((c) => c.cmd === "alarmAdd");
      check("alarms: in the repeated hour, a time whose first instant passed is refused; one still ahead is set at that first instant",
        refusedRepeat && r.ok && addRepeat?.due === "2026-11-01T01:40:00-04:00", r.summary);
    } finally {
      Date.now = realNow;
    }
  }
  // Other zones, each in a child process: every quarter hour of each day the clocks change, against a brute-force scan.
  {
    const { execFileSync } = await import("node:child_process");
    const probe = `
      const m = await import(${JSON.stringify(pathToFileURL(join(ROOT, "lib/mac-alarms.js")).href)});
      const fmt = new Intl.DateTimeFormat("en-US", { timeZone: process.env.TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
      const wall = (ms) => { const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value])); return p.year + "-" + p.month + "-" + p.day + "T" + p.hour + ":" + p.minute; };
      const pad = (n) => String(n).padStart(2, "0");
      let bad = 0, checked = 0, repeated = 0, skipped = 0;
      for (const [y, mo, d] of JSON.parse(process.env.DAYS)) {
        for (let h = 0; h < 24; h += 1) for (let mi = 0; mi < 60; mi += 15) {
          const text = y + "-" + pad(mo) + "-" + pad(d) + "T" + pad(h) + ":" + pad(mi);
          const local = Date.UTC(y, mo - 1, d, h, mi);
          const truth = [];
          for (let ms = local - 15 * 3600e3; ms <= local + 15 * 3600e3; ms += 15 * 60e3) if (wall(ms) === text) truth.push(ms);
          const got = m.parseAlarmTime(text);
          checked += 1;
          if (truth.length === 0) skipped += 1;
          if (truth.length > 1) repeated += 1;
          const ok = truth.length === 0
            ? "error" in got
            : !("error" in got) && got.at.getTime() === truth[0] && new Date(m.isoAt(got.at)).getTime() === truth[0]
              && (truth.length > 1 ? got.repeated?.getTime() === truth[1] : got.repeated === undefined);
          if (!ok) bad += 1;
        }
      }
      console.log(JSON.stringify({ bad, checked, repeated, skipped }));
    `;
    const zones = {
      "America/New_York": [[2026, 11, 1], [2027, 3, 14]],
      "Europe/London": [[2026, 10, 25], [2027, 3, 28]],
      "Australia/Lord_Howe": [[2027, 4, 4], [2026, 10, 4]],
      "Pacific/Chatham": [[2027, 4, 4], [2026, 9, 27]],
      "Asia/Shanghai": [[2026, 10, 25]],
    };
    for (const [zone, days] of Object.entries(zones)) {
      let out;
      try {
        const text = execFileSync(process.execPath, ["--input-type=module", "-e", probe], {
          env: { ...process.env, TZ: zone, DAYS: JSON.stringify(days) }, encoding: "utf-8",
        });
        out = JSON.parse(text.trim().split("\n").pop());
      } catch (err) {
        out = { bad: -1, error: String(err).slice(0, 200) };
      }
      check(`alarms: in ${zone}, wall-clock times on the days the clocks change read as the right instants (a repeated one as its first, a skipped one refused)`,
        out.bad === 0 && out.checked > 0 && (zone === "Asia/Shanghai" || (out.repeated > 0 && out.skipped > 0)), JSON.stringify(out));
    }
  }
  const now = new Date("2026-10-22T20:04:31Z");
  const t = alarmsMod.testAlarmTime(now).getTime();
  check("alarms: the test alarm is 2–3 minutes out, on a whole minute", t - now.getTime() >= 120_000 && t - now.getTime() < 180_000 && t % 60_000 === 0);

  // The card's buttons.
  const fakeRes = () => ({ status: 0, body: null, writeHead(code) { this.status = code; }, end(text) { this.body = JSON.parse(text); } });
  const post = (headers) => ({ method: "POST", headers: { host: "127.0.0.1:3080", "content-type": "application/json", ...headers } });
  const prepared = [];
  let plan = { ask: ["reminders"], denied: [] };
  const stubHelper = { prepare: async (force) => { prepared.push(force); }, invalidateStatus() {}, authorizePlan: async () => plan };
  let on = true;
  const cardDeps = { helper: stubHelper, alarms: service, enabled: () => on };
  let res = fakeRes();
  await alarmsMod.handleCardRoute("authorize", { method: "GET", headers: {} }, res, cardDeps);
  check("card buttons: GET is refused", res.status === 405 && prepared.length === 0);
  res = fakeRes();
  await alarmsMod.handleCardRoute("authorize", post({ origin: "https://evil.example" }), res, cardDeps);
  check("card buttons: another site's page is refused", res.status === 403 && prepared.length === 0);
  for (const kind of ["authorize", "test"]) {
    res = fakeRes();
    aCalls.length = 0;
    await alarmsMod.handleCardRoute(kind, post({ host: "evil.example:3080", origin: "http://evil.example:3080", "sec-fetch-site": "same-origin" }), res, cardDeps);
    check(`card buttons: a rebound page (its own origin, on a domain pointed at this Mac) is refused — ${kind}`,
      res.status === 403 && prepared.length === 0 && aCalls.length === 0);
  }
  res = fakeRes();
  await alarmsMod.handleCardRoute("authorize", post({ "sec-fetch-site": "cross-site" }), res, cardDeps);
  check("card buttons: a request the browser marks cross-site is refused", res.status === 403 && prepared.length === 0);
  res = fakeRes();
  await alarmsMod.handleCardRoute("authorize", { method: "POST", headers: { "content-type": "application/json" } }, res, cardDeps);
  check("card buttons: a request without a Host is refused", res.status === 403 && prepared.length === 0);
  if (process.platform === "darwin") {
    on = false;
    res = fakeRes();
    await alarmsMod.handleCardRoute("authorize", post({}), res, cardDeps);
    check("card buttons: nothing happens while 全天候秘书 is off", res.status === 409 && prepared.length === 0);
    on = true;
    res = fakeRes();
    await alarmsMod.handleCardRoute("authorize", post({ host: "localhost:3080", origin: "http://localhost:3080" }), res, cardDeps);
    check("card buttons: 一键授权 starts a forced round when there is something to ask, and answers with what it is doing",
      res.status === 200 && res.body.started === true && prepared.length === 1 && prepared[0] === true && res.body.plan?.ask?.[0] === "reminders",
      JSON.stringify(res.body));
    plan = { ask: [], denied: ["reminders"] };
    res = fakeRes();
    await alarmsMod.handleCardRoute("authorize", post({}), res, cardDeps);
    check("card buttons: …with nothing to ask (a refusal only System Settings can change), it starts nothing and says why",
      res.status === 200 && res.body.started === false && prepared.length === 1 && res.body.plan?.denied?.[0] === "reminders");
    plan = { build: "update", ask: ["calendar", "reminders"], denied: [] };
    res = fakeRes();
    await alarmsMod.handleCardRoute("authorize", post({}), res, cardDeps);
    check("card buttons: …and an outdated helper is updated in that round", res.body.started === true && prepared.length === 2 && res.body.plan?.build === "update");
    aCalls.length = 0;
    res = fakeRes();
    const res2 = fakeRes();
    await Promise.all([alarmsMod.handleCardRoute("test", post({}), res, cardDeps), alarmsMod.handleCardRoute("test", post({}), res2, cardDeps)]);
    check("card buttons: two presses of 测试闹钟 at once ring once (the second is told to wait)",
      res2.status === 429 && aCalls.filter((c) => c.cmd === "alarmAdd").length === 1, JSON.stringify(res2.body));
    const testAdd = aCalls.find((c) => c.cmd === "alarmAdd");
    const testIn = testAdd === undefined ? NaN : new Date(testAdd.due).getTime() - Date.now();
    check("card buttons: 测试闹钟 sets an urgent test alarm 2–3 minutes out, in the alarm list, saying what to check if it stays silent",
      res.status === 200 && res.body.ok === true && res.body.list === aHelper.alarmList()?.name && /^\d{2}:\d{2}$/.test(res.body.at)
        && testAdd?.title === "全天候秘书测试闹钟" && /我的位置/.test(testAdd?.notes ?? "") && /紧急/.test(testAdd?.notes ?? "")
        && testIn > 60_000 && testIn < 185_000, JSON.stringify(res.body));
    aCalls.length = 0;
    res = fakeRes();
    await alarmsMod.handleCardRoute("test", post({}), res, cardDeps);
    check("card buttons: …at most one a minute (each one rings the phone)", res.status === 429 && aCalls.length === 0 && /秒后再试/.test(res.body.message));
  }

  // The helper's permission rounds (a fake helper: nothing launches).
  {
    const calls = [];
    let st = { authorization: "notDetermined", reminders: "notDetermined", alarms: "supported", protocol: 3 };
    let hold = null;
    let slowStatus = null;
    const runner = async (req) => {
      calls.push(req);
      if (req.cmd === "status") {
        if (slowStatus === "wait") await new Promise((resolve) => { slowStatus = resolve; });
        return { ok: true, ...st };
      }
      if (req.cmd === "request") {
        if (req.reminders === true && hold === "wait") await new Promise((resolve) => { hold = resolve; });
        if (req.calendar === true && st.authorization === "notDetermined") st = { ...st, authorization: "fullAccess" };
        if (req.reminders === true && st.reminders === "notDetermined") st = { ...st, reminders: "fullAccess" };
        return { ok: true, ...st };
      }
      if (req.cmd === "calendars") return { ok: true, calendars: [] };
      return { ok: true };
    };
    const pRoot = join(tmpdir(), `clawbot-prepare-${process.pid}`);
    rmSync(pRoot, { recursive: true, force: true });
    const h = new calA.CalendarHelper(pRoot, join(ROOT, "native/macos-calendar/main.swift"), runner);
    const shape = () => calls.map((c) => (c.cmd === "request" ? `request(${c.calendar === true ? "c" : ""}${c.reminders === true ? "r" : ""})` : c.cmd)).join();
    await h.prepare();
    check("permissions: a start-up round only looks — no prompt with nobody at the Mac", shape() === "status", shape());
    let p = await h.authorizePlan();
    check("permissions: 一键授权's plan names the two prompts it will put up", p.ask.join() === "calendar,reminders" && p.denied.length === 0 && p.build === undefined, JSON.stringify(p));
    calls.length = 0;
    await h.prepare(true);
    check("permissions: a forced round puts up the calendar prompt, then the reminders one, one launch each", shape() === "status,request(c),request(r)", shape());
    calls.length = 0;
    await h.prepare(true);
    check("permissions: with both decided, a forced round asks nothing", shape() === "status", shape());
    p = await h.authorizePlan();
    check("permissions: …and the plan says there is nothing to ask", p.ask.length === 0 && p.denied.length === 0, JSON.stringify(p));
    st = { authorization: "fullAccess", reminders: "denied", alarms: "supported", protocol: 3 };
    p = await h.authorizePlan();
    check("permissions: a refused permission is in the plan as denied (only System Settings can change it), not as a prompt",
      p.ask.length === 0 && p.denied.join() === "reminders", JSON.stringify(p));
    st = { authorization: "fullAccess", reminders: "notDetermined", alarms: "unsupported", protocol: 3 };
    p = await h.authorizePlan();
    calls.length = 0;
    await h.prepare(true);
    check("permissions: where urgent reminders do not exist, no reminders prompt goes up",
      p.ask.length === 0 && p.alarmsUnsupported === true && !calls.some((c) => c.cmd === "request"), `${JSON.stringify(p)} ${shape()}`);
    // Per permission: while the reminders prompt is up, the calendar's commands go through; alarm ones wait.
    st = { authorization: "fullAccess", reminders: "notDetermined", alarms: "supported", protocol: 3 };
    hold = "wait";
    calls.length = 0;
    const round = h.prepare(true);
    for (let i = 0; i < 100 && typeof hold !== "function"; i += 1) await sleep(5);
    const during = await h.call({ cmd: "events", from: "2026-10-15", to: "2026-10-16" });
    const alarmDuring = await h.call({ cmd: "alarms", listId: "x" });
    h.invalidateStatus();
    const statusDuring = await h.status();
    if (typeof hold === "function") hold();
    await round;
    hold = null;
    check("permissions: while only the Reminders prompt is up, the calendar works and alarms say they are waiting",
      during.ok === true && calls.some((c) => c.cmd === "events") && !calls.some((c) => c.cmd === "alarms")
        && alarmDuring.pending === true && alarmDuring.code === "reminders_not_authorized", JSON.stringify(alarmDuring));
    check("permissions: …and the card hears that a prompt is up", statusDuring.prompting === true && statusDuring.authorization === "fullAccess", JSON.stringify(statusDuring));
    // 一键授权 during a start-up look: its own forced round right after, not swallowed by the quick one.
    st = { authorization: "notDetermined", reminders: "fullAccess", alarms: "supported", protocol: 3 };
    slowStatus = "wait";
    calls.length = 0;
    const quick = h.prepare();
    const forced = h.prepare(true);
    for (let i = 0; i < 100 && typeof slowStatus !== "function"; i += 1) await sleep(5);
    if (typeof slowStatus === "function") slowStatus();
    await quick;
    await forced;
    slowStatus = null;
    check("permissions: 一键授权 pressed during a start-up look still gets its own round, with the prompt", /request\(c\)/.test(shape()), shape());
    st = { authorization: "fullAccess", reminders: "fullAccess", protocol: 2 };
    h.invalidateStatus();
    const old = await h.status();
    check("status: a helper from before alarmComplete (protocol 2) is outdated — only then does the card ask for 一键授权",
      old.outdated === true && old.protocol === 2, JSON.stringify(old));
    st = { authorization: "fullAccess", reminders: "fullAccess", protocol: 3, alarms: "supported" };
    h.invalidateStatus();
    const cur = await h.status();
    check("status: …a current one is not, and says whether alarms work on this macOS", cur.outdated === false && cur.alarms === "supported", JSON.stringify(cur));
    rmSync(pRoot, { recursive: true, force: true });
  }

  // The helper side of it.
  const calSrcA = readFileSync(join(ROOT, "src/mac-calendar.ts"), "utf-8");
  const swiftSrc = readFileSync(join(ROOT, "native/macos-calendar/main.swift"), "utf-8");
  check("helper: the app declares what it wants Reminders for (no usage string = no prompt at all)",
    /NSRemindersFullAccessUsageDescription/.test(calSrcA) && /NSRemindersUsageDescription/.test(calSrcA));
  check("helper: one prompt per launch (calendar / reminders flags), and no reminders prompt where urgent reminders do not exist",
    /request\["calendar"\] as\? Bool \?\? true\) && authorization\(\) == "notDetermined"/.test(swiftSrc)
      && /request\["reminders"\] as\? Bool \?\? true\) && remindersAuthorization\(\) == "notDetermined" && reminderKitCheck\(\)\.isEmpty/.test(swiftSrc));
  check("helper: urgent is set through the change item's urgent context, after the due time",
    /setDueDateComponentsWithAlarmsIfNeeded:[\s\S]{0,500}urgentAlarmContext[\s\S]{0,200}setIsUrgentStateEnabledForCurrentUser:/.test(swiftSrc));
  check("helper: once an alarm is saved, a failed read-back is not a failure (the caller would set it again)",
    /try RK\.save\(save\)[\s\S]{0,400}let saved = \(\(try\? remindersIn\(rem, list\)\) \?\? \[\]\)/.test(swiftSrc)
      && /let made = \(\(try\? reminderLists\(rem\)\) \?\? \[\]\)/.test(swiftSrc));
  check("helper: isUrgent has no fallback that crashes where the method is gone",
    /func isUrgent\(_ reminder: NSObject\) -> Bool \{\s*\(try\? RK\.bool\(reminder, "isUrgentStateEnabledForCurrentUser"\)\) \?\? false\s*\}/.test(swiftSrc));
  check("helper: status says whether alarms can work on this macOS", /"alarms": missing\.isEmpty \? "supported" : "unsupported"/.test(swiftSrc));
  check("helper: a due time whose stored wall clock would read back as another instant is refused",
    /instant\(parts as NSDateComponents\), abs\(back\.timeIntervalSince\(due\.date\)\) > 1/.test(swiftSrc) && /code: "ambiguous"/.test(swiftSrc));
  check("helper: an absurd alert offset is dropped, not trapped", /func alertMinutes\(_ alarm: EKAlarm\) -> Int\?/.test(swiftSrc) && !/Int\(-\$0\.relativeOffset \/ 60\)/.test(swiftSrc));
  check("helper: every ReminderKit call checks the method is there first (a missing one is an error, not a crash)",
    /static func selector\(_ target: NSObject, _ name: String\) throws -> Selector \{\s*let sel = NSSelectorFromString\(name\)\s*guard answers\(target, sel\)/.test(swiftSrc));
  check("helper: rkcheck covers what the alarm commands reach through forwarding",
    ['("REMReminderStorage", "setIsUrgentStateEnabledForCurrentUser:")', '("REMReminderStorage", "notesAsString")', '("REMReminderStorage", "setCompleted:")',
      '("REMReminderChangeItem", "setCompleted:")', '("REMList", "account")', '("REMAccountStorage", "objectID")'].every((s) => swiftSrc.includes(s)));
  check("helper: the protocol numbers agree", new RegExp(`let helperProtocol = ${calA.HELPER_PROTOCOL}\\b`).test(swiftSrc));
  {
    // Every change to main.swift or the Info.plist template bumps helperProtocol: an installed helper is
    // replaced only when its protocol is behind (the card asks, and 一键授权 rebuilds, only then).
    const PIN = { protocol: 3, sha256: "5c6fd829b3c67c290378b30886de1e24d9bbda7bfb58025bc98046d2b6aaede6" };
    const sha = createHash("sha256").update(readFileSync(join(ROOT, "native/macos-calendar/main.swift")))
      .update(calA.infoPlist("0".repeat(32))).digest("hex");
    check("helper: main.swift and the Info.plist template are the ones pinned to this protocol (changed either? bump helperProtocol and HELPER_PROTOCOL, then this pin)",
      calA.HELPER_PROTOCOL === PIN.protocol && sha === PIN.sha256, `sha256 ${sha}`);
  }
  const bridgeSrcA = readFileSync(join(ROOT, "src/bridge.ts"), "utf-8");
  check("alarms: the bridge registers them with the calendar tools (one switch)",
    /registerCalendarTools\(agentCtx, \{[\s\S]{0,400}registerAlarmTools\(agentCtx, \{/.test(bridgeSrcA));

  // An outdated helper is kept (its permissions too) until the owner asks at the card, and a failed update keeps it.
  {
    const sRoot = join(tmpdir(), `clawbot-stale-${process.pid}`);
    rmSync(sRoot, { recursive: true, force: true });
    const exe = join(sRoot, "Clawbot-Calendar.app", "Contents", "MacOS", "Clawbot-Calendar");
    mkdirSync(dirname(exe), { recursive: true });
    writeFileSync(exe, "old build");
    writeFileSync(join(sRoot, "source.sha256"), "an older source");
    const broken = join(sRoot, "broken.swift");
    writeFileSync(broken, "this is not swift {\n");
    const stale = new calA.CalendarHelper(sRoot, broken);
    let threw = false;
    try { await stale.ensureBuilt(); } catch { threw = true; }
    check("helper: a build from older source is not replaced behind the owner's back (that would void its permissions)",
      !threw && stale.isStale() && readFileSync(exe, "utf-8") === "old build");
    let failed = null;
    try { await stale.ensureBuilt(true); } catch (err) { failed = err; }
    check("helper: a forced update that fails to compile keeps the old helper (and its permissions) where it was",
      failed !== null && readFileSync(exe, "utf-8") === "old build" && readFileSync(join(sRoot, "source.sha256"), "utf-8") === "an older source"
        && !readdirSync(sRoot).some((n) => n.startsWith(".build-") || n.startsWith(".old-")), String(failed));
    rmSync(sRoot, { recursive: true, force: true });
  }
  // Each Mac's build is its own app to macOS: a copy compiled elsewhere does not inherit the owner's grant.
  {
    const iRoot = join(tmpdir(), `clawbot-install-${process.pid}`);
    rmSync(iRoot, { recursive: true, force: true });
    const source = join(ROOT, "native/macos-calendar/main.swift");
    const exe = join(iRoot, "Clawbot-Calendar.app", "Contents", "MacOS", "Clawbot-Calendar");
    mkdirSync(dirname(exe), { recursive: true });
    writeFileSync(exe, "built");
    const id = "0123456789abcdef0123456789abcdef";
    writeFileSync(join(iRoot, "install-id"), id);
    writeFileSync(join(iRoot, "source.sha256"), createHash("sha256").update(readFileSync(source)).update(calA.infoPlist(id)).digest("hex"));
    const h = new calA.CalendarHelper(iRoot, source);
    const builtWithId = h.isBuilt();
    writeFileSync(join(iRoot, "install-id"), "fedcba9876543210fedcba9876543210");
    const withOther = h.isBuilt();
    check("helper: each Mac's build carries its own installation id in its signed Info.plist",
      builtWithId && !withOther && calA.infoPlist(id).includes(`<key>ClawbotInstallation</key><string>${id}</string>`)
        && calA.infoPlist(id).includes("<string>io.github.alphainfix.wechat-clawbot.calendar</string>")
        && calA.infoPlist(id, "x.test").includes("<string>x.test</string>"));
    // A lost install-id is taken back from the built app: a new id would be a new app to macOS.
    rmSync(join(iRoot, "install-id"));
    writeFileSync(join(iRoot, "Clawbot-Calendar.app", "Contents", "Info.plist"), calA.infoPlist(id));
    check("helper: a lost install-id is taken back from the built app, not minted anew",
      h.isBuilt() && readFileSync(join(iRoot, "install-id"), "utf-8") === id);
    rmSync(iRoot, { recursive: true, force: true });
  }

  // Two tool switches flipped in quick succession (off, then on): the listener must end up running WITH its
  // bridge. Replays the real startMonitor/stopMonitor and the restart from lib/index.js with fake WeChat pieces.
  {
    const src = readFileSync(join(ROOT, "lib/index.js"), "utf-8");
    const start = src.indexOf("let superseded = false;");
    const end = src.indexOf("// Approval questions for WeChat sessions arrive in WeChat.");
    const anchor = src.indexOf("await stopMonitor(`工具开关变了");
    const iifeStart = anchor < 0 ? -1 : src.lastIndexOf("void (async () => {", anchor);
    const iifeEnd = anchor < 0 ? -1 : src.indexOf("})().catch((err) => logger.warn(`重启微信监听失败", anchor);
    if (start < 0 || end < 0 || iifeStart < 0 || iifeEnd < 0) {
      check("restart: the listener code was found in lib/index.js", false);
    } else {
      const monitorCode = src.slice(start, end);
      const iifeBody = src.slice(iifeStart + "void (async () => {".length, iifeEnd);
      const harness = new Function("deps", `
        let { ctx, config, sendText, codexPeer, pending, backlog, calendarHelper, alarms, uploadFileTo, fs,
              pickAccount, WechatBridge, InboundRouter, runMonitor, logger, carryOverLegacyReminders } = deps;
        let bridge = null, router = null, monitorTask = null, currentAccount = null, warmSession, abort = new AbortController();
        ${monitorCode}
        const restart = (hot) => {
          const toolSwitches = hot.filter((key) => key === "macCalendar" || key === "codexPeer");
          const superseded = false;
          return (async () => {${iifeBody}})();
        };
        return { startMonitor, stopMonitor, restart, state: () => ({ bridge, router, monitorTask }) };
      `);
      for (const [slow, gap] of [[300, 100], [60, 10], [0, 0]]) {
        const bridges = [];
        class FakeBridge {
          constructor() { this.disposed = false; bridges.push(this); }
          async dispose() { await sleep(20); this.disposed = true; }
          ensureAgent() { return new Promise(() => {}); }
        }
        const runMonitor = ({ signal }) => (async () => {
          // Busy in onMessage (a media download, say) when the abort comes; then the loop sees it and ends.
          await sleep(slow);
          while (!signal.aborted) await sleep(5);
        })();
        const config = { macCalendar: true };
        const hh = harness({
          ctx: { inject() {} }, config, sendText: async () => {}, codexPeer: { close() {} },
          pending: { abortAll() {}, close() {}, reopen() {} }, backlog: {}, calendarHelper: { prepare: async () => {} }, alarms: {},
          uploadFileTo: async () => ({}), fs: {}, pickAccount: () => ({ accountId: "acct", configured: true, userId: "owner" }),
          WechatBridge: FakeBridge, InboundRouter: class { handle() {} }, runMonitor,
          logger: { info() {}, warn() {}, error() {} }, carryOverLegacyReminders() {},
        });
        hh.startMonitor();
        config.macCalendar = false;
        const a = hh.restart(["macCalendar"]);
        await sleep(gap);
        config.macCalendar = true;
        const b = hh.restart(["macCalendar"]);
        await Promise.all([a, b]);
        await sleep(gap + 30);
        const s = hh.state();
        const live = bridges.filter((x) => !x.disposed);
        check(`restart: two switch flips in a row (${slow} ms busy, ${gap} ms apart) leave one running listener with its bridge`,
          s.monitorTask !== null && s.router !== null && s.bridge !== null && live.length === 1 && live[0] === s.bridge,
          `monitor ${s.monitorTask !== null} router ${s.router !== null} bridge ${s.bridge !== null} live ${live.length}`);
        await hh.stopMonitor("test over");
      }
      // A stop whose turn waits on a WeChat answer (an approval): the answer is aborted first, so the stop ends.
      {
        let closed;
        const answered = new Promise((resolve) => { closed = resolve; });
        class WaitingBridge {
          constructor() { this.disposed = false; }
          async dispose() { await answered; this.disposed = true; }
          ensureAgent() { return new Promise(() => {}); }
        }
        const hh = harness({
          ctx: { inject() {} }, config: { macCalendar: true }, sendText: async () => {}, codexPeer: { close() {} },
          pending: { abortAll() {}, close() { closed(); }, reopen() {} }, backlog: {}, calendarHelper: { prepare: async () => {} }, alarms: {},
          uploadFileTo: async () => ({}), fs: {}, pickAccount: () => ({ accountId: "acct", configured: true, userId: "owner" }),
          WechatBridge: WaitingBridge, InboundRouter: class { handle() {} },
          runMonitor: ({ signal }) => (async () => { while (!signal.aborted) await sleep(5); })(),
          logger: { info() {}, warn() {}, error() {} }, carryOverLegacyReminders() {},
        });
        hh.startMonitor();
        const ended = await Promise.race([hh.stopMonitor("switch").then(() => true), sleep(2000).then(() => false)]);
        check("restart: a stop whose turn waits on a WeChat answer still ends (the answer is aborted first)", ended && hh.state().bridge === null);
      }
    }
  }
  rmSync(aRoot, { recursive: true, force: true });
  {
    const { PendingRegistry } = await import(join(ROOT, "lib/pending.js"));
    const reg = new PendingRegistry();
    const got = [];
    reg.push({ tag: "approval", sender: "u1", resolve: (r) => got.push(["a", r]) });
    reg.close();
    reg.push({ tag: "question", sender: "u1", resolve: (r) => got.push(["b", r]) });
    const whileClosed = reg.size;
    reg.reopen();
    reg.push({ tag: "question", sender: "u1", resolve: (r) => got.push(["c", r]) });
    check("pending: closing for a stop aborts what waits and takes nothing new until reopened",
      JSON.stringify(got) === JSON.stringify([["a", null], ["b", null]]) && whileClosed === 0 && reg.size === 1, JSON.stringify(got));
  }
  setLogLevel("info");
}

// ------------------------------------------------------------- 日程秘书(2026-10-14)
// 规则写进 memory.md(和人设一样属于机主,不进插件提示词);只有翻开关时增删,
// 关掉时留一份副本,再打开原样放回,机主自己改过的措辞不丢。
{
  const state = join(tmpdir(), `clawbot-secretary-${process.pid}`);
  rmSync(state, { recursive: true, force: true });
  mkdirSync(state, { recursive: true });
  const prevState = process.env.CLAWBOT_STATE_DIR;
  process.env.CLAWBOT_STATE_DIR = state;
  try {
    const sec = await import(join(ROOT, "lib/secretary.js"));
    const mem = await import(join(ROOT, "lib/memory.js"));
    const cfgS = await import(join(ROOT, "lib/config.js"));
    const memPath = join(state, "memory.md");
    const copyPath = join(state, "secretary-rules.md");
    const read = () => readFileSync(memPath, "utf-8");
    check("secretary: off by default, and hot (the card can write it; index.ts edits memory.md when it flips)",
      cfgS.DEFAULT_CONFIG.secretary === false && cfgS.normalizeConfig({}).secretary === false
      && cfgS.normalizeConfig({ secretary: true }).secretary === true && cfgS.HOT_FIELDS.has("secretary"));

    // A fresh install has no memory.md yet: switching on seeds it, then adds the rules.
    check("secretary: on a fresh install the memory file is created with the rules at the end",
      sec.addSecretaryRules() === "added" && /## 基本档案/.test(read()) && read().endsWith(`${sec.SECRETARY_RULES}\n`));

    const before = "# 用户记忆（长期）\n\n## 基本档案\n- [2026-10-01] 喜欢爬山\n\n## 偏好与习惯\n- [2026-10-02] 回复要短\n";
    writeFileSync(memPath, before);
    check("secretary: switching on appends the default rules after everything else", sec.addSecretaryRules() === "added"
      && read() === `${before.trimEnd()}\n\n${sec.SECRETARY_RULES}\n` && sec.hasSecretaryRules());
    const once = read();
    check("secretary: switching on again changes nothing", sec.addSecretaryRules() === "present" && read() === once);
    check("secretary: the rules keep reminders out of the calendar",
      /提醒我/.test(sec.SECRETARY_RULES) && /只设微信提醒，不进日历/.test(sec.SECRETARY_RULES));
    check("secretary: the section is called 全天候秘书 now; its rules say when to set an alarm, and that daily alarm planning is a 「任务」 the owner sets up",
      sec.SECRETARY_HEADING === "## 全天候秘书" && sec.SECRETARY_RULES.startsWith("## 全天候秘书\n")
      && /alarm_set/.test(sec.SECRETARY_RULES) && /「任务」提醒/.test(sec.SECRETARY_RULES) && !/每晚看第二天的日历定好，再说一声/.test(sec.SECRETARY_RULES));

    // Auto-memory keeps writing under its own headings; the section stays whole.
    mem.appendMemoryEntry("偏好与习惯", "喜欢早上写东西");
    check("secretary: an auto-memory entry lands under its own heading, the rules untouched",
      /## 偏好与习惯\n- \[[0-9-]+\] 喜欢早上写东西/.test(read()) && read().endsWith(`${sec.SECRETARY_RULES}\n`));

    mem.appendMemoryEntry("基本档案", "养了一只猫");
    check("memory: appending never leaves blank lines piling up at the end of the file", read().endsWith(`${sec.SECRETARY_RULES}\n`));

    // The owner rewrites a rule; a section auto-memory created later sits after it.
    writeFileSync(memPath, read().replace("60–90 分钟一块", "45 分钟一块") + "\n## 重要事实\n- [2026-10-03] 在写报告\n");
    check("secretary: switching off moves the section out and keeps everything else",
      sec.removeSecretaryRules() === "removed" && !/全天候秘书|日程秘书|45 分钟一块/.test(read())
      && /喜欢早上写东西/.test(read()) && /## 重要事实\n- \[2026-10-03\] 在写报告/.test(read()) && !/\n{3,}/.test(read()));
    check("secretary: …into a private copy, with the owner's wording",
      existsSync(copyPath) && /45 分钟一块/.test(readFileSync(copyPath, "utf-8")) && (statSync(copyPath).mode & 0o777) === 0o600);
    check("secretary: switching off again changes nothing", sec.removeSecretaryRules() === "absent" && !sec.hasSecretaryRules());
    check("secretary: switching on again puts the owner's version back, not the default",
      sec.addSecretaryRules() === "added" && /45 分钟一块/.test(read()) && !/60–90 分钟一块/.test(read())
      && /## 重要事实/.test(read()));

    // memory.md is capped at 500 lines (head 70% + tail 30%); the rules sit in the tail.
    for (let i = 0; i < 520; i += 1) mem.appendMemoryEntry("基本档案", `测试条目 ${i}`);
    check("secretary: the 500-line memory cap keeps the rules", sec.hasSecretaryRules() && /45 分钟一块/.test(read()));

    // The owner retitles the section: still the same one (no second copy at the next start).
    writeFileSync(memPath, "## 基本档案\n- 喜欢爬山\n\n## 全天候秘书（我的版本）\n- 早上不排会\n");
    check("secretary: a retitled section is still recognised (no second copy)",
      sec.hasSecretaryRules() && sec.addSecretaryRules() === "present" && (read().match(/全天候秘书/g) ?? []).length === 1);
    // A memory file from before the merge (the section was called 日程秘书): the same section, not a missing one.
    writeFileSync(memPath, "## 基本档案\n- 喜欢爬山\n\n## 日程秘书（我的版本）\n- 早上不排会\n");
    check("secretary: the section's old name (日程秘书) still counts: no second copy under the new name",
      sec.hasSecretaryRules() && sec.addSecretaryRules() === "present" && !/全天候秘书/.test(read()) && (read().match(/日程秘书/g) ?? []).length === 1);
    check("secretary: …and switching off moves the retitled one out",
      sec.removeSecretaryRules() === "removed" && !/日程秘书|早上不排会/.test(read()) && /喜欢爬山/.test(read())
      && /早上不排会/.test(readFileSync(copyPath, "utf-8")));
    // The owner's own notes under a heading that only starts with the name are not the rules.
    writeFileSync(memPath, "## 基本档案\n- 喜欢爬山\n\n## 日程秘书工作日志\n- 周一交了报告\n");
    rmSync(copyPath, { force: true });
    check("secretary: a heading that only starts with the name (「## 日程秘书工作日志」) is the owner's, not the rules",
      !sec.hasSecretaryRules() && sec.addSecretaryRules() === "added" && /## 日程秘书工作日志\n- 周一交了报告/.test(read())
      && read().endsWith(`${sec.SECRETARY_RULES}\n`));
    check("secretary: …and switching off leaves it there", sec.removeSecretaryRules() === "removed" && /周一交了报告/.test(read()) && !/全天候秘书/.test(read()));
    writeFileSync(memPath, "## 基本档案\n- 住址保密\n\n## 全天候秘书「我的版本」\n- 早上不排会\n");
    check("secretary: a title with brackets after the name (「我的版本」) is still the section",
      sec.hasSecretaryRules() && sec.addSecretaryRules() === "present" && (read().match(/全天候秘书/g) ?? []).length === 1);
    for (const title of ["## 日程秘书规则", "## 全天候秘书v2"]) {
      writeFileSync(memPath, `## 基本档案\n- 住址保密\n\n${title}\n- 早上不排会\n`);
      check(`secretary: a retitle that runs on from the name (「${title.slice(3)}」) is still the section, not a reason for a second copy`,
        sec.hasSecretaryRules() && sec.addSecretaryRules() === "present" && !read().includes(sec.SECRETARY_RULES));
    }
    for (const title of ["## 全天候秘书笔记", "## 日程秘书记录", "## 全天候秘书日志"]) {
      writeFileSync(memPath, `## 基本档案\n- 住址保密\n\n${title}\n- 周一交了报告\n`);
      check(`secretary: notes named after it (「${title.slice(3)}」) are the owner's, not the rules`, !sec.hasSecretaryRules());
    }
    writeFileSync(memPath, `## 基本档案\n- 住址保密\n\n${sec.EARLIER_RULES[1]}\n`);
    check("secretary: switching on while an untouched earlier default is there brings it up to date",
      sec.addSecretaryRules() === "present" && read().endsWith(`${sec.SECRETARY_RULES}\n`), read());
    // Both names in one file: switching off takes both out (and keeps both), not just the first.
    writeFileSync(memPath, "## 基本档案\n- 喜欢爬山\n\n## 日程秘书\n- 旧\n\n## 偏好与习惯\n- 短\n\n## 全天候秘书\n- 新\n");
    check("secretary: with the old and the new section both there, switching off takes both out and keeps both",
      sec.removeSecretaryRules() === "removed" && !sec.hasSecretaryRules() && /## 偏好与习惯\n- 短/.test(read())
      && /- 旧/.test(readFileSync(copyPath, "utf-8")) && /- 新/.test(readFileSync(copyPath, "utf-8")));
    // Untouched earlier defaults are brought up to date; an edited one is the owner's.
    for (const [i, earlier] of sec.EARLIER_RULES.entries()) {
      writeFileSync(memPath, `## 基本档案\n- 喜欢爬山\n\n${earlier}\n\n## 重要事实\n- 在写报告\n`);
      check(`secretary: an untouched earlier default (version ${i + 1}) is brought up to the current rules, the rest left as it was`,
        sec.upgradeSecretaryRules() === "upgraded" && read() === `## 基本档案\n- 喜欢爬山\n\n${sec.SECRETARY_RULES}\n\n## 重要事实\n- 在写报告\n`, read());
    }
    writeFileSync(memPath, `## 基本档案\n- 喜欢爬山\n\n${sec.EARLIER_RULES[1].replace("60–90 分钟一块", "45 分钟一块")}\n`);
    const edited = read();
    check("secretary: …an edited one is left exactly as it is", sec.upgradeSecretaryRules() === "kept" && read() === edited);
    writeFileSync(memPath, "## 基本档案\n- 喜欢爬山\n");
    writeFileSync(copyPath, `${sec.EARLIER_RULES[0]}\n`, { mode: 0o600 });
    check("secretary: a saved copy that is an untouched earlier default comes back as the current rules",
      sec.addSecretaryRules() === "added" && read().endsWith(`${sec.SECRETARY_RULES}\n`) && !/日程秘书/.test(read()), read());

    // A memory file that cannot be read is never written over (it would lose everything in it).
    writeFileSync(memPath, "## 基本档案\n- 喜欢爬山\n");
    chmodSync(memPath, 0o000);
    let unreadable = false;
    try { readFileSync(memPath, "utf-8"); } catch { unreadable = true; }
    if (unreadable) {
      let threw = false;
      try { sec.addSecretaryRules(); } catch { threw = true; }
      const appended = mem.appendMemoryEntry("基本档案", "不该写进去的一条");
      chmodSync(memPath, 0o644);
      check("secretary + memory: an unreadable memory.md is left alone, not replaced by a fresh file",
        threw && appended === false && read() === "## 基本档案\n- 喜欢爬山\n" && !sec.hasSecretaryRules());
    } else {
      chmodSync(memPath, 0o644);
      check("secretary + memory: an unreadable memory.md is left alone (skipped: running as root)", true);
    }

    // The card's "打开 memory.md" button: only the card's own JSON POST opens the file.
    const fakeRes = () => ({ status: 0, body: null, writeHead(code) { this.status = code; }, end(text) { this.body = JSON.parse(text); } });
    const opened = [];
    const opener = async (file) => { opened.push(file); };
    const post = (headers) => ({ method: "POST", headers: { host: "127.0.0.1:3080", ...headers } });
    let r = fakeRes();
    await sec.handleMemoryOpen({ method: "GET", headers: {} }, r, opener);
    check("memory open: GET is refused", r.status === 405 && opened.length === 0);
    r = fakeRes();
    await sec.handleMemoryOpen(post({ "content-type": "text/plain" }), r, opener);
    check("memory open: a form-style POST (what another site's page can send unasked) is refused", r.status === 403 && opened.length === 0);
    r = fakeRes();
    await sec.handleMemoryOpen(post({ "content-type": "application/json", origin: "https://evil.example" }), r, opener);
    check("memory open: a request from another origin is refused", r.status === 403 && opened.length === 0);
    r = fakeRes();
    await sec.handleMemoryOpen(post({ "content-type": "application/json", origin: "http://127.0.0.1:3080" }), r, opener);
    check("memory open: the card's own request opens memory.md and says where it is",
      r.status === 200 && r.body.ok === true && opened.length === 1 && opened[0] === memPath && r.body.path === memPath);
    r = fakeRes();
    await sec.handleMemoryOpen(post({ "content-type": "application/json" }), r, async () => { throw new Error("no app"); });
    check("memory open: a failure comes back as a message for the card", r.status === 500 && /打不开：no app/.test(r.body.message));
    r = fakeRes();
    await sec.handleMemoryOpen(post({ "content-type": "application/json", host: "evil.example:3080", origin: "http://evil.example:3080" }), r, opener);
    check("memory open: a rebound page (its own origin, on a domain pointed at this Mac) is refused", r.status === 403 && opened.length === 1);
    const allowed = (headers) => sec.cardRequestAllowed({ headers: { "content-type": "application/json", ...headers } });
    check("card requests: this Mac by any loopback name is the card; any other Host is not (DNS rebinding), whatever the Origin says",
      allowed({ host: "127.0.0.1:3080", origin: "http://127.0.0.1:3080" }) && allowed({ host: "localhost:3080" })
      && allowed({ host: "[::1]:3080", origin: "http://[::1]:3080" }) && allowed({ host: "127.0.0.2:3080" })
      && !allowed({ host: "evil.example:3080", origin: "http://evil.example:3080" }) && !allowed({ host: "127.0.0.1.nip.io:3080" })
      && !allowed({}) && !allowed({ host: "127.0.0.1:3080", "sec-fetch-site": "cross-site" })
      && !allowed({ host: "127.0.0.1:3080", origin: "http://localhost:3080" }));
  } finally {
    if (prevState === undefined) delete process.env.CLAWBOT_STATE_DIR; else process.env.CLAWBOT_STATE_DIR = prevState;
    rmSync(state, { recursive: true, force: true });
  }

  const secSrc = readFileSync(join(ROOT, "src/secretary.ts"), "utf-8");
  check("memory open: the file is opened without a shell (execFile with an argument list)",
    /execFile\(cmd, args/.test(secSrc) && !/\bexec\(|shell: true/.test(secSrc));
  check("memory open: the card button sends a JSON POST and the route is registered",
    /fetch\(MEMORY_OPEN_URL, \{ method: "POST", headers: \{ "content-type": "application\/json" \}/.test(readFileSync(join(ROOT, "src/client.js"), "utf-8"))
    && /registerMemoryOpenRoute\(ctx\)/.test(readFileSync(join(ROOT, "src/index.ts"), "utf-8")));

  const indexSrc = readFileSync(join(ROOT, "src/index.ts"), "utf-8");
  check("secretary: it needs the Mac calendar (and macOS)",
    /config\.secretary === true && config\.macCalendar === true && process\.platform === "darwin"/.test(indexSrc));
  check("secretary: memory.md changes only when the switch (or the calendar) flips; a start-up only fills in a missing section or upgrades an untouched one",
    /secretaryActive\(\) !== secretaryWas && !superseded/.test(indexSrc)
    && /if \(secretaryActive\(\)\) \{\s*try \{\s*if \(!hasSecretaryRules\(\)\) addSecretaryRules\(\);\s*else upgradeSecretaryRules\(\);/.test(indexSrc)
    && (indexSrc.match(/removeSecretaryRules\(\)/g) ?? []).length === 1);
  check("secretary: the rules are not in the plugin's own prompt (they belong to the owner, in memory.md)",
    !/日程秘书|全天候秘书|建议主线/.test(readFileSync(join(ROOT, "src/prompt.ts"), "utf-8")));
  const clientSrc = readFileSync(join(ROOT, "src/client.js"), "utf-8");
  check("全天候秘书: one switch on the card sets the calendar and the rules together",
    /label: "全天候秘书",[\s\S]{0,1200}set\("macCalendar", next\);\s*set\("secretary", next\);/.test(clientSrc)
    && !/label: "日程秘书"/.test(clientSrc) && !/label: "Mac 日历"/.test(clientSrc));
  check("全天候秘书: the card has 一键授权 and 测试闹钟, posting JSON to their routes",
    /fetch\(url, \{ method: "POST", headers: \{ "content-type": "application\/json" \}/.test(clientSrc)
    && /press\(AUTHORIZE_URL/.test(clientSrc) && /press\(TEST_ALARM_URL/.test(clientSrc)
    && /registerCardRoutes\(ctx, \{ helper: calendarHelper, alarms, enabled: \(\) => config\.macCalendar === true \}\)/.test(indexSrc));
  check("全天候秘书: the card tells the owner about the iPhone's own urgent-alarm permission, and that it rings on the Find My device",
    /iPhone 上还要先在「提醒事项」里\"\s*\+\s*"手动把一条提醒设成「紧急」一次/.test(clientSrc) && /「查找」里作为“我的位置”的那台设备/.test(clientSrc));
  check("secretary: the status route says whether the rules are in memory, and whether their switch is on",
    /secretary: hasSecretaryRules\(\)/.test(indexSrc) && /secretaryOn: config\.secretary === true/.test(indexSrc)
    && /others, secretary, secretaryOn, helper/.test(readFileSync(join(ROOT, "src/mac-calendar.ts"), "utf-8")));
  const promptSrcS = readFileSync(join(ROOT, "src/prompt.ts"), "utf-8");
  {
    const sec2 = await import(join(ROOT, "lib/secretary.js"));
    check("card routes: the status reads (calendar and MCP) answer this machine's page only (DNS rebinding)",
      /if \(!localRequest\(req\)\)/.test(readFileSync(join(ROOT, "src/mac-calendar.ts"), "utf-8"))
      && /if \(!localRequest\(req\)\)/.test(readFileSync(join(ROOT, "src/mcp-route.ts"), "utf-8"))
      && sec2.localRequest({ headers: { host: "127.0.0.1:3080" } }) && sec2.localRequest({ headers: { host: "localhost:3080" } })
      && !sec2.localRequest({ headers: { host: "evil.example:3080" } }) && !sec2.localRequest({ headers: { host: "127.0.0.1:3080", "sec-fetch-site": "cross-site" } }));
  }
  check("restart: a helper that fails to prepare after switching on is logged as that, not as a failed listener restart",
    /void calendarHelper\.prepare\(true\)\.catch\(/.test(indexSrc));
  {
    const { occurrenceAt } = await import(join(ROOT, "lib/backlog.js"));
    const batch = "[SCHEDULE REMINDER BATCH]\nThis is a scheduled message from the user\nreminders_json: "
      + JSON.stringify([{ schedule_id: "a", occurrence_at: "2026-10-23T03:00:00.000Z", reminder_prompt: "任务:x" },
        { schedule_id: "b", occurrence_at: "2026-10-23T01:00:00.000Z", reminder_prompt: "y" }]);
    check("backlog: a recurring reminder (a batch) is stamped with when it was due, like a one-off",
      occurrenceAt(batch) === "2026-10-23T03:00:00.000Z" && occurrenceAt("occurrence_at: 2026-10-22T13:00:00Z") === "2026-10-22T13:00:00.000Z"
        && occurrenceAt("nothing here") === undefined);
  }
  check("rule G5: a 「任务」 that could not be done is always reported, needs no acknowledgment, and counts its days from when it was due",
    /任务没能做成/.test(promptSrcS) && /任务回合不用先发确认/.test(promptSrcS) && /跨了日期的,后面紧跟一条「\[定时消息晚到\]」写明原定哪天,日子照它算/.test(promptSrcS));
  check("restart: switching on prepares the helper only in the live instance; a login during a stop starts the listener once it is done",
    /process\.platform === "darwin" && !superseded\) \{/.test(indexSrc) && /void stopping\.then\(\(\) => \{ if \(!monitorTask && !superseded\) startMonitor\(\); \}\);/.test(indexSrc)
      && /pending\.close\(\);[\s\S]{0,400}await bridge\?\.dispose\(\);\s*\} finally \{/.test(indexSrc));
  check("rule G5: a reminder whose content starts with 「任务」 is done when it fires, not forwarded — and that is how such tasks are made",
    /例外:提醒内容以「任务:」开头的\(冒号全角半角都算\)/.test(promptSrcS) && /内容以「任务:」开头\(只是提醒一声的,内容不要这样开头\)/.test(promptSrcS)
      && /一条都不发/.test(promptSrcS));
  // The card's words, from the real lib/client.js (grant, assistantHint, authorizeText).
  {
    const lib = readFileSync(join(ROOT, "lib/client.js"), "utf-8");
    const from = lib.indexOf("    /** One Mac permission as a short phrase. */");
    const to = lib.indexOf("    function Switch(props) {");
    const card = from < 0 || to < from ? null : new Function(`${lib.slice(from, to)}\nreturn { assistantHint, authorizeText };`)();
    if (card === null) {
      check("card words: found in lib/client.js", false);
    } else {
      const base = { ok: true, mac: true, enabled: true, others: 0, helper: "Clawbot-Calendar", built: true, secretary: true, secretaryOn: true,
        authorization: "fullAccess", reminders: "fullAccess", protocol: 3, alarms: "supported", calendars: 5, dedicated: { name: "规划", account: "iCloud" } };
      const hint = (over) => card.assistantHint({ ...base, ...over }, "规划", true);
      check("card words: an outdated helper asks for 一键授权 at the Mac, and warns the calendar pauses until Allow is clicked",
        /小程序要更新才能用闹钟：到 Mac 前点「一键授权」/.test(hint({ protocol: 1, reminders: "outdated", outdated: true, stale: true }))
        && /小程序有更新：到 Mac 前点「一键授权」/.test(hint({ protocol: 2, outdated: true, stale: true }))
        && /日历会停到点了「允许」为止/.test(hint({ protocol: 2, outdated: true, stale: true })));
      check("card words: a newer source with the same protocol asks for nothing (no rebuild that would void two permissions)",
        !/一键授权/.test(hint({ stale: true, outdated: false })) && /点「测试闹钟」试响一次/.test(hint({ stale: true, outdated: false })));
      check("card words: a refusal points at System Settings, not at 一键授权 (it cannot undo one)",
        /系统设置 → 隐私与安全性 → 提醒事项/.test(hint({ reminders: "denied" })) && !/一键授权/.test(hint({ reminders: "denied" })));
      check("card words: an undecided permission points at 一键授权, at the Mac", /到 Mac 前点「一键授权」补上/.test(hint({ reminders: "notDetermined" })));
      check("card words: the rules switched off in the config are said as such, not as a missing section",
        /排日程的规则没开/.test(hint({ secretaryOn: false, secretary: false })) && !/没找到/.test(hint({ secretaryOn: false, secretary: false }))
        && /没找到「## 全天候秘书」一节/.test(hint({ secretary: false })));
      check("card words: where urgent reminders do not exist it says so, and asks for nothing more",
        /没有紧急提醒（要 macOS 26 或更新）/.test(hint({ alarms: "unsupported", reminders: "notDetermined" }))
        && !/一键授权/.test(hint({ alarms: "unsupported", reminders: "notDetermined" })));
      check("card words: the first compile, a prompt on screen, and a failed update each say what is going on",
        /第一次要编译/.test(hint({ preparing: true, built: false })) && /等你在 Mac 上点「允许」/.test(hint({ prompting: true, preparing: true }))
        && /小程序更新没成功（旧版照常能用）：编译失败/.test(hint({ stale: true, outdated: true, updateError: "编译失败" })));
      check("card words: while a prompt is up, it says which one",
        /屏幕上有「Clawbot-Calendar」的「提醒事项」授权窗口/.test(hint({ prompting: true, waitingFor: ["reminders"] })));
      check("card words: switched on with no calendar name, it asks for the name first",
        /先在上面填专用日历的名字/.test(card.assistantHint({ ...base }, "", true)));
      check("card words: a helper that does not answer is not promised a prompt",
        /过一会儿再点一次/.test(card.authorizeText({ plan: { ask: [], denied: [], error: "timeout" } }))
        && !/授权窗口/.test(card.authorizeText({ plan: { ask: [], denied: [], error: "timeout" } })));
      check("card words: switching off and on to restore the rules says to do it at the Mac when it would also update the helper",
        /在 Mac 前做/.test(hint({ secretaryOn: false, secretary: false, outdated: true, protocol: 2, stale: true }))
        && !/在 Mac 前做/.test(hint({ secretaryOn: false, secretary: false })));
      check("card words: the alarm list is shown by the name Reminders has, and survives a rename",
        /闹钟清单「旧名 闹钟」在「iCloud」（改了名字也继续用它）/.test(hint({ alarmList: { name: "旧名 闹钟", account: "iCloud" } })));
      check("card words: 一键授权 says what it is doing — the prompts, a refusal, an update, or nothing to do",
        /「日历」、「提醒事项」的授权窗口/.test(card.authorizeText({ plan: { ask: ["calendar", "reminders"], denied: [] } }))
        && /只能在 系统设置/.test(card.authorizeText({ plan: { ask: [], denied: ["reminders"] } }))
        && /先更新小程序/.test(card.authorizeText({ plan: { build: "update", ask: ["calendar", "reminders"], denied: [] } }))
        && card.authorizeText({ plan: { ask: [], denied: [] } }) === "都已经授权了，不用再点");
    }
  }
}

// ------------------------------------------------------------- 插件图标(2026-10-22)
// DSH 的插件页读 package.json 的 "icon"(包里的相对路径;SVG/PNG/JPEG/WebP,不超过 256 KiB),
// 当作 <img> 显示:详情页 36 px、列表 30 px,背景透明。不合规时宿主只记一条诊断、不显示图标。
{
  const pkgI = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
  const icon = typeof pkgI.icon === "string" ? pkgI.icon : "";
  const file = join(ROOT, icon);
  const inside = icon !== "" && !icon.startsWith("/") && !/^[A-Za-z][A-Za-z\d+.-]*:/.test(icon) && !file.slice(ROOT.length).includes("..");
  check("icon: package.json names a relative image inside the package, in a format DSH takes",
    inside && /\.(svg|png|jpe?g|webp)$/i.test(icon) && existsSync(file) && statSync(file).isFile(), icon);
  check("icon: it is under DSH's 256 KiB limit", existsSync(file) && statSync(file).size <= 256 * 1024);
  check("icon: it ships in the package, and DSH can read package.json through the exports",
    Array.isArray(pkgI.files) && pkgI.files.includes(icon.split("/")[0]) && pkgI.exports?.["./package.json"] === "./package.json");
  const svg = existsSync(file) ? readFileSync(file, "utf-8") : "";
  check("icon: a standalone SVG (it is shown as an image: it needs its namespace, and has no script)",
    !/\.svg$/i.test(icon) || (/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/.test(svg) && /viewBox="0 0 36 36"/.test(svg) && !/<script|on[a-z]+=/i.test(svg)));
}

// ------------------------------------------------------- 审查第三轮(2026-10-22)
{
  // A macOS without urgent reminders: the alarm tools say so, instead of sending the owner to 一键授权.
  const calU = await import(join(ROOT, "lib/mac-calendar.js"));
  const alarmsU = await import(join(ROOT, "lib/mac-alarms.js"));
  for (const support of ["unsupported", "supported"]) {
    const uRoot = join(tmpdir(), `clawbot-unsupported-${support}-${process.pid}`);
    rmSync(uRoot, { recursive: true, force: true });
    const calls = [];
    const runner = async (req) => {
      calls.push(req.cmd);
      if (req.cmd === "status") return { ok: true, authorization: "fullAccess", reminders: "notDetermined", protocol: calU.HELPER_PROTOCOL, alarms: support };
      if (req.cmd === "calendars") return { ok: true, calendars: [] };
      return { ok: false, code: "reminders_not_authorized", error: "notDetermined" };
    };
    const h = new calU.CalendarHelper(uRoot, join(ROOT, "native/macos-calendar/main.swift"), runner);
    const service = new alarmsU.AlarmService(h, () => "规划");
    const r = await service.ensureList();
    if (support === "unsupported") {
      check("alarms: on a macOS without urgent reminders the tools say alarms cannot work here (一键授权 would never ask)",
        !r.ok && /没有紧急提醒/.test(r.message) && !/一键授权/.test(r.message) && !/（）/.test(r.message), r.message);
    } else {
      check("alarms: …where alarms work, a missing permission still sends the owner to 一键授权",
        !r.ok && /一键授权/.test(r.message), r.message);
    }
    rmSync(uRoot, { recursive: true, force: true });
  }

  // A status look never builds the helper: the first build takes a minute and the card would wait.
  {
    const nRoot = join(tmpdir(), `clawbot-noapp-${process.pid}`);
    rmSync(nRoot, { recursive: true, force: true });
    const h = new calU.CalendarHelper(nRoot, join(ROOT, "native/macos-calendar/main.swift"));
    const t0 = Date.now();
    const st = await h.status();
    check("helper: a status look with no app answers at once and builds nothing",
      st.built === false && st.error === undefined && Date.now() - t0 < 2000 && !h.hasApp
        && !(existsSync(nRoot) && readdirSync(nRoot).some((n) => n.startsWith(".build-") || n.endsWith(".app"))), JSON.stringify(st));
    const plan = await h.authorizePlan();
    const darwin = Number((await import("node:os")).release().split(".")[0]);
    check("helper: the first-build plan asks for Reminders only where macOS has urgent reminders (26+, Darwin 25+)",
      plan.build === "first" && plan.ask[0] === "calendar" && plan.ask.includes("reminders") === (darwin >= 25)
        && (plan.alarmsUnsupported === true) === (darwin < 25), JSON.stringify(plan));
    rmSync(nRoot, { recursive: true, force: true });
  }

  // 「任务」 by its marker; a scheduled message made only of them runs without 「正在输入」.
  const bl = await import(join(ROOT, "lib/backlog.js"));
  const single = (prompt, at = "2026-10-23T03:00:00.000Z") => ["[SCHEDULE REMINDER]", "This is a scheduled message from the user",
    'schedule_id_json: "s1"', `occurrence_at: ${at}`, `reminder_prompt_json: ${JSON.stringify(prompt)}`].join("\n");
  const batchOf = (items) => ["[SCHEDULE REMINDER BATCH]", "This is a scheduled message from the user",
    `reminders_json: ${JSON.stringify(items.map(([p, at], i) => ({ schedule_id: `s${i}`, occurrence_at: at, reminder_prompt: p })))}`].join("\n");
  check("schedule: a 「任务」 is told by its marker, half- or full-width colon (「任务清单…」 is a plain reminder)",
    bl.isTaskPrompt("任务:看明天的行程") && bl.isTaskPrompt(" 任务：排闹钟") && !bl.isTaskPrompt("任务清单记得交") && !bl.isTaskPrompt("提醒:任务:x"));
  check("schedule: a message made only of 「任务」 runs quietly; one with a plain reminder does not",
    bl.quietTask(single("任务：看第二天的行程，排闹钟")) && !bl.quietTask(single("提醒：交报告"))
      && bl.quietTask(batchOf([["任务:a", "2026-10-23T03:00:00.000Z"], ["任务：b", "2026-10-23T03:00:00.000Z"]]))
      && !bl.quietTask(batchOf([["任务:a", "2026-10-23T03:00:00.000Z"], ["喝水", "2026-10-23T03:00:00.000Z"]]))
      && !bl.quietTask("没有提醒的消息") && bl.reminderPrompts(single("a \"引号\"\n第二行"))[0] === "a \"引号\"\n第二行");
  const bridgeSrc4 = readFileSync(join(ROOT, "src/bridge.ts"), "utf-8");
  check("schedule: a quiet 「任务」 turn puts up no 「正在输入」 (and other reminder turns still do)",
    /if \(!quietTask\(messageText\(event\.data\)\)\) this\.typing\.start\(owner\);/.test(bridgeSrc4));

  // A scheduled message delivered on a later day than it was due: the bot is told which day it meant.
  const late = bl.lateScheduleNote(single("任务:看第二天的行程"), new Date("2026-10-23T04:30:00Z"));
  check("schedule: a nightly message delivered after midnight is told its own day, worked out (not left to UTC)",
    typeof late === "string" && /^\[定时消息晚到\]/.test(late) && /原定 10-22 周四 23:00，10-23 周五 00:30 才送到/.test(late)
      && /「今天」是 10-22 周四，「明天」「第二天」是 10-23 周五/.test(late), late);
  check("schedule: one delivered the same day, or with no time on it, gets no such line",
    bl.lateScheduleNote(single("x", "2026-10-22T13:00:00.000Z"), new Date("2026-10-22T14:30:00Z")) === undefined
      && bl.lateScheduleNote("没有时间", new Date()) === undefined);
  check("schedule: a recurring batch is dated by its latest occurrence",
    /原定 10-22 周四 23:00/.test(bl.lateScheduleNote(batchOf([["任务:a", "2026-10-22T03:00:00.000Z"], ["任务:b", "2026-10-23T03:00:00.000Z"]]),
      new Date("2026-10-23T11:00:00Z")) ?? ""));
  const tc = await import(join(ROOT, "lib/time-context.js"));
  const sched = { id: "m1", source: { kind: "schedule" }, content: [{ type: "text", text: single("任务:看第二天的行程") }] };
  const other = { id: "m2", source: { kind: "plugin:wechat-clawbot" }, content: [{ type: "text", text: "在吗" }] };
  const made = (text) => ({ id: "note", source: { kind: "plugin:wechat-clawbot" }, content: [{ type: "text", text }] });
  const withNote = tc.withLateScheduleNotes({ kind: "enter", messages: [sched, other] }, made, new Date("2026-10-23T04:30:00Z"));
  const onTime = { kind: "enter", messages: [sched] };
  check("schedule: the line rides in the same step, right after the late message (the model has it before its first call)",
    withNote.added === 1 && withNote.decision.messages.length === 3 && withNote.decision.messages[0] === sched
      && withNote.decision.messages[1].id === "note" && withNote.decision.messages[2] === other
      && tc.withLateScheduleNotes(onTime, made, new Date("2026-10-23T03:05:00Z")).decision === onTime
      && tc.withLateScheduleNotes({ kind: "reject" }, made).added === 0);
  check("schedule: the bridge adds the late-delivery line on the WeChat agent, next to the clock filter",
    /registerLateScheduleNotes\(target, \(id\) => this\.isWechatSession\(id\), \(text\) => wechatUserMessage\(\[\{ type: "text", text \}\]\)\)/.test(bridgeSrc4));

  // The calendar date after today: no slip where the zone is +13 or +14.
  {
    const { execFileSync } = await import("node:child_process");
    const lt = pathToFileURL(join(ROOT, "lib/localtime.js")).href;
    const out = execFileSync(process.execPath, ["--input-type=module", "-e",
      `const m = await import(${JSON.stringify(lt)}); console.log(m.zonedDatePlus(1, new Date("2026-10-22T09:00:00Z")), m.zonedDatePlus(-1, new Date("2026-10-22T09:00:00Z")))`],
      { env: { ...process.env, TZ: "Pacific/Kiritimati" }, encoding: "utf-8" }).trim();
    check("time: tomorrow and yesterday are one calendar day away in a +14 zone too", out === "2026-10-23 2026-10-21", out);
  }

  // Start-up only looks (no prompt); the switch is the owner at the card.
  const indexSrc4 = readFileSync(join(ROOT, "src/index.ts"), "utf-8");
  check("restart: start-up prepares the helper without prompts, the switch with them",
    /if \(config\.macCalendar === true && process\.platform === "darwin"\) \{[\s\S]{0,400}void calendarHelper\.prepare\(\)\.catch\(/.test(indexSrc4)
      && /config\.macCalendar === true && process\.platform === "darwin" && !superseded\) \{[\s\S]{0,300}void calendarHelper\.prepare\(true\)\.catch\(/.test(indexSrc4));

  // The card: on a macOS without alarms, the first build promises only the calendar prompt.
  {
    const lib = readFileSync(join(ROOT, "lib/client.js"), "utf-8");
    const start = lib.indexOf("    function authorizeText(d) {");
    const end = lib.indexOf("    function Switch(props) {");
    const authorizeText = new Function(`${lib.slice(start, end)}; return authorizeText;`)();
    const text = authorizeText({ plan: { build: "first", ask: ["calendar"], denied: [], alarmsUnsupported: true } });
    check("card words: a first build on a macOS without alarms promises only the 「日历」 prompt",
      /「日历」的授权窗口/.test(text) && !/提醒事项/.test(text) && /闹钟用不了/.test(text), text);
  }
}

console.log(`宿主: dsh ${HOST_VERSION}  (${NPX})`);
console.log(results.join("\n"));
console.log(`\n${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
