/** Codex RPC over stdio or a local WebSocket/Unix socket. No private UI APIs. */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { connect as connectUnix } from "node:net";
import WebSocket from "ws";

export type RpcMessage = {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message: string };
};

export interface CodexRpc {
  request<T>(method: string, params?: Record<string, unknown>): Promise<T>;
  close(): void;
}

export class CodexRpcError extends Error {
  constructor(message: string, readonly code?: number) { super(message); }
}

export type CodexRpcOptions = {
  command?: string;
  args?: string[];
  socketPath?: string;
  timeoutMs?: number;
  onNotification?: (message: RpcMessage) => void;
  /** Undefined leaves the request with the other clients of a shared server. */
  onRequest?: (message: RpcMessage) => Promise<unknown | undefined>;
};

/** Also works when a desktop-launched DSH has a minimal PATH. */
export function findCodexBinary(override?: string): string {
  if (override?.trim()) return override.trim();
  const candidates = [
    ...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, "codex")),
    path.join(os.homedir(), ".local", "bin", "codex"),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    "/Applications/Codex.app/Contents/Resources/codex",
    "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
  ];
  for (const candidate of candidates) {
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch { /* next */ }
  }
  return "codex";
}

export class CodexAppServer implements CodexRpc {
  private child: ChildProcessWithoutNullStreams | undefined;
  private socket: WebSocket | undefined;
  private connecting: Promise<void> | undefined;
  private closed = false;
  private nextId = 1;
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(private readonly options: CodexRpcOptions) {}

  private connect(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("Codex bridge was disposed"));
    if (this.connecting) return this.connecting;
    if (this.options.socketPath) return this.connectSocket(this.options.socketPath);
    if (!this.options.command) return Promise.reject(new Error("Codex command or socket is required"));
    const child = spawn(this.options.command, this.options.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      // Keep the user's Codex login and configuration in their existing home.
      env: { ...process.env },
      windowsHide: true,
    });
    this.child = child;
    let buffer = "";
    let stderr = "";
    const failed = (error: Error): void => {
      if (this.child !== child) return;
      this.child = undefined;
      this.connecting = undefined;
      child.kill();
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(error);
      }
      this.pending.clear();
    };
    child.on("error", () => failed(new Error("Could not launch Codex. Configure codexBinary or install the CLI.")));
    child.stdin.on("error", () => failed(new Error("Codex RPC input closed")));
    child.on("exit", () => failed(new Error(
      "Codex app-server disconnected. For live sessions, start a shared daemon or configure codexSocket."
      + (stderr ? ` ${stderr.trim().slice(-500)}` : ""),
    )));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-2_000); });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      // A corrupt or non-RPC executable must not accumulate unbounded output.
      if (Buffer.byteLength(buffer) > 8 * 1024 * 1024) {
        failed(new Error("Codex RPC frame exceeds 8 MiB"));
        return;
      }
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (!line) continue;
        try {
          const message: RpcMessage = JSON.parse(line);
          if (!message || typeof message !== "object") throw new Error("invalid frame");
          this.receive(child, message);
        } catch {
          failed(new Error("Codex returned an invalid JSON-RPC frame"));
          return;
        }
      }
    });
    this.connecting = this.initialize(child).catch((error: Error) => { failed(error); throw error; });
    return this.connecting;
  }

  private connectSocket(socketPath: string): Promise<void> {
    if (!path.isAbsolute(socketPath)) {
      return Promise.reject(new Error("codexSocket must be an absolute IPC path"));
    }
    const socket = new WebSocket("ws://localhost", {
      // The HTTP Upgrade goes over IPC, never TCP/DNS. This also preserves spaces in paths.
      createConnection: () => connectUnix({ path: socketPath }),
      handshakeTimeout: this.options.timeoutMs ?? 30_000,
      maxPayload: 8 * 1024 * 1024,
      followRedirects: false,
    });
    this.socket = socket;
    this.connecting = new Promise<void>((resolve, reject) => {
      const failed = (error: Error): void => {
        if (this.socket === socket) {
          this.socket = undefined;
          this.connecting = undefined;
          socket.terminate();
          for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
          this.pending.clear();
        }
        // Disposal can clear this.socket before the handshake rejects.
        // Always settle this connection's promise without touching a newer one.
        reject(this.closed ? new Error("Codex bridge was disposed") : error);
      };
      socket.on("error", (error: Error & { code?: string }) => failed(new Error(
        error.code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"
          ? "Codex RPC frame exceeds 8 MiB; reduce the history page size or use summarized items"
          : "Cannot connect to the shared Codex App Server. Start the correct server or configure codexSocket.",
      )));
      socket.on("close", () => failed(new Error("Shared Codex App Server disconnected; delivery of pending messages is unknown")));
      socket.on("message", (data, isBinary) => {
        try {
          if (isBinary) throw new Error("binary frame");
          const message: RpcMessage = JSON.parse(data.toString());
          if (!message || typeof message !== "object") throw new Error("invalid frame");
          this.receive(socket, message);
        } catch { failed(new Error("Codex returned an invalid WebSocket RPC frame")); }
      });
      socket.once("open", () => { void this.initialize(socket).then(resolve).catch(failed); });
    });
    return this.connecting;
  }

  private async initialize(connection: ChildProcessWithoutNullStreams | WebSocket): Promise<void> {
    await this.rawRequest("initialize", {
      clientInfo: { name: "wechat_clawbot", title: "WeChat Clawbot", version: "1.0.0" },
      capabilities: { experimentalApi: true },
    });
    this.write(connection, { method: "initialized", params: {} });
  }

  private write(connection: ChildProcessWithoutNullStreams | WebSocket, message: RpcMessage): void {
    const data = JSON.stringify(message);
    if (connection instanceof WebSocket) connection.send(data);
    else connection.stdin.write(`${data}\n`);
  }

  private receive(connection: ChildProcessWithoutNullStreams | WebSocket, message: RpcMessage): void {
    if (message.method) {
      if (message.id !== undefined) {
        // No automatic approval of commands, files, or permissions.
        void this.options.onRequest?.(message).then((result) => {
          if (result !== undefined && (this.child === connection || this.socket === connection)) this.write(connection, { id: message.id, result });
        }).catch((error: unknown) => {
          if (this.child === connection || this.socket === connection) this.write(connection, {
            id: message.id,
            error: { code: error instanceof CodexRpcError ? error.code ?? -32603 : -32603,
              message: error instanceof Error ? error.message : "Codex client request failed" },
          });
        });
      } else {
        this.options.onNotification?.(message);
      }
      return;
    }
    if (typeof message.id !== "number") return;
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new CodexRpcError(message.error.message, message.error.code));
    else entry.resolve(message.result);
  }

  private rawRequest<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const connection = this.child ?? this.socket;
    if (!connection) return Promise.reject(new Error("Codex app-server is not connected"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // Do not replay timed-out mutations: the server may already have acted.
        reject(new Error(`Codex ${method} timed out; delivery is unknown. Check the session before retrying.`));
      }, this.options.timeoutMs ?? 30_000);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      this.write(connection, { id, method, params });
    });
  }

  async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    await this.connect();
    return this.rawRequest<T>(method, params);
  }

  close(): void {
    this.closed = true;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("Codex bridge was disposed"));
    }
    this.pending.clear();
    const child = this.child;
    this.child = undefined;
    const socket = this.socket;
    this.socket = undefined;
    // Socket mode only closes our connection, never the shared daemon.
    socket?.terminate();
    child?.kill();
  }
}
