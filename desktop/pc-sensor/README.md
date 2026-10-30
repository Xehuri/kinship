# Kinship Sensor（PC 感知采集器）

运行在 Windows 上的 PC 状态采集器，采集前台窗口、无人状态、屏幕锁定等数据，
通过 HTTP POST 上报到后端。默认以**系统托盘**方式常驻，右键托盘图标即可配置；
也支持 `--no-tray` 无托盘模式，供桌面应用内嵌。

## 功能

- 前台窗口追踪（进程名 + 窗口标题）
- 无人检测（空闲超过阈值判定为无人）
- 屏幕锁屏 / 解锁检测
- 本地配置网页（`http://localhost:<port>/pc-config`）
- 系统托盘右键菜单
- 开机自启动（静默）
- 无托盘桌面内嵌模式：独立数据目录、父进程看门狗、优雅关闭接口

## 安装

### 方式 1：直接运行（需要 Python）

```bash
pip install -r requirements.txt
python pc_sensor_app.py
```

不带 `--silent` 启动时会自动打开一次配置网页；带 `--silent` 时静默驻留托盘（供开机自启使用）。

无托盘运行（桌面应用内嵌）示例：

```bash
python pc_sensor_app.py --silent --no-tray --data-dir <数据目录> --parent-pid <父进程 PID>
```

| 参数 | 说明 |
|------|------|
| `--silent` | 不自动打开配置网页 |
| `--no-tray` | 不创建托盘图标，主线程等待 `/shutdown`、SIGINT/SIGTERM 或父进程退出 |
| `--data-dir <dir>` | 可写数据目录（也支持 `--data-dir=<dir>`）。优先级：命令行 > `PC_SENSOR_DATA_DIR` > 程序目录 |
| `--parent-pid <pid>` | 每 2 秒检查一次父进程，父进程消失后自动退出（不杀父进程） |

`--data-dir` 下的 `config.json`、`pc_sensor_config.json`、`pc-sensor.log` 均由本进程写入；
`static/` 始终从程序资源目录读取，不复制到数据目录。

### 方式 2：打包成 exe

```bash
# 先安装 pyinstaller
pip install pyinstaller

# 然后运行打包脚本
build.bat

# 在 dist/ 目录得到 Kinship-PCSensor.exe
```

打包为单文件无控制台程序。`config.json`、`pc_sensor_config.json`、`static/`、`assets/` 已内嵌，
首次运行会自动在 exe 同目录生成可写配置。

## 配置

### 服务配置 `config.json`

只保存本地 HTTP API 的服务参数（不含设备身份，设备身份见下一节的 `pc_sensor_config.json`）。

| 字段 | 说明 |
|------|------|
| server_host | 本地 HTTP API 监听地址，默认 `127.0.0.1`（仅本机可访问）。改为 `0.0.0.0` 会把配置页及其注入的 Token 暴露到局域网，仅在明确知晓风险时使用 |
| server_port | 本地 HTTP API 端口 |
| agent_token | 认证 Token，保护敏感接口。为空或长度不足 32 位（视为可预测，含旧版出厂占位值）时，启动时自动生成随机 Token 并写回本文件 |
| instance_id | 桌面壳写入的实例标识（可选，默认空串），仅在状态接口回显，不参与认证 |

### 采集配置 `pc_sensor_config.json`

| 字段 | 说明 |
|------|------|
| enabled | 是否启用 PC 感知采集 |
| server_url | 后端服务器地址，建议使用带有效证书的域名，如 `https://example.com:8768`（证书校验默认开启，`localhost`/IP 会校验失败） |
| endpoint_candidates | 可选。多端点候选，列表 `[{name,url,priority}]` 或对象 `{name: url}`；按 priority 探测 `/health`，默认 IPv6 优先、frp 回退。为空时只用 `server_url` |
| backend_token | 后端 Bearer Token（**推荐**）。长期有效，优先于账号密码使用；配置后直接用于上报，无需密码 |
| username | 后端登录用户名（未配置 `backend_token` 时使用） |
| remember_password | 记住密码（PC-M8）。勾选后用 Windows DPAPI 加密保存密码（`password_enc`），下次启动自动登录；仅本机本 Windows 账户可解密 |
| idle_threshold | 空闲阈值（秒），超过判定为无人 |
| window_enabled | 是否采集前台窗口 |
| idle_enabled | 是否启用无人检测 |
| screen_enabled | 是否启用锁屏检测 |
| ssl_verify | 是否校验证书，默认 `true`（完整校验）。设为 `false` 会记录警告且不校验证书，存在中间人风险 |
| ssl_ca_file | 自定义 CA 证书（bundle）路径，用于自签名后端；留空使用系统信任库 |
| agent_id | 设备唯一标识，用于后端区分不同客户端，默认 `default-agent` |
| agent_name | 设备显示名称，留空时回退到 Windows 计算机名 |

以上采集项均可在托盘菜单或配置网页中实时切换。

> **关于后端凭据（PC-M7 / PC-M8）**：后端登录密码**不落盘**（仅存活于进程内存），
> 进程重启后默认需重新输入。三种免重输方式，按推荐度排序：
>
> 1. **`backend_token`（最推荐）**：填后端长期服务 Token——位于 `backend/config/auth.json` 中
>    `"kind": "service"` 的那一条，有效期至 2099 年且改密不失效。配置一次即可永久免密上报；
>    与账号密码同时存在时优先使用。
> 2. **记住密码（PC-M8）**：在配置页勾选「记住密码」并填入密码，密码会用 **Windows DPAPI 加密**
>    后存入 `pc_sensor_config.json` 的 `password_enc` 字段（明文仍不落盘），开机自动登录。
>    密文与当前 Windows 账户绑定，换账户或换机器无法解密——此时程序自动降级为「需重新输入密码」，
>    不影响启动。
> 3. 每次启动手动输入密码。
>
> 旧版配置里若残留明文 `password` 字段，程序会在首次加载时自动迁移并从磁盘擦除。

## 托盘菜单

右键托盘图标：

```
打开配置网页
────────────
启用 PC 感知          [勾选]
采集选项
  ├ 窗口追踪          [勾选]
  ├ 无人检测          [勾选]
  └ 锁屏检测          [勾选]
────────────
开机自启动（静默）    [勾选]
────────────
查看状态
打开日志
重启采集器
────────────
退出
```

## 开机自启动（静默）

托盘菜单勾选「开机自启动（静默）」后，程序会向注册表写入：

- 位置：`HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Run`
- 名称：`AxeuhPCSensor`
- 数据：`"<exe 绝对路径>" --silent`

取消勾选即删除该项。`--silent` 模式下程序只驻留托盘，不自动打开配置网页。

## HTTP API

服务默认监听 `server_host`（默认 `127.0.0.1`）的 `server_port`（默认 18888）。
仅 `/health`、`/`、`/pc-config`、`/static/` 为公开接口，其余接口需带
`Authorization: Bearer {agent_token}` 头。

| 端点 | 方法 | 认证 | 功能 |
|------|------|------|------|
| `/health` | GET | 否 | 健康检查，返回 `status`、`agent_id`、`agent_name`、`pid`、`version` |
| `/`、`/pc-config` | GET | 否 | 本地配置网页（服务端注入 agent_token，附带 CSP/nosniff 响应头） |
| `/static/*` | GET/HEAD | 否 | 本地静态资源（当前为 `vendor/chart.umd.min.js`），无外网 CDN |
| `/pc-sensor/config` | GET | 是 | 获取采集配置（密码脱敏） |
| `/pc-sensor/config` | POST | 是 | 更新采集配置（含 `endpoint_candidates` 校验） |
| `/pc-sensor/auth-token` | GET | 是 | 返回当前后端 Bearer Token 的内存快照 `{token, expires_in}`，供桌面壳注入 SPA；不写日志、不落盘 |
| `/pc-sensor/test-login` | POST | 是 | 重新测试后端登录，返回 `{success, logged_in, auth_error, message}`；不改采集状态、不重启采集器 |
| `/pc-sensor/pair` | POST | 是 | 用 8 位配对码换取设备 Token，更新 `server_url`/端点，返回脱敏配置 |
| `/pc-sensor/status` | GET | 是 | 运行状态，额外返回 `pid`、`data_dir`、`instance_id`、`version`、`current_endpoint`；`auth_error` 为最近一次认证失败原因 |
| `/pc-sensor/charts` | GET | 是 | 图表数据 |
| `/pc-sensor/logs` | GET | 是 | 读取运行日志尾部（查询参数 `lines` 默认 300，最大 5000） |
| `/restart` | POST | 是 | 重启采集器 |
| `/shutdown` | POST | 是 | 优雅关闭整个进程（返回后主线程停止采集器和 HTTP 服务） |

> 本地配置网页由服务端在 HTML 中注入 `window.__PC_AGENT_TOKEN__`，页面脚本自动携带
> Authorization 头，因此无需手动填写。该机制依赖服务仅绑定回环地址。

## 桌面应用内嵌契约

桌面壳以子进程方式启动采集器，并读取以下契约：

- 启动命令：`pc_sensor_app.py --silent --no-tray --data-dir <userData>/pc-sensor --parent-pid <electron pid>`
- 就绪判定：轮询 `GET /health`，`status=ok` 即就绪；`GET /pc-sensor/status` 的 `pid` 用于确认子进程身份
- 退出：`POST /shutdown`（Bearer `agent_token`）返回 `{"success": true}` 后进程自行退出；
  壳进程退出时看门狗会在 2 秒内检测到并关闭采集器
- 数据目录：壳预先写入 `config.json`（含 `server_port`、43 位 `agent_token`、`instance_id`）
  与 `pc_sensor_config.json`；采集器只在该目录写配置和日志
- 认证代理：桌面壳以 Bearer `agent_token` 调用 `GET /pc-sensor/auth-token` 取后端 Token 快照，
  再经 `executeJavaScript` 注入 SPA 实现自动登录与续期。采集端只返回进程内存中的 Token，
  不记录 Token；桌面壳不保存后端密码，也不把 Token 放进 URL

## 日志

日志写入数据目录下的 `pc-sensor.log`（按 2MB 轮转，保留 3 份）；默认数据目录即程序目录，`--data-dir` 可改写。
托盘菜单「打开日志」可直接用系统默认程序打开。

## 安全注意

- 默认仅监听 `127.0.0.1`；改为 `0.0.0.0` 会把配置页及其注入的 `agent_token` 暴露到局域网
- 空或可预测的 `agent_token`（长度不足 32 位，含旧版出厂占位值）会在首次启动时自动替换为随机 Token 并写回 `config.json`
- 后端登录密码**不落盘**：明文密码仅存活于进程内存，配置文件只保存 `backend_token`，或在勾选「记住密码」时保存 DPAPI 密文 `password_enc`（与当前 Windows 账户绑定，非明文）。请优先使用长期 Token 而非密码。`pc_sensor_config.json` 已加入 `.gitignore`，其中 `backend_token`、`password_enc` 均属敏感凭据，请勿提交并建议限制文件读权限
- `/pc-sensor/auth-token` 只返回内存 Token 快照，端点本身不写日志；调用方（桌面壳）也不得把 Token 写进 URL、查询串或日志
- 上报默认开启 TLS 证书校验；务必让 `server_url` 使用有效证书的域名（如 `https://example.com:8768`），
  不要使用 `localhost`/IP 直连，否则会校验失败。自签名后端可配置 `ssl_ca_file` 指向 CA 证书；
  仅在临时排障时才设置 `ssl_verify=false`
- 建议在防火墙中限制 `server_port` 的访问来源
