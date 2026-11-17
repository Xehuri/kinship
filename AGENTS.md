# Kinship

**技术栈**: Python 3.10+ (FastAPI) + Kotlin (Android/Compose) + TypeScript (Vue 3/Vite)
**仓库模式**: 公开主仓 + 私有组件分离，11 个子系统（含 Windows 桌面端、音频内核、Loom agent harness、外部 harness 适配、MOSS 旁路、QQ 网关）共用同一后端平台
**生成时间**: 2026-07-19
**上次更新**: 2026-11-17

## 概览

AI 驱动的健康监测系统。Android App 采集传感器数据(心率/GPS/步数/音频等)，FastAPI 后端接收存储，Loom AI（默认，完整工作流）定时分析健康状态和行为模式。PC 感知采集器 (PC Sensor) 采集 Windows PC 状态（前台窗口、空闲、锁屏）并上报后端。Windows 桌面端（`desktop/`，Electron 45）是现有 SPA 的网页套壳，并把 PC 采集端作为子进程内置；服务器地址与证书在本机设置页配置。全部音频算法（ASR/VAD/声纹/KWS/场景/说话人切分/陌生人）由**独立闭源音频内核进程**（运行时 `<project>/kernel`，源码在私有 `kinship-kernel`，包名 `axeuh_kernel`）承载——后端运行时零 ML、零算法实现，只经 `kernel_client.py` / `kernel_job_client.py` / `segment_channel.py` 调用内核。另有 **MOSS 深度音频理解旁路（可选功能，默认关闭）**（`tools/moss-shadow/`，1.6.0 起）：vLLM serve 由 systemd 单元常驻，watcher 文件订阅由后端编排器托管为子进程（`moss_watcher` spec；旧 `axeuh-moss-watch` 单元停用），对落盘 chunk 端到端深读（归因/场景/叙事），产物 `audio_deepdive.jsonl` 旁路文件——**perception.jsonl 一字不改，生产主链零依赖**。Python 环境：生产用 `/opt/venvs/axeuh-health`，内核用 `/opt/venvs/axeuh-kernel`，MOSS 用 `/opt/venvs/axeuh-moss`（2026-11 迁移后的路径；旧 `/opt/kinship/.venv-*` 已不存在）。AI 运行时默认是 Loom（一等、完整工作流）；`harness-plugins/` 提供可选的外部 harness 适配层，dsh 是其中的参考实现，已实现适配层与测试，并在 dsh Web 侧栏提供 Kinship 配置面板与计划排班卡片（`kinship-plan-scheduler` 把 Loom 的计划唤醒调度移植到 dsh，读写同一份 plan master/overlay；计划根等路径由 Kinship 后端经 bridge `/v1/kinship/paths` 推送，dsh 侧无需显式配置；`plan_note`/`plan_done` 可经当日覆盖层写回母版条目，主会话另有模型可调用的 `compact_context`），不是默认路径；运行时切换入口只有 `config.yaml` 的 `ai_backend`（hot 配置，保存即全链生效；旧 `/api/screen/backend` 写入口已退役），dsh 适配层会在 harness 重启后自动恢复绑定会话（不需要人工在 UI 打开）；生产可用性按部署环境验证，其他 harness 按 `docs/dev/adapter-contract.md` 接入（含 §3.1.1 冷启动恢复要求）。运行时定位与选择见 `docs/dev/ai-runtimes.md`。本仓库模板默认 `ai_backend: loom`；本机生产实例当前为 `dsh`（2026-11-17 实测 `/health` 报 dsh online、Loom 单元停用），Loom 未废弃。

**私有/单独交付**：`ai/`（运行时数据与记忆）、`kernel/`（闭源音频内核）、`tools/moss-shadow/`（MOSS 旁路，可选功能）不在本公开仓库发布；`docs/archive/` 与 `docs/dev/记忆-A方案-2026-10-20.md` 属于私有历史/设计文档，公开树不包含。`harness-plugins/`（可选外部 harness 适配）已纳入 `tools/kinship_export/allowlist.toml`（2026-11-17），随公开树发布；`tools/docs-check/` 与 `tools/check_stratum_*.py` 同样随公开树发布。仍不导出：`ai/`、`kernel/` 源码与权重、`tools/moss-shadow/`（均为私有组件）；`.github/` 的 CI 工作流自 2026-11-17 起随公开树发布。

**三目录/仓拓扑**：公开仓 `kinship`（源码、发行资产；不含 `ai/`、内核源码、`tools/moss-shadow/`、CircuitJS1 运行时）；私有仓 `kinship-kernel`（闭源内核源码）；私有实例目录 `kinship-data`（`config.yaml`、证书、`backend/config/auth.json`、AI 运行时数据，不入 git）。运行时内核位 `<project>/kernel` 是发行资产安装位，源码只在私有仓；`data.ai_root` 是唯一 AI 根（默认 `<project>/ai`，可指向 `kinship-data`），`data.dir` / `data.root` / `models.dir` 独立配置。

## 系统架构

```
采集层                       存储层                          处理层                输出层
Android App ──┐
              ├─ HTTPS :8768 ─→ FastAPI 后端 ─→ ai/data/daily/{date}/ ─→ Loom AI     ─→ 理解/复盘/健康清单
PC 采集器 ────┘   (对外 8768)      │  单端口 :8768           perception.jsonl     :5100      → ai/memory/ 长期记忆
              WS 上报            │                       health.json                    → 手机通知
                                 ├─ 调度器(每秒轮询) ─→ ai/data/tasks/*.yaml ─→ 触发 AI 任务
                                 └─ 音频内核 kernel/（闭源独立进程，bind 127.0.0.1 动态端口：ASR/VAD/声纹/KWS/切分/陌生人全在内核）

可选旁路（1.6.0，默认关闭，主链零依赖）:
  daily/{date}/audio/ 落盘 chunk ─(文件订阅)─→ tools/moss-shadow/ watcher ─→ :8100 MOSS-N2(vLLM, systemd 常驻 GPU)
        └→ ai/data/daily/{date}/audio_deepdive.jsonl(+_merged) ─(fact_extractor └ MOSS 子行)─→ Loom 交叉消费
```

图中 `ai/`、`kernel/`、`tools/moss-shadow/` 均为私有/单独交付组件，公开树不包含其实现。

| 层 | 职责 | 边界 |
|----|------|------|
| 采集 | 手机 / PC 传感器采集并上报 | 只负责采集，不做分析 |
| 后端 | 数据接收、存储、定时任务调度、内核编排 | **不做任何 AI 分析、不含任何音频算法实现**（编排+IO+兜底降级） |
| 音频内核 | 全部音频计算（ASR/VAD/声纹/KWS/场景/说话人切分/陌生人），独立进程 bind `127.0.0.1`，由后端 spawn | **不碰业务、不读写 `ai/`**；契约唯一真源 `docs/kernel-contract.md` |
| AI | 读取已落盘数据做分析、写回结论 | **不自建服务、不读项目代码** |

数据以**文件系统**为接口：后端写 JSONL/JSON，AI 读文件，两侧解耦。

AI 处理遵循 **脚本层 → 子智能体层 → 主智能体层** 三层工作流；现行 Loom 架构以本文件与 `config.yaml` 为准，AI 运行时选择见 `docs/dev/ai-runtimes.md`。历史架构快照保存在私有归档，不进入公开树。

## 目录结构

完整顶层树与每个子系统的入口见 `docs/dev/PROJECT_MAP.md`。

## 子系统速查

| 子系统        | 位置                 | 语言/框架                 | 入口                  | 关键文档                      |
| ------------- | -------------------- | ------------------------- | --------------------- | ----------------------------- |
| 后端          | `backend/`         | Python 3.10+ / FastAPI    | `main.py` (uvicorn) | `backend/AGENTS.md`         |
| 音频内核      | `kernel/`（运行时安装位；源码在私有 `kinship-kernel`） | Python / FastAPI+uvicorn 独立进程 | `python -m axeuh_kernel`（外层 spawn，HTTP+WS 同端口 `127.0.0.1:{port}`，pull-first） | `docs/kernel-contract.md` |
| Android App   | `app/`             | Kotlin / Jetpack Compose  | `MainActivity.kt`   | `app/AGENTS.md`             |
| 前端 SPA      | `frontend/mobile/` | TypeScript / Vue 3 + Vite（v2-only 壳层） | `src/main.ts`       | `frontend/mobile/AGENTS.md` |
| AI 分析       | `ai/`（私有，单独交付） | Python + Loom（默认）/ dsh（可选）/ OpenCode | `data/tasks/*.yaml` | 私有侧文档              |
| Loom agent harness | `loom-harness/` | TypeScript / Node | `packages/server/dist/cli.js` | `loom-harness/docs/` |
| 外部 harness 适配 | `harness-plugins/`（可选；dsh 为参考实现） | TypeScript / Node | `packages/kinship-bridge/src/server.ts` + `packages/kinship-ui/client.js` + `packages/kinship-plan/` + `packages/kinship-plan-scheduler/`（计划唤醒调度） + `packages/kinship-compact/`（`compact_context`） + `packages/kinship-task-compat/` + `packages/kinship-tools/`（通知/提醒/TTS 原生工具） + `packages/kinship-isolation/`（preset 级排异） | `docs/dev/ai-runtimes.md` + `docs/dev/adapter-contract.md` + `harness-plugins/packages/kinship-plan-scheduler/docs/DETAIL.md` |
| PC 感知采集器 | `desktop/pc-sensor/`       | Python / FastAPI          | `pc_sensor_app.py`  | `desktop/pc-sensor/AGENTS.md`       |
| Windows 桌面端 | `desktop/` | TypeScript / Electron 45 + Vue 3 | `src/main/main.ts` (Electron) | `desktop/AGENTS.md` |
| MOSS 旁路 | `tools/moss-shadow/`（私有，单独交付） | Python + vLLM（可选功能，默认关闭；systemd `axeuh-moss` serve；watcher 由后端编排器托管） | `watcher.py --loop` / `merge.py --date` | 私有侧部署说明 |
| QQ 网关 | `backend/services/qq_gateway/` | Python / 单 WS + qq CLI | `backend/main.py` 按 `qq_gateway.enabled` 启动（默认关闭；生产已启用）；入站 relay + `qq` CLI | `docs/dev/qq-gateway.md` |

## 常用入口

- 文档索引/真源矩阵：`docs/README.md`
- 任务路由表：`docs/dev/PROJECT_MAP.md` 的「Agent 路由」节
- 运行注意事项：`docs/ops/OPERATIONS.md`
- 配置热更新与初始化向导：`docs/ops/system-config-hot-reload.md`

## 操作准则

### 服务管理

- 生产服务用 systemd 管理：`sudo systemctl restart axeuh-health`（编排器托管 kernel、MOSS watcher；`ai_backend=loom` 时还托管 Loom。dsh 是独立的 `axeuh-dsh` 单元，不归后端编排器）；独立 `axeuh-loom` 单元默认停用，仅回滚用。后端也可用 `POST /api/screen/restart` 优雅重启
- 不得用 `Stop-Process` / `taskkill` 释放端口；确需结束进程时只按 PID `kill <PID>`，禁止 `pkill` / `killall` 按名称批量杀
- PC 感知采集器有 `/restart` 端点；后端重启端点为 `POST /api/screen/restart`（需 Bearer 认证，定义于 `backend/routers/maintenance.py`，路由前缀 `/api/screen`）

### 调试连接

- 所有调试连接必须使用 HTTPS，不要降级到 HTTP

### 代码修改

- **禁止**使用脚本(Python/Shell/Bat)直接修改 `.kt`、`.java`、`.py`、`.ts` 等源代码文件 —— 会导致乱码
- 所有代码修改应通过 `task()` 委托给子智能体执行

### 临时文件

- 所有临时文件存放在 `<TMP_DIR>`

## 项目级约定

### 记忆协议（Phase A，私有侧）

- 生产记忆以实例 AI 根内的 `ai/memory/PROTOCOL.md` 为唯一规则源：证据 → `ledger/`（facts / rules / open）与 `notes/` → 投影；02 日复盘是唯一日更写入者，主会话只写 `notes/proposals` 等提案，旧 A 方案文件冻结只读，`memory_finalize.py` 做收尾门。
- 仅适用于私有运行环境中的 `ai/` 记忆目录，不随公开仓库发布；协议、迁移记录与评测数据保存在私有侧，公开树不包含（公开模板 `ai-template/` 仍是旧骨架）。

### 跨子系统约定

- Git 提交必须实时：每次 AI 任务完成后立即 `git add` + `git commit`
- 项目根目录的 `config.yaml`、`.env` 不提交到 git
- `backend/config/auth.json` 包含加密密码 —— **注意不要在 git 中泄露**
- AGENTS.md 用中文编写，子目录不重复父目录内容
- 首次启动：11 步 onboarding（`welcome`→`account`→`dependencies`→`kernel`→`kernel_models`→`xiaomi`→`qq`→`moss`→`loom`→`clients`→`finish`），state v4；单一启动路径，未配置服务以编排器 `blocked` 状态表达（不再有 bootstrap 延迟服务面），`finish` 内依次合并预检、应用草稿与就绪审计并记录 completed；模型根在 `kernel_models` 步选择（只写 `models.dir`）；发行清单固定 frontend/kernel/Android/Windows 资产。详见 `docs/ops/INSTALL.md` 与 `docs/dev/onboarding-v4-2026-10-27.md`。

### Python 约定 (backend/ + desktop/pc-sensor/)

- FastAPI routers + services(单例模式) + middleware(auth) 架构
- 配置加载：`backend/config/config.py` 读取单个配置文件，优先级为 `CONFIG_PATH` 环境变量（由 `launcher.py --config` 注入）→ `backend/config/config.yaml` → 项目根 `config.yaml`；**不存在多文件合并/覆盖层**
- Token Bearer 认证，**无 localhost 免认证**（所有请求均需 Token；公开路径见 `backend/middleware/auth_middleware.py`）
- 测试: pytest + TestClient，conftest.py 提供 client/auth_headers fixture

### Kotlin/Android 约定 (app/)

- 包名 `com.xehuri.kinship`，minSdk 26 / targetSdk 36
- Kotlin 代码在 `src/main/java/` 目录下（兼容 Gradle 标准）
- 分层架构：网络层(AppHttpClient) -> 状态层(SensorStateHolder) -> 采集层(BaseCollector) -> UI层(ViewModel/Compose)
- 测试: JUnit 5 + MockK + Robolectric + Truth，反引号函数命名 `@Test fun \`should do X\``

### TypeScript/Vue 约定 (frontend/)

- Vue 3 Composition API + `<script setup>`，严格TS模式
- 无 Pinia —— 所有状态用 composables 管理，参考 `frontend/mobile/src/composables/`
- Router hash 模式，路径别名 `@` -> `./src`
- 前端只有 `mobile/`（主 SPA，`npm run dev` Vite proxy 到后端 HTTPS 8768；`npm run build` 产出 `dist`）；历史 `frontend/preview/`（音频预览台）与 `frontend/vaudit/`（声纹审计静态页）目录已不在仓库树中，后端 `main.py` 仍挂 `/preview/`、`/vaudit/` 静态路由，目录缺失时返回 404（2026-11-17 实测）
- 前端为 v2-only 壳层：桌面 6 项（对话/计划/提醒/报告/文件/设置），移动端 4 项（对话/计划/报告/设置），共享 `config/navV2.ts`；旧健康看板已移除，`/dashboard` 落 404
- 集中式Store模式: SSE事件直接修改 `messages.value`，不依赖占位符注册
- 子智能体系统: 多级嵌套栈 (`parentChain`)，API + 消息扫描双重数据源
- Token用量: 双路径更新 (SSE实时 + API历史加载)
- 测试: Vitest + happy-dom (单元)，Playwright (E2E)

## 构建与运行命令

```bash
# 启动整个系统
python launcher.py                     # 推荐，支持 --config / --data-dir
start.bat                              # Windows 开发便捷脚本（生产用 systemd）

# 后端开发（单端口 8768；本地开发先把 ssl.enabled 设为 false）
cd backend && python -m uvicorn main:app --reload --port 8768

# 前端开发
cd frontend/mobile && npm run dev

# 前端构建（生产构建到 dist-<时间戳> 并校验；替换 dist/ 后无需重启后端）
cd frontend/mobile && npm run build:atomic && npm run verify:dist

# Android 构建（须在仓库根执行，app/ 内没有 gradlew）
./gradlew :app:assembleDebug

# 运行测试
cd backend && python -m pytest tests/ -v    # 后端测试
cd frontend/mobile && npm run test:unit     # 前端单元测试
cd frontend/mobile && npm run test:e2e      # 前端 E2E 测试
./gradlew :app:testDebugUnitTest            # Android 测试
```

## 反模式（禁止）

1. **强杀进程**：用 `Stop-Process`/`taskkill`/`pkill` 释放端口 —— 应用 systemd 或重启端点；确需结束只按 PID
2. **脚本改代码**：任何 Python/Shell 脚本直接写 .kt/.py/.ts 文件 —— 委托给 task()
3. **运行时数据提交（私有侧）**：日志文件、用户数据、`outputs/.npy`、`ai/data/daily/*/audio_deepdive*.jsonl`、`tools/moss-shadow/state/` 不应提交到 git
4. **配置硬编码**：路径、端口、密码应走配置（`CONFIG_PATH` / 项目根 `config.yaml`），不硬编码在脚本中
5. **误以为存在配置覆盖层**：加载器只读单个配置文件，不存在多文件合并/覆盖，配置改动直接改 `config.yaml`
6. **在 AI 会话中查看项目代码（私有侧）**：AI (`ai/`) 只关心 `ai/` 目录内的数据文件，不读项目代码

## 运行注意事项

完整运行细节、端口、音频链路、Loom/MOSS 注意事项已移至 `docs/ops/OPERATIONS.md`；本节只保留硬规则：

- 生产服务用 systemd 管理；结束进程只按 PID，禁止 `pkill` / `killall`。
- 所有临时文件放 `<TMP_DIR>`。
- 端口、路径、运维细节以 `config.yaml`、`docs/dev/PROJECT_MAP.md`、`docs/ops/OPERATIONS.md` 为准。
- Android WebView 复用原生 `auth_token`：`WebTokenBridge` 在页面完成/回前台/token 变化时注入 `localStorage.mobile_token` + `axeuh-token-refresh`；详见 `docs/dev/android-webview-token-bridge-2026-10-25.md`。
