# Routers - API 路由层

**更新时间**: 2026-10-22（W44/W45/W46 双通道会话分账：session 双源聚合+backend 显式路由+switch 收编、events 双 hub 并存、backend POST 与 hub 解耦；W30 新增 web_backend.py 路由；后续新增 health_cloud.py / reminders.py；此前 P0 死接口裁剪 + P1/P2/P3 波次收敛 V2~V19，详见 `../../docs/archive/audit/2026-10-08/`）
**文件数**: 25 个路由文件（不含 `__init__.py`；P0 删 3 死路由后 22，后续新增 web_backend.py / health_cloud.py / reminders.py，现 25）
**挂载前缀**: 多数路由只设 tags，真实前缀由 main.py `include_router` 决定；部分文件自带 prefix

## 概述

FastAPI 路由层，按业务领域分文件组织。提供 REST API 和 WebSocket。

## 路由文件列表

`自身前缀` 为 APIRouter 声明的 prefix/tags；`main.py 挂载` 为 include_router 时追加的前缀，二者拼接才是真实路由。

| 文件 | 自身前缀/tags | main.py 挂载 | 职责 |
|------|------|------|------|
| `admin.py` | `/api/admin` | - | cohort 维护(compact/reload/stats，纯内核转发壳，转 `/v1/voiceprint/cohort/*`)；V10 后 import 面 voiceprint_service 清零（cohort 真相源全在内核 state-dir） |
| `audio_stream_ws.py` | tags audio-stream-websocket | - | 音频流 WS `/ws/audio-stream`（接收连续 PCM，非阻塞喂给唤醒词状态机；B1 起并行经内核桥 `WS /v1/stream` 转发 PCM，KWS 命中 `wakeup.hit` 帧桥回状态机，**内核不可达=降级不唤醒**；`audio_start` 支持 `local_hit`（端侧命中，外层不做 KWS 解码）与 `test`（云端测试，回推 `kws_test_result` 不投递 AI）；断开/audio_stop 时清理） |
| `auth_api.py` | tags auth | - | 登录/鉴权/初始化/凭据管理（logout/check/revoke 三死端点已于 P0-U3 裁除；改密自动吊销在 `auth.change_credentials` 内生效） |
| `events.py` | tags events | `/api/screen` | SSE 事件流 → `/api/screen/events/stream`（W44 双通道分账：per-backend 双 hub 并存——`_hubs` 注册表分槽懒建幂等、Web 通道漂移**不停旧 hub**，loom 槽恒用 `services.loom_client` 模块单例；`/events/stream` 一条共享队列同时订阅两 hub **多路复用**双流，None 哨兵只终结本响应流、finally 两 hub 一并退订；每条 data 帧在 properties 注入 `backend="opencode"\|"loom"` 通道标——纯增量字段，properties 缺失不注入不造壳、非 dict 原样照发，老前端可忽略；`_stop_hub` 保留为单 hub 关停原语，`reset_event_hub` 降级为测试/lifespan 专用 teardown-all；遗留缺口：opencode hub 上游 aiohttp 直连不带 `Authorization: Basic`，启用 `OPENCODE_SERVER_PASSWORD` 前须先收编） |
| `health.py` | `/api/health` | - | 健康数据同步/查询（source 切换/dates/upload-db 旁路已于 P0-U3 裁除） |
| `health_cloud.py` | `/api/health/cloud` | - | 小米健康云扫码登录/状态/回填/开关 |
| `reminders.py` | `/api/reminders` | - | 提醒板读写 |
| `maintenance.py` | `/api/screen` | - | 维护管理(重启) → `/api/screen/restart` |
| `mimo.py` | tags mimo | `/api` | MiMo 音频拉取 → `/api/mimo/audio/{filename}` |
| `mobile.py` | tags mobile | `/api/mobile` | 手机端文件浏览/上传/报告 |
| `model_config.py` | `/api/screen` | - | 模型设置 |
| `notifications.py` | tags 通知推送 | `/api` | 通知推送 → `/api/notification/*`（send 写内存历史上限 100 后经 `component_manager` WS 推送，慢客户端 2s 超时放弃；poll 兜底死端点已于 P0-U4 裁除；history 单条删除前端 apiPost 打 DELETE-only 路由必 405 的错配已于 P1-V19 增 apiDelete 改真 DELETE 修复） |
| `ota.py` | `/api/ota` | - | OTA 更新（download/info；check 死端点已于 P0-U4 裁除，App 走本地 update.json） |
| `pc.py` | `/api/pc` | - | PC 感知数据接收 |
| `pc_sensor_download.py` | `/api/pc-sensor` | - | PC 采集端 exe 下载(info/download) |
| `perception.py` | `/api/screen/stt` | - | 感知事件/语音会话上报（multipart 分段经 `_ingest_continuity` 进入按 `device_id` 的无缝流（时间连续即同一条流；静音端点切分委托内核 WS segment 通道，详见 `../../backend/AGENTS.md` 音频章节）；JSON 版 voice-session 死入口与 notify sidecar 双写已于 P0-U5 裁除；V17 起 import 无副作用——不在 import 期建单例，sweep sink 接线显式移入 `main.py` lifespan，关停经 `peek_audio_ingest_registry()` 限时 `stop_sweeper()` 防反向创建） |
| `preview.py` | `/api/preview` | - | 音频处理预览台(只读；硬编码阈值改读配置；读侧收编 `perception_reader`、ffmpeg 定位/裁剪统一 `audio_codec`；每块 vs 注册质心评分经 kernel_client 走内核 `score_all_v2`，内核不可达时降级 sim=null) |
| `phi4_api.py` | `/api/preview`(共用前缀) | - | Phi-4 音频理解测试端点：status(非阻塞探活)/start(异步 spawn 常驻服务)/run(裁 wav→phi4_serve 独立进程推理)；服务经 services/phi4_client.py 懒启动+pidfile 复用(conda phi4mm 隔离环境)，不可达一律 200+ready:false |
| `session.py` | `""`(tags session) | `/api/screen` | 会话管理 → `/api/screen/session/*`（发消息时读 `X-Device-Id` + `X-Client-Type` 刷新设备回传通道；for-agent/current/bind-main-task/abort/stats/agent/active 八条孤儿端点已于 P0-U2 裁除；V6 拍扁三级栈后 handler 经 `ai_client_factory.acquire_ai_client` 直连 opencode_client 信封公共层，原 OpenCodeGateway 已退役；W30 起 web 对话端点（create/message/list/messages/children/summarize/switch）改经 `services/web_backend_selector` 热切换通道，智能体绑定写 `"<backend>:<agent>"` 命名键、opencode 读侧保留裸键别名（语音兼容），chatlog 固定全局 ai_backend + 裸键不随 Web 切换漂移。W44 分账：`/session/list` 双源聚合=远端 opencode ∪ 远端 loom ∪ 仅本地 session_history，归一新键 `sessions`（条目 `{session_id,title,date,updated,backend}`，sid 去重远端元数据优先、updated ms 降序）+ 诊断键 `loom_sessions`（loom 原始腿）/`partial`（失败腿名单；实现为 `[]` 非 null=全量可信；恒 200 永不 500）；旧三键 `local_sessions/opencode_sessions/current_session` 名形冻结，`opencode_sessions` 从此恒 opencode 原始腿（修正 W30 混装）；`local_sessions` 空回退死键修复（opencode 真时间=`time.created/time.updated` ms，顶层 `created_at` 不存在，仅留旧桩回落）。message body 与 messages/children query 增可选 `backend` 显式路由：None/""透传=当次 Web 热切换通道（逐字节老语义），非法值 400 零副作用，显式腿直调 `acquire_opencode_client_direct`/`acquire_loom_client_direct` 通道原语、绝不经全局工厂与通道缝。messages 端点：`GET /session/{id}/messages` 默认 `limit=50`、支持 `before` 游标上翻；`?backend=loom` 路由到 `loom_client.get_session_messages`（内部 `loom_messages` 页级转换、上游游标恒透传，仅译后空页置 None）；孤儿 toolResult 原位壳规则见 `../services/AGENTS.md`。W46 switch 收编：`POST /session/switch` 可选 `backend`/`title`，有效通道=backend 或全局值；本地注册表命中**不核验 engine**（响应逐键等于旧四键形状），本地查无向有效通道 engine 核验 `get_session_status`——存在即收编登记进 history 并设为当前（200 同构）、engine 自报 `"HTTP 404"` 照旧诚实 404、不可达 503 SERVICE_UNAVAILABLE 零副作用；switch 成功一律随**有效通道**写命名键（修正随全局值漂移）；engine 直建/未注册会话 UI 点选不再被 404 阻断。遗留：create 处理器仍无条件写全局 `set_current_session`（loom 通道下亦如此，待收编波）；summarize 走通道缝，web=loom 时命中 loom_client 核内自动压缩垫圈（静默无害，见文末遗留登记）） |
| `web_backend.py` | `""`(tags web-backend) | `/api/screen` | Web 通道热切换状态：GET/POST `/api/screen/backend`（POST 校验→落盘 `web_backend.json`→即响应——**W44 解耦：不再 await `events.reset_event_hub()`、不重建 SSE hub**，hub 生命周期与开关无关，事件流恒双流多路复用；只作用 web 对话管线（create/message/list/messages/children/summarize/switch）的路由归属，后台链路仍随全局 ai_backend；非法值 400 `{ok:false,error}` 且零落盘零触碰注册表；鉴权走标准 `/api/screen` Bearer 中间件） |
| `speakers.py` | `/api/screen/speakers` | - | 声纹管理（Form/阈值默认值改读配置）；list/enroll/delete/identify 四端点经 kernel_client 直出内核 `/v1/voiceprint/*`，内核注册表为唯一事实源（V10 外层镜像整文件退役、无 shadow 读路径）；注册音频文件位置归外层 `DATA_DIR/voice/`（`GET /{speaker_id}/audio` 文件直返）；单查/verify 死端点已于 P0-U4 裁除 |
| `tts.py` | tags tts | `/api/screen` | TTS 语音合成 → `/api/screen/tts/speak·synthesize`（定向最近发消息设备；回退 `tts.fallback_client_types`，无目标静默丢弃；stop/status 死端点已于 P0-U3 裁除） |
| `voiceprint_audit.py` | `/api/vaudit` | - | 声纹审计平台 API（读侧统一 `perception_reader`；`/voices` 改内核 `GET /v1/voiceprint/registry` 元数据快照派生（V10，幽灵质心自动净化，向量绝不透出）；裁剪原语统一 `audio_codec`，POST `/crop` 委派 GET 同一实现（V4 三接口一实现）） |
| `wake_word.py` | `/api/screen/wake_word` | - | 唤醒词工具：中文唤醒词 → KWS token（encode 不落盘；keywords 编码并覆盖写词表 + 刷新运行时目标词；"失效已加载模型"自 B1 起外层不再干预——内核 spotter 进程级缓存，内核检测侧换词生效需重启内核）；encode/keywords 编码经内核 kws_encode（`POST /v1/kws/encode`，K4d；`audio.wake_word.model_dir` 随请求下发，仅用于编码 tokenizer） |
| `ws_main.py` | - | - | WS `/ws` 主连接（握手接受可选 `device_id` + `client`，`client` 取 `web`/`native`，默认 `web`） |
| `__init__.py` | - | - | 模块导出 |

## 内核端点契约

本文件只管外层 `/api/*` 路由。部分路由（`speakers.py` 声纹、`wake_word.py` 编码、`preview.py` 评分）经 `services/kernel_client.py` 把请求转发到内核的 `/v1/*` 端点；`/v1/*` 的端点契约、错误码与作业通道以 `docs/kernel-contract.md` 为唯一真源，本文件不复制其内容。

## 关键端点

| 功能 | 端点 | 方法 |
|------|------|------|
| 健康检查 | `/health` | GET |
| 登录 | `/login` | POST |
| TTS 合成 | `/api/screen/tts/speak` | POST |
| 健康数据上传 | `/api/health/sync` | POST |
| 健康数据查询 | `/api/health/query` | GET |
| SSE 事件流 | `/api/screen/events/stream` | GET |
| Web 通道查询/切换 | `/api/screen/backend` | GET / POST（Bearer；只作用 web 对话管线路由，SSE 双 hub 多路复用不受开关影响（W44 解耦），即时生效免重启） |
| WebSocket | `/ws` | WS |
| 声纹注册 | `/api/screen/speakers/enroll` | POST |
| 声纹识别 | `/api/screen/speakers/identify` | POST |
| 唤醒词编码 | `/api/screen/wake_word/encode` | POST |
| 唤醒词同步 | `/api/screen/wake_word/keywords` | POST |
| 通知发送 | `/api/notification/send` | POST（写入后 WS 推送，best-effort） |
| OTA 下载 | `/api/ota/download?token=xxx` | GET（需登录 token） |
| OTA 信息 | `/api/ota/info` | GET |
| PC 采集端信息 | `/api/pc-sensor/info` | GET（需登录 token） |
| PC 采集端下载 | `/api/pc-sensor/download?ticket=xxx` | GET（需登录 token 或一次性票据） |
| 感知事件上报 | `/api/screen/stt/perception-event` | POST |
| 语音分段上传 | `/api/screen/stt/voice-session-multipart` | POST |
| MiMo 音频 | `/api/mimo/audio/{filename}` | GET（HMAC 签名） |
| 音频预览台 | `/api/preview/days`, `/api/preview/timeline`, `/api/preview/audio` | GET |
| cohort 重建 | `/api/admin/cohort/compact` | POST |
| cohort 重载 | `/api/admin/cohort/reload` | POST |
| cohort 统计 | `/api/admin/cohort/stats` | GET |

## W44/W46 遗留登记（2026-10-15 双通道会话分账波，T5 门禁如实落字）

- **create 无条件写全局 current**：`POST /session/create` 处理器仍无条件调 `manager.set_current_session(...)`——loom 通道下新建会话照旧劫持全局 current_session（语音/任务链指针被挪）。W44/W46 均按 MUST NOT 未动，t2-report 登记在案，留待收编波。
- **summarize 的 loom 垫圈**：`POST /session/{id}/summarize` 经通道缝取 client；web=loom 时命中 `services/loom_client.py:669-683` 的 W29-A3 垫圈——loom 核内自动压缩、无 HTTP 手动端点，前端压缩按钮静默无害（不抛错不触网、不推 `session.compacted` 帧=少一条分隔线，D7 容忍）；loom W28-B 真触发面落地后该垫圈须改转发。
- **opencode hub 无 auth 头**：`events.py` 全局事件流对 opencode 上游为 aiohttp 直连，配置 `OPENCODE_SERVER_PASSWORD` 后仍不带 `Authorization: Basic`（t1-report 点名）；启用 loopback 密码前必须先收编，否则全局事件流 401。
- **`partial=[]` 措辞**：`/session/list` 失败腿名单实现为空数组 `[]` 而非 null——`[]`=全量可信、含名=该腿降级。消费方（前端/复核者）判降级须按名单长度，勿按 null 判定（协议文案差异，S6 验收记录在案，语义无冲突）。
- **loom converge 挂死（另案在查）**：W46 验收 S5 观察 loom 面消息流在 converge 阶段挂死（在途流不再出帧，证据留存于当次验收工件 `s5w46-sidL2-messages*.json`）；与双通道分账改造无关，独立线程追查中。

## 已移除的路由

P0 死接口裁剪（2026-10-08，四方零消费者取证见 `docs/archive/audit/2026-10-08/`）：
- `agents_remote.py` — 整文件（/api/agents×5 + /ws/agent + /api/agent/download，旧远程 Agent 体系遗留）
- `tasks.py` — 整文件（/api/screen/tasks×8；定时任务由后端调度器直跑 YAML/脚本，不经此 HTTP）
- `scripts.py` — 整文件（/api/scripts×4 无 UI 消费；脚本管理仍走 ScriptRunner docstring frontmatter）
- 散点端点：/logout、/auth/check、/auth/revoke、/api/health/source×2、/api/health/dates、/api/health/upload-db、/api/screen/tts/stop、/api/screen/tts/status、/api/notification/poll、/api/ota/check、/api/screen/speakers/{id}(GET)、/api/screen/speakers/{id}/verify、/api/screen/stt/voice-session(JSON)、session 域 8 条孤儿（for-agent/current/bind-main-task/abort/stats/agent×2/active）

以下路由更早从原 Axeuh Home System 中移除：
- `voice_assistant_ws.py` — 语音助手 WS（OQ2 裁定删除：自述 DEPRECATED、零客户端、依赖的 aliyun_asr_service 已删；2026-09-23 K2）
- `components.py` — 组件 CRUD（TV大屏不需要）
- `terminals.py` — 终端管理（TV大屏不需要）
- `bash.py` — Bash 执行（TV大屏不需要）
- `stocks.py` — 股票追踪（TV大屏不需要）
- `texts.py` — 文本组件（TV大屏不需要）
- `customs.py` — 自定义组件（TV大屏不需要）
- `stt.py` — 语音识别（本系统不包含STT）
- `stt_ws.py` — STT WebSocket
- `ws_terminal.py` — 终端 WebSocket

## 相关文档

- `../AGENTS.md` - Backend 总览
- `../services/AGENTS.md` - 服务层文档
