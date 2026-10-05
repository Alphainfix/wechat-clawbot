# wechat-clawbot

English | [中文](README.zh.md)

Chat with the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) agent on your computer from WeChat.
Away from your desk, you can still ask it to look through files, edit documents or run commands, and the results come back to the WeChat chat.

It uses WeChat's official **微信ClawBot** channel (Tencent iLink): no second account and no web-login tricks.

## What it does

- **Put your computer to work from WeChat**: "what's the newest PDF in Downloads?", "run this script"
- **Understands photos**: send a picture and ask what it is. If the model accepts images, the photo goes to it directly
- **Sends files back**: "send me README.md", "make a chart and send it". Images, PDFs, Office files and archives all work
- **"Typing…"**: while it thinks, works or sends you a file, WeChat shows the bot as typing, just like a person, until the reply arrives
- **Reminders**: "remind me at 9 tomorrow to hand in the report", and you get a WeChat message on time
- **Long-term memory**: remembers your habits and preferences, so you don't have to repeat them
- **Asks before it acts**: anything that needs your approval (e.g. touching files outside its working directory) is asked in WeChat; reply `同意` / `拒绝` (or `yes` / `no`)
- **Understands quotes**: reply to an older message with WeChat's quote feature and it knows which one you mean
- **Long chats stay quick**: when the conversation gets long, it tidies older messages into a summary during a quiet spell after a reply, so your next message never waits for it

## Requirements

- DSH **0.1.7 – 0.2.x** (tested on 0.1.7-rc.2 and 0.2.0-rc.2), Node.js 22+ and pnpm
- The official **微信ClawBot** plugin in the WeChat mobile app (WeChat → Settings → Plugins; the first scan may ask you to update WeChat)
- A computer that stays on: the bot is online while DSH is running

## Set up in three steps

**1. Install the plugin**

```bash
dsh plugin --profile web add wechat-clawbot
```

Or search for `wechat-clawbot` under **Plugins → Add plugin** in the DSH web sidebar. **Restart DSH** once afterwards.

**2. Link your WeChat**

```bash
npx -y -p wechat-clawbot clawbot login
```

A QR code appears in the terminal. Scan it with WeChat's "Scan" and confirm.

**3. Start chatting**

A new contact, **微信ClawBot**, shows up in WeChat. Message it. The running DSH picks up the new link within a few seconds, so no restart is needed.

Other commands: `clawbot status` shows who is linked, `clawbot logout` unlinks (use the same `npx -y -p wechat-clawbot` prefix).

## Settings

Open **Plugins → wechat-clawbot → 微信 Bot** in the DSH web sidebar. Changes apply immediately and the WeChat connection stays up:

- **Model**: pin a provider / model / reasoning effort for the bot. Leave it empty to follow DSH's global default.
- **Who may message the bot**: only you (the person who scanned) by default. Add WeChat user ids to let others in.
- **Images**: whether photos go straight to the model, and how outgoing images are resized and compressed.
- **空闲时整理对话** (tidy up while idle): on by default. Off leaves only DSH's own compaction, which runs right before a reply and makes that reply wait.
- **把工作目录的说明文件交给 bot** (workspace instruction files): on by default (DSH's own behaviour: once the bot works in a project, its AGENTS.md / CLAUDE.md is put into the chat, and the whole file again after every edit). Off keeps them out of the WeChat session, which helps when those files are long and change often; the bot can still read them when it needs to.
- **开放 Claude 桥** (Claude bridge): see "Working with Claude Code" below.

A few options (the session id, the working directory, whether to start with DSH) live in the `- id: clawbot` entry of
`~/.dsh/profiles/web/cordis.patch.yml`. Changing them restarts the WeChat listener automatically.

## Privacy and safety

- **Only you**: messages from anyone but the person who scanned the QR code are ignored.
- **Approvals come to you**: anything DSH needs you to approve is asked in WeChat, and nothing happens until you answer.
- **Where your messages go**: only to the model you configured for this session in DSH. The plugin sends your text nowhere else.
- **Auto-memory** (on by default): short messages that look like lasting facts ("I don't drink coffee") get a second
  question to **the same model**: should this be remembered? To turn it off, add `autoMemory: false` to the `clawbot`
  entry in `cordis.patch.yml`. It takes effect on the next message.
- The WeChat link and the long-term memory are stored on your computer, under `~/.dsh/clawbot/`.

## FAQ

**I sent a message and nothing happened**: check that DSH is running, then open **Plugins → wechat-clawbot**: both
components should say "running". If you just upgraded DSH, see the [install & troubleshooting guide](wechat-clawbot-INSTALL.md).

**A reminder was late**: reminders need the computer and DSH to be running. While the computer sleeps, they wait until it wakes.

**I want the bot on a different model**: pin one in the 微信 Bot settings. Then switching models in the web UI no longer affects the bot.

More on installing, upgrading and troubleshooting: [wechat-clawbot-INSTALL.md](wechat-clawbot-INSTALL.md) (in Chinese).
It is written for an AI agent installing the plugin for you, and it works just as well for people.

## Limitations

- No group chats and no voice messages.
- One WeChat account per DSH installation.
- The bot is offline while the computer is off or DSH is not running.

## Working with Claude Code (optional)

If you also use Claude Code, the bot can **check what a Claude Code session is doing** or **pass a message to one**.
A session that is already closed is resumed in the background first. This needs the `claude` CLI on the same machine.

The plugin also serves a small set of local HTTP routes for an MCP server, so Claude Code can in turn read and drive
DSH sessions and send you a WeChat notification. The routes listen on localhost only and require a token. If you don't
need them, turn off **开放 Claude 桥** in the 微信 Bot settings.

## Development

```bash
npm install
npm run build              # compile to lib/
node test/regression.mjs   # offline regression checks: no model calls, no network, no WeChat
```

`src/ilink/` is the protocol layer ported from Tencent's MIT-licensed
[`@tencent-weixin/openclaw-weixin`](https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin); the rest is the DSH integration.

## License

MIT. The ported iLink client is © Tencent, also under the MIT license; see [NOTICE](NOTICE).
