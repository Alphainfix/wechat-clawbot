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
import { readFileSync, mkdirSync, existsSync, unlinkSync, statSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
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
    ["地图 [Jefferson Lab](https://maps.example/x)", false, "latin markdown label"],
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
    "src/prompt.ts", "src/mcp-route.ts", "src/claude-peer.ts", "src/codex-peer.ts"]
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

  // 22:31 US Eastern on Aug 31 is already Sep 1 in UTC. A memory entry stamped
  // then read `[2026-09-01]`, so the agent saw a fact dated in the future.
  const lateEvening = new Date("2026-08-31T22:31:00-04:00");
  const utcWouldSay = lateEvening.toISOString().slice(0, 10);
  const zoned = lt.zonedDate(lateEvening);
  const eastern = lt.USER_TIME_ZONE === "America/New_York";
  if (eastern) {
    check("zonedDate does not drift to the UTC date late in the evening",
      zoned === "2026-08-31" && utcWouldSay === "2026-09-01",
      `zoned=${zoned} utc=${utcWouldSay}`);
  } else {
    check(`zonedDate agrees with the host zone (${lt.USER_TIME_ZONE})`,
      /^\d{4}-\d{2}-\d{2}$/.test(zoned), zoned);
  }
  check("no source file stamps dates from toISOString",
    ["lib/memory.js", "lib/prompt.js", "lib/bridge.js"].every(
      (f) => !/toISOString\(\)\.slice\(0, ?10\)/.test(readFileSync(join(ROOT, f), "utf-8"))));

  // Stepping the calendar, not adding 24h: 2026-03-08 is the US DST spring
  // forward, where +24h lands on the same date at 23:00 in some zones.
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

  // 2026-09-22:机主发「你知道吗,我**其实**可以吃肉桂」来验新链路,结果整条被
  // 预筛挡掉 —— 老正则要求「我」和动词紧挨着,中间夹一个副词就漏判。
  // 这几条钉住「副词可以夹在中间」,同时钉住不能因此把「我们…」放进来。
  const shouldPass = [
    "你知道吗，我其实可以吃肉桂，只是有些同学不喜欢。",
    "我真的不喜欢香菜",
    "我平时都喝美式",
    "我不能喝咖啡",
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
  check("notify sends only to account.userId", /account\.userId/.test(notifyBody),
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
  check("带时间的习惯照常送判定", pre("我习惯晚上十点睡觉") && pre("我每周三下午都有组会"));

  // 兜底:模型被告知不要,仍然偶尔会把提醒归档。用假判定函数模拟它不听话。
  const say = (out) => async () => out;
  const r1 = await confirmWithLLM("我每周三下午都有组会", say('{"section":"提醒事项","fact":"用户每周三下午有组会"}'));
  check("兜底:模型返回「提醒事项」就丢弃，而不是改塞进别的分类", r1 === null);
  const r2 = await confirmWithLLM("我喜欢喝茶", say('{"section":"重要事实","fact":"用户明天上午十点有会议"}'));
  check("兜底:事实里带「明天」这类相对时间就丢弃", r2 === null);
  const r3 = await confirmWithLLM("今天开始我戒咖啡了", say('{"section":"偏好与习惯","fact":"用户戒了咖啡"}'));
  check("兜底:改写后不带相对时间的事实照常保留", r3?.fact === "用户戒了咖啡" && r3?.section === "偏好与习惯");
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
    why("重要事实", "用户每周三下午有组会") === null && why("偏好与习惯", "用户喜欢喝茶") === null);
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
          bridge: { enqueueMessage: async (...args) => { enqueued.push(args); } },
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
  check("codexPeer is a cold field (a flip rebuilds the tool list)", !cfgMod3.HOT_FIELDS.has("codexPeer"));
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
  const indexSrc = readFileSync(join(ROOT, "src/index.ts"), "utf-8");
  check("the monitor starts only after the older instance stopped, and only while current",
    /void claim\.ready\.then\(\(\) => \{\s*if \(claim\.isCurrent\(\)\) startMonitor\(\);/.test(indexSrc));
  check("a retired or unloaded instance never starts a monitor again", /if \(monitorTask \|\| superseded\) return;/.test(indexSrc));
  check("retiring stops the monitor, the Codex peer and the account watcher",
    /claimInstance\(async \(reason\) => \{\s*superseded = true;[\s\S]{0,200}watcher\.close\(\);\s*codexPeer\.close\(\);\s*await stopMonitor\(reason\);/.test(indexSrc));
  check("our own unload gives the slot up", /claim\.release\(\);/.test(indexSrc));
}

console.log(`宿主: dsh ${HOST_VERSION}  (${NPX})`);
console.log(results.join("\n"));
console.log(`\n${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
