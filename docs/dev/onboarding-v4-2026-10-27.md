# 初始化引导 v4 契约（2026-10-27）

> 状态：**现行唯一契约**。本文描述 v4 的 11 步顺序、state v4 迁移、Xiaomi / QQ / MOSS / Loom setup / finish API，以及 Loom 内联密钥与 MOSS 边界。
> 旧版 onboarding 文档已归档，公开树不包含归档文件。
> 代码真源：`backend/services/onboarding_service.py`、`backend/services/onboarding_finish.py`、`backend/routers/onboarding_xiaomi.py`、`backend/routers/onboarding_qq.py`、`backend/routers/moss.py`、`backend/routers/loom_onboarding.py`、`backend/routers/onboarding_finish.py`。

## 1. 步骤表

v4 共 11 步，顺序固定。`preflight` 与 `startup` 不再是可见步骤，也不再出现在 `STEPS`、步骤状态或前端向导中。

| 序号 | id | 标题 | required | skippable | auth | 配置 / 状态写入 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `welcome` | 欢迎 | true | false | none | 无 |
| 2 | `account` | 管理员账号 | true | false | setup_token | 创建首个管理员，密码哈希写入 `backend/config/auth.json` |
| 3 | `dependencies` | 依赖检查 | true | false | bearer | 记录下载/拒绝选择；下载作业写入运行资产，不写 `config.yaml` |
| 4 | `kernel` | 音频内核 | true | true | password | 安装或复用音频内核；不写 `config.yaml` |
| 5 | `kernel_models` | 内核模型 | true | true | password | 下载/校验模型；可经 storage API 写 `models.dir` |
| 6 | `xiaomi` | 小米健康云 | true | true | password | 写健康云开关与扫码凭据；不启动拉取线程 |
| 7 | `qq` | QQ 网关 | true | true | password | 写 `qq_gateway.*`，token 落独立密钥文件；不启动网关 |
| 8 | `moss` | MOSS 深度音频 | true | true | password | 只写 `moss.enabled`、`moss.base_url`、`moss.model` |
| 9 | `loom` | AI 助手 | true | true | password | 写 `ai/.loom/config.yaml`、`loom.url`、`loom.token_file`、`ai_backend=loom` |
| 10 | `clients` | 客户端 | true | false | bearer | 无；只读取客户端下载目录 |
| 11 | `finish` | 完成 | true | false | bearer | 执行预检、集成校验、启动校验、promote/commit，并记录完成 |

说明：

- `required=true` 表示该步骤必须处于 `completed` 或 `skipped`。`skippable` 只决定是否允许显式记录 `skipped`。
- `auth` 取 `GET /api/system/onboarding/status` 返回的步骤元数据。`password` 指配置写授权：无用户时用 `X-Setup-Token`，已有管理员时用 user Bearer 加当前密码。
- `POST /api/system/onboarding/state` 使用单独的进度写入授权：无用户时用 setup token，已有用户时用 user Bearer，不需要密码。
- `finish` 的步骤元数据 `auth` 为 `bearer`，但唯一写动作 `POST /api/system/onboarding/finish` 走配置写授权，因此实际需要 setup token 或 user Bearer 加当前密码。
- `kernel`、`kernel_models`、`xiaomi`、`qq`、`moss`、`loom` 允许跳过。跳过表示用户明确不配置，不是自动完成。
- `welcome` 是 passive 步骤。后续任一非 passive 步骤推进时，服务端会自动把 `welcome` 补为 `completed`。
- `clients` 是 finish 之前最后一个内容步骤。它不提供 PC 感知采集器内容。

## 2. state v4 与迁移

### 2.1 存储与版本

- 状态文件默认 `backend/data/onboarding_state.json`，可用 `AXEUH_ONBOARDING_STATE` 覆盖，兼容变量 `AEUH_ONBOARDING_STATE` 次之。
- `STATE_VERSION=4`。写入使用同目录 `mkstemp`、`fsync`、`chmod 0600`、`os.replace`、目录 `fsync` 的原子序列。
- 损坏或非 JSON 状态文件会被隔离为 `<name>.corrupt-<时间戳>`，随后返回新的 v4 默认状态。
- v4 状态只保留 `STEPS` 中的 id。未知 id 会被丢弃，重复 id 去重，步骤列表按契约顺序重排，`current_step` 与 `completed` 由服务端重算。
- fresh install 在无状态文件且确认需要创建首个管理员时，会落一份 v4 默认状态。

### 2.2 v3 迁移

v3 的 `preflight` 与 `startup` 退出可见契约：

- 这两个 id 会从 `completed_steps` 与 `skipped_steps` 中移除。
- 对应的 `step_data` 移入 `legacy_step_data`，并追加 `removed_in_v4: true`。
- `step_data` 中只保留 v4 步骤 id 的数据。

v3 已完成安装（`finish` 为 completed 或 skipped）：

- 迁移后 `completed=true`，`current_step=null`。
- 所有 v4 步骤视为已完成，用户原有的 `skipped` 选择保留，但只允许落在可跳过步骤上。
- `xiaomi` 与 `qq` 补记合成数据：`{migrated: true, reason: "v3_upgrade", enabled: false}`。
- 不重新过预检或启动门禁。

v3 进行中安装：

- 已有的 completed/skipped 保留。
- `xiaomi` 与 `qq` 自动记为 `skipped`，避免新插入的可选步骤卡住升级用户。
- `current_step` 按新的 v4 顺序重算。例如原先完成到 `loom`，当前步骤变为 `clients`。
- 因为未完成，`finish` 仍必须真实执行预检、集成校验、启动校验与 promote/commit。

### 2.3 v2 / v1 迁移

v2：

- 与 v3 使用同一收敛规则。已完成 `finish` 的安装直接成为 v4 完成态，`xiaomi` / `qq` 合成数据 reason 为 `v2_upgrade`。
- 未完成的 v2 安装把 `xiaomi` / `qq` 记为 skipped，当前步骤照常重算，例如停在 `finish` 时必须重新走 v4 finish。

v1：

- 先按固定映射收敛：`preflight` → `welcome`，`server` / `ssl` / `ai_backend` / `data` → `dependencies`，`admin` → `account`，`integrations` → `moss`，`clients` → `clients`。
- `finish` 直接丢弃；旧 v1 完成态由 `completed=true` 或 `finish` 记录判定。
- 已完成 v1 安装映射到 v4 完成态；未完成安装只保留可映射步骤，`xiaomi` / `qq` 记为 skipped。
- 迁移会把 `legacy_upgraded` 置为 true，合成数据 reason 为 `v1_upgrade`。
- 没有 `version` 字段的状态文件按 v1 处理。

### 2.4 完成判定

- 服务端以步骤集合计算 `current_step` 与 `completed`。`completed=true` 表示全部 11 步均为 completed 或 skipped。
- 已完成状态的 `finish` 调用是幂等的，返回 `idempotent: true`，不会再次执行门禁。
- 已有用户且没有状态文件的旧安装仍按 legacy 完成处理，避免升级后被强制要求走向导。

## 3. API 契约

### 3.1 通用认证与错误

- 读接口：bootstrap 阶段公开；已有管理员时要求 user Bearer。
- 写接口：bootstrap 阶段要求 `X-Setup-Token`；已有管理员时要求 user Bearer 加请求体 `current_password`（部分旧动作使用 `password`，以各端点说明为准）。
- service/device Token 不能读配置，也不能写配置。
- 响应不得包含 passToken、QQ token、Loom token、provider key 或密钥文件路径。错误消息经 `redact_text` 脱敏。
- 常见错误码：`setup_token_required`、`setup_token_invalid`、`password_required`、`password_invalid`、`token_kind_forbidden`、`auth_required`。

### 3.2 Xiaomi

前缀：`/api/system/onboarding/xiaomi`。

| 方法 | 路径 | 授权 | 请求 | 响应 |
| --- | --- | --- | --- | --- |
| GET | `""` | 读 | 无 | `{enabled, configured, phase, userid_masked, userid_configured, region, last_error, needs_login}` |
| POST | `/config` | 写 | `{enabled, current_password?}` | 状态对象加 `starts_after_finish: true` |
| POST | `/qr` | 写 | `{current_password?}` | `{lp, qr_base64, expires_in, login_url}` |
| POST | `/qr/poll` | 写 | `{lp, current_password?}` | `{state: "waiting"}` 或 `{state: "success", userid_masked, configured}` |

行为与边界：

- `POST /config` 只持久化开关，`start_pull=false`，不启动后台拉取线程，也不发起首次拉取。
- `POST /qr` 申请一次性登录二维码，失败返回 502 `xiaomi_qr_failed`。
- `POST /qr/poll` 单次轮询扫码结果，失败返回 502 `xiaomi_qr_poll_failed`；成功时凭据写入健康云配置，但 `start_pull=false`。
- `phase` 取值包括 `disabled`、`unconfigured`、`auth_expired`、`error`、`ok`、`syncing`。
- `userid` 只返回掩码；`passToken` 永不返回。
- `finish` 时若 `enabled=true` 且 `configured=false`，会产生 blocking 项 `xiaomi_not_configured`。

### 3.3 QQ

前缀：`/api/system/onboarding/qq`。

| 方法 | 路径 | 授权 | 请求 | 响应 |
| --- | --- | --- | --- | --- |
| GET | `""` | 读 | 无 | `{enabled, self_qq, ws_url, ws_token_configured, mcp_token_configured, valid, errors}` |
| POST | `/validate` | 写 | `{enabled, self_qq, ws_url, ws_token?, regenerate_mcp_token?, current_password?}` | `{valid, errors: [{field, message}]}` |
| POST | `/config` | 写 | 同上 | 状态对象加 `starts_after_finish: true` |

行为与边界：

- `/validate` 只读，不创建目录、不写文件、不探测网络。
- `/config` 先校验后写盘，校验失败返回 422 `qq_config_invalid` 且零写入；配置写入失败返回 500 `qq_config_write_failed`。
- WebSocket token 写入 `<data.root>/secrets/qq_ws_token`，并把 `qq_gateway.account.ws_token_file` 指向该文件。
- MCP token 写入 `<data.root>/secrets/qq_mcp_token`，并把 `qq_gateway.mcp.token_file` 指向该文件。
- 密钥文件目录 0700、文件 0600；响应永不返回 token 内容或 token 文件路径。
- 写入新 token 后会清除旧的内联 `qq_gateway.account.ws_token`；MCP token 同样清除旧内联 `qq_gateway.mcp.token`，避免旧值优先级覆盖 token_file。
- 关闭网关时只写 `qq_gateway.enabled=false`，不写其他字段。
- `/config` 不启动网关、不触发配置应用器。网关在 `finish` 后由服务面启动。
- `finish` 时若网关已启用但 `QQGatewayConfig.validate()` 报错，会产生 blocking 项，错误按字段映射为 `qq_ws_url`、`qq_ws_token`、`qq_group_allowlist`、`qq_mcp`、`qq_qzone` 等。

### 3.4 MOSS

前缀：`/api/system/onboarding/moss`。

| 方法 | 路径 | 授权 | 请求 | 响应 |
| --- | --- | --- | --- | --- |
| GET | `""` | 读 | 无 | `{enabled, base_url, model}` |
| POST | `/config` | 写 | `{enabled?, base_url?, model?, current_password?}` | 当前生效值加 `starts_after_finish: true` |

行为与边界：

- 只托管三项配置：`moss.enabled`、`moss.base_url`、`moss.model`。
- 未提供的字段沿用当前值；URL 必须是带主机名的 `http://` 或 `https://` 地址；模型名不能为空。
- 校验失败返回 422 `moss_config_invalid`，错误项为 `{field, message}`；配置写入失败返回 500 `moss_config_write_failed`。
- 写入时如果旧配置仍含 `moss.manage_units`，会清除该遗留键；v4 不提供该键的用户入口。
- 不探测网络、不启动或停止服务、不管理 systemd 单元、不提供 helper、命令或 apply 动作。
- 响应只含生效配置，不含凭证。
- 旧端点 `/api/system/onboarding/moss/validate` 与 `/api/system/onboarding/moss/apply` 已移除，v4 不应调用。

MOSS 的边界见第 5 节。

### 3.5 Loom setup

v4 的 Loom 步骤只有一个可见动作：`POST /api/system/onboarding/loom/setup`，界面上对应「启动并应用」。

| 方法 | 路径 | 授权 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/system/onboarding/loom` | 读 | 读取 Loom 地址、provider/model 目录与健康摘要，供表单预填；不返回 token 或 key |
| POST | `/api/system/onboarding/loom/setup` | 写 | 一次性校验、写配置、启动 Loom、健康检查、catalog 校验并持久化 `ai_backend=loom` |

请求体：

```json
{
  "port": 5100,
  "provider": "new-api",
  "base_url": "https://api.example.com/v1",
  "model": "deepseek-flash",
  "api_key": "sk-...",
  "context_window": 128000,
  "max_output": 8192,
  "timeout": 600000,
  "pricing": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
  "current_password": "..."
}
```

- 必填：`port`、`provider`、`base_url`、`model`。
- v4 界面要求填写 `context_window`，默认 `128000`；直接调用 API 时可省略，服务端按 `128000` 处理。
- 未提供 `max_output` 时取 `min(8192, context_window)`，避免小上下文模型被默认输出上限卡住。
- `port` 必须在 Loom 运行时允许的端口范围内，且启动前该端口空闲。
- `base_url` 必须是带主机名的 `http://` 或 `https://` 地址。
- `api_key` 在首次配置时必填；已有内联 key 时可省略以沿用。
- 可选模型参数会写入 `models[]`；未提供的参数使用默认值。
- `pricing` 只影响成本展示，不会触发生效逻辑。

成功响应：

```json
{
  "ok": true,
  "stage": "done",
  "url": "http://127.0.0.1:5100",
  "port": 5100,
  "provider": "new-api",
  "base_url": "https://api.example.com/v1",
  "model": "deepseek-flash",
  "api_key_configured": true,
  "token_configured": true,
  "config_path": "<AI_ROOT>/.loom/config.yaml",
  "runtime": {"mode": "systemd", "running": true, "health": {"status": "ok"}},
  "catalog_verified": true,
  "warnings": []
}
```

失败响应为 HTTP 200 加 `ok: false`，包含 `code`、`stage`、`message`、`field`、`details`。`details` 中只允许出现错误码、阶段、端口、HTTP 状态、布尔和回滚状态，不得出现 key 或 token。常见错误码：

- `loom_port_invalid`
- `loom_provider_invalid`
- `loom_model_invalid`
- `loom_model_limits_invalid`
- `loom_pricing_invalid`
- `loom_api_key_missing`
- `loom_api_key_invalid`
- `loom_provider_unreachable`
- `loom_config_invalid`
- `loom_config_write_failed`
- `loom_ai_instance_failed`
- `loom_token_failed`
- `loom_runtime_unavailable`
- `loom_start_failed`
- `loom_health_timeout`
- `loom_catalog_failed`
- `loom_model_invalid`（catalog 中不存在）

流水线顺序：

1. 校验端口、provider、base_url、model、模型参数与 pricing。
2. 若请求未带 `api_key`，读取现有 `ai/.loom/config.yaml` 中同 provider 的 `providers[].apiKey`；仍为空则 `loom_api_key_missing`。
3. 请求 provider 的 `/models` 端点做探活。
4. 持久化 `loom.url`。
5. ensure AI 实例：目标为 `Config.AI_ROOT`，存在时只补 `ai-template` 缺失文件，不覆盖已有文件。
6. 发现或生成 Loom token；token 只保存在服务端与 `loom.token_file`。
7. 写入 `ai/.loom/config.yaml`：`providers[]` 中该 provider 的 `apiKey` 使用内联密钥，并从 `credentials` 段删除同名 provider 的 `${ENV_VAR}` 引用。
8. 按 `systemd` > `child` > `none` 探测运行时并重启 Loom。
9. 健康检查，超时默认 45 秒。
10. 读取 `/catalog/models` 并确认所选模型存在。
11. 持久化 `ai_backend=loom`、`loom.url`、`loom.manage_config=true`，必要时写 `loom.token_file`。
12. 任一环节失败都会恢复备份配置、恢复旧 `loom.url` 并尽力用旧配置重启；已新建的 token 文件会删除。

#### 3.5.1 内联 key 的安全边界

- key 只出现在请求体、`Selection.api_key` 与 `ai/.loom/config.yaml` 的 `providers[].apiKey`。
- 配置文件写入权限 0600，父目录 0700。Windows 上 `chmod` 只影响只读位，不落实 NTFS ACL，保护依赖用户目录 ACL。
- 响应只返回 `api_key_configured: true/false`。Loom 自己的 `/config` 也只投影 `apiKeyConfigured` 布尔，不序列化 key。
- 日志只记录 provider/model/port/mode，不记录 key。错误 details 不回显 key。
- 前端在成功后将输入框清空，不把 key 写入 localStorage、sessionStorage、URL 或引导状态。
- 已有内联 key 可以留空沿用；留空且无既有 key 时直接失败，不会退化成写明文到其他位置。
- 环境变量引用回退仍然保留：没有内联 `apiKey` 的 provider 可以继续使用 `credentials[provider]: ${ENV_VAR}`；同一 provider 存在内联 key 时，引导会删除其 credentials 引用，避免 `${ENV_VAR}` 无值导致 Loom 加载器 fail-fast。
- 不再有 token 手填或运行时手动管理 UI。token 发现、生成、重启与健康检查都由 setup 在服务端完成。

#### 3.5.2 旧 Loom 引导端点

`GET /loom/runtime`、`POST /loom/token/ensure`、`POST /loom/config/ensure`、`POST /loom/start`、`POST /loom/stop`、`POST /loom/validate`、`POST /loom/apply`、`POST /loom/restart` 仍保留给 headless 兼容与运维脚本，但 v4 向导不展示、也不调用它们。不要把这些端点当成当前 UI 能力。

### 3.6 finish

前缀：`/api/system/onboarding/finish`。

| 方法 | 路径 | 授权 | 说明 |
| --- | --- | --- | --- |
| GET | `""` | 读 | 返回只读收口快照：`runtime`、`startup`、`lifecycle`、`groups`、`activation`、`closing`、`finish` |
| POST | `""` | 写 | `{allow_degraded?, current_password?}`，执行完整 finish 编排 |

`GET` 响应示例结构：

```json
{
  "runtime": {"available": true, "active": true, "started": true, "state": "deferred", "committed": false, "gate_open": false},
  "startup": {"ok": false, "errors": [], "warnings": [], "subsystems": {}},
  "lifecycle": {},
  "groups": {"blocking": [], "soft": []},
  "activation": null,
  "closing": null,
  "finish": {"groups": {"blocking": [], "soft": []}, "activation": null}
}
```

`POST` 成功响应：

```json
{
  "ok": true,
  "state": {"version": 4, "completed": true, "current_step": null},
  "activation": {"committed": true},
  "groups": {"blocking": [], "soft": []},
  "closing": {
    "title": "初始化完成",
    "message": "系统已完成初始化，你可以开始使用了。",
    "enabled": [{"id": "clients", "label": "客户端"}],
    "skipped": [],
    "degraded": [],
    "enter_label": "进入主界面"
  }
}
```

失败统一返回 `{ok: false, code, message, groups, report, runtime, activation}`，HTTP 状态为 409。常见错误码：

| code | 含义 |
| --- | --- |
| `finish_not_bootstrap` | 当前不在引导模式，或 bootstrap runtime 不可用 |
| `finish_blocked` | 预检或集成校验存在 blocking 项 |
| `finish_startup_failed` | 服务面启动、校验或 promote 失败 |
| `finish_degraded_requires_ack` | 存在 soft 项，但请求未带 `allow_degraded=true` |
| `activation_failed` | commit 失败，finish 未记录 |
| `finish_record_failed` | 服务已激活，但完成状态写入失败；可重试 |

`groups` 固定为两层：

- `blocking`：必须修复。预检硬失败、Xiaomi 启用未登录、QQ 配置无效、启动校验错误。
- `soft`：需要显式确认降级。预检软失败、启动警告、MOSS 不可达或模型未找到。

## 4. finish 流程与收口

`POST /finish` 的编排顺序是硬约束：

1. 读取状态；若已 `completed=true`，直接返回幂等成功。
2. 确认 bootstrap runtime 存在且处于 active 或 committed；否则 409 `finish_not_bootstrap`。
3. 在服务面启动前执行一次预检，结果存入 `app.state.finish_preflight_result`。此时端口仍空闲，避免服务面占用端口后误报。
4. 预检 blocking 非空时返回 409 `finish_blocked`，响应带 `groups.blocking`。
5. 执行只读集成校验：Xiaomi、QQ、MOSS。Xiaomi 与 QQ 的 blocking 项直接阻断；MOSS 只产生 soft 项。
6. 若 runtime 为 `deferred`，执行 `attempt` 启动服务面；失败返回 `finish_startup_failed`。
7. 若 runtime 尚未 validated/promoted/committed，执行 `validate`；失败返回 `finish_startup_failed`。
8. 汇总启动报告。启动错误为 blocking，警告为 soft。blocking 非空时返回 409。
9. 存在 soft 且未显式 `allow_degraded=true` 时返回 409 `finish_degraded_requires_ack`。
10. `validated` 状态执行 `promote`，启动延迟集成。
11. 执行 `commit`；失败返回 409 `activation_failed`，不记录完成。
12. 使用第 3 步保存的预检结果记录 `finish`，不重跑预检。记录失败返回 `finish_record_failed`，提示服务已激活但状态未写入。
13. 返回 `closing`：标题、说明、已启用项、已跳过项、降级项与「进入主界面」。

前端 `FinishStep` 的行为：

- 进入步骤时调用 `GET /finish` 拉取分组与收口数据。
- blocking 非空时禁用提交。
- soft 非空时必须勾选降级确认，提交时传 `allow_degraded=true`。
- 成功后展示 `closing`，按钮文案取 `enter_label`，默认「进入主界面」。
- 点击按钮发出 `completed` 事件，向导关闭并进入主界面；不需要重启后端。

## 5. MOSS 边界

MOSS 是外部服务，不由本仓库后端托管：

- 后端只保存 `moss.enabled`、`moss.base_url`、`moss.model`，并在 finish 时做一次可选的只读探活。
- MOSS 的 vLLM 进程、`axeuh-moss` / `axeuh-moss-watch` systemd 单元、显存与模型加载属于外部部署，不在初始化向导中管理。
- 该步不提供 systemd 单元管理、helper、命令、启动/停止或 apply 动作。
- MOSS 当前没有后端业务消费者。深度音频理解的旁路管线位于 `tools/moss-shadow/`，与后端主链独立；后端 finish 的探活只用于提示可用性，不读取它的分析产物。
- MOSS 启用但不可达或模型名不匹配时只产生 soft 项，不阻断 finish；可以用 `allow_degraded=true` 完成，也可以用 `skipped` 跳过该步骤。
- 关闭 MOSS 不会停止外部服务；服务仍由部署者自行管理。

## 6. staging QA

### 6.1 隔离环境

```bash
export AXEUH_PROJECT_ROOT=<TMP_DIR>/onboarding-v4-stage
export AXEUH_ONBOARDING_STATE="$AXEUH_PROJECT_ROOT/onboarding/onboarding_state.json"
export AXEUH_AUTH_STATE_DIR="$AXEUH_PROJECT_ROOT/auth"
export CONFIG_PATH="$AXEUH_PROJECT_ROOT/config.yaml"
export AXEUH_ONBOARDING_BOOTSTRAP=1
```

要求：

- 所有路径都在 `$AXEUH_PROJECT_ROOT` 内，包括 auth、onboarding、config、日志与数据。
- 不省略 `AXEUH_PROJECT_ROOT`，否则初始化动作可能指向生产 `ai/`。
- 使用独立端口、证书或主机，避免与生产 8768 抢端口。
- 使用包含 v4 向导的前端构建产物，不要直接复用旧生产 dist。
- 启动日志必须出现 `[Bootstrap] mode=True` 与 `service plane deferred`。出现 `mode=False` 时立即按 PID 停止，检查启动器是否用 `os.execve(..., env)` 传递隔离环境。
- 首次复测前清空 staging 的 `auth/` 与 `onboarding/`；否则已有用户加无状态文件会被判定为 legacy 完成。

### 6.2 文档与聚焦测试

```bash
python3 tools/docs-check/check_docs.py all

cd backend
python -m pytest \
  tests/test_onboarding_service.py \
  tests/test_state_v4_migration.py \
  tests/test_onboarding_api.py \
  tests/test_onboarding_xiaomi_api.py \
  tests/test_onboarding_qq_api.py \
  tests/test_moss_onboarding_api.py \
  tests/test_loom_onboarding.py \
  tests/test_onboarding_finish_api.py \
  tests/test_onboarding_finish_gate.py \
  tests/test_onboarding_gate.py \
  tests/test_onboarding_storage.py \
  tests/test_onboarding_clients.py \
  tests/test_loom_runtime.py \
  tests/test_config_onboarding_keys.py \
  -q
```

测试文件不存在时先确认当前 checkout，不要伪造通过。`docs-check all` 必须输出 `docs-check all: OK`。

### 6.3 HTTP 验收

以下命令只用于 staging。`BASE` 指向 staging 的 scheme、host 与端口。

```bash
BASE="https://<staging-host>:<port>"

# 状态：11 步、state_version=4，steps 中不得出现 preflight/startup
curl -sSk "$BASE/api/system/onboarding/status" \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool

# Xiaomi：读取、开关、二维码、轮询
curl -sSk "$BASE/api/system/onboarding/xiaomi" \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool

curl -sSk -X POST "$BASE/api/system/onboarding/xiaomi/config" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"enabled":false}' | python3 -m json.tool

# QQ：校验只读，config 落盘但不启动网关
curl -sSk -X POST "$BASE/api/system/onboarding/qq/validate" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"enabled":false,"self_qq":"","ws_url":""}' | python3 -m json.tool

# MOSS：只写 enabled/base_url/model，不探测、不管理单元
curl -sSk -X POST "$BASE/api/system/onboarding/moss/config" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"enabled":false,"base_url":"http://127.0.0.1:8100","model":"moss-audio-4b"}' \
  | python3 -m json.tool

# Loom：一次性 setup，响应不得出现 api_key 或 token
curl -sSk -X POST "$BASE/api/system/onboarding/loom/setup" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"port":5100,"provider":"mock-provider","base_url":"http://127.0.0.1:18080/v1","model":"mock-model","api_key":"<staging-key>"}' \
  | python3 -m json.tool

# finish：先读快照，再提交；软降级需显式确认
curl -sSk "$BASE/api/system/onboarding/finish" \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool

curl -sSk -X POST "$BASE/api/system/onboarding/finish" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"allow_degraded":false}' | python3 -m json.tool
```

检查点：

- `status.steps` 长度为 11，id 顺序与第 1 节一致，不含 `preflight` / `startup`，`state_version=4`。
- `state` 写入 `preflight` 或 `startup` 返回 422 `invalid_step`。
- Xiaomi 响应不含 passToken；`userid` 只出现掩码。
- QQ 响应不含 token 与 token 文件路径；`<data.root>/secrets/qq_ws_token` 与 `qq_mcp_token` 权限为 0600。
- MOSS 响应只有 `enabled` / `base_url` / `model`；配置中不存在 `moss.manage_units`。
- Loom 响应只有 `api_key_configured` 布尔，不含 `api_key` 或 token；`<AI_ROOT>/.loom/config.yaml` 权限为 0600，`providers[].apiKey` 为内联值。
- Loom 配置文件权限在 POSIX 上核对；Windows 只核对 NTFS ACL，不把 `chmod` 当 ACL。
- `POST /finish` 成功后 `closing.enter_label` 为「进入主界面」，`state.completed=true`。
- 第二次 `POST /finish` 返回 `idempotent=true`，不重复执行门禁。

### 6.4 迁移验收

用隔离状态文件手工写入 v3 或 v2 状态，再调用 status 或服务层读取：

```bash
cat > "$AXEUH_ONBOARDING_STATE" <<'JSON'
{
  "version": 3,
  "completed_steps": ["welcome", "account", "dependencies", "kernel", "kernel_models", "moss", "loom", "clients", "preflight", "startup"],
  "skipped_steps": []
}
JSON

curl -sSk "$BASE/api/system/onboarding/status" \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool
```

检查点：

- `state_version=4`。
- `current_step=finish`，`preflight` / `startup` 不在 steps 或状态集合中。
- `xiaomi` / `qq` 为 skipped，并带 `reason=v3_upgrade` 的合成 step_data。
- `preflight` / `startup` 的旧数据在 `legacy_step_data` 中带 `removed_in_v4: true`。
- 真实调用 `POST /finish` 时仍执行预检、启动校验与 commit，不因迁移跳过门禁。

### 6.5 GUI 检查点

在浏览器打开 `/mobile/`：

1. 首屏是欢迎页，不是预检页。
2. 步骤栏只出现 11 个 v4 步骤，顺序为 welcome、account、dependencies、kernel、kernel_models、xiaomi、qq、moss、loom、clients、finish。
3. 没有 preflight 或 startup 面板，也没有任何序号错位。
4. Xiaomi 与 QQ 是独立步骤；Xiaomi 可扫码，QQ 可填写 self_qq / ws_url / ws_token。
5. MOSS 面板只有启用开关、服务地址、模型 ID；没有单元管理、命令或运行时按钮。
6. Loom 面板只有端口、provider、base_url、model、api_key 与「启动并应用」；没有 token 输入框、手动运行时按钮或旧 apply/restart 控件。
7. 提交 Loom 后，页面不出现 key 明文；输入框被清空。
8. clients 是 finish 前最后一个内容步骤。
9. finish 页在 blocking 时禁用提交，soft 时需要勾选降级确认；成功后显示「初始化完成」「系统已完成初始化，你可以开始使用了。」与「进入主界面」。
10. 浏览器控制台无未处理异常，页面不显示 token、密码或完整配置。

### 6.6 交接证据

| 证据 | 通过条件 |
| --- | --- |
| `docs-check all` | `OK` |
| 聚焦 pytest | 通过数与失败原因清楚，不存在的测试不冒充通过 |
| `/health` | 200 且状态健康 |
| `/api/system/onboarding/status` | 11 步、`state_version=4`、无 preflight/startup |
| `/api/system/onboarding/finish` | `groups` 分层正确，`closing` 在成功后出现 |
| Xiaomi / QQ / MOSS 响应 | 无 token、无 passToken、无密钥文件路径 |
| Loom setup 响应 | 只有 `api_key_configured`，无明文 key/token |
| 配置文件权限 | `.loom/config.yaml` 与 QQ token 文件 0600；Windows 核对 ACL |
| 状态迁移 | v3/v2/v1 状态均收敛到 v4，已完成安装不重新过门禁 |
| GUI 截图 | 11 步、MOSS 简化面板、Loom 单动作、finish 收口；不含秘密 |
| 进程收尾 | 只按 PID 停止，端口已释放，生产未受影响 |

## 7. 非目标与残余

- 不提供 MOSS systemd 单元管理、helper、命令或 apply 动作。
- 不提供 Loom token 手填、token 运行时面板或手动 start/stop/restart UI。
- 不把旧 `preflight` / `startup` 端点重新变为可见步骤；它们只为 headless 兼容保留。
- 不改变外部 MOSS 服务的部署方式与消费边界。
- 不在本文复制字段级 OpenAPI；字段以实现代码与 `GET /api/system/onboarding/status` 为准。

## 8. 真源索引

| 事实 | 真源 |
| --- | --- |
| 步骤、状态、迁移、预检 | `backend/services/onboarding_service.py` |
| finish 编排与关闭文案 | `backend/services/onboarding_finish.py` |
| Xiaomi API | `backend/routers/onboarding_xiaomi.py` |
| QQ API | `backend/routers/onboarding_qq.py`、`backend/services/onboarding_qq.py` |
| MOSS API | `backend/routers/moss.py` |
| Loom setup | `backend/routers/loom_onboarding.py`、`backend/services/loom_setup.py` |
| 前端步骤元数据 | `frontend/mobile/src/config/onboardingSteps.ts` |
| 前端 finish 交互 | `frontend/mobile/src/components/onboarding/steps/FinishStep.vue` |
| 配置键 | `config.example.yaml`、[CONFIGURATION.md](../ops/CONFIGURATION.md) |
| API 总表 | [API.md](API.md) |
| Harness 编排 | 私有运维手册（公开树不包含） |
