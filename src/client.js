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
    const { useState, useEffect } = react;

    /** Loader entry id; since DSH 0.1.7 also the settings form id. */
    const NAMESPACE = "clawbot";
    /** Package name: the key of this bundle's `plugins.bundle.config` card. */
    const PACKAGE = "wechat-clawbot";
    const MB = 1024 * 1024;
    const MODELS_URL = "/plugins/clawbot/models";
    const BRIDGE_URL = "/plugins/clawbot/mcp/status";

    const cls = (n) => `clawbot-${n}`;
    const S = {
      card: cls("card"), cardOpen: cls("card-open"), header: cls("header"),
      headText: cls("head-text"), name: cls("name"), description: cls("description"),
      chevron: cls("chevron"), chevronOpen: cls("chevron-open"), body: cls("body"),
      field: cls("field"), head: cls("head"), label: cls("label"), badge: cls("badge"),
      reset: cls("reset"), input: cls("input"), area: cls("area"), hint: cls("hint"),
      switch: cls("switch"), switchOn: cls("switch-on"), knob: cls("knob"),
      footer: cls("footer"), note: cls("note"), button: cls("button"),
      failed: cls("failed"),
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
     * What the bridge row says under its switch.
     *
     * The useful distinction is not on/off but *has Claude actually called in* —
     * a bridge that is enabled, has a token, and has never been touched means
     * the MCP server is not registered on the Claude side, which looks identical
     * to "working" from inside DSH. So say it explicitly.
     */
    function bridgeHint(bridge) {
      if (bridge === null) return "读取状态…";
      if (bridge.unreachable === true) return "状态读不到（路由没注册？DSH 可能需要重启）";
      if (bridge.enabled !== true) return "已关闭：四个路由都返回 403。开关立刻生效，不用重启";
      if (bridge.tokenReady !== true) return `token 还没生成（${bridge.tokenPath}）`;
      const rejected = bridge.rejected > 0 ? `；另有 ${bridge.rejected} 次 token 不对被拒` : "";
      if (!bridge.calls) {
        return `已就绪，但 Claude 还没连过。先跑 dsh-mcp-bridge --check 验证${rejected}`;
      }
      return `Claude 已调用 ${bridge.calls} 次，最近一次 ${ago(bridge.lastCallAt)}（${bridge.lastRoute}）${rejected}`;
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
          fetch(BRIDGE_URL, { headers: { accept: "application/json" } })
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
            .then((d) => { if (alive && d && d.ok) setBridge(d); })
            .catch(() => { if (alive) setBridge({ unreachable: true }); });
        };
        load();
        const timer = setInterval(load, 5000);
        return () => { alive = false; clearInterval(timer); };
      }, [open]);

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
        // Model first: it is the setting whose default surprises people, because
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
          label: "开放 Claude 桥",
          hint: bridgeHint(bridge),
          overridden: isSet("mcpBridge"), disabled,
          onReset: () => clear("mcpBridge"),
          inline: h(Switch, {
            label: "开放 Claude 桥",
            on: v.mcpBridge !== false,
            disabled,
            // Always writes an explicit value, like the other switches on this
            // card: flipping back to the default still shows 已覆盖, and 重置 is
            // the one thing that clears it. Uniform beats clever here.
            onChange: (next) => set("mcpBridge", next),
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
              "模型、图片、发送与白名单。改完立刻生效，微信连接不中断"),
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
