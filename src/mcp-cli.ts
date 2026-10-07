#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ClawbotMcpClient, createClawbotMcpServer } from "./mcp-server.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    process.stdout.write("clawbot-mcp [--check]\nEnvironment: CLAWBOT_DSH_URL, CLAWBOT_MCP_TOKEN_FILE, CLAWBOT_STATE_DIR, DSH_HOME\n");
    return;
  }
  if (args.some((arg) => arg !== "--check")) throw new Error("Unknown option; use clawbot-mcp --help");
  const client = new ClawbotMcpClient();
  if (args.includes("--check")) {
    const result = await client.request("sessions");
    process.stdout.write(`${JSON.stringify({ ok: true, wechatSessionConfigured: typeof result.wechatSessionId === "string" })}\n`);
    return;
  }
  const server = createClawbotMcpServer(client);
  await server.connect(new StdioServerTransport());
  const stop = (): void => { void server.close().finally(() => { process.exitCode = 0; }); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

main().catch((error: unknown) => {
  // stdout is reserved for the MCP protocol.
  process.stderr.write(`clawbot-mcp: ${error instanceof Error ? error.message : "startup failed"}\n`);
  process.exitCode = 1;
});
