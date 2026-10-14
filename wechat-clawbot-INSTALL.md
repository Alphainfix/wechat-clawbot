# wechat-clawbot 安装与排错手册

> **适用版本**：wechat-clawbot **1.1.0**；DeepSeek Harness（DSH）**0.1.7 到 0.2.0**（在 0.1.7-rc.2 和 0.2.0-rc.2 上测过）。
>
> **写给谁**：一个能执行命令、正在替别人安装 wechat-clawbot 的 AI agent。人看也一样适用。
> README 讲「它是什么、怎么用」，这份讲「怎么装好、怎么验收、出了问题怎么查」。
> 文中的每个症状都真实出现过，不是推测。

---

## 先记住：失败往往是静默的

从 DSH 0.1.7 起，插件出问题时 DSH 不会退出，也不会弹错：

- 插件导入失败：启动时只打一行 `dsh: warning: N entries did not activate`，DSH 照常运行，只是这个插件不在了。
- 插件版本不在 DSH 允许的范围内：整个插件被跳过，只有一行 `skipping profile bundle "wechat-clawbot": … incompatible with dsh …`。
- 浏览器端缺服务：整个网页只剩一行「Failed to load plugins」。

网页能打开、模型能用、进程的退出码也正常，**唯独微信那头没反应**。所以不要凭「看起来正常」下结论，装完一定按[第 4 节的验收清单](#4-验收清单)逐项确认。

**日志在哪**：插件的日志写在 DSH 进程的标准输出和标准错误里。在终端里运行 `dsh web` 的，就在那个终端；用启动器托管的，看启动器写的日志文件（例如 dsh-whale 写在 `~/.dsh/logs/dsh-web.out.log` 和 `dsh-web.err.log`）。DSH 启动失败时还会自己写一份诊断：`~/.dsh/logs/startup-*.log`。注意：DSH 内部框架（cordis）的错误在 web 模式下不会打印出来，所以「failed to import」后面通常看不到原因，要去 startup 日志里找。

---

## 1. 动手之前

| 检查项 | 怎么查 | 不满足会怎样 |
|---|---|---|
| DSH 版本 | `dsh --version` | 需要 **0.1.7 到 0.2.0**。插件声明的范围是 `^0.1.7-rc.1 \|\| ^0.2.0-rc.1`，不在范围内会被整个跳过（见上一节）。0.1.5 及更早：浏览器端整页白屏。**0.2.1 的预览版**：插件能加载，但 bot 无法设定时提醒，见[已知问题](#已知问题) |
| Node.js | `node --version` | 需要 22 或更高 |
| pnpm | `pnpm --version` | `dsh plugin add` 用 pnpm 安装 |
| 手机微信 | 微信 → 设置 → 插件 | 要能看到官方的「**微信ClawBot**」插件；第一次扫码时可能会提示升级微信 |
| 一台常开的电脑 | — | bot 只在 DSH 运行时在线 |

如果你同时还要升级 DSH，**先读[第 8 节](#8-升级-dsh)再动手**，有几次升级的顺序会影响设置和提醒能不能保住。

---

## 2. 安装

```bash
dsh plugin --profile web add wechat-clawbot
```

也可以在 DSH 网页侧边栏的「插件」→「添加插件」里搜 `wechat-clawbot`（插件页会自动测速，选择更快的 npm 镜像）。要固定版本就写 `wechat-clawbot@1.1.0`。

装完**重启一次 DSH**：插件的服务端代码只在启动时加载。

---

## 3. 绑定微信（必须由本人完成）

```bash
npx -y -p wechat-clawbot clawbot login
```

终端里会出现一个二维码，**让用户本人**用微信「扫一扫」扫码并确认。不要替用户扫码，也不要接触对方的凭据。绑定信息保存在 `~/.dsh/clawbot/accounts/`。

正在运行的 DSH 会自动发现新绑定的账号，并开启一个对话，不用重启。日志里会依次出现：

```
startMonitor: monitoring account=…
monitor started baseUrl=https://ilinkai.weixin.qq.com
```

如果看到下面这一行，说明还没绑定成功：

```
startMonitor: no bound account; waiting for `clawbot login`
```

其他命令（同样加 `npx -y -p wechat-clawbot` 前缀）：`clawbot status` 查看绑定的是谁，`clawbot logout` 解除绑定。

默认**只有扫码的那个人**能给 bot 发消息，其他人的消息会被直接忽略。要加人，在设置卡片的「允许给 bot 发消息的人」里填对方的微信用户 id。

---

## 4. 验收清单

全部满足才算装好。最后两项不能省：前面全部正常、一发消息却不通的情况真实发生过。

| 检查项 | 怎么查 | 期望结果 |
|---|---|---|
| 服务在运行 | `lsof -nP -iTCP:3080 -sTCP:LISTEN`（默认端口 3080） | 有一行 LISTEN |
| 插件已激活 | 日志里搜 `did not activate`、`failed to import`、`incompatible with dsh` | 都搜不到 |
| 插件页状态 | 网页「插件」→ wechat-clawbot | 两个组件都是「运行中」 |
| 只有一个实例 | 日志里的 `clawbot instance #N active` | 当前只有一个；改过要重启的设置后会出现更大的编号和 `superseded by instance #N`，属于正常 |
| 微信通道已连接 | 日志里的 `monitor started baseUrl=https://ilinkai.weixin.qq.com` | 有这一行 |
| 网页能加载 | 用带 token 的地址打开（见下） | 不是「Failed to load plugins」 |
| 设置卡片可用 | 「插件」→ wechat-clawbot → 微信 Bot | 卡片能展开，字段能修改 |
| **真实发一条消息** | 让用户在微信里发「在吗」 | **几秒内收到回复** |
| **真实设一个提醒** | 让用户设一个两分钟后的提醒 | **提醒出现在微信里**，而不只是出现在网页里 |
| DSH 会话能发微信（可选） | 在任意一个网页会话里说「用 notify_wechat 给我发条微信：测试」 | 微信里收到这条消息。这一步会用一次模型 |

**网页地址**：固定是 `http://127.0.0.1:3080`，但每次启动 DSH 都会生成新的 token，启动输出里有一行完整地址：

```bash
grep -o 'http://127.0.0.1:3080/?token=[A-Za-z0-9_-]*' ~/.dsh/logs/dsh-web.out.log | tail -1
```

（这是 dsh-whale 写日志的位置；直接在终端运行的，去终端输出里找。）不带 token 打开只会看到一行 401 文本，这不是故障；用 token 登录一次后，30 天内都不用再带。

**startup 日志里有 `EADDRINUSE` 不一定是故障**：守护程序重启 DSH 时偶尔会同时拉起两个进程，一个占到端口，另一个写下这份诊断后退出。判断服务是否在运行，看端口。

---

## 5. 配置

**配置只有一个文件**：`~/.dsh/profiles/<profile>/cordis.patch.yml`，本插件对应其中的 `- id: clawbot` 块。设置卡片里的修改也会写回这个文件。DSH 写回时可能删掉注释、调整字段顺序，所以手动修改前先看一眼当前内容，再做精确替换。

| 字段 | 在哪里改 | 什么时候生效 |
|---|---|---|
| 模型（provider、模型、思考等级）、允许发消息的人、图片相关四项、发文件预告阈值、emoji、审批等待超时、日志级别、拉活 Claude 会话的权限、开放 MCP 桥、空闲时整理对话、说明文件开关 | 网页「插件」→ wechat-clawbot → 微信 Bot | **立即生效**，微信连接不中断。日志：`设置已即时生效 […](没有重启,微信监听未中断)` |
| `autoMemory`（自动记忆，默认开） | 只能手改配置文件 | 立即生效（下一条消息） |
| `codexPeer`（Codex 会话联动，默认关） | 设置卡片或配置文件 | **会重启微信监听**（几秒） |
| `sessionId`、`cwd`、`autoStart`、`forwardQuestions`、`apiBaseUrl`、`botAgent`、`codexTransport`、`codexSocket`、`codexBinary` | 只能手改配置文件 | **会重启微信监听**（几秒） |

改过的字段在卡片上会标「已覆盖」，旁边有「重置」。

关于「重启微信监听」：DSH 会在进程内重新加载插件。从 0.9.10 起，新实例会先停掉旧实例再开始监听，日志里能看到 `superseded by instance #N`。0.9.9 及更早没有这层保护，改一次这类设置就可能多出一份 bot，症状见[速查表](#9-症状速查)。

---

## 6. 要跟用户讲清楚的几个功能

### 自动记忆（`autoMemory`，默认开）

看起来像长期事实的短消息（「我住在…」「我不喝咖啡」），会原文交给**同一个模型**再判断一次：值不值得写进长期记忆。

- **数据去向**：就是这个对话本来使用的模型，不会发给其他服务商。
- **代价**：每条被选中的消息多一次模型请求。便宜的模型可以忽略；如果用户把 bot 挂在很贵的模型上，值得提醒一句。
- **一次性提醒不会进记忆**：「明天十点开会」这类内容归定时提醒管。长期记忆每一轮都会整份放进系统提示词，过期的提醒会误导模型推算日期。
- **怎么关**：在 `- id: clawbot` 块里加一行 `autoMemory: false`，保存后下一条消息生效。设置卡片上没有这个开关。关掉后，模型仍然可以主动调用 `remember_user_info` 记东西。

装完一定要告诉用户这个功能是开着的、它做什么；关不关由用户决定。

### 连着发的几条会一起回复

参照 Claude Code 处理「它干活时你又发了消息」的两种方式：回车是等这一步做完再看，Ctrl+Enter 是立刻打断重来。bot 按当时在做什么分开处理，不让对方多等：

- **图片和文件马上处理**，不会先等后面那句话。
- **bot 还在第一次思考，没回复、也没调用任何工具**：立刻打断，带上新消息重新想，一次回复。同一条消息最多这样重来 3 次。定时提醒、网页里发的消息那一轮不会被打断。
- **bot 已经开始干活**（读文件、搜索、跑命令）：不打断正在跑的工具；这一步做完，下一步就能看到新消息。
- **bot 要发回复，而对方又补充了它还没读到的内容**：这条回复先不发（日志 `reply held`），读完再合在一起回。对方如果还有图片或文件正在下载，先等它到，最多等 8 秒。每轮最多这样等 3 次。
- **bot 已经回复过**：新消息算接着聊，另外回复。
- **bot 还没开始处理上一条**（比如正在空闲整理对话）：新消息直接并进上一条。
- **某一轮出错中断**：在那一轮里并进去、还没被读到的消息会被拿出来重新回复，不会一直等到对方再发消息。

日志里对应的几行：`restarting the turn to answer both together`、`steering message … (to be answered together)`、`reply held (1/3)`、`merged this one into it`、`a message was still unread after the turn; answering it now`。

### 发不出去的消息会存着，下次一起补发

微信只允许 bot 在用户最后一条消息之后的一段时间里主动发消息（实测约 24 小时）。超过这段时间，定时提醒、Claude Code / Codex 发来的通知都会被微信拒收，日志里是 `sendMessage ret=-2 errmsg=prepare failed`。

这些消息不会丢：

- 先存在 `~/.dsh/clawbot/backlog.json`，重启 DSH 也还在；
- 用户下次发消息时，bot **先回复那条消息**，然后把存着的合并成一条补发（特别长时按条目分成几段）：开头一句说明原因，按时间顺序列出，每段标明原定送达的时间，定时提醒标的是它原定的时间；
- Claude / Codex 的通知只保留一句话（发送方可以用 `summary` 参数自己给一句，不给就取第一句）；
- 图片和文件在合并消息里注明，随后单独补发；文件已经不在了也会注明。补发失败时：超过微信大小上限的直接放弃，其他原因（网络、窗口又关了）留到下次再传（合并消息里只预告一次），最多试 3 次；放弃时会单独发一句告诉对方。

日志里对应的两行：`backlog: WeChat will not let the bot write first now; kept a … until they write again`、`backlog: sent N kept message(s) to … after answering them`。

### 空闲时整理对话（`idleCompaction`，默认开）

对话越长，每条消息要带的上下文越多，越慢也越贵。开着这个功能时，bot 回复完、安静 10 分钟后，如果上下文已经接近 DSH 自动压缩的门槛（超过 85%），就调用 DSH 自带的 `/compact`，把旧对话整理成摘要。用户下一条消息来时不用再等压缩。

启动日志里有一行自检：`idle-compact: /compact 可用; …`。关掉后只剩 DSH 在回复前压缩，那一条回复会多等十几秒。

### 工作目录的说明文件（`workspaceInstructions`，默认开）

DSH 的默认行为：bot 在哪个项目里干过活，那里的 AGENTS.md / CLAUDE.md 就会被放进对话；之后文件每改一次，再放一整份。说明文件又长又经常改的话，会白白占掉大量 token。

关掉后，这些文件不再自动进入微信对话（网页里的对话不受影响），需要时 bot 可以自己去读。被拦下时日志会写：`workspace-instructions: kept … out of the WeChat session`。

### Codex 会话联动（`codexPeer`，默认关）

打开后，bot 可以列出 Codex 项目和对话、读取历史、转发消息、查询进度。代价是每次请求多带 5 个工具，大约 1k token。改动会重启微信监听，日志里的 `ensureTools: WeChat tools registered (Codex tools on)` 说明已经生效。

- 默认的 `socket` 模式需要一个正在运行的共享 Codex App Server；**桌面版 Codex 自己的服务是私有的，外部接不进去**。
- `stdio` 模式由插件自己启动 Codex，可以读取历史、续接没有在运行的对话，目前还是实验功能：转到微信的审批提示不完整，只建议在只有用户本人能给 bot 发消息时使用。
- 反方向（Codex 读取微信对话、给用户发微信）要把包里的 `clawbot-mcp` 注册到 Codex。在 Codex 默认的审批设置下，「驱动 DSH 对话」和「发微信」两个工具每次调用前都会征求同意。

具体配置见 README 的「和 Codex 联动」一节。

### DSH 会话联动（DSH 内部桥，1.1.0 起）

bot 能看到同一个 DSH 里的其他会话，范围是所有工作目录，不只某一个文件夹：

- `list_dsh_sessions`：列出会话的标题、所在文件夹、创建时间，以及是否正在运行。
- `read_dsh_session`：读某个会话最近的消息。
- `send_to_dsh_session`：往某个会话里捎一句话。没开着的会话会先被唤醒，和在网页里打开它一样。回答留在网页里，不会发到微信。

反过来，每个 DSH 会话都多了一个工具 `notify_wechat`，可以给用户发微信，比如「这个任务做完给我发个微信」。

- **全局生效**：所有 DSH 会话都有，不用按文件夹配置，DSH 内部也不需要 MCP。
- **微信会话自己没有**：它直接回复就行。
- **发不出去时**：用户一段时间没给 bot 发消息、微信不让 bot 主动发时，这条消息会存着，下次一起补发，并注明是哪个会话发的。
- **bot 能看到**：bot 自己的对话里也会出现一份，用户可以直接回复。

Claude Code 和 Codex 走的是另一条路：本机 HTTP 接口加 MCP server，见下一节。

### Claude Code 联动

bot 可以查看 Claude Code 会话在做什么，也可以给某个会话捎一句话；已经关掉的会话会在后台重新接上。这需要本机装有 `claude` 命令行，并且**保持更新**：它不会跟着桌面版一起升级，版本太旧时会因为不支持当前模型而直接报错，运行 `claude update` 即可。

1.1.0 起，插件会自动选用本机版本最新的 `claude`。为了捎话被拉到后台的会话，处理完会自动停掉、交还给桌面版。处理期间桌面版暂时打不开它，急用就在终端运行 `claude stop <会话 id 前 8 位>`。

插件还在本机开了一组 HTTP 接口，配合 MCP server 让 Claude Code 反过来读写 DSH 对话、给用户发微信。接口只监听本机，并且每个请求都要令牌。不需要的话，在设置卡片里关掉「开放 MCP 桥（Claude / Codex）」。

### DSH 的 Session Log 上传（DSH 自己的设置，跟本插件无关，但用户应该知道）

DSH「设置 → 通用设置」里有一项「在使用官方模型 API 时上传 Session Log」，默认开。开着时，每次调用 DeepSeek 官方 API 都会附带该对话还没上传过的那部分日志，累计下来就是整份对话，包括工具调用和结果。bot 使用 DeepSeek 官方模型时，整段微信对话都在其中；即使 bot 换成了别家模型，插件派出的子任务仍然固定使用 DeepSeek 官方模型，交给子任务的那部分内容也会上传。用户介意的话可以关掉；注意关闭期间的内容会在重新打开时一次性补传。

---

## 7. 模型与成本

- **选模型**：在设置卡片里给 bot 固定一个模型，这样用户在网页里换模型不会影响 bot。留空就跟随 DSH 的全局默认。
- **思考等级**：日常聊天用 `low` 就够。用到定时提醒时不建议完全关闭思考：关掉后，模型容易照抄历史消息里的日期，把提醒设到过去。
- **花销从哪来**：模型接口是无状态的，每次调用都要把系统提示词、工具说明和对话历史整份重发一遍；一条微信通常要调用 2 到 4 次模型。固定开销（系统提示词加工具说明）约 1.8 万 token。好在大部分内容能命中缓存（实测约 85%）。上下文会随对话增长，再被空闲整理压回去；作者的配置下，一般在 3.5 万到 20 万 token 之间。
- **作者的实际数据**：使用 gpt-6-luna 时，一条微信的平均成本约 $0.005–0.007，每天 7 条左右、一个月约 $1.4。

**不要往系统提示词里放每次都会变的内容**（带秒的时钟、随机 id、计数器）。支持前缀缓存的模型会从变化的那个字符开始整段按未命中计价；DSH 的「in-history」模式下更糟，每变一次就把整份提示词追加进历史。插件的系统提示词在一天之内逐字节不变，时间信息放在每条入站消息里（`[微信消息 MM-DD HH:mm]`）。

---

## 8. 升级 DSH

**总原则**：先把 wechat-clawbot 升到最新版，再切换 DSH。1.1.0 已经覆盖下面所有版本的要求。切换后照[第 4 节](#4-验收清单)重新验收一遍。

用 npx 运行 DSH 时，每个版本装在单独的缓存目录里，旧目录留着就是回滚的退路。

### 从 0.1.5 升到 0.1.7：顺序决定设置会不会丢

0.1.7 不再使用 `~/.dsh/settings.yaml`，配置统一存进 `cordis.patch.yml`。第一次启动 0.1.7 时，DSH 会把 settings.yaml **单向导入**进来，然后把原文件改名为 `settings.yaml.imported`。导入规则很严格，被拒绝的部分只记一条警告，终端里看不到：

1. **段名必须等于插件的 entry id**。本插件是 `clawbot`，正好对得上。
2. **这一段的每个字段都必须是「改完立即生效」的那一类**，只要有一个不是，整段丢弃。如果用户曾经手写过 `sessionId`、`apiBaseUrl`、`autoStart` 这类字段，先把它们挪进 `cordis.patch.yml` 的 `- id: clawbot` 块。
3. **第一次启动 0.1.7 时，插件必须已经是 0.9.4 或更新**。否则插件导入失败，整段设置被丢，bot 会退回默认模型，白名单和图片设置也都没了。

正确顺序：

```bash
# ① 备份（回滚到 0.1.5 时要用）
cp ~/.dsh/settings.yaml ~/.dsh/settings.yaml.bak-pre-017
cp ~/.dsh/profiles/web/cordis.patch.yml ~/.dsh/profiles/web/cordis.patch.yml.bak-pre-017

# ② 安装 0.1.7，但先不要启动
npx -y @deepseek-ai/dsh@0.1.7-rc.2 --version

# ③ 先把插件升级
dsh plugin --profile web add wechat-clawbot@latest
```

④ 然后才第一次启动 0.1.7。启动后确认 `~/.dsh/settings.yaml.imported` 存在，并且 `cordis.patch.yml` 的 `- id: clawbot` 块里能看到原来的模型、白名单等设置。

常一起安装的第三方插件：`dsh-plugin-marketplace` 0.3.4 会让整页白屏（0.1.7 自带的插件页已经能代替它，在配置里加 `disabled: true` 禁用）；`@deepseek-ai/dsh-subagent-acp` 要升到和 DSH 同号的版本。对话历史会自动从 v3 格式转成 v4，原文件保留，回滚是安全的。

### 从 0.1.7-rc.1 升到 rc.2：定时提醒换了存储位置

rc.2 把定时提醒从对话历史搬进了 DSH 自己的任务表（`~/.dsh/storages/schedule.json`），而且**不会迁移旧提醒**：bot 以前确认过的提醒到点不响，也不报错。

wechat-clawbot 0.9.6 起，第一次在 rc.2 上启动时，会把微信对话里还没响的提醒自动搬过去，每条在日志里写一行：

```
legacy reminder schedule-7 carried over as schedule-3f2a9c1e-… (due 2026-10-01T13:00:00.000Z)
```

搬过的记录保存在 `~/.dsh/clawbot/schedule-migration.json`，重启不会重复搬。过期超过一天的不搬；过期不到一天的，会在一分钟后补发。之后每次启动，DSH 都会打一行 `contains legacy reminders; recreate active reminders with schedule_create`，这是固定提示，看到过 `carried over` 就不用管。

其他变化：

- `@deepseek-ai/dsh-subagent-acp` 必须和 DSH 版本完全一致，差一个 rc 就会被禁用（日志：`disabling profile plugin row "subagent-acp-claude"`），回滚时也要一起退回。
- 本插件自带一行 `schedule` 配置，**不要**在 profile 里再加一行。
- 回滚到 rc.1 的副作用：已经在 rc.2 上响过的提醒，rc.1 会再补发一次；在 rc.2 上新设的提醒，rc.1 看不到。

### 从 0.1.7-rc.2 升到 0.2.0：版本门禁

0.2.0 不改对话格式，也不迁移任何数据（回滚只要换回旧版 DSH），但它的**版本门禁**会跳过所有声明范围只到 `^0.1.x` 的插件。

1. 本插件要 0.9.7 或更新（1.x 的声明范围同时覆盖 0.1.7 和 0.2.0，回滚也能用）。
2. `@deepseek-ai/dsh-subagent-acp` 升到同号的 `0.2.0-rc.2`。
3. 上游还没放宽范围的第三方插件，确认它们在 0.2.0 上能正常工作后，可以用 **0.2.0 版的 dsh**（旧版会拒绝）给那个精确版本授权：
   ```bash
   npx -y @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile web allow-version <包名>@<版本> --dsh-version 0.2.0-rc.2 --accept-risk
   ```
   授权保存在 `~/.dsh/profiles/<profile>/compatibility.json`，只对「这个插件版本 × 这个 DSH 版本」有效；任何一方升级后都要重新授权。`dsh-plugin-marketplace` 0.3.3 **不要**授权，它依赖已删除的接口，启用后整页卡住。
4. 0.2.0 的插件页「官方」里有一个实验性的「自动化任务」，打开它会再加一行 `schedule`：开着没关系，但**不要单独关掉其中的「任务调度」**，那会连微信提醒一起关掉；其中的「时间感知」建议关掉，微信消息自带时间戳，它反而会让 bot 追问时区。

### 已知问题

- **DSH 0.2.1 预览版（截至 0.2.1-alpha.2）**：设定时提醒的工具（`schedule_create` 等）从 `@deepseek-ai/dsh-schedule` 挪到了新包 `@deepseek-ai/dsh-tool-schedule`，而 wechat-clawbot 1.1.0 只加载前者。插件本身能正常加载，但 bot **无法设定时提醒**，而且不会报错。在 wechat-clawbot 适配之前，请继续使用 0.2.0。

---

## 9. 症状速查

| 症状 | 原因与处理 |
|---|---|
| 日志 `N entries did not activate` 加 `clawbot (…): failed to import` | 插件太旧，用到了当前 DSH 已经删除的接口。升到最新版 |
| 日志 `skipping profile bundle "wechat-clawbot": … incompatible with dsh …` | 版本门禁：插件声明的范围不包含当前 DSH 版本。1.1.0 支持 0.1.7 到 0.2.0；DSH 更旧或更新时要先换 DSH 版本 |
| 网页只剩「Failed to load plugins」，下面列着 `pending (waiting for service: X)` | 某个插件（不一定是本插件）的浏览器端依赖了当前版本没有的服务 X。升级或禁用那个插件 |
| 网页只有一行 401 文本 | 打开时没带 token，不是故障，见第 4 节 |
| `POST` 某个接口回 405 | 那条路由根本没有注册（401 才是「路由在，但没通过认证」） |
| 升级 DSH 后模型不对、白名单没了、设置全部回到默认 | settings.yaml 导入时被整段拒绝（第 8 节第一小节）。从 `settings.yaml.imported` 里把值抄进 `cordis.patch.yml` |
| bot 收到消息但不回复 | 模型只输出了文字，没有调用 `send_wechat_text`。在本插件里，纯文字输出永远不会发到微信 |
| 同一条消息被回答两三遍，或者回复完了还一直显示「正在输入」 | 0.9.9 及更早：改过需要重启微信监听的设置后，多出了几份 bot 同时在运行。升到 0.9.10 或更新，再重启一次 DSH。判断方法：网络抖动时，同一毫秒有几行 `getUpdates: POST fetch failed`，就有几份 |
| 回复送达后「正在输入」还要过几秒才消失 | 0.9.10 及更早的行为。1.0.0 在回复送达时立刻收起 |
| 回复很慢（20 秒以上） | 多半在连续搜网或抓网页；也可能是上下文太大，或者 DSH 正在回复前压缩（打开「空闲时整理对话」） |
| 定时提醒只出现在网页里，没发到微信 | 插件太旧（早于 0.9.4），识别不了 0.1.7 的新对话格式。升级插件 |
| 升到 0.1.7-rc.2 后，之前设好的提醒到点不响 | 插件早于 0.9.6，rc.2 不迁移旧提醒。升级插件并重启一次，日志里应出现 `carried over` |
| 日志 `contains legacy reminders; recreate active reminders with schedule_create` | rc.2 的固定提示，每次启动都会打。看到过 `carried over` 就没事 |
| 日志 `disabling profile plugin row "subagent-acp-claude"` | `dsh-subagent-acp` 和 DSH 版本不一致。升到同号版本 |
| 定时提醒迟到 | 电脑睡眠了。提醒的计时器在 DSH 进程里，进程被冻结就不会响，唤醒后才补发 |
| 提醒或通知到点没收到，日志 `sendMessage ret=-2 errmsg=prepare failed` | 用户有一段时间（约 24 小时）没给 bot 发消息，微信不让 bot 主动发。消息已经存着，用户下次发消息、bot 回复之后会合并补发，见第 6 节 |
| 在 DSH 0.2.1 预览版上 bot 设不了提醒 | 见[已知问题](#已知问题) |
| Codex 工具报「Cannot connect to the shared Codex App Server」 | `socket` 模式找不到共享服务（桌面版的服务是私有的）。见第 6 节的 Codex 部分 |
| 让 bot 给 Claude Code 会话捎话失败，报模型不受支持 | `claude` 命令行太旧，运行 `claude update` |
| 桌面版打不开某个 Claude Code 会话，提示 Claude Code crashed | bot 刚把它拉到后台处理捎去的话，处理完会自动交还；急用就运行 `claude stop <会话 id 前 8 位>` |
| 网页里的 DSH 会话说没有 `notify_wechat` 工具 | 插件早于 1.1.0，或者升级后还没重启 DSH |

---

## 10. 给 agent 的四条纪律

1. **不要替用户输入密码、扫码或填写验证码**：绑定微信、`npm login`、两步验证都由本人完成。
2. **自动记忆默认开着**，装完要告诉用户它做什么，关不关由用户决定；不要擅自关掉，也不要不提。
3. **不要把用户的 API key 复制到任何新文件里**；需要时在运行时从 `~/.dsh/.credentials.yaml` 读取。
4. **改完配置一定要验证真实路径**：真实发一条消息、真实设一个提醒。这个插件历史上一半的故障都是「看起来全对，一发消息就不通」，而从 DSH 0.1.7 起，失败大多是静默的。
