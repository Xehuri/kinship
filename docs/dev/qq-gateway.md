# QQ Gateway（单 WebSocket 网关）

## 目标

把 `qq_private_relay.py` 的收件、`qq` CLI 的发送、以及散落的 NapCat HTTP 查询收成一个常驻服务：

```
QQ ←→ NapCat ←— 唯一一条 forward WS —→ backend/services/qq_gateway
                                             ├─ SQLite inbox/outbox/read-state/water-state
                                             ├─ 转发展开 / 渲染 / 媒体下载
                                             └─ 127.0.0.1:8770 ← Bearer token ← qq CLI（ai/skills/qq-cli）
```

- 一个账号一条 WS；CLI 不再直连 NapCat。
- 跨平台：loopback TCP + Bearer token，不使用 UDS、`uvloop`、`flock`。
- 默认关闭，`qq_gateway.enabled` 打开后才启动；本部署 `config.yaml` 已设 `enabled: true`（生产启用）。

## 代码位置

```
backend/services/qq_gateway/
  config.py      配置 dataclass + 校验
  transport.py   单 WS、echo/pending、stream 聚合、重连、心跳
  store.py       SQLite 事件/去重/outbox/action ledger
  router.py      message/notice/request/meta 分类与白名单
  render.py      消息段渲染
  media.py       图片/文件下载、GIF magic-byte 识别
  forward.py     get_forward_msg 归一化、递归展平
  actions.py     发送/文件/戳/表情/历史 + retcode/限流
  stickers.py    收藏表情列表/发送/保存/修改/删除
  qzone_parse.py QZone JSONP/动态/评论解析、Cookie 解析、djb2 g_tk
  qzone_client.py QZone 动态/评论/回复/删除评论/点赞 HTTP 客户端
  qzone.py       QZone 能力门禁、Cookie 缓存、读写限速
  delivery.py    按序投递 loom，失败重试
  ipc.py         127.0.0.1 + Bearer token 的 HTTP action 面
  service.py     生命周期、事件编排、健康状态
  __main__.py    独立进程入口
backend/services/qq_mcp_server.py   qq CLI 实现库（只调 IPC；MCP 已退役）
ai/skills/qq-cli/qq_cli.py          qq CLI 入口
ai/skills/qq-cli/SKILL.md           qq CLI 使用说明
```

## 配置

在项目根 `config.yaml`（gitignored）增加：

```yaml
qq_gateway:
  enabled: false
  mode: lifespan
  account:
    self_qq: "1234567890"
    peer_allowlist: ["1000000001"]
    ws_url: ws://127.0.0.1:3001
    ws_token_env: NAPCAT_WS_TOKEN
    ws_token_file: ""
  inbound:
    private: true
    groups: false
    group_allowlist: []
    require_at: true
    shadow: false
  outbound:
    enabled: true
    dry_run: false
  forward:
    enabled: true
    max_depth: 3
    max_nodes: 200
    max_chars: 8000
  media:
    dir: ai/data/qq_gateway/media
  delivery:
    session: main-task
  mcp:
    enabled: false
    host: 127.0.0.1
    port: 8770
    token_env: QQ_GATEWAY_MCP_TOKEN
    token_file: ""
```

完整键见 `config.example.yaml` 的 `qq_gateway` 段。

以上是模板默认值；当前生产运行态见下文“当前运行态”。

静态配置改完需要重启 backend；`get_config()` 是 `lru_cache`，不会热加载。

## 启动

1. 备份 `config.yaml`。
2. 填 `account.self_qq`、`peer_allowlist`、`ws_url`、token 来源。
3. 生成 IPC token：

```bash
python3 -c 'import secrets; print(secrets.token_urlsafe(48))'
sudo install -d -m 750 -o xehuri -g xehuri /etc/kinship-qq-gateway
sudo sh -c 'umask 077; cat > /etc/kinship-qq-gateway/mcp.token'
sudo chown xehuri:xehuri /etc/kinship-qq-gateway/mcp.token
sudo chmod 600 /etc/kinship-qq-gateway/mcp.token
```

4. `qq_gateway.mcp.token_file` 指向该文件；`mcp.enabled: true`。
5. `qq_gateway.enabled: true`。
6. 重启 backend（生产走 `POST /api/screen/restart`）。
7. 验证：

```bash
TOKEN=$(cat /etc/kinship-qq-gateway/mcp.token)
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8770/v1/health
```

## qq-mcp 退役（2026-10-24）

Loom 的 `ai/.loom/config.yaml` 已移除 `qq-mcp` 条目；Loom 不再加载 23 个 MCP 工具。QQ 操作统一走 `qq` CLI（`ai/skills/qq-cli/`），CLI 经同一网关 IPC 调用。`backend/services/qq_mcp_server.py` 保留为 CLI 的实现库，不再作为 MCP 服务注册。

回滚：恢复 `ai/.loom/config.yaml.bak-qqcli-<时间戳>` 并重启 Loom。

## IPC 已读水位（read-state）

未读水位存在网关 SQLite `cursors` 表（`account=default`），MCP 未读工具与 `qq` CLI 共用，不再是 MCP 进程各自的本地状态。

- `GET /v1/read-state?chat_type=group|friend&target=<id>`：Bearer 认证，返回 `{ok:true,data:{chat_type,target,last_time,last_message_id}}`；无记录时 `last_time=0`、`last_message_id` 为空串。
- `POST /v1/read-state`：body 为 `{chat_type,target,last_time,last_message_id}`，按 `(account,chat_type,target)` upsert。
- 只有 `mark_read` / `--mark-read` 会推进水位；单纯查询未读不改。

## 水群模式（water-state）

每个群的水群状态存在网关 SQLite（`account=default`），relay 据此决定要不要发定向提醒。

- `GET /v1/water-state?group_id=<id>`：Bearer 认证，返回 `{ok:true,data:{group_id,mode,threshold,water_until,last_wake_at,updated_at}}`；无记录时返回默认值 `mode=mentions`、`threshold=12`、`water_until=0`、`last_wake_at=0`。
- `GET /v1/water-state`：不带 `group_id`，返回全部群的状态列表。
- `POST /v1/water-state`：body 为 `{group_id,mode?,threshold?,water_until?,last_wake_at?}`，按群 upsert，未给的字段保持原值。

CLI：

```bash
qq water on --group 1000000002 --ttl 30m --threshold 12
qq water off --group 1000000002
qq water mute --group 1000000002
qq water status --group 1000000002
qq water list
```

语义：

- `mentions`（默认）：只在 @我、叫“小贺”、引用我时发定向提醒。
- `water`：普通消息按类型 × 发送者权重打分，300 秒衰减半衰期；分数达到 `threshold` 且本群 60 秒冷却已过时自动发提醒；@/喊名/引用不受分数与冷却限制。
- `mute`：不发任何提醒。
- `water_until` 是绝对过期时间（Unix 秒）；过期后 relay 回落到 `mentions`，群内 30 分钟无消息也回落。
- relay 对状态约 5 秒缓存，CLI 改完不会立刻生效。
- 自动提醒不含正文，只报分数/阈值和 `qq history` 命令。

## qq CLI

`qq`（仓库根可执行脚本，实现位于 `ai/skills/qq-cli/qq_cli.py`）是网关 IPC 的薄客户端，覆盖全部 23 个 QQ 操作，不直连 NapCat。token 取 `QQ_GATEWAY_MCP_TOKEN_FILE`（默认 `/etc/kinship-qq-gateway/mcp.token`），IPC 地址默认 `http://127.0.0.1:8770`。

```bash
qq tools
qq send --group 1000000002 --text "在"
qq send-file --group 1000000002 --file /path/pic.png
qq call qq_send_poke --input '{"user_id":"1000000001","group_id":"1000000002"}'
qq history --group 1000000002 --unread --compact
qq history --group 1000000002 --unread --compact --mark-read
qq history --friend 1000000001 --unread --compact
```

`qq tools` 列出全部操作和字段；`qq call <tool> --input <json|->` 调用其余操作，`--input -` 从 stdin 读 JSON。默认 Markdown 文本；结构化输出加 `--json`（等价 `--format json`）。`--unread` 按上节水位过滤，`--mark-read` 显式推进水位。

`--unread --compact` 会自动为图片/文件调用网关 `/v1/media`，把媒体下载到 `qq_gateway.media.dir`（默认 `data/qq_gateway/media/`），并在 `[图片]` / `[文件:name]` 后附本地绝对路径；`--json` 的每条消息额外带 `media` 路径数组。媒体下载失败只保留占位符，不影响文字历史。

## 私聊提醒契约（2026-10-30）

私聊不再把正文投给 Loom。relay 只发一条元数据提醒：

```text
【QQ私聊·提醒】<昵称>(<QQ>) <HH:MM>（N 条，仅补漏合并时出现）
有新的私聊消息未看（这是提醒，不是聊天消息；必须先看再回）
第一步（必须，先调用一次工具）：qq history --friend <QQ> --unread --compact
第二步（必须）：qq send --friend <QQ> --text "..."
只在网页回复视为未回复。
```

- 提醒不含正文、图片或文件；Loom 必须先调用 `qq history --friend <QQ> --unread --compact`，再用 `qq send` 回复。
- 重连补漏按发送者合并为一条，带 `（N 条）`。
- 图片/文件由 `qq history --unread --compact` 下载并返回本地绝对路径，规则同下节。

## 群聊提醒契约

群消息不把正文投给 Loom。relay 命中 @我、引用我或文本含“小贺”时，只发一条元数据提醒：

```text
【QQ群聊·定向提醒】群<id> <昵称>(<QQ>) <HH:MM>（@我|喊小贺|引用我）
有新的定向消息未看（这是提醒，不是聊天消息；不回也行，要回先看）
查看：qq history --group <id> --unread --compact
```

- 自动提醒（water 模式）每群每 60 秒最多一块；@/喊名/引用不受 60 秒窗口限制，但 1 秒内合并。
- 只被 @全体成员不算定向，不触发。
- 提醒不含正文。Loom 收到后按提示命令拉未读，再决定读不读、回不回。
- 图片/文件不随提醒发送；拉未读时由网关下载并返回本地绝对路径，Loom 可直接用 `read` 打开。

## 当前运行态（2026-10-30）

- `enabled: true`
- `inbound.shadow: true`：只连、只计数，不投递 Loom；`inbound.groups: false`
- `outbound.enabled: true`、`outbound.private: true`、`outbound.groups: true`，群白名单 `["1000000002"]`
- qq-mcp 已退役；23 个操作由 qq CLI 覆盖（`qq tools`）
- QZone：`enabled: true`、`mode: http_sidecar`、`allow_read: true`、`allow_send: true`、`allow_delete: true`，写入 10 次/小时
- relay 仍在跑并承担入站：私聊仅发元数据提醒（`【QQ私聊·提醒】`，不含正文；Loom 调 `qq history --friend <QQ> --unread --compact` 后回复）；群聊仅 @我/引用我/文本含“小贺”时发元数据提醒（不含正文）；water 模式按评分自动提醒（每群 60 秒），mute 不发；详见“私聊提醒契约”“群聊提醒契约”与“水群模式”
- `ss -tnp | grep :3001` 应只有两条：gateway + relay

## QQ 操作（23 个，qq CLI 覆盖）

| 类别 | 工具 |
|---|---|
| 发送 | `qq_send_message`、`qq_send_file`、`qq_send_poke` |
| 查询 | `qq_get_friends`、`qq_search_friend`、`qq_get_group_msg_history`、`qq_get_login_info`、`qq_get_file`、`qq_get_forward_msg`、`qq_get_msg`、`qq_get_friend_msg_history` |
| 表情回应 | `qq_set_msg_emoji_like` |
| 收藏表情 | `qq_list_stickers`、`qq_send_sticker`、`qq_save_sticker`、`qq_update_sticker`、`qq_delete_sticker` |
| QQ 空间 | `qq_get_qzone_feeds`、`qq_get_qzone_comments`、`qq_comment_qzone`、`qq_reply_qzone_comment`、`qq_delete_qzone_comment`、`qq_like_qzone` |

以上操作由 `qq call <tool> --input <json|->` 调用；`qq tools` 输出名称和字段。

私聊与白名单群（`1000000002`）发送可用；非白名单群返回 `1403`。

历史工具支持 `compact: true`：群/好友历史按 `[时间] 昵称(QQ) id=...: 正文` 每行一条输出，并自动带 `parse_mult_msg: false`、`disable_get_url: true`；默认 `false` 保持原始 JSON。

历史工具支持 `unread_only: true`：按网关共享的已读水位（见“IPC 已读水位”）只返回水位之后的消息；`mark_read: true` 推进水位，`count_only: true` 只返回数量，`since_minutes` 叠加时间窗。未读是 AI 侧水位，不是 QQ 客户端未读。

## 切流顺序

1. **shadow**：`enabled: true`，`inbound.shadow: true`，`outbound.enabled: false`。只连、只落库、不投递、不发。
2. 对比 relay 日志与网关计数 30 分钟。
3. 停 relay（任务 frontmatter `enabled: false` 或移出任务目录），重启任务 runner。
4. 确认 `qq tools` / `qq call qq_get_login_info` 可用，重启 Loom 加载 `qq-cli` skill。
5. `inbound.shadow: false`、`inbound.deliver: true`、`outbound.enabled: true`，重启 backend。
6. 验证 `ss -tnp | grep :3001` 只有网关一个客户端；发一条唯一标记消息，确认只收到一次。
7. 停 `run-bot.service`（mybot-web 旧数据面）。

回滚：`enabled: false` → 重启 backend；若要恢复 qq-mcp 面，恢复 `ai/.loom/config.yaml.bak-qqcli-<时间戳>` 并重启 Loom。

## Windows 部署

- IPC 只用 `127.0.0.1:8770` + Bearer token；不要用 UDS。
- 单实例锁用 `filelock`，不要 `fcntl.flock`。
- 不要用 `uvloop`；标准 `asyncio` + `aiohttp`。
- 服务包装用 WinSW/NSSM，代码仍是 `python -m services.qq_gateway`。
- token 文件放 `%LOCALAPPDATA%\axeuh-qq-gateway\mcp.token`，用 `icacls` 限制当前用户。
- 路径用 `pathlib.Path`；配置里允许反斜杠。

## QZone

QZone 能力走独立 HTTP sidecar：`qzone_client.py` 直接请求 QZone Web CGI，鉴权用 NapCat `get_cookies` 取回的 Web cookies 与 `g_tk`。NapCat 原生 QZone action 只有 `send_qzone_msg`/`delete_qzone_msg`，读动态、评论、点赞都缺，所以不走原生 action。

范围：

- 读：动态列表、单条说说的评论。
- 写：评论、回复评论、删除评论、点赞。
- 不做：发布/删除说说、取消点赞、图片上传。删除评论由独立开关 `allow_delete` 控制（`qq_delete_qzone_comment`），与评论/回复/点赞的 `allow_send` 分离。

### 配置

```yaml
qq_gateway:
  qzone:
    enabled: false
    mode: http_sidecar   # 仅 http_sidecar 已实现；native / snowluma 保留未实现
    allow_read: false    # 读总闸：动态流 / 评论读取
    allow_send: false    # 写总闸：评论 / 回复 / 点赞
    allow_delete: false  # 删除评论总闸；还需 qzone.enabled + http_sidecar + outbound.enabled
    rate_per_hour: 5     # 写操作上限（次/小时），最小 1
```

- 读另有内部固定上限 30 次/分，不受 `rate_per_hour` 影响。
- 写还受 `outbound.enabled` 与 `outbound.dry_run` 约束。
- 静态配置改完需重启 backend；`get_config()` 是 `lru_cache`，不会热加载。

### 门禁矩阵

| 条件 | 读工具 | 写工具 | 删除评论 |
|---|---|---|---|
| `qzone.enabled: false` | `1403` | `1403` | `1403` |
| `qzone.mode` 不是 `http_sidecar` | `1403` | `1403` | `1403` |
| `qzone.allow_read: false` | `1403` | `1403` | 正常 |
| `qzone.allow_send: false` | 正常 | `1403` | 正常 |
| `qzone.allow_delete: false` | 正常 | 正常 | `1403` |
| `outbound.enabled: false` | 正常 | `1403` | `1403` |
| `outbound.dry_run: true` | 正常 | 返回 `dry_run`，不发 HTTP，不占写配额 | 同左 |
| 读超过 30 次/分 | `1200` | 不适用 | 不适用 |
| 写超过 `rate_per_hour` | 不适用 | `1200` | `1200` |

门禁在参数解析之后、任何网络请求之前执行。写操作先过 `dry_run` 分支，再检查写配额；所以 `dry_run` 不消耗配额。

### Cookie 与鉴权

- 缓存未命中时调 NapCat `get_cookies`，domain 固定 `user.qzone.qq.com`。
- `g_tk` 优先用 NapCat 返回的 `bkn`；没有 `bkn` 时对 `p_skey`（回退 `skey`）做 DJB2 取低 31 位。
- cookie 里的 `uin`/`p_uin` 去掉前导 `o`/`0` 后必须等于 `account.self_qq`，否则返回 `1409`，避免拿错号写操作。
- 鉴权信息只放内存，TTL 30 分钟。读请求遇到 `1401` 会强制刷新 cookie 并只重试一次；写请求不自动重试。
- 日志只记录 operation/status/duration/count，不记录 cookie、内容、QQ 号；httpx 中含 `user.qzone.qq.com` 的请求行被过滤器丢弃。

### 返回形状

`qq_get_qzone_feeds`：

```json
{
  "target_qq": "123456789",
  "count": 1,
  "feeds": [
    {
      "tid": "<tid>",
      "created_time": 1700000000,
      "created_at": "2026-10-21T12:00:00+08:00",
      "content": "<content>",
      "images": ["<url>"],
      "videos": [],
      "repost": null,
      "comment_count": 2,
      "has_more_comments": false,
      "comments": [
        {
          "comment_id": "<comment_id>",
          "uin": "<uin>",
          "nick": "<nick>",
          "content": "<comment>",
          "created_time": 1700000000,
          "created_at": "2026-10-21T12:00:00+08:00",
          "parent_id": null,
          "replies": []
        }
      ],
      "uin": "<uin>"
    }
  ]
}
```

`qq_get_qzone_comments` 命中时返回 `target_qq`、`tid`、`found: true`、`comments`、`comment_count`；未命中返回 `found: false`、空 `comments` 和本次扫描窗口 `scanned`。评论按 `list_3` 展平：子回复紧跟父评论，`parent_id` 指向父评论的 `comment_id`。

写工具成功时返回：

- 评论：`success`、`target_qq`、`tid`、`content_length`、`code: 0`。
- 回复：在评论字段基础上多一个 `comment_id`。
- 删除评论：`success`、`target_qq`、`tid`、`comment_id`、`comment_uin`（缺省为机器人账号 uin）、`code: 0`。
- 点赞：`success`、`target_qq`、`tid`。

`outbound.dry_run: true` 时返回 `{"dry_run": true, "action": "...", "target_qq": "...", "tid": "...", "content_length": N}`；点赞分支没有 `content_length`；删除评论分支没有 `content_length`，多一个 `comment_id`。

### 限制

- `limit` 与 `scan` 的有效区间是 1..20。MCP 参数校验直接拒绝越界值，IPC 路径在服务层夹到 1..20。
- `scan` 的含义是“在前 N 条动态里找这条说说的评论”，不是评论分页。tid 不在最近 N 条里时返回 `found: false`。
- LIST 固定 `replynum=100`、`pos=0`，没有翻页。单条说说最多看到前 100 条评论，更早的动态和评论拿不到；`has_more_comments` 只透传，不提供翻页。
- 评论可能为空，即使 `comment_count` 大于 0。可见性由 QZone 服务端决定，好友关系、私密/密码说说、权限设置都会影响返回；客户端不做二次权限判断。
- `comment_uin` 与 `comment_nick` 同时提供时回复不扫描动态；缺省时服务层固定扫最近 10 条动态来定位评论者，找不到返回 `1404`。这两个字段不影响 `qq_get_qzone_comments` 的 `scan`。
- 评论/回复表单用 `format=json`（与 SnowLuma 一致），删除评论用 `format=fs`。写响应解析先走严格 JSON/JSONP/frame，失败后回退正则从 JS 对象字面量（无引号 key、单引号、`undefined`、包裹 HTML）提取 `code`/`subcode`/`message`；只有 `code` 缺失才判 `1402`，绝不把无 `code` 的响应当成功。
- 写请求没有重试。超时按 indeterminate 处理，可能已经生效；不要盲目重发。HTTP 302/401 映射 `1401`，429 映射 `1200`，其他非 2xx 或业务 `code != 0` / `subcode` 非 0 映射 `1402`。成功判定为 `code=0` 且 `subcode=0`（缺省视为 0）。
- 删除评论需要 `target_qq`、`tid`、`comment_id`，`comment_uin` 缺省用机器人账号 uin（评论作者 uin 可从 `qq_get_qzone_comments` 取得）；删除与评论/回复/点赞共用 `rate_per_hour` 写配额。
- 连续写可能触发 QZone 风控。遇到 `1200`/`1401`/`1402` 应停写并检查账号状态，不要把 `rate_per_hour` 调高来硬闯。
- QZone 是私有 Web CGI/JSONP 接口，字段和返回结构可能无预告变化。

### 只读验证

token 从 `/etc/kinship-qq-gateway/mcp.token` 读取。以下命令只读，不要调用 `qq_comment_qzone`、`qq_reply_qzone_comment`、`qq_delete_qzone_comment`、`qq_like_qzone`。

IPC：

```bash
TOKEN=$(cat /etc/kinship-qq-gateway/mcp.token)
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:8770/v1/qzone/feeds?target_qq=123456789&limit=3"
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:8770/v1/qzone/comments?target_qq=123456789&tid=<tid>&scan=5"
```

`qq` CLI（先列操作，再读动态）：

```bash
cd /opt/kinship
./qq tools
./qq call qq_get_login_info --input '{}'
./qq call qq_get_qzone_feeds --input '{"target_qq":"123456789","limit":3,"response_format":"json"}'
```

`qq tools` 应列出 23 个操作。读动态会走真实 QZone 请求，目标号必须是机器人账号可见的账号，否则可能返回空列表或权限错误。

### 回滚

把 `qq_gateway.qzone.enabled` 改为 `false`（或 `mode: off`），重启 backend。cookie 只在内存，无落盘状态需要清理；已经发出的评论/回复/删除评论/点赞不会回滚。

## 收藏表情

- `qq_list_stickers` 默认输出精简文本（`res_id | 备注 | 用法`），不默认输出 JSON。
- `qq_save_sticker` 支持 `note`（写入 QQ 收藏描述）和 `usage`（写入本地 `sticker_meta`）。
- `qq_update_sticker` 可改 `note` / `usage`；只传一个时另一个保持原值。
- `qq_delete_sticker` 调 NapCat `delete_custom_face` 并清理本地元数据。
- 列表是**机器人账号**的收藏，不是主号个人收藏。
- 商城表情搜索、作者/来源字段当前不可用。
- 保存 GIF 到收藏时 QQ 可能转成静态 `.jpg`；要保留动画优先直接 `qq call qq_send_sticker --input '{"message_type":"group","target_id":"...","file_path":"..."}'`。

## 已知边界

- QZone 走 HTTP sidecar（Web cookies + `g_tk`），不是 NapCat action：只支持读动态/评论和评论/回复/删除评论/点赞，不支持发布/删除说说、取消点赞/传图；NapCat 原生 `send_qzone_msg`/`delete_qzone_msg` 未接入，`mode: native`/`snowluma` 保留未实现。
- 合并转发：`get_forward_msg` 返回 `OB11Message[]`，回发前要转 `node[].data.content`。
- `set_msg_emoji_like` 只认消息短 ID；`file_id` 是 24 小时/5000 条内存缓存，不能持久化。
- 申请事件默认只记录不自动同意；群消息默认关闭且要求 @。
- 媒体下载受 `media.max_mb` 限制；大文件优先传路径/URL，不要 base64。

## relay wrapper 孤儿风险

`ScriptRunner` 会为 `qq_private_relay.py` 生成一个 `wrapper_QQ私聊转发_*.py` 进程；真正连 NapCat 的是这个 wrapper。

`POST /api/screen/restart` 已修复为：先 `await ScriptRunner.stop()`，等待当前脚本（包括 relay wrapper）终止，再执行 `os._exit(0)`。因此正常 HTTP 重启不会再留下 `ppid=1` 的 wrapper。`ScriptRunner` 的 `_check_processes` 与 `_restart_script` 也加了 `_running` 守卫，避免停机窗口内被 monitor 线程重新拉起。

仍存在的边界：

- SIGKILL、OOM、主机断电等硬崩溃不会经过 shutdown，仍可能留下孤儿 wrapper。
- 修复前已经存在的历史孤儿不在 `ScriptRunner._processes` 中，不会被自动回收；只能按 PID 人工处理。
- stop 是同步等待，`stop_all` 串行执行，每个脚本最坏约 8 秒（5s 优雅 + 3s kill），期间事件循环阻塞。

排查：

```bash
ps -eo pid,ppid,lstart,cmd | grep wrapper_QQ私聊转发
ss -tnp | grep :3001
```

健康状态应只有“一个 wrapper 子进程 + gateway”两条 WS。切 relay 前确认没有 `ppid=1` 的历史 wrapper。

## 测试

```bash
cd backend
/opt/kinship/.venv-health/bin/python -m pytest tests/test_qq_gateway_*.py tests/test_qq_mcp_*.py -q
```

当前：**129 passed**。

QZone 相关分文件计数：`test_qq_gateway_qzone_parse.py` 25、`test_qq_gateway_qzone_client.py` 30、`test_qq_gateway_qzone.py`（服务层）31、`test_qq_gateway_ipc.py` 3、`test_qq_mcp_qzone.py` 7。

覆盖：echo/乱序/stream/断线、SQLite 去重/重启、路由矩阵、3 层转发展开、retcode/dry-run/indeterminate、收藏表情 list/save/update/delete、QZone JSONP/动态/评论解析（含宽松 JS 字面量回退）、Cookie 缓存与 g_tk、读写/删除门禁与限速、评论/回复/删除评论/点赞请求体、IPC 401/200 与 QZone 错误信封、MCP QZone 工具参数映射、fake NapCat → fake loom 端到端。
