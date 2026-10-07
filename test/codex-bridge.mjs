/** Offline integration checks: synthetic Codex RPC, temporary DSH HTTP and real MCP stdio. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { WebSocketServer } from "ws";
import { CodexPeer, registerCodexPeerTools } from "../lib/codex-peer.js";
import { CodexAppServer, CodexRpcError } from "../lib/codex-rpc.js";
import { CodexProgressStore } from "../lib/codex-progress.js";
import { ClawbotMcpClient } from "../lib/mcp-server.js";
import { registerMcpRoutes } from "../lib/mcp-route.js";
import { normalizeConfig, HOT_FIELDS } from "../lib/config.js";

const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";
const config = (transport = "socket") => ({ codexPeer: true, codexTransport: transport });
const thread = (id = ID_A, cwd = "/workspace/alpha", type = "idle") => ({
  id, cwd, name: "Fix tests", status: { type }, turns: [],
});

function mockRpc(records, hook) {
  const calls = [];
  const rpc = {
    calls,
    close() {},
    async request(method, params = {}) {
      calls.push({ method, params: structuredClone(params) });
      const custom = await hook?.(method, params, records);
      if (custom !== undefined) return structuredClone(custom);
      if (method === "thread/list") return {
        data: structuredClone(records.filter((record) => !params.cwd || record.cwd === params.cwd)), nextCursor: null,
      };
      const selected = records.find((record) => record.id === params.threadId);
      if (!selected) throw new Error("thread not found");
      if (method === "thread/read" || method === "thread/resume") {
        if (method === "thread/resume" && selected.status.type === "notLoaded") selected.status.type = "idle";
        return { thread: structuredClone(selected) };
      }
      if (method === "thread/turns/list") return { data: structuredClone(selected.turns.slice(-params.limit).reverse()), nextCursor: null };
      if (method === "turn/start") {
        selected.status.type = "active";
        const turn = { id: "turn-test", status: "inProgress", items: [] };
        selected.turns.push(turn);
        return { turn };
      }
      if (method === "turn/steer") return { turnId: params.expectedTurnId };
      throw new Error(`unexpected method ${method}`);
    },
  };
  return rpc;
}

test("ambiguous conversation titles cannot send; project selection resolves the target", async () => {
  const rpc = mockRpc([thread(), thread(ID_B, "/workspace/beta")]);
  const peer = new CodexPeer(config(), new CodexProgressStore(), { rpc });
  await assert.rejects(peer.send("Fix tests", "Run tests"), /多个会话匹配/);
  assert.equal(rpc.calls.filter((call) => call.method === "thread/resume").length, 0);
  const result = await peer.send("Fix tests", "Run tests", "/workspace/beta");
  assert.equal(result.threadId, ID_B);
  assert.equal(result.delivered, "started");
  await assert.rejects(peer.send(ID_A, "Run tests", "/workspace/beta"), /不属于所选项目/);
  const list = rpc.calls.find((call) => call.method === "thread/list");
  assert.ok(list.params.sourceKinds.includes("appServer"), "desktop/app-server threads must be included");
});

test("selector checks subsequent pages before deciding a title is unique", async () => {
  const rpc = mockRpc([], (method, params) => {
    if (method === "thread/list") return params.cursor
      ? { data: [thread(ID_B)], nextCursor: null }
      : { data: [thread()], nextCursor: "page-two" };
  });
  const peer = new CodexPeer(config(), new CodexProgressStore(), { rpc });
  await assert.rejects(peer.send("Fix tests", "hello"), /多个会话匹配/);
  assert.deepEqual(rpc.calls.map((call) => call.method), ["thread/list", "thread/list"]);
});

test("running task is steered with the exact current turn and original project policy", async () => {
  const active = thread(ID_A, "/workspace/alpha", "active");
  active.turns = [{ id: "active-turn", status: "inProgress", items: [] }];
  const rpc = mockRpc([active]);
  const peer = new CodexPeer(config(), new CodexProgressStore(), { rpc });
  const result = await peer.send(ID_A, "Only fix the parser", "/workspace/alpha");
  assert.equal(result.delivered, "steered");
  assert.deepEqual(rpc.calls.find((call) => call.method === "thread/resume").params, { threadId: ID_A, excludeTurns: true });
  const sent = rpc.calls.find((call) => call.method === "turn/steer");
  assert.equal(sent.params.expectedTurnId, "active-turn");
  assert.ok(sent.params.input[0].text.endsWith("Only fix the parser"));
  assert.equal(rpc.calls.filter((call) => call.method === "turn/start").length, 0);
});

test("a task becoming active during resume is steered, never started twice", async () => {
  const rpc = mockRpc([thread()], (method, _params, records) => {
    if (method !== "thread/resume") return;
    records[0].status.type = "active";
    records[0].turns = [{ id: "new-turn", status: "inProgress", items: [] }];
    return { thread: records[0] };
  });
  const peer = new CodexPeer(config(), new CodexProgressStore(), { rpc });
  await peer.send(ID_A, "hello");
  assert.equal(rpc.calls.at(-1).method, "turn/steer");
  assert.equal(rpc.calls.at(-1).params.expectedTurnId, "new-turn");
});

test("missing active turn id fails without starting unrelated work", async () => {
  const rpc = mockRpc([thread(ID_A, "/workspace/alpha", "active")]);
  const peer = new CodexPeer(config(), new CodexProgressStore(), { rpc });
  await assert.rejects(peer.send(ID_A, "hello"), /未返回当前 turn id/);
  assert.equal(rpc.calls.some((call) => call.method.startsWith("turn/")), false);
});

test("history reads are paginated and legacy fallback only handles an unsupported method", async () => {
  const record = thread();
  record.turns = [{ id: "old", status: "completed", items: [] }, { id: "recent", status: "completed", items: [] }];
  const rpc = mockRpc([record]);
  const peer = new CodexPeer(config(), new CodexProgressStore(), { rpc });
  assert.equal((await peer.read(ID_A, undefined, 1)).turns[0].id, "recent");
  assert.equal(rpc.calls.some((call) => call.params.includeTurns === true), false);
  const legacyRpc = mockRpc([record], (method) => {
    if (method === "thread/turns/list") throw new CodexRpcError("method not found", -32601);
  });
  const legacy = new CodexPeer(config(), new CodexProgressStore(), { rpc: legacyRpc });
  assert.equal((await legacy.read(ID_A, undefined, 1)).turns[0].id, "recent");
  assert.equal(legacyRpc.calls.at(-1).params.includeTurns, true);
  const unavailableRpc = mockRpc([record], (method) => {
    if (method === "thread/turns/list") throw new Error("connection lost");
  });
  const unavailable = new CodexPeer(config(), new CodexProgressStore(), { rpc: unavailableRpc });
  await assert.rejects(unavailable.read(ID_A), /connection lost/);
  assert.equal(unavailableRpc.calls.some((call) => call.params.includeTurns === true), false);
  const emptyRpc = mockRpc([thread()], (method) => {
    if (method === "thread/turns/list") throw new CodexRpcError("thread is not materialized yet", -32600);
  });
  const empty = new CodexPeer(config(), new CodexProgressStore(), { rpc: emptyRpc });
  assert.deepEqual((await empty.read(ID_A)).turns, []);
});

test("standalone continuation requires opt-in; reads do not resume the thread", async () => {
  const rpc = mockRpc([thread(ID_A, "/workspace/alpha", "notLoaded")]);
  const peer = new CodexPeer(config("stdio"), new CodexProgressStore(), { rpc });
  const read = await peer.read(ID_A);
  assert.equal(read.status.type, "notLoaded");
  assert.equal(rpc.calls.some((call) => call.method === "thread/resume"), false);
  await assert.rejects(peer.send(ID_A, "Continue"), /先关闭原会话/);
  assert.equal(rpc.calls.some((call) => call.method === "thread/resume"), false);
  await peer.send(ID_A, "Continue", "/workspace/alpha", true);
  assert.equal(rpc.calls.at(-1).method, "turn/start");
});

test("concurrent relays to one thread serialize and delivery is not completion", async () => {
  const progress = new CodexProgressStore();
  const rpc = mockRpc([thread()], async (method) => {
    if (method === "turn/start") await new Promise((resolve) => setTimeout(resolve, 15));
  });
  const peer = new CodexPeer(config(), progress, { rpc });
  const results = await Promise.all([peer.send(ID_A, "First"), peer.send(ID_A, "Second")]);
  assert.deepEqual(results.map((result) => result.delivered), ["started", "steered"]);
  assert.equal(rpc.calls.filter((call) => call.method === "turn/start").length, 1);
  assert.equal(progress.list(ID_A)[0].state, "running");
});

test("disable switch prevents new RPC operations; invalid messages do not mutate", async () => {
  const settings = config();
  const rpc = mockRpc([thread()]);
  const peer = new CodexPeer(settings, new CodexProgressStore(), { rpc });
  await assert.rejects(peer.send(ID_A, "  "), /消息必须/);
  settings.codexPeer = false;
  await assert.rejects(peer.list(), /已在设置里关闭/);
  assert.equal(rpc.calls.length, 0);
  const normalized = normalizeConfig({ codexPeer: false, codexTransport: "stdio", codexBinary: "/usr/local/bin/codex" });
  assert.equal(normalized.codexPeer, false);
  assert.equal(normalized.codexTransport, "stdio");
  assert.equal(normalizeConfig({ codexTransport: "unknown" }).codexTransport, "socket");
  assert.ok(HOT_FIELDS.has("codexPeer"));
  assert.equal(HOT_FIELDS.has("codexTransport"), false);
});

test("DSH tools distinguish unloaded threads and can query MCP progress without an RPC server", async () => {
  const progress = new CodexProgressStore();
  progress.report({ threadId: ID_A, state: "completed", summary: "Tests passed", source: "codex-mcp" });
  const rpc = mockRpc([thread(ID_A, "/workspace/alpha", "notLoaded")]);
  const peer = new CodexPeer(config(), progress, { rpc });
  const tools = new Map();
  registerCodexPeerTools({ tools: { register: (tool) => tools.set(tool.name, tool) } }, peer);
  const reports = await tools.get("read_codex_progress").execute({ threadId: ID_A });
  assert.equal(reports.ok, true);
  assert.equal(JSON.parse(reports.summary).progress[0].state, "completed");
  assert.equal(rpc.calls.length, 0);
  const listing = await tools.get("list_codex_sessions").execute({});
  assert.match(JSON.parse(listing.summary).sessions[0].state, /实时状态未知/);
  const read = await tools.get("read_codex_session").execute({ session: ID_A });
  assert.equal(JSON.parse(read.summary).progressReports[0].source, "codex-mcp");
  assert.equal(typeof tools.get("send_to_codex_session").output.render, "function");
});

test("RPC handles handshake, interleaved replies, server requests, errors and deadlines", async () => {
  const notifications = [];
  const fixture = `
    import { createInterface } from 'node:readline';
    let initialized = false;
    const write = value => process.stdout.write(JSON.stringify(value) + '\\n');
    createInterface({ input: process.stdin }).on('line', line => {
      const m = JSON.parse(line);
      if (m.method === 'initialized') { initialized = true; return; }
      if (m.method === 'initialize') { write({ id: m.id, result: {} }); return; }
      if (m.method === 'hang') return;
      if (m.method === 'fail') { write({ id: m.id, error: { code: -32000, message: 'synthetic error' } }); return; }
      if (m.method === 'first') {
        write({ method: 'turn/started', params: { threadId: 'test' } });
        write({ id: 'approval-test', method: 'item/commandExecution/requestApproval', params: {} });
        setTimeout(() => write({ id: m.id, result: { initialized, value: 'first' } }), 10); return;
      }
      if (m.method === 'second') {
        const result = JSON.stringify({ id: m.id, result: { value: 'second' } }) + '\\n';
        process.stdout.write(result.slice(0, 7)); process.stdout.write(result.slice(7)); return;
      }
      if (m.id === 'approval-test') write({ method: 'approval/answered', params: m.result });
    });
  `;
  const rpc = new CodexAppServer({
    command: process.execPath, args: ["--input-type=module", "-e", fixture], timeoutMs: 500,
    onNotification: (message) => notifications.push(message),
    onRequest: async () => ({ decision: "decline" }),
  });
  try {
    const [first, second] = await Promise.all([rpc.request("first"), rpc.request("second")]);
    assert.deepEqual(first, { initialized: true, value: "first" });
    assert.equal(second.value, "second");
    assert.ok(notifications.some((message) => message.method === "turn/started"));
    assert.ok(notifications.some((message) => message.params?.decision === "decline"));
    await assert.rejects(rpc.request("fail"), /synthetic error/);
    await assert.rejects(rpc.request("hang"), /delivery is unknown/);
  } finally { rpc.close(); }
  await assert.rejects(rpc.request("first"), /disposed/);
});

test("RPC connection loss rejects pending calls without replaying messages", async () => {
  const rpc = new CodexAppServer({ command: process.execPath, args: ["--input-type=module", "-e", `
    import { createInterface } from 'node:readline';
    createInterface({ input: process.stdin }).on('line', line => {
      const m = JSON.parse(line);
      if (m.method === 'initialize') process.stdout.write(JSON.stringify({id: m.id, result: {}}) + '\\n');
      if (m.method === 'turn/start') process.exit(1);
    });
  `] });
  try { await assert.rejects(rpc.request("turn/start"), /disconnected/); }
  finally { rpc.close(); }
});

test("shared socket uses WebSocket Upgrade and closing the bridge leaves the other client running", async () => {
  const dir = await mkdtemp(join(tmpdir(), "clawbot-codex-socket-"));
  const socketPath = join(dir, "rpc socket.sock");
  const http = createServer();
  const ws = new WebSocketServer({ server: http });
  const active = { ...thread(ID_A, "/workspace/alpha", "active"), turns: [{ id: "live-turn", status: "inProgress", items: [] }] };
  const methods = [];
  ws.on("connection", (connection) => {
    connection.on("message", (frame) => {
      const message = JSON.parse(frame.toString());
      const { id, method, params } = message;
      methods.push(method);
      const write = (result) => connection.send(JSON.stringify({ id, result }));
      if (method === "initialize") write({});
      if (method === "thread/read" || method === "thread/resume") write({ thread: active });
      if (method === "thread/turns/list") write({ data: active.turns, nextCursor: null });
      if (method === "turn/steer") {
        assert.equal(params.expectedTurnId, "live-turn");
        write({ turnId: "live-turn" });
      }
    });
  });
  const rpc = new CodexAppServer({ socketPath, timeoutMs: 1_000 });
  const observer = new CodexAppServer({ socketPath, timeoutMs: 1_000 });
  const peer = new CodexPeer(config(), new CodexProgressStore(), { rpc });
  try {
    await new Promise((resolve, reject) => { http.once("error", reject); http.listen(socketPath, resolve); });
    assert.equal((await observer.request("thread/read", { threadId: ID_A })).thread.status.type, "active");
    assert.equal((await peer.send(ID_A, "Keep the change focused")).delivered, "steered");
    peer.close();
    assert.equal((await observer.request("thread/read", { threadId: ID_A })).thread.status.type, "active");
    assert.equal(methods.includes("turn/start"), false);
    assert.equal(methods.filter((method) => method === "initialize").length, 2);
  } finally {
    peer.close(); observer.close();
    for (const client of ws.clients) client.terminate();
    await new Promise((resolve) => ws.close(resolve));
    await new Promise((resolve) => http.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test("closing a socket during initialization settles the connecting request", { timeout: 2_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "clawbot-codex-dispose-"));
  const http = createServer();
  const ws = new WebSocketServer({ server: http });
  const connected = new Promise((resolve) => ws.once("connection", resolve));
  const socketPath = join(dir, "rpc.sock");
  const rpc = new CodexAppServer({ socketPath });
  try {
    await new Promise((resolve, reject) => { http.once("error", reject); http.listen(socketPath, resolve); });
    const pending = assert.rejects(rpc.request("thread/list"), /disposed|disconnected/);
    await connected;
    rpc.close();
    await pending;
  } finally {
    rpc.close();
    for (const client of ws.clients) client.terminate();
    await new Promise((resolve) => ws.close(resolve));
    await new Promise((resolve) => http.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test("real RPC notifications preserve terminal states and withdraw cancelled WeChat questions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "clawbot-codex-events-"));
  try {
    for (const state of ["completed", "failed", "interrupted"]) {
      const bin = join(dir, `codex-${state}`);
      await writeFile(bin, `#!${process.execPath}\n
        import { createInterface } from 'node:readline';
        const write = value => process.stdout.write(JSON.stringify(value) + '\\n');
        const record = ${JSON.stringify(thread())};
        const state = ${JSON.stringify(state)};
        createInterface({ input: process.stdin }).on('line', line => {
          const m = JSON.parse(line);
          if (m.method === 'initialize') write({ id: m.id, result: {} });
          if (m.method === 'thread/read' || m.method === 'thread/resume') write({ id: m.id, result: { thread: record } });
          if (m.method === 'turn/start') {
            const turn = { id: 'event-turn', status: state, items: [], error: state === 'failed' ? { message: 'Synthetic failure' } : null };
            if (state === 'completed') {
              // A fast event can beat the RPC acknowledgement.
              write({ method: 'turn/completed', params: { threadId: record.id, turn } });
              write({ id: m.id, result: { turn: { ...turn, status: 'inProgress' } } });
            } else {
              write({ id: m.id, result: { turn: { ...turn, status: 'inProgress' } } });
              write({ id: 'question', method: 'item/commandExecution/requestApproval', params: { threadId: record.id, turnId: turn.id, command: 'npm test' } });
              setTimeout(() => write({ method: 'turn/completed', params: { threadId: record.id, turn } }), 20);
            }
          }
        });
      `, { mode: 0o700 });
      const progress = new CodexProgressStore();
      let cancelled = false;
      const peer = new CodexPeer({ ...config("stdio"), codexBinary: bin }, progress, {
        askWechat: (_question, signal) => new Promise((resolve) => {
          signal.addEventListener("abort", () => { cancelled = true; resolve(null); }, { once: true });
        }),
      });
      try {
        await peer.send(ID_A, "Run tests");
        for (let attempt = 0; attempt < 50 && progress.list(ID_A)[0]?.state !== state; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.equal(progress.list(ID_A)[0].state, state);
        assert.equal(progress.list(ID_A)[0].turnId, "event-turn");
        if (state !== "completed") assert.equal(cancelled, true, "completed/interrupted turns must withdraw pending phone questions");
        if (state === "failed") assert.match(progress.list(ID_A)[0].summary, /Synthetic failure/);
      } finally { peer.close(); }
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("progress storage is bounded and rejects invalid states", () => {
  const store = new CodexProgressStore();
  for (let i = 0; i < 205; i++) store.report({ threadId: `test-${i}`, state: "running", summary: "Working", source: "codex-mcp" });
  assert.equal(store.list().length, 200);
  assert.equal(store.list("test-0").length, 0);
  assert.ok(Date.parse(store.list()[0].updatedAt));
  assert.throws(() => store.report({ threadId: "test", state: "idle", summary: "bad", source: "codex-mcp" }), /invalid progress state/);
  assert.throws(() => store.report({ threadId: "test", state: "failed", summary: "x".repeat(4_001), source: "codex-mcp" }), /4000/);
});

test("MCP client refuses non-local destinations before reading or sending a token", () => {
  for (const url of ["https://example.com", "http://127.0.0.1.example.com", "file:///tmp/test", "http://localhost/?token=x", "http://user:pass@localhost", "http://localhost/path"]) {
    assert.throws(() => new ClawbotMcpClient({ url }), /loopback/);
  }
});

test("MCP stdio exposes WeChat session, owner-only notification and authenticated Codex progress", async () => {
  const dir = await mkdtemp(join(tmpdir(), "clawbot-codex-test-"));
  const previousState = process.env.CLAWBOT_STATE_DIR;
  process.env.CLAWBOT_STATE_DIR = dir;
  const sent = [];
  const appended = [];
  const driven = [];
  const routes = new Map();
  const progress = new CodexProgressStore();
  const settings = { mcpBridge: true, sessionId: "wechat-test" };
  const agent = {
    status: "idle",
    session: {
      id: "wechat-test", header: { cwd: "/workspace/chat" }, seq: 0,
      append: (...args) => appended.push(args), snapshotEvents: () => [],
    },
    followup: (message) => driven.push(message), steer: (message) => driven.push(message), whenIdle: async () => {},
  };
  const ctx = {
    agents: { list: () => [agent], get: (id) => id === "wechat-test" ? agent : undefined },
    get: () => ({
      listSessions: async () => [{ header: { id: "wechat-test", cwd: "/workspace/chat", createdAt: 1 }, live: true, persisted: true }],
      readTitleSnapshots: async () => [{ status: "fulfilled", value: { title: { title: "WeChat" } } }],
      readSurface: async () => ({ capturedThroughSeq: 1, events: [
        { type: "user/message", time: 1, seq: 1, data: { content: [{ type: "text", text: "Please check the task" }] } },
      ] }),
    }),
    webServer: { register: (route) => { routes.set(route.path, route.handler); return () => routes.delete(route.path); } },
    inject: (_services, callback) => callback(ctx), effect: (callback) => callback(),
  };
  let server;
  let mcp;
  try {
    registerMcpRoutes(ctx, {
      config: settings, codexProgress: progress,
      getAccount: () => ({ configured: true, userId: "linked-owner" }),
      sendText: async (to, text) => sent.push({ to, text }),
    });
    server = createServer((req, res) => {
      const handler = routes.get(new URL(req.url, "http://localhost").pathname);
      if (!handler) { res.writeHead(404); res.end(); return; }
      void Promise.resolve(handler(req, res)).catch((error) => { res.writeHead(500); res.end(error.message); });
    });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const url = `http://127.0.0.1:${server.address().port}`;
    const tokenFile = join(dir, "mcp-token");
    const token = (await readFile(tokenFile, "utf8")).trim();
    const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([, value]) => typeof value === "string"));
    const env = { ...baseEnv, CLAWBOT_DSH_URL: url, CLAWBOT_MCP_TOKEN_FILE: tokenFile };
    mcp = new Client({ name: "offline-test", version: "1.0.0" });
    await mcp.connect(new StdioClientTransport({ command: process.execPath, args: ["lib/mcp-cli.js"], env, stderr: "pipe" }));
    const listed = await mcp.listTools();
    assert.equal(listed.tools.length, 7);
    assert.equal(listed.tools.find((tool) => tool.name === "dsh_notify_wechat").annotations.readOnlyHint, false);
    const resource = await mcp.readResource({ uri: "clawbot://wechat-session" });
    assert.equal(JSON.parse(resource.contents[0].text).sessionId, "wechat-test");
    const session = await mcp.callTool({ name: "dsh_get_wechat_session", arguments: {} });
    assert.equal(session.structuredContent.messages[0].text, "Please check the task");

    const notice = await mcp.callTool({ name: "dsh_notify_wechat", arguments: { text: "Tests passed", to: "third-party" } });
    assert.equal(notice.isError, undefined);
    assert.deepEqual(sent, [{ to: "linked-owner", text: "Tests passed" }]);
    assert.equal(appended[0][1].content[0].text, "[Codex 发给用户的] Tests passed");
    assert.equal(driven.length, 0, "mirroring a notification must not start a bot turn");
    const invalid = await mcp.callTool({ name: "dsh_notify_wechat", arguments: { text: "  " } });
    assert.equal(invalid.isError, true);
    assert.equal(sent.length, 1);

    const report = await mcp.callTool({ name: "dsh_report_codex_progress", arguments: {
      threadId: ID_A, cwd: "/workspace/alpha", state: "completed", summary: "Build and tests passed",
    } });
    assert.equal(report.structuredContent.progress.source, "codex-mcp");
    assert.equal(progress.list(ID_A)[0].state, "completed");
    const read = await mcp.callTool({ name: "dsh_read_codex_progress", arguments: { threadId: ID_A } });
    assert.equal(read.structuredContent.progress.length, 1);
    assert.equal(sent.length, 1, "progress publishing must not silently notify the owner");

    const unauthorized = await fetch(`${url}/plugins/clawbot/mcp/codex/progress`);
    assert.equal(unauthorized.status, 401);
    const wrongState = await fetch(`${url}/plugins/clawbot/mcp/codex/report`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ threadId: ID_A, state: "made-up", summary: "bad" }),
    });
    assert.equal(wrongState.status, 400);
    assert.equal(progress.list(ID_A)[0].state, "completed");
    const check = await promisify(execFile)(process.execPath, ["lib/mcp-cli.js", "--check"], { env });
    assert.deepEqual(JSON.parse(check.stdout), { ok: true, wechatSessionConfigured: true });
    assert.equal(check.stdout.includes(token), false);

    settings.mcpBridge = false;
    const disabled = await mcp.callTool({ name: "dsh_read_codex_progress", arguments: {} });
    assert.equal(disabled.isError, true);
    assert.match(disabled.content[0].text, /403/);
    settings.mcpBridge = true;
    await writeFile(tokenFile, "wrong-token\n");
    const rotated = await mcp.callTool({ name: "dsh_list_sessions", arguments: {} });
    assert.equal(rotated.isError, true, "client reads the token file afresh for each call");
    assert.match(rotated.content[0].text, /401/);
  } finally {
    await mcp?.close();
    if (server) await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    if (previousState === undefined) delete process.env.CLAWBOT_STATE_DIR;
    else process.env.CLAWBOT_STATE_DIR = previousState;
    await rm(dir, { recursive: true, force: true });
  }
});
