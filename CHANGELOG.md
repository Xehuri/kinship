# 更新日志

## [Unreleased]

Kinship / 知己文字品牌批（2026-10-24）：产品名、作者名与公开域名的可见文本切换，技术标识、运行时路径与 `config.yaml` 保持不变。

### 新增

- **v4 引导重构（2026-10-27）**：11 步 `welcome→account→dependencies→kernel→kernel_models→xiaomi→qq→moss→loom→clients→finish`，state v4；Xiaomi/QQ 独立前置步骤，MOSS 仅启用/地址/模型，Loom 仅端口/提供商/密钥并一次启动应用，finish 合并预检与启动校验并显示结束语。详见 [docs/dev/onboarding-v4-2026-10-27.md](docs/dev/onboarding-v4-2026-10-27.md)。
- **零配置首次启动引导（2026-10-26，历史）**：新增 10 步 onboarding（`welcome`→`account`→`dependencies`→`kernel`→`kernel_models`→`moss`→`loom`→`clients`→`preflight`→`finish`），支持无 `config.yaml`、无内核、无模型、无 MOSS、无 Loom 的最小启动。bootstrap 模式延迟调度器、音频 ingest、Health Cloud、Loom 探针、QQ、P2P 与配置 watcher，仅放行引导/认证/静态资源；`finish` 进程内激活服务面并进入 chat。前端缺失时后台从 release 自愈下载，日志记录来源、进度与校验结果。Loom token 自动发现且不回显，MOSS 外部 vLLM 校验可跳过，预检硬失败阻断、软失败需 `allow_degraded=true`。
  - 发行 `onboarding-v1.0.0`（manifest `2026.10.26-r4`）：frontend `axeuh-mobile-dist-1.3.0.tar.gz` sha256 `17415ef0ab240c1f6fba011cd30354dbc9a90719640f4d87a1a065a273903b9e`；kernel `axeuh-kernel-1.0.0-py312-any.tar.gz` sha256 `4e9c7b2afd1d4599fc1acbecf2d0c3fe65e2c7d5ffb562cfa3770045ecbcebeb`；Android `Kinship-Android-1.4.2-debug.apk` sha256 `3ae44b41ecc139a5cea54fbb22039f67eddfe0496ad3816d6ba9983022109ece`；Windows `Kinship-Desktop-Setup-1.0.0-x64.exe` sha256 `2fb156ec1c4dd144c2d05e4a7e657b40109bf3e04fdfb48ee3a5b9be8fd9f554`；manifest sha256 `acaa637c373fa029e54ccbd800cad008e021d3fb57d57abed7a74b7779c7b390`。
- **桌面端网络层设置与实时日志（2026-10-25）**：首次启动改为“网络层 -> PC 采集端”两步，设置页合并服务器/网络为一个有序层编辑器，支持增删改、启停、上下排序、探测/重探、手动选层、按层 `system`/`pinned`/`insecure` TLS 与证书检查信任；活动层同时驱动 SPA 与 PC 采集端。启动与行为开关改为立即保存，日志面板改为实时流（自动跟随、关闭即停止），P2P 仅显示“未接入”占位。setup/settings 视觉对齐生产 Web 的暖奶油/墨色/赭石与 8/6 px 圆角。
- **Android WebView token 复用（2026-10-25 13:49）**：新增 `WebTokenBridge`，以 `axeuh_prefs["auth_token"]` 为唯一真源，在页面完成/回前台/token 变化时向 SPA 注入 `localStorage.mobile_token` + `axeuh-token-refresh`；SPA 关闭登录层、重连 SSE/WS，并忽略 token 轮换后的过期 401；URL token 消费后立即剥离。生产前端 `assets/index-JEWFxoJ0.js` / `assets/index-MFa6qXpn.css`，备份 `dist-backup-20261025-134930`；APK 需手动安装（debug 签名）。详见 [docs/dev/android-webview-token-bridge-2026-10-25.md](docs/dev/android-webview-token-bridge-2026-10-25.md)。
- **桌面端重置所有参数（2026-10-25）**：设置页新增“重置”分区，清除服务器地址、证书信任与 CA 证书、网络端点、PC 采集端账号/令牌、采集参数与窗口设置，并回到首次启动设置；二次确认要求输入 `重置`，取消/遮罩/Esc 不触发重置，运行日志保留。
- **桌面端单窗口与 Token 自动登录**：设置视图作为子 `WebContentsView` 覆盖在主窗口上，系统设置行同窗打开桌面设置；PC 采集端作为认证代理，桌面端注入后端 Token 并支持无刷新续期，SPA 不需要重复登录。
- **桌面端采集端健康与日志**：设置页新增常驻连接/登录状态条、登录失败原因与“测试登录”、桌面端/PC 采集端日志查看器（最近 300 行），并把“返回主界面”固定到左侧导航顶部。

### 变更

- **plan 工具三件改进（2026-10-28）**：新增 `user_intent`（`diff`/`revise` 写入、`read` 回显，只记录不参与 coverage）；`read`/`base` 支持 `status`/`kind` 过滤（`anchor` 别名，`details.__plan` 保持完整）；新增或改写 care 的 `done_when` 必须可核验（`HH:MM` 或 `window`），否则拒绝并建议 `kind=note`。详见 `docs/dev/loom-scheduling-redesign-2026-10-28.md` §5.1。
- **Loom 工具输出纯文本化（2026-10-28）**：`plan` / `long_task` / 网络搜索 / `task_fetch` 的模型输出不再回灌 JSON，改为紧凑纯文本，结构化数据保留在 `details`；`plan read/base` 新增 `include_instruction`（默认隐藏任务正文，`true` 或 id 数组按需展开），`leftovers` 收敛为昨日 `planned/blocked/carried` 且排除当日同 id 条目。详见 `docs/dev/loom-scheduling-redesign-2026-10-28.md` §5.1。
- **QQ 消息管线（2026-10-24/25）**：qq-mcp 从 Loom 撤下，23 个 QQ 操作统一走 `qq` CLI（`ai/skills/qq-cli/`）；未读水位与水群状态落到网关 SQLite（`/v1/read-state`、`/v1/water-state`）；群聊改为元数据提醒（定向 1 秒合并、自动提醒 60 秒/群），支持 water/mute、评分与空闲回退。
- **QQ 未读媒体**：`qq history --unread --compact` 自动经网关 `/v1/media` 下载图片/文件，正文附本地绝对路径；`--json` 每条消息附 `media` 数组。
- **产品名**：可见文本 `Axeuh Health Monitor` / `LiveLog-AI` / `Axeuh Mobile` / `Axeuh助手` → `Kinship`，`Axeuh Health Desktop` → `Kinship Desktop`，`Axeuh-PCSensor` → `Kinship Sensor`；PC 采集端 exe/spec 改为 `Kinship-PCSensor.exe` / `Kinship-PCSensor.spec`。Gradle 根项目名、appId、`productName`、包名已在本轮切换为 Kinship / `com.xehuri.kinship`；autostart、存储目录等技术标识保留。
- **作者/版权**：README、CONTRIBUTING、docs 与 public-sync 可见文本中的作者名 `Axeuh` → `Xehuri`；`com.axeuh.*`、`AXEUH_*`、`axeuh_kernel`、systemd `axeuh-*`、协议标签 `<Axeuh-home-system>`、`Axeuh_bot` 与仓库目录 `axeuh-health-monitor` 保留。
- **域名**：文档与服务入口的旧域名/组织域名已替换为占位示例 `example.com`（例如 `agent.example.com` / `signal.example.com`）；真实证书路径不写入公开变更日志。
- **public-sync**：历史映射已归档；公开仓地址为 `github.com/Xehuri/kinship`，GitHub 组织/仓库改名属外部动作。
- **前端交互修复（2026-10-24）**：外部发送 SSE 以 `session.queue` 建立用户轮次边界，修复新 AI 回复并入上一条回复；报告页按健康清单/日报/周报/复盘分组并移除 442 个标签 chip；文件预览改用完整 `row.path`、目录导航保留树状态；新增 `CodeSurface` 统一文件与 Markdown 代码显示；删除会话列表、摘要跳转、PC 聊天头部动作与设置页 AI 后端/重复入口；品牌副标题改为「知己」。已部署生产：`assets/index-BJ8e9P42.js` / `assets/index-WPbciDvZ.css`，旧产物备份 `dist-backup-20261025-000109`；后端已重启。详见 `docs/archive/frontend/frontend-ui-fix-2026-10-24.md`。
- **PC 右侧上下文栏（2026-10-25）**：按 demo 恢复 Chat 三栏布局，>=1180 常驻 320px 上下文栏，768-1179 页头触发器开合右抽屉，<768 保留移动浮层；`ContextInspector` 新增 embedded 模式，overlay 行为不变。另修复 Loom `: keepalive` 注释帧被前端当 JSON 解析的每 15s 报错。
- **设置页布局重构（2026-10-25 20:06）**：7 个设置 section 收进三组卡片（账户与偏好 / 数据与连接 / 系统与关于）；>=1024 双列卡片、移动单列；外观五字段 2/1 列自适应、强调色 2×2、顶部页边距跨列；数据源在宽卡内变双列小卡；修复 `.ax-shell button` reset 覆盖设置控件 padding/border/background 的级联缺陷；MiHealth 内容与卡片对齐。生产 `assets/index-ClJhwC_O.js` / `assets/index-MFa6qXpn.css`（设置路由 `SettingsView-BnO4yrGQ.js` / `SettingsView-Bx6sYfGe.css`），备份 `dist-backup-20261025-200603`；详见 `docs/archive/frontend/frontend-settings-redesign-2026-10-25.md`。
- **对话生产修复（2026-10-25 09:30）**：上下文栏新增 used/max 数值条与进度条；子智能体列表改为唯一滚动容器；压缩会话先弹确认；Web 发送对 Loom `session.queue` 信封去重；压缩分隔线只落在真实锚点页；压缩按钮移入「用量」节头；发送图标改 ArrowUp；删除「加载更早」，滚顶自动加载。新增 `GET /api/screen/model/context-window`（失败返回 null）。生产产物 `assets/index-NbkC67S6.js` / `assets/index-BDwBlMwO.css`，备份 `dist-backup-20261025-093046`；详见 `docs/archive/frontend/frontend-ui-fix-2026-10-25.md`。
- **前端 v2 部署（2026-10-24）**：前端切为 v2-only 壳层，桌面 5 项（对话/提醒/报告/文件/设置）、移动端 3 项（对话/报告/设置）；移除健康看板与 `/dashboard`（落 404），健康数据入口迁至报告页健康摘要条、GPS/声纹与设置页「健康数据」/「数据源」；生产产物 `assets/index-B2C_L_jB.js` 与 `assets/index-CiU9xJAX.css`，旧产物备份 `frontend/mobile/dist-backup-20261024-201153`。后端新增 `GET /api/sources/health`（Bearer 鉴权，未认证 401），`/api/mobile/reports` 增加 `size_bytes` / `kind`。

### 验证

- **零配置引导验证（2026-10-26）**：backend 2161 passed / 8 skipped / 13 既有环境失败（10 个缺 async pytest 插件、2 个 `auth_middleware.verify_token` 缺失、1 个 Windows 绝对路径在 Linux 的断言）；frontend typecheck + 111 文件 / 1208 用例通过；kernel 398 passed / 17 skipped / 15 既有对拍环境失败（`pypinyin` 缺失、Windows 硬编码路径、backend 对拍源缺失、`weak_split` 不存在）；docs-check OK。release `onboarding-v1.0.0` 资产 HTTP 200，manifest/前端/内核 SHA-256 匹配，frontend 顶层为 `dist/`，kernel `--help` 通过。
- **设置页布局重构验证（2026-10-25 20:06）**：单元 91 文件 / 973 用例通过；全量 49 个 Playwright 场景通过（settings layout/cascade 7 个）；真实数据 QA 53 张 PNG、20/20 冒烟、深浅色对比度均 ≥4.5、无横向溢出/焦点异常；生产 QA 0 problems、console/page/request/HTTP 错误均为 0。
- **Android WebView token 复用验证（2026-10-25）**：前端定向 32/32、全量 90 文件/965 用例通过；Android 定向 15/15；浏览器 QA 9/9；生产新 JS 200、旧 JS 404，`<KINSHIP_SERVICE>` PID 未变。Android 全量仍有 2 个与本次无关的既有 `NotificationCollectorTest` 失败。
- **记忆 P1 收口（2026-10-24）**：断链 59→0、PII 9→0、finalize errors 63→0；剩余 18 条体积 warning 归 P2。
- **前端交互修复验证（2026-10-25）**：typecheck 通过；83 文件 / 884 单测通过；14 个 UI E2E 通过；真实报告 234 条、`data` 目录下根级 `opencode.json` 预览通过；生产 QA `consoleErrors=0`、`failedResponses=0`。
- **对话生产修复验证（2026-10-25 09:30）**：typecheck 通过；88 文件 / 945 单测通过；全量 42 个 Playwright 场景通过（本轮相关 13 个）；后端定向 81 用例通过；生产 QA 1440/1024/390 显示 10.9% / 109,471 / 1,000,000，135 个子智能体仅列表滚动，压缩确认取消零请求，滚顶自动历史请求 1 次，`consoleErrors=0`、`failedResponses=0`。
- **桌面端 1.0.0 包（2026-10-24）**：`<RELEASE_BASE_URL>/Kinship-Desktop-1.0.0-x64.zip`（未签名）；280 单测 + 12 E2E 通过。

## [0.1.0] - 2026-10-29

公开首版，版本线从 0.1.0 重新起版；历史 1.x 记录保留。

### 新增

- **公开仓结构**：仓库拆为公开 `kinship`、私有 `kinship-kernel`、私有数据 `kinship-data` 三部分；公开树由 `tools/kinship_export` 的 fail-closed allowlist 生成。
- **组件许可**：后端/Loom 为 AGPL-3.0-only，客户端为 Apache-2.0，内核为 PolyForm Noncommercial 1.0.0，CircuitJS 独立为 GPL-2.0 插件仓。
- **AI 路径**：`data.ai_root` 成为单一 AI 根，未显式配置的 AI 子路径从它派生。
- **内核模型**：全部模型改由引导 `kernel_models` 步骤下载；内核发行包不含 `models/` 或 `.ckpt`。

### 变更

- **CircuitJS**：从公开树移出，构建前由 `frontend/mobile/scripts/fetch-circuitjs.mjs` 从 `kinship-circuitjs` 抓取并校验。
- **安全**：公开导出前完成测试夹具 PII 脱敏；`tools/public-sync` 退役。

## [1.7.0] - 2026-10-23

Windows 桌面端首次发布。Electron 网页套壳、内置 PC 采集端与本机证书信任一起落地，桌面端与独立采集端共用同一后端。

### 新增

- **Windows 桌面端（Electron 45）**：主窗口加载 `${server}/mobile/`；服务器地址与证书在本机设置页配置；PC 采集端作为子进程内置并由桌面端托管；托盘菜单、单实例锁、首次启动 / 设置 / 错误页；NSIS、便携版、zip 三件套。
- **PC 采集端桌面模式**：新增 `--no-tray`、`--data-dir`、`--parent-pid` 与 `POST /shutdown`，支持无托盘运行、独立数据目录、父进程看门狗和优雅退出。
- **本机证书信任**：自签名证书按主机与叶子证书 SHA-256 显式固定；证书链写入 `<userData>/ca-bundle.pem`，供 PC 采集端以 `ssl_verify=true` 使用。

### 变更

- **PC 采集端配置页**：改用本地 Chart.js（`static/vendor/chart.umd.min.js`）并收紧 CSP，不再引用外网 CDN。
- **文档**：新增 `desktop/README.md` 与 `desktop/AGENTS.md`，并同步根 AGENTS、PROJECT_MAP、安装文档和根 README。

### 安全

- **配置读取与客户端缓存（2026-10-27）**：已有用户时 `GET /api/system/config`、`/config/schema`、`/config/status` 与 `POST /config/validate` 统一要求 user Bearer；无用户 bootstrap 仍放行，首次配置 schema→validate→submit 不受影响。配置与 QQ 状态响应加 `Cache-Control: no-store`；前端登出/401 时清空配置快照与 onboarding QQ 状态，未登录隐藏配置编辑入口。
- 远程主窗口不加载 preload，保持沙箱与上下文隔离；IPC 只允许本地控制窗口调用。
- 只信任明确固定的证书，主机名不匹配、证书过期、链解析失败均不绕过。
- 禁止分发含本地配置的旧 `pc-sensor/dist/Axeuh-PCSensor.exe`。

## [1.6.3] - 2026-10-22

Loom 生产宿主收敛与记忆、QQ 两条外设链的集中落地。10-19 起 Loom 增加交互式 PTY 与退出唤醒；10-20 记忆 A 方案把主会话常驻压到 6 件，并补齐审计/写入/检索/巩固工具；10-21 QQ 网关收敛为单 WS + SQLite + MCP IPC 的常驻服务（默认关闭），同日 Loom 自动唤醒、converge 回执简化、单次/auto 压缩与内核/音频压缩、new-api、Loom 重试预算一起硬化；10-22 压缩升级为 ops+chat 双视角单摘要，文档侧新增 docs-check 门禁并完成 P0 安全/拓扑纠错。生产助手唯一宿主为 Loom `127.0.0.1:5100`，OpenCode 5096 退役。

### 新增

- **Loom 交互式 PTY（2026-10-19）**：新增 `pty_spawn` / `pty_write` / `pty_read` / `pty_list` / `pty_kill` 五件套（node-pty），支持长驻交互进程、输出缓冲、列表与按 PID 终止；`notifyOnExit` 默认 true，进程退出（含 timeout 自动杀）生成 `<pty_exited>` 并投回发起会话——空闲经 `SessionRegistry.deliverWake` 立即起唤醒轮，忙则入 durable send 队列、当前轮收尾后起新轮；env 剥离 `LOOM_` / `AXEUH_` 前缀，spawn cwd 限 workspace，权限/deny/net 走 D7 缝。
- **记忆 A 方案（2026-10-20）**：主会话常驻 11 件 / 190,156 B 压到 6 件 / 36,522 B（−80.8%）——`AGENTS.md`、`self/必读.md`、`self/persona-lite.md`、`profile/state.md`、`profile/core-lite.md`、`topics/INDEX.md`；批次/复盘四个实际 role 文件统一注入 5 件 core（`f541c350`）；`persona-lite` / `core-lite` 由 02 每日刷新。
- **记忆工具链（2026-10-20）**：`memory_write.py`（flock + temp + fsync + `os.replace`，append-log/append-scratch/upsert/mark/check/snapshot，同 key 不同文本旧条目标 `superseded` 并保留正文）、`memory_audit.py`（只读体检六件注入、超线、tag、投影新鲜度、摘要/索引上限、孤儿/legacy）、`memory_retrieve.py`（中文 2-gram + ASCII 分词、标题切段、0.55 relevance + 0.30 recency + 0.15 importance、字节预算、path:line）、`memory_consolidate.py`（daily 清 7 天前已收割/丢弃的 scratch 行，weekly 只报告；apply 先 snapshot、幂等）。
- **摘要 v2 + 批次索引（2026-10-20，fdf8fff6）**：`fact_extractor --update-summary` 按批分配字节预算、逐级压缩每段，当日摘要 ≤24 KB 且保留全部批次；新增 `批次索引-{date}.md`（每批一行：判断/首条观察/首段行号，≤4 KB），01/02 先读索引，再按疑点回读批次原文。
- **QQ 网关 P0（2026-10-21，721609f0）**：新增 `backend/services/qq_gateway/`（transport/store/router/render/media/forward/actions/delivery/ipc/service）与 `qq_mcp_server`；NapCat 单 WS、echo/pending、重连/心跳、SQLite 去重/inbox/outbox/action ledger、合并转发展开、媒体下载、发送/文件/戳/表情/历史；MCP 改走 `127.0.0.1:8770` + Bearer token 的 loopback IPC，不再直连 NapCat；`qq_gateway.enabled` 默认 false，按 lifespan 启动。
- **QQ 空间与收藏表情（2026-10-21，b35c1c38）**：新增 `qzone.py` / `qzone_client.py` / `qzone_parse.py`（动态、评论、回复、删除评论、点赞；独立 `allow_read` / `allow_send` / `allow_delete` 与写入限速）与 `stickers.py`（收藏表情列表/发送/保存/修改/删除）；IPC 暴露 `/v1/qzone/*` 与 `/v1/stickers/*`，MCP 工具扩到 23 个。
- **Loom 自动唤醒（2026-10-21）**：主会话 `converge` 支持可选 `wake`（倒计时 / 带时区 ISO / 本地时间 / `HH:MM` / `none`），最长 30 天；到点经 `deliverWake` 投 `【自动唤醒】` durable user 消息并起轮；sidecar `ai/.loom/state/session/wake/{sid}.json` 耐重启（过期未超 24 小时立即触发，超 24 小时丢弃）；侧会话/子智能体不可用；`server.autoWakeEnabled` 缺省启用，显式 false 关闭需重启。
- **Loom 单次/auto 压缩（2026-10-21，e35c36e0）**：worker 路径旧 compactable `toolResult` 先投影为占位符，`summaryMode: auto` 在预算内恰好一次摘要、超预算按消息边界递归拆分（`summaryMaxSplitDepth` 缺省 2，叶子回退 `summaryChunkTokens` 分块），成功后写 `coveredCount` / `tailIncluded` boundary，已覆盖前缀不重复压缩；`summaryReasoningEffort: low` 只覆盖摘要调用。

### 变更

- **Loom converge 回执简化（2026-10-21）**：主会话只需 `status`，digest 自动派生、body 可省略；侧会话 digest 亦内部派生。
- **Loom 双视角压缩（2026-10-22，02714491）**：worker 默认对同一投影前缀跑 ops + chat 两趟独立摘要，按顺序流式输出并带 `perspective` 标签，拼成一条 `summaryText`（`## OPS STATE` + `## CHAT STATE`）同轮注入；只有一个 `coveredCount` 与 boundary，重放不变，持久化/API/UI 仍只见一个摘要。chat 六段用对话主语言输出；`summaryPerspectives` 缺席即 `["ops","chat"]`，`["ops"]` 立即回退旧单 ops 摘要（字节同形）；legacy 路径仍单份 9 段摘要。
- **资源硬化（2026-10-21，ed3decc5 / a99d610）**：内核新增 `kernel.cpu_affinity` / `kernel.nice`，spawn 后按 PID 施加 `sched_setaffinity` / `setpriority`（生产 `[2,3,4]` / 10）；`audio_compressor` 新增 `ffmpeg_threads` / `nice`（生产 2 / 10，enabled=false 未变）；new-api CPU 监控阈值置 0，避免高负载时保护性 503；Loom 重试预算改为 `errorRetries=6` / `errorRetryBackoffMs=2000`，失败回合 replay 3 次 / 30000 ms，`reasoningContentReplay=true`。
- **规律层 L1 机载（2026-10-20）**：新建 `profile/规律.md`（≤100 行，只放当前在用结论）与 `profile/规律-摘要.md`（1,289 B，宿舍置顶）；data-checker/reviewer 的 memory 列表追加摘要，批次每天先读并写核对行，复盘负责增删与例外单列。
- **Loom 运维编制件（2026-10-20，预收口）**：O1-O6 运维手册（RACI / 值班 SLA / 发布分级 / 预算 / 对外承诺 / 退出降级）、`loom_metrics.sh` 指标告警、`loom_backup.sh` 状态备份演练、构建期 `VERSION` 回退与 `resolveLoomVersion`、`/health` 暴露 Loom 健康与版本；发布口径固定为"不回退 4097"；W5 观察未完成、W6 未签核。
- **记忆检索定位收敛（2026-10-20）**：50 题基线（40 可答 + 10 不可答）文件级 hit@1 17.5% / hit@12 35.0%、MRR 0.235、无答案题 10/10 均有返回（无 abstention）；`memory_retrieve` 仅作辅助定位，自然语言/偏好/关系/日期以 `grep` + `read` 为主；v0.2 明确不做。

### 修复

- **Loom 压缩边界与重放（2026-10-21）**：截断的摘要流按瞬时错误重试；重放保留未覆盖尾段；`compact_context` 从实时 boundary floor 起算；手动压缩前先 hydrate 会话，避免空上下文压缩。
- **fact_extractor 健康视图 fail-fast（2026-10-22，29d5ba07）**：分片真源存在但 store 不可用（裸 `python3` 缺 pydantic）时不再回落空 samples，改为 `sys.exit` 提示使用 `<VENV_HEALTH>/bin/python`，杜绝事实文件静默零心率（10-22 批次 06 实证 697 行）。
- **会话状态轮询兜底（2026-10-22，7a48a743）**：新增 `watch_session_state.py`，CLI `--wait-for-next` 连不上时改轮询会话状态，避免监督链因单次连接失败断线。

### 移除

- **OpenCode 5096 退役（2026-10-20，3d32b59b）**：launcher 不再启动 5096、OpenCode hub 跳过；生产助手唯一宿主为 Loom `127.0.0.1:5100`，OpenCode `4097` 只跑自有会话、不接管助手、不作回退；AGENTS/README 与运维文档同步新拓扑。

### 验证

- 记忆 A：`ai/analysis` 全量 49 tests passed；`memory_audit check` 0 errors / 17 warnings；18:00 批次实测注入 5 件 core（36,451 chars），摘要 20,504 B、索引 3,152 B，批次文件 34,995 B。
- QQ 网关：P0 26 条测试；QZone/表情包/MCP 契约新增 120 条全绿；生产 shadow 态 `ss -tnp | grep :3001` 仅 gateway + relay 两条。
- 资源硬化：后端定向 43 tests passed；生产内核 PID `taskset=2-4` / `ni=10` / health 200；Loom 侧 typecheck + build 绿、197 files / 2,284 tests passed，真实 wire 含 `reasoning_content` 与 `reasoning_effort`。
- MOSS fp8 显存实测（2026-10-21，3e5bc856）：r6_moss_fp8 语义上下文 88 行 VRAM 采样与汇总，卡2 3060Ti fp8 常驻数据留档。

### 文档

- **docs-check 门禁（2026-10-22，127fab67）**：`tools/docs-check/check_docs.py` 仅标准库，`p0` 检查链接、明文凭据、`.bak`、public-sync manifest、内核 kinds 35；`all` 另含旧拓扑、端口表、配置覆盖、docs 索引；不进入公开镜像。
- **P0 安全/拓扑纠错（2026-10-22）**：中文 README 生产拓扑改为 Loom 5100（4f816a03）；根 AGENTS 修正环境路径与端口（5597846f）；backend AGENTS 删除明文账号密码，kernel-design/health 架构文档移除真实 userId 与旧 Windows 凭据路径（5c1f9feb）；kernel kinds 终值统一 35 并同步后端计数（489ae09f）；修复断链与配置 docstring 指针（bd2d2853）；AI_SYSTEM 与部署指南加历史快照 banner（978b6867）。

## [1.6.2] - 2026-10-19

手机历史消息孤儿 toolResult 错挂修复：13:04 的旧 read 工具卡出现在 13:12 最终纯文本回复下方，刷新后仍复现。分页把 toolCallId 位于页外的 toolResult 变成孤儿，转换层将孤儿 toolResult 挂到了最后一条 assistant。

### 修复
- 根因：`GET /api/screen/session/{id}/messages?backend=loom` 默认 `limit=50`，分页只取到 toolResult 而取不到其 toolCallId 对应的 toolCall；转换层原逻辑把孤儿 toolResult 归并到最后一条 assistant
- 修复（6ab18aad）：孤儿 toolResult 不再挂靠，按原始时间线位置保留为独立壳；正常配对的 toolResult/toolCall 归并行为不变

### 验证
- health 后端重启后经真实手机 API 复核：返回 28 条消息，最终 assistant 的 tool parts=0，独立 toolResult 壳 1 个，13:04 旧卡不再出现在 13:12 回复下

## [1.6.1] - 2026-10-12

离线补传错位日桶根因修复：`append_perception` 按写入墙钟分桶，手机侧持续补传使旧日语音分析行流入当天桶（10-12 桶实锤混入 839 条 10-11 事件；同机制漂移自 08-23 起每晚发生，全库共 1901 条），污染 AI 分析层全部按"目录日期=事件日期"读取的路径（事实提取/当日摘要/声纹审计/预览时间线/覆盖自检）。

### 修复
- `append_perception` 增显式 `date_str: Optional[str]=None`（口径同 `save_audio`"绝不使用服务器当前时间"）：None=今天桶（实时链零改动），事件日期=指定桶；非法值 ValueError 直达调用方（fail-loud 置于返 False 的宽 try 之外）。语音分析链传 `_base_dt`（start_epoch_ms 事件时刻，随 requeue 全程透传）；PC 迟到批按原始 `event.t_iso` 单规则解析（`_event_date`，解析失败告警回今天，无推断阶梯）
- 一次性归位工具 `scripts/rebucket_perception_misplaced.py`：仅移动 audio 指针日期≠桶目录的 voice 行；默认 dry-run、cp-a 备份、Σ行数守恒断言、幂等；重复守卫（目标日将保留行/计划内同 basename → 跳过原位保留，防历史重复分析行双重计数）。22:03-22:09 停机窗口内执行：归位 1901 行、守恒 632,544 行不变、43 文件备份 `ai/data/rebucket-backup-20261012-2208/`、守卫跳过 1（08-23 历史重复行，永久原位）
- `scripts/audit_orphan_audio.py` 只读孤儿审计（停机时点执行）：113 个落盘音频无行引用（10-09 内核故障日 39、停机/重试丢弃等 74）；音频原件均在，回填与否待用户拍板（`backfill_audio.py` 系退役本地链，不顺手执行）
- 起服复核：新内核 respawn（port 33959），首条实时语音正确落桶；全库错位仅剩守卫跳过 1 条；dry-run 复跑幂等零待移。门禁审查（ultrabrain）三条 BLOCKER 全数入序：apply 竞态→停机窗内执行 / 停机静默丢→孤儿审计报数 / 摘要重生成回吸污染→今晚禁 `--update-summary`，23:40 后重跑 10-11/10-12 全天事实
- 测试：新增 17 用例（store 分桶三态 / pipeline date_str 捕获 / pc 端点三事件 / 归位工具 12），全量 backend/tests 11F/752P，失败集=基线 11 条逐名，零新增

### 已知残留（登记不处置）
- 6 月起旧路径 schema 的 voice 行（`voice_unresolved`）指针不可解析，原位保留只报告
- 10-11/10-12 手写批次与摘要基于污染桶生成，日期归属不可信——裁决区勘误条待用户批准；10-11 复盘择日重做

## [1.6.0] - 2026-10-12

MOSS-N2 深度音频理解·影子管线上线（旁路提质，生产主链零改动）。依据 2026-10-11/12 研究战役定案（15 轮实验 + 46 段人耳基线，总纲 `docs/archive/research/research-audio-understanding-2026-10-12.md`），方案 `docs/moss-production-integration-plan.md`（Momus 评审一次通过，= axeuh-moss/axeuh-moss-watch 两 systemd 单元的批准件，用户 2026-10-12 批准）。

### 新增
- **MOSS 影子管线 `tools/moss-shadow/`**：`axeuh-moss.service`（vLLM serve MOSS-Audio-4B-Instruct fp16，驻 GPU 卡1——内核 10-07 已退 CPU 专为此预留，`:8100` 仅 loopback，xgrammar guided）+ `axeuh-moss-watch.service`（CPU watcher 订阅 `daily/{date}/audio/` 新落盘 chunk → 能量短路（均值<-50dBFS ∧ 语音占比<10% 直落 `_sc` 静音行不进模型，-50~-45 灰区仍进）→ N2 请求（证据块+HINT_MOSS+schema v1 逐字配方、max_tokens 896、temp 0）→ 旁路 `ai/data/daily/{date}/audio_deepdive.jsonl`（append-only，主键=audio 相对路径，游标自愈去重，backlog 单趟 30 丢最旧）。**perception.jsonl 一字不改**；watcher 挂掉生产零感知
- **合并层 `merge.py`**：R10 定案纯规则（LCS 包含度 τ=0.65 零过度合并工作点，两跑字节确定）+ R12 三件套（①ambient 叙事回放提取器常开、③N0 声学专问二段推理+佐证闸门、②v2b 禁上），冲突直写不裁决 → `audio_deepdive_merged.jsonl`
- **AI 层消费（P3 编辑集，ai/ 属 AI 自身配置经批准修改）**：`fact_extractor.py` 新增 `load_deepdive` + 语音时间线行 `└ MOSS:` 子行注入（**A/B 金标实证：无 deepdive 日期输出逐字节不变、命中日纯增量零删除**）；顺带 `load_perception` 行级容错加固（R7 崩面封死）；`规则-01-data-check.md` 新增 §1c 六条消费规则（deepdive 交叉源非裁判 / R7 不对称律 device_playback=证据·human=无信息 / uncertain 降档 / 短路行不作内容结论 / 缺数据≠无事件 / 孤证采信零容忍上报）；`01-data-check.md` 加优先读行。transcript 刻意不上事实行——逐字文本与声纹身份仍归内核
- **音频工作台 v2 `tools/audio-console/`**（研究战役配套）：133 段素材库 ×18 方案并排 + 人耳基线标注抽屉（`state/annotations.jsonl`，永久真值源）+ 类目草稿自动建议 + :8790（frpc 公网映射，token 持久化）
- **8G 部署包 `docs/moss-8g-deploy/`**：MOSS-Audio-4B fp8 消费卡（sm_89）部署指南 + selftest + schema，经 8795 公网直链分发外部测试者（回传待收）
- **门读数工具链**：`metrics.py`（P1/P3 四门口径钉死）、`backfill_report.py`（四表读数）、`overnight_orchestrate.sh`（回填循环+熔断→merge③ 分日→自动读数）、P3 七天观察 `reports/p3-observation-runbook.md`（全命令 dry-run 实测）

### 修复
- `docs/moss-8g-deploy/selftest.py` 音频传输形态：data-URL 前缀被 vLLM 0.31 当 base64 内容直解报 400（"Non-base64 digit found"）→ 改裸 base64（R5 实证形态）；README §5 同错表述一并修正；8795 分发包已热替换（sha256 更新，链接不变）

### 状态与决策门
- P1 累积 2026-10-12 13:18 起算；期中读数三门全过（错误率 0%、p90 18.2s、卡1 显存稳），满日正式报告 10-13 晨；10-13 起 P3 七天双源观察门计数（G1 覆盖≥95% / G2 批次媒体归因考古段数降≥30% / G3 孤证采信=0 / G4 无泄漏）
- **P4 转正（动后端：静音 chunk 钩子闭 S18 盲区 + `type=moss_deep` 镜像 + stitch 切换）另需用户签 `docs/moss-p4-formalization-spec.md` §九，未获执行批准**；规格含 max_chunk_s 硬切语义对账与"生产 config.yaml 无 stitch 子块"实查修正
- 语义唤醒永久搁置（F3/R3 判死）；MiMo 退纵深侦察位（自由文本形态，M2+JSON 归因掉 24pp 定案）；回滚全期有效：`systemctl stop <MOSS_SERVICE> <MOSS_WATCH_SERVICE>` + revert ai/ 文本 commits

## [1.5.3] - 2026-10-08

P1/P2/P3 架构收敛（第一性原理"一接口一实现"重构波）。计划 `.omo/plans/p1-p3-convergence.md`，取证与逐单元证据 `docs/archive/audit/2026-10-08/`。**待统一重启窗口生效**（systemctl 整 cgroup，内核 K1a/K2a 新码同批换新）。

### 移除/退役（破坏性变更，行为面均有契约测试锁定）
- **OpenCodeGateway 整层退役**（V6）：信封/mock/默认模型注入下沉 `opencode_client` 同名方法，session 域 router→client 两级；顺带 gateway 系 16 条基线 async 测试随迁移转绿
- **声纹注册库外层镜像退役**（V10）：`voiceprint_service.py` 整文件（283 行）删除，探针函数并入 kernel_client；跨进程直读内核 state-dir（W1，含向量红线绕行）根除；`/api/vaudit/voices` 改内核 registry 快照派生（幽灵质心残留自动净化）；main 启动镜像计数删（守 B5 启动纯度）
- **health 派生视图双写退役**（V9）：`export_legacy` 不再被写链调用（函数保留为迁移工具/懒引导种子读）；109 历史日分片零空洞核验；AI 侧 health 直读方迁分片 read_view（逐键对拍 109/109 一致）
- **云健康 round-trip 去除**（V8）：小米云任务子进程直写 store（canonical→线格式→canonical 降级再升级环删除）；`batch_to_sync_payload` 退役；附带修复 ScriptRunner wrapper 未注入 backend sys.path 的潜伏缺陷
- 散装调度循环清零（V13/V17）：unknown_cleanup 与 compressor 自扫收编 TaskScheduler `register_builtin` 内建回调任务（时间判定单实现、同日不双触发锁定）；perception 路由 import 副作用单例创建迁 lifespan（shutdown 补 stop_sweeper 限时 join）
- 野生跨进程文件操作根除（V15/K2a）：artifact 消费即删改 `DELETE /v1/artifacts/{id}`（幂等 200+启动清扫条款）

### 新增
- **内核契约 additive 双端点**：`GET /v1/voiceprint/registry`（全量元数据快照，`_REGISTRY_META_KEYS` 白名单保证向量永不出响应）、`DELETE /v1/artifacts/{id}`；caps 登记 35 kinds；§15 消费漂移三笔回写（emotion 停用/interrupted 归属外层 requeue/陌生人未接线登记）
- **唯一 reader/原语层**：`services/perception_reader.py`（六套 perception.jsonl 解析收编，真实数据 13 组 golden 逐字节一致）；`services/audio_codec.py`（ffmpeg 路径×4→1、mp3 裁剪×2→1、PCM→WAV×4→1 单实现）；`services/kernel_segment_session.py`（无缝流/直播流镜像降级基类，59+73 行双实现→单实现，锁语义零变化）；`ai/analysis/health_source.py`（AI 侧健康数据源适配层）
- model_config 单一真源（`MODEL_CONFIG_PATH` config 键，router 写=client 读，写后缓存真失效）；五处逃逸硬编码路径收编 config 属性（逐处新旧值相等断言，物理数据零迁移）；`/api/vaudit` 裁剪三接口→单实现（路径别名兼容，前端零改动）
- 测试网：契约/golden/表征/单测新增约 120 用例（session 32、crop 16、mirror-degrade 10、builtin-sched 8、artifact-DELETE 8、registry 14 等），全量 11F/690P（原始基线 27F/570P，全程零新增失败）

### 遗留决策（见审计 README §六）
陌生人 confirm/reject UI 接线（V20 可选）、compressor 启用与否、V13b 脚本内嵌时刻表去留、AI 规程 md 的 health 条款随迁改写、孤儿缓存文件清理

## [1.5.2] - 2026-10-08


后端接口面第一性原理裁剪（P0 死码清除）。审计取证见 `docs/archive/audit/2026-10-08/`（75 条路由/四方消费者覆盖表/内核契约三方对照），执行提交 `f87d437a..5287ad38`。**2026-10-08 10:30 已随服务重启生效**（launcher 1534312 起新码；端点面 OpenAPI 实测 81 条、死接口残留 0、notify sidecar 停写证实）。

### 移除（破坏性变更，均为四方零消费者死接口）
- **三个整文件路由删除**（U1）：`agents_remote.py`（旧远程 Agent 体系 /api/agents×5 + /ws/agent + /api/agent/download）、`tasks.py`（任务管理 API 全套 8 条，任务实际由调度器直跑不经 HTTP）、`scripts.py`（/api/scripts×4 无 UI 消费）；调度器/ScriptRunner 本体保留
- **session 域 8 条孤儿端点**（U2）：for-agent/current/bind-main-task/abort/stats/agent/{type}×2/active；gateway 类内双写 `get_active_sessions` 死定义删除；`session_history_saver.py` 死模块删除（生产触发点早已注释）
- **杂项死端点**（U3/U4）：health /source×2、/dates、/upload-db（旧安卓导入旁路）；auth /logout、/auth/check、/auth/revoke（改密吊销已自动生效）；tts /stop、/status；notification /poll；ota /check；speakers 单查 + /verify；wake_word 空函数 `invalidate_spotter` 全链
- **perception 死支**（U5）：JSON 版 /voice-session 入口（App 已迁 multipart）及不可达 text/stream_stitch 分支；通知 sidecar `notify_store.py` 双写停（get_notifications 生产零读取）；`save_profile/get_today_profile` 死函数
- **内核客户端死件**（U6）：`cancel_job/resubmit_interrupted/list_jobs`（interrupted 恢复实际由外层 requeue 承担，内核侧成死轨）；registry 四死方法（get/reset/device_ids/flush_device）；`energy_vad_segments`、`is_ready`；`services/storage/` 死包（import 不存在模块、全仓零引用）。`reset_kernel_client` 判定保留（测试单例隔离在用）
- **emotion 全链死码**（U7）：pipeline 顶层三键死读（emotion/speaker/silent，`_adapt_kernel_facts` 从不写）+ silent 死分支 + 情绪日志拼装 + `voiceprint_unk` pending/confirmed 不可达段（全仓零写方，实测 perception.jsonl 三天零出现）；ai 侧 `fact_extractor/check_voiceprint` 死键消费清理。**段内活键 `emotion`（SenseVoice）透传保留**

### 变更
- 内核契约漂移登记：`analyze.emotion` kind 消费方已停用（10-07），本版本随 U6/U7 把外层死读清零；P1 待回写契约 §15
- backend/AGENTS.md、main.py 注册表同步收敛

### 验证
- backend 142 文件 py_compile 零错误；17 个删除符号全仓残留 grep=0
- pytest 基线 30 failed/596 passed → **27 failed/570 passed，新增失败 0**（消失 4 条均为被裁死测试；余 27 条为预存 e2e/mock 环境问题）
- 生产连续性：全程未重启（8768/5096 LISTEN 正常）；死端点在下次重启后正式下线

## [1.5.1] - 2026-09-25

内核与外层彻底分离（架构终态）。计划 `kernel-outer-separation-wave`：A1-A7 内核补齐 / B1-B5 外层接线 / C1-C6 物理删除+文档，16 提交收官，回滚 tag `pre-outer-stripping`。

### 移除（破坏性变更）
- **backend/ 物理删除 17 个算法实现文件**（57b6601b）：本地 VAD/ASR/声纹/KWS/场景/切分/陌生人/cohort 等全部算法实现清零；`backend/models/` 历史 ML 权重整体出库删除
- `voiceprint_service.py` 由 1735 行瘦身为 337 行**纯注册库镜像**（仅 `sync_from_kernel`/计数/IO），`extract_embedding` / `score_all_v2` / `CohortManager` 全删
- `requirements.txt` / `pyproject.toml` 去除 ML 全家桶（torch/funasr/modelscope/pyannote/silero/sherpa/sklearn 运行时 import 实测清零，`[ml]` extra 删除）；后端启动不再预加载任何模型（冷 lifespan 0.03s，RSS 75MB）（671d31d4）
- 本地流式切分器 `audio_stream_segmenter` 删除（C5，924cea29）——逐帧静音切分**绝不回退本地**，唯一真源在内核

### 变更
- **降级语义改变**：内核不可达 = 显式降级（不唤醒 / 无缝流整块冲刷 / 评分跳过 / 作业 requeue 重试），不再有本地模型兜底（本地模型已物理删除）
- **唤醒链全量切内核**（376f976c）：四个本地算法点清零，声纹最后一条本地活路径切断；`/ws/audio-stream` 桥接内核 `/v1/stream`，KWS 检测上移内核（d3211990）
- **分析链彻底切内核**（e19bbf58）：residual 三件（aed/emotion/breath）切内核 kind、滑窗评分单请求、降级全家桶改 requeue、陌生人切 track 模式、cohort 自动采集开闸（write-through 恢复生长）
- 无缝流/直播流切分委托内核 WS `mode:"segment"` 通道（`segment_channel.py`），外层保留时间轴/水位/去重/holdback（924cea29）
- cohort 真相源迁内核 state-dir，外层 `ai/data/cache/cohort_*` 归档；陌生人清理改内核 cleanup 定时调用
- **调度 v3**（c90e6cbe）：5 窗 → 10 窗，术语定死"业务"，两级业务机制落地（批次白名单内自适应侧重）
- **审计五件套上线**（62b76437→d4c7f8f0）：审计采集器 v1（9 域机械检查 + 判据溯源 + 生效日 SKIP）、05 深度复盘规范、02:00 定时调度、CTX 域升级为树内逐会话画像、05 异常深入探索授权
- 通知文风两轮定稿（用户 09-24 拍板）：第一人称"有人味" + 强制分段落；业务调整：新闻推送砍财经、删账单小结
- 文档同步（C6，ee27ca72）：全仓 11 文件（根 AGENTS / README×2 / backend 及 services/routers AGENTS / docs/DATA_FORMAT 等）统一"外层零算法、一切音频计算走闭源内核"新口径

### 验证
- 测试基线：kernel 379+3sk / backend 623+8sk+2F（2F 为预存 e2e 缺 token，与本波无关）；启动链纯净性断言测试锁死"外层禁 import ML"（671d31d4）
- 2026-09-25 10:41 生产核查：重启后 job 零失败、cohort 恢复生长首样本出现、voiceprint 五键配置落地（3abe1530）
- 遗留观察项 ⓐ-ⓖ 低危自然观察（vaudit current 面板仍直读冻结旧 unknown 库待切内核等），账目见 `.sisyphus/plans/kernel-outer-separation-wave.md`

## [1.5.0] - 2026-09-23

### 新增
- **上传音质双档（WAV/FLAC）**（音质改造 T1-T7，`9150647b`→`a471e696`）：App 设置页「环境音频 → 上传格式」两档 ChoicePicker（FLAC 无损约省 46% 流量：2.76→1.50 GB/天），**每段采集现读、改完下一段生效、无需重启**。App 侧 `FlacFinalizer`：MediaCodec `audio/flac` 首选 + java-flac-encoder 0.3.8 兜底（Maven Central，LGPL-2.1），编码失败自动降级 WAV **绝不丢数据**
- **后端 magic 嗅探**（ab8e80a3/451abdd1）：multipart 按 `RIFF`+`WAVE` / `fLaC` 魔数判格式（不信任 Content-Type），解码统一 PCM 进无缝流（水位/去重/切分全格式无关），chunk 按上传格式封装落盘 `daily/{date}/audio/`；`perception.jsonl` 单 `audio` 指针指实际落盘文件
- **`audio.store.upload_ext` 配置键**（9c162c2d）：嗅探未知时回退默认扩展名（默认 `wav`），非法值归一
- **流量提醒**（d386f54d）：选 FLAC 显示省流估算，WAV 档显示日流量水位提醒

### 变更
- `_ensure_wav` 就地覆盖改为 `{stem}.analysis.wav` **旁路瞬态转码**（4dbf8247/16fd08d2）：原文件字节不变，`analyze_audio_file` 的 `finally` 当场清理，数据目录只留 `.wav`/`.flac` 原件——消除 B 类最高危（就地覆盖毁原件）
- `audio_compressor` 归档清单收双后缀（`.wav`+`.flac`），rmtree 前 `_safe_purge_audio_dir` 断言防丢，归档清单排除 `.analysis.wav`（22d136ff）
- 消费方全量双后缀兼容（e3088f40）：vaudit 四端点 MIME、preview 时间线、check_coverage 统计、mimo 分析器

## [1.4.9] - 2026-09-23

### 新增
- **axeuh_kernel 闭源音频内核（独立进程）——重构轨道 K**（总纲 `7ff68886`）：
  - K0（5eddc955）：内核骨架——FastAPI+uvicorn 独立进程 bind `127.0.0.1` 动态端口（`--port 0` spawn，pidfile `backend/data/kernel_state/kernel.pid`），Bearer+Origin 认证、封闭错误码、能力自描述，零 ML 依赖
  - K1（59564ca2）：声纹切片进内核——评分/池选纯数学 + `/v1/voiceprint` 六端点，黄金分逐位回归锁定与外层旧实现一致
  - K2（ddc557c7）：外层接通内核——speakers/cohort/preview 评分经 `kernel_client.py` 接线，语音助手 WS 删除
  - K3（6d718121→07308042）：作业通道 `kernel_job_client.py`——提交/查询长轮询+幂等键、原子持久化状态机、产物上传通道替代 base64、作业列表与取消、重启后中断作业重投
  - K4a-d（43bba41b/463340f3/24a616ff/307a43e1）：vad/asr/scene/diarize/voiceprint 五类作业接入、`/v1/stream` WS 实时流帧协议 + KWS 逐帧唤醒（`wakeup.hit` 桥回外层状态机）、声纹注册库双写收口修复分裂脑（方案 A）、唤醒词表编码走内核 `kws_encode`
  - K5（4cb636f3/7aac3614/34f60995）：契约文档 `docs/kernel-contract.md` 按事实定稿、`kernel/AGENTS.md` 新建、PyArmor 源码保护构建 + `EULA.md` 分发；ERes2NetV2 声纹权重随包落地修复 503（cee91b5d）
- **健康数据多源架构——重构轨道 H**（与 K 并行，总纲同 `7ff68886`）：
  - H1/H2（d0e8e3c3/5671ed1d）：`HealthStore` 分片原子写 + RLock + 派生视图单一写者（暗接入零行为变更 → 写路径切换，legacy 惰性种子防覆盖）
  - H3（eefdb90c）：修复两 bug——dashboard 步数改求和口径、upload-db 改走 HealthStore 单一写者
  - H4（31c65d94 等）：`health.primary_user` 配置键 + 109 天历史分片迁移（备份+演练后正式应用）
  - H5（d5ed5ff1）：小米云源架构——sources 抽象 + 云拉取适配（`mi_fitness_fetch.py` 收录）+ 源选择 exclusive/merge + 拉取任务（默认关）
  - H6（9cc4692c）：多用户隔离生效——去 default 降级、主用户派生视图接线、设备注册表自动建档
- **OpenCode loopback 认证**（4a809176）：HTTP Basic fail-open 接入，防本机进程劫持会话
- **voice 管线不变量自检**（bd398ef1）：音频段 vs voice 事件机械对账，崩溃/缺口第一时间暴露

### 变更
- `session_compactor` 收编走 gateway（d123f372），消除直连 OpenCode 旁路
- `_collect_voice` 恢复 vp `ws/max/pct` 与 env 三形态兼容（fac2e915）；perception voice 的 `text` 由只取首段改为拼接全部 segs（0e2c004b）
- 文档同步（028ed2cf→e1e3bb5f）：根/backend/services/routers AGENTS 补内核接线与 health 多源说明，设计总纲 K0-K5+H1-H6 进度全量收口

## [1.4.8] - 2026-09-21

### 新增
- **学习教练出题机制**（b4f5d8cc，09-16）：每日 08:00 `question` 模式挂载；09-22 由"一天一道"改为"一天 1~3 道、同考点成组"（e6682825）
- **错题本机制**（44cc1ca6，09-21）：科目×月份分片，挂载到学习教练
- 统一消息前缀规则（8b77733f，09-14）：`<Axeuh-home-system>` 信封只留 `current_datetime`，场景标识靠正文首行全角【场景】前缀

### 变更
- **App 设置页重建**（6f0b6a21/321b58a0，09-16）：交互换「列表行 + 二级页」，拆分声音与唤醒、合并通知开关；**设置改动即时生效**——分段时长与唤醒参数不再需要重启采集（32e8f1aa）
- **App 上传链统一**（5cc73d36/21fa41d8）：统一上传入口（采集器只入队、主循环统一发）、待发队列落盘、删除死代码；版本 1.2.0→1.3.0（935503a2）
- App 消除冷启动白屏 + 运行时 401 不再误跳设置页（9f9dc8b4）
- **规则-01 归属规则收敛为三条根规则**（d6bd993d，09-22）：删逐案补丁；事实层停止输出归属标签、sim 只报数值（95c7f44c）；数据边界收窄为"分析任务不碰源数据"、工程类可只读（f7ef9b9e）
- **AI 规范减重三波**（6f153498/fadb5e22）：清沿革话术、砍反例（21 条血案例归档）
- 身份定调（c1bd0d49，09-24）：生活助理定位 + "方方面面有人味"总纲
- `tasks_state.json` 移出版本控制（调度器运行时状态，81268574）；check_coverage 跨午夜溢出过滤 + 余额告警低位补报（2fc9e7d4）
- MiMo 换模型 mimo-v2.5 → v2.6-flash（62968716）；登记手环 `sleep_data` 跨日整段重复上报缺陷（P1，1eed1e2f）

## [1.4.7] - 2026-09-15

### 新增
- **上传音频无缝流**（fe3f32b0/317ea51c）：`audio_ingest_session` + `audio_ingest_registry` 按 `device_id` 维护一条虚拟连续流——时间连续（`B.start_ms <= A.end_ms + tolerance_ms`，默认 1000ms 覆盖 App 500ms 前滚重叠）即同一条流，**不在文件边界切分**；合并发生在音频层（累积 PCM 整段送 ASR，避免跨文件断句）；超容差/设备变化/时间倒流 → 先冲刷再开新流。配置键 `audio.stream.stitch.*`（容差/硬上限 120s/最短块 10s/静音端点 1.5s）
- **崩溃安全 checkpoint**（0e143ba2）：`PcmCheckpointWriter` 每 10 秒 flush+fsync 落 `audio_checkpoint/pending/`，收尾原子转 `upload_cache/`；启动时 `CheckpointRecovery` 恢复孤儿 `.part` 补传；未上传成功条目永不淘汰（LRU + 7 天 TTL + 500MB 上限）。可感知中断（停止/关开关/`onTaskRemoved`/`onDestroy`）当场补传已落盘条目（70c64435），进程被杀才依赖下次启动恢复
- **流式隔离**（0e143ba2）：环境音频与语音唤醒两条链路独立——`perception_store.save_audio(origin=...)` / `analyze_audio_file(origin=...)` 溯源，唤醒流音频落 `stream/{date}/audio/` 不进增量数据
- **端侧 KWS 本地命中**（f617fdd0）：App 本机唤醒命中后 `audio_start` 带 `local_hit=true` 并回填约 2 秒预滚，外层跳过服务端解码直入声纹进门验证
- 唤醒声纹验证窗口覆盖 pre-roll（cfe2e3ee）：修复"只说唤醒词不触发"
- 提示音改内置音效 `res/raw/start.mp3`/`end.mp3`（SoundPool，235c3ae4）+ 双音律动 + 「提示音/TTS 语音音量」滑块各带试听（c1e26d52）；电平峰值 -16/-18 dBFS 归一化到约 -1 dBFS（e48e93e9，响度约 6 倍）

### 变更
- **App 分段改纯固定时长**（07928af7/31a42a3c）：删除 VAD 端点切段（`RMS_THRESHOLD=8.0` 过低从不触发），App 端不含任何端点逻辑，语义连续性由后端无缝流负责
- `client_time` 毫秒精度 + 额外回传 `start_wall_ms`（75fcdf10），后端优先用它推算时间轴（08c84b5b）——修复秒级截断导致跨段裁剪多裁真实音频
- 冲刷尾块过滤纯静音残片（c8561824）：语音占比低于 `min_flush_speech_ratio`（默认 0.05）不产出 voice 条目
- FGS 类型去除 `dataSync`（6cd8b4a5）：治 Android 15 六小时配额杀常驻服务
- 唤醒后最短录音保护改为自录制态起算（默认 2.5s，65c16f88）
- public-sync 保留唤醒词「小贺同学」不清洗（857baaaf）；公开镜像随分发三类预编译产物（92c59262）

## [1.4.6] - 2026-09-14

### 新增
- **语音唤醒与语音指令采集**（`backend/services/wake_word_service.py` + `audio_config.py`）：常开 KWS 唤醒词「小贺同学」（sherpa-onnx `KeywordSpotter` 单例 + 每连接 `WakeWordState` 状态机 `detect→verify→record` + worker 线程，`feed()` 非阻塞、预滚环形缓冲、有界队列丢帧时显式 `reset_stream()`）。进门验证 = 声纹分 + AS-Norm 域切换；停止条件 = 声纹持续低分（3750ms）/ VAD 尾静音（2000ms）/ 硬上限（30min）；随后弱切分 → ASR → 前缀 → 投递主会话。`keywords_score=1.8` / `keywords_threshold=0.25`（2.5 经 17.4h 实测误报 0→2 否决）；词表 `ai/data/wake_word/keywords.txt`、模型 `ai/data/wake_word/sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20/`
- **TTS 设备路由**（`backend/services/device_channel_store.py` + `routers/tts.py`）：内存映射 `user_id -> {device_id: client_type + expires_at}`，滑动 TTL 3600s，最新发送者取得所有权；TTS 优先定向最近发消息设备，回退广播 `tts.fallback_client_types`（默认 `["web"]`），无目标连接时静默丢弃（按要求）。WS 握手新增 `device_id` + `client`（`web`/`native`，默认 `web`），HTTP 发消息读 `X-Device-Id`（+ 可选 `X-Client-Type`）
- **设备标识**：前端 `frontend/mobile/src/composables/useDeviceId.ts`（localStorage 持久化，URL `?device_id=` 优先）+ App `app/.../util/DeviceId.kt`（`SharedPreferences("axeuh_prefs")` UUID）；`component_manager` WS 注册表升级为 `user_id → device_id → client_type` 三级，新增 `send_to_device` / `broadcast_to_type`

### 变更
- **音频参数全量配置化**：新增顶层 `audio:` 节（`stream`/`vad`/`voiceprint`/`wake_word`/`assistant`）与 `tts:` 节，由 `backend/services/audio_config.py` 统一加载（`DEFAULT_AUDIO_CONFIG` + 深合并 + 进程级缓存）。VAD 阈值、声纹滑窗/cohort/注册门、音频流切分与队列等参数不再硬编码
- **声纹滑窗 1000/750 → 1500/750**：与 `audio.voiceprint.sliding` 及分析链路 two_step 对齐，含此前两处泄漏的 `1000.0` 硬编码
- **死配置清理**：`backend/config/config.py` 删除零生效的 `VOICEPRINT_VAD_THRESHOLD` / `VOICEPRINT_COHORT_MAX_SAMPLES`（`MIN_SNR` / `MIN_SPEECH_RATIO` / `MIN_DURATION` 因仍被 `_check_audio_quality` 引用而保留）
- **fallback 漂移修正**：`unknown_speaker_matcher.py` / `unknown_speaker_health.py` / `pyannote_segmenter.py` 的代码级默认值对齐 `DEFAULT_*_CONFIG`；`routers/preview.py` / `routers/speakers.py` 硬编码阈值改读配置
- **VAD 弱切分**：`vad_processor.py` 常量全部改读配置，新增配置门控（默认关闭）的弱切分后处理
- **文档同步**：根 `AGENTS.md`、`backend/AGENTS.md`、`backend/services/AGENTS.md`、`backend/routers/AGENTS.md`、`app/AGENTS.md`、`frontend/mobile/AGENTS.md` 与 CHANGELOG 同步本次变更

### 验证
- 唤醒词标定：真实音频全天复核，`threshold=2.5` 明显劣化，故采用 `0.25`
- 配置化：`audio.*` / `tts.*` 缺省回落等于历史硬编码值，唯一有意变化为滑窗 1500/750

## [1.4.5] - 2026-09-13

### 新增
- **manifest 驱动的双仓同步器 public-sync**（`tools/public-sync/`，f3c84aae）：私有仓库 `axeuh-health-monitor` -> 公开镜像 `LiveLog-AI` 的确定性同步工具。Phase A `generate` 在空 staging 从零重建目标树 + fail-closed 校验 + 确定性校验（不触碰公开仓库）；Phase B `publish` 对账进公开仓库工作区（只操作跟踪文件）+ 重建 orphan 历史 + force-push（需人工复核后单独执行）。全程字节级清洗，作者名 `Axeuh` 原样保留。

### 变更
- **AGENTS.md 精简 290→136 行**（3f2712cc）：行为准则迁入 `memory/self`，主提示词只留必要规则。
- **ai-template 同步 AGENTS.md 精简版**（3562d381）：与实例侧精简对齐，模型占位符固定为 deepseek-flash。
- **public-sync 维护者文档**（e3a5f5ba）：新增 `docs/` 下同步指南、发布复核清单、凭证轮换清单、规则调和说明等；根 README 同步 ai-template 变更。

### 验证
- 同步器确定性：两次构建树哈希一致；发布后 staging 文件集 == 公开仓库跟踪集（孤儿对账）。

## [1.4.4] - 2026-09-11

### 变更
- **02 复盘提示词重构**：
  - git 提交改为**只提交本次复盘涉及的文件**（禁 `git add ai/` 全量），提交责任人统一为子智能体（主智能体验收）
  - 新增「增量裁定」机制：执行前读 `规则-01-data-check.md` 二区中「覆盖 02」条目（补齐规则文件覆盖但无人读取的缺口）
  - 批次文件改为**全量读取**（不再"主读摘要 + 按需打开"）
  - 错误处理合并：1c 只查产出「错误清单」→ 4b **统一修正**（批次文件直接改，唯一产物写回）；代码/工具问题改为**登记 `self/任务.md` 待办**，不当场改
  - 自优化机制去重（删与 1c 重复的"复查验证"）；`health.json` 口径统一（可只读）；通用化（步骤1b 领域进度 / 归属判定表 / 案例 / 考试日期）
  - 结构整理：标题步数校正、步骤 7b 前移为 6b、自检清单对齐正文
  - 移除 `voiceprint_result` 与 `yesterday` 参数（昨日改自算 `{date-1}`）及步骤4声纹检测（声纹已稳定，调度本就不传），同步 `AGENTS.md`/规则-01/`data/README.md` 引用
- **`复盘自优化流程.md` 并入 02**：降级为「深度洞察方法指南」后整体搬入 02 文末，删除独立文件并清理全部引用
- **03/04 回顾提示词清理**：
  - 修正理解文件路径（旧 `{date}-理解.md` → 兼容 `理解-{date}.md` / `理解-{date}-批次-{HH}.md`，此前会把新批次数据判为缺失）
  - 补 git 提交章节（只提交涉及文件）；03 新增「覆盖 03」增量裁定读取
  - 03 去重（health.json 口径三处合一）、清时效注释、通用化（扩展数据源枚举 / 学习 App 与科目）
  - 04 统一**禁读 perception.jsonl**（核心原则/边界/步骤/禁止行为/对比表），核验改用理解记录摘要 + 复盘
- **07-social-card 停用**：`07-social-card.md` → `07-social-card.md.dis`（保留内容，不再调度），文档引用同步
- **文档同步**：`docs/AI_SYSTEM.md` v2.0 → v2.1（目录树/数据流/关键文件表/02 工作流/归档段/反馈回路/调度时间按 yaml 校正）；`docs/ai-template-同步指南.md`、`ai/social/AGENTS.md`、`ai/data/README.md` 引用更新

## [1.4.3] - 2026-09-11

### 变更
- **01 提示词通用化**：领域任务外置 memory——删除 01 内嵌的"学习识别/提取"（步骤 4 学习归档 + 步骤 9 学习教练），01 降至 415 行、步骤 0~8 连续；新增步骤 8「执行 memory 声明的任务」通用挂载点（扫 `self/tasks/`，按 frontmatter 触发条件执行）
- **领域任务包机制**：新增 `ai/memory/self/tasks/学习教练.md`（自包含：触发 + 识别 + 产物 + 通知）+ `_template/task-领域包.md` 模板；主智能体不再传 `study_coach_mode`；新增领域 = 丢文件，提示词与调度永不改
- **分析规则外置**：01 的"分析规则"整节迁入 `agents/规则-01-data-check.md`（重构为"基础规则 + 增量裁决"完整规则库），01 保留引用
- **身份/人格外置**：新增 `ai/memory/self/身份.md`（署名 + 语气唯一真源），01 / 任务包 / AGENTS 引用
- **规范整理**：01 机械字段枚举去重（7 处 → 单一定义）、术语统一（确信度 → 置信度）、用户举例泛化、commit 字段数修正、主/子智能体身份声明改为"一体 + 分工"
- **文档同步**：`docs/AI_SYSTEM.md` 更新至 v2.0；`ai/AGENTS.md`、`ai/data/README.md`、`SELF-INDEX.md` 同步

## [1.4.2] - 2026-09-10

### 整理
- 仓库瘦身：`.gitignore` 全面补全（运行时数据/图片/密钥/备份/日志轮转）；删除未跟踪垃圾约 1.63GB（含 funasr emotion2vec 生成的 52.3 万个 `.npy`）；`git rm --cached` 移出运行时缓存/日志与学习图片共 2278 个文件
- 修复 `output_dir` 导致 `.npy` 堆积：移除 `backend/audio_processor.py` 中的 `output_dir="./outputs"`
- 去 demo 化：脚本 Context 引擎由 `demo/context.py` 迁至 `backend/services/scripts/context.py`，`script_runner.py` 候选路径同步更新；其余 demo 原型归档到 `archive/demo/`，实验音频/审计产物归档到 `archive/harvest/`
- git 历史重写：`git filter-repo` 两遍（移除历史中 >5MB 与 >2MB 的 blob），`.git` 体积从 1.8GB 降至 250MB；分支与标签保留，`git fsck` 通过

## [1.4.1] - 2026-09-09

### 变更
- **profile 双轨制重构（记忆体系 v2 完善）**：semantic 从"9 个按领域主题文件"重组为**活/死双轨**——
  - 活档案（会演化、多文件抗膨胀）：`people/` 人物一人一档（家人/同学朋友/待确认人物）+ `事项/` 进行中事项编年史（备考/系统建设/声音感知/插件/假期见面）
  - 死档案（基本稳定）：属性四文件（偏好与禁忌[并入音乐/游戏兴趣]/行为规律/健康基线/常去地点）
  - 7 个旧文件删除（行为模式/技术资产与兴趣/身份与家庭/健康事实/学业与备考/社交关系/行程记录），内容已瘦身迁移，git 历史保留
- **core.md 树状化**：画像概览+目录索引合一（L1 全景+导航），INDEX.md 删除；内容只列进行中事项与稳定概要
- **收割协议升级**：02 归属判定表 + 复盘自优化流程写入目标改为新档案路径，新增"指针纪律"（条目=浓缩+日期+复盘指针，正文不复制）
- 音乐偏好并入偏好与禁忌；家庭备忘/项目参考移 archive；反馈偏好明确为 05 运行配置（路径不变）

### 修复
- 历史文件 224 处旧 semantic 死链清理：已删主题链接移除 203 处、保留主题前缀修正 21 处、备考/human/state 旧路径重定向 36 处（62 文件，保留行内语境文字）
- AGENTS.md/docs 引用路径全面同步（agents 01/03/04/06 + AI_SYSTEM + README 中英）
- 设计文档引用修正指向 docs/（原 ai/memory/ 路径已失效）

## [1.4.0] - 2026-09-08

### 新增
- **声纹审计可视化工具**（`harvest_audit.py` 逐簇鉴定 / `harvest_timeline.py` 2D 时空 / `harvest_3d.py` 三维空间）+ `listen_audio.py` AI 听音工具（人工审计声纹能力根因）
- **声纹四层架构落地**（`unknown_speaker_matcher.py`）：会话累积滚动质心，替代单段即时判定；双闸门去除（5 项 config.yaml 改动，零代码修改可回退）
- **声纹审计平台 vaudit**：后端 `voiceprint_audit` API + `/vaudit` 静态托管 + 前端纯静态 3 文件（HTML/CSS/JS）四页签（cohort 页含实时质量参数面板：imp_mean/imp_std/池内相似度/AS-Norm 参照）
- **记忆体系 v2**（`ai/memory/`）：四分区重构——`self/`（AI 记事本：必读快照/任务/纠错/价值校准/认知/关系/执行日志）、`profile/`（用户画像，含 semantic 主题库）、`fact/`（两层检索索引：总目录 + 月度文件）、`archive/`（旧体系全量归档）；14 类新模板 + SELF-INDEX 导航；agents prompt 路径迁移 + v2 收割协议（归属判定表/ADD-UPDATE-NOOP/无增量零写入）+ 规则-01 增量裁决区；复盘自优化流程 v2 协议化；README/docs/AI_AGENTS 同步
- **fact 历史补全**：06/07/08/09 四个月度文件共 87 行，统一格式与复盘链接，日期连续完整
- **会话压缩器提醒**：上下文压缩成功后 15 分钟自动向主会话发送"加载 self 记忆"（持久化防重启丢失 + 短轮询精确定时）
- DeepSeek 余额告警器 + fact_extractor 支持 balance 感知数据（09-01，补录）

### 变更
- 01/02/03/04 子智能体启动前**强制完整读取 self**（除执行日志/复盘自优化流程），03 双周/04 周报额外精读执行日志
- cohort 采集规则：移除 PANNs speech_prob 门 + sim 门槛 0.05→**0.25**；compaction 改为按天均匀轮询（覆盖 12 天均衡分布）
- 逐字 sim 真实时间对齐：启用 ASR 逐字时间戳（CTC 60ms）替代均匀猜测映射，修复错位 26/36 字问题
- 未知人归档音频改用 `_rs/_rdur` 从 `audio_full` 重切（替代循环外 `_r_audio`）

### 修复
- **60s 整段污染**：VAD 稳态噪声剔除 + 样本时长硬上限（55s）；清理 cohort（active 136 条 / audit 201 条标记 rejected）
- **fact 历史内容修正**：07 月/08 月子智能体产出逐日核对——修正日期错位与虚构内容（07 月初段居家自学被误写为培训、08 月中旬电路内容前移）；07 月全月按复盘重写，补回开营摸底考（07-12 英语 33 分）与结营测试（07-26 阅读满分）；07-28 主人公归属修正（36 分为用户线上小测试、"差 1 分及格"为舍友非用户）
- cohort compaction 时间排序 bug：旧逻辑正序导致最新数据（8 月）被 7 月挤出 active
- 感知链路：恢复音频分析线程启动（模块化提取 voice_summary 时误删）+ `_run` 内 datetime import UnboundLocalError
- 归档段静默 except 改带日志（定位 12:22 后零归档，疑似归档段真实异常被吞）
- unknown_speaker 配置缓存 + 日志只打一次

### 验证
- 记忆重构：旧路径残留引用清零（scripts/AGENTS/docs 全扫描）；fact 87 行格式/链接/日期连续 100%
- 逐字 sim 对齐：26/36 错位字修正到真实时间轴

## [1.3.4] - 2026-09-04

### 修复
- **体检簇间融合链式误并 bug**（`unknown_speaker_health.py` `_merge_fragments`）：
  - 原实现 `while changed` 中同一簇合并后向量集膨胀，继续向后合并导致"链式串人"（A-B 合并后膨胀的 A' 继续误并 C）
  - 修复：每轮基于「本轮开始时的快照」做两两判定，每个簇每轮最多合并一次（`merged_ids` 标记），被并入簇立即从快照移除
  - 实证：修复前 `8959` 簇白天人(09-11时谈电商)与深夜人(23-04时吃夜宵)被链式并成 20 段同一身份（两人实际 sv_ratio 仅 0.07）；修复后正确分离
- **sv_ratio_match 阈值收紧**：`ratio_threshold` 0.5→**0.55**、`min_vectors` 3→**5**（同人高一致簇在 0.55 仍有 0.94-0.995 达标率，不同人仅 0.03-0.05，可分性良好）

### 变更
- **拆分已污染混杂簇**：对 3 个疑似混杂 confirmed 簇（8959/3698/1784，子结构组间质心 sim 0.43-0.51）执行 2 聚类拆分，重算各自质心/count/support_vectors/audio_files，写 `health_人工拆分` 审计
- 拆分后立即用修复后逻辑跑每日体检，深夜相关子簇与主深夜簇（3835, 119段）正确归并 → 形成 **count=175 单一深夜说话人簇**（内部 med=0.83，时段 01-06 时，组间 0.78 无混杂）

### 验证
- 库 342 → 345（拆分 3→6）→ 体检融合后 338 身份 / 10 confirmed
- 链式误并消除：修复后体检每轮每簇最多一次合并，无二次膨胀误并

## [1.3.3] - 2026-09-01

### 新增
- **支持向量集比例判定**（`sv_ratio_match`）：质心相似度不足 0.65 时，新 embedding 与已有向量集两两余弦 ≥0.5 占比 >50% → 仍合并。解决同一人短句 embedding 漂移（0.55-0.65）导致的碎片化
- **体检簇间融合**：每日体检自动检查库内所有 unk 对，向量集比例 >50% 判同一人 → 自动合并碎片簇（质心加权、向量集合并、status 取 confirmed 优先）
  - 实测：试点 51 段体育课音频，21 个 confirmed 碎片 → 1 个 236 段大人物（"体育课老师"正确聚合）

## [1.3.2] - 2026-09-01

### 变更
- 陌生人建档改为**两步切分**：VAD 子段 + score_all_v2 滑窗（1500ms/750ms）高分区域提取
  - 用户本人区域（score>0.5）剔除，不再混入陌生人库（根治"60s 整段混合 embedding"问题）
  - 每个候选人 = 单一说话人的连续话语区，独立 embedding 建档
- **动态 confirm 阈值**：10s 滑窗统计中间档(0.3-0.7)占比 >20% 判多人环境 → confirm_min_count 5(单人)/8(多人)
- unk 条目新增 `env_stats`（speaker_count_est / env_mode / mid_ratio / sample_conf）
- support_vectors 改为**归一化后存储**（修复范数问题导致体检跨簇相似度计算错误）
- 归档策略：默认归档**子段音频**（实际说话片段）而非 60s 整段，便于审计回听
- 清理污染库：400 条旧数据（整段混合样本）备份后清空重建，归档音频与审计日志保留溯源

## [1.3.1] - 2026-08-25

### 变更
- 移除陌生人建档的场景过滤（`require_scene`）：任何场景下满足 win_max/min_tokens/min_duration 即建档，避免场景识别不准漏掉真实对话
- 同步删除 `unknown_speaker_config.py` 默认配置、`config.yaml`、`verify_unknown_speaker.py` 中的场景过滤

## [1.3.0] - 2026-08-23

### 新增
- 陌生人识别（UnknownSpeaker）生命周期维护机制：
  - pending/confirmed 两级状态：新陌生人先 pending 观察，累计 ≥5 段稳定出现才升级为 confirmed（agent 才感知）
  - 支持向量集：每条 unk 保留最近 50 个段 embedding，用于双重确认与体检
  - 每日健康体检：支持向量集重聚，自动发现串扰（内部一致性低）、子簇分裂（两种声音并一簇）、质心漂移
  - `unknown_speaker_health.py` 新模块，挂入清理线程每日执行
- 声纹注册（enroll）改造：
  - VAD 切分 + 逐段 embedding + 逐段 SNR 过滤（`min_seg_snr`，默认 1.0dB）
  - 段间一致性过滤（`min_consistency`，默认 0.55）：剔除混入的他人声音/噪音段，防注册质心污染
- 陌生人建档余弦防护：`max_reg_sim`（默认 0.45），用最像注册人的窗口 embedding 对比，防止本人声音误建档

### 变更
- 陌生人 seg 级判定移入 `perception.py` 滑窗之后（修复用整段 sim 导致本人误判的 bug）
- pending 阶段的陌生人不再对外标记 unknown（保留溯源字段），仅 confirmed 才写 entry 级 unk 摘要
- 声纹库清理：删除 16 条旧迁移声纹（旧项目 Axeuh-home-system），仅保留重新注册的高质量质心

### 修复
- 本人声音被误建档为陌生人（2026-08-23 两次：19:08:28、19:39:30）根因：判定在滑窗前用整段 sim + 短段无防误判
- 注册质量检查误拒真实用户（SNR 门槛过高，19:27 本人录音被拒）

## [1.2.0] - 2026-07-19

### 新增
- 子智能体多级嵌套支持：`parentSessionId` 单级改为 `parentChain` 栈，任意层级可继续打开子智能体列表进入孙会话
- 会话 Token 用量显示：双路径更新（SSE `info.tokens` 实时 + API 消息历史加载），显示 coins 图标 + 格式化数字
- 会话 ID 复制功能：`copySessionId()` 通过 `navigator.clipboard.writeText` + 2 秒勾选反馈
- 测试沙箱 `frontend/refactor/` AGENTS.md 文档
- 子会话栏添加子智能体按钮（之前只有返回按钮，无法在子会话中再打开子智能体）

### 变更
- 前端 SSE 流式消息架构重构：废除 `_activePlaceholder` 模式，改为集中式 Store（SSE 直接修改 `messages.value`）
- 消息角色判定增强：新增兜底逻辑（有 parts 无 content = AI，有 content 无 parts = 用户）
- `initStreaming()` 替代 `configure()` 完成初始化
- 返回按钮文本动态化："返回主会话" → "返回 {父级标题} 会话"

### 修复
- SSE 历史消息回放过早触发 `finalizeStreaming`：`message.updated` 改为 no-op，最终化由 `session.idle` 统一触发
- 用户消息被显示为 AI 消息：`getMessageRole` 添加多层兜底判定

## [1.1.0] - 2026-06-20

### 新增
- 前端 UI 迁移：从单文件 SPA 迁移为模块化 Vue 3 + Vite + TypeScript 架构
  - 30+ 组件、11 个 composables、6 个 API 模块
  - 完整的单元测试 (Vitest) 和 E2E 测试 (Playwright) 覆盖
- 声纹识别功能 (funasr ERes2NetV2)
- OTA 自更新机制
- 多用户隔离认证

### 变更
- 认证中间件重构：统一 Token 校验、移除 localhost 豁免
- 配置系统重构：config.yaml + config.local.yaml 双层覆盖（注：该双层覆盖层后续已移除，现为单层配置；历史保留）
- 移除硬编码密钥，全部纳入配置管理
- GPS 覆盖层全屏显示、预览 Canvas 连续绘制

### 修复
- 修复 OTA 路由认证绕过问题
- 修复音频采集器 UnicodeDecodeError
- 修复定时任务脚本执行路径问题

### 技术债务
- 后端 config.py 中部分遗留属性待清理
- Android App 仍需手动注册 BroadcastReceiver

## [1.0.0] - 2026-05-27

### 新增
- FastAPI 后端初始版本
  - 感知数据接收 (心率/GPS/步数/音频/屏幕/通知)
  - 健康数据同步与查询
  - TTS 语音合成 (MiMo API)
  - WebSocket 实时通信
  - 定时任务调度 (apscheduler)
- Android 数据采集 App (Jetpack Compose)
  - 传感器数据采集 (心率/GPS/步数/音频/屏幕/通知/电量)
  - WebView 嵌入前端 SPA
  - 前台 Service 持续采集
- WebView 前端 SPA (单文件架构)
  - AI 聊天 (流式输出)
  - 健康看板 (7 种图表)
  - 文件浏览、报告查看、系统设置
- AI 分析系统 (OpenCode)
  - 定时数据检查 (每2小时)
  - 每日复盘与报告生成
  - 异常检测
- Windows 远程 Agent
  - 远程截图/文件操作/命令执行
- 一键启动脚本 (start.bat / launcher.py)
