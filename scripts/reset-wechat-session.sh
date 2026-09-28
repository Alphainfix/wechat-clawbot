#!/bin/bash
# wechat-clawbot 一键重置脚本(保留 memory)
#
# 做什么:
#   - 删除微信会话历史(session*.jsonl.zstd,含 v3 等带版本号的文件名)→ bot 完全失忆
#   - 删除会话创建标记 → 下次启动创建全新会话
#   - 删除 inbound 原始日志(含隐私内容)
#   - 保留:memory.md(长期记忆)、账号凭证(不用重新扫码)、quote-history(引用解析)
#
# 注意:
#   - 定时提醒:DSH 0.1.7-rc.2 起存在宿主任务表里($DSH_HOME/storages/schedule.json),
#     按会话 id 绑定 —— 重置后新会话还叫 wechat-main,提醒照常送达,不受影响。
#     更早的宿主把提醒存在会话历史里,会随重置一起清除;脚本会把它们列出来,
#     重置后让 bot 重新设一次。**不再写进 memory.md**:一次性提醒不进长期记忆
#     (0.9.5 起 memory 直接拒收「提醒事项」,以前那段迁移其实一直在静默写 0 条)。
#   - 必须先退出 GUI(terminal 里的 dsh web)再运行本脚本。
#
# 用法:
#   bash scripts/reset-wechat-session.sh
set -euo pipefail

DSH_HOME="${DSH_HOME:-${HOME}/.dsh}"
STATE_DIR="${CLAWBOT_STATE_DIR:-${DSH_HOME}/clawbot}"
SESSIONS_DIR="${DSH_HOME}/sessions"
# 会话按启动时的 cwd 分桶,桶名是把路径里的 / 换成 -,首尾各加 --。
# 小鲸鱼从 $HOME 启动,所以推导出来就是它那个桶 —— 别写死用户名,换台机器就错。
WHALE_SCOPE="--$(printf '%s' "${HOME#/}" | tr '/' '-')--"

echo "=== 0. 安全检查:确认 DSH 已退出 ==="
# 看端口,不看 pgrep -f:后者会匹配到任何命令行里带 "dsh web" 的进程(包括正在
# grep 它的那条命令),判断会被骗。小鲸鱼 20 秒内会把 dsh 拉回来,所以要先在
# 小鲸鱼里停掉。
if lsof -nP -iTCP:3080 -sTCP:LISTEN -t >/dev/null 2>&1; then
  echo "✗ 3080 端口上还有 dsh 在跑!请先退出 GUI(Ctrl+C / 小鲸鱼里停止)再运行本脚本。"
  exit 1
fi
echo "  OK:3080 上没有 dsh"

# 会话历史位置(微信会话 cwd = $HOME → 上面推导出的桶)
WECHAT_SESSION_DIR="${SESSIONS_DIR}/${WHALE_SCOPE}/wechat-main"

echo "=== 1. 备份 + 盘点未触发的提醒 ==="
# 文件名带格式版本号:DSH 0.1.5 起是 session.v3.jsonl.zstd,0.1.7 起是 v4,更早是
# session.jsonl.zstd。写死其中一个,换版本之后这个脚本会「成功」但什么都没删。
# v4 旁边还留着 v3 原件(不可变代次),所以取按名字排最后的那个,也就是最新格式。
SESSION_FILE=""
for cand in "${WECHAT_SESSION_DIR}"/session*.jsonl.zstd; do
  [ -f "$cand" ] && SESSION_FILE="$cand"
done
if [ -n "$SESSION_FILE" ]; then
  mkdir -p "${STATE_DIR}/session-backup"
  BK="${STATE_DIR}/session-backup/wechat-main.$(date +%Y%m%d-%H%M%S).jsonl.zstd"
  cp "$SESSION_FILE" "$BK"
  echo "  已备份会话历史 -> $BK"
else
  echo "  无会话历史文件,跳过备份"
fi

# 只列出来,不写 memory。别写死 nvm 的某个版本路径:升级 node 之后那条路径就没了。
NODE_BIN="$(command -v node || true)"
TASKS_FILE="${DSH_HOME}/storages/schedule.json"
PLUGIN_LIB="${DSH_HOME}/profiles/web/node_modules/wechat-clawbot/lib/schedule-migrate.js"
if [ -z "$NODE_BIN" ]; then
  echo "  (没有 node,跳过提醒盘点)"
elif [ -f "$TASKS_FILE" ]; then
  # 0.1.7-rc.2+:宿主任务表。按会话 id 绑定,重置不影响。
  "$NODE_BIN" -e '
    const fs = require("node:fs");
    const tasks = Object.values(JSON.parse(fs.readFileSync(process.argv[1], "utf-8")).tables?.tasks ?? {})
      .filter((t) => t.sessionId === "wechat-main" && t.status === "active");
    console.log(`  宿主任务表里有 ${tasks.length} 条待触发提醒,重置后照常送达:`);
    for (const t of tasks) {
      const when = new Date(t.record.scheduledAt).toLocaleString("zh-CN", { month: "long", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" });
      console.log(`    - ${when}  ${t.record.title}`);
    }
  ' "$TASKS_FILE" 2>/dev/null || echo "  (读宿主任务表失败,不影响重置)"
elif [ -n "$SESSION_FILE" ] && [ -f "$PLUGIN_LIB" ] && command -v zstd >/dev/null 2>&1; then
  # 旧宿主:提醒在会话历史里,会随重置清除。直接流式解压,不落临时文件(那是聊天原文)。
  zstd -dc "$SESSION_FILE" 2>/dev/null | "$NODE_BIN" --input-type=module -e "
    import fs from 'node:fs';
    import { foldLegacyReminders } from '$PLUGIN_LIB';
    const events = [];
    for (const line of fs.readFileSync(0, 'utf-8').split('\n')) { try { events.push(JSON.parse(line)); } catch {} }
    const pending = foldLegacyReminders(events).filter((r) => Date.parse(r.scheduledAt) > Date.now());
    if (pending.length === 0) { console.log('  没有待触发的提醒'); process.exit(0); }
    console.log('  ⚠ 这个 DSH 版本把提醒存在会话历史里,下面 ' + pending.length + ' 条会随重置清除,重置后请让 bot 重新设:');
    for (const r of pending) {
      const when = new Date(r.scheduledAt).toLocaleString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' });
      console.log('    - ' + when + '  ' + r.prompt.slice(0, 60));
    }
  " 2>/dev/null || echo "  (提醒盘点失败,备份仍保留)"
else
  echo "  (跳过提醒盘点:缺少 zstd 或插件)"
fi

echo "=== 2. 删除微信会话历史 + 标记 ==="
# 会话是按启动时的 cwd 分桶的:小鲸鱼从 $HOME 起,手动在别的目录 `dsh web` 就会
# 建出第二个桶。只清小鲸鱼那个桶的话,残留的 session*.jsonl.zstd 会让下一次
# create() 落在一个已存在的会话文件上,agent 建得出来但驱动不启动 —— 消息进了
# inbox 却永远不跑,表现为"收到消息但完全没反应"。所以每个桶都要扫。
for bucket_dir in "${SESSIONS_DIR}"/*/wechat-main; do
  [ -e "$bucket_dir" ] || continue
  for f in "${bucket_dir}"/session*.jsonl.zstd; do
    [ -f "$f" ] || continue
    mkdir -p "${STATE_DIR}/session-backup"
    cp "$f" \
       "${STATE_DIR}/session-backup/wechat-main.$(basename "$(dirname "$bucket_dir")").$(date +%Y%m%d-%H%M%S).jsonl.zstd"
    echo "  额外桶已备份: $(basename "$(dirname "$bucket_dir")") ($(basename "$f"))"
  done
  rm -f "${bucket_dir}"/session*.jsonl.zstd* "${bucket_dir}/session.lock" 2>/dev/null || true
done
rm -f "${STATE_DIR}/sessions/wechat-main.json" 2>/dev/null || true
echo "  已删除全部 cwd 桶下的会话历史与创建标记"

echo "=== 3. 清理 inbound 原始日志(隐私) ==="
rm -f "${STATE_DIR}/inbound-raw.jsonl"* 2>/dev/null || true
echo "  已清理 inbound-raw.jsonl"

echo ""
echo "=== 完成!==="
echo "保留内容:memory.md(长期记忆)/ 账号凭证(免扫码)/ quote-history(引用解析)"
echo "已清除:微信会话历史 / 会话标记 / inbound 日志(定时提醒见上面第 1 步的盘点)"
echo ""
echo "下一步:重新启动 GUI,微信里发一条消息即可开始全新会话。"
