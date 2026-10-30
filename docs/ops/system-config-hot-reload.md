# 系统配置热更新与初始化向导

> 最后更新：2026-10-27。本文描述现行配置运行面：可插拔载体、热应用、配置 API、初始化向导与回滚。键的完整清单仍以 `config.example.yaml` 与 `backend/config/config_schema.py` 为准。

## 1. 目标与保证

| 保证 | 现行行为 |
| --- | --- |
| 无配置也能启动 | 后端启动不因 `config.yaml` 缺失、为空或不可解析而退出。缺失或损坏只进入降级态，schema 默认值兜底，`GET /health` 可用。 |
| 单一设置面 | 所有可编辑键由 `backend/config/config_schema.py` 定义；Web 设置页、初始化向导、HTTP API 与后端校验共用同一份 schema，不再存在第二套手写表单口径。 |
| 热应用不重启进程 | 保存后由 `ConfigStore` 原子替换快照，再按领域调用应用器；大多数键立即生效，不重启后端进程。 |
| 引导与设置共用入口 | 首启自动弹出 11 步初始化向导；设置页「系统配置」卡片提供「配置向导（测试模式）」入口。测试模式只改变入口与提示，保存仍是真实写入。 |
| 失败可解释 | 保存返回逐域 `applied` / `failed`，配置状态暴露 `degraded` 与 `warnings`；部署接线键返回 409 并给出重启命令，不做假成功。 |

系统配置编辑器与 `/api/system/config/schema` 不再展示 legacy assistant compatibility keys（旧版助手兼容键）；`GET /api/system/config` 也会过滤这些键。后端仍兼容读取旧配置，避免已有安装因升级丢失运行参数。

配置读取鉴权：无用户 bootstrap 阶段，schema/status/validate 允许未登录读取，保证首次配置可完成；创建管理员后，`GET /api/system/config`、`/schema`、`/status` 与 `POST /validate` 一律要求 user Bearer，匿名请求返回 401。配置与 QQ 状态成功响应统一带 `Cache-Control: no-store`、`Pragma: no-cache`。

无配置启动是正常降级状态，不是异常分支。典型降级原因包括 `config_missing`、`config_empty`、`base_load_failed`、`overlay_load_failed`、`provider_build_failed`、`defaults_unavailable`、`validation_unavailable`。这些原因可在 `GET /api/system/config` 或 `GET /api/system/config/status` 的 `degraded` 中看到。

无配置时的监听取 schema 默认值：`server.host=0.0.0.0`。`ssl.enabled` 默认为 true，但没有证书与私钥时会被强制降为 false，因此实际以 HTTP 监听 `server.port=8768`；证书就绪后同一端口改用 HTTPS。

## 2. 架构

### 2.1 分层

| 层 | 位置 | 职责 |
| --- | --- | --- |
| schema | `backend/config/config_schema.py` | 唯一键清单、类型/范围/枚举校验、敏感字段、分类、核心/高级标记、`apply_strategy`。 |
| store | `backend/config/store.py` | 加载默认值、base 与 env 覆盖层，发布不可变语义的快照，串行化写入，校验 revision，分发应用器，轮询外部变更。 |
| providers | `backend/config/providers.py` | YAML / JSON / SQLite 持久化与 env 只读覆盖层；原子写、备份、0600、文件锁、revision。 |
| facade | `backend/config/config.py` | 稳定 `Config` 对象。模块持有同一个 facade，store 换快照后属性读取立即看到新值。 |
| reconcilers | `backend/services/config_reconciler.py` | 六个领域应用器：AI、音频、数据路径、外部集成、内核、监听/TLS/CORS。 |
| HotServer | `backend/core/hot_server.py` | 程序化 uvicorn 宿主；进程内重绑监听地址/端口，TLS 证书轮换。 |
| API | `backend/routers/system_config.py`、`backend/routers/system_onboarding.py` | 读取、校验、保存、引导状态与引导动作。 |
| authz | `backend/services/config_authz.py` | 无用户时强制 setup token；有用户时 Bearer + 当前密码。 |

写入链路固定为：

1. 授权检查。
2. 嵌套 changes 展开为点分路径。
3. 拒绝 `deployment` 与 `none` 策略路径。
4. schema 校验，拦截未知键、类型错误、范围错误、跨字段错误。
5. 检查 env 覆盖层是否锁定目标路径。
6. 检查 `revision` 乐观锁。
7. provider 原子落盘，文件 provider 先写备份。
8. 重新加载 base 与 env 覆盖层，发布新快照。
9. 依次调用已注册应用器；单个应用器失败写入 `failed`，不阻塞其他应用器。
10. 返回 `revision`、`changed`、`applied`、`failed`、`degraded`、`warnings`。

保存是单次配置写入，不是跨子系统事务。若某个应用器失败，配置已经落盘且快照已更新，响应中的 `failed` 会指明失败域。修复后可重新保存，或重启对应进程。不要假设 `failed` 非空时配置会自动回滚。

### 2.2 快照与模块读取

`ConfigStore` 启动时按以下顺序合成有效文档：

1. schema 默认值。
2. 持久化 base 文档。
3. env 覆盖层，优先级最高。

每次写入或外部变更都在锁内完成合成、校验与引用替换；旧快照引用保持稳定。`Config` facade 不缓存字段值，属性访问每次走当前快照，因此服务模块不需要重新注入配置对象。

`ConfigStore` 还启动一个守护线程轮询持久化层的 revision，默认间隔 2 秒。检测到外部修改后重新加载并调用应用器。外部修改不经过写入 API 的阻断式校验，非法值可能以 warning 或降级原因出现；读取失败时保留旧快照并记录 `external_reload_failed`，不会把运行配置替换成默认值。

### 2.3 HotServer

`HotServer` 用 `uvicorn.Server.serve(sockets=[sock])` 启动一次，lifespan 只执行一次。监听重绑不重复执行 startup/shutdown，只做以下动作：

1. 先绑定新 socket；失败则保留旧监听并返回错误。
2. 构建新 TLS context；失败同样保留旧监听。
3. 替换 `server.servers`，关闭旧监听。
4. 更新 host、port、SSL 状态与 uvicorn config。

这意味着配置端口保存后不需要重启进程。重绑不会主动断开已建立的连接，但旧监听已关闭，客户端之后的重连必须使用新地址与新端口。长连接客户端需要自行重连。

TLS 轮换使用 `ssl_context_factory` 捕获监听 context，并通过 `sni_callback` 在每次新握手时把连接指向当前活动 context。证书替换只影响后续握手，已建立的 TLS 会话继续使用旧证书直到断开。

当 `server.host`、`server.https_port`、`server.http_port`、`ssl.enabled` 或证书路径变化时，监听应用器调用 `rebind_from_config()`。仅证书内容变化且端点不变时，走 `reload_tls()`，不重建监听。

### 2.4 认证判定

配置写入的引导模式唯一判据是「系统中是否已有用户」：

- 无任何用户：`X-Setup-Token` 必须有效。即使 `auth.setup_require_token=false` 也一样。
- 已有用户：Bearer 必须是 `user` 类型 Token，且必须提供当前密码；`service` 与 `device` Token 一律拒绝。

`auth.setup_require_token` 默认 `true`，只影响 `/auth/setup` 端点；显式设为 `false` 可关闭首个管理员创建时的令牌校验，但不解除配置写入的无用户令牌要求。

## 3. 配置载体与环境变量

### 3.1 载体选择

| 环境变量 | 作用 | 默认与取值 |
| --- | --- | --- |
| `AXEUH_CONFIG_BACKEND` | 选择持久化后端 | `yaml` / `json` / `sqlite` / `env`；未设置时自动推断。 |
| `AXEUH_CONFIG_PATH` | YAML/JSON 文件路径 | 默认 `<repo>/config.yaml`。设置后若未指定 backend，`.json` 后缀推断为 JSON，其余推断为 YAML。 |
| `AXEUH_CONFIG_SQLITE_PATH` | SQLite 文件路径 | 默认 `<repo>/backend/data/settings.db`。设置后若未指定 backend，推断为 SQLite。 |
| `AXEUH_SETTINGS__<DOTTED_UPPER>` | 只读 env 覆盖层 | 前缀固定 `AXEUH_SETTINGS__`；`__` 表示层级分隔。值先按 JSON 解析，失败按字符串处理。 |
| `AXEUH_AUTH_STATE_DIR` | `auth.json` 与 `.setup_token` 目录 | 默认 `<repo>/backend/config`。 |
| `AEUH_ONBOARDING_STATE` | 引导状态文件路径 | 默认 `<repo>/backend/data/onboarding_state.json`。 |

补充说明：

- 旧变量 `CONFIG_PATH` 仍兼容。`backend/config/config.py` 在导入时把 `CONFIG_PATH` 同步为 `AXEUH_CONFIG_PATH`；新部署应直接使用 `AXEUH_CONFIG_PATH`。
- 已退役的 `launcher.py` 仅保留迁移回滚路径；`--config` 仍通过 `CONFIG_PATH` 传给后端子进程，最终进入同一入口。
- 已退役 `launcher.py --data-dir` 回滚路径通过 `AXEUH_SETTINGS__DATA__DIR` 注入。该覆盖层会锁住 `data.dir`，此时 Web 修改 `data.dir` 会得到 409 `env_locked`。
- `AEUH_FRONTEND_DIST` 只用于初始化预检检查前端产物，不是配置键。
- `AXEUH_CONFIG_BACKEND` 取值非法时不会阻止启动：`ConfigStore` 回退到默认 YAML provider，并记录 `provider_build_failed` 降级原因。
- 路径建议写绝对路径。provider 对相对路径按进程工作目录解析，不按项目根解析。
- 前缀注意：实际变量是 `AXEUH_CONFIG_BACKEND` / `AXEUH_CONFIG_PATH` / `AXEUH_CONFIG_SQLITE_PATH` / `AXEUH_SETTINGS__*` / `AXEUH_AUTH_STATE_DIR`；旧写法 `AEUH_CONFIG_*`、`AEUH_SETTINGS__*`、`AEUH_AUTH_STATE_DIR` 不会生效。`AEUH_ONBOARDING_STATE` 与 `AEUH_FRONTEND_DIST` 例外，保留旧前缀。

### 3.2 具体例子

默认 YAML 载体：

```bash
cd backend
python -m core.hot_server
```

JSON 载体：

```bash
AXEUH_CONFIG_BACKEND=json \
AXEUH_CONFIG_PATH=/opt/kinship/settings.json \
python -m core.hot_server
```

SQLite 载体：

```bash
AXEUH_CONFIG_BACKEND=sqlite \
AXEUH_CONFIG_SQLITE_PATH=/opt/kinship/settings.db \
python -m core.hot_server
```

仅环境变量载体（只读，适合容器或只读部署）：

```bash
AXEUH_CONFIG_BACKEND=env \
AXEUH_SETTINGS__SERVER__HOST=0.0.0.0 \
AXEUH_SETTINGS__SERVER__HTTPS_PORT=8768 \
AXEUH_SETTINGS__AI_BACKEND=loom \
AXEUH_SETTINGS__LOOM__URL=http://127.0.0.1:5100 \
python -m core.hot_server
```

持久化 YAML 加 env 覆盖：

```bash
AXEUH_CONFIG_PATH=/opt/kinship/config.yaml \
AXEUH_SETTINGS__DATA__DIR=/opt/kinship/data \
python -m core.hot_server
```

最后一种写法中，`data.dir` 由 env 覆盖层提供，Web 写入该键会被拒绝；其他键仍可写。

### 3.3 载体的读写性质

| 载体 | 可写 | revision 形态 | 备份 |
| --- | --- | --- | --- |
| YAML | 是 | `mtime_ns-size-sha256前12位` | 覆盖已有文件前生成 `.bak-YYYYMMDD-HHMMSS[-N]`。 |
| JSON | 是 | 同上 | 同上。 |
| SQLite | 是 | `meta.revision` 自增整数字符串 | 无同名备份文件，写入在事务内完成。需要留档时用 `sqlite3 ... ".backup"`。 |
| env | 否 | `env-<摘要>` | 不适用。 |

文件 provider 的写入纪律：同目录唯一临时文件、`fsync`、`chmod 0600`、`os.replace`、目录 `fsync`；写入前拒绝符号链接；使用 `<name>.lock` 与 `flock` 做跨进程串行化。SQLite 使用 WAL、`BEGIN IMMEDIATE`、`settings` 与 `meta` 两张表，文件权限 0600。

YAML/JSON 保存会重新序列化整个文档。文件中已有的未知键会被保留，但注释会丢失。需要保留注释时先备份原文件，或改用 SQLite 载体。

## 4. 生效策略矩阵

`backend/config/config_schema.py` 给每个键标注 `apply_strategy`。当前共 262 个叶子键，其中 36 个核心键、19 个分类。按策略统计：hot 174、reconnect 77、respawn 5、deployment 6。

| 策略 | 含义 | 代表键组 | 用户看到什么 | API 行为 |
| --- | --- | --- | --- | --- |
| `hot` | 保存后立即应用，不重建进程 | `server.*`、`ssl.*`、`data.*`、`ai_backend`、`loom.*`、`api.mimo_key`、`api.dashscope_key`、`tts.*`、`audio.*`、`health.*`、`scripts.*`、`pc_sensor.*`、`ota.*`、`unknown_speaker.*`、`audio_compressor.*` | 多数情况下立即生效。改端口或 SSL 会触发监听重绑；改 `data.dir` 只影响新写入；TLS 证书文件原地替换会在下一次 `server`/`ssl` 配置应用时检测并轮换（无配置变更时仍需触发一次保存或重启）。 | 正常写入并返回逐域 `applied`。 |
| `reconnect` | 原地重启外部集成，不重启后端 | `qq_gateway.*`、`p2p.*`（实验，当前不可用） | QQ 网关或 P2P 管理器短暂断开后按新配置重连。 | 正常写入；应用器失败时 `failed` 包含 `integrations`。 |
| `respawn` | 停止并重新拉起音频内核 | `kernel.device`、`kernel.cpu_affinity`、`kernel.cuda_visible_devices`、`kernel.nice`、`kernel.state_dir` | 内核短暂不可用，正在处理的音频任务可能中断。 | 正常写入；内核重启失败时 `failed` 包含 `kernel`。 |
| `deployment` | 由部署接线决定，运行中只读 | `api.baidu_map_ak`、已退役 `launcher.*` 回滚元数据 | 保存被拒绝，提示使用部署命令重启。 | 409 `deployment_required`，附 `command`。 |
| `none` | 已废弃或不可写 | `log.level`、`voiceprint.*`、`memory.*`、`agent.*` 等废弃键 | 写入被拒绝。 | 422 `unsupported_change` 或校验错误 `deprecated_key`。 |

`launcher.*` 属于已退役启动器的回滚元数据，只在迁移回滚时解析，运行中修改不会影响当前进程。legacy assistant compatibility keys 继续由后端兼容读取，但不再出现在系统配置 API 或编辑器中；已有配置文件里的值继续生效。

修改这些回滚键的流程是：编辑承载文件或部署配置，然后按回滚方案重启对应进程。生产环境按部署单元重启（公开示例为 `sudo systemctl restart kinship`）。`POST /api/system/config/restart` 不会执行重启，它只返回 409 与同一条命令。

## 5. HTTP API

所有端点前缀 `/api/system`。错误响应统一为 `{code, message, errors?}`；`GET` 配置响应中的敏感字段由后端掩码为 `***`。

### 5.1 配置端点

| 方法 | 路径 | 认证 | 行为 |
| --- | --- | --- | --- |
| GET | `/api/system/config` | 已有用户需 user Bearer；bootstrap 无用户放行 | 返回 `revision`、`path`、`provider`、`config`（已掩码）、`degraded`、`warnings`、`apply_failures`、`schema_version`。非 user Token 返回 403。 |
| GET | `/api/system/config/schema` | 已有用户需 user Bearer；bootstrap 无用户放行 | 返回 `schema_version`、19 个分类与全部字段元数据，含 `apply_strategy`、`category`、`sensitive`、`min` / `max` / `enum`。 |
| GET | `/api/system/config/status` | 已有用户需 user Bearer；bootstrap 无用户放行 | 与 `/config` 相同，但不返回完整配置文档。 |
| POST | `/api/system/config/validate` | 已有用户需 user Bearer；bootstrap 无用户放行 | 请求体 `{changes, clear_keys?}`；只校验，不写入。有阻塞错误返回 422 `validation_failed`；通过返回 `{ok:true, warnings}`。 |
| PUT | `/api/system/config` | 已有用户 user Bearer + 当前密码；bootstrap `X-Setup-Token` | 请求体 `{revision, current_password?, changes, clear_keys?, dry_run?}`。`dry_run=true` 只校验并返回 `changed`，不落盘、不应用。 |
| POST | `/api/system/config/restart` | 配置写权限 | 兼容端点，固定返回 409 `deployment_required`，不执行重启。 |

`PUT` 成功响应包含 `revision`、`changed`、`applied`、`failed`、`degraded`、`warnings`、`dry_run`。`changes` 可以写嵌套字典，服务端会展开为点分路径；`clear_keys` 用于删除键或清空敏感字段。

`deployment` 路径在写入前被拒绝，不进入 provider。`none` 路径同样在写入前被拒绝。

常见错误码：

| HTTP | code | 含义 |
| --- | --- | --- |
| 401 | `auth_required` | 有用户但未提供有效 Bearer。 |
| 403 | `setup_token_required` / `setup_token_invalid` | 无用户时缺少或错误的 `X-Setup-Token`。 |
| 403 | `password_required` / `password_invalid` | 有用户时缺少或错误的当前密码。 |
| 403 | `token_kind_forbidden` | service/device Token 试图写配置。 |
| 409 | `revision_conflict` | 版本已变化，响应带 `current_revision`。 |
| 409 | `env_locked` | 目标路径被 env 覆盖层锁定，响应带 `paths`。 |
| 409 | `read_only` | 当前载体只读，例如 env 后端。 |
| 409 | `deployment_required` | 部署接线键，响应带 `command`。 |
| 422 | `validation_failed` | schema 校验失败，响应带 `errors`。 |
| 422 | `unsupported_change` | 废弃或不可写路径。 |
| 500 | `write_failed` / `config_error` | provider 写入或其他存储错误。 |

### 5.2 引导端点

| 方法 | 路径 | 认证 | 行为 |
| --- | --- | --- | --- |
| GET | `/api/system/onboarding/status` | 引导期公开；完成后读权限 | 返回 `state`、`needs_setup`、`degraded`、`onboarding_complete`、`config_revision`、11 个 v4 `steps` 与 `state_version=4`；引导期不返回 `step_data`。 |
| POST | `/api/system/onboarding/state` | 无用户用 setup token；有用户用 Bearer user | 请求体 `{step_id, status, data?, dry_run?}`；按 v4 步骤顺序记录 `completed` / `skipped`。`preflight` / `startup` 不是合法 id。 |
| GET / POST | `/api/system/onboarding/xiaomi`, `/xiaomi/config`, `/xiaomi/qr`, `/xiaomi/qr/poll` | 读权限 / 写权限加 `current_password` | 读取脱敏状态、启停开关、二维码登录；不启动拉取线程。 |
| GET / POST | `/api/system/onboarding/qq`, `/qq/validate`, `/qq/config` | 读权限 / 写权限加 `current_password` | 校验并保存 `qq_gateway.*` 与 token 文件；不启动网关。 |
| GET / POST | `/api/system/onboarding/moss`, `/moss/config` | 读权限 / 写权限加 `current_password` | 只读写 `moss.enabled`、`moss.base_url`、`moss.model`；不探测网络、不管理单元。旧 `moss/validate`、`moss/apply` 已移除。 |
| GET / POST | `/api/system/onboarding/loom`, `/loom/setup` | 读权限 / 写权限加 `current_password` | 读取预填信息；一次性写内联 key 配置、启动 Loom、健康与 catalog 校验。 |
| GET / POST | `/api/system/onboarding/finish` | 读权限 / 写权限加 `current_password` | 读取收口快照；执行预检、集成校验、启动校验、promote/commit 并返回 closing。 |
| POST | `/api/system/onboarding/action` | 配置写权限 | 请求体 `{action, overwrite?, current_password?}`；支持 `copy_ai_template` 与 `generate_self_signed_cert`。 |
| GET | `/api/system/onboarding/storage` | 读权限 | 返回数据根、模型根、空间、可写性与告警。 |
| POST | `/api/system/onboarding/storage` | 写权限加 `password` | 只保存绝对 `models_dir`，不创建目录、不迁移缓存。 |
| GET | `/api/system/onboarding/preflight` | 仅 headless 兼容 | 不是 v4 可见步骤；只读预检。 |
| GET / POST | `/api/system/onboarding/startup`, `/startup/attempt`, `/startup/validate`, `/startup/abort` | 仅 headless 兼容 | 不是 v4 可见步骤；旧启动验证平面接口。 |

`POST /onboarding/state` 在已有用户时只要求 Bearer user Token，不要求密码；无用户时走 setup token。`POST /onboarding/action` 与配置写入一致：无用户用 setup token，有用户用 Bearer + 当前密码。

步骤顺序由服务端校验。跳步会返回 409 `step_out_of_order`。`dry_run=true` 只预演状态，不写状态文件，也不触碰配置。

### 5.3 认证规则汇总

- 无用户 bootstrap 时，`/config`、`/config/schema`、`/config/status`、`POST /config/validate` 走 `require_config_read` 放行；已有用户时四个端点都要求 user Bearer，service/device 返回 403。`/onboarding/status` 只在引导期公开，完成后要求读权限。`/onboarding/preflight` 仅为 headless 兼容保留，不是 v4 可见步骤。
- `POST /api/system/config/validate` 只读、只校验；bootstrap 可不带 token，已有用户必须带 user Bearer。
- 所有配置写入、引导动作按「用户存在性」分流。
- 无用户时 setup token 在启动阶段生成，文件默认 `backend/config/.setup_token`，权限 0600，已加入 `.gitignore`。启动日志以 INFO 输出完整令牌与来源（`新生成` / `文件`），仅用于首次配置，创建管理员后失效；HTTP/WS/错误响应不返回令牌。
- 有用户时只接受 `user` 类型 Bearer；service/device Token 被拒绝。
- 密码只出现在当次请求体，前端不写入 localStorage 或 sessionStorage。
- 所有路径都不存在 localhost 免认证旁路。

## 6. 初始化向导与设置页测试入口

### 6.1 11 步与状态 v4

首启向导使用 11 步契约：`welcome`、`account`、`dependencies`、`kernel`、`kernel_models`、`xiaomi`、`qq`、`moss`、`loom`、`clients`、`finish`。步骤 id、顺序与每步职责的唯一真源是 [onboarding-v4-2026-10-27.md](../dev/onboarding-v4-2026-10-27.md)；本节只记录与配置系统的交叉点。

- 预检已并入 `finish`，共 11 项只读检查，优先读取 ConfigStore 的有效快照（schema 默认值 + base + env overlay），SQLite/JSON/env 载体不会误报“配置文件缺失”；只有 store 不可用才回退原始文件。硬失败项为 `python`、`config`、`frontend_dist`、`disk`、`ports`、`ssl`；软失败项为 `ai_dir`、`kernel`、`kernel_models`、`loom`、`ai_backend`。
- `finish` 在一次 POST 中执行预检、Xiaomi/QQ/MOSS 集成校验、启动校验、promote/commit；`preflight` 与 `startup` 不再是可见步骤，仅保留 headless 兼容端点。软失败需 `allow_degraded=true`，硬失败 409，提交失败返回 `activation_failed` 且不写入完成状态。
- `kernel_models` 步骤内含模型根选择区块。`GET/POST /api/system/onboarding/storage` 只读写 `models.dir` 的绝对路径，不创建目录、不迁移缓存，也不接受 `data.root`。`data.root` 仍由 `AXEUH_DATA_ROOT` 或 `data.root` 配置。
- 管理员步骤调用 `/auth/setup` 创建首个用户。创建成功后 `.setup_token` 被删除，系统进入常规模式。已有管理员重新进入向导时，入口闸门通过只读 `POST /auth/verify-password` 验证一次当前密码；验证通过后密码只保留在内存并注入后续写请求，不写入 localStorage/sessionStorage。各步骤不再显示当前密码输入框；刷新或重开向导需重新验证。
- 状态文件默认 `backend/data/onboarding_state.json`，可用 `AXEUH_ONBOARDING_STATE` 或兼容的 `AEUH_ONBOARDING_STATE` 覆盖。当前 `STATE_VERSION=4`；已完成 `finish` 的 v3/v2/v1 安装直接迁移为完成态，不重新过门禁；未完成安装保留进度并把新增的 `xiaomi`/`qq` 记为 skipped，必须真实执行 v4 finish。`preflight`/`startup` 的 step_data 迁入 `legacy_step_data`。写入使用同目录临时文件、`fsync`、0600、`os.replace`；损坏文件隔离为 `.corrupt-<时间戳>` 后回到默认状态。

升级安装的完成判定：状态文件存在时看 `completed`；不存在时，若已有用户且配置未降级，则视为已完成，避免升级后被反复要求走向导。

### 6.2 自动打开与测试入口

向导在以下条件之一成立时自动打开：

- 后端尚无任何用户。
- 已登录，引导状态已知且 `onboarding_complete=false`。
- 已登录，配置处于降级态。

旧安装若已完成引导，不会自动弹出。用户在会话内手动关闭后，本次会话不再自动弹回，直到触发条件全部消失。

设置页入口：设置 → 系统与关于 → 系统配置 → 「配置向导（测试模式）」。该入口只设置 `test-mode` 提示，不经过 `dry_run`：

- 保存仍然是真实写入。
- 写入后立即应用。
- 页面顶部显示「测试模式：保存会真实生效」。
- 设置页入口完成后不自动重连 SSE/WS；如果改了端口或证书，需要刷新页面或重新登录。首启向导完成后会触发实时连接重连。

同一张「系统配置」卡片还提供「编辑配置」编辑器，显示载体类型、存储位置、revision、降级项、应用失败。编辑器保存要求当前密码；无用户阶段应使用向导，因为编辑器不提供 setup token 输入。

## 7. 安全

- 无用户时启动即生成 setup token，权限 0600；已有用户时清理残留令牌。完整令牌只允许出现在启动 INFO 日志（来源=`新生成`/`文件`），不进 HTTP/WS 响应、不进文档、不进 git。
- 无用户 bootstrap 时配置读取放行；已有用户时 `/config`、`/config/schema`、`/config/status` 与 `POST /config/validate` 均要求 user Bearer（service/device 返回 403）。配置 GET 一律经 `masked_config()`。敏感字段包括 `loom.token`、`api.mimo_key`、`api.dashscope_key`、`api.baidu_map_ak`、`health.cloud.userid`、`health.cloud.passtoken`。非空值返回 `***`。
- 配置读取与 QQ 状态成功响应带 `Cache-Control: no-store`、`Pragma: no-cache`；前端登出或收到 401 时清空系统配置快照与 onboarding QQ 状态，未登录不渲染配置卡片和编辑入口。
- 敏感字段写入时，`None`、空字符串或 `***` 表示「不修改」。要清空请用 `clear_keys`。
- 文件 provider 写入 0600；备份 0600；临时文件先 `chmod` 再 `replace`；拒绝通过符号链接写入；跨进程文件锁超时 5 秒。
- SQLite 文件创建即 0600，启用 WAL 与 `BEGIN IMMEDIATE`。
- setup token 只用于引导阶段。已有用户后，配置写入必须同时具备 user Bearer 与当前密码，service/device Token 无权写入。
- revision 冲突返回 409 且不写入；env 覆盖层锁定的路径返回 409 且不写入。
- 外部文件 watcher 不执行写入 API 的阻断式校验。能写宿主文件的人可以绕过 API 校验直接影响运行配置；生产上应限制配置文件与 SQLite 文件的系统权限。
- 引导动作 `copy_ai_template` 只在 `ai/` 完全不存在时创建；只要 `ai/` 存在（包括空目录、符号链接或只有少量文件），一律返回 409 `already_exists`，不执行覆盖、不删除任何既有文件，也不提供 force 绕过。staging 需要初始化时请使用全新的临时根。
- staging 必须设置 `AXEUH_PROJECT_ROOT` 指向临时根目录；否则初始化动作使用后端代码所在项目根，可能操作生产 `ai/`。`qa_config_staging.py` 已自动注入该变量。
- 日志不输出配置全文，也不输出密码或其他令牌；唯一例外是启动阶段的完整 setup token。全局 `backend/core/redaction.py` 统一遮盖 Authorization、query token/ticket、Cookie、JWT、`sk-`/`tvly-`/`xai-` 前缀；`uvicorn.error` 的 WS `?token=`/`?ticket=` 也经过滤。校验异常日志只保留 `type/loc/msg`，不记录 Pydantic `input`；未处理异常与 HTTP 错误详情经 `redact_text` 后输出。
- `masked_config()` 除已知敏感字段外，对 schema 外 token/key/secret/password/credential 类路径同样返回 `***`（排除 `*_env`/`*_file`/`*_path`/`*_url`/`*_ttl` 等非值路径）。
- 移动端文件浏览器拒绝 `.loom`、`.git`、`.ssh`、`.env*`、`auth.json`、`.setup_token`、`*.key`、`*.pem` 及 token/secret/credential/password 类文件名；`ai/data/tasks/deepseek_key.txt` 与 `ai/.loom/config.yaml` 不可读取。
- 小米健康云状态与扫码结果中的 `userid` 已遮盖；`mi_cloud_setup --status/--check` 不打印完整 userId。扫码 `loginUrl` 仍只在交互终端显示，并提示其为一次性凭据。

## 8. 运维与回滚

已有用户环境下，本节涉及 `GET /api/system/config`、`/config/status`、`/config/schema` 的命令都要带 user Bearer；无用户 bootstrap 例外。

### 8.1 备份命名

YAML/JSON 每次保存前生成：

```text
config.yaml.bak-20261026-012345
config.yaml.bak-20261026-012345-2
```

同一秒内重复保存时追加 `-2`、`-3`。备份不自动轮转。SQLite 不生成同名备份，写入在事务内完成；需要留档时用：

```bash
sqlite3 backend/data/settings.db ".backup '/srv/backup/settings-$(date +%Y%m%d-%H%M%S).db'"
```

### 8.2 回滚步骤

1. 停止对应后端进程。生产按部署单元停止（公开示例 `sudo systemctl stop kinship`）；只有迁移回滚路径才涉及已退役的 launcher。
2. 将备份复制回原路径，例如 `cp -a config.yaml.bak-20261026-012345 config.yaml`。
3. 确认权限 `chmod 600`，属主与运行用户一致。
4. 启动进程，检查 `GET /api/system/config/status` 的 `revision`、`degraded`、`apply_failures`。
5. 检查 `GET /health` 与关键业务端点。

不建议在服务运行时直接覆盖文件。虽然 watcher 会在约 2 秒内加载并应用，但外部修改不经过阻断式校验，错误值可能先进入快照。停服务再还原更可控。

### 8.3 revision 冲突

保存返回 409 `revision_conflict` 且带 `current_revision` 时，说明其他会话、watcher 或人工编辑已经推进了版本。处理方式：

1. `GET /api/system/config` 取最新配置与 revision。
2. 对比本地待保存字段，重新应用。
3. 用新 revision 再提交。

不要自动重试旧 revision，也不要用旧快照覆盖新配置。

### 8.4 切换载体

v1 不支持运行中切换载体。`ConfigStore` 在首次构建时选择 provider，之后不会重新读取 `AXEUH_CONFIG_BACKEND`。切换步骤：

1. 导出当前配置，例如 `GET /api/system/config` 或直接备份文件。
2. 停止进程。
3. 在 systemd drop-in 或启动脚本中设置新的 `AXEUH_CONFIG_BACKEND` / `AXEUH_CONFIG_PATH` / `AXEUH_CONFIG_SQLITE_PATH`。
4. 启动进程。
5. 检查 `/api/system/config/status` 的 `provider` 与 revision。

从文件切到 SQLite 不会自动迁移旧文档到数据库；需要先把旧文档导入新载体，或继续使用旧文件。切到 `env` 后端后配置只读，适合容器与只读部署。

### 8.5 staging 验证

仓库自带隔离 harness：

```bash
cd /opt/kinship
python3 backend/scripts/qa_config_staging.py --dry-run
python3 backend/scripts/qa_config_staging.py --smoke
```

默认 staging 根目录为 `<TMP_DIR>/system-config/staging-<时间戳>`，默认报告路径为：

```text
<TMP_DIR>/system-config/staging-report.md
```

报告文件内容是 JSON，不是 Markdown。`--report` 可覆盖路径，`--keep` 保留 staging 根目录，`--timeout` 调整启动等待。

该 harness 用 `uvicorn main:app` 启动 HTTP 服务，只做 `/health` 与 `/mobile/` 冒烟检查，不覆盖 HotServer 重绑与 TLS 轮换。需要验证热重绑时，用独立配置文件和 `python -m core.hot_server` 手工启动。

手工 staging 示例（必须使用绝对路径，避免落到生产配置）：

```bash
ROOT=<TMP_DIR>/system-config/manual
mkdir -p "$ROOT/auth" "$ROOT/data"
cd backend
AXEUH_CONFIG_BACKEND=yaml \
AXEUH_CONFIG_PATH="$ROOT/config.yaml" \
AXEUH_AUTH_STATE_DIR="$ROOT/auth" \
AEUH_ONBOARDING_STATE="$ROOT/onboarding_state.json" \
python -m core.hot_server
```

要让 Web 修改监听字段，用 YAML/JSON 文件承载，不要用 `AXEUH_SETTINGS__SERVER__*` 覆盖层，否则这些字段会被 env 锁定而无法在线修改。

`backend/scripts/qa_config_staging.py` 已注入 `AXEUH_AUTH_STATE_DIR` 与 `AEUH_ONBOARDING_STATE`，staging 的 auth/onboarding 状态不会落到生产目录。

## 9. 已知限制

1. TLS 轮换只影响新握手。已建立的 TLS 连接继续使用旧证书，直到断开重连。
2. 监听重绑会关闭旧监听。已有 SSE/WS 连接不会被主动踢掉，但之后的重连必须使用新地址与新端口；设置页保存端口变更后不会自动重连实时连接。
3. `data.dir` 只影响之后的写入路径，不做历史数据迁移。切换目录后旧数据仍留在原目录，需要人工搬迁或保留双份。
4. 内核 respawn 会停止旧内核，正在处理的音频任务可能中断。高负载时改 `kernel.*` 应避开采集高峰。
5. v1 不支持运行中切换配置载体。切换 `AXEUH_CONFIG_BACKEND` 必须重启进程。
6. `launcher.*` 是已退役启动器的回滚元数据，HTTP API 只读；只在迁移回滚时使用。
7. AI 侧仍存在直接读取项目根 `config.yaml` 的代码，例如 `ai/mcp/ai_mcp.py` 与 `ai/analysis/mi_fitness_fetch.py`。切换载体或热改端口后，这些读取点不会自动跟随，需要单独迁移或重启。
8. YAML/JSON 保存会丢失注释。需要在文件中保留人工注释时，先备份，或改用 SQLite。
9. SQLite 没有同名侧车备份。需要可回滚副本时，依赖定期 `.backup` 或外部快照。
10. `env` 后端与 env 覆盖层只读。命中覆盖层的键无法通过 Web 修改。
11. 配置保存不是跨子系统事务。应用器失败不会自动回滚已落盘的配置。
12. `qa_config_staging.py` 的 auth 隔离键与运行时代码不一致，见 8.5 节。
13. 桌面端与 Android 原生设置不在此配置面内。它们只通过 SPA 获得设置页入口；服务器地址、证书等本机设置仍由各客户端自己的配置管理。

## 10. 测试与验证

后端定向测试：

```bash
cd backend
/opt/kinship/.venv-health/bin/python -m pytest \
  tests/test_config_schema.py \
  tests/test_config_providers.py \
  tests/test_config_store.py \
  tests/test_config_reconciler.py \
  tests/test_config_authz.py \
  tests/test_system_config_api.py \
  tests/test_onboarding_service.py \
  tests/test_onboarding_api.py \
  tests/test_hot_server.py \
  tests/test_hot_server_entrypoint.py \
  -v
```

后端全量：

```bash
cd backend
/opt/kinship/.venv-health/bin/python -m pytest tests/ -v
```

前端定向 Vitest：

```bash
cd frontend/mobile
npm run test:unit -- \
  tests/unit/components/settings/SettingsSystemConfig.test.ts \
  tests/unit/components/settings/SystemConfigEditor.test.ts \
  tests/unit/components/settings/SystemConfigField.test.ts \
  tests/unit/components/onboarding/OnboardingWizard.test.ts
```

前端全量单元测试：

```bash
cd frontend/mobile
npm run test:unit
```

前端 E2E（设置布局与级联）：

```bash
cd frontend/mobile
npm run test:e2e -- settings
```

staging 冒烟与报告：

```bash
python3 backend/scripts/qa_config_staging.py --smoke
cat <TMP_DIR>/system-config/staging-report.md
```

文档检查：

```bash
python3 tools/docs-check/check_docs.py all
```

## 11. 相关文档

- 键参考：[CONFIGURATION.md](CONFIGURATION.md)
- 运行与运维：[OPERATIONS.md](OPERATIONS.md)
- API 端点总表：[API.md](../dev/API.md)
- 安装与首启：[INSTALL.md](INSTALL.md)
- 音频内核契约：[kernel-contract.md](../kernel-contract.md)
- 文档索引：[README.md](../README.md)
