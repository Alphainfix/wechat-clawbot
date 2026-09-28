#!/usr/bin/env node
/**
 * ClawBot CLI — manual WeChat connection for wechat-clawbot.
 *
 *   clawbot login    show a QR code, scan with WeChat on your phone
 *   clawbot status   show the bound account
 *   clawbot logout   remove the bound account
 *
 * Credentials are written to the DSH ClawBot state directory
 * (`$CLAWBOT_STATE_DIR` or `$DSH_HOME/clawbot`); a running profile picks them
 * up automatically (the plugin watches the state directory).
 */
import {
  startWeixinLoginWithQr,
  waitForWeixinLogin,
  displayQRCode,
} from "./ilink/auth/login-qr.js";
import {
  saveWeixinAccount,
  clearWeixinAccount,
  listIndexedWeixinAccountIds,
  loadWeixinAccount,
  normalizeAccountId,
} from "./ilink/auth/accounts.js";
import { resolveStateDir } from "./ilink/storage/state-dir.js";
import { logger } from "./ilink/util/logger.js";

const DEFAULT_LOGIN_TIMEOUT_MS = 8 * 60_000;

function usage(): void {
  process.stdout.write(
    `ClawBot — WeChat bridge for DeepSeek Harness (wechat-clawbot)

用法:
  clawbot login [--timeout-ms <ms>]   扫码登录微信
  clawbot status                      查看当前绑定的账号
  clawbot logout                      解除绑定并删除凭据

环境变量:
  CLAWBOT_STATE_DIR   状态目录（默认 $DSH_HOME/clawbot，DSH_HOME 默认 ~/.dsh）
  CLAWBOT_LOG_LEVEL   debug|info|warn|error（默认 info）
`,
  );
}

async function cmdLogin(timeoutMs: number): Promise<number> {
  process.stdout.write("正在向微信服务器申请二维码…\n");
  const start = await startWeixinLoginWithQr({
    verbose: true,
    apiBaseUrl: "https://ilinkai.weixin.qq.com",
  });
  if (!start.qrcodeUrl) {
    process.stderr.write(`登录失败: ${start.message}\n`);
    return 1;
  }

  await displayQRCode(start.qrcodeUrl);
  process.stdout.write("\n请用手机微信「扫一扫」扫描上方二维码。\n");

  const result = await waitForWeixinLogin({
    sessionKey: start.sessionKey,
    apiBaseUrl: "https://ilinkai.weixin.qq.com",
    timeoutMs,
    verbose: true,
  });

  if (result.alreadyConnected) {
    process.stdout.write(`✅ ${result.message}\n`);
    return 0;
  }
  if (!result.connected || !result.botToken || !result.accountId) {
    process.stderr.write(`登录失败: ${result.message}\n`);
    return 1;
  }

  const accountId = normalizeAccountId(result.accountId);
  saveWeixinAccount(accountId, {
    token: result.botToken,
    baseUrl: result.baseUrl,
    userId: result.userId,
  });

  process.stdout.write(
    `✅ ${result.message}\n` +
      `   botId:   ${accountId}\n` +
      (result.userId ? `   绑定用户: ${result.userId}\n` : "") +
      `   凭据已保存: ${resolveStateDir()}\n` +
      `\n现在打开微信，找到联系人「微信ClawBot」，发消息即可对话。\n`,
  );
  return 0;
}

function cmdStatus(): number {
  const ids = listIndexedWeixinAccountIds();
  if (ids.length === 0) {
    process.stdout.write("未绑定微信账号。运行 `clawbot login` 开始连接。\n");
    return 1;
  }
  process.stdout.write(`状态目录: ${resolveStateDir()}\n`);
  for (const id of ids) {
    const data = loadWeixinAccount(id);
    process.stdout.write(
      `账号: ${id}\n` +
        `  绑定用户: ${data?.userId ?? "(未知)"}\n` +
        `  登录时间: ${data?.savedAt ?? "(未知)"}\n` +
        `  状态: ${data?.token ? "已连接" : "未配置"}\n`,
    );
  }
  return 0;
}

function cmdLogout(): number {
  const ids = listIndexedWeixinAccountIds();
  if (ids.length === 0) {
    process.stdout.write("未绑定微信账号，无需登出。\n");
    return 1;
  }
  for (const id of ids) clearWeixinAccount(id);
  process.stdout.write(`已解除绑定（${ids.join(", ")}）。\n`);
  return 0;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const cmd = argv[0] ?? "";
  switch (cmd) {
    case "login": {
      let timeoutMs = DEFAULT_LOGIN_TIMEOUT_MS;
      const tIdx = argv.indexOf("--timeout-ms");
      if (tIdx >= 0 && argv[tIdx + 1]) {
        const parsed = Number(argv[tIdx + 1]);
        if (Number.isFinite(parsed) && parsed > 0) timeoutMs = parsed;
      }
      return cmdLogin(timeoutMs);
    }
    case "status":
      return cmdStatus();
    case "logout":
      return cmdLogout();
    default:
      usage();
      return cmd ? 2 : 0;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    logger.error(`clawbot: ${String(err)}`);
    process.exitCode = 1;
  });
