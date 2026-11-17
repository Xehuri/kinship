# Services - 业务服务层

**更新时间**: 2026-11-17（核对 79 个顶层 .py + 5 个子包；补登记 dsh 通道 6 件、orchestrator/ p2p/ 两个新子包、onboarding 系列 6 件、内核资产/模型清单 5 件、发行与客户端资产 4 件、配置热应用/授权 2 件、数据源健康与就绪门控 3 件、音频分析 pipeline/queue 2 件、Loom 运行时 4 件、MOSS 2 件）
**文件数**: 79 个顶层 Python 文件（`ls backend/services/*.py | grep -v __init__ | wc -l` 实数，不含 `__init__.py`；含 `__init__.py` 为 80）+ 5 个子包：`health/`(5 py)、`orchestrator/`(7 py)、`p2p/`(11 py)、`qq_gateway/`(17 py)、`scripts/`(1 py)。`storage/` 已随 P0-U6 死件裁剪删除
**模式**: 全局单例 + 工厂函数
**边界**: **零音频算法实现、零 ML import**（Wave C1-C5 物理删除 17 个算法文件 + 本地切分器；一切音频计算经三条内核通道 `kernel_client.py` / `kernel_job_client.py` / `segment_channel.py` 调用闭源内核 `kernel/`；内核不可达=降级不回退）

## 概述

业务逻辑层，包含核心服务、AI 多通道客户端（opencode/loom/dsh，由 `ai_backend` 单一真源择路）、定时任务系统、感知读写分层、健康存储。声纹外层注册库镜像已随 V10 整文件退役（唯一事实源在内核）。所有服务使用单例模式管理。

## 服务分类

### 核心服务

| 服务 | 文件 | 职责 |
|------|------|------|
| ComponentManager | `component_manager.py` | WebSocket 连接管理 + 状态广播 |
| HealthCloudService | `health_cloud_service.py` | 小米健康云扫码/状态/回填/开关编排 |
| RemindersStore | `reminders_store.py` | 提醒板持久化与读写 |
| LoomHealth | `loom_health.py` | Loom `/health` 探针与版本 |
| Phi4Client | `phi4_client.py` | Phi-4 实验推理客户端（懒启动 + pidfile） |
| QQGateway | `qq_gateway/` | QQ 单 WS 网关（NapCat）+ SQLite inbox/outbox/read-state/water-state + IPC `:8770` |
| QQMCPServer | `qq_mcp_server.py` | `qq` CLI 实现库（MCP 已退役），经 IPC 调 QQ 网关 |
| EventLoopManager | `event_loop_manager.py` | 主事件循环引用管理 |
| TTSPlayer | `tts_player.py` | TTS 语音播放 |
| AudioCompressor | `audio_compressor.py` | 音频压缩归档：每日凌晨把超过 keep_days 天的 WAV/FLAC 合并为 M4A 并删原件。定时语义 V13 起归 `TaskScheduler` 内建回调任务 `builtin_audio_compressor_daily`（00:05，main.py lifespan 注册），本类不再自带后台扫描循环/start/stop；V18 起扫描桶扩为 **daily+stream 双桶**（`daily/{date}/audio` 上传支与 `stream/{date}/audio` 流式支，终结 stream/ 单向堆积；两支共用同一段扫描/合并/校验实现，无复制逻辑）；删除前 `_safe_purge_audio_dir` 断言归档清单外无残留防丢；`audio_compressor.enabled` 控制开关；归档后悬空指针改写 `rewrite_archived_pointers` 现为**纯函数、未接写链**（启用决策留用户） |

### 音频子系统 (2026-09-14, V2/V3/V12/V15 收敛)

| 服务 | 文件 | 职责 |
|------|------|------|
| AudioConfig | `audio_config.py` | 音频/`tts` 统一配置加载（`DEFAULT_AUDIO_CONFIG` + `_deep_merge` + 进程级缓存 + 锁；返回 `store/stream/vad/voiceprint/wake_word/assistant/tts` 及兼容别名 `audio`，另有 `get_upload_ext()` 取嗅探回退扩展名），另有 `get_project_root()` / `resolve_path()`。注：vad/wake_word 节多数键是传给内核的评分/判停参数或显示回显——推理/检测本体在内核 |
| AudioCodec | `audio_codec.py` | **V2/V3 新增**：ffmpeg 原语唯一实现——`ffmpeg_path()`（收编 preview/voiceprint_audit/speakers/audio_compressor 四份拷贝：非 win32 走 PATH，win32 优先 `backend/bin/ffmpeg.exe` 回退 PATH）、`crop_mp3()`（两份合一，临时目录与前缀由调用方传入）、`pcm_to_wav()`（V3 四合一：stream 手搓头/ingest wave 模块/wake 转调/encode WAV 分支；死导出 `build_wav_bytes` 已删） |
| AudioIngestSession | `audio_ingest_session.py` | 单设备「上传分段无缝流」会话（`DeviceIngestSession`）：按 `device_id` 维护一条虚拟连续流（时间连续判定 `B.start_ms <= A.end_ms + audio.stream.stitch.tolerance_ms` 即追加，不在文件边界切分）、**逐帧静音切分委托内核 WS segment 通道**（`segment_channel.py`，首帧 push 才建连；通道故障该流降级逐段独立产出+镜像缓冲兜底+冷却 120s，**绝不回退本地切分**——本地 segmenter 已删）、切出段整段交分析链路、去重与过晚分段安全丢弃；V12 起镜像/降级/收割/消费原子件继承 `KernelSegmentSessionBase`，去重连续性编排留子类；格式无关核心——`sniff_audio_fmt`（RIFF+WAVE/fLaC 魔数嗅探）、`decode_audio_pcm`（WAV 走 wave / FLAC 走 soundfile，统一解到交错 s16le，`decode_wav_pcm` 保留为别名）、`encode_audio_bytes`（chunk 按 fmt 封装，flac 失败降级 wav——soundfile IO 编码，非算法，留外层；WAV 封装转调 `audio_codec.pcm_to_wav`）；`EmittedChunk.fmt` 承载上传格式 |
| AudioStreamSession | `audio_stream_session.py` | WS 直播流单连接会话：`audio_start` 建连推 PCM、force_cut 60s 口径；V12 起与 ingest 共享 `KernelSegmentSessionBase` 原子件，背压节流编排与进程级 60s 限频降级告警留子类 |
| AudioIngestRegistry | `audio_ingest_registry.py` | `{device_id: DeviceIngestSession}` 注册表 + 后台空闲冲刷（sweep，周期 5s）守护线程；`get_audio_ingest_registry()` 单例（V17 起仅 lifespan 显式创建并接线 sweep sink，路由 import 无副作用；`peek_audio_ingest_registry()` 只查不建），参数取 `audio.stream.stitch_enabled` / `holdback_s` / `min_flush_speech_ratio` 与 `audio.stream.stitch.*` |
| KernelSegmentSessionBase | `kernel_segment_session.py` | **V12 新增**：两条生产链「镜像缓冲/降级/收割/消费」共享基类（mirror/degrade/harvest/consume 家族单实现）。并发裁定：**基类不持锁不建锁**，原语一律"外持锁"（lock-free），由子类公开入口的既有 RLock 包裹；编排差异（stream 背压 vs ingest 去重/水位/连续性）、产出类型差异、降级告警策略全部留子类钩子；另导出 `build_segment_channel` 工厂 |
| SegmentChannel | `segment_channel.py` | **C5 新增**：设备级内核 `WS /v1/stream mode:"segment"` 长连接通道（模块级共享事件循环线程 + 同步 push/stop/poll 接口）。PCM 推入→内核逐帧 RMS 切分→收 `segment.closed {artifact,start_ms,end_ms,seq}`→`GET /v1/artifacts/{id}` 取回 WAV 解码 PCM→**即取即删**（artifact 消费即删是外层义务；删除走契约面 `DELETE /v1/artifacts/{id}`——P3-K2a/V15 根除跨进程 unlink 野生 rm，幂等 200 仅记 WARNING，401/403/503 真异常上抛）。`session.start.segment` 参数映射与两路 max_chunk 口径（ingest 120s vs WS 直播 force_cut 60s）见 `../AGENTS.md`「stitch 配置 ↔ 内核 segment 参数映射」表。失败 fail-fast 上抛，由调用方降级（镜像缓冲兜底，绝不丢音频字节；未 stop 即断连的内核缓冲一律丢弃——故外层必须自带镜像） |
| WakeWordService | `wake_word_service.py` | 唤醒词 + 语音指令采集的**纯状态机+编排**（每连接 `WakeWordState` `detect→verify→record` 状态机/worker 线程，`feed()` 非阻塞）；B1 起**不持有本地 KWS 模型**——命中只来自内核 `wakeup.hit` 帧桥（`audio_stream_ws.py`）或端侧 `local_hit=true`；进门验证/滑窗评分经内核 score 垫片，尾静音判停经内核 `inspect.vad_curve`，ASR/弱切分走内核 `analyze.asr`；支持云端测试模式（`test=true` 只回推 `kws_test_result`）、多唤醒词运行时列表（`invalidate_spotter()` 空函数已随 P0-U4 删除）；`audio.wake_word.*` 默认关闭 |
| DeviceChannelStore | `device_channel_store.py` | TTS 回传通道内存存储（`user_id -> {device_id: client_type + expires_at}`，滑动 TTL 3600s，最新发送者取得所有权），含 `device_channel_store` 单例与 `get_tts_config()` |

#### 无缝流 stitch 配置 ↔ 内核 segment 参数映射（C5 定稿）

内核 `session.start.segment` 白名单六键，由两条路径的会话层分别组装：

| 外层配置键 | 默认 | → 内核 segment 键 | 路径 |
|---|---|---|---|
| `audio.stream.stitch.silence_cut_s` | 1.5 | `silence_cut_s` | ingest（上传无缝流） |
| `audio.stream.stitch.min_chunk_s` | 10.0 | `min_chunk_s` | ingest |
| `audio.stream.stitch.max_chunk_s` | 120.0 | `max_chunk_s` | ingest 硬上限 |
| `audio.stream.rms_threshold` | 5.0 | `rms_threshold` | 两路共用 |
| `audio.stream.frame_ms` | 30 | `frame_ms` | 两路共用 |
| `audio.stream.force_cut_s` | 60.0 | `max_chunk_s` | WS 直播路径硬上限（**≠ ingest 的 120**） |
| 流首段绝对 epoch ms | — | `t0_ms` | 两路时间轴锚（通道恒显式传入） |

> **两路 max_chunk 口径不同**：上传无缝流取 `stitch.max_chunk_s`（120s），WS 直播流由 `audio_stream_session` 把 `force_cut_s`（60s）作为 `max_chunk_s` 传给内核——同一内核键、不同外层来源，调参勿混。

### AI 通道（OpenCode / Loom / dsh 三通道）

| 服务 | 文件 | 职责 |
|------|------|------|
| AIClientFactory | `ai_client_factory.py` | AI 后端统一入口工厂：调用点只依赖 `acquire_ai_client`/`get_ai_client`，通道由 config.yaml 顶层 `ai_backend` 键选择（生产=dsh；代码/模板缺省=opencode。W53 起 `ai_backend` 是 hot 策略：PUT 配置即热应用——客户端单例重置、dsh 事件 hub 按需重建，无需重启后端；opencode.enabled=false 仅关 launcher 启动与 SSE hub，不切换 ai_backend、不阻断客户端构造；opencode 链路保留但非现网、非回退开关）；三通道客户端 duck-type 同构，信封契约真源 = `opencode_client.py` 公共层 |
| WebBackendSelector | `web_backend_selector.py` | Web 对话管线择路（W30 立项，W53 收敛为**无第二真源**）：`get_web_backend` 恒等于 `get_ai_backend()`（顶层 `ai_backend`，每次现读配置快照，非法值 fail-fast）；旧的独立状态文件 `web_backend.json` 已退役，`deprecate_legacy_state()` 在启动时把它改名归档为 `.deprecated-<时间戳>` 留证；`acquire_web_client`/`get_web_client` 按该唯一值路由 opencode/loom/dsh 原语（后台链路仍直接经 `ai_client_factory`）；`web_agent_key` = 绑定命名空间键形制单源（`"<backend>:<agent>"`）；W53 起不再提供写入面（切换统一走 `/api/system/config`，写操作受 `require_config_write` 密码校验约束） |
| OpenCodeClient | `opencode_client.py` | OpenCode API 客户端（V6 起含信封公共层，原 OpenCodeGateway 已退役拍扁；裸传输改 `_raw_*`，mock/默认模型注入下沉同名方法） |
| LoomClient | `loom_client.py` + `loom_messages.py` | Loom harness 通道客户端与**页级**消息形状转换（与 opencode 信封逐键同构）：toolResult 按 `toolCallId` 并回同页 assistant toolCall part，同页无宿主的孤儿原位保留独立壳（规则见下节） |
| LoomSessionLog | `loom_session_log.py` | **W56 新增**：Loom 主会话追加日志 `<AI_ROOT>/.loom/session/loom-main.jsonl` 的只读离线读取层（chatlog 的 loom 腿，不要求 Loom 进程在线）。反向分块扫描 + 时间窗过滤（早于 start_ms 即停），user 字符串 / assistant block 列表归一为（正文, 工具名），thinking 与 toolResult 跳过，坏行逐行容错；只读当前文件，不扫 `.bak-*` 轮转备份 |
| LoomMainSession | `loom_main_session.py` | **T5 新增**：Loom 主会话唯一解析入口。真源=`GET /sessions/main`：200 以返回 sessionID 覆盖本地 `loom:main-task` 绑定（陈旧绑定自愈）、404 表示无主会话；后端 web 会话端点不得再经 `GET /sessions` 列表或自建随机会话取 Loom 会话 |
| LoomRuntime | `loom_runtime.py` | **T6 新增**：跨平台运行时管理——模式探测矩阵 `systemd`（有 systemctl + `axeuh-loom` 单元）> `child`（有 node + `loom-harness/packages/server/dist/cli.js`）> `none`；token/配置供给与子进程生命周期。发行版 dist 被 gitignore 且不在发布清单，缺件时如实返回 `none` |
| LoomSetup | `loom_setup.py` | 一次性托管初始化（向导专用），严格顺序：校验端口/供应商 → 供应商探活（`/models`）→ 持久化 `loom.url` → 补齐 AI 实例与 Loom token → 生成 `ai/.loom/config.yaml` → 重启/启动 Loom → health+catalog 验证 → 持久化 `ai_backend=loom` 与 `loom.token_file` |
| LoomOnboarding | `loom_onboarding.py` | Loom 引导服务（T8）：token 自动发现顺序固定 `config.yaml loom.token` > env `LOOM_TOKEN` > `loom.token_file`（读 `LOOM_TOKEN=` 行）> `loom.credentials_file`；对外只返回 `found/source/fingerprint`，永不回传 token 明文 |
| DshClient | `dsh_client.py` | 后端到 dsh `kinship-bridge` 插件的 HTTP 客户端，公开接口面与 `LoomClient`/`OpenCodeClient` 同构（同名方法/同签名/同 `{"ok","data","error"}` 信封），由 `ai_client_factory` 按 `ai_backend` 择路；**只与 bridge 暴露的唯一绑定会话通信** |
| DshMessages | `dsh_messages.py` | 纯函数：bridge `GET /v1/session/messages` 的扁平行 / `/v1/session/children` 的子会话行 → 后端消费形状，无 IO |
| DshEventBridge | `dsh_event_bridge.py` | 纯状态机（无 IO）：把 bridge `GET /v1/session/events` 的两类帧（durable Session 事件 + live 助手流）转译成前端 SSE 词表 |
| DshHealth | `dsh_health.py` | `/health` 的 dsh 就绪缓存，与 `loom_health.py` 同构（模块级缓存 + 后台探针 + 公开读取器）；探针调 `DshClient.health_check()`（bridge `GET /v1/health`，异常也返回 offline 信封不外抛） |
| DshPaths | `dsh_paths.py` | 把 Kinship 数据路径推给 dsh 计划调度器（bridge `POST /v1/kinship/paths`）：plan master/overlay 路径由后端在生命周期点主动推送一次（`reason` 仅作诊断标签 boot/data_paths/ai_surface/health），bridge 缓存后供排班器定位数据根 |
| DshToolAuth | `dsh_tool_auth.py` | 把后端内部地址 + 长期 service token 推给 dsh bridge（工具回调凭据，`POST /v1/kinship/tool-auth`）；bridge 只放内存不落盘，GET 只回脱敏状态 |

#### Loom 历史消息转换（`loom_messages.py`，W43/W50 修正）

- **页级转换**：loom history 每次按 `limit` 取一页（移动端 `GET /session/{id}/messages` 默认 `limit=50`，`before` 为翻页游标；loom 单页硬上限 200，超发静默夹取），`to_opencode_messages()` 只在本页内按 `toolCallId` 合并，跨页不回溯。
- **孤儿 toolResult**：本页找不到对应 toolCall（典型是分页截断早期 call）时，**原位保留独立 toolResult 壳**（`info.role="toolResult"`、part `type:"tool"`），绝不合成到最后一条 assistant 上，消息序与原始时间线位置不变；计数打 `logger.debug`，字段 `orphan_shell`。
- **不编造输出**：无匹配 toolResult 的 toolCall 留 `output=""`、`status:"completed"`；`_content_to_text` 只拼接 text 块，**ImageContent 跳过**。

### 定时任务系统

| 服务 | 文件 | 职责 |
|------|------|------|
| TaskScheduler | `task_scheduler.py` | 定时任务调度器（每2秒轮询）；V13 起 `register_builtin()` 内建回调任务通道（稳定 id/防误删/YAML 重载后重注入/与 YAML 任务共用 next_run 与执行记录）——unknown 清理 `builtin_unknown_speaker_cleanup` 与 `builtin_audio_compressor_daily` 两散装循环已收编为 daily 内建任务，main.py 调度语义 `create_task=0` |
| TaskStorage | `task_storage.py` | 任务仓储 + YAML 解析/热加载 |
| TaskExecutor | `task_executor.py` | 定时任务执行器 |
| TaskModels | `task_models.py` | 任务数据模型 |
| TaskConfig | `task_config.py` | 任务配置 |
| ScheduleParser | `schedule_parser.py` | 解析统一 schedule 字段(daily/weekly/延迟)，计算下次执行时间 |

### 自定义脚本系统

| 服务 | 文件 | 职责 |
|------|------|------|
| ScriptRunner | `script_runner.py` | 脚本进程管理器(启动/监控/心跳/自动重启) + 热加载(FileWatcher) + stdout桥接(JSON 行消息分发，AI 调用经 `ai_client_factory` 多通道，V6 起取代原 gateway 注入)；日志根/审计根=config.TASK_LOGS_DIR（V14 收编原相对硬编码）；常驻脚本语义保留不并入调度器（V13 裁定）；`trigger_task` 默认全局限 1 次/分钟，脚本可在 frontmatter 用 `trigger_rate_per_min` 覆盖（QQ 私聊中继=20） |
| ScriptSandbox | `script_sandbox.py` | AST 安全审查 + 子进程沙箱(Job Object 256MB) |
| Context | `scripts/context.py` | 脚本与调度器间 stdout JSON 行管道通信接口 |

### 数据存储

| 服务 | 文件 | 职责 |
|------|------|------|
| PerceptionStore | `perception_store.py` | 感知数据按日**写侧**（`append_perception`，单写 `perception.jsonl`）；stream 根=config.STREAM_DIR（V14 收编，默认 DATA_DIR/stream 等价原派生）；读侧归 PerceptionReader |
| PerceptionReader | `perception_reader.py` | **V11 新增**：`perception.jsonl` 唯一读取层——`read_day()`/`iter_days()` 单实现，容错=六读方语义并集（只放宽不收紧：缺文件返回空/空行跳过/坏行逐行跳过/IO 中断返回已收集部分）；消费方 preview / voiceprint_audit / mobile / audio_compressor / `scripts/rebuild_cohort_from_perception.py` 已收编（golden 逐字节对拍锁定） |
| ~~NotifyStore~~ | （已删） | 通知 sidecar 双写零读取（get_notifications 生产无调用方），随 P0-U5 裁除；上行脱敏后单写 `perception.jsonl` |
| HealthStorage | `health_storage.py` | 手环传感器+睡眠按日存储 |
| Health 分片存储包 | `health/` | 多源健康分片存储（H 系列）：`store.py` 按 `(user_id, date)` 分片读-改-写（RLock 串行 + 临时文件 `os.replace` 原子写）；**V9：派生兼容视图（legacy `health.json`）写链双写已退役**——`export_legacy` 函数保留但生产写路径不再调用（仅迁移工具/历史读；新日期不再产生该文件，回落读仅命中 H2~V8 存量历史日），另有懒引导守卫（分片全缺时一次性从 legacy 种子导入）；`paths.py` 路径约定、`devices.py` 设备注册表（文件路径=config.HEALTH_DEVICES_PATH，V14 收编）、`models.py` 数据模型；`sources/{base,phone_push,cloud_pull}` 数据源（phone_push 手机上行 / cloud_pull 云端拉取）——**V7 分组双胞胎合一**：分组/睡眠归一单实现落 `PhonePushSource.normalize`，`save_health_data` 薄委派；原 `registry` 死抽象（get_source/capabilities）已删，文件仅存 `cloud_pull` 消费的 `CLOUD_FETCH_KEYS` 取数顺序常量；**V8 云直写**：拉取任务子进程经 `get_health_store()` 直写 cloud 分片（并发裁定：cloud 分片唯一自动化写者 + 派生视图全量重合成幂等；`batch_to_sync_payload` 降级环已退役） |
| ~~SessionHistorySaver~~ | （已删） | 唯一生产触发点早已注释断链，随 P0-U2 裁除 |

### 声纹（V10：外层注册库镜像整文件退役，注册表唯一事实源=内核）

`voiceprint_service.py`（Wave C2 曾瘦身 1735→337 行的纯注册库镜像）已随 **P2-V10 整文件退役**（2026-10-08）：`sync_from_kernel()` 与 `registry_path` 删除、外层探针函数并入 `kernel_client`（消灭透传壳）、routers `speakers.py`/`voiceprint_audit.py` 直连内核 `/v1/voiceprint/*` 与 `/v1/voiceprint/registry` 快照派生、main.py 启动计数删除（守 B5 import 纯度）；退役文件移存 /tmp 不销毁。打分/注册/识别/验证/CohortManager/质量门/质心重建**全部在内核** `/v1/voiceprint/*`（模型 eres2netv2(kernel)），外层不再持有任何 shadow 注册表。

> 参数化 (2026-09-14)：VAD 阈值、声纹滑窗（现 **1500/750**，替换旧 1000/750）、cohort、注册质量门、音频流切分与队列等参数均已由 `audio.*` 配置驱动（加载器 `audio_config.py`），模块内保留的常量仅是缺省回退。注：其中 VAD/打分/采集/注册门的**执行**现已全在内核；滑窗与分档参数由外层分析链组装评分请求时使用（`kernel_client.score_all_v2` 垫片透传 `sliding`/`collect`）。

#### Cohort（冒名者队列，**已整体内核化**）

- **用途**: AS-Norm 自适应归一化的"非用户"负样本池，消除环境噪声对相似度的影响
- **现状（Wave C1-C4/A2/A6 后）**: 采集/管理全在内核——分析链段级评分请求带 `collect=True`+`collect_meta`，**内核内**三门+去重+日限采集并写内核 state-dir `voiceprint/cohort_active.jsonl` + `cohort_audit.jsonl`（真相源）；外层 `backend/cohort_*.jsonl` 为迁移前遗留冻结文件
- **采集门（内核内置，与历史外层同款）**: 段内 max_sim < COLLECT_SIM_MAX(0.25) 才采 / 时长≥2s / RMS≥0.008(能量门) / 去重(cos距离>0.01) / 每日每源≤5条
- **自动更新闭环**: 内核侧 buffer 满100刷盘进 audit → 每5次刷盘 compaction → 重选500工作集（A6 cohort 管理四端点 `POST /v1/voiceprint/cohort/{reload,compact}`、`GET .../{stats,audit}`）
- **管理API**: `POST /api/admin/cohort/compact|reload`、`GET /api/admin/cohort/stats`（`routers/admin.py` 转内核同路径端点，A6）
- **重建脚本**: `scripts/rebuild_cohort_from_perception.py`（从每日 perception.jsonl 已标注语音段切 wav，逐段经 `services.kernel_client` 送内核评分补采，**不再 import voiceprint_service / 不再本地加载模型**）

### 陌生人识别（UnknownSpeaker，四层架构 → **全链已内核化**）

外层 L1-L4 实现（`pyannote_segmenter.py` + `unknown_speaker_{pipeline,session,session_feed,matcher,profile,health,storage,cleaner}.py` 共 9 件）已随 Wave C1 **物理删除**。现状：

| 位置 | 职责 |
|------|------|
| 内核 `/v1/unknown/track`（A4） | L1 pyannote-3.1 切块 → L2 会话累积滚动质心 → L3 攒会话开档 → 块级身份归类（confirmed unknown > registered > mixed > env，阈值内置=生产值）一次产出 `facts.blocks`；状态落内核 state-dir `unknown/` 四件套 |
| 外层 `audio_analysis_pipeline` | 门控 `unknown_speaker.enabled` → 经 `kernel_job_client.unknown_track(file_key, audio_path=analysis_path)` 文件级一次喂送（失败=unknown 字段留空，**绝不本地建档**）；`_apply_track_blocks` 只做时间对齐映射，不做二次判定 |
| 外层 `main.py` | 每日 `cleanup_hour` 定时调内核 `POST /v1/unknown/cleanup`（TTL/上限清理+簇间融合体检+空闲轨道封存；调度归外层，内核无定时器；lifecycle 节经 `config_override` 透传） |
| 外层 `unknown_speaker_config.py` | 纯配置加载（cleanup 调度 + 预览台读 two_step 窗参数用），仍保留 |
| 内核 `/v1/unknown/{sessions,profiles,tracks,status,audit,profiles/confirm}` | 建档查询/确认六端点（vaudit 切内核为后续遗留事项） |

**四层链路（现全在内核）**: L1 pyannote 切块 → L2 会话层(滚动质心, 单块不建档) → L3 攒会话开档 → L4 注册线多锚点。旧两步切分单块直配链路已随外层删除而不存在。

### 内核对接 (2026-09-23)

| 服务 | 文件 | 职责 |
|------|------|------|
| KernelClient | `kernel_client.py` | 外层内核客户端（K2）：spawn（`python -m axeuh_kernel --port 0`，token 只经环境变量不进 argv）+ 握手（stdout 单行 JSON 取 `{port,pid,api_version}`）+ pidfile 复用（`{state_dir}/kernel.pid`；state_dir 缺省=config.KERNEL_STATE_DIR，env AXEUH_KERNEL_STATE_DIR 优先，V14 收编，pid 存活且 `/v1/health` 探通即复用、绝不二次 spawn）+ Bearer HTTP 请求面；断连抛 `KernelUnavailable`，路由层映射 HTTP 503 `state.unavailable` 降级，内核业务错误经 `KernelHttpError` 原样透传 |
| KernelJobClient | `kernel_job_client.py` | 内核作业客户端（K3f，纯标准库 urllib）：`POST /v1/jobs` 提交（带 `Idempotency-Key` 防重复计算）+ `GET /v1/jobs/{id}?wait=` 长轮询取终态；独立于 `kernel_client`，只做纯 HTTP 作业面（interrupted 重提交助手/作业列表查询/协作取消三个死件随 P0-U6 裁剪移除，零生产调用方）；失败恢复语义=**调用方 requeue 延迟重投**（B2 起绝不回退本地全家桶） |

### 音频分析链（B2 起外层零算法）

| 服务 | 文件 | 职责 |
|------|------|------|
| AudioAnalysisPipeline | `audio_analysis_pipeline.py` | 音频分析流水线（**同步函数，绝不 spawn 线程**）：由 `routers/perception.py` 原内联 `_run`（约 600 行）抽出，供单 worker 队列同步调用；算法唯一路径=内核（主链四 kind `vad/asr/scene/diarize` + `unknown.track`），含 `_ensure_wav` 分析旁路与 `_purge_analysis_bypass` 收尾删除 |
| AudioAnalysisQueue | `audio_analysis_queue.py` | 单 worker + 延迟重试堆的模块级单例队列（`maxsize=32`，队满拒收）：既串行内核推理，也串行锁外 CPU 重活（soundfile 读取、评分、归档写盘）；B2 起支持内核不可达的 requeue 重投 |

### 编排器（`orchestrator/`，2026-11 起唯一子服务编排面）

| 服务 | 文件 | 职责 |
|------|------|------|
| ServiceSpec 注册表 | `orchestrator/spec.py` | `ServiceSpec` 数据模型 + `REGISTRY` + `register()`；`critical=True` 的服务参与业务就绪门控与 finish 审计 |
| Orchestrator | `orchestrator/runtime.py` | gate 判定 + start/stop/pause/resume + `snapshot()`；`AXEUH_ORCHESTRATOR=off` 时整体停用（`/api/services` 也随之禁用） |
| KernelSpec | `orchestrator/kernel_spec.py` | 内核进程 spec（spawn / 存活探活 / stop） |
| MossWatcherSpec | `orchestrator/moss_spec.py` | MOSS watcher 子进程 spec：只 spawn `watcher.py --loop --data-root <DATA_DIR>`，**绝不启停 `axeuh-moss.service`**；stop 按精确 PID SIGTERM → 30s → SIGKILL |
| LoomSpec | `orchestrator/loom_spec.py` | Loom spec（`ai_backend=loom` 时托管） |
| child_entry | `orchestrator/child_entry.py` | 子进程包装：父进程死亡保护，避免孤儿 |

### 引导与就绪（v4 onboarding）

| 服务 | 文件 | 职责 |
|------|------|------|
| OnboardingService | `onboarding_service.py` | 引导状态持久化（真源 `backend/data/onboarding_state.json`，env `AXEUH_ONBOARDING_STATE` 可覆盖）+ 只读环境预检 + 引导动作；写入走 mkstemp + fsync + chmod 0600 + `os.replace` 原子序列 |
| OnboardingFinish | `onboarding_finish.py` | v4 收口：预检端口/路径 → 一次性应用配置草稿 → 按编排器快照审计 `critical=True` 服务（须 ready 或用户显式接受）；不再负责 attempt/validate/promote |
| OnboardingJobs | `onboarding_jobs.py` | 引导下载作业：内存注册表 + 全局单活 + 进度/取消；不持久化，对外文本经 `core.redaction.redact_text` 二次脱敏 |
| OnboardingSecrets | `onboarding_secrets.py` | 引导期密钥文件原子写入：目录 0700 / 文件 0600，同目录临时文件 fsync 后 `os.replace`，失败清理临时文件 |
| OnboardingQQ / OnboardingXiaomi | `onboarding_qq.py` / `onboarding_xiaomi.py` | QQ 与小米的引导步骤实现：只落配置与密钥文件（token 写独立文件、绝不写回 `config.yaml`），不启停网关、不发网络探测；响应只含字段名与可读消息 |
| StartupValidation | `startup_validation.py` | 校验态服务面（Wave 2 T11）：只启安全 in-process 子集，把实时服务与条件集成汇总成一份稳定报告；所有探测只读 |
| StorageLayout | `storage_layout.py` | 只读存储布局解析：`data.root`/`models.dir` 根、剩余空间、可写性、Windows 系统盘位置与遗留缓存检测；**不创建任何目录** |
| BootstrapRuntime | `bootstrap_runtime.py` | 延迟服务面的可重试生命周期状态机（`deferred→attempted→validated→promoted→committed`），`active` 即引导门禁标志 |

### 内核资产与模型清单

| 服务 | 文件 | 职责 |
|------|------|------|
| KernelAssets | `kernel_assets.py` | 内核资产只读巡检与发行包安装：`inspect` **绝不 import/调用 KernelClient**（不 ensure、不 spawn），只读配置/pidfile；安装遵守 C1 守卫（源码检出或有发行标记冲突时拒绝覆盖） |
| KernelBootstrap | `kernel_bootstrap.py` | 内核本地构建与内核 venv 依赖安装（引导第 4 步）：`build_dist.py --protection pyc` + 断言产物 + venv 装依赖；不下载 kernel tar.gz |
| KernelModelManifest | `kernel_model_manifest.py` | 内核模型清单加载/校验/目标路径解析/本地落地状态；真源 `backend/resources/kernel-models.json`（只描述元数据，不做下载） |
| KernelModelAssets | `kernel_model_assets.py` | 模型资产只读状态 + 受控下载：按清单 `source` 分派（`bundled` 永不下载 / `modelscope` 快照下载 / HuggingFace 物化 cache） |
| KernelModelPaths | `kernel_model_paths.py` | 模型根目录与缓存环境变量解析（下载器与内核 spawn 共用），布局对齐"伪 HOME"（`.cache/{modelscope,huggingface,axeuh-kernel,torch}`） |

### 发行与客户端资产

| 服务 | 文件 | 职责 |
|------|------|------|
| ReleaseAssets | `release_assets.py` | 发行资产：清单校验 + 流式下载 + 安全解包 + 前端 dist 自愈。信任锚=HTTPS + 清单 SHA-256；日志固定 `[OnboardingAssets]` / `[FrontendAssets]` 前缀，令牌不落日志 |
| ClientsCatalog | `clients_catalog.py` | 客户端下载目录：Android APK 与 Windows 桌面端的本地/发行资产元数据；解析优先级 `local -> configured URL -> release manifest -> GitHub 发行页`，每级 fail-open |
| ClientArtifacts | `client_artifacts.py` | 客户端产物文件元数据：APK 与桌面安装包的发现、哈希与版本解析 |
| ClientReleaseManifest | `client_release_manifest.py` | 客户端发行清单缓存与 GitHub 发行页地址：正缓存 600s / 负缓存 60s、单次 3s 超时不重试、任何异常退化为 `(None, error_code)` |

### 配置热应用与授权

| 服务 | 文件 | 职责 |
|------|------|------|
| ConfigReconciler | `config_reconciler.py` | N11 配置热应用器：把 ConfigStore 变更分发到各运行中子系统。注册顺序即依赖顺序（AI → 音频/归档 → 数据路径 → 外部集成 → 内核 → 监听/TLS）；单个 applier 异常由 `ConfigStore.apply` 如实记入 failed、绝不静默吞；applier 全部懒加载、幂等；`ai_surface` 是 AI 派生面 applier（同步 dsh hub / 工具授权 / 路径推送） |
| ConfigAuthz | `config_authz.py` | 配置写入授权：常规模式要求密码二次校验，引导模式强制引导令牌（由 `require_config_read` / `require_config_write` 消费） |

### P2P 设备通道（`p2p/`）

| 模块 | 职责 |
|------|------|
| `p2p/manager.py` | P2P 管理器（`routers/p2p.py` 的唯一运行时入口）；`p2p.enabled=false` 时整组端点 404 |
| `p2p/signaling.py` / `protocol.py` / `webrtc.py` | 短时信令票据、协议帧与 WebRTC 面（Phase 1）；日志**不得**输出配对码、设备 token、信令票据或 SDP/ICE 载荷 |
| `p2p/config.py` / `devices.py` / `records.py` / `store.py` / `tokens.py` / `errors.py` | 配置、设备注册、记录、持久化、票据与错误类型 |

### 数据源健康与就绪门控

| 服务 | 文件 | 职责 |
|------|------|------|
| SourceHealth | `source_health.py` | `GET /api/sources/health` 的实现层：每个采集器返回 `{id,name,status,last_sync,records,detail}`，状态只依据本地可验证事实（分片文件、服务状态机、进程内连接表）；无法确定返回 `unknown`，**绝不编造 records/last_sync** |
| SourceHealthPC | `source_health_pc.py` | PC 感知上报健康：从每日 `perception.jsonl` 读 `pc_sensor` 事件（独立成模块只为控单文件体积，对外入口由 `source_health` 包装） |
| SchedulerGating | `scheduler_gating.py` | 业务就绪门控：由 `Orchestrator.on_state_change` 回调驱动调度器暂停/恢复派发；只认 `critical=True` 服务，不轮询不 sleep；`AXEUH_ORCHESTRATOR=off` 时放行 |

### MOSS 只读门面

| 服务 | 文件 | 职责 |
|------|------|------|
| MossClient | `moss_client.py` | 引导只读校验门面：只读 `GET {base}/v1/models`，**不发送任何凭证、不接受 URL 内嵌用户名/密码**；默认面向回环（非回环只给告警）；不启停任何服务、不写配置与引导状态 |
| MossProbe | `moss_probe.py` | MOSS 探测原语：URL 归一化、模型列表解析与共享常量 |

### Windows 专项

| 服务 | 文件 | 职责 |
|------|------|------|
| WinProcess | `win_process.py` | Windows 进程按 PID 查询与终止（仅 Windows 语义，POSIX 上不导入）；只被 `kernel_client` 的 Windows 分支惰性导入；Win32 入口都是模块级可注入 seam，Linux 单测注入假 DLL 即可覆盖 |
| FFmpegBootstrap | `ffmpeg_bootstrap.py` | 把 imageio-ffmpeg wheel 自带的 ffmpeg 按需落地到本地 bin 目录（首次复制一次后命中缓存）；`AXEUH_FFMPEG_BIN_DIR` 改写落地目录；缺 wheel 抛 `FFmpegMissing`（消息以 `ffmpeg_missing` 开头） |

## 依赖关系

```
TaskScheduler (YAML定时任务 + V13 内建回调通道)
├── TaskExecutor (执行器)
├── TaskStorage (持久化+热加载)
├── ScheduleParser (schedule 解析)
└── AIClientFactory (执行任务时调用)

ScriptRunner (Python脚本任务; 常驻语义保留不并调度器)
├── ScriptSandbox (AST安全审查)
├── Context (stdout JSON 管道)
├── FileWatcher (scripts/热加载)
└── StdoutBridge (JSON 消息分发; AI 调用经 AIClientFactory)

ComponentManager (连接管理)
└── WebSocket 广播

AIClientFactory (AI 后端统一入口; config `ai_backend` 选通道)
├── LoomClient / LoomMessages / LoomMainSession / LoomSessionLog (loom harness 通道; 历史页级转换 + 孤儿 toolResult 原位壳)
├── OpenCodeClient (opencode 通道; 信封公共层=契约真源; SSE 事件流)
└── DshClient / DshMessages / DshEventBridge / DshHealth / DshPaths / DshToolAuth (dsh bridge 通道; 唯一绑定会话)

Orchestrator (spec 注册表: kernel -> moss_watcher -> loom; gate/start/stop/pause/resume + snapshot)
├── KernelSpec / MossWatcherSpec / LoomSpec (各子服务生命周期)
└── SchedulerGating (critical 服务就绪 -> 调度器派发闸门)

PerceptionStore (感知写) / PerceptionReader (感知唯一读层, V11)
HealthStorage (手机上行薄委派) / health/ 分片存储 (V7 分组单实现, V8 云直写, V9 legacy 停写)
WakeWordService (唤醒词状态机 + 语音指令采集; KWS 检测在内核)
DeviceChannelStore (TTS 设备路由回传通道)
AudioAnalysisQueue (单 worker + 延迟重试堆) -> AudioAnalysisPipeline (同步, 零算法)
KernelClient / KernelJobClient / SegmentChannel (三条内核通道; 分析链 audio_analysis_pipeline/queue 与无缝流 ingest/stream 会话、唤醒、评分、陌生人 track 全部经此三者触内核; 两侧会话镜像/降级/收割/消费共享 KernelSegmentSessionBase 基类)
ConfigReconciler (配置热应用, 注册顺序即依赖顺序; `ai_surface` = AI 派生面) / ConfigAuthz (写授权)
```

## 单例模式

```python
# 懒加载单例
_storage_instance = None
def get_storage() -> StorageManager:
    global _storage_instance
    if _storage_instance is None:
        _storage_instance = StorageManager()
    return _storage_instance

# 直接导出实例
component_manager = ComponentManager()
```

## 已移除的服务

以下服务已从原 Axeuh Home System 中移除：
- `voice_assistant_service.py` + `voice_assistant_models.py` + 路由 `voice_assistant_ws.py` — 语音助手整链（OQ2 裁定删除，2026-09-23 K2）
- `voiceprint_service.py` — 声纹注册库镜像，P2-V10 整文件退役（2026-10-08：注册表唯一事实源=内核，`sync_from_kernel`/`registry_path` 删除，探针函数并入 `kernel_client`；退役文件移存 /tmp 不销毁，非销毁式处置）
- `vad_asr_service.py` — VAD + ASR 语音识别
- `stt_service.py` — STT 服务
- `unified_stt.py` — 统一 STT 接口
- `aliyun_asr_service.py` — 阿里云 ASR
- `custom_wakeword.py` — 唤醒词检测（旧 Axeuh Home System 的实现；本系统的唤醒词能力见 `wake_word_service.py`）
- `sensevoice_service.py` — SenseVoice 识别
- `stock_api.py` — 股票 API
- `sse_forwarder.py` — SSE 事件转发（SSE 逻辑现位于 `routers/events.py`）

以下音频算法实现已随**内核分离工程 Wave C1-C5 物理删除**（功能迁入闭源内核 `kernel/`，外层经三条通道调用）：
- 根目录（backend/）：`audio_processor.py`（ASR/SER/AED/ESC）、`vad_processor.py`（pyannote/Silero VAD）、`sound_scene.py`（PANNs 环境声）、`sigh_detector.py`（叹气检测）、`speaker_diarization.py`（MFCC 聚类日志）
- `services/`：`multimodal_audio_manager.py`（多模态音频模型管理）、`pyannote_segmenter.py`（L1 切块）、`unknown_speaker_{pipeline,session,session_feed,matcher,profile,health,storage,cleaner}.py`（陌生人四层八件）、`audio_stream_segmenter.py`（无缝流本地切分器，C5 由 `segment_channel.py` 委托内核取代）

## 兼容保留的服务

以下服务在重构中被标记为"已移除"，因仍有代码引用，继续保留：
- `stt_session_manager.py` — STT 会话管理（被 opencode_client/loom_client、task_executor/task_storage、script_runner、session 引用；W30-B3 起 `_load_data` 一次性幂等迁移：裸 `main-task` 绑定存在且 `opencode:main-task` 缺失时**复制**到命名键——裸键原样保留供语音/任务站使用、已有命名键永不覆盖、加载阶段零落盘；get/set 签名与调用点不变）
- `terminal_service.py` — 终端管理（被 component_manager、ws_main 引用）

## 相关文档

- `../AGENTS.md` - Backend 总览
- `../routers/AGENTS.md` - 路由层文档
