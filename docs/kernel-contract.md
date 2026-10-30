# Axeuh 内核对外契约（按实现事实定稿）

> **状态**: 已按 `kernel/axeuh_kernel/` 已实现代码逐节核对（K0-K4d 全通道 + Wave A1-A6 全部 additive 回填），非纸上推演。
> **定稿时间**: 2026-09-23（K 波）；2026-09-24 回填 A1-A6（提交 `38c9e61c`/`962640ce`/`24d8e512`/`b1309839`/`0436ae3f`/`9601f3c7`）。
> **原则**: 本文是**事实契约**——以代码为准；`docs/kernel-design.md`（设计总纲）保持只读，凡与设计不一致处一律**以本文为准**，偏差集中登记于 [§15 事实与设计偏差](#15-事实与设计偏差以代码为准)。
> **fork 校验**: 每节标注 **实现指针**（源文件）与 **测试指针**（`kernel/tests/` 对应测试），fork 可按指针逐节复核。
> **一次性核对命令**（caps kinds 与本文 §13.1 表格一致性）见 [§13](#13-能力自描述-v1capabilities)。

**版本**: `api_version = "1.0.0"`（实现指针 `axeuh_kernel/__init__.py`，启动握手行与 `/v1/capabilities` 共用同一常量）。**Wave A1-A6 全部为 minor additive（新增 kind/字段/端点），零破坏，常量不变**（演进记录见 §14）。

---

## 1. 通道总览

单端口 `127.0.0.1:{port}`，REST 与 WS 同一 app 同一端口（设计 §4.1「单端口」，已实现）。交互式文档端点关闭（`docs_url/redoc_url/openapi_url = None`）。

| 面 | 端点 | 延迟类 | 实现指针 | 测试指针 |
|----|------|--------|----------|----------|
| 协商/生命周期 | `GET /v1/health` · `GET /v1/ready` · `GET /v1/capabilities` | 基础设施 | `health.py` / `caps.py` | `test_handshake.py` · `test_auth.py` · `test_job_voiceprint_kind.py`（caps 断言） |
| 作业通道 | `POST /v1/jobs` · `GET /v1/jobs` · `GET /v1/jobs/{id}`（`?wait=` 长轮询） · `POST /v1/jobs/{id}/cancel` | 批处理 | `jobs/api.py` `jobs/store.py` `jobs/handlers.py` | `test_job_api.py` · `test_job_store.py` · `test_job_audio_kinds.py` · `test_job_voiceprint_kind.py` · `test_job_residual_kinds.py`（A1 三 kind） · `test_a6_asr_cohort.py`（weak_split options） |
| 声纹通道 | `POST /v1/voiceprint/{enroll,identify,verify,score}` · `GET /v1/voiceprint/{speakers,registry,cohort,cohort/metrics,unknown}` · `DELETE /v1/voiceprint/speakers/{id}` · **A6 cohort 管理** `POST /v1/voiceprint/cohort/{reload,compact}` · `GET /v1/voiceprint/cohort/{stats,audit}` | 交互式同步 | `voiceprint.py` `audio/voiceprint/service.py` | `test_voiceprint_api_contract.py` · `test_voiceprint_k2_routes.py` · `test_golden_scoring.py` · `test_voiceprint_a2_sliding_collect.py` · `test_voiceprint_a3_enroll_quality.py` · `test_a6_asr_cohort.py` · `test_voiceprint_registry.py`（P2-K1a） |
| 陌生人通道（A4） | `POST /v1/unknown/track` · `GET /v1/unknown/profiles` · `POST /v1/unknown/profiles/{id}/{confirm,reject}` · `GET /v1/unknown/state` · `POST /v1/unknown/cleanup` | 交互式同步 | `unknown_router.py` `unknown/{service,storage,config}.py` | `test_unknown_api_contract.py` · `test_unknown_chain.py` · `test_unknown_golden_parity.py` · `test_unknown_migrate_state.py` |
| 审计台通道（A5） | `POST /v1/inspect/{vad_curve,asr_sliding,diarize_blocks}` · `POST /v1/voiceprint/space` | 交互式同步 | `inspect_router.py` `audio/inspect.py` `audio/vad_curve.py` `audio_input.py` | `test_inspect_api.py` · `test_space_endpoint.py` |
| 产物通道 | `PUT /v1/artifacts` · `GET /v1/artifacts/{id}` · `DELETE /v1/artifacts/{id}`（P3-K2a，幂等删除，§8.1） | 辅助（替代 base64 入参） | `artifacts.py` | `test_artifacts.py` |
| KWS 编码通道 | `POST /v1/kws/encode` | 交互式同步 | `audio/kws_encode.py` | `test_kws_encode.py` |
| 实时流 | `WS /v1/stream` | 实时（单帧 <200ms 目标） | `stream/router.py` `stream/session.py` `stream/kws.py` `stream/segmenter.py`（A6） | `test_stream_ws.py` · `test_stream_segment_mode.py`（A6 segment 模式） |

- 装配总入口：`app.py`（`create_app`：中间件 → **9 组路由**（health/caps/voiceprint/unknown/inspect/jobs/artifacts/kws/stream） → 统一异常处理）。
- 作业 kind 分层（原子阶段，编排归外层）：`analyze.vad` · `analyze.asr` · `analyze.scene` · `analyze.aed` · `analyze.emotion` · `analyze.breath` · `analyze.diarize` · `analyze.voiceprint`，另有仅测试启用的 `test.park`（见 §6）。
- **数据通道 `/v1/data/entries` 已砍**（设计 §4.1 注，零真实消费者）——实现中不存在该路由。

---

## 2. 认证（Bearer + Origin + WS query token）

**实现指针**: `auth.py`（REST 中间件）、`stream/router.py`（WS 端点内自校验）。
**测试指针**: `test_auth.py`（REST 401/403/免验矩阵）、`test_stream_ws.py`（WS token/Origin）、`test_handshake.py`（免验 health 可达）、`test_job_api.py`（带/不带 token 的作业端点）、`test_unknown_api_contract.py`·`test_inspect_api.py`（新通道鉴权参数化覆盖）。

| 规则 | 行为 |
|------|------|
| Bearer | 除 `GET /v1/health` 外**全部端点**要求 `Authorization: Bearer <token>`；`secrets.compare_digest` 恒定时间比较（`auth.check_bearer`） |
| 缺失/错误 token | `401 {"error":{"code":"auth.failed",...}}` |
| Origin 校验 | **Origin 头存在且非空 → 403 auth.failed，无论其值**；仅缺省或空串放行。适用于**所有端点（含 `GET /v1/health`）**，Origin 检查先于 Bearer 检查（`auth.create_auth_middleware`） |
| 免 Bearer | 仅 `GET /v1/health`（路径常量 `health.HEALTH_PATH`，auth 中间件据此放行，单一事实来源） |
| WS `/v1/stream` | `BaseHTTPMiddleware` 只处理 http scope 不拦 WebSocket → 端点内自校验：`?token=` 恒定时间比较 + Origin 非空拒绝；失败时 **accept 后立即回 `error auth.failed` 再 close(1008)**（等价拒绝，跨源拿不到业务帧）。REST 侧契约原样不动，两边同一 token |

token 来源：启动握手期由入口 `__main__.require_token()` 从环境变量 `AXEUH_KERNEL_TOKEN` 读取后注入 `create_app(token)`——**应用层不读环境**，`token` 为空时 `create_app` 直接 `ValueError`。

---

## 3. 启动握手（stdout JSON / --port 0 / --state-dir / AXEUH_KERNEL_TOKEN）

**实现指针**: `__main__.py`、`state.py`、`__init__.py`。
**测试指针**: `test_handshake.py`（真实子进程：单行 JSON + 键集精确 + health 可达 + stdout 唯一行）。

### 3.1 CLI 与快速失败顺序

```
python -m axeuh_kernel --port 0 --state-dir <dir> [--config <path>]
```

| 项 | 契约（代码事实） |
|----|------------------|
| `--port` | 默认 `0`（系统分配）；范围 `0..65535`，越界 → stderr + **退出码 2** |
| `--state-dir` | **必填**；缺失由 argparse 拒绝（退出码 2） |
| `--config` | 可选；不可读 → stderr + 退出码 2；JSON 解析失败按原始文本保留（阶段 0 只做可读性校验，内容不被任何逻辑消费） |
| token | **仅环境变量 `AXEUH_KERNEL_TOKEN`**；缺失/空 → stderr + **退出码 2**。**无 `--token` 命令行参数**（命令行会进进程列表），比设计 §4.6 更严格 |
| 推理设备 | 环境变量 `AXEUH_KERNEL_DEVICE` ∈ `cpu`（缺省，未设即 cpu）\| `gpu` \| `auto`（2026-10-01 additive）：`resolve_device()` 统一解析——`gpu/auto` 且 CUDA 可用 → `cuda:0`，否则自动回退 cpu（绝不因设备问题抛错阻断惰性加载）；非法值按 cpu fail-safe。作用于全部 torch 系模型（asr/emotion/scene/aed/vad/vad_curve/unknown diar/voiceprint 嵌入），sherpa-onnx KWS 恒 CPU 不受影响。调用期读取（同 models_source 纪律，不 import 快照）。外层经 config `kernel.device` 随 spawn 注入 env（`device.py`） |
| 绑定 | **`127.0.0.1` only**（`BIND_HOST` 常量）；先 `bind` + 显式 `listen(2048)` 再握手；bind 失败 → stderr + **退出码 1** |

快速失败顺序：`token → config → 状态目录 → 绑定 → 握手行 → 服务`。

### 3.2 握手行

- 先建 socket 绑定（`--port 0` 则读系统分配的真实端口），再向 **stdout 打印且仅打印一行** JSON（紧凑分隔符、flush）：

```json
{"port":52341,"pid":1234,"api_version":"1.0.0"}
```

- 键集精确为 `{port, pid, api_version}`（测试锁定）；此后 stdout 不允许再有任何内容。
- **所有日志一律走 stderr**（uvicorn 默认日志配置被覆盖为 `ext://sys.stderr`，含 access log 与 `axeuh_kernel` logger），防止污染握手行。
- 服务以已绑定的 socket 传入 `uvicorn.Server.run(sockets=[sock])`。

### 3.3 状态目录布局

`state.ensure_state_dir` 启动时确保存在四个私有子目录（幂等，`STATE_SUBDIRS`，A4 起含 `unknown`）：

```
<state-dir>/voiceprint/   <state-dir>/jobs/   <state-dir>/artifacts/   <state-dir>/unknown/
```

注册库文件在 `<state-dir>/voiceprints/voiceprints.json`（复数目录，首次落盘时自动创建）；A2 cohort 采集落 `<state-dir>/voiceprint/cohort_active.jsonl` + `cohort_audit.jsonl`；A4 陌生人链五文件落 `<state-dir>/unknown/`（§11.4）。`--state-dir`（不是 `--data-dir`）：业务数据归外层，内核只有私有状态根。服务实例经构造参数注入路径（**不做 import 时快照**）；测试未注入时在调用期创建临时状态根。内核生命周期独立于外层。

**外层→内核首启播种（2026-10-08 登记，审计 W3）**：外层 `kernel_client` 在 spawn 时对 `voiceprints/` 注册库与 cohort 文件做 **copy2 播种**——仅目标缺失时复制，属**一次性首启引导**语义；外层注册库镜像退役（P2-V10 进行中）后**仅首部署触发**。系跨进程文件旁路而非契约通道，与 §15-20~22 同批回写登记。

### 3.4 模型权重统一解析链（A1，`models_source.py`）

内核私有模型资源**零外层目录依赖**（全内核源码无 `backend/`、仓库根反推字面路径；旧 `AXEUH_SCENE_*` 环境变量废弃、全仓零消费者）。文件与目录共用同一条链，全部调用期读取：

| 级 | 来源 |
|----|------|
| a | 环境变量 `AXEUH_KERNEL_MODEL_DIR`（用户私有模型目录，最高优先） |
| b | 包内双根：`axeuh_kernel/models/`（大权重区，若存在；0.1.0 发行包刻意不含）→ `axeuh_kernel/audio/data/`（随包小资源，如 AudioSet 标签 CSV） |
| c | 下载落地目录：`AXEUH_KERNEL_MODEL_DOWNLOAD_DIR` 优先，缺省 Windows `%LOCALAPPDATA%/axeuh-kernel/models`、其余平台 `~/.cache/axeuh-kernel/models` |

- **自动下载默认关**：仅当调用方给出 `download_url` 且 a/b 未命中且（scene 作业路径）环境变量 `AXEUH_KERNEL_ALLOW_MODEL_DOWNLOAD=1` 显式许可才首拉（当前唯一使用者为 Cnn14 权重 Zenodo 拉取，原子写 `.part`→rename + 可选 MD5 校验，任何失败静默返回 None）。**caps 自描述与 `model_available()` 门控恒 `allow_download=False`，永不联网**。
- 任何一级未命中 → None，由调用方改抛 `model.unavailable`(503, retryable)——绝不阻断内核启动/能力自描述。`relative_name` 绝对路径/盘符/`..` 一律拒绝（防路径穿越）。
- KWS 缺省目录（`kws_encode` 与 `stream/kws` 同源）：`resolve_model_dir("sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20")`；词表缺省 `resolve_model_file("keywords.txt")`，未命中再退「解析命中目录的兄弟 keywords.txt」→ 包内期望路径（`stream/kws._resolve_default_keywords_file`）。旧「缺省指向外层 `ai/data/wake_word/`」的路径反推已随 A1 断除。

---

## 4. 错误码（12 个封闭枚举）

**实现指针**: `errors.py`（枚举/格式化/响应模型）、`app.py`（`KernelError` 与请求体校验异常处理器）。
**测试指针**: `test_error_codes.py`（恰好 12 个、形状、未知码强制 `retryable=false`、details 省略规则）。

### 4.1 错误响应形状（冻结）

```json
{"error": {"code": "input.invalid", "message": "...", "retryable": false, "details": {...}}}
```

- `details` 为空（`None`/空 dict）时**省略该键，绝不出现在响应里为 null**（`errors.force_format`）。
- 未知错误码一律 `retryable=false`（`force_format` 强制）。
- 形状由 `ErrorResponse`/`ErrorDetail` 模型锁定（`extra="forbid"`）。
- FastAPI 请求体校验失败 → `400 input.invalid`（`app.request_validation_handler` 截断前 5 条错误），**不外泄 FastAPI 422 原始体**。

### 4.2 封闭枚举与语义

| code | 典型 HTTP | retryable | 内部产出点（实现指针） |
|------|-----------|-----------|------------------------|
| `auth.failed` | 401（token）/ 403（Origin） | false | `auth.py` · `stream/router.py` |
| `version.mismatch` | — | false | **封闭保留，当前无端点产出**（api_version 协商由外层启动时比对握手/caps 完成） |
| `input.invalid` | 400 | false | 校验类全域（`app.py` 400 兜底、`jobs/api.py`、`jobs/handlers.py`（含 A6 asr weak_split options 白名单）、`artifacts.py`、`voiceprint.py`（含 A2 sliding 窗>hop、A3 thresholds/three 门拒绝）、`unknown_router.py`·`unknown/service.py`（XOR/config_override）、`inspect_router.py`·`audio/inspect.py`（engine 非法）、`audio/kws_encode.py`、`stream/session.py`、`audio_input.py`（WAV 解析失败/空音频） |
| `input.unsupported_format` | 415（HTTP）/ WS 帧内 | false | `audio/voiceprint/service.py`（WAV 格式 415）、`audio/{asr,scene,diarize,emotion,breath}.py`（音频不可解码 415）、`audio_input.py`（非 mono/16bit/16kHz——unknown/inspect 同步通道共用）、`stream/session.py`（sample_rate≠16000） |
| `input.not_found` | 404 | false | `artifacts.py`（产物缺失）、`jobs/api.py`（artifact 不存在）、`jobs/handlers.py`（音频/批量输入缺失）、`voiceprint.py`（DELETE 缺席）、`unknown_router.py`（artifact 缺失/档案 id 缺席）、`audio_input.py`（artifact 缺失） |
| `artifact.too_large` | 413 | false | `artifacts.py`（流式累计超限立即止、不落盘） |
| `kernel.busy` | 429 | **true** | `jobs/api.py`（溢出，附 `Retry-After: 5` 头） |
| `job.not_found` | 404 | false | `jobs/api.py`（查询/取消未知 id） |
| `job.cancelled` | 409（终态再取消） | false | `jobs/api.py` `request_cancel`；作业落 `cancelled` 终态时写入 error 载荷 |
| `job.interrupted` | —（retryable 语义码） | **true** | 封闭保留：内核重启把 `running` 翻转 `interrupted`（`jobs/store._load`）只改状态、**不写 error 载荷**；该码供外层语义消费 |
| `model.unavailable` | 503 | **true** | 模型/依赖缺失（`handlers.py` 音频八 kind（含 A1 aed/emotion/breath）、`kws_encode.py`、`stream` KWS 工厂、`voiceprint` 提取器、`unknown/segmenter.py`（L1 缺 503 化）、`audio/{vad_curve,inspect}.py`（引擎/探针缺）） |
| `state.unavailable` | 503 | **true** | 状态文件损坏/缺失（`jobs/store.py`、`artifacts.py`、`voiceprint` 注册库/cohort 读失败、`unknown/storage.py`（JSONL 坏行 fail-closed）、`audio/inspect.py`（PCA 分解失败）、`stream` 装配/状态源） |

- **恰好 12 个，新增即破坏性变更**（`errors.ERROR_CODES` frozenset；caps 的 `error_codes` 即其 `sorted` 形式）。A1-A6 未增删任何码。
- **可重试语义表**（设计只冻结了「未知码 retryable=false」，实现附加语义划分）：`_RETRYABLE_CODES = {kernel.busy, job.interrupted, model.unavailable, state.unavailable}` 为 true，其余默认 false。
- `job.cancelled` 落终态的判定唯一出口：`jobs/api._fail_job`（`code == job.cancelled → cancelled 态，其余 → failed 态`）。

---

## 5. 通用约定：时间 / 分数 / `_ms` / ID / 截断

**实现指针**: `jobs/store.utc_now_z` · `artifacts.utc_now_z` · `handlers._ms` · `stream/session.clamp01` · `voiceprint.service.utc_now_z` · `unknown/service.utc_now_z`。
**测试指针**: `test_job_store.py`（时间 Z 结尾/迁移）、`test_stream_ws.py`（confidence 收进 0-1）、`test_artifacts.py`（id 白名单）、`test_unknown_api_contract.py`/`test_inspect_api.py`（computed_at Z 格式）。

| 项 | 约定（代码事实） |
|----|------------------|
| 时间 | **UTC RFC3339、`Z` 结尾、秒级**（`"%Y-%m-%dT%H:%M:%SZ"`），禁本地偏移。作业 `created_at/updated_at/finished_at`、产物 `created_at`、声纹/陌生人/审计 provenance `computed_at` 均走此格式。响应层的已知例外仅 `kws_encode` provenance `computed_at`（`isoformat()`，§15-9 登记）。**内部状态文件层**（A4 unknown `session_state/matcher/profile` 的 `saved_at/last_seen` 等）用 **naive UTC `isoformat()`**、审计行 `ts` 用 aware isoformat——不出响应，§15-16 登记 |
| 分数 | 0–1；WS 出站 confidence 一律 `clamp01`；声纹 similarity/threshold 0..1（请求体 `Field(ge=0,le=1)`）；ref_sim/win_pct 等 round 4 |
| 时长/时间点 | 一律 `_ms` 整数后缀（`duration_ms`/`start_ms`/`end_ms`/`speech_ms`/`t0_ms` 等）；秒→毫秒经 `handlers._ms`（round） |
| 列表截断 | facts 内列表一律截前 N 条 + `*_truncated`/total 计数，**绝不携带大数组/波形/概率全量**。上限常量（实现指针括注）：`_MAX_FACT_SEGMENTS=200`（vad/diarize/emotion/breath）、`_MAX_FACT_ASR_SEGMENTS=50`、`_MAX_FACT_AED_EVENTS=200`、`_MAX_FACT_TAGS=10`、`_MAX_FACT_MATCHES=5`、`_MAX_TEXT_CHARS=4000`（以上 `handlers.py`）；`_MAX_SLIDING_WINDOWS=256` 窗（A2 `voiceprint/service.py`，扁平 512 数）；`_MAX_FACT_BLOCKS=200`（A4 `unknown/service.py`）；diarize_blocks ≤200、vad_curve `max_points≤50000`+抽稀、asr_sliding `max_windows≤2000`（A5 `inspect_router.py`/`inspect.py`，D2 豁免条款见 §12） |
| 向量红线 | **响应任意层级禁止嵌入向量键**（`embedding/embeddings/vector/vectors/centroid_payload`），A4/A5 各测试以递归扫描锁定（请求方向 `unknown.segments[].emb` 允许） |
| 作业 id | `job_<uuid4 hex 32>`（`jobs/store.create`） |
| 产物 id | `art_<uuid4 hex 32>`；读取路径白名单正则 `^art_[A-Za-z0-9][A-Za-z0-9_\-]*$`（`artifacts._ARTIFACT_ID_RE`，防路径穿越；jobs 侧 `input.artifact` 同一约定） |

---

## 6. 作业通道（生命周期 / Idempotency-Key / 长轮询）

**实现指针**: `jobs/store.py`（状态机+原子持久化）、`jobs/api.py`（HTTP+执行管理+长轮询）、`jobs/handlers.py`（业务 kind 注册）。
**测试指针**: `test_job_store.py` · `test_job_api.py` · `test_job_audio_kinds.py` · `test_job_voiceprint_kind.py` · `test_job_residual_kinds.py` · `test_a6_asr_cohort.py`。

### 6.1 状态机（`jobs/store.py`）

```
queued ──> running ──> done | failed | cancelled | interrupted
   └─────────────> cancelled
终态(done/failed/cancelled/interrupted)无出边；非法迁移 → input.invalid
```

- `VALID_STATES`/`TERMINAL_STATES` 为 frozenset 导出（路由/测试共用同一事实来源）。
- 持久化：**每作业一个 JSON** `{state-dir}/jobs/<id>.json`，同目录临时文件 + `fsync` + `os.replace` 原子落盘，成功后绝不残留 `.tmp`。
- **重启 reload**：任何 `running` 一律翻转 `interrupted` 并写回磁盘（补 `updated_at/finished_at`，不写 error 载荷）——外层**不再**据此重新提交（恢复归属裁定见 §15-21：由外层 requeue 队列唯一承担，该列表仅供运维观测）。
- 全部公开方法持 `RLock`（事件循环线程与工作线程共用一份实例）。
- 启动 `lifespan` 调 `JobManager.dispatch_pending()` 分发重启前遗留的 `queued` 作业（事件循环已就绪）。

### 6.2 提交 `POST /v1/jobs`

请求体 `{kind, input?, options?}`（`extra=forbid`；input/options 默认空对象）。**`options` 为自由 dict，api 层不做键校验，语义校验归各处理器**（A6 asr weak_split、A1 aed/emotion/breath 同款先例——非法值以作业 `failed` + 封闭码收敛，不同步 400）。提交内部顺序（`JobManager.submit` 整段持锁原子执行）：

1. **幂等重放最先**：`Idempotency-Key` 头 → 命中既有作业直接返回（含已终态结果，**忙时同 key 仍可重放、不重复计算**）；索引从落盘记录 `idempotency_key` 字段重建（**跨重启仍可重放**）。
2. kind 必须已注册，未知 kind → 400 `input.invalid`（同步拒绝，不落盘死信作业）。
3. `input` 校验：`artifact`/`path` **二选一**（都缺 400、都有 400、`path` 须非空串、`artifact` 白名单格式 + `<state>/artifacts/<id>.meta.json` 存在性 → 缺失 404 `input.not_found`）。
4. **溢出**：`queued+running >= max_pending`（默认 **32**，可在装配期收紧）→ `429 kernel.busy` + 响应头 **`Retry-After: 5`**（`RETRY_AFTER_BUSY`）。

响应 = 作业记录 dict（`id/kind/input/options/state/created_at/updated_at[/idempotency_key]`）。

### 6.3 查询与长轮询

- `GET /v1/jobs/{id}` = **唯一真相源**（持久化，重启可查）；未知 → 404 `job.not_found`；带协作取消标志时响应附 `cancel_requested: true`。
- `GET /v1/jobs/{id}?wait=N`：**长轮询**，`N` 上限截到 `MAX_WAIT_SECONDS = 30.0`；用完成 future + `asyncio.wait_for(asyncio.shield(future))` 等待——**绝不 sleep 轮询/阻塞事件循环**；一个等待者超时不取消他人；**超时返回当前状态（不报错）**。完成信号经 `loop.call_soon_threadsafe` 点亮（`JobManager._resolve`）。
- `GET /v1/jobs?state=&kind=&limit=`：列表（**外层重启恢复在途任务的唯一途径**——**已过时**：外层恢复语义由 requeue 队列唯一承担，本面含 `?state=interrupted` 降级为**仅供运维观测**，裁定见 §15-21）；`limit` 1..500 默认 50；非法 `state` → 400 `input.invalid`；按 `created_at` 倒序；响应 `{jobs, count}`。
- `POST /v1/jobs/{id}/cancel`：
  - 未知 → 404 `job.not_found`
  - 已终态 → **409 `job.cancelled`**（终态不被破坏）
  - `queued` → 立即转 `cancelled`（与工作线程抢转失败则回落协作标志）
  - `running` → 置**进程内存协作取消标志**，处理器观察 `ctx.cancelled()` 后自行落 `cancelled`；响应与 GET 均带 `cancel_requested=true`（标志不持久化——重启后 running 已翻转 interrupted，无需恢复）

### 6.4 执行模型

- 处理器在 **`ThreadPoolExecutor(max_workers=4)`** 线程池执行，事件循环永不被处理器阻塞；队列深度（32）与线程数解耦，超出部分在 `queued` 排队。
- `done` 落盘 `payload = {"result": {"kernel": <信封>, "outer": {}}}` —— **`outer` 内核恒给空对象**，由外层落盘时自拼（§7）。
- 处理器返回非 dict → 收敛为 `input.invalid` 作业失败；处理器抛 `KernelError` 按其封闭码落 `failed`（`job.cancelled` 落 `cancelled`）；任意未捕获异常收敛为 `input.invalid` `failed`（**绝不吐非封闭错误**）。
- 处理器注册：`register_handler`（测试/内嵌）+ 惰性导入 `jobs/handlers.register_all`（`ImportError` 安静跳过）——**仅新增注册，不覆盖调用方已注册 kind**。
- **kind 清单**（`handlers.register_all`，共 8 个 analyze.*）：`analyze.voiceprint` · `analyze.vad` · `analyze.asr` · `analyze.scene` · `analyze.diarize` · **A1 追加** `analyze.aed` · `analyze.emotion`（外层已停用，§15-20） · `analyze.breath`；`test.park` 仅在 `AXEUH_KERNEL_TEST_KINDS=1` 时注册（生产不设该变量则不存在、也不进 caps）。
- 音频 kind 行为：先校验输入（确定性 404）→ 查 `model_available()`（不可用 → 503 `model.unavailable`，不卡死不吐非封闭错）→ 协作取消检查 → 计算 → facts 只含元数据（§5 截断表）；`analyze.voiceprint` 只做纯数学 AS-Norm 打分（`score_all_v2`，查询向量随输入提供，不加载嵌入模型）；provenance 五键恒非空，非声纹 kind `cohort_hash="none"`、音频预处理版本 `wav-16k-mono-v1`。
- **A1 残留三 kind**（实现 `audio/{aed,emotion,breath}.py`，黄金对拍 `test_residual_parity.py`）：
  - `analyze.aed`：PANNs 逐窗事件检测（与 scene 共享同一份 Cnn14 权重单例）。`options.segment_s`（0.5..30，默认 2.0）、`options.top_k`（1..10，默认 5）非法 → `input.invalid`。facts `{duration_ms, count, events:[{label,label_cn,start_ms,end_ms,prob}], events_truncated, reason}`（events ≤ `_MAX_FACT_AED_EVENTS=200`）；provenance model_id=`panns/Cnn14_16k`。
  - `analyze.emotion`：emotion2vec_plus_base 逐段情绪校准。**外层已停用（2026-10-07 提交 `e194366e`，§15-20），内核 handlers 冻结保留**。段列表取 `input.segments` 优先、`options.segments` 其次（`[{start_ms,end_ms}]`，非法 → `input.invalid`；<0.5s 段跳过不校准）。空段 → 200 空结论 `reason=missing_input`。facts `{duration_ms, segments:[{start_ms,end_ms,emotion,emotion_cn,confidence}], segment_count, segments_truncated, primary_emotion, primary_emotion_cn, counts, reason}`（≤200）。**只出独立事实，不做跨 kind 合并**（合并归外层适配层）。
  - `analyze.breath`：频谱呼吸/叹气检测（纯 DSP 无外部权重，`builtin/spectral-breath-detector`）。`options.vad_timeline`（`[{start_ms,end_ms}]` 语音掩码，可选）。facts `{duration_ms, breaths:[{start_ms,end_ms,kind}], count, breaths_truncated, reason}`（≤200）。
- **A6 `analyze.asr` 可选 `options.weak_split`**（实现 `audio/weak_split.py`，对拍 `test_weak_split_parity.py`/`test_a6_asr_cohort.py`）：
  - 白名单键 `{enabled, window_ms, low_energy_win_ms, min_seg_ms, max_seg_ms}`（缺省 `enabled=false`、`window_ms=1500`、`min_seg_ms=2500`、`max_seg_ms=12000`——**wake_word_service 版数值权威**；`low_energy_win_ms` 宽容接收但 wake 版不消费）。非对象/未知键/非正整数值 → `input.invalid`（处理器级，作业 failed）。
  - `enabled=true`：整段 PCM 按无重叠帧 RMS 谷切子段 → 每子段经 `pcm_to_wav_bytes` 包临时 WAV（落 `{state-dir}/jobs/`，即用即删）走既有 transcribe → 段边界与 `word_ts` 回移全局时间轴。facts 与整段模式形状兼容 + additive 两键 `weak_split_applied=true` / `n_subsegments`。
  - **默认关时行为与旧版逐字节一致**（回归锁，不产出两键）；`enabled=false` 显式传入同路径。
  - `vad_processor` 段域版**未移植进内核**（`weak_split.py` docstring 载明两版**不同源**差异表；§15-13 登记）；`analyze.vad` 无 weak_split 选项。

---

## 7. 声纹通道与 voice schema（kernel 信封 + outer）

**实现指针**: `voiceprint.py`（路由+信封）、`audio/voiceprint/service.py`（服务）、`audio/voiceprint/scoring.py`（打分数学）、`audio/voiceprint/cohort.py`（采集门/工作集数学）。
**测试指针**: `test_voiceprint_api_contract.py`（信封/脱敏/鉴权唯一事实来源）、`test_voiceprint_k2_routes.py`、`test_golden_scoring.py`（分数与后端逐位一致）、`test_caps_voiceprint_model.py`、`test_voiceprint_a2_sliding_collect.py`（A2）、`test_voiceprint_a3_enroll_quality.py` + `test_enroll_quality_parity.py`（A3）、`test_a6_asr_cohort.py`（A6 cohort 管理）、`test_voiceprint_registry.py`（P2-K1a registry 快照）。

### 7.1 内核信封（发布即固化）

```json
{
  "schema_version": "1",
  "facts": { "...算法结论，只含元数据..." },
  "provenance": {
    "model_id": "...", "model_hash": "...", "cohort_hash": "...",
    "preprocessing_version": "...", "computed_at": "...Z"
  }
}
```

- 三键在**响应顶层**；`schema_version` 为**非空字符串 `"1"`**（`voiceprint.SCHEMA_VERSION`；设计稿示例画的数字 `1` 以契约为准，见 §15-4）。
- `provenance` 五键**恒非空**（声纹通道 `svc.provenance()`，`cohort_hash` 走 provenance）。
- `facts` 只含元数据（id/名称/分数/阈值/计数/时间戳）；**响应任意层级禁止嵌入向量键**（§5 向量红线）。
- **POST 空请求体 `{}` 返回 200 空结论**（`reason=missing_input`），缺字段不报 400（POST 一致：enroll/identify/verify/score）。
- 请求体模型全部 `extra=forbid`、字段可选。

### 7.2 端点（voiceprint 路由 14 个；`/v1/voiceprint/space` 见 §12）

| 方法 | 路径 | facts 要点 / 错误 |
|------|------|-------------------|
| POST | `/v1/voiceprint/enroll` | `{enrolled,speaker_id,name,remark,scene_tag,created_at,embedding_dim,segments_used,duration_ms,speaker_count,quality_report}`；**A3 质量链**（§7.4）：`segments_used` 为实际聚合段数（不再恒 1）、`quality_report` 恒出；空体 `enrolled=false`（`segments_used:0`）；质量拒绝 **400 `input.invalid`**（§7.4）；body 可选 `thresholds`（8 键覆盖，非法 → 400） |
| POST | `/v1/voiceprint/identify` | `matched/speaker_id/name/similarity/threshold/threshold_passed/candidates/count/as_norm_on/n_cohort`；`threshold` 默认 0.45、`top_k` 默认 3（1..20） |
| POST | `/v1/voiceprint/verify` | `found/speaker_id/name/similarity/target_score/threshold/threshold_passed`；缺 `speaker_id` 或 `audio_b64` → 空结论 |
| POST | `/v1/voiceprint/score` | score_all_v2 detail 六键 `scores/raw/imp_mean/imp_std/n_cohort/as_norm_on`；**A2 additive**（§7.3）：可选 `sliding` → `windows/win_max/win_pct/windows_total`；可选 `collect`(+`collect_meta`) → `collected/collect_reason` |
| DELETE | `/v1/voiceprint/speakers/{id}` | 缺席 → **404 `input.not_found`**（路径寻址资源语义） |
| GET | `/v1/voiceprint/speakers` | 注册清单 `{count, speakers:[{speaker_id,name,embedding_dim,created_at}]}`（时间倒序，无向量） |
| GET | `/v1/voiceprint/registry` | **（P2-K1a，2026-10-08 additive）** 注册库全量元数据快照 `{count, speakers:[11 键条目]}`（§7.6，无向量；为消外层 W1 野生直读而生） |
| GET | `/v1/voiceprint/cohort` | cohort 工作集白名单元数据（`_COHORT_META_KEYS` 12 键裁剪：t/src/src_start/src_end/dur/sim/rms/env/speech_prob/status/reviewed/rejected）；`source` ∈ `active`/`legacy`/`empty`（active 优先、旧 `cohort.jsonl` 回退）；`cohort_hash` 进 provenance |
| GET | `/v1/voiceprint/cohort/metrics` | 池质量指标（`status:ok` + `imp_mean/imp_std/pool_sim/max_sim_any` 分位 + `as_norm_reference`；池 <2 → `status:unavailable`，向量不出内核） |
| GET | `/v1/voiceprint/unknown` | 未知说话人清单 `{count, source:"unknown_db", items:[{id,label,status,confirm_count,support_count,created_at}]}`；**A4 起接真实 unknown 库**（未装配时回退 K1 恒空骨架 `source:"none"`+note，§15-18 登记 source 值变化） |
| POST | `/v1/voiceprint/cohort/reload` | **（A6）** 显式重读 active 工作集 + 计数回显 `{reloaded:true, count}`；内核本就每请求读盘（幂等语义 §15-17） |
| POST | `/v1/voiceprint/cohort/compact` | **（A6）** audit → `select_active`（reviewed 优先/时间倒序/sim 升序 + 按天配额 + 多样性贪心，上限 500）原子重写 active；播种条（active 中不在 audit 的）永不丢；facts `{active_count, audit_count, kept, dropped_rejected, before}` |
| GET | `/v1/voiceprint/cohort/stats` | **（A6）** `{active, buffer}`（内核 write-through 采集无攒批缓冲，`buffer` 恒 0；键集对齐外层 `get_stats`） |
| GET | `/v1/voiceprint/cohort/audit` | **（A6）** query `offset`(≥0)/`limit`(clamp 1..1000 默认 300)/`date`(t 前缀过滤)/`sim_min`；facts `{count,total,offset,limit,stats{n,mean,median,min,max},items}`——items 白名单键 + `quality`，**embedding 键剥离**；缺文件 = 200 零计数（不 404） |

WAV 输入 `decode_wav_b64`：非单声道/非 16bit/非 16kHz → **415 `input.unsupported_format`**。

### 7.3 A2 score 增强（`POST /v1/voiceprint/score`）

- **`sliding:{window_ms,hop_ms}`**（`SlidingParams`，默认 1500/750，各 `ge=100 le=60000`）：单请求输出整段滑窗趋势，窗分=逐窗嵌入 `score_all_v2` 降序首项（对齐外层逐窗 `kernel_score` head 语义，AS-Norm on/off 两态一致）。`window_ms <= hop_ms` → 400 `input.invalid`（路由层显式校验）。facts additive 四键：
  - `windows`：**扁平数组 `[start_ms, score, start_ms, score, ...]`**，只带前 **256 窗**（`_MAX_SLIDING_WINDOWS`，512 个数）；
  - `windows_total`：截断前全体窗数；`win_max`：全体窗分最大值（round 4，无窗 → null）；`win_pct`：`score>0` 窗占比（round 4，无窗 → null）。
  - 单窗提取/打分异常跳过该窗（外层 `except: pass` 同款不中断）。
- **`collect:true`**（默认 false）+ 可选 `collect_meta{src_file,src_t,src_start,src_end,env_tag,speech_prob}`（缺省对齐外层 `try_collect` 形参默认：空串/0.0/speech_prob 1.0 仅落盘不过门）：打分成功时内核内执行 cohort 自动采集——预门 raw 头分 `>=0.25` + 六门（时长 <2s / >55s、RMS <0.008、余弦距离 <0.01 去重、同源同日 ≥5 限流；门常量 `cohort.py`，9-05 调优资产零漂移）。落盘 `voiceprint/cohort_active.jsonl`（覆盖原子）+ `cohort_audit.jsonl`（追加），条目 schema 逐键对齐外层。facts additive 两键 `collected`(bool) / `collect_reason`——封闭短语全集（`voiceprint/service.py` 模块注释）：`written` / `too_similar` / `short` / `long` / `rms_low` / `dup` / `daily_cap` / `not_scored` / `write_fail`。窗级 1.5s < `MIN_DUR_S 2.0` 不采集（与外层逐窗实际行为一致），采集恒整段一次。
- **回归锁**：不带 `sliding`/`collect` 的请求 facts 键集与旧版逐键相等（`test_voiceprint_a2_sliding_collect.py`）；空体 200 `missing_input` 不变（不产出 extras）。

### 7.4 A3 enroll 质量门（`audio/voiceprint/service.py::VoiceprintService.enroll`）

质量链逐函数移植外层 `VoiceprintService.enroll`（外层实现为唯一数值语义权威）：

1. **VAD 切段**（`audio/vad.detect_segments` 双引擎；pyannote+silero 皆缺 → **降级整段单嵌入，不 503**，`quality_report.vad_skipped=true`、`engine="none"`）；
2. **整段三门**（判定序 snr→ratio→duration）：`min_snr=15.0` / `min_speech_ratio=0.5` / `min_duration=3.0`；
3. **逐段提取**：段长 ≥ `min_seg_s=1.0` 且段 SNR ≥ `min_seg_snr=1.0` 才嵌入；
4. **一致性过滤**（合格段 ≥ `trigger_count=3` 启用）：与其它段平均余弦 < `min_consistency=0.55` 的离群段丢弃（带段数下限回退保护）；
5. **质量判定**：合格段数 ≥ `min_seg_count=2`，否则拒绝；
6. **质心聚合**：各段嵌入 L2 归一后按段 SNR 加权平均再归一（对齐 `_rebuild_centroids`）。

- body 可选 `thresholds`：8 键全覆盖（`min_snr/min_seg_snr/min_consistency/min_speech_ratio/min_duration/min_seg_s/min_seg_count/trigger_count`，全部 `ge=0`；未知键/非数值 → 400 `input.invalid`）。
- facts additive：旧键零变化，新增 `quality_report`（成功/降级报告八键 `{snr,speech_ratio,duration_sec,segments_used,quality_score,vad_skipped,engine,dropped_segments}`，形状对齐外层 enroll 报告 + 内核侧补充键；**拒绝报告额外带 `reason` 门名**）；成功 `enrolled` facts 另带 `speaker_count`；`segments_used` 从恒 1 升级为实际聚合段数（VAD 降级 = 1）。
- **质量拒绝 → 400 `input.invalid`**，`details` 四键 `{error:"quality_check_failed", reason, name, quality_report}`——reason 封闭集：`snr_too_low` / `speech_ratio_too_low` / `duration_too_short` / `no_valid_segments` / `not_enough_segments`（不发明新错误码，外层 dict 键映射）。
- 嵌入模型缺失 → `model.unavailable` 503（与 VAD 降级路径分界：注册可用性优先）。
- `create_app` 新注入口 **`voiceprint_vad`**（与 `voiceprint_extractor` 同款实例级模式，假 detector 免真模型驱动质量链）。

### 7.5 voice 输出 schema（kernel + outer 切分）

- **内核只产 `kernel{schema_version,facts,provenance}`**；作业通道结果信封为 `{"kernel": {...}, "outer": {}}`，`outer` **恒空对象**、由外层落盘时自拼（设计 §4.3/§5：内核管「怎么算」，外层管「写到哪、业务含义、设备名/时间 t/落盘路径 audio 等外层字段」）。
- 设计 §5 的业务级 `voice` 条目（`type/t/device_name/audio/...` 字段组装）**当前由外层 `analyze_audio_file` 链路产出**，内核 `analyze.*` kind 不产出该条目；信封形状是两者共守的载体契约。
- 向量一旦出内核外层即可复刻打分算法——**facts 永不携带向量**是不可退让条款。

### 7.6 P2-K1a 注册库全量元数据快照 `GET /v1/voiceprint/registry`（2026-10-08 additive）

**存在根因**: 契约此前只有四键摘要 `GET /v1/voiceprint/speakers`，无全量注册库快照端点，K4c 双写方案只好跨进程直读内核私有 state-dir 文件 `{state}/voiceprints/voiceprints.json`（野生通道 W1，取证 `docs/archive/audit/2026-10-08/raw/02-kernel-contract.md`）——文件面把注册库**连同 embedding 向量**复刻进外层 v4 镜像，绕开 §5/§7.5 向量红线。本端点交付合法 HTTP 面，外层接线与镜像退役在 **V10**（本单元不动 backend/）。

- **形状**: 内核信封三键（§7.1）；`facts = {count, speakers:[条目]}`，`count` = 条目数（与 speakers 长度恒等）。
- **条目 11 键白名单**（`voiceprint/service.py::_REGISTRY_META_KEYS`，`_persist_enrollment` 落盘键集的元数据投影）：
  `speaker_id / name / remark / scene_tag / embedding_dim / created_at / duration_ms / duration_sec / snr / speech_ratio / segments_used`。
  缺键类型化缺省：字符串空串、`duration_ms` 0、可选质量键（`snr/speech_ratio/duration_sec/segments_used`）`None`——对齐 enroll 按需写入语义（VAD 降级路径不写 snr/speech_ratio）。
- **embedding 键绝不在列**（§5 红线）；`embedding_dim` 是标量维度非向量。外层需求 `audio_path`（注册音频位置）归外层私有语义（`backend/routers/speakers.py::_save_enroll_audio`），内核不持有、本端点不提供。
- **分页裁定: 无分页、全量返回**。生产注册库为十级小集合（人手注册的真实说话人），全量响应体积由标量键封顶；外层 `sync_from_kernel` 镜像语义本就要求一次拿全，分页徒增镜像幂等复杂度。若未来库增长到需要分页，走 additive query 参数（缺省=全量向后兼容）。
- **排序裁定: 确定性双重排序**——主键 `created_at` 倒序（对齐 `speakers` 摘要端点既有语义），同刻并列按次键 `speaker_id` 升序（稳定 tie-break）。镜像幂等与外层 diff 观测要求重复响应逐字节稳定，注册库 dict 的插入序不作为契约承诺。
- **错误路径**: 注册库文件缺失 = 200 空清单（`_read_registry_file` 既有语义）；JSON 损坏/格式非法 → **503 `state.unavailable`**（fail-closed，`_load_registry` 既有语义复用，零新码）。
- **鉴权**: 沿用 `create_app` 全局 Bearer + Origin 中间件（§2），路由零特判。
- **caps additive**: kinds 追加 `voiceprint.registry`（sync, GET），组尾 `voiceprint.cohort_metrics` 之后；`kws.encode` 恒末尾约定不动（§13.1）。
- **实现指针**: `voiceprint.py::voiceprint_registry`（路由）· `audio/voiceprint/service.py::registry_facts` + `_REGISTRY_META_KEYS`（零算法，纯元数据序列化）。
- **测试指针**: `test_voiceprint_registry.py`（空库/字段集全集/无向量递归扫描/旧条目缺省/排序稳定与幂等/401/403/损坏 503/caps additive/enroll 闭环/speakers 摘要零变化回归锁）。

---

## 8. 产物通道

**实现指针**: `artifacts.py`（ArtifactStore + 路由）。
**测试指针**: `test_artifacts.py`（上传/取回逐字节一致/作业引用/尺寸上限/原子性/DELETE 幂等/鉴权/启动清扫/caps `artifacts.delete` 登记）。

| 项 | 契约 |
|----|------|
| `PUT /v1/artifacts[?name=]` | 接收**原始字节流**（替代把 base64 塞进作业 input）；`name` 可选 ≤255；返回 `{id,name,size_bytes,created_at}` |
| `GET /v1/artifacts/{id}` | 元数据 + `content_b64`（与上传逐字节一致）；缺失 → 404 `input.not_found`；meta/bin 不一致 → 503 `state.unavailable` |
| `DELETE /v1/artifacts/{id}` | **P3-K2a additive**：删除产物双文件 `<id>.bin` + `<id>.meta.json`（缺一也删另一、按存在即删）；**不存在/二次删除 → 200 幂等成功**（§8.1）；返回 `{id, deleted}`（`deleted` = 本次是否真删掉了文件）；非法 id → 400 `input.invalid`；unlink 失败（权限/IO）→ 503 `state.unavailable`（retryable）。**响应不携带内容面**（无 `content_b64`/元数据复刻，只回两键） |
| 落盘 | `{state-dir}/artifacts/<id>.bin` + `<id>.meta.json`，双文件均**原子写**（临时文件+fsync+`os.replace`，无 `.tmp` 残留） |
| 生命周期 | **显式 DELETE 为主**（外层"消费即删"纪律，P3-K2a 提供合法 HTTP 面）+ **内核启动清扫超龄残留**（`app.py` lifespan 钩子内 `sweep_stale`：mtime 超 `stale_max_age_s`（默认 **7 天**，装配期可改 `app.state.artifacts.stale_max_age_s`）的 id 整组删除，兼清崩溃残留 `.*.tmp`；尽力而为、失败不阻断启动）。**无运行期过期、无后台清扫任务**（§8.1） |
| 尺寸上限 | `max_bytes` 默认 **64MB**（≈34 分钟 16k 单声道 16bit PCM）；**流式累计超限立即 413 `artifact.too_large`，不落任何文件**；可在装配期收紧（`app.state.artifacts.max_bytes`） |
| id | `art_<hex>` 白名单；非法 → 400 `input.invalid` |
| 作业引用 | 提交时 `input.artifact = 本通道返回的 id`；存在性由 jobs 层按文件名约定 `<id>.meta.json` 校验，**两侧共守约定、不做模块间 import** |
| 同步通道引用 | A5 inspect 各端点的 `artifact` 入参经 `audio_input.read_artifact_array` 直读 `.bin` 内容（缺失 404）；A4 `unknown.track` 经 `unknown_router._read_artifact` 同款直读 |
| 鉴权 | 走 create_app 统一 Bearer+Origin 中间件（免验仅 `GET /v1/health`） |

### 8.1 DELETE 语义裁定（P3-K2a，2026-10-08）

- **不存在 = 幂等成功（200）**，非 404。理由：外层消费方是"消费即删"的重试友好路径（取证 `backend/services/segment_channel.py::_delete_artifact`——外层现在对缺失文件先 `is_file()` 判存在再 unlink、失败只 WARNING 不阻断，即**外层语义本就是幂等**）；404 会把"已成功删除"与"从未存在/已被并发删除"两类都算作失败，逼外层写特判。删除是收敛操作，天然幂等。
- 与 `DELETE /v1/voiceprint/speakers/{id}`（缺席 → 404）的**不对称是有意的**：注册声纹是业务实体，误删需暴露；产物是瞬态传输介质，重复删除无害。
- **错误码只用 §4.2 封闭表既有项**：`input.invalid`（非法 id）、`state.unavailable`（unlink 失败，retryable=true，外层按重试处理）、401/403 `auth.failed`（中间件统一）。零新增码。
- **TTL 采最小口径**：不发明后台清扫任务；启动清扫只是 crash 残留兜底（默认 7 天，防跨进程泄漏的最后防线），主泄漏治理靠外层消费即删 + DELETE 纪律。**已知理论边界**：内核宕机 >7 天且重启时仍有 queued 作业引用超龄产物时，启动清扫可能先删其输入（该作业将按既有语义失败）——宕机 7 天的 queued 作业早已无业务时效，接受此边界，登记于此。
- **能力标记**：caps `kinds` 新增 `artifacts.delete`（§13.1 第 34 位，additive 组插在 inspect 组与 `kws.encode` 之间）；外层 V15 接线时据此做运行时校验（旧内核无此 kind → 外层不得依赖 HTTP 删除）。PUT/GET artifacts 维持不进 kinds（§15-3）。

---

## 9. KWS 编码通道

**实现指针**: `audio/kws_encode.py`。
**测试指针**: `test_kws_encode.py`（信封/鉴权/fixture 逐字节一致/封闭码/解析链）。

- `POST /v1/kws/encode`，请求体 `{keywords?, model_dir?}`（`extra=forbid`）。
- **纯编码、无状态、不落盘**：词表文件写入 / 运行时目标词刷新 / 模型失效全部留在外层（`backend/routers/wake_word.py`），内核只产出 token 行。
- 输出与外层旧实现**逐字节一致**：`x iǎo h è t óng x ué @小贺同学`（phone+ppinyin 二级切分 + ` @原文` 回显标签）。
- **kind `kws.encode`：已实现（路由见 `kws_encode.py`，`KWS_KINDS` 常量定义于此），并恒在 `caps.py` kinds 拼接末尾**（`_KWS_KINDS`，§13）。
- 信封 `schema_version="1"`（与声纹通道一致）；provenance 为编码通道专用三键 `{tokenizer: "sherpa-onnx-text2token-phone+ppinyin", model_dir, computed_at}`（**非五键**——编码非打分，无 cohort/model_hash 概念；`computed_at` 用 `isoformat()` 见 §15-9）。
- facts：成功 `{keywords[], lines[], count}`（`keywords[i]` 与 `lines[i]` 一一对应——编码为空的条目被跳过，靠 `@` 回显对齐）；空输入 → 200 空结论 `reason=missing_input`。
- 错误：sherpa 未安装 / `tokens.txt`、`en.phone` 缺失 → **503 `model.unavailable`**（retryable）；text2token 抛错 / 全部编码结果为空 → 400 `input.invalid`。
- **缺省 `model_dir` 走 §3.4 统一解析链**（A1：`resolve_model_dir("sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20")`——`AXEUH_KERNEL_MODEL_DIR` > 包内 `models/` > 下载目录；三级均未命中以包内期望路径作 503 报错载体）。外层调用显式传 `model_dir` 的行为不变；旧「缺省指向外层 `ai/data/wake_word/`」的仓库根反推已废弃。

---

## 10. 实时流 `WS /v1/stream`

**实现指针**: `stream/router.py`（认证+连接循环）、`stream/session.py`（帧协议状态机，A6 扩 segment 模式）、`stream/kws.py`（sherpa 引擎）、`stream/segmenter.py`（A6 物理切分器，逐位移植外层 `AudioStreamSegmenter`）。
**测试指针**: `test_stream_ws.py`（帧协议+认证+假 spotter 驱动+封闭码）、`test_stream_segment_mode.py`（A6 切点数学/绝对墙钟轴/WAV 头解析/wakeup 回归锁）。

### 10.1 连接认证

`ws://127.0.0.1:{port}/v1/stream?token=...`：`Origin` 非空拒绝 + `?token=` 与 REST 同一 token 恒定时间比较；失败 → accept 后回 `error auth.failed` 再 `close(1008)`（`WS_CLOSE_POLICY`）；装配缺失 → `error state.unavailable` 同样关闭。

### 10.2 帧协议（发布即固化；A6 additive 扩展字段）

| 方向 | 帧 |
|------|-----|
| → 内核 | `session.start {device_id, sample_rate[, mode, segment, t0_ms]}` · **二进制 PCM 帧（s16le）** · `session.stop` |
| ← 内核 | `wakeup.hit {keyword, confidence}` · `segment.closed {artifact, start_ms, end_ms[, seq]}` · `speaker.changed {speaker}` · `error {"error":{code,message,retryable,details?}}` |

通用行为锁定（两模式共同遵守）：

- `sample_rate` **仅接受 16000**（`stream/kws.SAMPLE_RATE`，caps `stream.session.sample_rates=[16000]` 封闭）；其余整数 → `input.unsupported_format`；缺失/类型错 → `input.invalid`；`device_id` 须为字符串。
- 协议违例（未 start 发二进制 / 未知 JSON type / 会话中重复 start / 未 start 发 stop / 非法 JSON / 奇数字节帧）→ `error input.invalid`，**会话与连接不中断**（可继续）。
- 断连未 stop 的缓冲丢弃（`segment.closed` 只在 stop/段上限/切点发出；两模式一致，不产生孤儿 artifact）。
- `speaker.changed` 由注入的 `speaker_provider` 驱动（返回值相对上次变化即回帧）；缺省无 provider 不产生该帧。

### 10.3 wakeup 模式（K4b 基线；`mode` 缺省值，A6 后逐字节不变）

- KWS 引擎不可用 → `error model.unavailable(retryable=true)`，**会话继续**（PCM 缓冲与分段照常，仅唤醒暂停）；工厂失败置位后不重试。真实引擎命中 confidence 固定 1.0（sherpa 不暴露后验），0-1 clamp 在会话层。
- 会话期 PCM 只进内存缓冲（**无每帧磁盘 IO**）；`session.stop` 或缓冲达 `max_segment_bytes`（默认 **32MB**，低于 artifacts 64MB 上限）时经 `ArtifactStore.put` 落盘（**原始 PCM 字节**）并回 `segment.closed`（无 `seq` 键）；时间轴由会话内样本计数按采样率推算（**相对 ms，跨进程即断**）。
- 常量回退（不读 config.yaml）：`chunk=8 / keywords_score=1.8 / keywords_threshold=0.25 / num_threads=1`；词表/模型路径与 `kws_encode` 同源走 §3.4 解析链；`KeywordSpotter` 进程内单锁串行，spotter 进程级惰性缓存。
- 入站 KWS 引擎异常 → `error state.unavailable`，该帧 hits 清空，会话继续。

### 10.4 segment 模式（A6 additive，D1 物理切分上移）

- `session.start` 扩展字段（全部可选，缺省 = wakeup 模式）：
  - `mode`: `"wakeup"`（默认）| `"segment"`；非字符串/未知值 → `error input.invalid`（**会话不建立、连接不中断**）。
  - `t0_ms`: 非负整数 epoch ms（时间轴锚；仅 segment 消费，wakeup 忽略无害。非法 → `input.invalid`）。缺省 = **首帧到达墙钟**（延迟到此刻定基）。
  - `segment`: 参数对象，白名单六键 `{rms_threshold(默认 5.0), frame_ms(默认 30), silence_cut_s(默认 1.5), min_chunk_s(默认 10.0), max_chunk_s(默认 120.0), pre_roll_ms}`；数值键必须为正、`frame_ms` 正整数；**`pre_roll_ms` 仅接受 0**（唤醒链概念，segment v1 显式拒非零于 error 帧）；未知键/类型错 → `input.invalid` 不建会话。
- 行为：PCM 不整段驻留，直入 `StreamSegmenter` **逐帧 int16 RMS 静音切分**（规则与外层逐位一致：`>=min_chunk_s` 且静音游程 `>=silence_cut_s` 切；`>=max_chunk_s` 硬切；flush 外不短于 min_chunk_s；奇数残余字节跨 push 保留）。到切点把该 chunk 以 **WAV（RIFF 头）封装**经 `ArtifactStore.put` 落盘（外层 `GET /v1/artifacts/{id}` 即取即用，免自加头）。
- `segment.closed {artifact, start_ms, end_ms, seq}`：`start_ms/end_ms` 为**绝对墙钟 epoch ms**（`t0_ms + 会话内累计样本偏移` 单调推轴，帧间无空洞假设；与外层逐次 `wall_ms` 打戳的差异登记 §15-15）；`seq` 自 **1** 起会话内单调（wakeup 模式不产出该键）。
- 32MB 兜底改按 `segmenter.pending_bytes` 检查，超限强制冲刷当前块、会话继续；`session.stop` 冲刷尾段。
- **segment 模式整条路径不触 sherpa/KWS**（不加载引擎、不产生 `wakeup.hit`）；`wakeup` 模式帧行为回归锁（`test_stream_segment_mode.py` 末尾用例锁定两模式分界）。
- segmenter 参数缺省逐键对齐外层 `audio.stream.*` 生产默认（无缝流 `stitch.max_chunk_s=120` 口径；WS 直播历史默认 60 由外层调用方经 `session.start.segment` 显式传入）。

---

## 11. 陌生人通道 `POST/GET /v1/unknown/*`（A4）

**实现指针**: `unknown_router.py`（六端点+请求模型）、`unknown/service.py`（编排/幂等/块级归类）、`unknown/{config,storage,segmenter,session,matcher,profile,health}.py`（外层 `unknown_speaker_*.py` L1-L4 四层逐函数移植）、`scripts/migrate_unknown_state.py`（一次性迁移）。
**测试指针**: `test_unknown_api_contract.py`（信封/鉴权/XOR/幂等）、`test_unknown_chain.py`（L1-L4 链行为）、`test_unknown_golden_parity.py`（与外层库对拍：决策四元组+库终态逐位一致）、`test_unknown_migrate_state.py`（迁移脚本）、`test_unknown_real_model_sanity.py`（真模型 sanity）。

### 11.1 端点与请求 schema（sync 通道，Bearer+Origin，信封三键，空体 200 `missing_input`）

| 方法 | 路径 | 请求 | facts |
|------|------|------|-------|
| POST | `/v1/unknown/track` | `{file_key, audio_b64 \| artifact (XOR), segments?, start_epoch_ms?, device_t?, config_override?}`（`extra=forbid`） | `{file_key, blocks[], blocks_truncated, profiles_touched[], pending_count, reason}` |
| GET | `/v1/unknown/profiles` | — | `{count, profiles:[{id,label,confirm_count,status,support_count,created_at}]}`（无向量）；**内核面已交付、外层未接线（§15-22，可选消费方 = vaudit V20 单元）** |
| POST | `/v1/unknown/profiles/{unk_id}/confirm` | `{label?}` | `{confirmed:true, unk_id, label}`；id 缺席 → **404 `input.not_found`**；**内核面已交付、外层未接线（§15-22，可选消费方 = vaudit V20 单元）** |
| POST | `/v1/unknown/profiles/{unk_id}/reject` | `{}` 可空 | `{rejected:true, unk_id}`（档案移除、审计保留溯源）；id 缺席 → 404；**内核面已交付、外层未接线（§15-22，可选消费方 = vaudit V20 单元）** |
| GET | `/v1/unknown/state` | — | `{profiles:{count,by_status}, pending:{count,max_sessions}, session:{active_tracks,total_blocks,saved_at}, scan:{processed_files}}`（计数级，无向量）；**内核面已交付、外层未接线（§15-22，可选消费方 = vaudit V20 单元）** |
| POST | `/v1/unknown/cleanup` | `{config_override?}` | `{cleaned, flushed_sessions, health_alerts, alert_kinds, reason}`（被动 TTL/上限清理+簇间融合体检+空闲轨道封存；**调度归外层**，内核无定时器） |

### 11.2 track 细则

- **`file_key` 必填**（幂等溯源键）：缺失 → **200 `missing_input`**（对齐声纹空体契约，无幂等键即拒绝处理防污染状态；不写幂等表）。
- 输入：`audio_b64` 与 `artifact` **二选一 XOR**（都有 → 400；WAV 非 mono/16bit/16kHz → 415，经 `unknown_router._wav_bytes_to_array` 同款封闭码语义）。两者都缺但有 `segments` = 合法**纯向量喂送**（跳 L1 直入 L2-L4）。
- `segments`: `[{start_ms(ge=0), end_ms(gt=0), emb?, speaker?}]`（`UnknownSegment`，`extra=forbid`；**请求方向量允许、响应方禁止**；emb 缺失/维度非法的段跳过不计）。
- `start_epoch_ms`（ge=0）: 文件起始墙钟，L2 轨道时间轴锚；缺省用内核墙钟。
- **幂等**：`file_key` 已在 `scan_state.processed` → 不再喂送 L2，回 `{blocks:[], ..., pending_count:实值, reason:"duplicate"}`；processed 表按 `computed_at` 环形截尾（上限 `_MAX_PROCESSED_KEYS=20000`）。
- facts `blocks[]` 截断 `_MAX_FACT_BLOCKS=200`；每块**八键** `{start_ms, end_ms, unk_id, kind, name, ref_sim, count, is_new}`；`kind` ∈ 封闭集 **`unknown` | `registered` | `mixed` | `env`**（判定优先级：confirmed unknown 档案 ≥ open_threshold > registered ≥ registered_sim(0.75) > mixed ≥ mixed_sim(0.30) > env 兜底；对齐外层段级 spk 富对象，本调用新开档可被同人块命中并标 `is_new=true`）。`ref_sim` round 4。
- `reason` ∈ `ok` / `no_blocks`（无有效块喂入）/ `duplicate` / `missing_input`。
- L1 模型（pyannote diar-3.1）缺失且需要自切 → **503 `model.unavailable`**（外层静默 skipped 的 503 化收敛，§15 已随对拍白名单登记）。
- provenance 五键：`model_id="pyannote/speaker-diarization-3.1"`、`model_hash="unknown-chain-v1"`、`cohort_hash` 取声纹工作集真值（与 `/v1/voiceprint/unknown` 同哈希）、`preprocessing_version="wav-16k-mono-v1"`、`computed_at` Z 格式。
- 并发：`_track_lock` 全局串行 track/cleanup 的读-算-写闭环；L1 重计算在锁外。

### 11.3 `config_override` 分节键表

请求级阈值覆盖（track/cleanup 共用）。**顶层节白名单 7 节**：`detection` / `matching` / `pyannote` / `session` / `profile` / `lifecycle` / `tagging`——非白名单顶层键（含 `enabled`/`storage`/`audio_archive`）或节值非 dict → **400 `input.invalid`** + `details.bad_keys`。节内键深合并（`_deep_merge`），值消费点按外层同款 float/int 转换。

**内置默认 = 生产 `config.yaml` `unknown_speaker` 节实际值**（逐键表与差异注释在 `unknown/config.py` `DEFAULT_UNKNOWN_CONFIG`；`test_unknown_golden_parity.py::test_builtin_defaults_match_production_config` 每次 gate 实读生产配置锁死）。相对外层代码默认的生产覆盖键：`detection.max_reg_sim 0.99`、`detection.min_duration_sec 2.5`、`detection.two_step.user_score_threshold 0.99`、`detection.two_step.user_gap_max_sec 0`、`detection.env_estimation.multi_threshold 0.25`、`session.speech_ratio_min 0.0`、`lifecycle.confirm_min_count 8`、`pyannote/session/profile.enabled` 全 True。内核补充节 `tagging`（`label_threshold 0.5` / `registered_sim 0.75` / `mixed_sim 0.30`，源生产 `audio.voiceprint.sliding/tag`）。`env_estimation` 在 L2-L4 仅作 meta 透传（`env_mode` 缺省恒 `single`，外层多说话人加严路径在 track 喂送下不激活）、`two_step` 判定属外层分析链（内核 track 不做用户区两刀切分）——**生产值下两节为死语义未移植判定**，config_override 键全集保留。

### 11.4 状态布局与迁移

```
{state-dir}/unknown/
  unknown_speakers.jsonl            档案库（centroid/support_vectors 向量仅私有落盘）
  unknown_audit.jsonl               审计日志（追加，永久；ts 行级自动补）
  unknown_pending_sessions.jsonl    L3 候选池
  unknown_session_state.json        L2 活跃轨道快照（含向量，仅私有）
  unknown_scan_state.json           已处理 file_key 幂等/溯源表
```

- 五文件与外层 `ai/data/cache/unknown_*` **同 schema 逐字段直通**；原子写（`.tmp`+fsync+`os.replace`）；JSONL 坏行 **fail-closed → 503 `state.unavailable`**；实例级 `RLock`。
- 迁移脚本：`python kernel/scripts/migrate_unknown_state.py --from <ai/data/cache> --to <state-dir> [--dry-run]`——行级校验（坏行 fail-fast 报行号）、幂等（unk_id/pending_id/track_id 已存在跳过；audit 按行内容去重追加；scan_state processed 键并集）、**只复制不删源**；脚本不 import 内核（schema 双写由 `test_unknown_migrate_state.py` 锁同源）。

---

## 12. 审计 inspect 通道 `/v1/inspect/*` + `/v1/voiceprint/space`（A5）

**实现指针**: `inspect_router.py`（四端点+请求模型）、`audio/inspect.py`（InspectService 编排）、`audio/vad_curve.py`（三引擎曲线）、`audio/asr.py::transcribe_window`、`unknown/segmenter.py::_PipelineLoader`（diar-3.1 **类级共享 pipeline 缓存**——inspect 与 unknown 链同一份权重单实例，跨实例推理类级锁串行）、`audio_input.py`（`wav_b64_to_array`/`read_artifact_array`/`wav_bytes_to_array` **三模输入共享解析层**——当前消费方为 inspect 路由；voiceprint/unknown 路由各自持有同封闭码语义的独立解码，见 §7/§11）。
**测试指针**: `test_inspect_api.py`（三端点契约/抽稀数学/窗数/截断/禁向量/空输入 200/caps 顺序）、`test_space_endpoint.py`（轴符号稳定/探针不进拟合基/退化输入）。

### 12.1 端点 schema（sync 通道，Bearer+Origin，信封三键；请求体全部 `extra=forbid`。三 inspect 端点空体 200 `missing_input`；`space` 无音频 = 只画库底图（probe=null），非 missing_input 路径）

| 方法 | 路径 | 请求 | facts |
|------|------|------|-------|
| POST | `/v1/inspect/vad_curve` | `{audio_b64\|artifact(XOR), engine, frame_ms(10..200 默认30), max_points(100..50000 默认20000)}`；缺 `engine` 或无音频 → 空结论 | `{points:[float 0..1 round4], step_ms, frames_total, decimated, duration_ms, engine, reason}` |
| POST | `/v1/inspect/asr_sliding` | `{audio_b64\|artifact, window_ms(500..60000 默认5000), hop_ms?(ge500，缺省=window_ms), max_windows(1..2000 默认200)}` | `{windows:[{start_ms,end_ms,text,emotion,event}], truncated, count_total, duration_ms, reason}` |
| POST | `/v1/inspect/diarize_blocks` | `{audio_b64\|artifact, min_seg_sec(0..30 默认0.5)}` | `{blocks:[{start_ms,end_ms,speaker,sim}], blocks_truncated, count, as_norm_on, n_cohort, reason}`（≤200；空库 blocks 照出、speaker/sim=null） |
| POST | `/v1/voiceprint/space` | `{audio_b64\|artifact, max_cohort(1..2000 默认400)}` | `{axes:["PC1","PC2"], explained:[e1,e2], cohort:[{x,y}], centroids:[{x,y,name}], probe:{x,y}\|null, n_points, reason}`；样本 <3 → 空坐标 `reason:"insufficient_samples"` |

- 引擎/模型缺失 → **503 `model.unavailable`（不回退不吞空）**：vad_curve 按 `engine ∈ {silero, pyannote, funasr}` 白名单（非法 engine → 400），`space` 仅在探针提取失败时 503（库向量恒在）、asr_sliding 查 SenseVoice、diarize_blocks 查 diar-3.1。
- **vad_curve**：三引擎 native 逐帧语音概率（silero 512 样本帧 32ms / pyannote segmentation-3.0 桶 `bucket_ms` / funasr FSMN-VAD patch ComputeScores 取 `1-sil_pdf`、10ms，固定 CPU）→ 统一按 `frame_ms` 网格最近邻重采样 → `max_points` 整数步长抽稀（`step_ms` 放大、`decimated` 置真、`frames_total`=抽稀前点数）。曲线数学逐位对照外层 `preview.py`。
- **asr_sliding**：SenseVoice 固定滑窗逐窗转写（**绕 VAD 看原始输出**），窗数学以 `preview._sliding_asr` 为权威（`while s < total-0.1`、尾窗截 total、段长 ≥0.3s 才计入）。
- **diarize_blocks**：diar-3.1 切块（≥`min_seg_sec`）→ 每块（≥0.5s）提取嵌入对注册质心 `score_all_v2` AS-Norm top1；块四键严格 `{start_ms,end_ms,speaker,sim}`。
- **space**：cohort active（尾截 `max_cohort`）+ 注册质心锚点装载，numpy SVD PCA 2D（`full_matrices=False`，中心化→`proj=Xc@Vt[:2].T`）；**轴符号确定性归一**（每主轴 Vt 行取绝对值最大分量为正，跨请求坐标系稳定）；**探针不进 PCA 拟合基**（事后投影 `(probe-mean)@Vt[:2].T`，带/不带探针底图坐标逐位一致，测试锁定）；**只回坐标，向量绝不出内核**。
- provenance：`inspect 非声纹评分端点 cohort_hash="none"`；`diarize_blocks`/`space` 涉声纹评分/库 → 真 cohort_hash。model_id 按端点：vad_curve 成功 `"builtin/vad-curve"`（空结论 `"builtin/none"`）、asr_sliding `"iic/SenseVoiceSmall"`、diarize_blocks `"pyannote/speaker-diarization-3.1"`、space `"iic/speech_eres2netv2_sv_zh-cn_16k-common"`。
- 装配注入口：`create_app(inspect_diarizer=...)`（A5 唯一 inspect 注入参数；曲线/ASR 路径测试经 monkeypatch `audio.vad_curve.engine_available`/`audio.asr.transcribe_window` 驱动，无独立注入参数）。

### 12.2 D2 豁免条款（明文）

> **`inspect.vad_curve` 的 `points` 数组是 §5「facts 绝不大数组」通则的登记豁免**（D2 决策=a）：逐帧语音概率曲线**即审计台交付物本身**（概率非向量，不受向量红线约束），仅供审计台消费。豁免边界纪律：`max_points` 硬上限 **50000**（请求级 clamp，`ge=100`）+ 超出即整数步长**抽稀**（`decimated`/`step_ms` 如实回报），任何响应不携带原生分辨率全量。除此之外本通道其余 facts 全守通则。

---

## 13. 能力自描述 `GET /v1/capabilities`

**实现指针**: `caps.py`（`_VOICEPRINT_KINDS`/`_UNKNOWN_KINDS`/`_AUDIO_JOB_KINDS`/`_STREAM_KINDS`/`_INSPECT_KINDS`/`_ARTIFACT_KINDS`（P3-K2a）/`_KWS_KINDS`；模型条目 `_voiceprint_model_entry`/`_scene_model_entry`/`_unknown_diar_model_entry`/`_fsmn_vad_model_entry` 请求时按解析链动态计算）。
**测试指针**: `test_job_voiceprint_kind.py` · `test_job_audio_kinds.py` · `test_job_residual_kinds.py`（A1 三 kind + models=10 断言 + `kws.encode` 恒末尾） · `test_stream_ws.py` · `test_caps_voiceprint_model.py` · `test_kws_encode.py` · `test_error_codes.py`（error_codes 恰 12） · `test_unknown_api_contract.py`（A4 六 kind） · `test_inspect_api.py::test_caps_inspect_kinds_order_and_tail`（A5 顺序回归锁） · `test_artifacts.py`（P3-K2a `artifacts.delete` 登记 + 末尾约定回归）。

顶层形状（发布即固化）：

```json
{
  "api_version": "1.0.0",
  "kinds":  [ /* _VOICEPRINT_KINDS(10) + _UNKNOWN_KINDS(6) + _JOB_KINDS(8) + _STREAM_KINDS(1) + _INSPECT_KINDS(8) + _ARTIFACT_KINDS(1) + _KWS_KINDS(1) —— 共 35 */ ],
  "models": [ /* 10 条目（含 4 个动态计算） */ ],
  "limits": {},
  "error_codes": [ /* 12 个封闭码，字典序 sorted */ ]
}
```

### 13.1 kinds 实际清单（与文档表格 diff 核对基准；实测=本文，逐字序锁定）

| # | kind | transport | method/path |
|---|------|-----------|-------------|
| 1 | `voiceprint.enroll` | sync | POST `/v1/voiceprint/enroll` |
| 2 | `voiceprint.identify` | sync | POST `/v1/voiceprint/identify` |
| 3 | `voiceprint.verify` | sync | POST `/v1/voiceprint/verify` |
| 4 | `voiceprint.speakers` | sync | GET `/v1/voiceprint/speakers` |
| 5 | `voiceprint.cohort` | sync | GET `/v1/voiceprint/cohort` |
| 6 | `voiceprint.unknown` | sync | GET `/v1/voiceprint/unknown` |
| 7 | `voiceprint.score` | sync | POST `/v1/voiceprint/score` |
| 8 | `voiceprint.delete` | sync | DELETE `/v1/voiceprint/speakers/{id}` |
| 9 | `voiceprint.cohort_metrics` | sync | GET `/v1/voiceprint/cohort/metrics` |
| 10 | `voiceprint.registry` | sync | GET `/v1/voiceprint/registry` |
| 11 | `unknown.track` | sync | POST `/v1/unknown/track` |
| 12 | `unknown.profiles` | sync | GET `/v1/unknown/profiles` |
| 13 | `unknown.profile_confirm` | sync | POST `/v1/unknown/profiles/{id}/confirm` |
| 14 | `unknown.profile_reject` | sync | POST `/v1/unknown/profiles/{id}/reject` |
| 15 | `unknown.state` | sync | GET `/v1/unknown/state` |
| 16 | `unknown.cleanup` | sync | POST `/v1/unknown/cleanup` |
| 17 | `analyze.vad` | async | POST `/v1/jobs` |
| 18 | `analyze.asr` | async | POST `/v1/jobs` |
| 19 | `analyze.scene` | async | POST `/v1/jobs` |
| 20 | `analyze.aed` | async | POST `/v1/jobs` |
| 21 | `analyze.emotion` | async | POST `/v1/jobs` |
| 22 | `analyze.breath` | async | POST `/v1/jobs` |
| 23 | `analyze.diarize` | async | POST `/v1/jobs` |
| 24 | `analyze.voiceprint` | async | POST `/v1/jobs` |
| 25 | `stream.session` | stream | WS `/v1/stream` |
| 26 | `inspect.vad_curve` | sync | POST `/v1/inspect/vad_curve` |
| 27 | `inspect.asr_sliding` | sync | POST `/v1/inspect/asr_sliding` |
| 28 | `inspect.diarize_blocks` | sync | POST `/v1/inspect/diarize_blocks` |
| 29 | `voiceprint.space` | sync | POST `/v1/voiceprint/space` |
| 30 | `voiceprint.cohort_reload` | sync | POST `/v1/voiceprint/cohort/reload` |
| 31 | `voiceprint.cohort_compact` | sync | POST `/v1/voiceprint/cohort/compact` |
| 32 | `voiceprint.cohort_stats` | sync | GET `/v1/voiceprint/cohort/stats` |
| 33 | `voiceprint.cohort_audit` | sync | GET `/v1/voiceprint/cohort/audit` |
| 34 | `artifacts.delete` | sync | DELETE `/v1/artifacts/{id}` |
| 35 | `kws.encode` | sync | POST `/v1/kws/encode` |

> kinds 顺序 = `_VOICEPRINT_KINDS + _UNKNOWN_KINDS + _JOB_KINDS + _STREAM_KINDS + _INSPECT_KINDS + _ARTIFACT_KINDS + _KWS_KINDS`（**`kws.encode` 恒末尾**为 `caps.py`/`kws_encode.py` 注释约定；A4 unknown 组插在 voiceprint 后、A5 inspect 组插在 stream 后、P3-K2a artifact 组插在 inspect 组后 kws 前——既有 kind 相对顺序历波零变动，`test_caps_inspect_kinds_order_and_tail` 锁尾部，`test_job_residual_kinds.py` 锁 `kinds[-1]=="kws.encode"`）。
> **不进 kinds 的辅助端点**：`/v1/health`、`/v1/ready`、`/v1/capabilities` 自身、`PUT/GET /v1/artifacts`（偏差 §15-3；P3-K2a 起产物通道仅 `DELETE` 以 `artifacts.delete` 进 kinds——外层 V15 运行时校验所需的能力标记，§8.1）。

**一次性核对命令**（拉实际响应与上表 diff；TestClient 不绑端口）：

```bash
cd <repo> && python - <<'PY'
import sys; sys.path.insert(0, 'kernel')
from fastapi.testclient import TestClient
from axeuh_kernel.app import create_app
r = TestClient(create_app('t')).get('/v1/capabilities', headers={'Authorization': 'Bearer t'}).json()
kinds = [k['kind'] for k in r['kinds']]
expect = ['voiceprint.enroll','voiceprint.identify','voiceprint.verify','voiceprint.speakers',
          'voiceprint.cohort','voiceprint.unknown','voiceprint.score','voiceprint.delete',
          'voiceprint.cohort_metrics','voiceprint.registry',
          'unknown.track','unknown.profiles','unknown.profile_confirm','unknown.profile_reject',
          'unknown.state','unknown.cleanup',
          'analyze.vad','analyze.asr','analyze.scene','analyze.aed','analyze.emotion',
          'analyze.breath','analyze.diarize','analyze.voiceprint','stream.session',
          'inspect.vad_curve','inspect.asr_sliding','inspect.diarize_blocks','voiceprint.space',
          'voiceprint.cohort_reload','voiceprint.cohort_compact','voiceprint.cohort_stats',
          'voiceprint.cohort_audit','artifacts.delete','kws.encode']
assert kinds == expect, kinds  # 契约: 35 kind, kws.encode 恒在末尾
assert len(r['models']) == 10, len(r['models'])
assert r['error_codes'] == sorted(r['error_codes']) and len(r['error_codes']) == 12
assert r['limits'] == {} and r['api_version'] == '1.0.0'
print('caps OK:', len(kinds), 'kinds /', len(r['models']), 'models')
PY
```

### 13.2 models 实际清单（请求时动态计算；本表按 HEAD 环境实测快照）

| # | model_id | task | bundled | 备注（实现指针） |
|---|----------|------|---------|------|
| 1 | `iic/speech_eres2netv2_sv_zh-cn_16k-common` | speaker_embedding | True（按权重目录落地动态） | `service.MODEL_ID`；`dim=192`/`preprocessing_version`/`loading=lazy`/`checkpoint` 路径（§3.4 解析链） |
| 2 | `pyannote/segmentation-3.0` | vad | False | gated 仓库需 HF token（skipif） |
| 3 | `silero/vad` | vad_fallback | True | skipif silero_vad 包缺失 |
| 4 | `iic/SenseVoiceSmall` | asr | False | skipif funasr/ModelScope 缓存缺失（`ASR_MODEL_ID`） |
| 5 | `panns/Cnn14_16k` | sound_scene | 动态（A1 解析链三级命中即 True） | `SCENE_MODEL_ID`；`checkpoint` 随附；**判定永不联网** |
| 6 | `iic/emotion2vec_plus_base` | emotion | False | **A1 新增**；ModelScope 系统缓存，skipif |
| 7 | `builtin/mfcc-hierarchical-clustering` | speaker_diarization | True | 纯算法无外部权重（`loading=none`） |
| 8 | `builtin/spectral-breath-detector` | breath_detection | True | **A1 新增**；纯频谱 DSP（skipif librosa，`loading=none`） |
| 9 | `pyannote/speaker-diarization-3.1` | speaker_diarization_l1 | 动态（**A4 新增**，本地缓存 snapshot 存在即 True） | `unknown/segmenter.DIAR_MODEL_ID`；gated（skipif） |
| 10 | `iic/speech_fsmn_vad_zh-cn-16k-common-pytorch` | vad_fsmn_curve | 动态（**A5 新增**，ModelScope 缓存计算） | `vad_curve.FSMN_MODEL_ID`（skipif funasr/缓存缺失） |

**`bundled`/`skipif` 标志语义**：模型/token 缺失由 skipif 兜底（测试 `pytest.mark.skipif` 跳过而非 fail gate）——**模型缺失绝不阻断能力自描述/内核启动**。A1 起 eres2netv2/Cnn14/diar-3.1/fsmn-vad 四条目按 §3.4 解析链**请求时动态计算**，自动下载许可不影响 caps 判定。

---

## 14. 兼容策略（compat）与演进

**权威来源**: 设计 §4.7 兼容条款（代码未推翻，作为契约承诺固化）；实现锚点 `caps.py`（自描述）+ `errors.py`（封闭枚举）+ `__init__.py`（api_version）。

- `capabilities` 自描述 per-kind 元数据；外层/fork 拿它做运行时校验与 SDK 生成，也是版本协商依据（外层启动拉取，**major 不匹配即失败退出**）。
- **minor 只允许 additive**（新增 kind/字段/端点）；破坏性变更走 **major + `Sunset` 头弃用窗口**。
- **永不可变**：错误码语义 / 认证机制 / ID 语义 / 时间格式 / 数值单位。
- 错误码集合恰好 12、WS 帧协议、信封三键、`outer` 恒空、握手行键集、`MAX_WAIT_SECONDS=30`、`Retry-After: 5` 均为「发布即固化」项。

### 14.1 演进记录（Wave A1-A6，全 additive；`api_version` 保持 `"1.0.0"`）

| 日期 | 波次（提交） | 增量 | 零破坏核对 |
|------|--------------|------|-----------|
| 2026-09-24 | A1 `38c9e61c` | kinds +3（`analyze.aed/emotion/breath`，16→19）；models +emotion2vec/+breath（6→8，Cnn14 动态化）；§3.4 权重三级解析链上线，scene/kws/stream 断外层路径，旧 `AXEUH_SCENE_*` 废弃 | 旧 kind facts 逐键不变；错误码/信封/帧协议/握手零变化 |
| 2026-09-24 | A2 `962640ce` | `voiceprint.score` 可选 `sliding`/`collect`(+`collect_meta`) 参数与 facts 六键 additive；无新参请求 facts 键集逐字节不变（回归锁测试） | 空体 missing_input 不变；kinds/models 计数不变 |
| 2026-09-24 | A3 `24d8e512` | enroll 质量链（body 可选 `thresholds`；facts additive `quality_report`，`segments_used` 语义升级；拒绝走既有 400 `input.invalid`+details）；`create_app` 注入口 `voiceprint_vad` | 旧 facts 键零变化；不发明新错误码 |
| 2026-09-24 | A4 `b1309839` | kinds +6（`unknown.*`，19→25）；models +diar-3.1（8→9）；`/v1/unknown/*` 六端点（§11）；state 布局 +`unknown/`；`GET /v1/voiceprint/unknown` 接真库（count/items 向后兼容，source 值变化 §15-18）；迁移脚本 | 既有 kinds/models 相对顺序零变动 |
| 2026-09-24 | A5 `0436ae3f` | kinds +4（`inspect.*` 三条 + `voiceprint.space`，25→29）；models +fsmn-vad（9→10）；inspect 通道（§12）+ D2 豁免登记；`audio_input.py` 三模共享层；diar-3.1 类级共享缓存 | kws.encode 恒末尾不动；既有端点零变化 |
| 2026-09-24 | A6 `9601f3c7` | kinds +4（`voiceprint.cohort_{reload,compact,stats,audit}`，29→**33**）；`analyze.asr` options `weak_split`（默认关逐字节回归）；WS `session.start` 扩展 `{mode,segment,t0_ms}` + `segment.closed` additive `seq` + segment 模式（§10.4，wakeup 模式零变化）；cohort 管理四端点（§7.2） | 帧类型集合不新增（复用 segment.closed 加键）；错误码/信封/认证不变 |
| 2026-10-08 | P2-K1a | kinds +1（`voiceprint.registry`，33→**34**）；`GET /v1/voiceprint/registry` 注册库全量元数据快照（§7.6，为消外层 W1 野生直读而生，外层接线在 V10） | 既有 kind 相对顺序零变动（组尾追加、`kws.encode` 恒末尾）；既有端点响应逐键不变（`test_voiceprint_registry.py` 含 speakers 摘要回归锁）；错误码/信封/认证不变 |

**终值**：caps **kinds 35 / models 10 / error_codes 12 / limits {}**；错误码、信封、WS 帧类型集、握手行键集、认证机制、时间纪律（§5，含 §15-9/§15-16 登记项）**全部零破坏**（§13.1 一次性核对命令实证）。测试基线 `kernel/tests` **379 passed + 3 skipped**（A6 gate 实测；P2-K1a 在其上 +14 用例，见 `test_voiceprint_registry.py`）。

---

## 15. 事实与设计偏差（以代码为准）

> 以下为对照 `docs/kernel-design.md` §4/§5 与历轮实现逐条核实的差异；**设计总纲保持只读、不修改**，一切以本文与代码为准。1-12 为 K 波存量条目（按 HEAD 事实刷新表述），13-19 为 A1-A6 回填新增，20-22 为 2026-10-08 消费漂移回写（P1-V16，取证 `docs/archive/audit/2026-10-08/raw/02-kernel-contract.md` D13/D5/D6-D10），23 为 2026-10-08 P2-K1a 契约缺口补齐登记（同取证 W1），24 为 2026-10-08 P3-K2a 契约缺口补齐登记（同取证 W2）。

| # | 设计条目 | 设计说法 | 实际实现（指针） |
|---|----------|----------|------------------|
| 1 | §4.1 通道总览表 | 5 行：协商/作业/声纹/实时流/产物 | **实装 9 组路由**：additive 追加 `POST /v1/kws/encode`（K4d）、`/v1/unknown/*` 陌生人通道（A4）、`/v1/inspect/*` + space 审计通道（A5）（设计 §3.1 曾列 text2token 归内核但 §4.1 表未入行） |
| 2 | §4.2 capabilities | 「**每个 kind 的 input/output JSON Schema 自描述**」 | kinds 仅含 `method/path/input` **文字简述**（作业 kind 的 input 是一句说明，非 JSON Schema）；`limits` 恒 `{}`（`caps.py`） |
| 3 | §4.1/§4.2 kinds 覆盖 | 协商、产物等均属通道 | caps `kinds` 只列 **35 个**（10 voiceprint + 6 unknown + 8 job + 1 stream + 3 inspect + space + 4 cohort 管理 + `artifacts.delete`（P3-K2a 起）+ `kws.encode`；P2-K1a 起 voiceprint 组含 `voiceprint.registry`）；**不列** health/ready/capabilities 自身与 `PUT/GET /v1/artifacts` 等辅助端点（`caps.py`；产物通道仅 DELETE 作能力标记进 kinds，§8.1） |
| 4 | §4.3 响应示例 | `"schema_version": 1`（数字） | **字符串 `"1"`**（`voiceprint.SCHEMA_VERSION`；契约测试要求非空字符串，见 `test_voiceprint_api_contract.py`） |
| 5 | §4.3 | 「`GET` 只返回 `kernel`；`outer` 由外层落盘时自己拼」 | GET 返回**完整作业记录**；结果在 `result.kernel`，且 `result.outer` **恒为空对象**随记录落盘（`jobs/api._run_job` payload）——语义等价：outer 内核永不填内容 |
| 6 | §4.4 声纹通道 | 6 端点（3 POST + 3 GET） | **voiceprint 路由 14 端点**：K2 additive 追加 `score`/`DELETE speakers/{id}`/`cohort/metrics`，A6 再追加 cohort 管理四端点 `cohort/{reload,compact,stats,audit}`，P2-K1a 追加 `GET registry`（§7.6）（`voiceprint.py`，均符合 minor-additive）；另 `/v1/voiceprint/space` 归 inspect 路由（§12） |
| 7 | §4.6 启动握手 | `--token <走环境变量,禁止命令行>` | 实现**无 `--token` 参数**，仅 env `AXEUH_KERNEL_TOKEN`（比设计更严格：连占位参数都不留）；`--config` 阶段 0 不消费内容 |
| 8 | §4.7 错误 retryable | 只冻结「未知码 retryable=false」 | 实现附加**语义表** `_RETRYABLE_CODES={kernel.busy,job.interrupted,model.unavailable,state.unavailable}` 为 true（`errors.py`）；`version.mismatch`/`job.interrupted` 为封闭保留码，当前无端点直接产出 |
| 9 | §4.7 时间格式 | UTC RFC3339 `Z` 结尾 | 主体一致（`%Y-%m-%dT%H:%M:%SZ`）；**响应层唯一例外 `kws_encode._provenance.computed_at` 用 `isoformat()`**（`+00:00` 后缀、含微秒）——仍是 UTC 无本地偏移，但格式与其余不一致；**以代码为准记录**，收敛留待后续 additive 修复。**既有条目，A1-A6 未触碰，保持** |
| 10 | §4.2/§4.6 | 内核无业务信息泄露 | 一致：`/v1/health` 只回 `{"status":"ok"}`；`/v1/ready` 恒 `{"status":"ready"}`（阶段 0 无待加载模型；就绪探针同样受 Origin 校验保护） |
| 11 | §5 voice schema | 业务级 voice 条目字段（t/device_name/audio 等）「内核/外层」分栏 | 当前该条目由**外层** `analyze_audio_file` 链路组装落盘；内核 `analyze.*` kind 不产 §5 条目，只产 §7 信封（`outer={}` 载体已就位） |
| 12 | §9.5 风险「后端 → 助手宿主无认证」 | 分发前必须解决（外层面） | 本轮已接线（assistant host authentication：客户端全请求带 Basic 头），调研证据与残余缺口见认证提交的提交信息 |
| 13 | A6 计划「weak_split 双入口」 | A6 提交信息称 vad_processor 段域版「作第二入口段域函数+对拍锁定」 | **按代码事实：内核只移植了 wake_word_service 版**（`audio/weak_split.py` 仅 `weak_split` + `pcm_to_wav_bytes`，模块 docstring 载明「按任务定稿只移植 wake 版」）；vad 版以 docstring 内**不同源差异表**登记（域/低谷搜索/约束/low_energy_win_ms/退化五轴），**函数体未落码**、`analyze.vad` 无 weak_split 选项、`test_weak_split_parity.py` 只锁 wake 版 vs 外层 wake 版。数值权威 = wake 版（与任务定稿一致） |
| 14 | A6 asr weak_split 实现细节 | — | 子段以 `pcm_to_wav_bytes` 包成临时 WAV 落 `{state-dir}/jobs/asr_ws_<b0>_<b1>_<rand4hex>.wav`，transcribe 后 finally 即删（不改 transcribe 契约的最小侵入）；段边界 `start/end` round 2、`word_ts` 子段 ms 平移全局轴（`handlers._analyze_asr_weak`） |
| 15 | A6/外层 WS 段时间轴 | 外层无缝流按**逐次 push 到达墙钟**打 `wall_ms` 戳 | 内核 segment 模式 `start_ms/end_ms` = `t0_ms`（缺省首帧到达墙钟）**+ 会话内样本计数单调推算**（帧间无空洞假设）；断连空洞不重对齐。同名绝对墙钟轴、时间源不同构，消费侧（外层无缝流 vs 内核 artifact 直取）按各自语义使用（`stream/session.py` docstring） |
| 16 | §5 时间纪律 vs unknown 内部状态 | 响应时间戳 Z 结尾秒级 | HTTP 响应层守纪（`unknown/service.provenance` 走 `utc_now_z`）；但 unknown **内部状态文件**（`session_state.saved_at`、档案/pending 的 `first_seen/last_seen`、matcher 时钟）用 **naive UTC `isoformat()`**、`storage.append_audit` 行 `ts` 用 aware isoformat（`+00:00` 含微秒）——对照外层为本地 naive，内核统一 naive UTC 使状态自洽；不出响应故不破 §5 面约，登记备查（`unknown/{session,matcher,profile,storage}.py`） |
| 17 | A6 cohort/reload 语义 | 外层 reload 清内存缓存再重读 | 内核 `load_cohort` **本就每请求读盘、无内存工作集缓存**，端点收敛为幂等「显式重读+计数回显」（`reloaded` 恒 true），管理面板操作语义保留（`service.cohort_reload_facts`） |
| 18 | A4 前 `GET /v1/voiceprint/unknown` | K1 恒空骨架 | 骨架 `facts={count:0, source:"none", items:[], note:...}`；A4 接入真库后 `source:"unknown_db"` 且 **note 键消失**、items 为档案摘要六键。`count/items` 两键向后兼容；`source/note` 属漂移面（路由仅在 `app.state.unknown` 未装配时才回退旧骨架，生产/测试默认装配恒走真库，`voiceprint.py::voiceprint_unknown`） |
| 19 | §9 旧文 tokenizer 字符串 | 本文旧版记载 `"sherpa-onnx-text2token+ppinyin"` | **代码事实为 `"sherpa-onnx-text2token-phone+ppinyin"`**（`kws_encode.TOKENIZER_ID`，K4d 初始提交 `307a43e1` 起如此——旧文脱字），本轮按码改正，非行为变更 |
| 20 | §6.4/§13.1 `analyze.emotion` 消费漂移（2026-10-08 登记） | 契约列 8 个 analyze.* kind、caps 恒 33 kinds | **外层已于 2026-10-07 停用该 kind 的消费**：emotion2vec_plus_base 权重 decoder miss、输出恒空且零消费方（取证 `backend/services/kernel_job_client.py` RESIDUAL_KINDS 已剔除，提交 `e194366e`「内核退 CPU + 整体移除 analyze.emotion」；死链清理 P0-U7 `4710030e`）。内核 handlers/caps/§13.1 清单**冻结保留、零变化**（合法 additive 面，fork 与三方对拍不受影响）——本条登记的是**消费方漂移**，非实现事实漂移；§6.4 两处 emotion 行已加括注（审计 D13） |
| 21 | §6.1/§6.3 interrupted 恢复归属（2026-10-08 裁定） | 「外层据 `GET /v1/jobs?state=interrupted` 重新提交」「列表是外层重启恢复在途任务的唯一途径」 | **裁定：恢复语义由外层 requeue 队列（`audio_analysis_queue`/pipeline 降级重投）唯一承担**。原客户端 `resubmit_interrupted`/`list_jobs` 恢复路径从未接入 lifespan、属死件，已随 P0-U6 删除（提交 `0dfaa732`）；内核 `interrupted` 作业不再被收割重投，`GET /v1/jobs?state=interrupted` **降级为仅供运维观测**（僵尸作业记录观测面，审计 D5）；§6.1 重启 reload 与 §6.3 列表表述已同步改注 |
| 22 | §11.1 陌生人管理四端点外层消费（2026-10-08 登记） | A4（提交 `b1309839`）交付 profiles/confirm/reject/state 完整管理链 | 外层仅接线 `track` + `cleanup`；`GET /v1/unknown/profiles`、`POST /v1/unknown/profiles/{id}/confirm`、`POST /v1/unknown/profiles/{id}/reject`、`GET /v1/unknown/state` 四端点**内核面已交付、外层零消费方**——「建档后无人确认」，档案生命周期停在内核半程（审计 D6-D10）。属外层消费欠账而非内核缺陷；可选消费方 = vaudit 陌生人确认 UI 接线（计划 V20 单元，P2-V10 链条后实施）；§11.1 对应四行已加括注 |
| 23 | W1 野生直读注册库的契约缺口（2026-10-08 登记，P2-K1a） | 设计 §4.1 声纹通道只列 6 端点、无「全量注册库快照」；state-dir 是内核私有状态（§3.3） | 外层 K4c 双写经 `kernel_voiceprint_registry_path` 跨进程直读 `{state}/voiceprints/voiceprints.json`（审计 raw/02 W1），文件面把 embedding 向量复刻进外层镜像、绕开 §5 红线——**契约缺口倒逼的野生通道**。**已补 `GET /v1/voiceprint/registry`**（§7.6，additive，kinds 33→34）提供合法 HTTP 元数据面；**外层接线改走端点 + v4 镜像退役 = 计划 V10 单元**（本单元只动 kernel/，backend/ 野生通道暂存原样）。注：`/voices` 面板的 `centroids/centroid_info` 派生块与 `audio_path` 属外层镜像文件自产字段，非内核数据，V10 退役镜像时由 V10 一并裁定去向；内核 `space` 端点（§12）投影所需质心恒在内核内构建，不外带 |

---

*本文随 `kernel/` 代码演进更新；改动契约必须先改代码与测试，再回填本文（事实先行）。*
