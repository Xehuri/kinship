# Kinship Desktop

Windows 桌面端（Electron 45），把现有 Web SPA 包成原生窗口，并把 PC 感知采集器作为子进程内置。一个应用、一个窗口、一个托盘图标，服务器地址、证书信任与 SPA 登录都由本机统一完成。

## 概览

- 单窗口：主窗口加载 `${server}/mobile/`，页面内容仍由服务器提供；本地设置页作为覆盖层挂在同一窗口内，不创建第二个窗口。
- 首次启动配置有序网络层（直连 / FRP），按顺序探测并选择第一个健康层；同一地址同时用于网页与 PC 采集端。
- 内置 PC 采集端：随安装包携带 Python 3.11.9 运行时与固定版本 wheel，用户无需安装 Python；由桌面端启动、监管和回收。
- PC 采集端同时是 SPA 的认证代理：桌面端读取采集端持有的后端 Token 并注入页面，实现自动登录与无刷新续期，不需要在 SPA 里重复登录。
- 系统托盘常驻，提供主界面、服务器设置、采集端面板、重启采集端、日志目录和退出。
- 单实例锁：重复启动只会聚焦已有窗口。

## 窗口、菜单与主题

- 只有一个 `BrowserWindow`：远程 SPA 占据窗口自身的 `webContents`，本地设置页是覆盖整个内容区的 `WebContentsView`；打开设置只切换视图显隐，窗口数量不变。
- Windows 与 Linux 不显示默认的 File/Edit/View/Window 应用菜单；主窗口、设置视图与采集端面板都启用 `autoHideMenuBar`。托盘仍提供服务器设置、采集端面板、重启采集端与退出。macOS 保留系统标准菜单。
- 主窗口跟随 SPA 的 `html[data-theme]`：`dark` 映射深色原生标题栏与 `#0d0d14` 背景，`light` 映射浅色与 `#f5f7fa`，`glacier` 映射浅色原生标题栏与 `#e8f4fc` 内容背景（原生边框按浅色处理，页面内容仍是冰川蓝）。
- 主题由主进程向页面注入只读观察器读取，经 `console.log` 标记回传给主进程。远程主窗口仍无 preload、无 IPC，页面拿不到 Node/Electron API；页面理论上能伪造标记，影响仅限于窗口底色。
- 窗口创建时按系统偏好选择 `#0d0d14` 或 `#f5f7fa`；SPA 初始化前不改写 `nativeTheme.themeSource`。
- F5 或 Ctrl+R 重新加载页面；F12 或 Ctrl+Shift+I 仅在开发环境（未打包）打开 DevTools。
- 主窗口设置 `backgroundThrottling: false`，窗口在后台时 SSE、WebSocket 与计时器仍按实时节奏运行。

## 系统设置联动与模式切换

SPA 设置页的「系统设置」行仍使用 `axeuh://open-settings`，SPA 代码行为不变。

- Android：WebViewClient 拦截该 scheme，打开 Android 系统设置页。
- Windows 桌面端：主窗口在导航策略之前拦截同一 scheme，阻止导航，并在同一窗口内显示本地设置视图（`axeuh://bundle/index.html#/settings`）。设置视图不是独立窗口，也不会被当作外部链接。
- 设置视图的「返回主界面」只摘除覆盖层，远程 SPA 仍保持原有页面、滚动位置与登录状态。

## 自动登录与 Token 刷新

桌面端不在自己手里保存后端密码或长期凭据，认证由 PC 采集端代理：

1. PC 采集端用 `backend_token` 或账号密码完成一次后端认证，凭据与 Token 生命周期都归采集端管理。
2. 桌面端用本机 `agent_token` 以 Bearer 方式请求采集端 `GET /pc-sensor/auth-token`，取得后端 Token 快照 `{ token, expires_in }`。
3. 桌面端通过 `executeJavaScript` 向主窗口 SPA 注入脚本：写入 `localStorage.mobile_token`，并派发 `CustomEvent('axeuh-token-refresh', { detail: token })`。
4. SPA 的 `useApi` 监听该事件，更新内存 Token、`localStorage` 与登录状态，页面不刷新、不重新登录。

刷新节奏：页面加载完成时同步一次；之后默认每 5 分钟轮询，只有 Token 变化时才再次注入。`AXEUH_TOKEN_POLL_MS`（毫秒，最小 100）可覆盖轮询间隔并关闭 30 秒节流，`AXEUH_QA=1` 同样关闭节流，仅用于测试。

安全边界：

- Token 只经本机回环 HTTP 与 `executeJavaScript` 传递，不写入 URL 查询串或 hash，不写入桌面端日志（日志最多记录 `expires_in`）。
- 该事件由桌面壳与 Android `WebTokenBridge` 共同派发（字符串 detail）；Android 在页面完成、回到前台、`auth_token` 变化时注入。
- 采集端未登录或后端 Token 为空时桌面端不注入，SPA 仍按原有逻辑要求手动登录。

## 架构

桌面端分四个部分：

| 部分 | 行为 |
| ---- | ---- |
| 主窗口 | 唯一的 `BrowserWindow`，`webContents` 加载 `${server}/mobile/`，无 preload，`sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`；导航限制在服务器 origin 内 |
| 设置视图 | 同一窗口内的 `WebContentsView` 覆盖层，加载 `axeuh://bundle/index.html#/setup`、`#/settings`、`#/error`；唯一加载 preload 的 webContents，通过 `contextBridge` 暴露 IPC API |
| PC 采集端子进程 | `python.exe pc_sensor_app.py --silent --no-tray --data-dir <userData>/pc-sensor --parent-pid <electron pid>`，由 `SensorSupervisor` 启动、探活、重启和停止；同时作为 SPA 的认证代理 |
| 托盘 | 显示服务器主机与采集端状态，动作包括打开主界面、服务器设置、采集端面板、重启采集端、打开日志、退出 |

设置视图按路由加载本地 Vue 应用。`axeuh://` 协议只在应用内注册，主窗口与设置视图共享同一个协议处理器，但只有设置视图获得 preload。退出时先停采集端，再执行窗口与会话清理，超时 8 秒。

## 安装

发行产物有三种，均为 Windows x64：

| 产物 | 用途 |
| ---- | ---- |
| `Kinship-Desktop-Setup-<version>-x64.exe` | NSIS 安装器，按用户安装，可选安装目录，创建桌面与开始菜单快捷方式 |
| `Kinship-Desktop-Portable-<version>-x64.exe` | 便携版，单文件启动，不写安装目录 |
| `Kinship-Desktop-<version>-x64.zip` | 解压即用目录版 |

要求 Windows 10 或 Windows 11 x64。安装包目前未签名，首次运行可能出现 SmartScreen 警告，需要用户确认后再运行。安装器是 per-user 模式，不申请管理员权限，默认安装到 `%LOCALAPPDATA%\Programs\Kinship Desktop`。

从旧版（`Axeuh-Health-Desktop-*`）升级：

1. 安装新版后，旧的 `%LOCALAPPDATA%\Programs\Axeuh Health Desktop` 目录及其卸载项仍会保留。
2. 运行 `powershell -ExecutionPolicy Bypass -File scripts\cleanup-legacy-install.ps1`（可先加 `-WhatIf` 预览），或手动卸载旧版，避免新旧两个 appId 同时运行、争用 PC 采集端口。
3. 脚本不读取也不删除 `%APPDATA%\Axeuh Health Desktop`；用户数据由新版继续使用。

## 首次启动

1. 配置网络层。添加直连或 FRP 层，只填协议、主机和端口（例如 `https://your-server.example:8768`），不要带 `/api` 或 `/mobile/` 路径。可以添加多层并上下排序；桌面端按顺序探测，第一个健康的层成为当前连接。HTTP 仅允许 localhost 用于本机开发。
2. 处理证书。公共 CA 签发的有效证书直接通过；自签名证书可检查后固定指纹，或在该层显式选择“跳过校验”（只对该层生效）。
3. 点击“保存并探测”。成功后会显示每层状态、延迟与当前层；全部失败时保留在第一步并展示失败原因。
4. 配置 PC 采集端。当前层地址会自动作为上报地址；填写认证方式和采集范围，认证支持账号密码或后端访问令牌。这里配置的凭据同时用于采集上报与 SPA 自动登录。
5. 点击“完成设置”。配置写入本机，主窗口打开 `${origin}/mobile/`，设置视图在同一窗口内收起；SPA 通过采集端 Token 自动登录，无需再次输入账号密码。

设置页可再次修改网络层与采集端配置。保存网络层会更新活动地址，并按该层 TLS 模式同步 PC 采集端。

## 网络层与证书

- `network.layers` 是唯一真源，`server` / `transport` 由活动层派生，不在 UI 中单独编辑。
- 层类型为 `direct`、`frp`、`p2p`。P2P 仅保留类型占位，保存会被拒绝（`P2P_NOT_AVAILABLE`），不接入信令与数据面。
- 每层独立 TLS 模式：`system`（系统校验）、`pinned`（固定该主机叶子证书 SHA-256）、`insecure`（仅该层跳过校验，需显式确认）。
- 只有 `ERR_CERT_AUTHORITY_INVALID` 可以按“固定该叶子证书”的方式放行。主机名不匹配、证书过期、证书链无法解析等错误不会被绕过，吊销状态仍按 Chromium 默认策略处理。
- 检查并信任证书后，证书链写入 `<userData>/ca-bundle.pem`。Pinned 层的 PC 采集端使用该文件校验；`insecure` 层对应 `ssl_verify=false`，不会影响其他层。
- `userData` 在 Windows 上是 `%APPDATA%\Axeuh Health Desktop`。

## 重置

设置页底部的“重置”分区提供“重置所有参数”，用于把本机恢复到首次启动状态。入口只在设置视图可用，主进程会停止 PC 采集端、清除桌面配置（网络层、证书信任与 CA 证书、窗口与启动设置）、采集端账号/访问令牌与采集参数，以及旧 SPA 的存储、Cookie 和 Token 注入状态。

- 二次确认：第一步展示清除范围，第二步必须输入 `重置` 才能点击“确认重置”；取消、Esc 或点击遮罩不会调用重置接口。
- 日志保留：`<userData>/logs/desktop.log` 与采集端日志不会被删除。
- 完成后自动回到首次启动的“配置网络层”页面，需要重新添加网络层并配置 PC 采集端。此操作不可撤销。

## PC 采集端

桌面端内置的采集端与独立托盘版共用同一份 `desktop/pc-sensor/` 源码，但运行方式和数据目录不同。顶层独立 `pc-sensor/` 目录已移除，采集端源码的唯一真源是 `desktop/pc-sensor/`。

- 运行时：`resources/pc-sensor/runtime/`，Python 3.11.9 embeddable 包，版本与 SHA-256 固定在 `scripts/python-embed.lock.json`；依赖 wheel 固定在 `scripts/pc-sensor-requirements.txt`。
- 源码：`resources/pc-sensor/app/`，由 `npm run stage:pc-sensor` 从仓库 `desktop/pc-sensor/` 复制。
- 数据目录：`%APPDATA%\Axeuh Health Desktop\pc-sensor`，存放 `config.json`、`pc_sensor_config.json`、`pc-sensor.log`。
- 无独立托盘：子进程以 `--no-tray` 运行，托盘菜单由桌面端统一提供。
- 配置字段：服务器地址、用户名与密码或后端访问令牌、无人判定阈值、窗口追踪、无人检测、锁屏检测、`ssl_verify`、`ssl_ca_file`、`agent_id`、`agent_name`。密码使用 Windows DPAPI 加密保存，明文不落盘。
- 启动与接管：默认使用端口 `18888`，被占用时在 `18889-18898` 内回退。发现同端口已有采集端时，先探活并比对 `instance_id`；匹配则接管为外部实例，不重复启动；不匹配则进入端口冲突状态并在设置页显示原因。
- 认证代理：桌面端以 `agent_token` 调用本机 `GET /pc-sensor/auth-token` 取得后端 Token 快照，再注入 SPA 供其自动登录与续期。采集端只返回内存中的 Token，不写日志；桌面端不保存后端密码，也不把 Token 放进 URL。
- 状态与测试：设置页顶部常驻采集端健康条，显示进程状态、服务器连接与登录失败原因；“测试登录”调用本机 `POST /pc-sensor/test-login`，不改变采集状态。
- 日志：桌面端日志在 `<userData>/logs/desktop.log`，采集端日志在 `<userData>/pc-sensor/pc-sensor.log`。设置页“查看日志”通过 `startLogStream` 实时追加（初始快照最近 300 行，桌面端 / PC 采集端两个标签），支持自动跟随、暂停跟随、手动刷新与打开日志文件夹；关闭面板或窗口会停止订阅。两边都不记录 Token 明文。

从独立托盘版迁移：

1. 退出旧的 `Axeuh-PCSensor.exe` 或 `python pc_sensor_app.py`；新的独立产物为 `Kinship-PCSensor.exe`。
2. 启动桌面端。它会尝试接管仍在运行且实例标识匹配的采集端，否则显示端口冲突。
3. 不要长期同时运行独立托盘版和桌面端，二者会争用端口与采集状态。

独立版的完整参数、配置字段和 HTTP API 见 [`pc-sensor/README.md`](pc-sensor/README.md)。

## 故障排查：缺少内置 PC 采集端运行时

症状：保存设置时提示“缺少内置 PC 采集端运行时”，路径类似 `C:\Users\<用户>\AppData\Local\Temp\<随机目录>\resources\pc-sensor\runtime\python.exe` 或同一目录下的 `app\pc_sensor_app.py`。

原因：便携版（portable exe）启动时会把资源自解压到 `%TEMP%\<随机目录>`。Windows 杀毒软件可能把 `python.exe` 或 `pc_sensor_app.py` 当作可疑文件隔离，自解压也可能因权限或磁盘问题不完整；直接在压缩包内运行、或从会被清理的临时目录运行，同样会出现该错误。

处理顺序：

1. 优先改用 NSIS 安装版。安装版使用固定的安装目录，不依赖 `%TEMP%` 自解压，最稳定。
2. 或把 zip 解压到本地固定目录后再运行，不要直接从压缩包内启动，也不要放在会被系统清理的临时目录。
3. 将应用目录（包含 `resources\pc-sensor`）加入 Windows 安全中心或第三方杀毒软件的排除项，避免 `python.exe`、`pc_sensor_app.py` 被隔离。
4. 删除 `%TEMP%` 下旧的随机解压目录后重新启动，排除残留文件干扰。

新构建的便携版固定解压到 `%TEMP%\KinshipDesktop`，运行时位于 `%TEMP%\KinshipDesktop\resources\pc-sensor\runtime\python.exe`；旧版本仍使用随机目录或 `%TEMP%\AxeuhHealthDesktop`。

桌面端按以下顺序查找运行时，取第一个同时存在 `runtime\python.exe` 与 `app\pc_sensor_app.py` 的目录：

1. 环境变量 `AXEUH_PC_SENSOR_ROOT`（相对路径按应用目录解析）
2. 应用资源目录 `resources\pc-sensor`
3. `%APPDATA%\Axeuh Health Desktop\pc-sensor-runtime`
4. `%LOCALAPPDATA%\Programs\Kinship Desktop\resources\pc-sensor`
5. `%LOCALAPPDATA%\Programs\Axeuh Health Desktop\resources\pc-sensor`（旧版安装目录）
6. 应用目录的上一级 `pc-sensor`

采集端配置现在会先写入本机，再启动采集端。因此即使运行时缺失，服务器地址与采集端设置也会保存；补装或修复运行时后重启桌面端即可，无需重新填写。

## 构建

前置条件：Node.js 20+、npm，以及能访问 Python 官方下载源和 PyPI 的网络。

```bash
cd desktop
npm ci
npm run stage:pc-sensor
npm run build
npm run dist:win
```

- `npm ci` 安装锁定依赖。
- `npm run stage:pc-sensor` 下载 Python 3.11.9 embeddable 包与固定 wheel，解压到 `resources/pc-sensor/runtime/`，复制采集端源码到 `resources/pc-sensor/app/`，并生成 `manifest.json`。该目录被 gitignore。
- `npm run build` 编译主进程（tsc）、打包 preload（esbuild）、构建 renderer（Vite）。
- `npm run dist:win` 依次执行 stage、build，并生成 NSIS、portable、zip 三件套到 `release/`。

在 Linux 上构建 Windows 包：

- Wine 方案可用。便携 Wine 11.20 实测可完成构建：

  ```bash
  PATH=/tmp/wine-portable/wine-11.20-amd64-wow64/bin:$PATH \
  WINEPREFIX=/tmp/wine-portable/prefix \
  WINEDEBUG=-all \
  WINEDLLOVERRIDES=mscoree,mshtml= \
  npm run dist:win
  ```

- Docker 方案可用 `electronuserland/builder:wine` 镜像，在容器内执行同样的命令。
- Windows 原生构建同样可行，且 NSIS 安装器相关步骤最稳定。

## 产物校验

```bash
node scripts/verify-pc-sensor-runtime.mjs   # 运行时结构、PE32+、扩展模块、_pth、Chart.js
node scripts/check-no-secrets.mjs           # 拒绝配置、日志、备份、旧 exe、私钥与个人域名
node scripts/verify-win-artifacts.mjs       # 三件套文件名、大小、zip 内容、asar 内容
npm run typecheck
npm run test:unit
xvfb-run -a npm run test:e2e
```

`verify-win-artifacts.mjs` 需要已经生成 `release/` 产物。`check-no-secrets.mjs` 只扫描已暂存的 `resources/pc-sensor/`，不会读取安装包内部。

## 目录结构

```
desktop/
├── src/main/           Electron 主进程
│   ├── main.ts         应用入口、单实例锁、userData
│   ├── desktop-app.ts  启动编排、托盘、关闭到托盘
│   ├── app-controller.ts 配置、服务器、证书预检、窗口生命周期
│   ├── ipc/            IPC 注册与发送方校验
│   ├── lib/            采集端监管、配置、TLS、端口、日志、窗口状态
│   ├── windows/        主窗口、设置视图、采集端面板
│   └── shell/          axeuh 协议、导航、权限、托盘、退出
├── src/preload/        preload，仅设置视图加载
├── src/renderer/       本地 Vue 应用（setup/settings/error）
├── src/shared/         类型、常量、IPC 通道
├── scripts/            stage、verify、no-secrets、图标生成
├── resources/          icon.png/icon.ico；pc-sensor/ 由 stage 生成
├── tests/              Vitest 单元测试
├── e2e/                Playwright 端到端测试
├── electron-builder.yml
└── package.json
```

以下目录不入库：`resources/pc-sensor/`、`dist/`、`release/`、`node_modules/`、`.cache/`、`test-results/`、`playwright-report/`。

## 已知限制与安全注意

- 安装包未签名，SmartScreen 会提示；没有自动更新，升级需要重新下载安装。
- 桌面端版本 1.0.0 独立于仓库发布版本 1.7.0；两者不需要对齐。
- 设置页的“启动与行为”开关可编辑并立即保存：`minimizeToTray` 默认开启，关闭窗口只隐藏到托盘；关闭该开关后关闭会销毁主窗口，但托盘存在时应用与采集端继续运行。`openAtLogin` 在 Windows 上使用 `app.setLoginItemSettings`，便携版以 `PORTABLE_EXECUTABLE_FILE` 为目标；Linux/macOS 为空操作。重置会清除登录项。
- 网络层、探测、日志流与窗口行为的通道和类型见 [`docs/network-layer-ipc.md`](docs/network-layer-ipc.md)。P2P 仅保留类型占位（UI 显示“未接入”），本轮不接入信令与数据面。
- 在 Wine 下可以构建产物，但不支持在 Wine 中安装 NSIS 安装器。安装验证请在 Windows 上进行。
- 不得分发 `desktop/pc-sensor/dist/Axeuh-PCSensor.exe`（旧）或 `desktop/pc-sensor/dist/Kinship-PCSensor.exe`（新）。两种单文件 exe 都会内嵌本机 `config.json` 与 `pc_sensor_config.json`，可能携带 token、密码和服务器地址。
- PC 采集端的 `backend_token` 沿用现有 `pc_sensor_config.json` 明文存储设计；优先使用账号密码 + “记住密码”（DPAPI）。如必须使用长期 Token，请依赖本机账户权限保护数据目录。
- 公开导出 allowlist 已拒绝 `desktop/pc-sensor/dist`（单文件 exe 内嵌本机配置，不公开分发）；示例配置中的真实域名已改为占位符。运行 `tools/kinship_export` 前仍须复核。
- 主窗口加载远程页面，必须保持无 preload、沙箱开启。任何 preload 都只允许挂在本地设置视图。
- 后端 Token 只经采集端内存快照注入 SPA：不落日志；Android 通过 `WebTokenBridge` 派发同一事件，后续刷新只经 WebView `evaluateJavascript` 注入；bootstrap URL 的 token 由 SPA 消费后立即剥离。
- 证书信任只对明确固定的主机与叶子证书生效，不做全局 `--ignore-certificate-errors` 式放行。
- 从旧版升级后旧安装目录、卸载项与快捷方式不会自动消失；需要时运行 `scripts/cleanup-legacy-install.ps1`。`%APPDATA%\Axeuh Health Desktop` 始终保留。
