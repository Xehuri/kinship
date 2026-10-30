# Backend - FastAPI 后端

**更新时间**: 2026-10-22
**框架**: FastAPI + Uvicorn
**Python**: >=3.10

## 概述

FastAPI 后端服务，提供健康数据接收、定时任务调度（含调度器内建回调任务）、自定义脚本任务、TTS 语音合成、手机通知推送（上下行）、OTA 更新、AI 会话管理等功能（远程 Agent 管理随 P0-U1 整层裁除；声纹注册库外层镜像随 P2-V10 退役，元数据读内核 registry 快照）。

**运行时零 ML、零音频算法实现**（Wave C1-C5 物理删除，`rg "import torch|funasr|modelscope|pyannote|silero_vad|sherpa_onnx|sklearn"` 实测 0 命中；冷 import 仅剩 numpy/soundfile/librosa 纯 IO/信号级库）。全部音频计算由独立闭源内核进程（`kernel/`，FastAPI+uvicorn，外层 spawn，HTTP+WS 同端口 `127.0.0.1:{动态端口}`，pull-first）承载，外层只保留三条通道：

- `services/kernel_client.py`：同步通道（speakers/cohort/preview 评分、`kws_encode`、unknown cleanup 等；V10 镜像退役后声纹观测经探针 `vp_speaker_count()`/`vp_cohort_stats()`，内核不可达降级 0）
- `services/kernel_job_client.py`：作业通道（`analyze.vad/asr/scene/diarize` 主链四 kind + `analyze.aed/breath` 残留两件 + `unknown.track`，提交+长轮询（P0-U6 起 resubmit_interrupted/cancel_job/list_jobs 死件已删；重启恢复语义由外层 requeue 队列承担）。**2026-10-07：`analyze.emotion` 从后端整体移除**——emotion2vec 在 funasr 1.3.22 下 decoder 权重 miss 输出恒空、perception 零消费（取证见 commit e194366e 与 memory `project_emotion2vec_broken_unused`）；内核 handlers 保留不动，段 confidence 改由 PANNs Speech 二次校准直接接管。同窗 `kernel.device` 生产值=gpu→**cpu**（为 vLLM 双卡腾显存，实测 CPU 热路径 1~4s 异步无感；段内 SenseVoice 活键 `emotion` 透传保留，仅 kind 级 emotion 作业停用））
- `services/segment_channel.py`：WS `mode:"segment"` 切分通道（无缝流/直播流的逐帧静音切分，C5 起；镜像降级逻辑与直播流共享 `kernel_segment_session.py` 基类）；artifact 取回 `GET /v1/artifacts/{id}` 后**经契约面 HTTP `DELETE /v1/artifacts/{id}` 即删**（V15/K2a，幂等；跨进程直接 unlink 已根除）

**内核不可达 = 降级不回退**（本地模型已删）：唤醒链不唤醒（限频告警）、无缝流该流降级逐段独立产出（镜像缓冲兜底、冷却 120s）、直播流整块冲刷、声纹评分跳过、分析作业 requeue。契约见 `docs/kernel-contract.md`（35 kinds / 10 models）。健康数据为多源架构（H1-H6 完成）：`services/health/` 分片存储、统一写路径、109 天历史迁移、小米云拉取源、多用户设备隔离。

生产环境已关闭交互式 API 文档：`/docs`、`/redoc`、`/openapi.json` 均未注册（返回 404）。

## 目录结构

```
backend/
├── main.py              # 主入口，lifespan + 路由注册 + 静态页(移动端/vaudit/preview)；B5 起启动链零模型预加载；V13 起 compressor/unknown_cleanup 均为 TaskScheduler 内建回调任务（register_builtin，散装循环清零），V17 起音频摄入 sweeper 单例经 lifespan 接线/停止（路由 import 副作用清零）
├── middleware/           # 中间件
│   ├── __init__.py
│   └── auth_middleware.py
├── core/                # errors.py(统一异常处理) + log_setup.py(日志配置)
├── models.py            # Pydantic 数据模型（注意：历史 ML 权重目录 backend/models/ 已随 Wave C3 整体出库删除，权重归内核私有模型目录）
├── auth.py              # Token 认证系统
├── routers/             # API 路由 (25 个 + __init__；agents_remote/tasks/scripts 已随 P0-U1 裁除)
├── services/            # 业务服务 (42 个；含 kernel_client.py / kernel_job_client.py / segment_channel.py 三条内核通道，health/ 多源健康包，单实现层 perception_reader.py / audio_codec.py / kernel_segment_session.py，AI 客户端 opencode_client.py + ai_client_factory.py 双通道工厂；**零算法实现**)
│   ├── scripts/         # context.py (脚本 stdout JSON 管道通信)
│   ├── health/          # 多源健康包: store.py(分片存储；V9 起 export_legacy 派生视图双写退役，函数仅存历史迁移/懒引导种子读) / paths.py / models.py / devices.py / sources/{base,phone_push,cloud_pull}（V7 分组双胞胎合一至 phone_push.normalize；原 registry 死抽象已删，仅存 CLOUD_FETCH_KEYS 取数顺序常量）
│   ├── kernel_client.py # 内核同步通道 (speakers/cohort/preview 评分、kws_encode、vp_speaker_count/vp_cohort_stats 探针，Bearer 调 127.0.0.1:{动态端口}；spawn+握手+pidfile 复用)
│   ├── kernel_job_client.py # 内核作业通道 (analyze.* 六类在用 kind（vad/asr/scene/diarize/aed/breath，emotion 已随 10-07 外层移除）+ unknown.track，提交+长轮询，重启恢复=外层 requeue)
│   └── segment_channel.py   # 内核 WS mode=segment 切分通道（无缝流/直播流逐帧静音切分委托内核，C5；artifact GET 取回后 DELETE /v1/artifacts/{id} 即删，K2a）
├── config/              # 配置模块(config.py + auth.json/notify_filter.json；agents.json 为 P0-U1 后零消费者残留文件；model_config.json 真源在 config.MODEL_CONFIG_PATH 指向的 ai/config/，V5 双缓存合一)
├── scripts/             # 运维/重建脚本（cohort 重建走 kernel_client 评分，无本地模型）
├── tests/               # 测试文件
├── data/                # 运行时数据目录（自动生成；含 kernel_state/ pidfile 与内核状态根缺省位置，V14 起该缺省位置与 health_devices.json/health_source_selection.json 均归 config.py 属性）
├── logs/                # 日志文件（按日轮转，保留30天）
├── outputs/             # 运行时输出(随机 key .npy 等)
├── bin/                 # ffmpeg.exe
├── ai/                  # ai/data 数据目录入口
├── mimo_signing.py      # MiMo 音频签名 URL 工具
├── usersessions.json    # 用户会话数据
└── requirements.txt     # 依赖列表（Wave C4 后零 ML：无 torch/funasr/modelscope/pyannote/silero；numpy/soundfile/librosa 为 IO 级）
```

> 已物理删除（Wave C1-C5，算法全部内核化）：`audio_processor.py` / `vad_processor.py` / `sound_scene.py` / `sigh_detector.py` / `speaker_diarization.py`、`services/multimodal_audio_manager.py` / `pyannote_segmenter.py` / `unknown_speaker_{pipeline,session,session_feed,matcher,profile,health,storage,cleaner}.py`、`audio_stream_segmenter.py`、权重目录 `models/`；`services/voiceprint_service.py`（注册库镜像）随 P2-V10 退役——W1 跨进程直读根除，声纹元数据读改内核探针 `kernel_client.vp_speaker_count/vp_cohort_stats`，vaudit /voices 走契约 `GET /v1/voiceprint/registry` 快照。P0/V6 死码波再删：`opencode_gateway.py` 整层（信封/默认模型注入平迁 `opencode_client`，三级栈压两级）、`notify_store.py`（通知上行单写 perception.jsonl）、`session_history_saver.py`、`services/storage/` 死包、路由整文件 `agents_remote.py`/`tasks.py`/`scripts.py`。`services/unknown_speaker_config.py`（纯配置加载，供 cleanup 调度与预览台读窗参数）仍在。

## 快速定位

| 任务 | 位置 | 说明 |
|------|------|------|
| 添加新 API | `routers/` | 创建新文件，在 main.py 注册 |
| 修改业务逻辑 | `services/` | 单例模式，通过 get_*() 获取 |
| 数据模型 | `models.py` | Pydantic BaseModel |
| 脚本任务 | `services/script_runner.py` | Python 脚本自动执行 + AST 安全审查（管理 UI 路由 scripts.py 已随 P0-U1 裁除，任务启停走 docstring frontmatter 热加载） |
| 认证逻辑 | `auth.py` | Token 生成/验证, 多用户 |
| ~~Agent管理~~ | （已删） | 旧远程 Agent 体系整文件随 P0-U1 裁除，四方零消费者 |
| 通知上下行 | `routers/notifications.py` | 下行经 `component_manager` WS 推送（poll 兜底已随 P0-U4 裁除）；上行脱敏后直接追加 `perception.jsonl`（notify_store sidecar 零读方，已随 P0-U5 裁除） |
| 声纹探针/镜像退役 | `services/kernel_client.py` | P2-V10：外层注册库镜像（`voiceprint_service.py` + `sync_from_kernel`）已退役，打分/注册/识别/CohortManager 全在内核（`/v1/voiceprint/*`）；管线计数/日志经 `vp_speaker_count()` / `vp_cohort_stats()`（内核不可达降级 0）；vaudit /voices 读契约 `GET /v1/voiceprint/registry` 元数据快照（向量 §5 红线永不外带，centroids 展示块按 name 派生） |
| 声纹四层/陌生人 | 内核 `/v1/unknown/*`（A4 全链闭环） | 外层 L1-L4 实现（pyannote_segmenter/unknown_speaker_* 八件）已删（Wave C1）；分析链经 `kernel_job_client.unknown_track` 一次喂送读结论；每日清理=定时调内核 `/v1/unknown/cleanup`（B5 起内核执行，V13 起定时收编为调度器内建任务 builtin_unknown_speaker_cleanup；`unknown_speaker_config.py` 仍在）；vaudit current 面板暂直读冻结旧库（遗留，见 C1 偏离注记） |
| 语音唤醒/指令 | `services/wake_word_service.py` + `services/audio_config.py` | 唤醒词状态机+语音指令采集（`audio.wake_word.*`，默认关闭）的**编排层**；KWS 检测在内核 `/v1/stream`（B1，`wakeup.hit` 帧桥回状态机；不可达=降级不唤醒），尾静音判停走内核 `/v1/inspect/vad_curve`；支持端侧命中（`local_hit`）两条路径 |
| 内核端点/kernel_client | `services/kernel_client.py` + `services/kernel_job_client.py` + `services/segment_channel.py` | 同步通道：speakers/cohort/preview 评分、`kws_encode`（routers/wake_word.py 的 encode/keywords）、unknown cleanup、声纹探针 `vp_speaker_count`/`vp_cohort_stats`（V10）；作业通道：六类在用 `analyze.*` job + `unknown.track`（恢复语义唯一=外层 requeue，`cancel_job`/`resubmit_interrupted`/`list_jobs` 死方法已随 P0-U6 删）；WS segment 切分通道（无缝流/直播流，镜像降级共享 `kernel_segment_session.py` 基类）；契约见 `docs/kernel-contract.md`（2026-10-08 additive：`GET /v1/voiceprint/registry` 元数据快照 K1a、`DELETE /v1/artifacts/{id}` 消费即删 K2a） |
| 感知唯一 reader | `services/perception_reader.py` | perception.jsonl 解析六套散落收编单实现：`read_day(date, types=...)` / `iter_days(start, end)` / `day_dirs` / `perception_path`；新消费方一律经此，不再手写逐日 jsonl 解析 |
| 音频编解码原语 | `services/audio_codec.py` | `pcm_to_wav`（×4→1）/ `ffmpeg_path`（×4→1，含 `bin/` 定位）/ `crop_mp3`（×2→1，vaudit/preview 试听裁剪共用）单实现 |
| 健康多源 | `services/health/` | H1-H6 完成：分片存储（store）/ 统一写路径 / 109 天历史迁移 / 小米云拉取（sources/cloud_pull）/ 多用户设备隔离（devices）。P1-V7 分组双胞胎合一（phone_push.normalize 单实现，health_storage 拷贝删除）；P2-V9 起派生 `daily/{date}/health.json` 每次写强制双落已停（export_legacy 仅存历史迁移/懒引导种子读）；P2-V8 云任务 `ai/data/tasks/xiaomi_cloud_health.py` 直写 store 不再 POST `/sync`；`/api/health` 现仅剩 `/sync` + `/query`（source/dates/upload-db 死端点已随 P0-U3 裁除） |
| 唤醒词表同步 | `routers/wake_word.py` | `/api/screen/wake_word/encode`（仅编码不落盘）+ `/keywords`（编码 + 覆盖词表 + 刷新运行时目标词；原"失效模型"空操作函数 `invalidate_spotter` 已随 P0-U3 删除，换词后内核检测侧生效需重启内核） |
| TTS 设备路由 | `services/device_channel_store.py` + `routers/tts.py` | 记录"最近发消息的设备"，TTS 定向回传（滑动 TTL，回退 `tts.fallback_client_types`） |
| 上传音频无缝流 | `services/audio_ingest_session.py` + `audio_ingest_registry.py` + `segment_channel.py` + `routers/perception.py` | 按 `device_id` 把时间连续的上传分段当作一条虚拟连续流；逐帧静音切分**委托内核 WS `mode:"segment"` 通道**（C5），外层保留时间轴/水位/去重/holdback，通道故障该流降级逐段独立产出（降级基类 `kernel_segment_session.py` 与直播流共享，V17 起注册表 sweeper 经 lifespan 接线）（`audio.stream.stitch.*`，详见文末章节）；上传格式双档（WAV/FLAC）经 magic 嗅探统一解码 PCM 入流，chunk 按上传格式封装落盘（FLAC 重编码用 soundfile，属 IO 非算法，留外层） |
| 定时任务 | `services/task_scheduler.py` | 自动调度 + 热加载；`register_builtin()` 内建回调任务（V13：builtin_audio_compressor_daily 每日 00:05 双桶 daily+stream、builtin_unknown_speaker_cleanup 每日 cleanup_hour），时间判定唯一走 ScheduleParser/next_run；ScriptRunner 常驻脚本语义独立保留 |
| AI 双通道会话 | `services/ai_client_factory.py` + `services/loom_messages.py` | 通道随 config `ai_backend` 选 loom/opencode；移动端历史 `GET /session/{id}/messages` 默认 50 条、`before` 上翻，loom 页级转换的孤儿 toolResult 原位保留独立壳，规则见 `services/AGENTS.md`「Loom 历史消息转换」 |

## 启动方式

```bash
# 开发 (HTTP 8769)
cd backend && python -m uvicorn main:app --port 8769 --reload

# 生产 (HTTPS 8768)
python -m uvicorn main:app --port 8768 \
  --ssl-certfile /path/to/cert.pem --ssl-keyfile /path/to/key.pem

# 使用 launcher.py
cd .. && python launcher.py
```

## 认证中间件

- 多用户支持，token 携带 user_id
- AuthMiddleware 注入 request.state.user_id
- Phase 2 已移除 localhost 绕过：所有请求均需 Token（`auth_middleware.py` L90）
- 公开路径（PUBLIC_PATHS，精确匹配，共 15 条）: `/`, `/favicon.ico`, `/health`, `/login`, `/auth/setup-status`, `/auth/setup`, `/mobile`, `/mobile/`, `/vaudit`, `/vaudit/`, `/preview`, `/preview/`, `/docs`, `/openapi.json`, `/redoc`
- auth 路由现仅 `/login`、`/auth/setup-status`、`/auth/setup`、`/auth/change-credentials`、`/auth/ws-ticket`（`/logout`、`/auth/check`、`/auth/revoke` 死端点已随 P0-U3 裁除，改密吊销自动生效）
- 静态资源豁免：`/mobile/`、`/vaudit/`、`/preview/`、`/static` 下匹配扩展名(js/css/html/字体等)的请求
- query 凭证(`?token=`/`?ticket=`)仅白名单前缀接受（SSE、音频流、文件下载等无法带 header 的场景；含 `/api/pc-sensor/download`，浏览器 `<a download>` 场景）
- MiMo 音频端点 `/api/mimo/audio/` 按路径放行，由端点内 HMAC 短 TTL 签名校验

## 配置模块

| 文件 | 位置 | 说明 |
|------|------|------|
| `config.yaml` | 项目根目录 | 生产配置（gitignored，含密钥） |
| `config.example.yaml` | 项目根目录 | 模板配置（含占位符，纳入 git） |
| `auth.json` | `backend/config/` | 运行时凭据真源（`agents.json` 为 P0-U1 后零消费者残留；`model_config.json` 真源已收敛到 `config.MODEL_CONFIG_PATH`，默认 `ai/config/`，V5 双缓存合一） |
| `notify_filter.json` | `backend/config/` | 通知上行敏感应用黑名单（`blocked_packages`，默认空列表） |
| `config.py` | `backend/config/` | 61 个 `@property`，`@lru_cache` 单例；V14 收编野生路径属性（`KERNEL_STATE_DIR`/`TASK_LOGS_DIR`/`STREAM_DIR`/`HEALTH_DEVICES_PATH`/`HEALTH_SOURCE_SELECTION_PATH`，逐处新旧值相等断言、物理数据零迁移）+ V5 `MODEL_CONFIG_PATH`（model_config router 写/client 读单一真源，双缓存合一） |

加载顺序：`CONFIG_PATH` 环境变量（launcher.py `--config` 设置）→ `backend/config/config.yaml`（存在时）→ 项目根 `config.yaml`。不支持 `config.local.yaml`。

新增配置项需在 `config.py` 添加 `@property`，在对应 `config.yaml` 添加键。

### 音频子系统配置 (2026-09-14)

- 顶层 `audio:` 节：`store`（`upload_ext` 嗅探未知回退）/ `stream`（切分参数传给内核 segment 通道 + 队列，含上传无缝流子块 `stream.stitch`）/ `vad`（仅唤醒链判停读 threshold/window_s/step_s/bucket_ms，VAD 推理在内核）/ `voiceprint`（滑窗/分档/分段供外层组装评分请求与产出标注，打分与 cohort 采集在内核）/ `wake_word`（KWS 阈值/录音状态机；KWS 检测在内核，内核内置同款常量）/ `assistant`（历史服务，默认关）；由 `services/audio_config.py` 统一加载（内置 `DEFAULT_AUDIO_CONFIG` + `_deep_merge` + 进程级缓存 + 锁），返回 `store/stream/vad/voiceprint/wake_word/assistant/tts` 及兼容别名 `audio`。
- 顶层 `tts:` 节：`enabled` / `device_channel_ttl_seconds` / `fallback_client_types`，由 `services/device_channel_store.py` 的 `get_tts_config()` 读取。
- 音频链路参数（VAD 阈值、声纹滑窗/cohort/注册门、音频流切分与队列）**已全量配置化**，不再是散落的硬编码常量。
- 声纹滑窗由 1000/750 统一为 **1500/750**（与 `audio.voiceprint.sliding` 对齐，含此前两处泄漏的 `1000.0` 硬编码）。
- `config.py` 中 `VOICEPRINT_MIN_*` 五个 property（`MIN_SNR`/`MIN_SEG_SNR`/`MIN_CONSISTENCY`/`MIN_SPEECH_RATIO`/`MIN_DURATION`）随 Wave C2 注册质量门内核化（内核 `ENROLL_MIN_*` 内置常量）而失去全部消费者，沦为死访问器——顶层 `voiceprint:` 节不再被外层读取。
- `audio:` / `tts:` 值在部分模块 import 时快照、`get_audio_config()` 按进程缓存，**修改后需重启后端**（`POST /api/screen/restart`）。

### 环境变量

| 变量 | 作用 |
|------|------|
| `CONFIG_PATH` | 自定义 YAML 配置路径（优先于默认查找） |
| `OPENCODE_SERVER_PASSWORD` / `OPENCODE_SERVER_USERNAME` | OpenCode loopback HTTP Basic 认证（config.yaml `opencode.server_password`/`server_username` 优先；**两者皆空 = 不启用认证，后端不带头、launcher 不注入，老部署 fail-open 照常工作**。启用后 launcher 注入给 `opencode serve`，`opencode_client` 每请求带 `Authorization: Basic`。V6 拍扁后 session 域已全收编 client；残余缺口：`routers/events.py` 全局事件流仍 aiohttp 直连未带认证头，配置密码前需先收编） |
| `KMP_DUPLICATE_LIB_OK` | 解决 OpenMP 库冲突(libomp vs libiomp5md)，main.py 强制置 TRUE |
| `TQDM_DISABLE` | main.py 置 1（历史：关闭 funasr/SenseVoice 进度条；现外层无 funasr，仅对继承该环境变量的内核子进程生效） |
| `VAD_ENGINE` | **已废弃无消费者**（`vad_processor.py` 随 Wave C1 删除；VAD 引擎选择归内核内部，pyannote 主/Silero 回退） |
| `AXEUH_KERNEL_STATE_DIR` / `AXEUH_KERNEL_TOKEN` | 内核状态根覆盖 / 内核 Bearer token（kernel_client spawn 时注入 token；缺省状态根 `backend/data/kernel_state/`=config `KERNEL_STATE_DIR`，V14 收编，env 优先级更高） |
| `AXEUH_KERNEL_DEVICE` | 内核 torch 推理设备 `cpu`(缺省)\|`gpu`\|`auto`（gpu 时 CUDA 不可用自动回退 cpu；KWS 恒 CPU）；由 config `kernel.device` 经 spawn 注入，不配置则内核按 cpu（2026-10-01） |
| `OTA_FILE_DIR` | OTA APK 目录覆盖（默认取 `ota.apk_dir`） |
| `MIMO_API_KEY` | MiMo API Key（config.yaml `api.mimo_key` 优先） |

## 已移除的硬编码

- MiMo API Key: `tts_player.py` 硬编码 → config.yaml api.mimo_key / 环境变量 MIMO_API_KEY
- OTA 独立 Token: `ota.py` 硬编码 → 改为登录 Bearer 认证
- 回退密码: `auth.py` 硬编码 → 强制从 config 读取 password_hash

## 重启后端

```bash
# 后端 HTTPS 端口 8768（生产，config.yaml）/ HTTP 8769（开发）
# 使用最长有效期的 token 调重启（token 从 backend/config/auth.json 读取，找 expires_at 最大的那条）
python -c "
import urllib.request as r, json, ssl
ctx = ssl.create_default_context(); ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE
with open('config/auth.json') as f: auth = json.load(f)
# 找最长有效期的 token
tokens = [(t['expires_at'], tid) for tid, t in auth['tokens'].items()]
token = max(tokens, key=lambda x: x[0])[1]
req = r.Request('https://127.0.0.1:8768/api/screen/restart', method='POST', headers={'Authorization': f'Bearer {token}'})
resp = r.urlopen(req, timeout=5, context=ctx)
print(resp.status, resp.read().decode())
"
```

## 2026-10 新增模块

- `services/qq_gateway/` + `services/qq_mcp_server.py`：QQ 单 WS 网关与 IPC（`127.0.0.1:8770`，默认关闭，生产启用）；qq-mcp 已退役，Loom 侧走 `qq` CLI，`qq_mcp_server.py` 为 CLI 库。
- `routers/health_cloud.py` + `services/health_cloud_service.py`：小米健康云扫码/状态/回填/开关。
- `routers/reminders.py` + `services/reminders_store.py`：提醒板。
- `services/loom_health.py`：Loom `/health` 探针。
- `services/phi4_client.py`：Phi-4 实验件（`routers/phi4_api.py` 使用）。
- `kernel.cpu_affinity` / `kernel.nice` / `audio_compressor.nice`：内核与 ffmpeg 子进程 CPU 亲和/nice（POSIX）。

## 相关文档

- `../AGENTS.md` - 项目根目录文档
- `services/AGENTS.md` - 服务层文档
- `routers/AGENTS.md` - 路由层文档

## 通知上下行 (2026-09-14 更新)

### 下行（后端 → App）

- `POST /api/notification/send`：写入内存队列 + 历史后，额外经 `component_manager.send_to_user` 向在线 `/ws` 客户端实时推送 `{"type":"notification","data":{id,title,content,ts}}`。推送为 best-effort：主事件循环内 `wait_for` 2s 超时，跨线程时经 `event_loop_manager.get_main_loop()` + `run_coroutine_threadsafe` 投递，任何失败都不影响 HTTP 响应。
- ~~`GET /api/notification/poll`~~：离线兜底端点已随 P0-U4 裁除（App 早已改 `/ws` 长连接，四方零消费）。

### 上行（App → 后端）

- App 端 `NotificationCollector` 把本机通知以 `type="notify"` POST 到 `/api/screen/stt/perception-event`。
- `routers/perception.py` 对 `type="notify"` 先 `sanitize_notify_payload` 脱敏，再追加 `perception.jsonl`（供 AI 消费）。原 sidecar 去重双写（`services/notify_store.py`，`DATA_DIR/cache/notify_store.json`）因 `get_notifications` 生产零读取已随 P0-U5 裁除——同一事件不再写两份。黑名单脱敏规则（`config/notify_filter.json` 的 `blocked_packages`）仍在 sanitize 内生效。

## 声纹审计平台 (2026-09-05 新增)

**访问**: `https://example.com:8768/vaudit/` (免登录看壳, 数据 API 需登录；凭据在本地 `backend/config/auth.json`，勿写入文档)
**用途**: 声纹系统审计/调试/测试的可视化平台, 弥补"状态不可见、压缩丢上下文"痛点

### 结构
- 后端: `routers/voiceprint_audit.py` (prefix /api/vaudit, 只读+裁剪, 不含embedding大数组)
- 前端: `frontend/vaudit/` (纯静态 HTML+CSS+JS 3文件, 无构建, agent可直接改, 刷新生效)
  - 改完前端注意 index.html 里 `<script src="...?v=xxx">` 版本号 +1 强制浏览器换缓存
- 静态托管: main.py `serve_vaudit`, `/vaudit` 无斜杠 307 到 `/vaudit/`
- 认证: 静态页扩展名豁免; API 要 Bearer; 音频端点浏览器靠 `?token=` query(中间件已支持)

### 端到端 QA
启动后端后按 `/api/vaudit/days` → `/api/vaudit/day/{date}` 顺序手测（免登录壳 + Bearer 数据 API）；QA 脚本不入库。

### 主要端点速查
| 端点 | 用途 |
|---|---|
| GET /api/vaudit/days | 日期列表(voice段统计) |
| GET /api/vaudit/day/{date} | 某天voice段(segs合并文本, 自动裁剪URL) |
| GET /api/vaudit/day/{date}/audio/{file} | 原始wav流(Range) |
| GET /api/vaudit/audio/crop?date&file&start&end | ffmpeg裁剪mp3(通用) |
| GET /api/vaudit/cohort?source=active\|audit | cohort列表(无embedding, 附统计) |
| GET /api/vaudit/unknown?source=all\|legacy\|current | 簇审计(current新链路5档 + legacy旧链路512档) |
| GET /api/vaudit/unknown/{id}/sample/{idx} | 样本试听(按ws_spk窗口自动裁剪为该说话人语音段) |
| GET /api/vaudit/voices | 注册声纹概览（V10：内核 `GET /v1/voiceprint/registry` 元数据快照派生，向量永不外带） |

### 数据裁剪逻辑(重要)
- 每日voice段试听: 有精确segs(非整文件占位) → 自动裁剪[语音范围±0.3s]; 否则整文件
- cohort试听: 按条目 src_start~src_end 裁剪
- unknown样本: 扫 daily perception 的 seg.spk.unk_id / vp.ws_spk 匹配该unk → 合并窗口裁剪
  (current档用ws_spk精确750ms窗口; legacy档用seg.spk.unk_id整段; 41/42 legacy confirmed可命中)

## 语音唤醒与 TTS 设备路由 (2026-09-14 新增，2026-09-25 内核分离后修订)

### 语音唤醒/指令 (`services/wake_word_service.py` —— 纯状态机+编排，零算法)

- **B1 起外层不持有本地 KWS 模型**：每个音频流 WS 连接一个 `WakeWordState` 状态机（`detect → verify → record`）+ 独立 worker 线程；`feed()` 非阻塞，带预滚环形缓冲与有界队列。KWS 检测唯一路径=内核 `WS /v1/stream`（`routers/audio_stream_ws.py` 的 `_KernelStreamBridge` 并行转发 PCM，内核 `wakeup.hit {keyword, confidence}` 帧桥回 `trigger_local_hit` 驱动同一状态机）；**内核不可达=降级不唤醒**（限频 ERROR，App 5s 兜底退出），绝不回退本地解码。
- 进门验证 = 声纹分 + 域切换（`as_norm_on`，评分经内核 score 垫片）；停止条件 = 声纹持续低分（3750ms）/ VAD 尾部静音（3000ms，判停调内核 `POST /v1/inspect/vad_curve`，失败=本轮跳过判停）/ 硬上限（30min）。另受唤醒后最短录音保护约束：自进入录制态（`wake_start` 提示音下发）起算 `min_record_ms`（默认 2500ms）内不做任何停止判定（不含 pre-roll/进门验证音频）。随后弱切分+ASR（内核 `analyze.asr` 作业，`options.weak_split` 透传配置）→ 前缀 → 投递主会话（main-task）。
- 生产唤醒词「小贺同学」（词表 `ai/data/wake_word/keywords.txt` 由外层读写；内核检测模型按内核解析链 `AXEUH_KERNEL_MODEL_DIR`>包内>下载目录自解析，`audio.wake_word.model_dir` 仅随 encode 请求下发）；`keywords_score=1.8` / `keywords_threshold=0.25`（2.5 经全天实测否决；内核 stream/kws 内置同款常量，外层键供编码与回显）。
- 日志：状态变化 INFO（`[WakeWord] 命中唤醒词` / `进门验证通过|未通过` / `录制停止 reason=vad_silence|voiceprint_low|hard_limit` / `语音指令已投递 main-task`），逐窗声纹与 VAD 明细为 DEBUG。

**唤醒提示信号（2026-09-14 追加）**：`routers/audio_stream_ws.py` 复用**同一条** `/ws/audio-stream` 连接向手机回推两条文本帧，驱动手机端提示音（`app/.../util/HintTonePlayer.kt`）：

- `{"type":"wake","stage":"start","keyword":"小贺同学"}` —— **声纹进门验证通过、进入录制态**时下发（不是 KWS 原始命中）
- `{"type":"wake","stage":"end","reason":"vad_silence"}` —— 录制停止时下发，`reason` 与 `_stop_recording` 一致
- 回调由 `wake_word_service.WakeWordState` 注入（`on_event`），在**唤醒工作线程**触发，经 `event_loop_manager.get_main_loop()` + `asyncio.run_coroutine_threadsafe` 调度回主循环发送；循环不可用只告警，不影响音频链路
- 投递主会话时正文首行固定为 `【语音唤醒】必须第一时间使用tts_speak工具中文回复语音消息。` + ASR 文本（统一场景前缀；信封 `<Axeuh-home-system>` 内只含 `current_datetime`）

### 端侧唤醒（local_hit）与云端测试模式 (2026-09-15 新增)

唤醒有**两条检测路径**，汇入同一条下游链路（进门验证 → 录制 → ASR → 投递）：

- **服务端流式 KWS**：检测在内核 `/v1/stream` 跑（外层 `audio_stream_ws` 桥接转发 PCM，`wakeup.hit` 帧回驱状态机）。
- **端侧命中**：App 本机跑 KWS（`app/.../wakeword/LocalKwsEngine.kt`），命中后 `audio_start` 携带 `local_hit: true`（可选 `keyword` 为实际命中词）。`WakeWordState` 进入 `local_hit` 模式后由 `trigger_local_hit()` 登记待处理命中，在检测态消费，直接进入声纹进门验证（B1 起外层本就两条路径都不做服务端 KWS 解码，端侧命中与内核命中共用同一入口）。App 回填约 2 秒预滚（含完整唤醒词）作为进门验证样本——因此 `local_hit` 模式下预滚保留时长取 `max(pre_roll_ms, sliding_window_ms)`；`_push_pre_roll` 对超过缓冲容量的整帧只保留帧尾（否则 App 整帧上行的大预滚会被一次性弹出清空，导致只说唤醒词不触发）。
- **兜底**：App 侧自连接就绪（`CONNECTED`）起 5 秒未收到服务端 `wake/start` 即主动结束本轮推流（建连耗时不计入），避免验证不过时无限推流。

**云端测试模式**：`audio_start` 携带 `test: true` 时，`WakeWordState` 照常跑 detect/verify/record，但**不投递 AI、不落盘**，改为经同一条 WS 回推 `{"type":"kws_test_result", ...}`（含命中词、`vp_scores` 滑窗分数序列、`dur_ms`、`asr_text`、`reason` 与参数快照；验证失败也回推 `reason=verify_fail`）。App 设置页「唤醒词测试」面板展示该结果。

**多唤醒词**：目标词不再硬编码，改为运行时列表（初始值仍 `["小贺同学"]`），只有与当前列表**精确匹配**的命中才触发，`wake_start` 回推实际命中的那个词；词表为空时回退 `["小贺同学"]`。设置页经 `POST /api/screen/wake_word/encode`（内核 `kws_encode`）编码中文为拼音 token，再由 `POST /api/screen/wake_word/keywords` 覆盖词表、刷新运行时目标词（原 B1 起外层**空操作**的"失效已加载模型"函数已随 P0-U3 删除——内核 spotter 进程级缓存，换词后要让内核检测侧吃到新词表需重启内核；不阻塞音频主链路）。

**进门阈值**：`entry_score_cohort_ready` / `entry_score_no_cohort`（别名 `entry_threshold_ready` / `entry_threshold_cold`）。生产 `config.yaml` 于 2026-09-15 调为 `0.7` / `0.45`；注意 `audio_config.py` 的 `DEFAULT_AUDIO_CONFIG` 兜底仍为 `0.75` / `0.5`，仅在 `config.yaml` 未提供该键时生效。

### TTS 设备路由

- `services/device_channel_store.py`：内存映射 `user_id -> {device_id: client_type + expires_at}`，滑动 TTL 3600s，最近发消息的设备取得所有权。
- `routers/tts.py`：优先定向 `send_to_device`；目标离线或未命中（过期/从未发送）→ 广播给 `tts.fallback_client_types`（默认 `["web"]`）；**无任何目标连接时静默丢弃**（用户明确要求）。
- 设备标识来源：WS 握手 `device_id` + `client`（`web`/`native`，默认 `web`）；HTTP 发消息 `X-Device-Id`（+ 可选 `X-Client-Type`）。

## 音频来源溯源与流式隔离 (2026-09-15 新增)

**两条独立链路，不可混谈**：

| 链路 | 入口 | 是否写增量数据 | 产出 |
|------|------|----------------|------|
| 环境音频（分段上传） | `POST /api/screen/stt/voice-session-multipart`（App 采集） | 是（`perception.jsonl` + `daily/{date}/audio/`） | AI 可分析的按日 voice 条目 |
| 语音唤醒（流式） | `WS /ws/audio-stream`（`AudioStreamSession`） | **否**（音频只落 `stream/{date}/audio/`） | ASR 结果作为语音指令投递主会话 |

- **`origin` 溯源透传**：`analyze_audio_file(..., origin="upload"|"stream")` 缺省 `"upload"`（行为不变）。`origin="stream"` 时跳过 `append_perception`；上传路由、分析队列（`AudioAnalysisQueue.submit(..., origin=...)`）、`AudioStreamSession` 均显式透传。
- **落盘隔离**：`services/perception_store.py` 的 `save_audio(..., origin="stream")` 落 `stream/{date}/audio/`（`daily/` 之外）；`target_dir` 显式指定时优先于 `origin` 默认目录。
- **可配置开关**：`audio.stream.persist_perception`（默认 `false`）——置 `true` 时流式音频也写 `perception.jsonl`，仅供调试/回滚；配置在导入时快照，改后需重启。

### 上传分段无缝流（2026-09-15 起；2026-09-25 C5 起切分委托内核）

固定时长切分会把一句话截断在两个文件里，故 multipart 分段上传不再"每段独立分析"，而是按 `device_id` 维护一条**虚拟连续音频流**——上传的 WAV/FLAC 只是"流的一段"。**职责边界（内容归内核/位置与编排归外层）**：逐帧 RMS 静音切分在内核 `WS /v1/stream mode:"segment"` 会话执行（经 `services/segment_channel.py` 通道，首帧 push 才建连）；外层保留时间连续性判定、去重水位、holdback 冲刷、产出块语音占比过滤与镜像缓冲（无缝流/直播流的镜像降级逻辑共享 `services/kernel_segment_session.py` 基类，双实现已合一）。

- `services/audio_ingest_registry.py`：`{device_id: DeviceIngestSession}` 注册表 + 互斥锁 + 后台空闲冲刷（sweep，周期 5s）守护线程；`get_audio_ingest_registry()` 单例（V17 起经 main.py lifespan 接线创建/停止，路由 import 副作用清零），参数取自 `audio.stream.stitch_enabled` / `holdback_s` / `min_flush_speech_ratio` 与 `audio.stream.stitch.*`。
- **时间连续性判定**（`services/audio_ingest_session.py`）：`B.start_ms <= A.end_ms + tolerance_ms`（`audio.stream.stitch.tolerance_ms`，默认 **1000ms**）即视为同一条流并追加，**不在文件边界切分**。App 有 500ms 前滚重叠，故不要求首尾严格相等；容差内的间隙用静音补齐以保持绝对时间轴与样本数对齐。
- **切分委托内核 segment 通道**：PCM 推入通道后由内核逐帧能量判定，在静音端点（`stitch.silence_cut_s`，默认 1.5s）或硬上限（`stitch.max_chunk_s`，默认 120s）处闭合 `segment.closed {artifact, start_ms, end_ms, seq}`，外层经 `GET /v1/artifacts/{id}` 取回段 WAV、解码 PCM、**即取即删=契约面 HTTP `DELETE /v1/artifacts/{id}`**（V15/K2a，鉴权同 GET、幂等；跨进程直接 unlink 已根除；artifact 无 TTL，消费即删是外层义务）。切点可落在**文件中间**。时间轴锚 `t0_ms` 恒显式传入=该流首段绝对 epoch ms。**通道故障绝不回退本地切分**（本地 `audio_stream_segmenter` 已删）：该流降级为逐段独立产出（stitch=false 既有语义），镜像缓冲兜底冲刷不丢音频，冷却 120s 后的新流重试内核。
- **合并发生在音频层**：切出的段（内核 artifact PCM）作为单个输入交给 `services/audio_analysis_pipeline.analyze_audio_file`（其 VAD/ASR 全走内核作业），因此跨文件的一句话不会被 ASR 断句（不是"分别识别后拼文本"）。
- **不连续处理**：超容差（丢文件 / 设备切换 / 时间倒流）→ 先冲刷当前流，再开新流，绝不跨间隙拼接。连续/不连续均记 INFO 日志（含两侧时间戳、间隙与判定结果）。
- **收尾**：`holdback_s`（默认 90s，按**接收空闲**计，避免历史补传被立即冲刷）内无新文件到达则对通道 `stop`（内核冲刷尾段）+ 镜像兜底；会话结束或显式 `flush()` 立即收尾。`min_flush_speech_ratio`（默认 0.05）为产出块的语音占比下限（外层计算），低于此值视为纯静音残片、不产出 voice 条目（仍推进记账，避免空闲冲刷反复处理同一残片）。
- `routers/perception.py`：`_ingest_continuity` 接管标准 16k/单声道/16bit 且带绝对时间的分段；`_dispatch_stitched_chunks` 把产出 chunk 按上传格式（`EmittedChunk.fmt`）封装 WAV/FLAC 落 `daily/{date}/audio/` 并 `origin="upload"` 触发分析（FLAC 档=内核 segment 恒产 WAV、外层用 soundfile 重编码——IO 非算法）。非标准格式/无绝对时间则**回退**既有独立分析路径（不误切分）。去重表 `(device_id, session_id, seq, start_ms)` 覆盖 App 重试与缓存重放，"完全落在已处理水位内"的过晚分段安全丢弃。
- 开关：`audio.stream.stitch_enabled`（默认 `true`）关闭时上传路由直接走既有独立分析路径。
- 时间精度：multipart 端点可选表单字段 `start_wall_ms`（毫秒级起始墙钟，App 从 `upload_cache` 的 cacheJson 原样回传），`_resolve_start` **优先**用它推算时间轴，缺失时才回退解析秒级的 `client_time` / `ts`——避免秒级截断让跨段裁剪多裁真实音频。

**stitch 配置 ↔ 内核 segment 参数映射**（C5 定稿；内核 `session.start.segment` 白名单六键）：

| 外层配置键 | 默认 | → 内核 segment 键 | 路径 |
|---|---|---|---|
| `audio.stream.stitch.silence_cut_s` | 1.5 | `silence_cut_s` | ingest（上传无缝流） |
| `audio.stream.stitch.min_chunk_s` | 10.0 | `min_chunk_s` | ingest |
| `audio.stream.stitch.max_chunk_s` | 120.0 | `max_chunk_s` | ingest 硬上限 |
| `audio.stream.rms_threshold` | 5.0 | `rms_threshold` | 两路共用 |
| `audio.stream.frame_ms` | 30 | `frame_ms` | 两路共用 |
| `audio.stream.force_cut_s` | 60.0 | `max_chunk_s` | WS 直播路径硬上限（**≠ ingest 的 120**） |
| 流首段绝对 epoch ms | — | `t0_ms` | 两路时间轴锚 |

> **两路 max_chunk 口径不同须点明**：上传无缝流用 `stitch.max_chunk_s`（120s），WS 直播流经 `audio_stream_session` 把 `force_cut_s`（60s）作为 `max_chunk_s` 传入内核会话——同为内核 `segment.max_chunk_s` 键但取值口径不同，调参时勿混。

### 上传格式双档 WAV/FLAC（2026-09-23）

App 可选上传 WAV（原始）或 FLAC（无损，约省 46% 流量），后端按上传格式原样保存。数据契约见 `docs/DATA_FORMAT.md` voice 节，此处只记后端实现：

- **magic 嗅探**（`audio_ingest_session.sniff_audio_fmt`）：`RIFF` 且 8-11 位为 `WAVE` 判 wav、偏移 0 `fLaC` 判 flac；**裸 RIFF 也匹配 WebP/AVI 故必须配 `WAVE`**；**不信任 Content-Type / 扩展名**。
- **统一解码 PCM**（`decode_audio_pcm`，`decode_wav_pcm` 保留为别名）：WAV 走 `wave`，FLAC 走 `soundfile`（读 int16 交错字节，**不重采样**——非 16k 由 `_ingest_continuity` 拒接管、回退独立分析）。无缝流水位/去重/切分**全在 PCM 层，格式无关，600 行核心零改**。
- **chunk 按格式封装**（`encode_audio_bytes`）：`_dispatch_stitched_chunks` 用 `chunk.fmt` 封装 WAV/FLAC 落盘（flac 编码失败降级 WAV 不丢数据）；`perception_store.save_audio(..., ext=)` 白名单（非法值回退 wav，防路径注入）；`perception.jsonl` 单 `audio` 指针仍指实际落盘文件（后缀随格式）。
- **分析链旁路**（`audio_analysis_pipeline._ensure_wav`）：非 WAV 转码到 `{stem}.analysis.wav` **旁路**并返回可分析路径，**原文件字节不变**（历史上 `os.replace` 就地覆盖会毁原件，已根治）；`analyze_audio_file` 内核作业（含 `unknown_track` 喂送）/声纹读盘走 `analysis_path`（恒 16k/单声道/16bit，内核 track 严格校验），jsonl 溯源仍指原件。**旁路是瞬态衍生品，不落数据目录**：`analyze_audio_file` 的 `finally` 调 `_purge_analysis_bypass` 删除本次 `.analysis.wav`（靠后缀识别，永不触碰原件；WAV 原件路径不以 `.analysis.wav` 结尾故不删）。`audio_compressor` 三处清单（日期检测/压缩/`_safe_purge_audio_dir` 残留判定）排除 `.analysis.wav` 防重复合并。（原"四层会话喂送 `feed_audio_file` 传原件"路径随 C1 本地四层链删除而消失，陌生人现经 `unknown_track` 直传旁路 WAV。）
- **时长**（`_wav_duration_ms`）：flac 走 `soundfile`（**禁 `len/32` 数学**——压缩流字节数≠时长），wav 保留 `wave` 快解析 + `len/32` 回退。
- **归档防丢**（`audio_compressor`）：日期检测与归档清单收 `.wav`+`.flac`；rmtree 前 `_safe_purge_audio_dir` 断言清单外无残留音频（有残留只删清单内，防竞态新文件/清单遗漏被整树删除）。
- **默认扩展名**：`audio.store.upload_ext`（默认 `wav`）仅用于 magic 嗅探未知时（如旧 JSON base64 路径）的回退；`get_upload_ext()` 非法值归一 `wav`。
- **热生效**：后端 `audio.*` 改后仍需 `POST /api/screen/restart`；App 侧 `audio_upload_format` 每段现读、下一段生效（详见根 `AGENTS.md` 与 `app/AGENTS.md`）。
