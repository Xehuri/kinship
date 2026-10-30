# API Endpoints

> Extracted from `README.md` (2026-10-22). The FastAPI app is the source of truth for the live OpenAPI surface.

## API Endpoints

| Endpoint                   | Method | Description                              |
| -------------------------- | ------ | ---------------------------------------- |
| `/health`                  | GET    | Health check                             |
| `/login`                   | POST   | Login and get token                      |
| `/auth/setup-status`       | GET    | Check whether first-run setup is needed  |
| `/auth/setup`              | POST   | First-run admin creation (only when no user exists) |
| `/auth/verify-password`    | POST   | Read-only verification of the current admin password for the onboarding entry gate; user Bearer required, 5 failures/60s rate limit; never returns a token |
| `/auth/change-credentials` | POST   | Change current user's username/password  |
| `/auth/ws-ticket`          | POST   | Issue a one-time ticket for WS / EventSource / `<audio>` URLs that cannot carry an Authorization header |
| `/api/system/onboarding/status` | GET | Read-only onboarding state, 11 v4 steps, bootstrap flag, degraded reasons; public only during bootstrap, otherwise Bearer user token required |
| `/api/system/onboarding/state` | POST | Record a v4 step as completed/skipped; `finish` gates on preflight and startup runtime |
| `/api/system/onboarding/xiaomi` | GET | Masked Xiaomi Health Cloud status; never returns passToken |
| `/api/system/onboarding/xiaomi/config` | POST | Enable or disable Health Cloud without starting the pull thread (Bearer + current password) |
| `/api/system/onboarding/xiaomi/qr` | POST | Request a one-time Xiaomi login QR code (Bearer + current password) |
| `/api/system/onboarding/xiaomi/qr/poll` | POST | Poll the Xiaomi QR login once (Bearer + current password) |
| `/api/system/onboarding/qq` | GET | Masked QQ gateway status; never returns tokens or token file paths |
| `/api/system/onboarding/qq/validate` | POST | Validate QQ gateway fields without writing (Bearer + current password) |
| `/api/system/onboarding/qq/config` | POST | Save `qq_gateway.*` and token files; does not start the gateway (Bearer + current password) |
| `/api/system/onboarding/moss` | GET | Read `moss.enabled`, `moss.base_url`, and `moss.model` |
| `/api/system/onboarding/moss/config` | POST | Save `moss.enabled`, `moss.base_url`, and `moss.model` (Bearer + current password); no service or unit management |
| `/api/system/onboarding/loom` | GET | Read Loom address, providers, and models for form prefill; never returns token or API key |
| `/api/system/onboarding/loom/setup` | POST | v4 one-shot Loom setup: validate, write inline `providers[].apiKey` config 0600, start, health/catalog check, persist `ai_backend=loom` (Bearer + current password) |
| `/api/system/onboarding/finish` | GET | Read-only finish snapshot: runtime, startup, groups, activation, closing |
| `/api/system/onboarding/finish` | POST | Run preflight, integration checks, startup validation, promote/commit, and closing (Bearer + current password) |
| `/api/system/onboarding/preflight` | GET | Headless compatibility only; not a visible v4 step. Read-only preflight for external harnesses |
| `/api/system/onboarding/startup` | GET | Headless compatibility only; not a visible v4 step. Latest startup report and lifecycle |
| `/api/system/onboarding/startup/attempt` | POST | Headless compatibility only; not a visible v4 step. Start the validation-mode service plane (Bearer + password) |
| `/api/system/onboarding/startup/validate` | POST | Headless compatibility only; not a visible v4 step. Run read-only startup probes |
| `/api/system/onboarding/startup/abort` | POST | Headless compatibility only; not a visible v4 step. Stop the validation plane for a retry (Bearer + password) |
| `/api/system/onboarding/storage` | GET | Storage snapshot: data root, models root, free space, writability, warnings |
| `/api/system/onboarding/storage` | POST | Save an absolute `models.dir` (Bearer + password; never creates or migrates directories) |
| `/api/system/onboarding/action` | POST | Run `copy_ai_template` or `generate_self_signed_cert` (setup token, or Bearer + current password) |
| `/api/system/onboarding/assets` | GET | Release manifest plus local kernel/dependency status |
| `/api/system/onboarding/assets/download` | POST | Start a frontend or kernel download job (Bearer + password) |
| `/api/system/onboarding/models` | GET | Kernel model inventory and local presence |
| `/api/system/onboarding/models/download` | POST | Start a model download job by model IDs or tiers (Bearer + password) |
| `/api/system/onboarding/jobs/{job_id}` | GET | Download job status and progress |
| `/api/system/onboarding/jobs/{job_id}/cancel` | POST | Cancel a download job (Bearer + password) |
| `/api/system/onboarding/loom/runtime` | GET | Headless compatibility only; not shown by the v4 wizard. Runtime mode, health, and token state |
| `/api/system/onboarding/loom/token/ensure` | POST | Headless compatibility only; not shown by the v4 wizard. Discover or generate the Loom token (Bearer + password) |
| `/api/system/onboarding/loom/config/ensure` | POST | Headless compatibility only; not shown by the v4 wizard. Generate or complete a managed Loom config (Bearer + password) |
| `/api/system/onboarding/loom/start` | POST | Headless compatibility only; not shown by the v4 wizard. Start Loom (Bearer + password) |
| `/api/system/onboarding/loom/stop` | POST | Headless compatibility only; not shown by the v4 wizard. Stop Loom (Bearer + password) |
| `/api/system/onboarding/loom/validate` | POST | Headless compatibility only; not shown by the v4 wizard. Validate a provider/model selection |
| `/api/system/onboarding/loom/apply` | POST | Headless compatibility only; not shown by the v4 wizard. Apply a selection; optional restart |
| `/api/system/onboarding/loom/restart` | POST | Headless compatibility only; not shown by the v4 wizard. Restart Loom |
| `/api/system/onboarding/clients` | GET | Android and Windows client download catalog |
| `/api/clients/desktop/download` | GET | Desktop installer download (`?ticket=` one-time download ticket) |
| `/api/health/sync`         | POST   | Upload health data (heart rate, steps, sleep, etc.) |
| `/api/health/query`        | GET    | Query health data                        |
| `/api/screen/stt/perception-event` | POST | Upload perception data (GPS, system state, notifications) |
| `/api/screen/stt/voice-session-multipart` | POST | Voice session multipart upload (the App's current upload path; the JSON variant was retired with 1.5.2) |
| `/api/pc/sync`             | POST   | PC sensor state sync (idle / locked / foreground window), written into `perception.jsonl` |
| `/api/screen/tts/speak`    | POST   | TTS speech synthesis (synthesized and played server-side) |
| `/api/screen/tts/synthesize` | POST | TTS synthesis only, returns Base64 WAV for Web Audio playback (no server-side play) |
| `/api/screen/model`        | GET    | Get available models and the current model/provider config |
| `/api/screen/model`        | POST   | Set the default model/provider (single source of truth) |
| `/api/screen/model/context-window` | GET | Active web-channel model context window; failure returns 200 with `contextWindow: null` |
| `/api/screen/session/*`    | *      | AI session management                    |
| `/api/screen/events/stream` | GET   | SSE event stream (proxies assistant host events from the Loom hub, fan-out via EventHub) |
| `/ws`                      | WS     | Main WebSocket connection                |
| `/ws/audio-stream`         | WS     | Audio stream uplink (PCM s16le; `audio_start` supports `test` and `local_hit`) |
| `/api/screen/speakers/*`   | *      | Speaker (voiceprint) management (enroll / list / audio / delete / identify) |
| `/api/screen/wake_word/encode` | POST | Encode Chinese wake words to sherpa-onnx KWS tokens (no persistence) |
| `/api/screen/wake_word/keywords` | POST | Encode and overwrite the keyword file, refresh the runtime target list (kernel stream-KWS needs its own keywords.txt + restart to re-resolve) |
| `/api/notification/*`      | *      | Push notification management (send / history / delete) |
| `/api/admin/cohort/*`      | *      | Voiceprint cohort ops forwarded to the kernel (reload / compact / stats) |
| `/api/ota/*`               | *      | OTA auto-update (info / download)        |
| `/api/mimo/audio/{filename}` | GET  | Fetch a MiMo audio file via a short-TTL signed URL (`exp`/`sig`, no token needed) |
| `/api/pc-sensor/info`      | GET    | PC sensor executable info (size, mtime)  |
| `/api/pc-sensor/download`   | GET    | Download the PC sensor exe (`?ticket=` one-time ticket) |
| `/api/p2p/pairing-code`    | POST   | Bearer; issue an 8-digit one-time pairing code (5 min TTL) |
| `/api/p2p/enroll`          | POST   | Public; exchange a pairing code for a device token + short-lived signal ticket |
| `/api/p2p/signal-ticket`   | POST   | Bearer; issue a short-lived HMAC signal ticket (`X-Device-Id` required for user tokens) |
| `/api/p2p/status`          | GET    | Bearer; P2P enabled/signal/endpoint/device summary, including `signal_url` and `webrtc_enabled` |
| `/api/p2p/devices`         | GET    | Bearer; enrolled devices for the current user |
| `/api/p2p/devices/{device_id}/revoke` | POST | Bearer; revoke a device and its device tokens |
| `/api/screen/restart`      | POST   | Restart the backend service              |
| `/api/mobile/reports`      | GET    | Allowlisted user reports: `family=health\|daily\|weekly\|review`, response adds `total/counts/families`; unknown family 400 |
| `/api/mobile/*`            | *      | Mobile file browser, dashboard, reports, upload |
| `/api/sources/health`      | GET    | Six-source health snapshot (contract: `docs/api-sources-health.md`) |
| `/api/preview/*`           | *      | Perception preview / audio timeline data (incl. `/api/preview/phi4/*`) |
| `/api/vaudit/*`            | *      | Voiceprint audit data (read-only)        |
| `/mobile`                  | GET    | App WebView frontend page                |
| `/vaudit`                  | GET    | Voiceprint audit platform page           |
| `/preview`                 | GET    | Audio preview console page               |

> P2P 目前处于实验阶段，不是正式功能，当前不可用。以下 `/api/p2p/*` 仅记录代码面，默认关闭且不保证行为；不要启用。
>
> `p2p.enabled=false` (default) returns 404 for the whole `/api/p2p/*` group; only `/api/p2p/enroll` is public when enabled.
>
> Full data format documentation: [docs/DATA_FORMAT.md](DATA_FORMAT.md) (Chinese)

---
