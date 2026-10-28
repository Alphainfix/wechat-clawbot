/**
 * wechat-clawbot — browser half: the WeChat bot's card on 设置 → 插件.
 *
 * Plain hand-written JS on purpose. The client bundle is loaded by the host's
 * module loader (`window.__ModuleLoader__`), which hands `require` in, so there
 * is nothing here for tsc to resolve; the build simply copies this file to
 * `lib/client.js`.
 *
 * ## Looking like the built-in cards
 *
 * Every number and colour below was read out of
 * `@deepseek-ai/dsh-client-ui-settings-plugins`' own compiled stylesheet rather
 * than eyeballed, because eyeballing got it wrong the first time: the title was
 * 14px/400 against their 15px/600, descriptions 12px against 13px, hints 11px
 * and `label-dimmed` against their 12px and `label-tertiary`. Their structure is
 * also not what it looks like — a field is a COLUMN (label row, then the control
 * full width, then the hint), not a row with the control pushed to the right.
 * This file follows that structure so the card reads as one of theirs.
 *
 * If the host restyles those cards, re-read their rules and update here; there
 * is no shared stylesheet to inherit from.
 *
 * ## Where this card lives (DSH 0.1.7)
 *
 *   1. 0.1.7 moved plugin configuration out of Settings into the **Plugins**
 *      sidebar page. A bundle's own card is the `plugins.bundle.config` slot,
 *      keyed by the bundle's PACKAGE name (`PACKAGE` below — the npm publish
 *      rename rewrites it along with everything else). It is a KEYED slot:
 *      registering without `options.key` throws, and the client plugin tree has
 *      no isolation — one throw takes the whole page down.
 *
 *   2. Reads and writes go through `ctx.configForms.get(<entry id>)` — the
 *      Loader entry id `clawbot`, which 0.1.7 also uses as the settings form
 *      id. (0.1.5's `settingsScope` is gone; naming it in `inject` is exactly
 *      what left 0.1.7 stuck on "Failed to load plugins … waiting for service:
 *      settingsScope".) The snapshot keeps `status` / `value` / `user` /
 *      `writable`, so `snapshot.user` still says whether a field is overridden,
 *      which drives the 已覆盖 badge and the per-field 重置. Writes land in the
 *      profile's cordis patch, not a separate settings document.
 *
 * The fields shown here are the ones the running plugin adopts in place
 * (HOT_FIELDS in src/config.ts). Cold ones are deliberately absent rather than
 * shown-but-inert.
 */
window.__ModuleLoader__.load({
  id: "wechat-clawbot",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    // DSH 0.1.5 把 createSnapshotStore 从 `dsh-client-runtime/client` 挪到了
    // `dsh-client-store`,而**客户端模块表里查不到的名字会抛异常**,一抛就是
    // 「Failed to load plugins」整页白屏(不是这个插件不工作)。所以两个名字都试,
    // 回滚到旧版 DSH 也照样能用。
    const runtime = (() => {
      for (const id of ["@deepseek-ai/dsh-client-store", "@deepseek-ai/dsh-client-runtime/client"]) {
        try {
          const mod = require(id);
          if (mod && typeof mod.createSnapshotStore === "function") return mod;
        } catch { /* 这个名字这一版没有,试下一个 */ }
      }
      throw new Error("找不到 createSnapshotStore(宿主的客户端模块表变了?)");
    })();
    const react = require("react");
    const h = react.createElement;
    const { useState, useEffect, useRef } = react;

    /** Loader entry id; since DSH 0.1.7 also the settings form id. */
    const NAMESPACE = "clawbot";
    /** Package name: the key of this bundle's `plugins.bundle.config` card. */
    const PACKAGE = "wechat-clawbot";
    const MB = 1024 * 1024;
    const MODELS_URL = "/plugins/clawbot/models";
    const BRIDGE_URL = "/plugins/clawbot/mcp/status";
    const CALENDAR_URL = "/plugins/clawbot/calendar/status";
    const MEMORY_OPEN_URL = "/plugins/clawbot/memory/open";
    const AUTHORIZE_URL = "/plugins/clawbot/secretary/authorize";
    const TEST_ALARM_URL = "/plugins/clawbot/secretary/test-alarm";
    const PERMISSIONS_URL = "/plugins/clawbot/permissions";
    const PERMISSIONS_SETTINGS_URL = "/plugins/clawbot/permissions/open-settings";
    const PERMISSIONS_REVEAL_URL = "/plugins/clawbot/permissions/reveal";

    const cls = (n) => `clawbot-${n}`;
    const S = {
      card: cls("card"), cardOpen: cls("card-open"), header: cls("header"),
      headText: cls("head-text"), name: cls("name"), description: cls("description"),
      chevron: cls("chevron"), chevronOpen: cls("chevron-open"), body: cls("body"),
      field: cls("field"), head: cls("head"), label: cls("label"), badge: cls("badge"),
      reset: cls("reset"), input: cls("input"), area: cls("area"), hint: cls("hint"),
      switch: cls("switch"), switchOn: cls("switch-on"), knob: cls("knob"),
      footer: cls("footer"), note: cls("note"), button: cls("button"),
      failed: cls("failed"), actions: cls("actions"), attention: cls("attention"),
    };

    let stylesInjected = false;
    /**
     * Inject the card's CSS once.
     *
     * These values mirror `.YyYd_a_*` (card/header) and `.At1oFq_*` (fields) in
     * the host's settings-plugins bundle. Colours are `--dsw-*` tokens only, so
     * light/dark follows the app.
     */
    function ensureStyles() {
      if (stylesInjected || typeof document === "undefined") return;
      stylesInjected = true;
      const el = document.createElement("style");
      el.dataset.clawbot = "settings-card";
      el.textContent = `
.${S.card} { border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-3); border-radius: 12px; list-style: none;
  transition: border-color .16s, background .16s; }
.${S.card}:hover { border-color: var(--dsw-alias-label-dimmed); }
.${S.cardOpen} { background: var(--dsw-alias-bg-layer-2);
  border-color: var(--dsw-alias-label-dimmed); }
.${S.header} { appearance: none; width: 100%; font: inherit; color: inherit;
  text-align: left; cursor: pointer; background: 0 0; border: 0; border-radius: 12px;
  align-items: center; gap: 12px; padding: 14px 16px; display: flex; }
.${S.header}:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: -2px; }
.${S.headText} { flex-direction: column; flex: 1; gap: 4px; min-width: 0; display: flex; }
.${S.name} { color: var(--dsw-alias-label-primary); font-size: 15px; font-weight: 600;
  line-height: 1.4; }
.${S.description} { color: var(--dsw-alias-label-tertiary); font-size: 13px;
  line-height: 1.5; }
.${S.chevron} { color: var(--dsw-alias-label-tertiary); flex: none;
  transition: transform .16s; }
.${S.chevronOpen} { transform: rotate(180deg); }
.${S.body} { border-top: 1px solid var(--dsw-alias-border-l2); margin: 0 16px;
  padding-bottom: 8px; }
.${S.field} { flex-direction: column; gap: 6px; padding: 12px 0; display: flex; }
.${S.field} + .${S.field} { border-top: 1px solid var(--dsw-alias-border-l2); }
.${S.head} { align-items: center; gap: 8px; display: flex; }
.${S.label} { min-width: 0; color: var(--dsw-alias-label-primary); flex: 1;
  font-size: 13px; font-weight: 500; line-height: 1.5; }
.${S.badge} { white-space: nowrap; background: var(--dsw-alias-bg-module-platform);
  color: var(--dsw-alias-label-secondary); border-radius: 999px; padding: 1px 8px;
  font-size: 11px; font-weight: 500; line-height: 17px; }
.${S.reset} { font: inherit; color: var(--dsw-alias-label-secondary); cursor: pointer;
  background: 0 0; border: none; padding: 0; font-size: 12px; line-height: 1.5; }
.${S.reset}:hover:not(:disabled) { color: var(--dsw-alias-label-primary); }
.${S.reset}:disabled { cursor: default; }
.${S.input} { border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-3); height: 34px; font: inherit;
  color: var(--dsw-alias-label-primary); border-radius: 8px; padding: 0 12px;
  font-size: 13px; line-height: 1.5; width: 100%; box-sizing: border-box; }
.${S.input}:focus-visible { border-color: var(--dsw-alias-brand-primary); outline: none; }
.${S.input}:disabled { color: var(--dsw-alias-label-tertiary); cursor: default; }
.${S.area} { border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-3); min-height: 56px; font: inherit;
  color: var(--dsw-alias-label-primary); border-radius: 8px; padding: 7px 12px;
  font-size: 13px; line-height: 1.5; width: 100%; box-sizing: border-box;
  resize: vertical; }
.${S.area}:focus-visible { border-color: var(--dsw-alias-brand-primary); outline: none; }
.${S.hint} { color: var(--dsw-alias-label-tertiary); margin: 0; font-size: 12px;
  line-height: 1.5; }
.${S.switch} { position: relative; width: 38px; height: 22px; padding: 0; border: 0;
  border-radius: 999px; cursor: pointer; flex: none;
  background: var(--dsw-alias-border-l2); transition: background .16s; }
.${S.switch}:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px; }
.${S.switch}:disabled { cursor: default; opacity: .55; }
.${S.switchOn} { background: var(--dsw-alias-brand-primary); }
.${S.knob} { position: absolute; top: 3px; left: 3px; width: 16px; height: 16px;
  border-radius: 50%; background: #fff; transition: transform .16s; }
.${S.switchOn} .${S.knob} { transform: translateX(16px); }
.${S.footer} { border-top: 1px solid var(--dsw-alias-border-l2); align-items: center;
  gap: 8px; padding: 12px 0 4px; display: flex; }
.${S.note} { min-width: 0; color: var(--dsw-alias-label-tertiary); flex: 1; margin: 0;
  font-size: 12px; line-height: 1.5; }
.${S.button} { appearance: none; font: inherit; cursor: pointer; flex: none;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; padding: 5px 14px;
  font-size: 13px; line-height: 1.5; color: var(--dsw-alias-label-secondary);
  background: 0 0; }
.${S.button}:hover:not(:disabled) { color: var(--dsw-alias-label-primary);
  border-color: var(--dsw-alias-label-dimmed); }
.${S.button}:disabled { opacity: .4; cursor: default; }
.${S.failed} { color: var(--dsw-alias-state-error-primary); font-size: 12px; line-height: 1.5; }
.${S.actions} { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
.${S.attention} { color: var(--dsw-alias-state-warn-label, var(--dsw-alias-state-warn-primary));
  font-size: 12px; line-height: 1.5; }
`;
      document.head.appendChild(el);
    }

    /**
     * One field: a label row (label, 已覆盖 badge, 重置, plus inline controls such
     * as a switch), then an optional full-width control, then an optional hint.
     * Mirrors the built-in ValueField layout.
     */
    function Field(props) {
      const { label, hint, control, inline, overridden, onReset, disabled } = props;
      return h(
        "div",
        { className: S.field, key: label },
        h(
          "div",
          { className: S.head },
          h("span", { className: S.label }, label),
          overridden ? h("span", { className: S.badge }, "已覆盖") : null,
          overridden
            ? h("button", {
                type: "button", className: S.reset,
                disabled: disabled === true, onClick: onReset,
              }, "重置")
            : null,
          inline ?? null,
        ),
        control ?? null,
        hint ? h("p", { className: S.hint }, hint) : null,
      );
    }

    /** "3 分钟前" — relative beats an ISO stamp for "did it just happen". */
    function ago(iso) {
      const then = Date.parse(iso);
      if (!Number.isFinite(then)) return "";
      const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
      if (secs < 10) return "刚刚";
      if (secs < 60) return `${secs} 秒前`;
      if (secs < 3600) return `${Math.round(secs / 60)} 分钟前`;
      if (secs < 86400) return `${Math.round(secs / 3600)} 小时前`;
      return `${Math.round(secs / 86400)} 天前`;
    }

    /**
     * GET one of the card's status routes. With no answer to show it rejects
     * with { status, message, platform }; status is missing when DSH was not
     * reached at all, platform unless the route said which system DSH runs on.
     */
    function getStatus(url) {
      return fetch(url, { headers: { accept: "application/json" } }).then(async (r) => {
        const d = await r.json().catch(() => null);
        if (r.ok && d && d.ok) return d;
        throw {
          status: r.status,
          message: d && typeof d.message === "string" ? d.message : undefined,
          platform: d && typeof d.platform === "string" ? d.platform : undefined,
        };
      });
    }

    /**
     * What a status row keeps when getStatus has no answer (not `failed`: the card has a state by that name).
     * `hostPlatform`: the system DSH runs on, when a refusal said so — kept apart from `platform`, which is an answer's.
     */
    function noAnswer(e) {
      if (!e || typeof e.status !== "number") return { unreachable: true };
      return { unreachable: true, status: e.status, message: e.message, ...(e.platform ? { hostPlatform: e.platform } : {}) };
    }

    /**
     * A status row's words when there is no answer. 403 is not a missing route:
     * these routes name programs and paths, so they answer only a page opened on
     * DSH's own computer, and a restart changes nothing.
     */
    function unreachableText(s) {
      if (s.status === 403) return "这一项只在运行 DSH 的那台电脑上能看（在那台电脑上用 127.0.0.1 打开这个页面）";
      if (s.status >= 500 && s.message) return `状态读不到：${s.message}`;
      return "状态读不到（路由没注册？DSH 可能需要重启）";
    }

    /**
     * What the bridge row says under its switch.
     *
     * The useful distinction is not on/off but *has Claude actually called in* —
     * a bridge that is enabled, has a token, and has never been touched means
     * the MCP server is not registered on the Claude side, which looks identical
     * to "working" from inside DSH. So say it explicitly.
     */
    function bridgeHint(bridge) {
      if (bridge === null) return "读取状态…";
      if (bridge.unreachable === true) return unreachableText(bridge);
      if (bridge.enabled !== true) return "已关闭：MCP 路由都返回 403。开关立刻生效，不用重启";
      if (bridge.tokenReady !== true) return `token 还没生成（${bridge.tokenPath}）`;
      const rejected = bridge.rejected > 0 ? `；另有 ${bridge.rejected} 次 token 不对被拒` : "";
      if (!bridge.calls) {
        return `已就绪，但 MCP 客户端还没连过。先跑 clawbot-mcp --check 验证${rejected}`;
      }
      return `MCP 客户端已调用 ${bridge.calls} 次，最近一次 ${ago(bridge.lastCallAt)}（${bridge.lastRoute}）${rejected}`;
    }

    /** One Mac permission as a short phrase. */
    function grant(state, what, app) {
      switch (state) {
        case "fullAccess": return `${what}已授权`;
        case "notDetermined": return `${what}还没授权`;
        // 隐私与安全: macOS 27's name, and the start of 隐私与安全性 (macOS 13–26).
        case "denied": return `${what}被拒绝了（系统设置 → 隐私与安全 → ${what} 里打开「${app}」）`;
        case "writeOnly": return `${what}只有「仅添加」（系统设置 → 隐私与安全 → ${what} 里改成完全访问）`;
        case "restricted": return `${what}被这台 Mac 的管理策略限制了`;
        case "outdated": return `${what}：要先更新小程序`;
        default: return `${what}：${state || "读取中"}`;
      }
    }

    /**
     * What the 全天候秘书 row says. The states that need the owner at the Mac
     * come first (a prompt on screen, an outdated helper, a refusal): that is
     * what has to be done before walking away from it.
     */
    function assistantHint(status, name, on) {
      const base = "打开后，bot 能读 Mac「日历」里所有账户的日程（含备注），在专用日历里自己安排，还能设闹钟（紧急提醒，到点像闹钟一样响，不靠微信）。"
        + "闹钟要 macOS 26.2 和 iOS 26.2 或更新。排日程、定闹钟的规则写在 memory.md 的「## 全天候秘书」一节，可以直接改。"
        + "仅 macOS，关着时不占 token。打开时（或之后点「一键授权」）Mac 上会弹出「日历」和「提醒事项」两个授权"
        + "（macOS 早于 26.2 时只有「日历」），要在 Mac 前点「允许」";
      if (status === null) return base;
      if (status.unreachable === true) return unreachableText(status);
      if (status.mac === false) return "只支持 macOS";
      if (!on) return name ? base : `先填专用日历的名字，再打开开关。${base}`;
      if (!name) return "先在上面填专用日历的名字（闹钟清单第一次也按它起名），bot 才能排日程、定闹钟";
      if (status.others > 0) return "白名单里还有别人：大家共用这一个对话，日历和闹钟会被看到，所以这些工具不开放";
      const app = status.helper || "Clawbot-Calendar";
      if (status.preparing && status.built === false && !status.stale) {
        return `正在准备「${app}」（第一次要编译，约一分钟），之后 Mac 上会弹出授权窗口`;
      }
      if (status.prompting) {
        const names = { calendar: "「日历」", reminders: "「提醒事项」" };
        const which = (status.waitingFor || []).map((k) => names[k]).join("、");
        return `等你在 Mac 上点「允许」：屏幕上有「${app}」的${which || ""}授权窗口（可能被别的窗口挡住）`;
      }
      if (status.preparing) return `正在准备「${app}」…`;
      if (status.error && status.authorization !== "fullAccess") return `还没就绪：${status.error}`;
      if (status.built === false && !status.stale) return `「${app}」还没编译：点「一键授权」`;
      const unsupported = status.alarms === "unsupported";
      const lines = [];
      if (status.updateError) lines.push(`小程序更新没成功（旧版照常能用）：${status.updateError}`);
      else if (status.outdated) {
        // Protocol 1 has no alarms at all; protocol 2 has them, and only misses the newer pieces.
        lines.push(`${(status.protocol ?? 1) < 2 ? "小程序要更新才能用闹钟" : "小程序有更新"}：到 Mac 前点「一键授权」`
          + "（更新后「日历」「提醒事项」都要在 Mac 上再点一次「允许」，不在 Mac 前就先别点，日历会停到点了「允许」为止）");
      }
      lines.push(unsupported
        ? `${grant(status.authorization, "日历", app)}；这台 Mac 的系统没有紧急提醒（要 macOS 26.2 或更新），闹钟用不了`
        : `${grant(status.authorization, "日历", app)}；${grant(status.reminders, "提醒事项", app)}`);
      if (status.authorization === "fullAccess") {
        lines.push(status.dedicated && status.dedicated.name === name
          ? `专用日历「${name}」在「${status.dedicated.account || "本机"}」，能看到 ${status.calendars ?? "?"} 个日历`
          : `专用日历「${name}」第一次用到时创建（优先建在 iCloud）`);
      }
      if (status.reminders === "fullAccess" && !unsupported) {
        lines.push(status.alarmList
          ? `闹钟清单「${status.alarmList.name}」在「${status.alarmList.account || "iCloud"}」（改了名字也继续用它）`
          : `闹钟清单「${name} 闹钟」第一次设闹钟时创建`);
      }
      if (status.secretaryOn === false) {
        lines.push("排日程的规则没开（配置里 secretary 是关的）：日历和闹钟照常能用；要那套规则，就把开关关掉再打开一次"
          + (status.outdated ? "（在 Mac 前做：重新打开会顺便更新小程序、弹出授权）" : ""));
      } else if (status.secretary === false) {
        lines.push("memory.md 里没找到「## 全天候秘书」一节：关掉再打开一次就会放回去");
      }
      const undecided = status.authorization === "notDetermined" || (!unsupported && status.reminders === "notDetermined");
      const ready = status.authorization === "fullAccess" && !status.outdated
        && (unsupported || status.reminders === "fullAccess");
      if (ready && !unsupported) {
        lines.push("闹钟只在「查找」里作为“我的位置”的那台设备上像闹钟一样响（一般是 iPhone）；iPhone 上还要先在「提醒事项」里"
          + "手动把一条提醒设成「紧急」一次、允许弹出的授权，闹钟才会响（之后在「设置 → App → 提醒事项」的「闹钟」里能看到它）。点「测试闹钟」试响一次");
      } else if (undecided) {
        lines.push("缺的授权到 Mac 前点「一键授权」补上；都允许之后点「测试闹钟」试响一次");
      }
      return lines.join("。");
    }

    /** What 一键授权 answered it is doing (the route's plan). */
    function authorizeText(d) {
      const p = (d && d.plan) || {};
      const names = { calendar: "「日历」", reminders: "「提醒事项」" };
      const list = (keys) => (keys || []).map((k) => names[k] || k).join("、");
      const parts = [];
      if (p.build === "first") parts.push("先编译小程序（第一次要一两分钟）");
      if (p.build === "update") parts.push("先更新小程序（更新后两个授权都要重新点）");
      if ((p.ask || []).length > 0) {
        parts.push(`Mac 屏幕上会弹出${list(p.ask)}的授权窗口（可能被别的窗口挡住），都点「允许」`);
      } else if (p.error) {
        parts.push(`小程序这次没有回应（${p.error}）：过一会儿再点一次「一键授权」`);
      }
      if ((p.denied || []).length > 0) {
        parts.push(`${list(p.denied)}之前被拒绝了，只能在 系统设置 → 隐私与安全 里打开「Clawbot-Calendar」`);
      }
      if (p.alarmsUnsupported) parts.push("这台 Mac 的系统没有紧急提醒，闹钟用不了（日历不受影响）");
      return parts.length > 0 ? parts.join("；") : "都已经授权了，不用再点";
    }

    /** Whether this page is open on the computer DSH runs on: the 电脑权限 buttons act on that computer. */
    function onThisComputer() {
      if (typeof location === "undefined" || location.protocol === "dsh-app:") return true;
      const host = location.hostname;
      return host === "localhost" || host === "[::1]" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
    }

    /**
     * How the card names what DSH's access is held against: 「终端」（Terminal）,
     * 「DSH小鲸鱼」（DSHWhale.app） — Finder lists a bundle by its file name, which
     * can differ from the app's own name — 「node」…, or null when it is not known.
     */
    function starterName(l) {
      if (!l || l.kind === "unknown") return null;
      if (l.kind !== "app") return `「${l.name}」`;
      const file = (l.file || "").replace(/\.app$/, "");
      const also = [];
      if (l.localName) also.push(l.name);
      if (file !== "" && file !== l.name && file !== l.localName) also.push(l.file);
      return `「${l.localName || l.name}」${also.length > 0 ? `（${also.join("，")}）` : ""}`;
    }

    /** The name Finder shows for it, for the 在访达中显示 button. */
    function finderName(l) {
      if (l.kind !== "app") return l.name;
      return l.localName || (l.file ? l.file.replace(/\.app$/, "") : l.name);
    }

    /**
     * The 电脑权限 row. On a Mac the bot's file access belongs to whatever started
     * DSH (or to DSH's own program), so the text names it; without Full Disk
     * Access every protected folder puts a dialog on the Mac's screen, and the bot
     * waits for someone to click. System Settings' words are quoted as they read
     * in Chinese (「完全磁盘访问权限」, 「以后」).
     */
    function permissionHint(p, here) {
      if (p === null) return "读取中…";
      if (p.unreachable === true) return unreachableText(p);
      const away = here ? "" : "。下面的按钮在运行 DSH 的那台电脑上打开";
      if (p.platform === "win32") {
        const base = "Windows 不用单独授权：bot 能读你能读的所有文件，不会弹窗问";
        if (p.folderGuard !== "on") return base;
        // Windows Security has used both names over the years; English too, in case it renames them again.
        return `${base}。不过这台电脑开着「文件夹限制访问」（勒索软件防护，也叫「受控文件夹访问」，英文 Controlled folder access）：`
          + "bot 在文档、图片、视频、音乐这些受保护的文件夹（桌面通常也在内）里新建、修改文件会被拦（读不受影响），"
          + "Windows 安全中心会弹出「未经授权的更改被阻止」。"
          + `被拦的主要是两个程序：DSH 自己的读写工具算 ${p.program}，bot 跑的命令算 PowerShell（装了 PowerShell 7 是 pwsh.exe，否则是 powershell.exe）；`
          + "命令里再运行的其他程序也可能按它自己的名字被拦。"
          + "要放行，点「打开 Windows 安全中心」→「通过文件夹限制访问允许某个应用」→「添加允许的应用」→「最近阻止的应用」，把列出的这些加进去"
          + "（会弹出用户帐户控制，要管理员确认）；加好以后重启一次 DSH（桌面版退出再打开），DSH 自己的工具才放行。"
          // DSH's own program is node.exe under `dsh web`, the app itself under DSH Desktop.
          + `注意：放行 PowerShell 或 ${String(p.program || "node.exe").split(/[\\/]/).pop()}，等于让用它们运行的所有脚本都能改这些文件夹；`
          + `不想放行，就让 bot 把文件存到别处（「下载」默认不受保护）${away}`;
      }
      if (p.platform !== "darwin") return "这台电脑不用单独授权";
      const l = p.launcher || { kind: "unknown" };
      const who = starterName(l);
      const holder = l.kind === "program" && l.own ? ` DSH 自己的程序${who}` : `启动 DSH 的程序${who || ""}`;
      const unsigned = l.signing === "adhoc" || l.signing === "unsigned";
      const unstable = who !== null && unsigned ? `${who}没有正式签名：它每更新一次，macOS 就当它是新程序，要回这里再开一次` : null;
      if (p.fullDisk === "granted") {
        const lines = [`完全磁盘访问权限已开${who ? `（开给了${who}）` : ""}：bot 读下载、桌面、文稿、照片图库都不会再弹窗`];
        if (p.fullDiskHere === "denied") lines.push("DSH 是在开之前启动的，它自己的读文件工具要重启一次 DSH 才用得上（bot 跑的命令已经可以了）");
        if (unstable) lines.push(unstable);
        return lines.join("。");
      }
      const lines = [p.fullDisk === "denied"
        ? `还没开「完全磁盘访问权限」：macOS 把 bot 读文件的授权算在${holder}头上。没开时 bot 每进一个受保护的文件夹`
          + "（下载、桌面、文稿、照片图库……），Mac 上都会弹窗，没人点「允许」它就一直卡着"
        : `查不出「完全磁盘访问权限」开没开（探测没有得到回答）${who ? `；要开就开给${holder}` : ""}`];
      const admin = "（要管理员确认一次：触控 ID 或登录密码）";
      if (l.kind === "app") {
        // "Quit & Reopen" on Terminal or DSH Desktop would take DSH down with it; the bot's
        // commands are new processes and have the access at once, so 以后 (Later) is enough.
        lines.push(`点「打开设置」，在列表里把它打开；列表里没有就点「+」添加，或者把访达里选中的它拖进去${admin}。`
          + "提示「…将无法完全访问磁盘，直至退出」时点「以后」（英文系统是 Later），不要点「退出并重新打开」。开好后这里会自动变成「已开」");
        if (!l.dsh) lines.push("注意：开了以后，在它里面运行的其他程序也都能读你的全部文件");
        if (unstable) lines.push(unstable);
      } else if (l.kind === "program") {
        // The card's own probe leaves it in the list, switched off — next to any other node of the same name.
        lines.push(`它是 ${l.path}${l.own ? "（macOS 没把它算在哪个 App 头上：DSH 由 launchd 直接运行，或者启动它的程序把授权交给了 DSH 自己，都是这样）" : ""}。`
          + `点「打开设置」：列表里多半已经有一个关着的「${l.name}」（同名的可能不止一个，要的是这个路径），把它打开；`
          + `没有就点「+」，按 ⌘⇧G 粘贴这个路径${admin}。`
          + (unsigned ? "它没有正式签名，每更新一次都要回来重新开" : "换了版本、路径变了要重新开"));
        lines.push(`注意：开了以后，不经过 App、直接用这个「${l.name}」运行的其他程序也都能读你的全部文件`);
      } else {
        lines.push(`没认出启动 DSH 的程序（${l.reason || "原因不明"}）：在终端里运行就给「终端」，用 DSH 桌面版就给「DeepSeek Harness」，`
          + `用小鲸鱼就给「DSH小鲸鱼」（DSHWhale.app）${p.own ? `，由 launchd 直接运行就给 DSH 自己的程序 ${p.own}` : ""}。点「打开设置」去开`);
      }
      return lines.join("。") + away;
    }

    function Switch(props) {
      return h(
        "button",
        {
          type: "button",
          role: "switch",
          "aria-checked": props.on === true,
          "aria-label": props.label,
          disabled: props.disabled === true,
          className: `${S.switch} ${props.on ? S.switchOn : ""}`,
          onClick: () => props.onChange(props.on !== true),
        },
        h("span", { className: S.knob }),
      );
    }

    function Card(props) {
      const state = props.useClawbot((snapshot) => snapshot);
      const [open, setOpen] = useState(false);
      const [restarting, setRestarting] = useState(false);
      const [failed, setFailed] = useState(false);
      const [catalogue, setCatalogue] = useState(null);
      const [bridge, setBridge] = useState(null);
      const [calendar, setCalendar] = useState(null);
      // What is typed in the calendar-name box; null = show the saved name.
      const [calName, setCalName] = useState(null);
      // The "打开 memory.md" button: null, "opening", "opened", or what went wrong.
      const [memoryOpen, setMemoryOpen] = useState(null);
      // 一键授权 / 测试闹钟: { busy, text, kind, at } while one runs and after it answered; cleared once stale.
      const [action, setAction] = useState(null);
      // Bumped to look at the calendar status again at once (after 一键授权).
      const [poke, setPoke] = useState(0);
      // The 电脑权限 row: what started DSH and whether it has Full Disk Access (macOS),
      // or Controlled folder access (Windows). null until the first answer.
      const [perm, setPerm] = useState(null);
      // 打开设置 / 在访达中显示: { busy, text, at } while one runs and for a while after.
      const [permAction, setPermAction] = useState(null);
      // Set at the click itself: two clicks before React re-renders would both still see permAction idle.
      const permPressing = useRef(false);
      // The switch, before the early return below: flipping it looks again at once
      // (the off state counts as settled, so the next look would be a minute away).
      const calendarOn = Boolean(state && state.value && state.value.macCalendar === true);

      // The model catalogue is a server fact, fetched the first time the card is
      // opened rather than on mount: it costs one resolveModelInfo per model, and
      // most visits to this page never expand this card.
      useEffect(() => {
        if (!open || catalogue !== null) return;
        let alive = true;
        fetch(MODELS_URL, { headers: { accept: "application/json" } })
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
          .then((d) => { if (alive && d && d.ok) setCatalogue(d.providers || []); })
          .catch(() => { if (alive) setCatalogue([]); });
        return () => { alive = false; };
      }, [open, catalogue]);

      // Bridge status: cheap (no model round trips), and it answers a question
      // the settings schema cannot — whether Claude has actually called in.
      // Re-polled while the card is open so "刚刚" is true rather than stale.
      useEffect(() => {
        if (!open) return;
        let alive = true;
        const load = () => {
          getStatus(BRIDGE_URL)
            .then((d) => { if (alive) setBridge(d); })
            .catch((e) => { if (alive) setBridge(noAnswer(e)); });
        };
        load();
        const timer = setInterval(load, 5000);
        return () => { alive = false; clearInterval(timer); };
      }, [open]);

      // Calendar permission state. The server only asks the helper while the
      // switch is on, and caches the answer, so polling here launches nothing.
      useEffect(() => {
        if (!open) return;
        let alive = true;
        let timer = null;
        // Fast while the permission is still being decided, slow once it has
        // settled (or the switch is off): every look launches the helper app.
        const final = ["fullAccess", "denied", "restricted", "writeOnly"];
        const settled = (d) => d && (d.enabled !== true
          || (final.includes(d.authorization)
            && (final.includes(d.reminders) || d.reminders === "outdated" || d.alarms === "unsupported")
            && d.preparing !== true && d.prompting !== true));
        const next = (d) => { if (alive) timer = setTimeout(tick, settled(d) ? 60000 : 10000); };
        const tick = () => {
          getStatus(CALENDAR_URL)
            .then((d) => {
              if (!alive) return;
              setCalendar(d);
              // 一键授权's answer describes a round: once that round is over, the live hint says the rest.
              if (d.preparing !== true && d.prompting !== true) {
                setAction((a) => (a && !a.busy && a.kind === "authorize" && Date.now() - a.at > 3000 ? null : a));
              }
              next(d);
            })
            .catch((e) => { if (alive) { setCalendar(noAnswer(e)); next(null); } });
        };
        tick();
        return () => { alive = false; if (timer) clearTimeout(timer); };
      }, [open, poke, calendarOn]);

      // Full Disk Access is given in System Settings, outside this page. One look even
      // while the card is folded (the header says when it is missing); while open, a
      // look every few seconds until it is there, and whenever the window gets focus
      // back — so the row turns 已开 by itself once the owner has switched it on.
      useEffect(() => {
        let alive = true;
        let timer = null;
        // The pace an answer calls for: every few seconds while Full Disk Access is missing, else a minute.
        // A look that got nothing back (DSH restarting, a dropped connection) is tried again in a few
        // seconds, so the row does not say 状态读不到 for a minute after DSH is back; a refusal (403:
        // this page is not on DSH's computer) is an answer of its own and keeps the pace.
        let waiting = false;
        // Looks overlap (the timer and a focus); only an answer newer than the one shown counts.
        let asked = 0;
        let shown = 0;
        const next = (d, retry) => {
          if (!alive || !open) return;
          if (timer !== null) clearTimeout(timer);
          if (d !== null) waiting = d.platform === "darwin" && d.fullDisk !== "granted";
          timer = setTimeout(tick, retry ? 5000 : waiting ? 4000 : 60000);
        };
        const tick = () => {
          const n = ++asked;
          const fresh = () => {
            if (!alive || n <= shown) return false;
            shown = n;
            return true;
          };
          getStatus(PERMISSIONS_URL)
            .then((d) => {
              if (!fresh()) return;
              setPerm(d);
              // Done once it is there: what a button said is about the way there.
              if (d.platform === "darwin" && d.fullDisk === "granted") setPermAction((a) => (a && !a.busy ? null : a));
              next(d);
            })
            .catch((e) => {
              if (!fresh()) return;
              const lost = noAnswer(e);
              setPerm(lost);
              next(null, lost.status !== 403);
            });
        };
        tick();
        const onFocus = () => tick();
        if (typeof window !== "undefined") window.addEventListener("focus", onFocus);
        return () => {
          alive = false;
          if (timer !== null) clearTimeout(timer);
          if (typeof window !== "undefined") window.removeEventListener("focus", onFocus);
        };
      }, [open]);

      // Follow the saved name again once it changes (a save landed, or 重置).
      const savedName = state && state.value ? (state.value.macCalendarName || "") : "";
      useEffect(() => { setCalName(null); }, [savedName]);

      if (!state || state.available !== true) return null;

      const v = state.value || {};
      const user = state.user || {};
      const disabled = state.writable !== true;
      const set = props.set;
      const clear = props.clear;
      const isSet = (field) => Object.hasOwn(user, field);

      /** Commit a number, or clear the override when the box is emptied. */
      const num = (field, raw, scale) => {
        const text = String(raw).trim();
        if (text === "") return clear(field);
        const parsed = Number(text);
        if (Number.isFinite(parsed) && parsed >= 0) set(field, Math.round(parsed * (scale || 1)));
      };

      const providers = (catalogue || []).filter((p) => (p.models || []).length > 0);
      const provider = providers.find((p) => p.id === v.provider);
      const models = (provider && provider.models) || [];
      const model = models.find((m) => m.id === v.model);
      const efforts = (model && model.efforts) || [];

      const openMemory = async () => {
        if (memoryOpen === "opening") return;
        setMemoryOpen("opening");
        try {
          const res = await fetch(MEMORY_OPEN_URL, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
          const d = await res.json().catch(() => null);
          if (res.ok && d && d.ok) {
            setMemoryOpen("opened");
            setTimeout(() => setMemoryOpen((now) => (now === "opened" ? null : now)), 3000);
          } else {
            setMemoryOpen((d && d.message) || `打不开（HTTP ${res.status}）`);
          }
        } catch {
          setMemoryOpen("打不开：路由读不到，DSH 可能需要重启");
        }
      };

      /** POST one of the 全天候秘书 buttons; the answer is shown under the row. */
      const press = async (url, running, done, kind) => {
        if (action !== null && action.busy) return;
        const at = Date.now();
        setAction({ busy: true, text: running, kind, at });
        try {
          const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
          const d = await res.json().catch(() => null);
          setAction({ busy: false, text: res.ok && d && d.ok ? done(d) : ((d && d.message) || `没成功（HTTP ${res.status}）`), kind, at });
        } catch {
          setAction({ busy: false, text: "没成功：路由读不到，DSH 可能需要重启", kind, at });
        }
        // The test alarm's line is about the next few minutes only.
        if (kind === "test") setTimeout(() => setAction((a) => (a && a.at === at ? null : a)), 240000);
        setPoke((n) => n + 1);
      };
      const authorize = () => press(AUTHORIZE_URL, "正在看要做什么…", authorizeText, "authorize");
      const testAlarm = () => press(TEST_ALARM_URL, "正在设测试闹钟…",
        (d) => d.urgent === false
          ? `设上了（${d.at}），但没能设成紧急提醒，到点只会弹通知`
          : `已设：${d.at} 在「${d.list}」里响，看 iPhone 是不是像闹钟一样响（没响就看这条提醒的备注）`, "test");

      /** 打开设置 / 在访达中显示: the card's own JSON POST; the answer shows under the row for a while. */
      const pressPermission = async (url, done) => {
        if (permPressing.current) return;
        permPressing.current = true;
        const at = Date.now();
        setPermAction({ busy: true, text: "正在打开…", at });
        let text;
        try {
          const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
          const d = await res.json().catch(() => null);
          text = res.ok && d && d.ok ? done : ((d && d.message) || `没打开（HTTP ${res.status}）`);
        } catch {
          text = "没打开：路由读不到，DSH 可能需要重启";
        } finally {
          permPressing.current = false;
        }
        setPermAction({ busy: false, text, at });
        setTimeout(() => setPermAction((a) => (a && a.at === at ? null : a)), 20000);
      };
      const permBusy = permAction !== null && permAction.busy;
      const starter = perm !== null && perm.platform === "darwin" ? starterName(perm.launcher) : null;
      const permButtons = [];
      if (perm !== null && perm.platform === "darwin" && perm.fullDisk !== "granted") {
        permButtons.push(h("button", {
          key: "settings", type: "button", className: S.button, disabled: permBusy,
          onClick: () => pressPermission(PERMISSIONS_SETTINGS_URL, "已打开「完全磁盘访问权限」那一页"),
        }, "打开设置"));
        if (starter !== null) {
          const short = finderName(perm.launcher);
          permButtons.push(h("button", {
            key: "reveal", type: "button", className: S.button, disabled: permBusy,
            onClick: () => pressPermission(PERMISSIONS_REVEAL_URL, `已在访达中选中「${short}」，把它拖进列表就行`),
          }, `在访达中显示「${short}」`));
        }
      }
      if (perm !== null && perm.platform === "win32" && perm.folderGuard === "on") {
        permButtons.push(h("button", {
          key: "settings", type: "button", className: S.button, disabled: permBusy,
          onClick: () => pressPermission(PERMISSIONS_SETTINGS_URL, "已打开 Windows 安全中心的「勒索软件防护」"),
        }, "打开 Windows 安全中心"));
      }
      // Nothing to do on other computers (Windows without Controlled folder access, Linux): no row. Nor on a
      // page opened elsewhere when DSH's computer is not a Mac: a refusal cannot say whether Windows has
      // Controlled folder access on (it is off unless turned on), and the other rows already say where to look.
      const permRow = perm === null || perm.platform === "darwin" || (perm.platform === "win32" && perm.folderGuard === "on")
        || (perm.unreachable === true && (perm.hostPlatform === undefined || perm.hostPlatform === "darwin"));

      const restartNow = async () => {
        if (restarting) return;
        setRestarting(true);
        setFailed(false);
        try {
          const res = await fetch("/plugins/dsh-restart/restart", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
        } catch {
          setFailed(true);
          setRestarting(false);
        }
      };

      const select = (value, onChange, options, isDisabled) =>
        h(
          "select",
          {
            className: S.input,
            disabled: disabled || isDisabled === true,
            value,
            onChange: (e) => onChange(e.target.value),
          },
          options.map((opt) => h("option", { key: opt[0], value: opt[0] }, opt[1])),
        );

      const fields = [
        // First, because it is what a new install trips over: on a Mac the bot's file
        // access is held against whatever started DSH, and until that has Full Disk
        // Access every protected folder brings up a dialog on the Mac's screen.
        // The words first, then the buttons: they are steps to read before pressing.
        // What a button answered shows only while there are buttons (nothing left to do, nothing to say).
        permRow ? Field({
          label: "电脑权限",
          control: h("div", null,
            h("p", { className: S.hint }, permissionHint(perm, onThisComputer())
              + (permButtons.length > 0 && permAction !== null && permAction.text ? `（${permAction.text}）` : "")),
            permButtons.length > 0 ? h("div", { className: S.actions }, permButtons) : null),
        }) : null,
        // Model next: it is the setting whose default surprises people, because
        // leaving it empty means the bot follows the deployment default — and the
        // web UI's model picker writes through to exactly that.
        Field({
          label: "模型 provider",
          hint: catalogue === null
            ? "读取模型清单…"
            : "留空 = 跟随全局默认（在网页里换模型时，bot 会跟着换）",
          overridden: isSet("provider"), disabled,
          onReset: () => { clear("provider"); clear("model"); clear("reasoningEffort"); },
          control: select(
            v.provider || "",
            (next) => {
              // A model belongs to its provider, so switching provider drops the
              // stale model and effort rather than leaving an impossible pair.
              clear("model");
              clear("reasoningEffort");
              if (next === "") clear("provider"); else set("provider", next);
            },
            [["", "跟随全局默认"]].concat(providers.map((p) => [p.id, `${p.name}（${p.id}）`])),
            catalogue === null,
          ),
        }),
        Field({
          label: "模型",
          hint: model === undefined
            ? "先选一个 provider"
            : `${model.takesImages ? "支持直接看图" : "不支持看图，识图会退回视觉工具"}${efforts.length ? "" : "；这个模型没有思考等级可选"}`,
          overridden: isSet("model"), disabled,
          onReset: () => { clear("model"); clear("reasoningEffort"); },
          control: select(
            v.model || "",
            (next) => {
              clear("reasoningEffort");
              if (next === "") clear("model"); else set("model", next);
            },
            [["", provider === undefined ? "跟随全局默认" : "选一个模型"]]
              .concat(models.map((m) => [m.id, m.name === m.id ? m.id : `${m.name}（${m.id}）`])),
            provider === undefined,
          ),
        }),
        Field({
          label: "思考等级",
          hint: efforts.length === 0
            ? "选定模型后才知道可选项"
            : `留空 = 用该模型默认${model && model.defaultEffort ? `（${model.defaultEffort}）` : ""}`,
          overridden: isSet("reasoningEffort"), disabled,
          onReset: () => clear("reasoningEffort"),
          control: select(
            v.reasoningEffort || "",
            (next) => { if (next === "") clear("reasoningEffort"); else set("reasoningEffort", next); },
            [["", "用模型默认"]]
              .concat(efforts.map((e) => [e.id, e.name === e.id ? e.id : `${e.name}（${e.id}）`])),
            efforts.length === 0,
          ),
        }),
        Field({
          label: "把图片直接给模型看",
          hint: "模型支持时最快。关掉会退回让它用视觉工具读路径，每张图多花约 40 秒",
          overridden: isSet("attachImages"), disabled,
          onReset: () => clear("attachImages"),
          inline: h(Switch, {
            on: v.attachImages !== false, disabled,
            label: "把图片直接给模型看",
            onChange: (next) => set("attachImages", next),
          }),
        }),
        Field({
          label: "空闲时整理对话",
          hint: "回复结束、安静 10 分钟后，上下文接近压缩阈值就趁空闲把旧对话整理成摘要。下一条消息来时不用再等压缩",
          overridden: isSet("idleCompaction"), disabled,
          onReset: () => clear("idleCompaction"),
          inline: h(Switch, {
            on: v.idleCompaction !== false, disabled,
            label: "空闲时整理对话",
            onChange: (next) => set("idleCompaction", next),
          }),
        }),
        Field({
          label: "空闲整理阈值",
          hint: "万 token。上一次请求超过这个数，空闲时就整理。留空 = 宿主压缩阈值的 85%。只管 bot，网页会话不受影响",
          overridden: isSet("idleCompactionTokens"), disabled,
          onReset: () => clear("idleCompactionTokens"),
          control: h("input", {
            type: "number", className: S.input, min: 1, step: 1, disabled,
            value: v.idleCompactionTokens === undefined ? "" : v.idleCompactionTokens / 10000,
            placeholder: "自动",
            onChange: (e) => num("idleCompactionTokens", e.target.value, 10000),
          }),
        }),
        Field({
          label: "把工作目录的说明文件交给 bot",
          hint: "AGENTS.md / CLAUDE.md。关掉则微信会话里不再自动塞这些文件（DSH 每次改动都会重发整份），需要时让 bot 自己去读",
          overridden: isSet("workspaceInstructions"), disabled,
          onReset: () => clear("workspaceInstructions"),
          inline: h(Switch, {
            on: v.workspaceInstructions !== false, disabled,
            label: "把工作目录的说明文件交给 bot",
            onChange: (next) => set("workspaceInstructions", next),
          }),
        }),
        Field({
          label: "允许回复里出现 emoji",
          hint: "关掉则剥掉 😊 这类符号。[捂脸] 这种方括号代码一律去掉，不受这个开关影响 —— 它们在微信里根本转换不出来",
          overridden: isSet("stripEmoji"), disabled,
          onReset: () => clear("stripEmoji"),
          inline: h(Switch, {
            on: v.stripEmoji === false, disabled,
            label: "允许回复里出现 emoji",
            onChange: (next) => set("stripEmoji", !next),
          }),
        }),
        Field({
          label: "图片长边上限", hint: "像素。相机原图几千万像素，必须缩",
          overridden: isSet("maxImageEdge"), disabled,
          onReset: () => clear("maxImageEdge"),
          control: h("input", {
            type: "number", className: S.input, min: 64, max: 8192, disabled,
            value: v.maxImageEdge === undefined ? "" : v.maxImageEdge,
            placeholder: "2048",
            onChange: (e) => num("maxImageEdge", e.target.value),
          }),
        }),
        Field({
          label: "JPEG 质量", hint: "10–100",
          overridden: isSet("imageQuality"), disabled,
          onReset: () => clear("imageQuality"),
          control: h("input", {
            type: "number", className: S.input, min: 10, max: 100, disabled,
            value: v.imageQuality === undefined ? "" : v.imageQuality,
            placeholder: "80",
            onChange: (e) => num("imageQuality", e.target.value),
          }),
        }),
        Field({
          label: "压缩阈值", hint: "MB。超过这个大小才压缩，以下的原样发",
          overridden: isSet("compressThresholdBytes"), disabled,
          onReset: () => clear("compressThresholdBytes"),
          control: h("input", {
            type: "number", className: S.input, min: 0, step: 0.5, disabled,
            value: v.compressThresholdBytes === undefined ? "" : v.compressThresholdBytes / MB,
            placeholder: "1",
            onChange: (e) => num("compressThresholdBytes", e.target.value, MB),
          }),
        }),
        Field({
          label: "发文件预告阈值",
          hint: "MB。超过这个大小才先发一条「正在发送」。0 = 每个文件都预告",
          overridden: isSet("noticeMinBytes"), disabled,
          onReset: () => clear("noticeMinBytes"),
          control: h("input", {
            type: "number", className: S.input, min: 0, step: 0.5, disabled,
            value: v.noticeMinBytes === undefined ? "" : v.noticeMinBytes / MB,
            placeholder: "2",
            onChange: (e) => num("noticeMinBytes", e.target.value, MB),
          }),
        }),
        Field({
          label: "审批等待超时", hint: "秒。0 = 一直等",
          overridden: isSet("approvalTimeoutMs"), disabled,
          onReset: () => clear("approvalTimeoutMs"),
          control: h("input", {
            type: "number", className: S.input, min: 0, disabled,
            value: v.approvalTimeoutMs === undefined ? "" : v.approvalTimeoutMs / 1000,
            placeholder: "0",
            onChange: (e) => num("approvalTimeoutMs", e.target.value, 1000),
          }),
        }),
        Field({
          label: "日志级别", hint: "协议层日志的详细程度",
          overridden: isSet("logLevel"), disabled,
          onReset: () => clear("logLevel"),
          control: select(
            v.logLevel || "info",
            (next) => set("logLevel", next),
            ["debug", "info", "warn", "error"].map((lv) => [lv, lv]),
          ),
        }),
        Field({
          label: "允许给 bot 发消息的人",
          hint: "每行一个微信用户 id。留空 = 只有扫码登录的本人",
          overridden: isSet("allowFrom"), disabled,
          onReset: () => clear("allowFrom"),
          control: h("textarea", {
            className: S.area, disabled,
            defaultValue: Array.isArray(v.allowFrom) ? v.allowFrom.join("\n") : "",
            placeholder: "留空即可",
            onBlur: (e) => {
              const ids = String(e.target.value).split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
              if (ids.length === 0) clear("allowFrom"); else set("allowFrom", ids);
            },
          }),
        }),
        Field({
          label: "拉活关掉的 Claude 会话时",
          hint: "会话没开着时,先用 --bg 在后台把它拉活成正常会话再投消息。"
            + "这是拉活时给它的审批模式。默认沿用那个会话自己的 —— 要人盯着批的模式"
            + "(default/manual/plan)后台没人可批,会退回「改文件直接过」并在回复里说明",
          overridden: isSet("claudeResumePermissionMode"), disabled,
          onReset: () => clear("claudeResumePermissionMode"),
          control: select(
            v.claudeResumePermissionMode || "inherit",
            (next) => set("claudeResumePermissionMode", next),
            [
              ["inherit", "沿用该会话原本的权限（默认）"],
              ["acceptEdits", "改文件直接过，跑命令仍需批准"],
              ["bypassPermissions", "全部不问（信任的工作区）"],
              ["auto", "由分类器判定"],
              ["dontAsk", "不再询问"],
              ["plan", "只出方案，不动手"],
              ["manual", "每步都要批准（后台等于不动手）"],
            ],
          ),
        }),
        Field({
          label: "开放 MCP 桥（Claude / Codex）",
          hint: bridgeHint(bridge),
          overridden: isSet("mcpBridge"), disabled,
          onReset: () => clear("mcpBridge"),
          inline: h(Switch, {
            label: "开放 MCP 桥（Claude / Codex）",
            on: v.mcpBridge !== false,
            disabled,
            // Always writes an explicit value, like the other switches on this
            // card: flipping back to the default still shows 已覆盖, and 重置 is
            // the one thing that clears it. Uniform beats clever here.
            onChange: (next) => set("mcpBridge", next),
          }),
        }),
        Field({
          label: "全天候秘书",
          hint: assistantHint(calendar, (calName ?? v.macCalendarName ?? "").trim(), v.macCalendar === true)
            + (action !== null && action.text ? `（${action.text}）` : "")
            + (memoryOpen !== null && memoryOpen !== "opening" && memoryOpen !== "opened" ? `（${memoryOpen}）` : ""),
          overridden: isSet("macCalendar") || isSet("macCalendarName") || isSet("secretary"), disabled,
          onReset: () => { clear("macCalendar"); clear("macCalendarName"); clear("secretary"); setCalName(null); },
          inline: h(Switch, {
            label: "全天候秘书",
            on: v.macCalendar === true,
            // Turning it on needs a name first (the one being typed counts);
            // turning it off never does. Calendar, alarms and rules are one
            // feature: the switch sets both fields.
            disabled: disabled || (v.macCalendar !== true
              && (!(calName ?? v.macCalendarName ?? "").trim() || (calendar !== null && calendar.mac === false))),
            onChange: (next) => {
              const typed = (calName ?? v.macCalendarName ?? "").trim();
              if (next && typed !== (v.macCalendarName || "").trim()) set("macCalendarName", typed);
              set("macCalendar", next);
              set("secretary", next);
            },
          }),
          control: h("div", null,
            h("input", {
              type: "text", className: S.input, disabled,
              value: calName ?? (v.macCalendarName || ""),
              placeholder: "专用日历的名字（闹钟清单第一次也用它），例如 规划",
              maxLength: 60,
              onChange: (e) => setCalName(String(e.target.value)),
              onBlur: (e) => {
                const name = String(e.target.value).trim();
                if (name === (v.macCalendarName || "").trim()) return;
                if (name === "") clear("macCalendarName"); else set("macCalendarName", name);
              },
            }),
            h("div", { className: S.actions },
              h("button", {
                type: "button", className: S.button,
                disabled: disabled || v.macCalendar !== true || (action !== null && action.busy),
                onClick: authorize,
              }, "一键授权"),
              h("button", {
                type: "button", className: S.button,
                disabled: disabled || v.macCalendar !== true || (action !== null && action.busy)
                  || !(calendar && calendar.reminders === "fullAccess" && !calendar.outdated && calendar.alarms !== "unsupported"),
                onClick: testAlarm,
              }, "测试闹钟"),
              h("button", {
                type: "button", className: S.button, disabled: disabled || memoryOpen === "opening", onClick: openMemory,
              }, memoryOpen === "opened" ? "已在 Mac 上打开" : "打开 memory.md"),
            )),
        }),
        Field({
          label: "日历提醒",
          hint: "bot 往日历里加日程时，默认带一个提前这么多分钟的日历提醒（手机上也会响）。"
            + "和 bot 的微信提醒重复没关系；全天日程不加；你在微信里说了要提前多久，就按你说的",
          overridden: isSet("macCalendarAlert") || isSet("macCalendarAlertMinutes"), disabled,
          onReset: () => { clear("macCalendarAlert"); clear("macCalendarAlertMinutes"); },
          inline: h(Switch, {
            label: "日历提醒", on: v.macCalendarAlert !== false, disabled,
            onChange: (next) => set("macCalendarAlert", next),
          }),
          control: h("input", {
            type: "number", className: S.input, min: 0, max: 10080, disabled: disabled || v.macCalendarAlert === false,
            value: v.macCalendarAlertMinutes === undefined ? "" : v.macCalendarAlertMinutes,
            placeholder: "提前几分钟，默认 10",
            onChange: (e) => num("macCalendarAlertMinutes", e.target.value),
          }),
        }),
        Field({
          label: "改别的日历前先问我",
          hint: "bot 往专用日历以外的日历里加、改、删日程前，先在微信里问你、回「好」才动。"
            + "关掉就直接改（只读和订阅的日历本来就改不了）；会通知其他参与者的改动仍会先问",
          overridden: isSet("macCalendarAsk"), disabled,
          onReset: () => clear("macCalendarAsk"),
          inline: h(Switch, {
            label: "改别的日历前先问我", on: v.macCalendarAsk !== false, disabled,
            onChange: (next) => set("macCalendarAsk", next),
          }),
        }),
        Field({
          label: "Codex 会话联动",
          hint: "默认关。打开后 bot 可以选择 Codex 项目和会话、转发微信消息、查询进度,但每次请求要多带 5 个工具(约 1k token)。改动会重启微信监听。连接方式和 CLI 路径在 clawbot 配置里设置",
          overridden: isSet("codexPeer"), disabled,
          onReset: () => clear("codexPeer"),
          inline: h(Switch, {
            label: "Codex 会话联动", on: v.codexPeer === true, disabled,
            onChange: (next) => set("codexPeer", next),
          }),
        }),
      ];

      return h(
        "li",
        { className: `${S.card} ${open ? S.cardOpen : ""}` },
        h(
          "button",
          {
            type: "button", className: S.header,
            "aria-expanded": open, onClick: () => setOpen(!open),
          },
          h(
            "span",
            { className: S.headText },
            h("span", { className: S.name }, "微信 Bot"),
            h("span", { className: S.description },
              "模型、图片、白名单、全天候秘书（日历和闹钟）。大多改完立刻生效，微信连接不中断"),
            // Shown folded: the one thing a new install has to do on the Mac itself (open, the row says it).
            !open && perm !== null && perm.platform === "darwin" && perm.fullDisk === "denied"
              ? h("span", { className: S.attention }, "还差一项电脑权限：完全磁盘访问权限（展开看怎么开）")
              : null,
          ),
          h(
            "svg",
            {
              className: `${S.chevron} ${open ? S.chevronOpen : ""}`,
              width: 14, height: 14, viewBox: "0 0 14 14", "aria-hidden": true,
            },
            h("path", {
              d: "M3 5l4 4 4-4", fill: "none", stroke: "currentColor",
              strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round",
            }),
          ),
        ),
        open
          ? h(
              "div",
              { className: S.body },
              fields,
              h(
                "div",
                { className: S.footer },
                h("p", { className: S.note },
                  disabled
                    ? "设置文件不可写，这里只能查看。"
                    : "会话 id、自动监听、iLink 地址等改动需要重启，它们留在 cordis.patch.yml 里。"),
                failed ? h("span", { className: S.failed }, "重启没成功") : null,
                h("button",
                  { type: "button", className: S.button, disabled: restarting, onClick: restartNow },
                  restarting ? "重启中…" : "重启 DSH"),
              ),
            )
          : null,
      );
    }

    const name = "wechat-clawbot-client";
    const inject = ["slots", "configForms"];

    function apply(ctx) {
      ensureStyles();
      const scope = ctx.configForms.get(NAMESPACE);
      const project = () => {
        const snap = scope.getSnapshot();
        return {
          available: snap.status === "ready",
          writable: snap.writable,
          value: snap.value || {},
          // The user layer distinguishes "you set this" from "inherited from the
          // profile" — the 已覆盖 badge and per-field 重置 both read it, same as
          // the built-in cards.
          user: snap.user || {},
        };
      };
      const store = runtime.createSnapshotStore(project());
      ctx.effect(() => scope.subscribe(() => {
        store.set(project());
      }), "clawbot: settings form subscription");

      // Only while the Host serves the entry's form — i.e. the server half is
      // up and declared its volatile fields — and withdrawn if it stops.
      ctx.effect(() => ctx.configForms.whileServed([NAMESPACE], () =>
        ctx.slots.inject("plugins.bundle.config", () =>
          ctx.slots.register(
            {
              name: "plugins.bundle.config",
              // Keyed slot: omitting `key` throws, and one throw here takes the
              // entire page down (no isolation in the client plugin tree).
              key: PACKAGE,
              id: NAMESPACE,
              order: 50,
              inject: () => ({
                hooks: { clawbot: store },
                set: (field, value) => scope.set(field, value),
                clear: (field) => scope.unset(field),
              }),
            },
            Card,
          ),
        ),
      ), "clawbot: plugins page card");
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.name = name;
    return module.exports;
  },
});
