# wechat-clawbot

[English](README.md) | 中文

在微信里和你电脑上的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）助手聊天。
出门在外也能让它查文件、改文档、跑命令，结果直接回到微信对话里。

它走的是微信官方的 **微信ClawBot** 通道（腾讯 iLink），不用小号、不模拟网页登录。

## 能做什么

- **在微信里使唤你的电脑**：「帮我看看下载文件夹里最新的 PDF」「把这个脚本跑一下」
- **看图**：直接发照片问「这是什么？」，模型支持图片输入时，照片会原样交给它看
- **把文件发回微信**：「把 README.md 发给我」「画张图表发我」—— 图片、PDF、Office 文档、压缩包都行
- **「对方正在输入…」**：它在想、在查、在给你传文件的时候，微信里会像真人一样显示「对方正在输入」，回复一到就消失
- **定时提醒**：「明天早上 9 点提醒我交报告」，到点在微信里提醒你
- **长期记忆**：记住你的习惯和偏好，下次不用再说一遍
- **先问再做**：需要你授权的操作（比如动工作目录以外的文件），会先在微信里问你，回「同意」或「拒绝」即可
- **看得懂引用**：引用一条旧消息回复，它知道你在说哪条
- **聊得越久也不变慢**：回复结束、安静一阵之后，对话太长就趁空闲把旧内容整理成摘要，你下一条消息来时不用等

## 需要什么

- DSH **0.1.7 到 0.2.x**（在 0.1.7-rc.2 和 0.2.0-rc.2 上测过），以及 Node.js 22+、pnpm
- 手机微信里能用官方「**微信ClawBot**」插件（微信 → 设置 → 插件；第一次扫码时可能会提示升级微信）
- 一台一直开着的电脑：DSH 在运行，bot 才在线

## 三步装好

**1. 安装插件**

```bash
dsh plugin --profile web add wechat-clawbot
```

也可以在 DSH 网页侧边栏「插件」→「添加插件」里搜 `wechat-clawbot`。装完**重启一次 DSH**。

**2. 扫码绑定微信**

```bash
npx -y -p wechat-clawbot clawbot login
```

终端里会出现一个二维码，用微信「扫一扫」扫码并确认。

**3. 开始聊天**

微信里会多出一个联系人「**微信ClawBot**」，给它发消息就行。正在运行的 DSH 几秒内会自动认出新绑定的账号，不用重启。

其他命令：`clawbot status` 看绑定的是谁，`clawbot logout` 解除绑定（同样用 `npx -y -p wechat-clawbot` 前缀）。

## 设置

在 DSH 网页侧边栏打开 **「插件」→ wechat-clawbot → 微信 Bot**，改完立刻生效，微信连接不会断：

- **模型**：给 bot 固定一个 provider / 模型 / 思考档位。留空就跟随 DSH 的全局默认模型。
- **允许给 bot 发消息的人**：默认只有扫码的你自己。要加人就填对方的微信用户 id。
- **图片**：要不要把照片直接交给模型看，以及发图时的压缩尺寸和质量。
- **空闲时整理对话**：默认开。关掉后只剩 DSH 在回复前压缩（会让那一条回复多等十几秒）。
- **把工作目录的说明文件交给 bot**：默认开（DSH 原样：bot 在哪个项目里干过活，那里的 AGENTS.md / CLAUDE.md 就会塞进对话，文件每改一次再塞一整份）。关掉则微信会话里不再自动塞，适合说明文件很长、又经常改的人；需要时让 bot 自己去读。
- **开放 MCP 桥（Claude / Codex）**：见下面的联动说明。
- **Codex 会话联动**：选择 Codex 项目和对话、转发消息、查询进度。

少数几项（会话 id、工作目录、是否随 DSH 自动启动等）在 `~/.dsh/profiles/web/cordis.patch.yml` 的 `- id: clawbot` 里改，改完会自动重启微信监听。

## 隐私与安全

- **只有你能用**：默认只接受扫码绑定者本人的消息，陌生人的消息直接忽略。
- **需要授权的操作会先问你**：DSH 要你批准的操作，在微信会话里一律发到微信问你，你不回就不做。
- **消息去哪**：发给你为这个 DSH 会话配置的模型。你要求转发给 Claude Code 或 Codex 时，对应消息也会交给所选的本机代码会话。
- **自动记忆**（默认开）：像「我不喝咖啡」这种看起来是长期事实的短消息，会让**同一个模型**判断要不要记下来。
  不想要的话，在 `cordis.patch.yml` 的 `clawbot` 里加一行 `autoMemory: false`，下一条消息就生效。
- 绑定凭据和长期记忆都存在本机的 `~/.dsh/clawbot/` 里。

## 常见问题

**发了消息没反应**：先确认 DSH 在运行。再看网页「插件」→ wechat-clawbot，里面两个组件应该都是「运行中」。
刚升级过 DSH 的话，看 [安装与排错手册](wechat-clawbot-INSTALL.md)。

**提醒没按时响**：提醒要靠电脑和 DSH 开着；电脑睡眠时会推迟到醒来之后。

**想换 bot 用的模型**：在上面的「微信 Bot」设置里固定一个模型，这样在网页里换模型就不会影响 bot。

更完整的安装、升级和排错说明见 [wechat-clawbot-INSTALL.md](wechat-clawbot-INSTALL.md)。
这份手册本来是写给「替你装插件的 AI」看的，人看也一样有用。

## 限制

- 不支持群聊，也不支持语音消息。
- 一个 DSH 只绑定一个微信号。
- 电脑关机、DSH 没运行的时候，bot 不在线。

## 和 Claude Code 联动（可选）

如果你也用 Claude Code，bot 可以帮你**查看 Claude Code 会话在做什么**，或者**给某个会话捎一句话**（已经关掉的会话会在后台重新接上）。
需要本机装有 `claude` 命令行。

另外插件在本机开了一组 HTTP 接口，配合 MCP server 使用，可以让 Claude Code 反过来读写 DSH 会话、给你发一条微信通知。
这组接口只监听本机，并且要求令牌。不需要的话，在「微信 Bot」设置里关掉「**开放 MCP 桥（Claude / Codex）**」即可。已有的 Claude MCP 客户端仍然兼容。

## 和 Codex 联动（可选）

支持两个方向：

- **微信 → Codex**：让 bot 列出项目和对话，选择目标后转发消息。DSH 获得
  `list_codex_projects`、`list_codex_sessions`、`read_codex_session`、`send_to_codex_session` 和 `read_codex_progress`。
  项目按对话的工作目录分组，列表支持翻页。选择时使用返回的完整目录和对话 id；多个同名候选会返回选项，不会猜着发送。
- **Codex → DSH / 微信**：包内的 `clawbot-mcp` 是标准 stdio MCP 服务，可读取微信会话、读写 DSH 对话、给微信发通知、发布和查询 Codex 进度。

### 让 Codex 看到 DSH 微信会话和发送微信的 MCP

在运行 DSH 的同一台电脑上编译这个版本，再注册 MCP：

```bash
npm ci
npm run build
codex mcp add wechat-clawbot -- node /path/to/wechat-clawbot/lib/mcp-cli.js
node /path/to/wechat-clawbot/lib/mcp-cli.js --check
```

把 `/path/to/wechat-clawbot` 换成实际代码目录。安装了包含此功能的包后，也可以使用 `clawbot-mcp` 可执行命令。
注册后重新连接 Codex 客户端。DSH 需要运行更新后的插件，并开启「开放 MCP 桥（Claude / Codex）」。
默认地址为 `http://127.0.0.1:3080`；端口不同可设置 `CLAWBOT_DSH_URL`。
令牌从 `$CLAWBOT_STATE_DIR/mcp-token` 或 `$DSH_HOME/clawbot/mcp-token` 读取，`DSH_HOME` 默认为 `~/.dsh`。
使用别的位置可设置 `CLAWBOT_MCP_TOKEN_FILE`。这些环境变量可通过 `codex mcp add --env KEY=VALUE` 传入。
令牌留在本机文件里，不要抄进命令参数或仓库配置。

Codex 可读取 `clawbot://wechat-session`，或调用 `dsh_get_wechat_session` 查看微信对话。
`dsh_notify_wechat({text: "…"})` 只发给扫码绑定的用户，并将带有 `[Codex 发给用户的]` 前缀的副本写入 DSH 历史，不额外触发 bot 回复。
`dsh_send_to_session` 可以驱动所选的 DSH 对话，其回复不会自动发到微信；需要手机通知时使用通知工具。

### 从微信选择项目和对话来转发

默认 `codexTransport: socket` 通过 Unix socket 上的 WebSocket 连接已有的共享 App Server。
默认 socket 为 `$CODEX_HOME/app-server-control/app-server-control.sock`，`CODEX_HOME` 默认为 `~/.codex`。
连接特定共享服务时设置 `codexSocket`；为独立后台模式选择 CLI 时设置 `codexBinary`。
这几项写在本机 DSH `cordis.patch.yml` 的 `clawbot` 配置里，改动会重启插件。
「Codex 会话联动」（`codexPeer`）则是立即生效的设置开关。

共享服务必须是实际执行目标对话的那个服务，并支持官方的 Unix socket WebSocket 传输。
可用 `codex app-server --listen unix://` 或 `--listen unix:///path/to/rpc.sock` 启动本机共享服务。
已经运行的桌面端 / IDE 客户端需要开放或使用该共享服务才能实时投递；**另开一个 daemon 不会自动接管别的客户端正在运行的任务**。
共享服务不可用时会明确报错，不会悄悄启动另一个 Codex 执行同一任务。

连接好后，可以在微信里说「列出 Codex 项目」「看看这个项目的对话」，选定目标后说「把运行测试这句话发给这个对话」。
运行中的任务通过带有当前 turn id 的 `turn/steer` 接收消息；空闲对话通过 `turn/start` 开始下一轮。
会话身份和权限沿用原设置。工具报告消息已投递时，工作未必已经完成，需要另查进度。

如果需要对历史对话做后台续聊，显式设置 `codexTransport: stdio`。
它用已有的 Codex 登录和配置启动独立的 `codex app-server --listen stdio://`，无法判断另一个客户端是否仍在工作。
未加载的历史对话必须先关闭原客户端，并明确允许后台续聊（`allowResume: true`）才会继续执行。
模型、沙箱和审批策略不会被覆盖。独立服务的命令 / 文件审批和用户问题会转到微信，未支持的权限授予会被拒绝；共享服务的审批仍由原 Codex 客户端处理。

### 让 clawbot 查询和汇报 Codex 进度

在 Codex 对话里要求它在重要阶段和结束时调用 `dsh_report_codex_progress`，使用已选择对话的完整 id，例如：

```json
{"threadId":"11111111-1111-4111-8111-111111111111","state":"running","summary":"正在实现解析器"}
```

状态支持 `running`、`waiting`、`completed`、`failed`、`interrupted`。
DSH 通过 `read_codex_progress` 查询；MCP 客户端也可通过 `dsh_read_codex_progress` 查询。
上报只保存进度，不自动发微信；需要通知时让 Codex 另调用 `dsh_notify_wechat`。
已订阅对话的 App Server 事件也会生成进度记录。`notLoaded` 表示实时状态未知；进度记录带有更新时间，不能当成持续在线的心跳。
记录仅存在内存里，最多保存 200 个对话，插件重启后清空。

HTTP 接口为 `POST /plugins/clawbot/mcp/codex/report` 和
`GET /plugins/clawbot/mcp/codex/progress?threadId=…`，和已有接口一样受 bearer token 与 `mcpBridge` 开关保护。
MCP 客户端只接受本机回环地址，并拒绝重定向。包里不会附带登录信息、真实对话快照、个人偏好、项目清单或本地文件索引。
协议说明：[Codex App Server 官方文档](https://learn.chatgpt.com/docs/app-server)。

## 开发

```bash
npm install
npm run build              # 编译到 lib/
node test/regression.mjs   # 离线回归测试：不调模型、不联网、不碰微信
npm run test:codex         # 模拟 Codex、临时回环 HTTP、真实 MCP stdio；不调模型、不发微信
```

`src/ilink/` 是移植自腾讯官方 MIT 许可的 [`@tencent-weixin/openclaw-weixin`](https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin) 的协议层，
其余是 DSH 集成代码。

## License

MIT。移植的 iLink 协议客户端版权归腾讯，同为 MIT 许可，见 [NOTICE](NOTICE)。
