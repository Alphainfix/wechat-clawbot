# wechat-clawbot 安装手册（写给替用户装这个插件的 AI 看）

> **适用于：`wechat-clawbot` 0.9.6 + DeepSeek Harness（DSH）≥ 0.1.7（含 0.1.7-rc.2）。**
>
> 读者假设：你是一个能跑命令的 agent，正在替某个人把 `wechat-clawbot` 装进他的 DSH。
> README 讲的是「这插件是什么」，这份讲的是「怎么装成，以及装不成时那个报错到底在说什么」。
>
> 每一条症状都是真出过的，不是设想出来的。

---

## 最重要的一句话：0.1.7 上，出问题是**静默**的

DSH 0.1.5 时代，一个插件导入失败会让整个 `dsh` exit(1)——很吵，但一眼就看见。
**0.1.7 改成了宽容模式**：失败的插件只在启动时打一行

```
dsh: warning: N entries did not activate
clawbot (…): failed to import
```

然后 DSH **照常运行**，只是那个插件不在了。网页照开、模型照用，**微信那头就是没反应**。
浏览器那半边更狠：任何一个插件在 `inject` 里写了不存在的服务，整页卡在
「Failed to load plugins」。

所以**别看 exit code**（永远是好的），要看下面第 4、5 步的那几样东西。

---

## 0. 先确认两件事，再动手

| 要确认的 | 怎么查 | 不满足会怎样 |
|---|---|---|
| DSH 版本 | `npx @deepseek-ai/dsh --version` | **需要 ≥ 0.1.7**。插件的 peerDependencies 写的是 `^0.1.7-rc.1`，0.1.7 的**版本门禁**会拿运行时版本去比，不满足就把插件禁用（日志：`Plugin … is incompatible with dsh …`）。装在 0.1.5 上则是浏览器端找不到 `configForms`、整页白屏 |
| 包管理器 | `pnpm --version` | `dsh plugin add` 走 pnpm |

如果用户**已经在 0.1.5 上用着这个插件**，要升 DSH，**先看第 2 节**——顺序错了会丢设置。

---

## 1. 装

两种方式，效果一样：

```bash
dsh plugin --profile web add wechat-clawbot
```

或者在网页侧边栏 **「插件」→「添加插件」** 里填 `wechat-clawbot`（0.1.7 自带的插件管理页，会自动测速选 npmmirror 镜像）。

装完重启一次 DSH（服务端代码要重启才加载）。

---

## 2. 从 DSH 0.1.5 升级上来的：顺序决定设置会不会丢

0.1.7 **退役了 `~/.dsh/settings.yaml`**，配置统一存进 profile 的
`~/.dsh/profiles/<profile>/cordis.patch.yml`。第一次启动 0.1.7 时，宿主把 settings.yaml
**单向导入**进 patch，然后把原文件改名成 `settings.yaml.imported`。导入规则很硬，而且
**被拒的段落只写一行 warn、stderr 里什么都看不到**：

1. **段名必须等于插件的 entry id。** 本插件的 entry id 是 `clawbot`，段名 `clawbot:` 正好对得上。
   （别的插件未必——用 `dsh --profile web --dump-config` 看每个 entry 的 `id:`。）
2. **该段的每个字段都必须是插件声明的「热字段」（`.volatile()`）**，有一个不是，整段丢弃。
   0.9.4 把所有能在设置卡片里改的字段都标成了 volatile；但如果用户**手写**过冷字段
   （`sessionId`、`apiBaseUrl`、`autoStart` 这类）到 settings.yaml 的 `clawbot:` 段里，
   那一段就会整段被拒——先把冷字段挪进 cordis.patch.yml 的 `- id: clawbot` 块。
3. **导入发生在插件加载完之后，所以插件必须先是 0.9.4。** 如果第一次启动 0.1.7 时插件
   还是 0.9.3（它 import 了 0.1.7 已删除的 `installSettingsSection`，会导入失败），
   `clawbot` 这个 entry 就没有可配置的 schema，**整段设置被丢**，bot 会退回默认模型、
   丢掉白名单、图片参数等全部设置。

所以顺序是：

```bash
# ① 备份（0.1.5 读 settings.yaml，回滚要用）
cp ~/.dsh/settings.yaml ~/.dsh/settings.yaml.bak-pre-017
cp ~/.dsh/profiles/web/cordis.patch.yml ~/.dsh/profiles/web/cordis.patch.yml.bak-pre-017
```

```bash
# ② 装 0.1.7，但先别启动（npx 会装进一个新的缓存目录，旧的留着当回滚）
npx -y @deepseek-ai/dsh@0.1.7-rc.1 --version
```

```bash
# ③ 先把插件升到 0.9.4
dsh plugin --profile web add wechat-clawbot@0.9.4
```

④ 然后才第一次启动 0.1.7。启动后确认：

```bash
ls ~/.dsh/settings.yaml.imported          # 有 = 导入发生了
grep -A12 '^- id: clawbot' ~/.dsh/profiles/web/cordis.patch.yml   # 能看到 provider / model 等字段
```

日志里出现 `设置已即时生效 […](没有重启,微信监听未中断)` 就是导入的值被插件吃进去了。

**另外两个 0.1.7 上已知不兼容的第三方插件**（不是本插件的问题，但常一起装）：
- `dsh-plugin-marketplace`（含最新的 0.3.4）会让整页白屏。0.1.7 自带的插件页已经覆盖它的功能，
  在 cordis.patch.yml 里加 `- id: plugin-marketplace` / `disabled: true` 禁用即可。
- `@deepseek-ai/dsh-subagent-acp` 要升到 `0.1.7-rc.1`，旧版会被版本门禁禁用。

**会话历史不用管**：0.1.7 会把 v3 会话转成 v4（生成一个新的 `session.v4.jsonl.zstd`），
v3 原件不动，回滚安全。实测一个 1200 多条事件的会话，每类事件数量完全一致。

### 从 0.1.7-rc.1 升到 rc.2：**先把插件升到 0.9.6**，否则已经设好的提醒会静默失效

rc.2 把定时提醒从「会话历史」搬进了宿主自己的任务表（`$DSH_HOME/storages/schedule.json`），
而且**明确不迁移旧的**：宿主只在日志里打一行
`schedule: Session "wechat-main" contains legacy reminders; recreate active reminders with schedule_create.`
——bot 当初确认过的提醒，到点就是不响，没有任何报错。

0.9.6 在 rc.2 下第一次启动时，会把微信会话里还没响的提醒**自动搬一次**（绑回原会话，
不唤醒它）。日志里每条一行：

```
legacy reminder schedule-7 carried over as schedule-3f2a9c1e-… (due 2026-10-01T13:00:00.000Z)
```

状态目录里的 `schedule-migration.json` 记着搬过哪些，重启不会重复；用户之后在新任务表里
删掉的，也不会被再搬回来。过期超过一天的不搬（日志里会说原因），过期一天以内的一分钟后补发
（和旧版「下次启动补发」的行为一致）。宿主那行 `contains legacy reminders` 之后**每次启动都会打**，
是固定提示，看到 `carried over` 就不用管它。

其他几处 rc.2 的变化：
- `@deepseek-ai/dsh-subagent-acp` 要升到 **`0.1.7-rc.2`**：它的 peerDependencies 是**精确**锁版本的，
  跟宿主差一个 rc 就被版本门禁禁用（日志 `disabling profile plugin row "subagent-acp-claude" … incompatible`）。
  **回滚到 rc.1 时也要把它一起退回 `0.1.7-rc.1`**。
- 网页端默认**关掉**了 `schedule` / `time-context` / 任务页 `ui-schedule`。本插件自带的那行会把
  `schedule` 重新打开（插件页里 wechat-clawbot 下面会列出 `@deepseek-ai/dsh-schedule`「运行中」），
  **不要**再在 profile 里自己 insert 一行 `schedule`。任务页默认仍是关的。
- provider 多了一个 `deepseek-account`（DeepSeek 账号登录那条），正常情况下是 **10 个**。
- 回滚到 rc.1 的副作用：已经搬过去、并且在 rc.2 上响过的提醒，rc.1 看会话历史会以为它们还没响，
  **会再补发一次**；在 rc.2 上新设的提醒 rc.1 看不见。

---

## 3. 配置在哪（0.1.7）

**唯一的配置文件是 `~/.dsh/profiles/<profile>/cordis.patch.yml`**，本插件是其中的 `- id: clawbot` 块。

| 字段 | 在哪改 | 改完要不要重启 |
|---|---|---|
| **热字段**：模型（provider / model / 思考等级）、白名单、图片参数、emoji、日志级别、Claude 桥开关等 | 网页侧边栏 **「插件」→ wechat-clawbot → 微信 Bot** 卡片 | **不用**。宿主就地提交，微信连接不中断 |
| **冷字段**：`sessionId`、`autoStart`、`apiBaseUrl`、`cwd`、`forwardQuestions`、`botAgent` | 手改 cordis.patch.yml | 要。改冷字段宿主会自动重启这个插件 |
| `autoMemory`（**默认开**） | 要关的话手改 cordis.patch.yml（卡片上没有这个开关，见第 8 节） | 不用（它是热字段，文件保存后下一条消息生效） |

改过的字段在卡片上会显示「已覆盖」，旁边有「重置」。

---

## 4. 启动之后：看这两样，别看 exit code

```bash
# 有没有插件没激活（0.1.7 的失败只会在这里出现）
grep -a 'did not activate\|failed to import\|incompatible with dsh\|pending (waiting' ~/.dsh/logs/*.log | tail
```

```bash
# 启动失败时宿主会写一份完整诊断（含每个缺服务的插件）
ls -t ~/.dsh/logs/startup-*.log | head -3
```

注意：cordis 自己的 error 日志在 web profile 下**不写 stderr**，所以「failed to import」
后面通常**看不到原因**。要原因的话看 startup-*.log；或者在网页「插件」页里看这个插件
是否标着「运行中」。

**`startup-*.log` 里有 `EADDRINUSE` 不一定是坏了**：守护进程重启时偶尔会同时拉起两个，
一个抢到端口、另一个写了这份诊断后退出。判断服务活没活看端口：

```bash
lsof -nP -iTCP:3080 -sTCP:LISTEN
```

---

## 5. 一定要在浏览器里真打开一次

服务端干净不代表能用：浏览器那半边是加载网页时才执行的。

```bash
# 地址固定 127.0.0.1:3080，但 URL 里的 token 每次重启都变，取当前这次的：
grep -o 'http://127.0.0.1:3080/?token=[A-Za-z0-9_-]*' ~/.dsh/logs/dsh-web.out.log | tail -1
```

- 页面只有一行 **「Failed to load plugins」**，下面列着 **`pending (waiting for service: X)`**
  → 某个插件（不一定是这个）的浏览器端在 `inject` 里写了这一版没有的服务。0.1.7 删掉的
  `settingsScope` 是最常见的 X。客户端**没有隔离**，一个插件卡住整页都出不来。
- 没带 token 的裸地址回 **401**（`dsh web authentication required`）——不是坏了，是还没换 cookie。
  换过一次之后 30 天内有效。

---

## 6. 绑定微信（一次性，要人操作）

扫码登录必须由**本人**完成，agent 不要代劳、也不要碰对方的凭据。让用户自己扫，
绑定结果落在 `~/.dsh/clawbot/accounts/`。

绑定之后默认**只有扫码的那个人**能给 bot 发消息（白名单）。要加人，在微信 Bot 卡片的
「允许给 bot 发消息的人」里填微信用户 id。

---

## 7. 选模型，以及两个会烧钱的坑

这两条不是这个插件特有的，但这个插件最容易踩，因为它每一轮都带一份完整的系统
提示词 + 工具定义（实测约 17.7k token 的固定开销）。

**坑一：提示词里放会变的东西 = 缓存全灭。**
如果提示词里有每轮都变的字符（时钟带秒、随机 id），支持前缀缓存的模型（DeepSeek
这类）会**从那个字符开始整段按未命中计价**。实测过一次：命中率 1%，一轮 29 步的
对话累计 928 万 input token，约 ¥10 一轮。

**坑二：`systemPromptUpdate: "in-history"` 之后，同一个毛病换个姿势咬人。**
那个模式下「提示词变了」不是就地改写，而是**把整份追加进历史**。时钟带秒 = 每一步
往历史里塞一份完整提示词。实测 14 轮 / 35 步塞了 35 份 24KB，上下文 519k 而真实
对话只有 54k。（DeepSeek 官方 provider 的内置目录用的是 in-history；pi-ai 这类手写
provider 默认就地改写。）

**结论**：系统提示词必须**一天之内逐字节不变**，易变的东西放最新那条消息里。这个
插件现在就是这么做的（入站消息带 `[微信消息 MM-DD HH:mm]`），你**不要**往提示词
里加时钟、计数器之类的东西。

思考档位：日常聊天用 `low` 就够（实测闲聊轮思考 0–220 token）。会用到定时提醒的话
不建议关——关了之后模型会从历史消息里抄日期，把提醒设到过去的某天。

---

## 8. `autoMemory`：默认开，要告诉用户它做了什么

**默认开**（0.9.5 起）。看起来像个人信息的短消息（"我住在…"、"我不能喝咖啡"）会被原文
**再发给同一个模型问一次**：值不值得写进长期记忆。

- **去向**：就是这个会话本来就在用的模型（走宿主 `llm` 服务、跟着本会话的路由）。
  跟对话去的是同一个地方，**不是额外的厂商**。（0.9.2 及以前是写死发到 `api.deepseek.com`，
  那才是第二个去向，所以当时默认关。）
- **代价**：每条被预筛选中的消息多一次请求。便宜的模型上可以忽略；如果用户把 bot 挂在
  很贵的模型上，值得跟他提一句。

装完要**跟用户说一声**这个功能开着、它做什么；**他不想要就让他自己关**——在 cordis.patch.yml
的 `- id: clawbot` 块里加一行 `autoMemory: false`，保存即生效（热字段，不用重启）。
卡片上没有这个开关。关掉不影响 `remember_user_info`——那是模型自己决定要记的，不经过
这个分类器。

**两条路都不收一次性提醒**（0.9.5 起）：分类器和 `remember_user_info` 最后都经过同一个
写入口，「提醒事项」分类和带「今天/明天/几分钟后」的条目一律拒收——那些归定时提醒
（`schedule_create`）管。原因：memory.md **每一轮都整份进系统提示词**，一条「明天十点开会」
第二天就是错的，还会误导模型算日期。如果从老版本升上来，memory.md 里可能攒着一个
「## 提醒事项」段，可以整段删掉（真正会响的提醒存在定时系统里，删这段不影响它们）。

---

## 9. 装完的验收清单

| 查什么 | 命令 / 位置 | 期望 |
|---|---|---|
| 服务活着 | `lsof -nP -iTCP:3080 -sTCP:LISTEN` | 有 LISTEN |
| 插件激活了 | 日志里**没有** `did not activate` / `failed to import`；网页「插件」→ wechat-clawbot 两个组件都是「运行中」 | 两个都满足 |
| 微信通道通了 | 日志里 `monitor started baseUrl=https://ilinkai.weixin.qq.com` | 有 |
| 网页能开 | 带 token 打开 | 不是「Failed to load plugins」 |
| 设置卡片在 | 「插件」→ wechat-clawbot → 微信 Bot | 卡片能展开、字段能填 |
| **真发一条微信** | 让用户发「在吗」 | **几秒内收到回复** |
| （升级的）定时提醒 | 让用户设一个两分钟后的提醒 | **提醒到了微信上**，而不只是出现在网页里 |
| （升到 rc.2 的）旧提醒搬过去了 | 日志里 `legacy reminder … carried over as …` | 每条还没响的提醒一行 |

最后两行不能省。前面全绿而一发消息就不通的情况是存在的——目录干净 ≠ 真实路径能跑。
定时提醒那一行专门针对升级：0.1.7 换了会话格式，老版本插件识别提醒的方式会**静默失效**，
表现就是提醒只在网页里回答、到不了微信，而且不报任何错。

---

## 10. 症状 → 原因速查

| 症状 | 多半是 |
|---|---|
| 日志 `N entries did not activate` + `clawbot (…): failed to import` | 插件版本太老（0.9.3 及以前 import 了 0.1.7 已删除的 API）→ 升到 0.9.4 |
| 日志 `Plugin … is incompatible with dsh …` | 0.1.7 的版本门禁：插件 peerDependencies 的范围不含当前 DSH 版本 → 升级那个插件 |
| 网页整页「Failed to load plugins」+ `pending (waiting for service: X)` | 某个插件浏览器端硬依赖了这一版没有的服务 X（常见 `settingsScope`）→ 升级或禁用那个插件 |
| 升级 DSH 后 bot 用的模型不对 / 白名单没了 / 设置全回默认 | settings.yaml 导入时 `clawbot:` 段被整段拒了（第 2 节的三条规则）→ 从 `settings.yaml.imported` 里把值抄进 cordis.patch.yml |
| 网页一行 401 文本 | 没带 token（第 5 步），不是坏了 |
| `POST /<路径>` 回 **405** | 那条路由**根本没注册**（不是没权限）。401 才是「路由在、没过鉴权」 |
| bot 收到消息但不回 | 看它是不是只输出了文本没调 `send_wechat_text`——这个插件里**纯文本输出永远不会到达微信** |
| bot 回复很慢（20 秒+） | 多半在连着搜网 / 抓页面；也可能是上下文被撑大了（见第 7 步） |
| 定时提醒只在网页里出现、没到微信 | 插件太老（见第 9 节最后一行）→ 升到 0.9.4 |
| 升到 rc.2 之后，之前设好的提醒到点不响 | 插件还是 0.9.5 或更老：rc.2 不迁移旧提醒 → 升到 0.9.6 重启一次，日志里应出现 `carried over` |
| 日志 `contains legacy reminders; recreate active reminders with schedule_create` | rc.2 宿主的固定提示，每次载入都打。下面跟着 `carried over`（或 marker 里已记过）就没事 |
| 日志 `disabling profile plugin row "subagent-acp-claude"` | `dsh-subagent-acp` 版本跟宿主差了一个 rc → 升到和宿主同号 |
| 定时提醒迟到 | 机器睡着了。提醒的定时器活在进程里，进程冻结就不会响，醒来才补发 |

---

## 11. 给 agent 的三条纪律

1. **不要替用户输密码、扫码、填 OTP。** 绑定微信、`npm login`、2FA 验证码，全都
   让本人做。
2. **`autoMemory` 默认开着，装完要告诉用户**它会拿像个人信息的短消息再问一次同一个模型；
   关不关由他决定，你不要替他关、也不要瞒着不说。另外**不要把他的 key 复制到任何新文件
   里**——要用就运行时从 `~/.dsh/.credentials.yaml` 读。
3. **改完配置要验真实路径**，别停在「目录 / 设置页看着正常」。这个插件的历史故障
   里，有一半是「看着全对，一发消息就炸」。0.1.7 让这一条更重要了：失败是静默的。
