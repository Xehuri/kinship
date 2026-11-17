---
name: qq-cli
description: Use for QQ operations in this deployment through the backend QQ gateway (send text/files/stickers/pokes, read history or unread, contacts, QZone). Replaces qq-mcp. Prefer `qq send`, `qq send-file`, and `qq history`; use `qq call <tool>` for the rest; run `qq tools` to list all operations.
---

# QQ CLI（替代 qq-mcp）

> 本目录是模板化的技能说明：群号、QQ 号一律是 `<群号>` / `<QQ号>` 占位符，实际调用时换成自己的数字。网关部署见项目仓库 `docs/dev/qq-gateway.md`。

## 何时用

- 所有 QQ 相关操作：发消息、发文件、发表情包、戳一戳、读历史或未读、好友与群、QZone。
- 收到 `【QQ群聊·定向提醒】...`：先当通知，不要直接回复；要看再用 `qq history`。
- qq-mcp 已从运行时撤下，不再有 `mcp_qq-mcp_*` 工具。

## 入口

- 项目根的 `qq` 包装脚本调用 `{AI目录}/skills/qq-cli/qq_cli.py`；解释器用 `QQ_CLI_PYTHON` 覆盖，后端目录用 `QQ_CLI_BACKEND` 覆盖。
- 读写都走网关 IPC，不直连 NapCat。
- 默认配置（都可用环境变量覆盖）：

| 项 | 默认值 | 覆盖变量 |
|---|---|---|
| 网关 IPC | `http://127.0.0.1:8770` | `QQ_GATEWAY_MCP_BASE_URL` |
| 网关 token | `/etc/qq-gateway/mcp.token` | `QQ_GATEWAY_MCP_TOKEN_FILE` |
| 后端目录 | 由脚本位置推出的 `backend/` | `QQ_CLI_BACKEND` |

## 常用命令

```bash
qq send --group <群号> --text "在"
qq send --friend <QQ号> --text "晚安"
qq send --group <群号> --input - <<'JSON'
[{"type":"text","data":{"text":"在"}}]
JSON

qq send-file --group <群号> --file /path/pic.png
qq history --group <群号> --unread --compact
qq history --group <群号> --unread --compact --mark-read
qq tools
```

- `--unread` 会自动下载图片/文件，并在 `[图片]` / `[文件:...]` 后附本地绝对路径；`--json` 每条消息带 `media` 数组。下载失败只保留占位符，不影响文字历史。

## @ 人（已实测可用）

```bash
qq send --group <群号> --input - <<'JSON'
[{"type":"at","data":{"qq":"<成员QQ号>"}},{"type":"text","data":{"text":" 你说的那个镜像问题"}}]
JSON
```

- `--text` 里塞 `\n` 不会变成换行，要真换行用 `$(printf '第一行\n第二行')` 或者 `--input` 数组。
- `--text` 里写 `@123456` 只是纯文本；真 @ 必须走 `--input` 的 `at` 节点。
- 群成员 uid 从 `qq history --compact` 每行的 `昵称(uid)` 里取。

## 群提醒（water）状态

```bash
qq water on --group <群号> --ttl 30m --threshold 12
qq water off --group <群号>
qq water mute --group <群号>
qq water status --group <群号>
qq water list --json
```

- `mentions`（默认）：只有 @、叫名字或引用消息才提醒。
- `water`：按打分自动提醒，同一群 60 秒冷却；`--ttl` 到期后自动回到 `mentions`，单位 s/m/h/d，默认 `30m`；`--threshold` 是 0..100 的提醒分数阈值，默认 `12`。
- `mute`：不发任何提醒。
- 中继缓存状态约 5 秒，改动不会立即生效。
- `status` / `list` 支持 `--json`，输出原始 `data`。

## 其余操作

`qq tools` 列出全部操作和字段；用 `qq call` 调用：

```bash
qq call qq_send_poke --input '{"user_id":"<QQ号>","group_id":"<群号>"}'
qq call qq_set_msg_emoji_like --input '{"message_id":"123","emoji_id":"1"}'
qq call qq_list_stickers --input '{}'
qq call qq_send_sticker --input '{"message_type":"group","target_id":"<群号>","res_id":"..."}'
qq call qq_get_qzone_feeds --input '{"target_qq":"<QQ号>","limit":10}'
```

- `--input -` 从 stdin 读 JSON，避免 shell 引号问题。
- 参数由 Pydantic 校验；错误以 `qq: ...` 输出。
- `--format json` 或 `--json` 用于结构化输出。

## QQ 回复纪律

- QQ 来源的轮次必须用 `qq send`、`qq send-file` 或 `qq call qq_send_sticker` 实际发出；只写文字不算送达。
- 发送后核对返回的 `real_seq`。
- 提醒只是提醒，不是聊天消息；看完再决定回不回。

## 谁在说话

`qq history --compact` 每行格式是 `[时间] 昵称(uid) id=消息id: 正文`，`[我]` 表示自己发的。

- 引用消息里 `[引用 ...]` 后面接的是引用内容，不是本条发言；判断谁说的看行首昵称。
- 同一个群里可能有同名的人或引用消息，先看清 uid 再回。
- 分不清谁是谁就沉默；猜错比不说话更糟。
