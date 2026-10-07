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
- **开放 MCP 桥（Claude / Codex）** (MCP bridge): see the integrations below.
- **Codex 会话联动**: select a Codex project and conversation, relay a message, or query progress.

A few options (the session id, the working directory, whether to start with DSH) live in the `- id: clawbot` entry of
`~/.dsh/profiles/web/cordis.patch.yml`. Changing them restarts the WeChat listener automatically.

## Privacy and safety

- **Only you**: messages from anyone but the person who scanned the QR code are ignored.
- **Approvals come to you**: anything DSH needs you to approve is asked in WeChat, and nothing happens until you answer.
- **Where your messages go**: to the model configured for this session in DSH. If you ask the bot to relay a message to Claude Code or Codex, it also sends that message to the selected local coding session.
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
need them, turn off **开放 MCP 桥（Claude / Codex）** in the 微信 Bot settings. Existing Claude MCP clients remain compatible.

## Working with Codex (optional)

The integration works in both directions:

- **WeChat → Codex**: ask the bot to list Codex projects and conversations, choose one, then relay your message.
  DSH gets `list_codex_projects`, `list_codex_sessions`, `read_codex_session`, `send_to_codex_session`, and `read_codex_progress`.
  Projects are grouped by the conversations' working directories. Listings are paginated; use the returned full directory
  and conversation ID when selecting a target. Ambiguous names return candidates without sending anything.
- **Codex → DSH/WeChat**: the bundled `clawbot-mcp` stdio server exposes the configured DSH WeChat conversation,
  DSH session list/read/send tools, a notification tool, and progress publishing/query tools.

### Connect Codex to the DSH WeChat session

Build this checkout and register its MCP entry point on the same machine as DSH:

```bash
npm ci
npm run build
codex mcp add wechat-clawbot -- node /path/to/wechat-clawbot/lib/mcp-cli.js
node /path/to/wechat-clawbot/lib/mcp-cli.js --check
```

Replace `/path/to/wechat-clawbot` with your checkout. For an installed version containing this integration,
`clawbot-mcp` is also a package executable. Reconnect the Codex client after adding the server.
DSH must be running with the updated plugin and **开放 MCP 桥（Claude / Codex）** enabled.
The default origin is `http://127.0.0.1:3080`; set `CLAWBOT_DSH_URL` if DSH uses a different port.
The token is read from `$CLAWBOT_STATE_DIR/mcp-token` or `$DSH_HOME/clawbot/mcp-token` (`DSH_HOME` defaults to `~/.dsh`).
Set `CLAWBOT_MCP_TOKEN_FILE` for another location. Pass these variables with `codex mcp add --env KEY=VALUE` as needed.
Keep the token in its local file, not in command arguments or repository config.

Codex can read `clawbot://wechat-session` or call `dsh_get_wechat_session` to see the WeChat session.
`dsh_notify_wechat({text: "…"})` sends only to the QR-linked owner and records a `[Codex 发给用户的]` copy in DSH history;
it does not start another bot turn. `dsh_send_to_session` drives a selected DSH conversation without automatically
forwarding its replies to WeChat. Use the notification tool when you want a phone update.

### Choose the Codex project and conversation from WeChat

The default `codexTransport: socket` connects to an existing shared App Server using WebSocket over a Unix socket.
The default socket is `$CODEX_HOME/app-server-control/app-server-control.sock` (`CODEX_HOME` defaults to `~/.codex`).
Set `codexSocket` to use a specific shared server's socket. Set `codexBinary` to select the CLI for standalone mode.
These fields belong in the `clawbot` row of
your local DSH `cordis.patch.yml`; changing them restarts the plugin. `codexPeer` is a live switch in the settings card.

The server must be the one executing the selected conversations and support the documented Unix socket WebSocket transport.
You can start a local shared service with `codex app-server --listen unix://` or `--listen unix:///path/to/rpc.sock`.
An already-running desktop/IDE client must expose or use that shared server for
live steering; **starting another daemon does not attach it to an unrelated client's running tasks**.
There is no silent fallback to a separate Codex runner if the shared server is unavailable.

Once connected, say, for example: "List Codex projects", "Show conversations in that project", then
"Send 'run the tests' to this conversation". Active turns receive `turn/steer` with the current turn ID;
idle conversations receive `turn/start`. Both keep the selected conversation's identity and permissions.
Delivery is reported immediately; completion must be checked separately.
An unloaded conversation requires the original client to be closed and explicit `allowResume: true`,
even in socket mode: another server's live execution cannot be inferred from stored history.

`notLoaded` only means this server has not loaded the conversation. Use `read_codex_session` to read its saved history.
Reads use summarized pages to avoid pulling large command outputs and tool results. If a response still hits the
8 MiB limit, reduce `limit` to 1. Reading history does not resume execution and may omit another client's unsaved messages.

A relayed message belongs to the conversation identified by the delivery result's `threadId`; it is not copied
into other conversations open in the app. In a regular local CLI, `/app` opens the same saved conversation in the
desktop app. Live execution on a shared server still requires the clients to connect to that same server.
You can also open a known local conversation with `codex://threads/<thread-id>`; see the
[desktop deep-link reference](https://learn.chatgpt.com/docs/reference/commands) and
[CLI command reference](https://learn.chatgpt.com/docs/developer-commands).

For background continuation of stored conversations, explicitly configure `codexTransport: stdio`.
That launches an independent `codex app-server --listen stdio://` using your existing Codex login/config.
It cannot inspect another client's live execution. A stored, unloaded conversation will only resume after you
close its original client and explicitly permit background continuation (`allowResume: true`).
No model, sandbox, or approval policy is overridden. Command/file approval requests and user questions from
this independent runner go to WeChat; unsupported permission grants are declined. Shared-server approvals remain
with the existing Codex client.

### Let clawbot report progress

In Codex, ask it to call `dsh_report_codex_progress` at meaningful milestones and at the end of the task,
using the selected conversation's full ID:

```json
{"threadId":"11111111-1111-4111-8111-111111111111","state":"running","summary":"Implementing the parser"}
```

States are `running`, `waiting`, `completed`, `failed`, or `interrupted`. DSH can query `read_codex_progress`,
and MCP clients can query `dsh_read_codex_progress`. Publishing a report does not send a phone notification;
Codex can separately use `dsh_notify_wechat` when requested. App Server events also populate progress for subscribed
conversations. `notLoaded` means live state is unknown, and a timestamped report is an observation, not a live heartbeat.
Progress reports are held in memory (up to 200 conversations) and cleared when the plugin restarts.

The progress HTTP routes are `POST /plugins/clawbot/mcp/codex/report` and
`GET /plugins/clawbot/mcp/codex/progress?threadId=…`. They use the same bearer token and live `mcpBridge` switch as
the existing session/notification routes. The MCP client accepts loopback origins only and refuses redirects.
No login data, conversation snapshots, preferences, project inventories, or local workspace indexes are bundled in the package.
Protocol reference: [Codex App Server](https://learn.chatgpt.com/docs/app-server).

## Development

```bash
npm install
npm run build              # compile to lib/
node test/regression.mjs   # offline regression checks: no model calls, no network, no WeChat
npm run test:codex         # synthetic Codex RPC + loopback HTTP + real MCP stdio; no model or WeChat calls
```

`src/ilink/` is the protocol layer ported from Tencent's MIT-licensed
[`@tencent-weixin/openclaw-weixin`](https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin); the rest is the DSH integration.

## License

MIT. The ported iLink client is © Tencent, also under the MIT license; see [NOTICE](NOTICE).
