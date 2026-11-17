# API Endpoints

> Source of truth is code: `backend/routers/` declares the routes, `backend/main.py` supplies the
> `include_router` prefixes and the page routes. Interactive API docs are disabled in production —
> `/docs`, `/redoc` and `/openapi.json` are not registered and return 404 — so this table can only be
> reconciled against code, never exported from a live schema.
>
> **Audit date 2026-11-17**: 40 files under `backend/routers/` = 39 route modules + `__init__.py`;
> **153 route declarations** (GET 75 · POST 73 · PUT 1 · DELETE 2 · WebSocket 2), plus the page/app
> routes defined directly in `backend/main.py`.

Reproduce the counts and the raw list:

```bash
# 39 route modules, 153 route declarations
ls backend/routers/*.py | grep -v __init__ | wc -l
grep -rhoE '@[a-z_]+\.(get|post|put|delete|patch|websocket)\(' backend/routers/*.py | wc -l

# per-module prefixes and the mount prefixes they are combined with
grep -n 'APIRouter(prefix' backend/routers/*.py
grep -n 'app.include_router' backend/main.py

# raw list (one-line decorators only: 144 of the 153; the rest are WebSocket,
# draft_router and one multi-line decorator in model_config.py)
grep -rhoE '@router\.(get|post|put|delete|patch)\("[^"]*"' backend/routers/*.py | wc -l
```

## Authentication model

- Every HTTP route goes through `AuthMiddleware` (`backend/middleware/auth_middleware.py`).
  **There is no localhost bypass** — all requests need a token.
- Tokens carry a `kind`: `user` (login), `service` (long-lived service token) or `device`
  (issued by P2P pairing, bound to a `device_id`). See `backend/auth.py`.
- Public paths are matched **exactly** (`PUBLIC_PATHS`): `/`, `/favicon.ico`, `/health`, `/login`,
  `/auth/setup-status`, `/auth/setup`, `/mobile`, `/mobile/`, `/vaudit`, `/vaudit/`, `/preview`,
  `/preview/`, `/docs`, `/openapi.json`, `/redoc`, `/api/p2p/enroll`.
- `OPTIONAL_AUTH_PATHS` only injects identity when a token is present; the route then decides
  (bootstrap may proceed without one).
- Query credentials (`?ticket=` / `?token=`) are honoured **only** on allowlisted prefixes:
  `/api/mimo/audio/`, `/api/vaudit/`, `/api/preview/`, `/api/mobile/files`, `/api/ota/download`,
  `/api/clients/desktop/download`, `/api/pc-sensor/download`, `/api/screen/events/stream`.
  `/api/ota/download` and `/api/clients/desktop/download` additionally require a *download* ticket;
  the other prefixes accept a *generic* ticket. Matching is by **prefix**, so every path under
  `/api/vaudit/`, `/api/preview/` and `/api/mobile/files` accepts a query credential, not just the
  audio rows marked below.
- `/api/mimo/audio/*` is exempt from the middleware and validates its own HMAC signature + short TTL.
- WebSocket and `EventSource` cannot send headers, so clients exchange a Bearer token for a one-time
  ticket at `POST /auth/ws-ticket` (30 s, generic scope; `POST /api/ota/ticket` issues a 60 s
  download-scope ticket) and then pass `?ticket=`.
- Until onboarding is complete, `OnboardingGateMiddleware` answers 503 `onboarding_required` for
  everything outside the onboarding/config/OTA/client paths.
- Middleware order (outermost first): CORS → SecurityHeaders → OnboardingGate → P2PDisabledGuard →
  Auth → GZip → routes. `P2PDisabledGuardMiddleware` turns every `/api/p2p/*` request into 404
  *before* auth runs, so a disabled group does not leak its existence through a 401.

Auth column codes:

| Code | Meaning |
| --- | --- |
| `public` | No credential required (exact `PUBLIC_PATHS` match) |
| `bearer` | Any valid token (user / service / device) |
| `bearer:user` | User token only; service and device tokens get 403 |
| `bearer+pwd` | User token **plus** password re-check (`current_password` in the body or `X-Config-Password` header); in bootstrap mode an `X-Setup-Token` header replaces both |
| `optional` | Middleware injects identity if present; the route decides (bootstrap passes without a token) |
| `bearer+query` | Additionally accepts `?ticket=` / `?token=` as described above |
| `signed` | HMAC-signed short-TTL URL, no token |
| `ws` | WebSocket handshake: `?ticket=` first, then `?token=` or `Authorization: Bearer`, verified inside the endpoint |

## `auth_api.py` — 6 routes

| Method | Path | Purpose | Auth | Notes |
| --- | --- | --- | --- | --- |
| POST | `/login` | Exchange username/password for a bearer token | public | Failure rate-limited |
| POST | `/auth/verify-password` | Read-only password check for the onboarding entry gate; never returns a token | bearer:user | 5 failures / 60 s |
| GET | `/auth/setup-status` | Whether first-run setup is needed | public | Called before login |
| POST | `/auth/setup` | Create the first user and return a token | public | Only effective while no user exists |
| POST | `/auth/change-credentials` | Change the current user's username/password | bearer | A password change revokes old user tokens and returns a new one; a rename keeps tokens valid |
| POST | `/auth/ws-ticket` | Issue a one-time ticket for WS / EventSource / `<audio>` | bearer | `{"ticket", "expires_in"}`, 30 s, generic scope |

## `health.py` — 2 routes

| Method | Path | Purpose | Auth | Notes |
| --- | --- | --- | --- | --- |
| POST | `/api/health/sync` | Phone uploads health data | bearer | Written into per-user health shards |
| GET | `/api/health/query` | Read one day of health data | bearer | Reads the authenticated user's shard only (H6/A5 isolation) |

## `health_cloud.py` — 6 routes

| Method | Path | Purpose | Auth | Notes |
| --- | --- | --- | --- | --- |
| GET | `/api/health/cloud/status` | Xiaomi Health Cloud status | bearer | `?probe=true` forces a network probe; default is cache-only |
| POST | `/api/health/cloud/enable` | Enable/disable Health Cloud without starting the pull thread | bearer | Body `{enabled}` |
| POST | `/api/health/cloud/qr` | Request a one-time login QR code | bearer | Returned as base64; never logged |
| POST | `/api/health/cloud/qr/poll` | Poll that QR login once | bearer | Body `{lp}`; first pull starts after success |
| POST | `/api/health/cloud/sync` | Pull once, or backfill `{days}` | bearer | 502 on upstream failure |
| POST | `/api/health/cloud/latest` | Latest cloud samples in a window | bearer | `{window_hours}` 1–720, default 48 |

## `perception.py` — 2 routes

| Method | Path | Purpose | Auth | Notes |
| --- | --- | --- | --- | --- |
| POST | `/api/screen/stt/perception-event` | Standalone perception event upload (GPS, system state, notifications) | bearer | `type="notify"` payloads are sanitized before append |
| POST | `/api/screen/stt/voice-session-multipart` | Voice session multipart upload | bearer | The App's only upload path; segments join a per-`device_id` seamless stream. The JSON variant was retired |

## `pc.py` — 1 route

| Method | Path | Purpose | Auth | Notes |
| --- | --- | --- | --- | --- |
| POST | `/api/pc/sync` | PC sensor state sync (idle / locked / foreground window) | bearer | Appended to `perception.jsonl` as `_source=pc_sensor` |

## `model_config.py` — 3 routes

| Method | Path | Purpose | Auth | Notes |
| --- | --- | --- | --- | --- |
| GET | `/api/screen/model` | Provider/model catalogue plus the current selection | bearer | Catalogue comes from the active channel |
| GET | `/api/screen/model/context-window` | Context window of the active web-channel model | bearer | Any failure still returns 200 with `contextWindow: null` |
| POST | `/api/screen/model` | Set the default provider/model | bearer | Writes the model-config file (`config.MODEL_CONFIG_PATH`). Runtime backend selection (`ai_backend`) is a separate key and is only writable through `/api/system/config` |

## `session.py` — 9 routes (mounted under `/api/screen`)

| Method | Path | Purpose | Auth | Notes |
| --- | --- | --- | --- | --- |
| POST | `/api/screen/session/switch` | Switch the active session | bearer | Optional `backend` (opencode/loom/dsh) and `title` |
| POST | `/api/screen/session/update-title` | Update a session title | bearer | |
| POST | `/api/screen/session/create` | Create a new session | bearer | Returns the authoritative session for the resolved channel |
| POST | `/api/screen/session/message` | Send a message through the active web channel | bearer | Optional body `backend` routes a single request to an explicit channel; `X-Device-Id` / `X-Client-Type` refresh the TTS return channel |
| GET | `/api/screen/session/list` | List sessions | bearer | Aggregates opencode ∪ loom ∪ local history ∪ (dsh mode) the single bridge session; keys `sessions`, `local_sessions`, `opencode_sessions`, `loom_sessions`, `current_session`, `partial`. Always 200; failing legs are listed in `partial` |
| GET | `/api/screen/session/{session_id}/messages` | Message history (paginated) | bearer | `limit` default 50, `before` cursor, optional `backend` |
| GET | `/api/screen/session/{session_id}/children` | Sub-sessions / sub-agents | bearer | dsh and the offline Loom log do not support children; the response flags `children_unsupported` |
| POST | `/api/screen/session/{session_id}/summarize` | Trigger context compaction | bearer | Delegates to the active channel |
| GET | `/api/screen/session/chatlog` | Conversation log for a time range | bearer | `start`, `end`, `session_id`, `include_children`, `format=json\|text`, optional `backend`. Default follows `ai_backend`; `loom` reads the offline session log (Loom need not be running); `dsh` only accepts the bridge-bound session id and returns 409 otherwise; 400 on unparsable or inverted range |

## `web_backend.py` — 2 routes (mounted under `/api/screen`)

| Method | Path | Purpose | Auth | Notes |
| --- | --- | --- | --- | --- |
| GET | `/api/screen/backend` | Read-only mirror of the current AI backend | bearer | `{"ok": true, "backend", "options": ["opencode", "loom", "dsh"]}`, read straight from `config.yaml` `ai_backend` |
| POST | `/api/screen/backend` | **Retired — always 410** | bearer | `{"ok": false, "error": ...}`. Switch backends via `/api/system/config`; `ai_backend` in `config.yaml` is the only source of truth |

## `tts.py` — 2 routes (mounted under `/api/screen`)

| Method | Path | Purpose | Auth | Notes |
| --- | --- | --- | --- | --- |
| POST | `/api/screen/tts/speak` | Synthesize and play server-side | bearer | Directed to the device that last sent a message; falls back to `tts.fallback_client_types`, silently dropped when no target is connected |
| POST | `/api/screen/tts/synthesize` | Synthesize only | bearer | Returns Base64 WAV for Web Audio playback |

## `speakers.py` — 5 routes

| Method | Path | Purpose | Auth | Notes |
| --- | --- | --- | --- | --- |
| POST | `/api/screen/speakers/enroll` | Enroll a voiceprint | bearer | Forwarded to the kernel registry (the only source of truth) |
| GET | `/api/screen/speakers` | List enrolled voiceprints | bearer | Read from the kernel registry |
| GET | `/api/screen/speakers/{speaker_id}/audio` | Enrolled audio file | bearer | File lives in the backend `DATA_DIR/voice/` |
| DELETE | `/api/screen/speakers/{speaker_id}` | Delete a voiceprint | bearer | Missing id returns 404 |
| POST | `/api/screen/speakers/identify` | Identify the speaker in an upload | bearer | Scoring happens in the kernel |

## `wake_word.py` — 2 routes

| Method | Path | Purpose | Auth | Notes |
| --- | --- | --- | --- | --- |
| POST | `/api/screen/wake_word/encode` | Encode Chinese wake words into KWS tokens | bearer | Encodes through the kernel, persists nothing |
| POST | `/api/screen/wake_word/keywords` | Encode, overwrite the keyword file, refresh runtime targets | bearer | The kernel spotter caches at process level, so kernel-side detection needs a kernel restart to pick up a new list |

## `events.py` — 1 route (mounted under `/api/screen`)

| Method | Path | Purpose | Auth | Notes |
| --- | --- | --- | --- | --- |
| GET | `/api/screen/events/stream` | SSE event stream | bearer+query | Multiplexes the opencode and loom hubs; each data frame carries `properties.backend` |

## `maintenance.py` — 1 route

| Method | Path | Purpose | Auth | Notes |
| --- | --- | --- | --- | --- |
| POST | `/api/screen/restart` | Restart the backend | bearer | Returns immediately; the process hands over to launcher/systemd. On Windows it refuses (409) when the kernel cannot be stopped first |

## `admin.py` — 3 routes

| Method | Path | Purpose | Auth | Notes |
| --- | --- | --- | --- | --- |
| POST | `/api/admin/cohort/reload` | Hot-reload the cohort pool | bearer | Forwards to the kernel |
| POST | `/api/admin/cohort/compact` | Manually compact the cohort pool | bearer | Forwards to the kernel |
| GET | `/api/admin/cohort/stats` | Cohort statistics | bearer | Forwards to the kernel |

## `notifications.py` — 3 routes

| Method | Path | Purpose | Auth | Notes |
| --- | --- | --- | --- | --- |
| POST | `/api/notification/send` | Push a notification to the user's phone | bearer | Written to an in-memory history (cap 100/user) and pushed over `/ws` best-effort with a 2 s timeout |
| GET | `/api/notification/history` | Notification history | bearer | Paginated, newest first |
| DELETE | `/api/notification/history/{notification_id}` | Delete one history entry | bearer | Must be a real `DELETE` (the old `POST`-only helper returned 405) |

## `plan.py` — 3 routes (mounted under `/api`)

| Method | Path | Purpose | Auth | Notes |
| --- | --- | --- | --- | --- |
| GET | `/api/plan/long-tasks` | List long-running tasks | bearer | Static route, declared before the date routes |
| GET | `/api/plan/{date}/effective` | Master plan merged with the day overlay | bearer | Read-only, declared before the catch-all |
| GET | `/api/plan/{date:path}` | Day plan, overlay contract and due long tasks | bearer | Read-only; catch-all accepts nested paths. A missing plan file returns `plan: null` (not 404), a missing `coverage.yaml` returns `coverage: null` |

## `reminders.py` — 2 routes

| Method | Path | Purpose | Auth | Notes |
| --- | --- | --- | --- | --- |
| GET | `/api/reminders` | Read the reminder board | bearer | Per-user |
| POST | `/api/reminders` | Overwrite the whole board | bearer | Read-modify-write loop's final step |

## `mobile.py` — 6 routes (mounted under `/api/mobile`)

| Method | Path | Purpose | Auth | Notes |
| --- | --- | --- | --- | --- |
| GET | `/api/mobile/files` | List a directory | bearer+query | `path`, `scope=data\|root`; path traversal is rejected |
| GET | `/api/mobile/files/content` | Read a text file | bearer+query | Same safe resolution |
| GET | `/api/mobile/files/raw` | Raw bytes with a proper MIME type | bearer+query | Audio/image preview |
| POST | `/api/mobile/upload` | Upload a file into the user's directory | bearer | Returns absolute and AI-root-relative paths plus size |
| GET | `/api/mobile/reports` | List AI markdown reports | bearer | `tag`, `date_from`, `date_to`, `family=health\|daily\|weekly\|review`; adds `total`, `counts`, `families`; unknown family returns 400 |
| GET | `/api/mobile/dashboard` | Aggregated dashboard data | bearer | `?date=YYYY-MM-DD`, computed on the fly for the authenticated user |

## `mimo.py` — 1 route (mounted under `/api`)

| Method | Path | Purpose | Auth | Notes |
| --- | --- | --- | --- | --- |
| GET | `/api/mimo/audio/{filename}` | Fetch a MiMo audio file | signed | Short-TTL HMAC URL (`exp`/`sig`); the external MiMo service cannot carry a token |

## `preview.py` — 6 routes

| Method | Path | Purpose | Auth | Notes |
| --- | --- | --- | --- | --- |
| GET | `/api/preview/days` | Days that have `perception.jsonl` | bearer | Newest first |
| GET | `/api/preview/timeline` | Status timeline of the day's audio chunks | bearer | |
| GET | `/api/preview/file` | Processing chain of one chunk | bearer | All algorithms run in the kernel |
| GET | `/api/preview/audio` | Cropped MP3 preview | bearer+query | `start`/`end`; ranges over 60 s are allowed |
| GET | `/api/preview/sliding` | Sliding-window audit | bearer | Raw and AS-Norm scores per window |
| GET | `/api/preview/space` | 2-D voiceprint projection | bearer | Cohort backdrop, enrolled centroids, optional probe |

## `phi4_api.py` — 5 routes (mounted under `/api/preview`)

| Method | Path | Purpose | Auth | Notes |
| --- | --- | --- | --- | --- |
| GET | `/api/preview/phi4/files` | Today's audio chunks as `{file, t0, dur}` | bearer | |
| POST | `/api/preview/phi4/start` | Spawn the Phi-4 service asynchronously | bearer | Poll `/phi4/status` for readiness |
| GET | `/api/preview/phi4/status` | Non-blocking service status | bearer | `ready` / `loading` / `down`; never spawns |
| POST | `/api/preview/phi4/run` | Crop `[start, end]` and run inference | bearer | Returns text and timing |
| GET | `/api/preview/phi4/audio` | Cropped 16 kHz mono WAV | bearer+query | Audition clip |

## `voiceprint_audit.py` — 14 routes (prefix `/api/vaudit`)

| Method | Path | Purpose | Auth | Notes |
| --- | --- | --- | --- | --- |
| GET | `/api/vaudit/days` | Days with perception data plus voice-segment counts | bearer | Newest first |
| GET | `/api/vaudit/day/{date}` | Compact voice-segment list for a day | bearer | Does not expand `segs` |
| GET | `/api/vaudit/day/{date}/audio/{filename}` | Original audio stream | bearer+query | Supports Range/seek |
| GET | `/api/vaudit/cohort/metrics` | Live cohort quality parameters | bearer | Impurity distribution, in-pool similarity, AS-Norm reference |
| GET | `/api/vaudit/cohort` | Cohort list | bearer | `source=active\|audit`, read from the kernel state dir |
| GET | `/api/vaudit/audio/crop` | Generic MP3 crop | bearer+query | Same handler as `/cohort/audio` |
| GET | `/api/vaudit/cohort/audio` | Cohort entry audition | bearer+query | Aliased to the same crop handler |
| GET | `/api/vaudit/unknown` | Unknown-speaker cluster audit | bearer | `source=all\|legacy\|current` |
| GET | `/api/vaudit/unknown/{unk_id}/audio` | Audition an unknown sample | bearer+query | Auto-cropped to that speaker's window |
| GET | `/api/vaudit/unknown/{unk_id}/sample/{idx}` | Audition sample `idx` of a cluster | bearer+query | Matches `samples[].idx` |
| GET | `/api/vaudit/unknown/{unk_id}/archive/{wav_name}` | Read an archived session wav | bearer+query | New-pipeline archive directory |
| GET | `/api/vaudit/voices` | Enrolled voiceprint overview | bearer | Metadata snapshot from the kernel registry; vectors are never exposed |
| GET | `/api/vaudit/voice/{speaker_id}/audio` | Enrolled voiceprint audio | bearer+query | |
| POST | `/api/vaudit/crop` | Crop test for a day/file | bearer | Delegates to the same implementation as the GET route |

## `ota.py` — 3 routes

| Method | Path | Purpose | Auth | Notes |
| --- | --- | --- | --- | --- |
| POST | `/api/ota/ticket` | Issue a one-time APK download ticket | bearer | 60 s, download scope; 404 when no APK exists |
| GET | `/api/ota/download` | Download the latest APK | bearer+query | Accepts a Bearer token, `?token=` or a download `?ticket=` |
| GET | `/api/ota/info` | OTA server info | bearer | Version, size, hashes |

## `pc_sensor_download.py` — 2 routes

| Method | Path | Purpose | Auth | Notes |
| --- | --- | --- | --- | --- |
| GET | `/api/pc-sensor/info` | PC sensor executable info | bearer | Size, mtime, sha256 |
| GET | `/api/pc-sensor/download` | Download the PC sensor executable | bearer+query | Browser `<a download>` uses a **generic** ticket |

## `clients.py` — 2 routes

| Method | Path | Purpose | Auth | Notes |
| --- | --- | --- | --- | --- |
| GET | `/api/system/onboarding/clients` | Android/Windows client download catalogue | optional | Readable during bootstrap |
| GET | `/api/clients/desktop/download` | Desktop installer download | bearer+query | Requires a **download** ticket for `?ticket=` |

## `sources.py` — 1 route (mounted under `/api`)

| Method | Path | Purpose | Auth | Notes |
| --- | --- | --- | --- | --- |
| GET | `/api/sources/health` | Six-source health snapshot | bearer | Contract: [api-sources-health.md](api-sources-health.md). Errors use `{"detail": ...}`, not the project envelope |

## `services_status.py` — 3 routes (mounted under `/api`)

| Method | Path | Purpose | Auth | Notes |
| --- | --- | --- | --- | --- |
| GET | `/api/services` | Orchestrator switch plus every managed service state | bearer:user | `Cache-Control: no-store`; fields are whitelisted, `detail` is sanitized |
| POST | `/api/services/{service_id}/pause` | Stop a service and forbid auto-restart | bearer:user | State becomes `blocked/manually_paused`; 409 when the orchestrator is off; 404 for unknown ids |
| POST | `/api/services/{service_id}/resume` | Lift the pause and re-evaluate | bearer:user | Only runtime state changes, no config write |

## `system_config.py` — 12 routes

| Method | Path | Purpose | Auth | Notes |
| --- | --- | --- | --- | --- |
| GET | `/api/system/config` | Config snapshot | optional | Masked; includes revision, provider, warnings, pending flags |
| GET | `/api/system/config/schema` | Field schema | optional | |
| GET | `/api/system/config/status` | Revision/degradation status | optional | |
| POST | `/api/system/config/validate` | Validate changes without writing | optional | 422 `validation_failed` with per-field errors |
| PUT | `/api/system/config` | Hot-apply config changes | bearer+pwd | `revision` is the CAS precondition; secrets are never echoed |
| POST | `/api/system/config/restart` | Deployment-wiring escape hatch | bearer+pwd | Always 409 `deployment_required` with the restart command; live config is already hot-applied |
| POST | `/api/config/draft` | Stage changes into the draft layer | bearer+pwd | |
| GET | `/api/config/pending` | Read staged changes | bearer+pwd | Password via `X-Config-Password` |
| GET | `/api/config` | Read-only alias of `/api/system/config` | bearer | Same payload shape. Unlike `/api/system/config*`, the draft layer is **not** in `OPTIONAL_AUTH_PATHS`, so the middleware always requires a token here (route-level auth still allows bootstrap placement) |
| POST | `/api/config/discard` | Drop the draft | bearer+pwd | |
| POST | `/api/config/apply` | Apply staged paths | bearer+pwd | Returns `applied`/`failed`/`deferred_restart`/`partial` |
| POST | `/api/config/apply/retry` | Re-run only the failed staged items | bearer+pwd | Applied items were already cleared from the draft |

## `system_onboarding.py` — 10 routes (prefix `/api/system/onboarding`)

| Method | Path | Purpose | Auth | Notes |
| --- | --- | --- | --- | --- |
| GET | `/api/system/onboarding/preflight` | Read-only preflight report | optional | Headless-compatible, not a visible v4 step |
| GET | `/api/system/onboarding/status` | Onboarding state, 11 steps, bootstrap flag, degraded reasons | optional | Only anonymous while setup is required; otherwise a user token is needed. `step_data` is stripped in bootstrap |
| POST | `/api/system/onboarding/state` | Record a step as completed/skipped | optional | Bootstrap: setup token; otherwise user token (`service`/`device` → 403). `dry_run` supported |
| POST | `/api/system/onboarding/action` | Run `copy_ai_template` or `generate_self_signed_cert` | optional | Setup token, or user token + current password |
| GET | `/api/system/onboarding/assets` | Release manifest plus local kernel/dependency status | bearer | Needs a user token (not in `OPTIONAL_AUTH_PATHS`; the wizard has already created the account by this step) |
| POST | `/api/system/onboarding/assets/download` | Start a frontend/kernel download job | bearer+pwd | |
| GET | `/api/system/onboarding/models` | Kernel model inventory and local presence | bearer | |
| POST | `/api/system/onboarding/models/download` | Start a model download by ids or tiers | bearer+pwd | |
| GET | `/api/system/onboarding/jobs/{job_id}` | Download job status and progress | bearer | |
| POST | `/api/system/onboarding/jobs/{job_id}/cancel` | Cancel a download job | bearer+pwd | |

## `onboarding_startup.py` — 4 routes

| Method | Path | Purpose | Auth | Notes |
| --- | --- | --- | --- | --- |
| GET | `/api/system/onboarding/startup` | Startup report and lifecycle | optional | Headless-compatible, not a visible v4 step |
| POST | `/api/system/onboarding/startup/attempt` | Start the validation-mode service plane | optional | User token + password; 409 outside bootstrap |
| POST | `/api/system/onboarding/startup/validate` | Run read-only startup probes | optional | Read auth; requires a prior `/attempt` |
| POST | `/api/system/onboarding/startup/abort` | Stop the validation plane for a retry | optional | User token + password |

## `onboarding_storage.py` — 2 routes

| Method | Path | Purpose | Auth | Notes |
| --- | --- | --- | --- | --- |
| GET | `/api/system/onboarding/storage` | Data root, models root, free space, writability, warnings | bearer | |
| POST | `/api/system/onboarding/storage` | Save an absolute `models.dir` | bearer+pwd | Never creates or migrates directories, and never accepts `data.root` |

## `loom_onboarding.py` — 10 routes

| Method | Path | Purpose | Auth | Notes |
| --- | --- | --- | --- | --- |
| GET | `/api/system/onboarding/loom` | Loom address, providers and models for form prefill | bearer | Never returns tokens or API keys |
| GET | `/api/system/onboarding/loom/runtime` | Runtime mode, health, token state | bearer | Headless-compatible, hidden from the v4 wizard |
| POST | `/api/system/onboarding/loom/token/ensure` | Discover or generate the Loom token | bearer+pwd | |
| POST | `/api/system/onboarding/loom/config/ensure` | Generate or complete a managed Loom config | bearer+pwd | |
| POST | `/api/system/onboarding/loom/start` | Start Loom | bearer+pwd | |
| POST | `/api/system/onboarding/loom/stop` | Stop Loom | bearer+pwd | |
| POST | `/api/system/onboarding/loom/setup` | One-shot setup: validate, write inline provider keys (0600), start, health/catalog check, persist `ai_backend=loom` | bearer+pwd | |
| POST | `/api/system/onboarding/loom/validate` | Validate a provider/model selection | bearer+pwd | |
| POST | `/api/system/onboarding/loom/apply` | Apply a selection, optional restart | bearer+pwd | |
| POST | `/api/system/onboarding/loom/restart` | Restart Loom | bearer+pwd | |

## `moss.py` — 2 routes

| Method | Path | Purpose | Auth | Notes |
| --- | --- | --- | --- | --- |
| GET | `/api/system/onboarding/moss` | Read `moss.enabled`, `moss.base_url`, `moss.model` | bearer | |
| POST | `/api/system/onboarding/moss/config` | Save the same three keys | bearer+pwd | No service or unit management |

## `onboarding_xiaomi.py` — 4 routes

| Method | Path | Purpose | Auth | Notes |
| --- | --- | --- | --- | --- |
| GET | `/api/system/onboarding/xiaomi` | Masked Health Cloud status | bearer | Never returns `passToken` |
| POST | `/api/system/onboarding/xiaomi/config` | Enable/disable Health Cloud without starting the pull thread | bearer+pwd | |
| POST | `/api/system/onboarding/xiaomi/qr` | Request a one-time login QR code | bearer+pwd | |
| POST | `/api/system/onboarding/xiaomi/qr/poll` | Poll the QR login once (no first pull) | bearer+pwd | |

## `onboarding_qq.py` — 3 routes

| Method | Path | Purpose | Auth | Notes |
| --- | --- | --- | --- | --- |
| GET | `/api/system/onboarding/qq` | Masked QQ gateway status | bearer | Never returns tokens or token-file paths |
| POST | `/api/system/onboarding/qq/validate` | Validate fields without writing | bearer+pwd | |
| POST | `/api/system/onboarding/qq/config` | Save `qq_gateway.*` and token files | bearer+pwd | Does not start the gateway |

## `onboarding_finish.py` — 2 routes

| Method | Path | Purpose | Auth | Notes |
| --- | --- | --- | --- | --- |
| GET | `/api/system/onboarding/finish` | Read-only finish snapshot: runtime, startup, groups, activation | bearer | |
| POST | `/api/system/onboarding/finish` | Run preflight, integration checks, startup validation, promote/commit, closing | bearer+pwd | |

## `p2p.py` — 6 routes (experimental, disabled by default)

`p2p.enabled: false` (the shipped default) makes the **whole group return 404**, emitted by
`P2PDisabledGuardMiddleware` before authentication; see [p2p-data-protocol.md](p2p-data-protocol.md)
— do not enable.

| Method | Path | Purpose | Auth | Notes |
| --- | --- | --- | --- | --- |
| POST | `/api/p2p/pairing-code` | Issue an 8-digit one-time pairing code (default TTL 5 min, `p2p.pairing_code_ttl_seconds`) | bearer | 404 while the group is disabled |
| POST | `/api/p2p/enroll` | Exchange a pairing code for a device token + signal ticket | public | Rate-limited, 10/min per client IP; the code itself is the credential |
| POST | `/api/p2p/signal-ticket` | Issue a short-lived HMAC signal ticket | bearer | Device tokens must match `X-Device-Id`; user tokens may auto-enroll when allowed |
| GET | `/api/p2p/status` | `enabled`, `signal_connected`, `signal_url`, `webrtc_enabled`, `room`, `endpoints`, `device_count`, `server_id` | bearer | |
| GET | `/api/p2p/devices` | Enrolled devices of the current user | bearer | Revoked devices are flagged, not hidden |
| POST | `/api/p2p/devices/{device_id}/revoke` | Revoke a device and its device tokens | bearer | Another user's device returns 403 |

## `ws_main.py` / `audio_stream_ws.py` — 2 WebSocket routes

| Method | Path | Purpose | Auth | Notes |
| --- | --- | --- | --- | --- |
| WS | `/ws` | Main control channel (text + binary) | ws | Optional `device_id` and `client=web\|native` query params |
| WS | `/ws/audio-stream` | Audio uplink (PCM s16le) | ws | `audio_start` supports `test` (cloud KWS test, replies `kws_test_result`) and `local_hit` (device-side hit). Not verified by the middleware — the endpoint checks the ticket/token itself |

## Page / app-level routes defined in `backend/main.py`

| Method | Path | Purpose | Auth | Notes |
| --- | --- | --- | --- | --- |
| GET | `/health` | Liveness plus the active AI runtime | public | `{"status", "service", "ai_backend", "loom", "dsh", "config"}`; `degraded` when the probe for the active backend reports offline |
| GET | `/` | 307 redirect to `/mobile/` | public | |
| GET/HEAD | `/mobile`, `/mobile/`, `/mobile/{path}` | Mobile SPA shell and assets | public | Assets are matched by extension; `/dashboard` route no longer exists |
| GET/HEAD | `/vaudit`, `/vaudit/`, `/vaudit/{path}` | Voiceprint audit console | public | Route is registered, but `frontend/vaudit/` is **not in the current tree**, so these requests return 404 until the directory is restored. Data API lives at `/api/vaudit/*` |
| GET/HEAD | `/preview`, `/preview/`, `/preview/{path}` | Audio preview console | public | Same as `/vaudit`: the route exists, `frontend/preview/` is absent from the current tree, so 404. Data API lives at `/api/preview/*` |

> Note: `/docs`, `/redoc` and `/openapi.json` appear in `PUBLIC_PATHS` only so that they return 404
> instead of 401. They are not registered.

## Retired endpoints (no longer in code — expect 404)

Confirmed absent from the route inventory above, so they must not be reintroduced by documentation:

`/logout`, `/auth/check`, `/auth/revoke`, `/api/health/source`, `/api/health/dates`,
`/api/health/upload-db`, `/api/screen/tts/stop`, `/api/screen/tts/status`,
`/api/notification/poll`, `/api/ota/check`, `/api/screen/speakers/{id}` (GET),
`/api/screen/speakers/{id}/verify`, `/api/screen/stt/voice-session` (the JSON upload variant),
the eight orphan session endpoints (`for-agent`, `current`, `bind-main-task`, `abort`, `stats`,
`agent`, …), `/api/screen/tasks/*`, `/api/scripts/*`, `/api/agents/*`, `/ws/agent`, and
`POST /api/screen/backend` as a *writer* (still routed, but returns 410).

Data formats live in [DATA_FORMAT.md](DATA_FORMAT.md); the sources-health contract is
[api-sources-health.md](api-sources-health.md).
