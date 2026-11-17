# Project Map

> Extracted from `README.md` (2026-10-22; updated 2026-11-17). For agent-oriented routing, see `AGENTS.md`.

## Repository View

The `kinship` repository holds the runnable source; the published public tree is a subset of it (see `tools/kinship_export/allowlist.toml`). Private components are kept in separate repositories or directories.

```
Kinship/ (repository tree)
├── config.example.yaml        # Configuration template (real config stays private)
├── launcher.py                # Unified launcher
├── start.bat / start.ps1      # Windows convenience launchers
├── build.gradle.kts           # Root Gradle build script
├── gradle/ + gradlew*         # Gradle wrapper
├── backend/                   # FastAPI backend
│   ├── main.py                # Entry point
│   ├── routers/               # API routes
│   ├── services/              # Business services (including scripts/ Context engine)
│   ├── middleware/            # Auth middleware
│   ├── config/                # Configuration module
│   └── tests/                 # Tests
├── frontend/
│   └── mobile/                # App WebView frontend (Vue 3, v2-only shell)
│       └── dist/              # Build output (gitignored; npm run build:atomic)
├── app/                       # Android data collection app (Kotlin)
├── desktop/                   # Electron shell + embedded PC sensor (desktop/pc-sensor/)
├── loom-harness/              # Loom agent harness (TypeScript/Node), Kinship default workflow
├── harness-plugins/           # Optional external-harness adapters (dsh reference implementation; exported since 2026-11-17)
├── ai-template/               # Sanitized template for the configured AI root (data.ai_root)
├── deploy/                    # systemd unit references
├── docs/                      # user/ ops/ dev/ adr/ kernel/ + kernel-contract.md
├── scripts/                   # Utility scripts
├── assets/                    # Brand and static assets
├── tools/
│   ├── kinship_export/        # Fail-closed public export (allowlist + scanner)
│   ├── docs-check/            # Markdown link/anchor checker
│   └── check_stratum_*.py     # Stratum prompt/command consistency checks
├── qq                         # QQ gateway CLI wrapper script (see docs/dev/qq-gateway.md)
├── LICENSES/                  # Third-party license texts
└── pyproject.toml / setup.*   # Python project metadata
```

`frontend/mobile/dist/` is build output, not tracked. `frontend/` currently contains only `mobile/` (plus `LICENSE`); the historical `frontend/preview/` (audio preview console) and `frontend/vaudit/` (voiceprint audit page) trees are **not in this repository** (no git history either), so the backend's `/preview/` and `/vaudit/` static routes return 404 when those directories are absent (verified 2026-11-17). `harness-plugins/`, `tools/docs-check/`, `tools/check_stratum_*.py`, `SECURITY.md`, `NOTICE` and `frontend/LICENSE` were added to the `tools/kinship_export/allowlist.toml` allow entries on 2026-11-17, so they ship with the public tree; `.github/` is still outside the allowlist. `tools/moss-shadow/` is a private component (not in the public tree). The configured AI root (`data.ai_root`, default `<project>/ai`) is created from `ai-template/` at install time and is not in the public tree. `kernel/` in a running install is the installed release asset, not source.

### Private and Separate Components

| Component | Location | Role |
| --- | --- | --- |
| `kinship-kernel` | Private repository | Closed-source kernel source; builds the protected release asset |
| `kinship-data` | Private directory (`<DATA_ROOT>`) | `config.yaml`, certificates, auth state, AI runtime data, uploads; never committed |
| `kinship-circuitjs` | Separate public repository (GPL-2.0) | CircuitJS1 runtime fetched at dev/build time; not vendored |

Private or excluded from the public tree: the AI runtime directory (default `ai/`), `kernel/` source, `tools/moss-shadow/`, `validation/`, `archive/`, `docs/archive/`. The kernel runtime installs at `<project>/kernel`; `data.ai_root` is the single AI root (default `<project>/ai`).

前端为 v2-only 壳层：桌面 6 项（对话/计划/提醒/报告/文件/设置），移动端 4 项（对话/计划/报告/设置），导航项定义在 `frontend/mobile/src/config/navV2.ts`；`/dashboard` 已移除并落 404；健康数据入口在报告页健康摘要条、GPS/声纹与设置页「健康数据」/「数据源」。

---

## Agent 路由

下表覆盖私有开发树；`ai/`、`kernel/` 源码、`tools/moss-shadow/`、`validation/`、`archive/` 不在公开树中。

| 任务              | 位置                                                                                   |
| ----------------- | -------------------------------------------------------------------------------------- |
| 文档索引/真源矩阵 | `docs/README.md`                                                                     |
| 首次引导/onboarding | `backend/services/onboarding_service.py`（步骤/状态 v4；preflight/startup 不再是可见步骤，统一由 `finish` 合并预检、应用草稿与就绪审计）+ `startup_validation.py` + `storage_layout.py` + `onboarding_finish.py` + `backend/routers/system_onboarding.py` / `onboarding_startup.py` / `onboarding_storage.py` / `onboarding_finish.py` / `onboarding_qq.py` / `onboarding_xiaomi.py` / `loom_onboarding.py`；前端 `frontend/mobile/src/components/onboarding/`；契约 `docs/dev/onboarding-v4-2026-10-27.md` |
| 添加 API 端点     | `backend/routers/`，在 `backend/main.py` 注册                                      |
| 修改业务逻辑      | `backend/services/`                                                                  |
| 内核端点/kernel_client | `backend/services/kernel_client.py`（同步通道：speakers/cohort/preview 评分、wake_word encode、声纹探针 vp_speaker_count/vp_cohort_stats）+ `kernel_job_client.py`（作业通道：vad/asr/scene/diarize/aed/breath 分析链；重启恢复语义唯一=外层 requeue，内核侧重投死件已随 P0-U6 裁除）；内核新契约端点：`GET /v1/voiceprint/registry` 元数据快照（K1a，向量永不外带）、`DELETE /v1/artifacts/{id}` 消费即删（K2a）；内核侧端点契约见 `docs/kernel-contract.md` |
| 脚本 Context 引擎 | `backend/services/scripts/context.py`（脚本运行时注入的 Context；旧 demo 原型已归档于 `archive/demo/`） |
| 修改 AI 任务/行为 | `ai/data/tasks/*.yaml` + `ai/agents/*.md`                                          |
| Loom 交互式 PTY | `loom-harness/packages/tools/src/pty/`（五工具面：`pty_spawn` / `pty_write` / `pty_read` / `pty_list` / `pty_kill`）+ `loom-harness/packages/server/src/session-api/registry.ts`（退出唤醒 `deliverWake`）；配置 `ai/.loom/config.yaml` 的 `pty` 段 |
| Loom Feature Plugin | `loom-harness/packages/plugin-sdk/`（公开契约）+ `loom-harness/packages/server/src/plugin-host/`（Host/loader/storage）+ `loom-harness/packages/server/src/features/`（todo/pty/task 抽离）；P0-P2a 已实现，P2b 沙箱设计见 `docs/dev/plugin-host-p2b.md`（暂缓） |
| 外部 harness 适配 | `harness-plugins/`（可选；dsh 参考实现：`packages/kinship-bridge/` + `packages/kinship-ui/`（Web 侧栏面板，含计划排班卡片）+ `packages/kinship-plan/`（日计划 + 覆盖层写回）+ `packages/kinship-plan-scheduler/`（Loom 计划调度器移植：母版/覆盖层 + 唤醒队列）+ `packages/kinship-compact/`（`compact_context`）+ `packages/kinship-task-compat/` + `packages/kinship-tools/`（通知/提醒板/TTS 原生工具）+ `packages/kinship-isolation/`（preset 级宿主提示词与工具隔离）+ `presets/kinship.patch.yml`）；契约 `docs/dev/adapter-contract.md`，运行时选择 `docs/dev/ai-runtimes.md` |
| Android 采集器    | `app/.../service/collectors/`                                                        |
| Android UI 设置页 | `app/.../ui/settings/`（状态卡 + 5 组 20 行概览；主页面 `CollectionControlPage` / `DevicePage` / `BackgroundPage` / `SoundPage` / `RunStatusPage`，已退役 `DataCollectionPage` / `SystemPage` / `BatteryPage`） |
| Android 登录态    | `app/.../auth/SessionManager.kt` + `app/.../ui/settings/LoginNavigationPolicy.kt`    |
| Android 连接层/回退 | `app/.../transport/`（TierModels/Codec/Store/Probe/Selector/Runtime/SettingsController）；旧 prefs 三键迁移后只读 |
| Android 设置主题  | `app/.../ui/theme/KinshipTokens.kt` + `SettingsTheme.kt`；令牌真源 `frontend/mobile/src/styles/tokens.css` |
| Android WebView token 桥 | `app/.../web/WebTokenBridge.kt` + `MobileActivity.kt` + `frontend/mobile/src/composables/useApi.ts` + `App.vue` + `api/client.ts`；详见 `docs/android-webview-token-bridge-2026-10-25.md` |
| 前端页面/组件     | `frontend/mobile/src/views/` + `components/`                                        |
| 前端组合式函数    | `frontend/mobile/src/composables/`                                                  |
| 子智能体/嵌套会话 | `frontend/mobile/src/composables/useSubAgents.ts` + `ChatView.vue`                  |
| Token用量显示     | `frontend/mobile/src/composables/useStreamingMessage.ts` + `useChat.ts`             |
| 声纹审计/音频预览 | `backend/routers/voiceprint_audit.py`（`/api/vaudit`）+ `backend/routers/preview.py`（`/api/preview`）；旧静态页 `frontend/vaudit/`、`frontend/preview/` 已不在仓库树，`main.py` 的 `/vaudit/`、`/preview/` 静态路由在目录缺失时返回 404 |
| 通知上下行        | 下行 `app/.../network/NotificationStreamClient.kt` + `backend/routers/notifications.py`（WS 推送）；上行 `app/.../service/collectors/NotificationCollector.kt` → `/api/screen/stt/perception-event`（notify_store sidecar 零读方已随 P0-U5 裁除） |
| QQ 网关          | `backend/services/qq_gateway/`（单 WS + IPC `127.0.0.1:8770`；入站 relay + `qq` CLI `ai/skills/qq-cli/`；`qq_mcp_server.py` 为 CLI 库）；契约/运维见 `docs/dev/qq-gateway.md` |
| 语音唤醒/指令     | `backend/services/wake_word_service.py`（纯状态机+编排，KWS 检测在内核 `/v1/stream`）+ `backend/services/audio_config.py`；词表 `ai/data/wake_word/keywords.txt`（外层读写、随 encode 请求供内核 tokenizer 用）；内核检测模型按内核解析链（`AXEUH_KERNEL_MODEL_DIR` 等）自解析，`audio.wake_word.model_dir` 仅随编码请求下发 |
| 唤醒词表同步      | `backend/routers/wake_word.py`（`POST /api/screen/wake_word/encode` 仅编码——内核 `kws_encode`；`/keywords` 编码 + 覆盖词表 + 刷新运行时目标词；原"失效模型"外层空操作已随 P0-U3 删除——内核 spotter 进程级缓存，换词后内核侧生效需重启内核） |
| 端侧唤醒（本机 KWS） | `app/.../wakeword/LocalKwsEngine.kt`（sherpa-onnx，经 JNI）；模型与词表 `app/src/main/assets/kws/`（与服务端 `ai/data/wake_word/` 同源） |
| 音频采集/分段/上传 | `app/.../service/collectors/AudioCollector.kt` + `AudioSegmentPolicy.kt`（纯策略）；checkpoint `app/.../service/uploader/PcmCheckpointWriter.kt` / `CheckpointRecovery.kt`；上传格式双档（WAV/FLAC）编码 `app/.../service/uploader/FlacFinalizer.kt`（MediaCodec 首选 + java-flac-encoder 兜底），格式键 `audio_upload_format` 经 `DataCollectorService.getUploadFormat` 每段现读 |
| 上传音频无缝流/流式隔离 | `backend/services/audio_ingest_session.py` + `audio_ingest_registry.py` + `segment_channel.py`（按 `device_id` 维护虚拟连续流，时间连续即同一条流；逐帧静音切分委托内核 WS segment 模式，外层保留时间轴/水位/去重/holdback，通道故障整块冲刷降级——无缝流/直播流共享 `kernel_segment_session.py` 镜像降级基类）+ `routers/perception.py` 的 `_ingest_continuity`；隔离 `perception_store.save_audio(origin=...)` / `audio_analysis_pipeline.analyze_audio_file(origin=...)` |
| TTS 设备路由      | `backend/services/device_channel_store.py` + `backend/routers/tts.py`；设备标识 `frontend/mobile/src/composables/useDeviceId.ts` / `app/.../util/DeviceId.kt` |
| 顶部页边距调节    | `frontend/mobile/src/composables/useTopInset.ts` + `styles/variables.css`（`--app-top-inset`） |
| PC 采集端下载     | `backend/routers/pc_sensor_download.py` + `frontend/mobile/src/api/downloads.ts`     |
| Windows 桌面端 | `desktop/src/main/`（Electron 主进程/协议/托盘）+ `desktop/src/renderer/`（本地设置页）+ `desktop/pc-sensor/`（采集端源码）+ `desktop/resources/pc-sensor/`（构建期 staged 内置运行时，gitignored，由 `desktop/scripts/stage-pc-sensor-runtime.mjs` 生成） | `desktop/AGENTS.md` |
| 私有→公开导出     | `tools/kinship_export/`（`cli.py export/verify`）+ `README.md`                     |
| MOSS 深潜管线/门读数 | `tools/moss-shadow/`（watcher.py/merge.py/metrics.py/backfill_report.py/alerts.py）；watcher 由后端编排器托管为 `moss_watcher` 子进程（`moss.enabled=true` 时 spawn，旧 systemd `axeuh-moss-watch` 单元停用），vLLM serve 仍由独立 `axeuh-moss` 单元常驻；+ 现行方案与 P4 历史规格在私有侧维护（本仓不含 `moss-formalization-plan` / `moss-p4-formalization-spec`；七步完成、待两日回归+七天观察） |
| 人耳基线/素材工作台 | 可选的本机工具，**本仓不含** `tools/audio-console/`（旧记录：:8790，标注 `state/annotations.jsonl`）；音频理解研究总纲在私有侧 `docs/archive/research/research-audio-understanding-2026-10-12.md`（不随公开树导出） |
| 启动服务          | 生产：systemd `axeuh-health.service`（后端编排器托管内核与 MOSS watcher；`ai_backend=loom` 时还托管 Loom，独立 `axeuh-loom.service` 默认停用、仅回滚用；`ai_backend=dsh` 时 dsh 由独立的 `axeuh-dsh.service` 提供，不归后端编排器）。开发：`python launcher.py`，或 `cd backend && python -m uvicorn main:app --reload --port 8768`（单端口；本地开发先把 `ssl.enabled` 设为 false） |
