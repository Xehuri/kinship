# Services - 业务服务层

**更新时间**: 2026-10-25（QQ 操作迁移到 ai/skills/qq-cli；新增 health_cloud_service.py / reminders_store.py / loom_health.py / phi4_client.py / qq_mcp_server.py 与 qq_gateway/ 包；W30 新增 web_backend_selector.py + stt_session_manager 绑定迁移；此前 P0 死件裁剪 + P1/P2/P3 波次收敛 V2~V19，详见 `../../docs/archive/audit/2026-10-08/`）
**文件数**: 42 个顶层 Python 文件（`ls backend/services/*.py | wc -l` 实数，含 `__init__.py`；另有 `health/`、`scripts/`、`qq_gateway/` 子目录，`storage/` 已随 P0-U6 死件裁剪删除）
**模式**: 全局单例 + 工厂函数
**边界**: **零音频算法实现、零 ML import**（Wave C1-C5 物理删除 17 个算法文件 + 本地切分器；一切音频计算经三条内核通道 `kernel_client.py` / `kernel_job_client.py` / `segment_channel.py` 调用闭源内核 `kernel/`；内核不可达=降级不回退）

## 概述

业务逻辑层，包含核心服务、AI 双通道客户端（opencode/loom）、定时任务系统、感知读写分层、健康存储。声纹外层注册库镜像已随 V10 整文件退役（唯一事实源在内核）。所有服务使用单例模式管理。

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

### AI 通道（OpenCode / Loom 双通道）

| 服务 | 文件 | 职责 |
|------|------|------|
| AIClientFactory | `ai_client_factory.py` | AI 后端统一入口工厂：调用点只依赖 `acquire_ai_client`/`get_ai_client`，通道由 config.yaml 顶层 `ai_backend` 键选择（生产=loom；代码/模板缺省=opencode。切流=手改配置并重启后端，无运行时热切换路径；opencode.enabled=false 仅关 launcher 启动与 SSE hub，不切换 ai_backend、不阻断客户端构造；opencode 链路保留但非现网、非回退开关）；两通道客户端 duck-type 同构，信封契约真源 = `opencode_client.py` 公共层 |
| WebBackendSelector | `web_backend_selector.py` | Web 通道热切换（W30）：`get_web_backend` 每次现读状态文件 `config.WEB_BACKEND_STATE_PATH`（web_backend.json，缺失/损坏回落全局 `get_ai_backend`，绝不让 web 崩溃）；`set_web_backend` 校验 `_VALID_BACKENDS` + tmp/`os.replace` 原子写；`acquire_web_client`/`get_web_client` 按状态值路由 loom/opencode 原语（后台链路不经此模块）；`web_agent_key` = 绑定命名空间键形制单源（`"<backend>:<agent>"`）；生产固定 loom；opencode 分支保留但不作 Web 助手回退（本部署 5096 已退役；4097 是独立自有会话实例） |
| OpenCodeClient | `opencode_client.py` | OpenCode API 客户端（V6 起含信封公共层，原 OpenCodeGateway 已退役拍扁；裸传输改 `_raw_*`，mock/默认模型注入下沉同名方法） |
| LoomClient | `loom_client.py` + `loom_messages.py` | Loom harness 通道客户端与**页级**消息形状转换（与 opencode 信封逐键同构）：toolResult 按 `toolCallId` 并回同页 assistant toolCall part，同页无宿主的孤儿原位保留独立壳（规则见下节） |

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
| ScriptRunner | `script_runner.py` | 脚本进程管理器(启动/监控/心跳/自动重启) + 热加载(FileWatcher) + stdout桥接(JSON 行消息分发，AI 调用经 `ai_client_factory` 双通道，V6 起取代原 gateway 注入)；日志根/审计根=config.TASK_LOGS_DIR（V14 收编原相对硬编码）；常驻脚本语义保留不并入调度器（V13 裁定） |
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
├── LoomClient / LoomMessages (loom harness 通道; 历史页级转换 + 孤儿 toolResult 原位壳)
└── OpenCodeClient (opencode 通道; 信封公共层=契约真源; SSE 事件流)

PerceptionStore (感知写) / PerceptionReader (感知唯一读层, V11)
HealthStorage (手机上行薄委派) / health/ 分片存储 (V7 分组单实现, V8 云直写, V9 legacy 停写)
WakeWordService (唤醒词状态机 + 语音指令采集; KWS 检测在内核)
DeviceChannelStore (TTS 设备路由回传通道)
KernelClient / KernelJobClient / SegmentChannel (三条内核通道; 分析链 audio_analysis_pipeline/queue 与无缝流 ingest/stream 会话、唤醒、评分、陌生人 track 全部经此三者触内核; 两侧会话镜像/降级/收割/消费共享 KernelSegmentSessionBase 基类)
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
