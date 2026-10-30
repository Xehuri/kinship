# Configuration Reference

> Extracted from `README.md` (2026-10-22). The canonical key list remains `config.example.yaml`.

## Configuration Reference

The canonical key list is `config.example.yaml` (the committable template); the production `config.yaml` lives in the project root and is not tracked by git. The main sections are documented below. Most keys are optional and fall back to the shown default. Missing or partial configuration no longer blocks startup: the backend runs degraded with schema defaults, and the Loom connection settings can be completed later from the web onboarding wizard.

### Runtime carriers and apply strategy

- Carriers: YAML (default), JSON, SQLite, or environment only. `AXEUH_CONFIG_BACKEND` selects the backend; `AXEUH_CONFIG_PATH` / `AXEUH_CONFIG_SQLITE_PATH` set the location. `AXEUH_SETTINGS__<DOTTED_UPPER>` is a read-only overlay with higher priority than the stored document.
- Apply strategy: most keys are `hot`; `qq_gateway.*` and `p2p.*` (实验，当前不可用) reconnect in place; `kernel.*` respawns the audio kernel; the retired `launcher.*` rollback metadata is deployment wiring and is read-only over HTTP.
- Full contract, API, onboarding, security and rollback: [system-config-hot-reload.md](system-config-hot-reload.md).

> Ports and paths below are examples; set them for your environment. For the full nested `health`, `kernel`, `qq_gateway`, `audio`, and `unknown_speaker` structures, use `config.example.yaml` as the single source of truth. Where this file says a change requires a restart, the apply strategy in `system-config-hot-reload.md` takes precedence.

### `server` — HTTP service

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `server.host` | str | `0.0.0.0` | Listen address |
| `server.port` | int | `8768` | Single port for HTTP and HTTPS; `ssl.enabled` decides the protocol (Android app and web UI) |

### `ssl` — HTTPS certificate

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `ssl.enabled` | bool | `true` | Enable HTTPS (required by the Android app) |
| `ssl.cert` | str | `""` | Certificate file path |
| `ssl.key` | str | `""` | Private key file path |

### `ai_backend` / `loom` - Assistant host (Loom)

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `ai_backend` | str | `loom` | Assistant host selector. The public template and onboarding set `loom` |
| `loom.url` | str | `http://127.0.0.1:5100` | Loom assistant host URL |
| `loom.token` | str | `""` | Loom Bearer token. The `LOOM_TOKEN` environment variable is the fallback; Loom rejects empty tokens |
| `loom.token_file` | path | `""` | Optional env-style file containing `LOOM_TOKEN=...`; relative paths resolve from the project root. Masked in config APIs |
| `loom.credentials_file` | path | `""` | Optional Loom credentials env file used by onboarding token discovery. Masked in config APIs |
| `loom.manage_config` | bool | `false` | Legacy flag; v4 onboarding always writes the managed `ai/.loom/config.yaml` after an explicit "start and apply" action |

> Runtime mode is detected as `systemd` (unit present) > `child` (`node` plus `loom-harness/packages/server/dist/cli.js`) > `none`. v4 onboarding auto-provisions `loom.token_file`; the token is never returned by the API. The Loom model provider key is written inline as `providers[].apiKey` in the 0600 managed `ai/.loom/config.yaml`; `credentials: {provider: ${ENV_VAR}}` remains a fallback for non-onboarding installs. See [onboarding-v4-2026-10-27.md](../dev/onboarding-v4-2026-10-27.md).

> Loom is the assistant host at `127.0.0.1:5100`. In the stable production topology the backend starts Loom as a managed child; systemd `axeuh-loom` is reserved for migration and rollback. `ai_backend: loom` is the template default and is written by the onboarding `loom` step.

### `onboarding` — First-run downloads

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `onboarding.release_manifest_url` | str | `""` | Release manifest URL; empty uses the built-in `https://github.com/Xehuri/kinship/releases/latest/download/release-manifest.json` |
| `onboarding.release_base_url` | str | `""` | Base URL for manifest asset files; empty derives it from the manifest URL |
| `onboarding.frontend_autodownload` | bool | `true` | Download the prebuilt frontend when `frontend/mobile/dist` is missing; never overwrites an existing dist |
| `onboarding.kernel_release_tag` | str | `""` | Optional kernel release tag metadata |
| `onboarding.allow_model_download` | bool | `true` | Allow the onboarding model download job |
| `onboarding.model_tiers` | list | `["required", "recommended"]` | Default model tiers selected by onboarding |

### `moss` — MOSS deep-audio sidecar

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `moss.enabled` | bool | `false` | Consume MOSS deep-audio outputs; the MOSS service itself is external and is not started/stopped by the backend |
| `moss.base_url` | str | `http://127.0.0.1:8100` | External MOSS vLLM endpoint |
| `moss.model` | str | `moss-audio-4b` | Model id expected from `/v1/models` |

> v4 onboarding no longer exposes systemd unit/helper/command management. `moss.manage_units` is a legacy key and is ignored/cleared.

### `clients` — Client download catalog

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `clients.android_url` | str | `""` | Android release asset URL; empty falls back to the local APK |
| `clients.android_sha256` | str | `""` | Expected Android asset SHA-256 |
| `clients.desktop_url` | str | `""` | Windows desktop installer URL; empty falls back to `desktop/release` |
| `clients.desktop_sha256` | str | `""` | Expected desktop installer SHA-256 |
| `clients.github_release_tag` | str | `onboarding-v1.0.0` | GitHub release tag used by the client catalog page fallback; empty = `releases/latest` |
| `clients.github_release_base` | str | `https://github.com/Xehuri/kinship` | GitHub repository base for the release page fallback; empty disables that fallback |

> Client resolution order is `local` > `configured` > `manifest` > `github` > `none`. `github` only links to the release page and does not prove the asset was verified.

### `api` — Third-party keys

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `api.dashscope_key` | str | `""` | Alibaba DashScope key (optional; ASR etc.) |
| `api.mimo_key` | str | `""` | Xiaomi MiMo key (optional; audio understanding + TTS) |
| `api.baidu_map_ak` | str | `""` | Baidu Maps AK (optional; front-end reverse geocoding) |

### `health` — Multi-source health store

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `health.primary_user` | str | `""` | Primary user; this user's data is also derived into the legacy history-only `daily/{date}/health.json` view |
| `health.source_mode` | str | `exclusive` | `exclusive` = only the active source may write (others get 409); `merge` = phone and cloud shards coexist |
| `health.default_source` | str | `phone` | Default source per user (`phone` or `cloud`) |
| `health.cloud_poll_interval_min` | int | `30` | Mi Fitness cloud auto-pull period (minutes) |
| `health.cloud.enabled` | bool | `false` | Deployment default for cloud auto-pull; the runtime toggle takes precedence |
| `health.cloud.userid` / `passtoken` | str | `""` | Mi account credentials; only in the gitignored `config.yaml` |
| `health.cloud.region` | str | `cn` | Region: `cn` / `ru` / `de` / `i2` / `sg` / `us` |
| `health.cloud.initial_lookback_days` | int | `3` | First-pull lookback (days) |
| `health.cloud.overlap_days` | int | `7` | Re-read overlap per pull (days) to absorb late cloud data |

### `audio_compressor` — Audio compression archive

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `audio_compressor.enabled` | bool | `false` | Enable daily auto-compression (WAV/FLAC files older than `keep_days` are merged into a single M4A archive and the originals deleted); when off, all raw audio files are kept |
| `audio_compressor.keep_days` | int | `3` | Keep the most recent N days of raw audio (today + previous N-1 days); older ones are compressed |

### `kernel` — Audio kernel process

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `kernel.device` | str | `cpu` | Torch device for the kernel (`cpu` / `gpu` / `auto`); `gpu` falls back to CPU when CUDA is unavailable. sherpa-onnx KWS stays on CPU |
| `kernel.python` | path | `""` | Kernel interpreter (config > `AXEUH_KERNEL_PYTHON` > `/opt/kinship/.venv-kernel` > project venv > backend interpreter). The same chain is used for kernel spawn and onboarding asset checks |
| `kernel.model_dir` | path | `""` | Kernel model root; empty = the kernel's own resolution chain. Overrides `AXEUH_KERNEL_MODEL_DIR` for spawned kernels |
| `kernel.cuda_visible_devices` | str | `""` | `CUDA_VISIBLE_DEVICES` injected into the kernel spawn; empty = no injection |
| `kernel.cpu_affinity` | list/str | `[]` | CPU affinity after spawn (`[2,3,4]` or `"2-4"` / `"2,3,4"`); POSIX only |
| `kernel.nice` | int/null | `null` | Process nice value after spawn (-20..19); POSIX only |

> Kernel changes respawn the kernel through hot apply; in-flight audio jobs may be interrupted. The kernel's ML stack lives in `/opt/kinship/.venv-kernel`, not in the backend environment.

### `audio` — Audio subsystem

Loaded by `backend/services/audio_config.py` (built-in defaults + `_deep_merge`, process-cached). Hot apply invalidates the cache; `POST /api/screen/restart` is no longer required for these keys. Every key is optional; omitted keys fall back to the code defaults in `audio_config.py`, which equal the previous hard-coded values. The single intentional default change is the voiceprint sliding window (1000/750 -> **1500/750**).

`audio.store` — upload persistence (added 2026-09-23):

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `audio.store.upload_ext` | str | `wav` | Fallback extension when the backend's magic sniff cannot identify the uploaded audio as WAV or FLAC (e.g. the legacy JSON base64 path). Only `wav` / `flac` are accepted; any other value falls back to `wav`. The effective format normally follows the client's actual upload bytes (RIFF+WAVE / fLaC sniffing, Content-Type not trusted), independent of the App-side `audio_upload_format` preference |

`audio.stream` — stream splitting and analysis queue. Since Wave C5 the per-frame cut decision is executed inside the kernel (WS `mode:"segment"`); these keys are the outer-side knobs passed into the kernel session (or used by the outer mirror/degradation logic):

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `audio.stream.sample_rate` | int | `16000` | Sample rate (Hz) |
| `audio.stream.bytes_per_sample` | int | `2` | 16-bit = 2 bytes/sample |
| `audio.stream.channels` | int | `1` | Mono |
| `audio.stream.min_chunk_s` | float | `10.0` | Minimum chunk length (except flush) |
| `audio.stream.silence_cut_s` | float | `1.5` | Prefer cutting on silence |
| `audio.stream.force_cut_s` | float | `60.0` | Hard-cap forced cut (streaming/WS path; the upload seamless stream uses `stitch.max_chunk_s` instead) |
| `audio.stream.rms_threshold` | float | `5.0` | Silence RMS threshold |
| `audio.stream.frame_ms` | int | `30` | Per-frame decision window |
| `audio.stream.queue_maxsize` | int | `32` | Analysis queue cap |
| `audio.stream.max_pending_minutes` | int | `5` | Backpressure cap (minutes) |
| `audio.stream.session_max_s` | int | `300` | Backpressure cap (seconds) |
| `audio.stream.stitch_enabled` | bool | `true` | Seamless upload stream: time-continuous segments are treated as one stream and cut only at silence endpoints (no cut at file boundaries); `false` falls back to per-segment analysis |
| `audio.stream.holdback_s` | float | `90.0` | Max retention of a tail fragment (receive-idle timeout, seconds) before flushing |
| `audio.stream.min_flush_speech_ratio` | float | `0.05` | Speech-ratio floor for an emitted chunk; below it the chunk is treated as pure silence and produces no `voice` entry |
| `audio.stream.stitch.tolerance_ms` | int | `1000` | Continuity tolerance (ms): `B.start_ms <= A.end_ms + tolerance` means the same stream. Covers the App's 500 ms pre-roll overlap; beyond it the current stream is flushed and a new one starts |
| `audio.stream.stitch.max_chunk_s` | float | `120.0` | Hard cap per analysis chunk (s) to prevent unbounded accumulation (= 2 upload file periods) |
| `audio.stream.stitch.min_chunk_s` | float | `10.0` | Minimum accumulation before a silence endpoint may cut (s) |
| `audio.stream.stitch.silence_cut_s` | float | `1.5` | Silence-endpoint duration that triggers a cut (s); the cut may land in the middle of a file |
| `audio.stream.persist_perception` | bool | `false` | When `true`, streamed (wake) audio also writes `perception.jsonl`; default `false` keeps the stream isolated. Debug/rollback only, hot apply |

`audio.vad` — VAD parameters for the wake-chain trailing-silence stop. The VAD **inference itself runs in the kernel** (`POST /v1/inspect/vad_curve`, pyannote primary / Silero fallback inside the kernel). Keys still read by the backend: `threshold`, `window_s`, `step_s`, `bucket_ms` (used to size the rolling window and judge the curve returned by the kernel). The remaining keys (`engine`, `device`, `model`, `min_speech_ms`, `min_silence_ms`, `merge_gap_s`, `reject_stationary_noise`, `min_audio_ms`, `min_wav_samples`, `stationary_noise`) are historical and no longer consumed by the outer layer after the algorithm moved to the kernel.

`audio.voiceprint` — voiceprint thresholds for the outer analysis chain: sliding window (`window_ms: 1500` / `hop_ms: 750`), identity tagging (`tag`), segment rules (`segment`), AS-Norm gating (`as_norm`). Scoring, cohort collection and the enrollment quality gate execute **inside the kernel**; the kernel ships built-in defaults equal to the production cohort/enroll thresholds. `audio.voiceprint.enroll` is kept for reference (enroll quality is enforced kernel-side).

`audio.wake_word` — wake-word KWS and recording state machine (default off):

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `audio.wake_word.enabled` | bool | `false` | Master switch (fail-safe: off when unconfigured) |
| `audio.wake_word.keywords_file` | str | `ai/data/wake_word/keywords.txt` | Keyword file (one pinyin-token line per word) |
| `audio.wake_word.model_dir` | str | `ai/data/wake_word/sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20` | KWS model directory sent to the kernel with each `kws_encode` request (word-list encoding). The live wake-word detection inside the kernel's `/v1/stream` resolves its own model via the kernel chain (`AXEUH_KERNEL_MODEL_DIR` etc.), independent of this key |
| `audio.wake_word.chunk` | int | `8` | (display/compat only — kernel uses built-in chunk=8) |
| `audio.wake_word.num_threads` | int | `1` | (display/compat only — kernel built-in) |
| `audio.wake_word.keywords_score` | float | `1.8` | Keyword boosting score (calibrated 2026-09-14); the kernel's stream KWS has the same value built in |
| `audio.wake_word.keywords_threshold` | float | `0.25` | Decision threshold; the kernel's stream KWS has the same value built in |
| `audio.wake_word.pre_roll_ms` | int | `1000` | Pre-roll buffer before a hit (streaming mode; end-side mode uses `max(pre_roll_ms, sliding_window_ms)`) |
| `audio.wake_word.entry_score_cohort_ready` | float | `0.75` (production: `0.7`) | Entry-check threshold when the cohort is ready |
| `audio.wake_word.entry_score_no_cohort` | float | `0.5` (production: `0.45`) | Entry-check threshold when the cohort is not ready |
| `audio.wake_word.entry_threshold_ready` / `entry_threshold_cold` | float | alias | Alternative names accepted for the two keys above |
| `audio.wake_word.exit_threshold` | float | `0.75` | Stop condition: low voiceprint score gate |
| `audio.wake_word.exit_hold_ms` | int | `3750` | Duration the score must stay low |
| `audio.wake_word.vad_silence_ms` | int | `3000` | Stop condition: trailing VAD silence |
| `audio.wake_word.hard_limit_ms` / `max_record_ms` | int | `1800000` | 30-minute hard cap |
| `audio.wake_word.min_record_ms` | int | `2500` | Minimum recording time after the wake confirmation (counted from entering the record state) |
| `audio.wake_word.weak_split` | dict | see example | Weak splitting before ASR (`enabled` / `window_ms` / `low_energy_win_ms` / `min_seg_ms` / `max_seg_ms`) |

`audio.assistant` — legacy voice-assistant constants (default off; superseded by the wake chain).

### `tts` — TTS device routing

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `tts.enabled` | bool | `true` | Master switch; `false` degrades to the original broadcast behaviour |
| `tts.device_channel_ttl_seconds` | int | `3600` | Sliding TTL of the return channel (seconds) |
| `tts.fallback_client_types` | list | `["web"]` | Client types to broadcast to when there is no targeted device |

### `p2p` — P2P device transport (experimental, currently unavailable)

> P2P 目前处于实验阶段，不是正式功能，当前不可用。请保持 `enabled: false`，不要部署信令服务或安装 P2P 依赖；以下键仅保留为实验配置。

| Key | Default | Meaning |
|-----|---------|---------|
| `enabled` | false | 总开关；关闭时 `/api/p2p/*` 404，且不建立信令连接 |
| `server_id` | home | 本机 ID；`room` 为空时回落 |
| `room` | "" | 房间标识 |
| `signal_url` | "" | 启用时必填，信令 WebSocket URL |
| `signal_secret_env` | P2P_SIGNAL_SECRET | HMAC 密钥的环境变量名 |
| `signal_ticket_ttl_seconds` | 600 | 票据 TTL，60..900 |
| `allow_shared_token` | false | 设备 token 是否可代同用户其他设备取票 |
| `endpoints` | {} | 设备可达端点映射；示例含 `ipv6` / `frp`，值必须为 https（http 仅回环） |
| `pairing_code_ttl_seconds` | 300 | 配对码 TTL，60..900 |
| `pairing_max_attempts` | 5 | 配对尝试上限 |
| `devices_path` | backend/data/p2p/devices.json | 设备持久化路径 |
| `auto_enroll_user_devices` | true | 用户 token 首次取信令票据时自动登记未知设备；设备 token 不适用 |
| `webrtc.enabled` | false | 启用 aiortc WebRTC 数据面；需先安装 `backend/requirements-p2p.txt` |
| `webrtc.stun_servers` | `["stun:stun.l.google.com:19302"]` | 仅 STUN，TURN 不支持 |
| `webrtc.max_frame_bytes` | 16384 | DataChannel 单块上限，1024..65536 |
| `webrtc.max_message_bytes` | 8388608 | 单条音频总上限，1 MiB..64 MiB |
| `webrtc.ack_timeout_seconds` | 60 | 服务端音频装配超时，5..300 |

> 以上仅为实验配置记录。P2P 当前不可用，不要设置 `enabled: true`，不要安装 P2P 依赖或部署信令服务。
>
> `endpoints` 的键名由部署自定义（示例 `ipv6` / `frp`），值必须为 https（http 仅回环）。客户端数据面按 **IPv6 → WebRTC → frp** 顺序尝试，仅用 STUN，不做 TURN。

### `qq_gateway` — QQ gateway (optional, off by default)

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `qq_gateway.enabled` | bool | `false` | Start the gateway in the backend lifespan; off by default (enabled in this deployment) |
| `qq_gateway.mode` | str | `lifespan` | `lifespan` = run inside the backend; a standalone entry point (`python -m services.qq_gateway`) is also provided |
| `qq_gateway.account.ws_url` | str | `ws://127.0.0.1:3001` | NapCat forward WebSocket URL |
| `qq_gateway.account.ws_token_file` | path | `""` | 0600 file containing the NapCat WS token; v4 onboarding writes this file |
| `qq_gateway.account.peer_allowlist` | list | `[]` | Allowed peer IDs; keep private values out of git |
| `qq_gateway.inbound.*` | dict | private only | Inbound routing: `enabled`, `deliver`, `shadow`, `private`, `groups`, `require_at`, and related filters |
| `qq_gateway.outbound.*` | dict | private, enabled | Outbound sending and rate limits (`send_rate_per_min` 20) |
| `qq_gateway.delivery.session` | str | `main-task` | Loom session that receives inbound messages |
| `qq_gateway.mcp.host` / `port` | str/int | `127.0.0.1` / `8770` | Bearer-token MCP action surface |
| `qq_gateway.mcp.token_file` | path | `""` | 0600 file containing the MCP Bearer token; v4 onboarding generates it when needed |
| `qq_gateway.qzone.*` | dict | off | QZone read/write gates; `mode: http_sidecar` is the implemented mode |

> The QQ gateway is a separate path from the Loom chat assistant. Full nested keys and production caveats: [docs/qq-gateway.md](../dev/qq-gateway.md).

### `auth` — Authentication

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `auth.setup_require_token` | bool | `true` | Require the bootstrap token for first-run setup (anti-takeover). Credentials live in `backend/config/auth.json`, not here |

### `launcher` - Retired rollback metadata

> `launcher.py` is retired. These keys only remain for migration rollback; new deployments start with `scripts/start.sh`, `start.bat`, or `python -m core.hot_server`.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `launcher.conda_python` | str | `python` | Python interpreter path kept for the retired launcher rollback path |

### `agent` — Agents (reserved)

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `agent.default_type` | str | `explore` | Default sub-agent type (reserved; not wired into code) |
| `agent.available` | list | `[explore]` | Available agents list (reserved) |

### `data` — Data directories (relative to project root; absolute paths override)

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `data.dir` | str | `ai/data` | AI data root (perception/health stored under its `daily/`); independent from `data.root` |
| `data.root` | str | `""` | Runtime data root for `secrets/`, `run/`, `logs/` and local models. Empty = `<project root>/var`; `AXEUH_DATA_ROOT` wins over config. Put it on a data disk (Linux `/mnt/data/...`, Windows `D:\...`) |
| `data.sessions` | str | `ai/data/cache/usersessions.json` | User session list |
| `data.voiceprints` | str | `ai/data/cache/voiceprints.json` | Voiceprint data |
| `data.tasks` | str | `ai/data` | Scheduled-task data directory |
| `data.upload_dir` | str | `ai/data/uploads` | User upload directory |
| `data.ai_root` | str | `ai` | AI root: Loom workspace/config and the mobile file browser root. `AXEUH_AI_ROOT` is read by helper scripts; the backend uses this key |

### `models` — Local model storage

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `models.dir` | str | `""` | Model weight root; empty = `<data.root>/models`. `AXEUH_MODELS_DIR` wins over config. Relative paths resolve from the project root |

> The onboarding storage block (`GET/POST /api/system/onboarding/storage`) reads `data.root` plus `models.dir` and can save only an absolute `models.dir`. It never creates directories, migrates or deletes caches, and does not accept `data.root`; system-disk and unwritable targets are warnings.

### `scripts` — Custom scripts

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `scripts.dir` | str | `ai/data/tasks` | Python custom scripts directory (same as YAML tasks) |

### `ota` — OTA updates

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `ota.apk_dir` | str | `app/build/outputs/apk/debug` | APK build output directory (OTA distribution) |

### `pc_sensor` — PC sensor download

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `pc_sensor.exe_path` | str | `desktop/pc-sensor/dist/Kinship-PCSensor.exe` | Path to the Windows PC sensor executable served by the Settings page ("设备" group, PC only). The file is **not** in git (`*.exe` / `dist/` are ignored), so run `desktop/pc-sensor/build.bat` once. Also overridable via the `PC_SENSOR_EXE_PATH` environment variable. |

### `log` — Logging

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `log.level` | str | `INFO` | Log level |

### `memory` — Memory search (reserved)

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `memory.search_threshold` | float | `0.7` | Memory search similarity threshold (reserved; not wired into code) |
| `memory.search_limit` | int | `10` | Memory search result limit (reserved) |

### `voiceprint` — Speaker recognition (legacy; enrollment quality is enforced kernel-side)

> **Kernel separation note (Wave C2).** The enrollment quality gate now runs **inside the kernel** (`/v1/voiceprint/enroll`, built-in constants `ENROLL_MIN_SNR=15.0` / `ENROLL_MIN_SEG_SNR=1.0` / `ENROLL_MIN_CONSISTENCY=0.55` / `ENROLL_MIN_SPEECH_RATIO=0.5` / `ENROLL_MIN_DURATION=3.0`). The outer layer no longer reads the keys below (the `config.py` properties survive as dead accessors); they are kept in older `config.yaml` files only as harmless leftovers, and the numbers happen to equal the kernel built-ins.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `voiceprint.min_snr` | float | `15.0` | Minimum speech SNR (dB) — historical, kernel-side gate now authoritative |
| `voiceprint.min_seg_snr` | float | `1.0` | Minimum SNR per VAD segment at enrollment (dB) — historical |
| `voiceprint.min_consistency` | float | `0.55` | Inter-segment consistency filter at enrollment — historical |
| `voiceprint.min_speech_ratio` | float | `0.5` | Minimum speech ratio of the audio — historical |
| `voiceprint.min_duration` | float | `3.0` | Minimum enrollment audio duration (s) — historical |

> `voiceprint.vad_threshold` and `voiceprint.cohort_max_samples` are also **no longer read**: the VAD threshold moved to `audio.vad.threshold` (wake-chain only; the main-chain VAD runs kernel-side) and the cohort collection now executes inside the kernel with its own built-in gates.

### `unknown_speaker` — Unknown-speaker detection (advanced, off by default)

Requires `unknown_speaker.enabled: true`. See [docs/UNKNOWN_SPEAKER_FEATURE.md](../dev/UNKNOWN_SPEAKER_FEATURE.md) for the algorithm.

> **Kernel separation note (Wave A4/B2/B5/C1).** The full L1-L4 unknown-speaker chain (diarization blocks, session accumulation, profile matching, lifecycle) now runs **inside the kernel** (`/v1/unknown/track` and `/v1/unknown/*`), with its own state under the kernel state dir. The outer layer keeps only: the `enabled` business switch, `lifecycle.*` (the daily cleanup job passes the `lifecycle` section through `config_override`), and `detection.two_step.window_ms / hop_ms` (read by the preview console for display alignment). The `audio_archive.*` and `storage.*` keys are legacy paths with no live writer anymore (the chain's archives/index now live in the kernel state dir). The kernel's **built-in defaults equal the production values**, which differ from several historical defaults listed below (e.g. `detection.max_reg_sim` production `0.99`, `min_duration_sec` `2.5`, `lifecycle.confirm_min_count` `8`, `pyannote/session/profile.enabled` all `true` in the kernel defaults; see kernel `unknown/config.py` docstring for the key-by-key deltas). The table below documents the legacy outer defaults and their structure; treat it as reference for `config_override`-compatible sections, not live backend behaviour.

| Key | Default | Description |
|-----|---------|-------------|
| `unknown_speaker.enabled` | `false` | Master switch (fail-safe; off when unconfigured) |
| `unknown_speaker.detection.max_vp_score` | `0.30` | Max voiceprint match score (above = user, dropped) |
| `unknown_speaker.detection.max_reg_sim` | `0.45` | Registered-voiceprint similarity cap |
| `unknown_speaker.detection.min_tokens` | `3` | Minimum token count |
| `unknown_speaker.detection.min_duration_sec` | `1.5` | Minimum duration (s) |
| `unknown_speaker.detection.min_snr` | `0.0` | Minimum SNR |
| `unknown_speaker.detection.two_step.enabled` | `true` | Two-step split switch |
| `unknown_speaker.detection.two_step.window_ms` | `1500` | Sliding-window length (ms) |
| `unknown_speaker.detection.two_step.hop_ms` | `750` | Sliding-window hop (ms) |
| `unknown_speaker.detection.two_step.user_score_threshold` | `0.5` | User-region detection threshold |
| `unknown_speaker.detection.two_step.min_seg_sec` | `1.0` | Minimum region length (s) |
| `unknown_speaker.detection.two_step.merge_gap_sec` | `1.0` | Contiguous-region merge gap (s) |
| `unknown_speaker.detection.two_step.user_gap_max_sec` | `2.5` | User-gap merge cap (s) |
| `unknown_speaker.detection.env_estimation.enabled` | `true` | Multi-speaker environment detection switch |
| `unknown_speaker.detection.env_estimation.window_sec` | `10.0` | Sliding-window duration (s) |
| `unknown_speaker.detection.env_estimation.mid_low` | `0.3` | Mid-band lower bound |
| `unknown_speaker.detection.env_estimation.mid_high` | `0.7` | Mid-band upper bound |
| `unknown_speaker.detection.env_estimation.multi_threshold` | `0.2` | Multi-speaker threshold (mid-band ratio) |
| `unknown_speaker.matching.merge_threshold` | `0.65` | Merge threshold |
| `unknown_speaker.matching.centroid_method` | `weighted_avg` | Centroid method |
| `unknown_speaker.matching.sv_ratio_match.enabled` | `true` | Support-vector ratio match switch |
| `unknown_speaker.matching.sv_ratio_match.ratio_threshold` | `0.55` | Pairwise cosine threshold |
| `unknown_speaker.matching.sv_ratio_match.min_frac` | `0.5` | Fraction-of-pairs threshold |
| `unknown_speaker.matching.sv_ratio_match.min_vectors` | `5` | Minimum vectors to enable |
| `unknown_speaker.pyannote.enabled` | `false` | L1 pyannote segmentation switch |
| `unknown_speaker.pyannote.model` | `pyannote/speaker-diarization-3.1` | Segmentation model |
| `unknown_speaker.pyannote.min_seg_sec` | `0.5` | Minimum segment length (s) |
| `unknown_speaker.pyannote.file_merge_threshold` | `0.55` | Within-file segment merge threshold |
| `unknown_speaker.pyannote.preload_on_start` | `true` | Preload model on startup |
| `unknown_speaker.session.enabled` | `false` | L2 session layer switch |
| `unknown_speaker.session.block_min_sec` | `3.0` | Minimum block length (s) |
| `unknown_speaker.session.speech_ratio_min` | `0.50` | File minimum speech ratio |
| `unknown_speaker.session.merge_threshold` | `0.60` | Rolling-in threshold |
| `unknown_speaker.session.hard_reject` | `0.55` | Hard-reject threshold |
| `unknown_speaker.session.session_gap_sec` | `60.0` | Session-gap decision (s) |
| `unknown_speaker.session.rolling_window` | `12` | Rolling-window block count |
| `unknown_speaker.session.min_blocks_per_session` | `3` | Minimum blocks to emit a session |
| `unknown_speaker.session.cold_start_blocks` | `3` | Cold-start block count |
| `unknown_speaker.session.flush_idle_sec` | `90.0` | Track idle flush (s) |
| `unknown_speaker.session.persist_every_blocks` | `10` | Persist every N blocks |
| `unknown_speaker.profile.enabled` | `false` | L3 profile layer switch |
| `unknown_speaker.profile.open_threshold` | `0.60` | Open-profile threshold |
| `unknown_speaker.profile.open_threshold_strong` | `0.80` | Absolute high-score threshold (above merges without margin) |
| `unknown_speaker.profile.margin_min` | `0.08` | Relative salience (min top1 vs top2 gap) |
| `unknown_speaker.profile.open_min_sessions` | `3` | Minimum sessions to open a profile |
| `unknown_speaker.profile.internal_min_sim` | `0.55` | Internal minimum similarity |
| `unknown_speaker.profile.internal_confirm_sim` | `0.75` | Internal confirmation similarity |
| `unknown_speaker.profile.multi_open_min_sessions` | `5` | Sessions to open a profile in multi-speaker environments |
| `unknown_speaker.profile.pending_ttl_hours` | `24` | Pending-pool TTL (hours) |
| `unknown_speaker.profile.pending_max` | `200` | Pending-pool cap |
| `unknown_speaker.profile.pending_reverse_merge` | `0.85` | Pending-pool reverse-merge threshold |
| `unknown_speaker.lifecycle.ttl_days` | `30` | Unconfirmed profile TTL (days) |
| `unknown_speaker.lifecycle.cleanup_hour` | `3` | Daily cleanup hour |
| `unknown_speaker.lifecycle.max_unknown_count` | `200` | Unconfirmed profile cap |
| `unknown_speaker.lifecycle.confirm_min_count` | `5` | Minimum confirmations |
| `unknown_speaker.lifecycle.support_vectors_max` | `50` | Support-vector cap |
| `unknown_speaker.lifecycle.dynamic_confirm.enabled` | `true` | Dynamic-confirm switch |
| `unknown_speaker.lifecycle.dynamic_confirm.single_confirm_min_count` | `5` | Single-speaker confirm threshold |
| `unknown_speaker.lifecycle.dynamic_confirm.multi_confirm_min_count` | `8` | Multi-speaker confirm threshold |
| `unknown_speaker.audio_archive.enabled` | `true` | Sub-segment audio archive switch |
| `unknown_speaker.audio_archive.root` | `ai/data/cache/unknown_audio` | Archive root |
| `unknown_speaker.audio_archive.segment_archive` | `true` | Archive sub-segments instead of full segments |
| `unknown_speaker.audio_archive.min_duration_sec` | `1.0` | Minimum archived sub-segment length (s) |
| `unknown_speaker.storage.unknown_db` | `ai/data/cache/unknown_speakers.jsonl` | Index database |
| `unknown_speaker.storage.audit_log` | `ai/data/cache/unknown_audit.jsonl` | Audit log |
| `unknown_speaker.storage.scan_state` | `ai/data/cache/unknown_scan_state.json` | Scan state |
| `unknown_speaker.storage.pending_db` | `ai/data/cache/unknown_pending_sessions.jsonl` | Pending-session database |
| `unknown_speaker.storage.session_state` | `ai/data/cache/unknown_session_state.json` | Session state |

> A template for the main sections is in `config.example.yaml` at the project root; `unknown_speaker` is an advanced optional section (off by default) that you can add to `config.yaml` as needed.

---
