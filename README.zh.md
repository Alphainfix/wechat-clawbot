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
- **开放 Claude 桥**：见下面「和 Claude Code 联动」。

少数几项（会话 id、工作目录、是否随 DSH 自动启动等）在 `~/.dsh/profiles/web/cordis.patch.yml` 的 `- id: clawbot` 里改，改完会自动重启微信监听。

## 隐私与安全

- **只有你能用**：默认只接受扫码绑定者本人的消息，陌生人的消息直接忽略。
- **需要授权的操作会先问你**：DSH 要你批准的操作，在微信会话里一律发到微信问你，你不回就不做。
- **消息去哪**：你的消息只会发给你在 DSH 里给这个会话配置的模型，插件不会把内容发给其他地方。
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
这组接口只监听本机，并且要求令牌。不需要的话，在「微信 Bot」设置里关掉「**开放 Claude 桥**」即可。

## 开发

```bash
npm install
npm run build              # 编译到 lib/
node test/regression.mjs   # 离线回归测试：不调模型、不联网、不碰微信
```

`src/ilink/` 是移植自腾讯官方 MIT 许可的 [`@tencent-weixin/openclaw-weixin`](https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin) 的协议层，
其余是 DSH 集成代码。

## License

MIT。移植的 iLink 协议客户端版权归腾讯，同为 MIT 许可，见 [NOTICE](NOTICE)。
