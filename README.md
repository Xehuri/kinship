# Kinship

**中文（默认）** | [English](README.en.md)

> 状态：2026-10-30。中文是默认入口；英文 README 是摘要与镜像。完整文档见 `docs/`。

自托管的 AI 个人数据助理。Android App 持续采集手机和手环传感器数据（心率、步数、GPS、环境音频、通知、屏幕状态等），上传到私有后端；Loom AI（生产）定时分析并生成理解、复盘、健康清单与通知。系统全部运行在你自己的服务器上。

## 为什么是 Kinship

Kinship 不是“又一个健康手环 App”，也不是“套了健康数据的聊天机器人”。它是一个自托管的、长期运行的个人生活智能体：手机、手环、PC 和音频持续提供生活痕迹，系统把这些痕迹整理成可追溯的事实，再让 AI 按自己的节拍做理解、复盘和提醒。

它的重点不是让 AI 多聊几句，而是让 AI 长期、安静、可解释地参与你的生活。

### 它不做什么

- 不做云端 SaaS：数据默认落在你自己的机器上。
- 不把数据锁进黑盒数据库：核心接口是文件，可读、可备份、可迁移。
- 不假装 AI 全知：音频、情绪、疲劳看不准的地方，会明确说看不准。
- 不把音频算法塞进业务后端：音频由独立内核负责，后端保持轻量。

### 六个不一样的地方

1. **生活流，而不是聊天记录。** 输入不是一句“我今天很累”，而是睡眠、步数、心率、音频场景、屏幕活动和行为节奏的组合。
2. **文件是接口，不是黑盒。** `perception.jsonl`、健康分片、Markdown 日报和记忆文件都可直接读取；AI 只是这些文件的读者和写作者。
3. **音频内核独立，后端零 ML。** ASR、VAD、声纹、KWS、场景和说话人切分都在独立内核里，后端只通过契约调用。
4. **AI 有自己的节拍。** 每日检查、每日复盘、每周总结和唤醒队列让它不只是被动问答，而是按时间结构工作。
5. **事实与判断分开。** 脚本层做确定性预处理，子智能体做理解与复盘，主智能体做编排和验收，结果更容易追溯。
6. **全栈自托管，模型可替换。** Android、FastAPI、Vue/Electron、PC 采集器和音频内核组成完整链路；可以接本地 vLLM，也可以接兼容 OpenAI 的 API。

### 适合谁

适合愿意自己维护机器、在意数据主权、有长期记录习惯，并能接受早期项目不完美的人。

不适合想要开箱即用 SaaS、医疗级诊断、完全准确的音频识别，或不愿处理部署与模型运维的人。

**一句话：Kinship 是一个把生活数据留在自己手里、让 AI 按自己的节拍长期理解你的自托管系统。**

## 仓库布局

Kinship 分为三个位置，不是单一仓库：

| 位置 | 内容 | 分发方式 |
| --- | --- | --- |
| `kinship`（本仓库） | 后端、Android App、前端、桌面端、Loom harness、文档、发行资产 | 公开源码树 |
| `kinship-kernel` | 闭源音频内核源码（`axeuh_kernel`） | 私有；PolyForm Noncommercial 1.0.0 |
| `kinship-data` | `config.yaml`、证书、`backend/config/auth.json`、AI 运行时数据与上传文件 | 私有；不入 git |

公开树不包含 `ai/`、`kernel/` 源码、`tools/moss-shadow/` 与 CircuitJS1 运行时。`ai/` 是由 `ai-template/` 创建的实例数据；内核以预编译发行资产安装到 `<project>/kernel`；`tools/moss-shadow/` 为私有组件；CircuitJS1 在 dev/build 时从独立的 `kinship-circuitjs` 仓库获取。

运行时后端依赖三个位置：`<project>/kernel`（已安装的内核包，无需源码）、`data.ai_root`（唯一 AI 根，默认 `<project>/ai`，可指向私有 `kinship-data`）、以及独立的私有数据根（配置、证书、认证状态、模型与运行时数据）。全部内核模型（含 ERes2NetV2）由 `kernel_models` 引导步骤下载；内核压缩包不含 `models/` 目录与 `.ckpt` 文件；内核 API 保持 1.0.0。

## 生产拓扑

```text
Android App / PC Sensor
  -> https://<domain>:8768        (frpc TCP 8768 -> 本机 8768，后端 TLS)
浏览器
  -> https://<domain>             (frpc TCP 443 -> 本机 Caddy 443)
  -> https://<domain>:8443        (IPv6 直连 Caddy 8443)
Caddy 443/8443
  -> https://127.0.0.1:8768       (跳过上游证书校验)
FastAPI 后端 8768（HTTP/HTTPS 同端口）
  -> Loom 127.0.0.1:5100          (助手唯一宿主，由 axeuh-health 托管为子进程)
  -> 音频内核 127.0.0.1:<动态>     (后端 spawn，闭源进程)
  -> MOSS 127.0.0.1:8100          (转正执行中，卡2)
```

### 端口

| 端口 | 作用 |
| --- | --- |
| `8768` | 后端（HTTP 与 HTTPS 同端口，由 `ssl.enabled` 决定协议） |
| `5100` | Loom 助手宿主 |
| `18888` | PC 感知采集器本地 HTTP |
| `8000` | 本地 27B LLM（vLLM，按需） |
| `8100` | MOSS serve（转正执行中，loopback） |
| `8790` | 音频工作台（素材试听/人耳标注） |
| `8770` | QQ 网关 IPC（qq CLI） |
| `5173` | Vite 开发服务器 |
| `127.0.0.1:<动态>` | 音频内核（实际端口见 pidfile） |

## 快速启动

完整平台矩阵、退出码与排障见 [docs/ops/STARTUP.md](docs/ops/STARTUP.md)。

**Linux / macOS**

```bash
./scripts/setup.sh
./scripts/start.sh
```

**Windows**

```bat
setup.bat
start.bat
```

**Linux 生产（systemd）**

```bash
sudo cp deploy/kinship.service.example /etc/systemd/system/kinship.service
sudo systemctl daemon-reload
sudo systemctl enable --now kinship
```

`deploy/kinship.service.example` 中的路径、用户与解释器均为占位符，需按实际部署修改。

`setup.sh` / `setup.bat` 创建 `.venv`、安装后端依赖，并在缺失时从 `config.example.yaml` 生成 `config.yaml`、从 `ai-template/` 生成 `ai/`，不会覆盖已有文件。`start.sh` / `start.bat` 在前台启动后端；手动启动的等价命令是在 `backend/` 下执行 `python -m core.hot_server`。首次启动前按 [docs/ops/CONFIGURATION.md](docs/ops/CONFIGURATION.md) 检查服务器、SSL、模型与密钥。

脚本不构建前端，也不安装或构建音频内核。`frontend/dist` 缺失时由首次引导下载发行资产；手动构建仅用于开发，需要单独的 CircuitJS 仓库。音频功能依赖外部内核，缺少内核时后端仍可启动，但音频不可用。

启动后打开 Web UI 完成管理员注册与 11 步初始化（账户、依赖、内核、模型、小米健康云、QQ、MOSS、Loom、客户端、完成），并确认 `http://127.0.0.1:8768/health` 返回 `{"status":"healthy"}`。Android App 与 PC 感知采集器的安装见 [docs/ops/INSTALL.md](docs/ops/INSTALL.md)，首次 AI 初始化按 `ai-template/系统初始化指南.md` 执行。

## 核心能力

- **Loom 助手（生产）**：`127.0.0.1:5100`，由 `axeuh-health` 托管为子进程（独立 `axeuh-loom.service` 停用，仅回滚）；`ai_backend: loom`。
- **三层工作流**：脚本层（`fact_extractor.py` / `check_coverage.py`）→ 子智能体层（data-check / reviewer）→ 主智能体层（派发、验收、自优化）。
- **定时调度**：默认 7 个数据检查窗口（00/06/08/12/16/20/22），每日复盘 00:40，双周复盘 1/15 18:30，周报周一 03:00。
- **记忆 A 方案**：主会话常驻 6 件（约 36.5 KB），批次/复盘 role 注入 5 件 core；`memory_write` / `memory_retrieve` / `memory_audit` / `memory_consolidate`；检索以 `grep` + `read` 为主。
- **MOSS 旁路（转正执行中）**：`tools/moss-shadow/`，`axeuh-moss` + `axeuh-moss-watch`，输出 `audio_deepdive.jsonl`；七步已完成，待两日回归 + 七天观察；事实文件只消费 `静音`/`ambient`，human/mixed/device 留审计；`perception.jsonl` 与主链零改动。
- **QQ 网关**：单 WS + SQLite inbox/outbox/read-state/water-state + qq CLI IPC `127.0.0.1:8770`；qq-mcp 已退役；群聊元数据提醒与水群模式；默认关闭，生产已启用。
- **Loom 运行时**：交互式 PTY、flow 自动唤醒、回执简化、ops+chat 双视角压缩。

### Loom 的四个特点

- **Plan 机制**：`plan` 工具提供 `read` / `commit` / `revise` / `note` / `close`，把当日计划、coverage 检查点、care 与长任务写成带版本和 CAS 校验的计划文件。日计划与计划复核走 Plan mode，只读并执行 `plan commit` / `plan revise`，不执行 care、不主动发用户通知。
- **Flow 机制**：`flow_commit` / `flow_list` / `flow_get` 维护可恢复的主线，记录 `active` / `waiting_user` / `waiting_event` / `closed` 状态、focus、`next_decision_at` 与关闭条件。FlowGate 只在主会话生效，`flowEnded` 负责收束回合，自动唤醒按 `next_decision_at` 投递；旧的 converge 路径已禁用。
- **上下文 diff**：每个会话维护自己的上下文快照。`SessionContextWatcher` 只轮询注入源的 stat 变化，把变化转成有字节预算的 unified-diff notice，下一轮只注入变化片段，而不是把整份 memory 和历史重新灌入。
- **上下文注入**：装配顺序是稳定前缀（`AGENTS.md` + memory + 任务 prompt）→ boundary 摘要 → 每轮增量尾部。稳定前缀字节恒定以命中 prompt cache；memory Markdown 自动扫描，源缺失或损坏时 fail-soft；压缩只写 boundary 摘要，并提供 ops/chat 双视角。

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [README.en.md](README.en.md) | English mirror / short summary |
| [docs/README.md](docs/README.md) | 公开文档索引 |
| [docs/ops/STARTUP.md](docs/ops/STARTUP.md) | 平台启动脚本、systemd 示例、首次初始化 |
| [docs/ops/INSTALL.md](docs/ops/INSTALL.md) | 安装 1-5 阶段、AI 工作目录、唤醒词、PC 采集器 |
| [docs/ops/CONFIGURATION.md](docs/ops/CONFIGURATION.md) | `config.yaml` 完整参考 |
| [docs/dev/API.md](docs/dev/API.md) | API 端点表 |
| [docs/dev/PROJECT_MAP.md](docs/dev/PROJECT_MAP.md) | 目录结构与子系统地图 |
| [docs/dev/AUDIO_PIPELINE.md](docs/dev/AUDIO_PIPELINE.md) | 环境音频上传、无缝流、WAV/FLAC |
| [docs/dev/AI_SYSTEM.md](docs/dev/AI_SYSTEM.md) | AI 架构：Loom、任务、记忆、MOSS、QQ |
| [docs/dev/DATA_FORMAT.md](docs/dev/DATA_FORMAT.md) | 感知与健康数据格式 |
| [docs/kernel-contract.md](docs/kernel-contract.md) | 闭源音频内核契约 |
| [docs/kernel/README.md](docs/kernel/README.md) | 内核分发、模型、运行时路径与许可 |

部署排障与 Loom 运维等私有文档保留在私有仓 `docs/`，不随公开镜像同步。

## 常见问题

- **首次启动没有账号密码**：打开 Web UI 完成首次设置，凭据写入 `backend/config/auth.json`；默认要求一次性引导令牌（`backend/config/.setup_token`，通过 `X-Setup-Token` 提交），仅可信内网可显式设 `auth.setup_require_token: false` 关闭。
- **Android App 连不上**：确认使用 `https://`、端口与 `server.https_port` 一致、服务器证书被系统信任；自签证书不能靠浏览器接受一次解决。
- **前端 404**：`frontend/mobile/dist/` 不存在，执行 `npm run build` 后重启后端。
- **后台服务被杀**：小米/OPPO/华为等需锁定最近任务、关闭电池优化并允许自启动。

完整 FAQ、故障排查与部署细节见 [README.en.md](README.en.md) 和私有仓部署指南。

## License

本仓库采用按组件划分的许可：

- 仓库根目录（含后端、AI、工具及下方未单独列出的文件）：[AGPL-3.0-only](LICENSE)
- Loom：[AGPL-3.0-only](loom-harness/LICENSE)
- 前端、Android App、桌面端：[Apache-2.0](frontend/mobile/LICENSE)
- 音频内核：[PolyForm Noncommercial 1.0.0](docs/kernel/LICENSE)，商业用途需另签协议，见 [docs/kernel/COMMERCIAL.md](docs/kernel/COMMERCIAL.md)；分发条款见 [docs/kernel/EULA.md](docs/kernel/EULA.md)
- CircuitJS1：GPL-2.0，已迁至独立仓库 `kinship-circuitjs`，dev/build 前按需抓取，不在本仓库公开树中分发

第三方组件与声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

Copyright 2026 Xehuri.

## Contributing

欢迎贡献，见 [CONTRIBUTING.md](CONTRIBUTING.md)。
