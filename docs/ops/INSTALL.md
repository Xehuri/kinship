# Installation and Setup

> Extracted from `README.md` (2026-10-22). This is the detailed install/setup manual; see [README.md](../README.md) for the entry point.

## Before You Start: What to Prepare

Work through this checklist before you begin. Items tagged **(core)** are required for the system to run; the rest enable specific features or are strongly recommended.

**Server and core AI tooling (core)**

- [ ] A machine that can run **Python 3.10+**. Windows and Linux are both tested (production runs on Linux); macOS is untested. See [Prerequisites](#prerequisites).
- [ ] The bundled **Loom** assistant host (`loom-harness/`) and a Node.js runtime. Loom is the documented default (`ai_backend: loom`); onboarding starts it and writes `ai/.loom/config.yaml`.

**Python dependencies**

- [ ] Backend dependencies: `pip install -r backend/requirements.txt` (core; contains **no ML packages**).
- [ ] Audio capabilities (ASR / voiceprint / KWS / VAD / scene / diarization) run in a **separate closed-source kernel process** (runtime `<project>/kernel`, package `axeuh_kernel`), spawned automatically by the backend. The kernel's modules lazily import an ML stack (torch / funasr / modelscope / pyannote.audio / silero-vad / sherpa-onnx) which the **Python environment must provide for the kernel** — these are kernel requirements, not backend ones (the backend itself imports zero ML). Model weights are resolved by the kernel's own directory chain and downloaded by `kernel_models`. See [Model Dependencies](#model-dependencies), [docs/kernel/EULA.md](../kernel/EULA.md), [docs/kernel/README.md](../kernel/README.md) and [docs/kernel-contract.md](../kernel-contract.md).

**AI working directory**

- [ ] A copy of the AI working directory created from `ai-template/`, with its placeholders filled in. See [AI Working Directory Setup](#ai-working-directory-setup).

**Certificate and API keys**

- [ ] An SSL certificate and private key for `ssl.cert` / `ssl.key`. Self-signed is fine for development; use a CA-issued certificate for production. See [Phase 1.4](#14-ssl-certificate-android-app-requires-this).
- [ ] A model **configured in Loom**, with `loom.url` and a token (`loom.token`, `LOOM_TOKEN`, or `loom.token_file`) in place. The default and recommended choice is **`deepseek-flash`**; any OpenAI-compatible provider works. See [Core LLM](#core-llm-required-invoked-by-loom).
- [ ] *(recommended)* A **MiMo API key** at `api.mimo_key`. Not required, but strongly recommended: the AI uses MiMo's multimodal model to analyze audio, and MiMo also powers TTS.
- [ ] *(optional)* A **Baidu Maps AK** for reverse geocoding, used by `ai/analysis/geocode_tool.py`.
- [ ] A browser to open the web UI and complete **first-run user registration** (creating the admin account). See [Phase 1.3](#13-configuration).

**Devices and apps**

- [ ] An **Android 8.0+ (API 26)** phone with 12GB+ free storage. See [Prerequisites](#prerequisites).
- [ ] A **Gadgetbridge-supported band** such as a Xiaomi Band 8 Pro / 9 Pro. See [Phase 5.1](#51-install-gadgetbridge).
- [ ] The **Gadgetbridge** app installed from F-Droid or GitHub, not Google Play. See [Phase 5.1](#51-install-gadgetbridge).

## Prerequisites

| Item      | Requirement                                                    |
| --------- | -------------------------------------------------------------- |
| Server    | Any machine running Python 3.10+ (Windows / Linux / macOS)    |
| Phone     | Android 8.0+ (API 26), 12GB+ storage recommended              |
| Band      | Xiaomi Band 8 Pro / 9 Pro (or other Gadgetbridge-supported model) |
| Core      | Loom (bundled default assistant host)                         |

## Model Dependencies

The project depends on two kinds of models: a required LLM (invoked by Loom) and the audio ML models that live **inside the closed-source kernel process** (the backend itself carries no ML code or ML dependencies).

### Core LLM (Required, invoked by Loom)

Pick a model that is **configured in Loom**. The default and recommended driver is **`deepseek-flash`**; any OpenAI-compatible provider (DeepSeek, Anthropic, OpenAI, ...) works.

| Setting | Scope | Where to change |
| ------- | ----- | --------------- |
| Main-session model | The main agent (the driver) | `ai/.loom/config.yaml` -> `models[0]` |
| Sub-agent model | Each sub-agent (data check, review, ...) | that agent's own file, e.g. `ai/agents/data-checker.md` -> `model:` |

> The Loom config only sets the **main session** model. Every sub-agent's model is set separately in its own file under `ai/agents/`; changing `ai/.loom/config.yaml` alone will not change the sub-agents. `deepseek-flash` is recommended for both.

### Audio ML Models (kernel side, NOT installed with the backend)

Since the kernel separation (Wave A–C), the backend contains **zero ML code and zero ML dependencies** — `pip install -r backend/requirements.txt` no longer pulls torch / funasr / modelscope / pyannote / sherpa-onnx. All audio computation (ASR, VAD, speaker recognition, wake-word KWS, environmental scene classification, diarization, unknown-speaker profiling) happens inside the **closed-source audio kernel** (`kernel/`, package `axeuh_kernel`), a separate process spawned by the backend on `127.0.0.1` with an ephemeral port. The kernel lazily imports its ML stack and resolves weights through its own model directory:

| Model (kernel side)                                                | Purpose                                         | Source              |
| ------------------------------------------------------------------ | ------------------------------------------------ | ------------------- |
| **SenseVoiceSmall** (`iic/SenseVoiceSmall`)                        | Multilingual ASR (Chinese/English/Japanese/Cantonese etc.) | funasr / ModelScope |
| **emotion2vec_plus_base** (`iic/emotion2vec_plus_base`)            | Speech emotion recognition, **retired** (output never consumed; removed with 1.5.2); SenseVoice's per-segment `emotion` field is kept and passed through | funasr / ModelScope |
| **PANNs Cnn14_16k**                                                | Environmental sound classification (527 AudioSet labels) | Kernel resolution chain (§3.4 of the contract; optional first download) |
| **pyannote segmentation-3.0** (`pyannote/segmentation-3.0`)        | Voice Activity Detection (pyannote primary, Silero fallback — both inside the kernel) | Kernel HuggingFace cache |
| **pyannote speaker-diarization-3.1**                               | Unknown-speaker L1 diarization                   | Kernel HuggingFace cache |
| **funasr ERes2NetV2** (`iic/speech_eres2netv2_sv_zh-cn_16k-common`) | Speaker embedding extraction (voiceprints) | ModelScope via `kernel_models` |
| **sherpa-onnx KWS zipformer (zh-en 3M)**                           | Wake-word keyword spotting (server-side detection) | Kernel model directory |

No model weights ship in the kernel asset. Every row above, including ERes2NetV2, is downloaded by the `kernel_models` onboarding step; the public 0.1.0 kernel tarball has no `models/` directory and no `.ckpt` file.

Kernel model resolution follows a three-level chain (contract §3.4): `AXEUH_KERNEL_MODEL_DIR` > package `models/` (not shipped in public 0.1.0) > download landing dir (`%LOCALAPPDATA%/axeuh-kernel/models` on Windows, `~/.cache/axeuh-kernel/models` elsewhere). Weights are **never** placed under `backend/models/` anymore (the directory is retired).

When the kernel is unreachable the backend **degrades, never falls back to local models** (there are none): the wake chain stops detecting (sessions continue, the App's 5 s timeout backs out), a seamless upload stream whose segment channel failed degrades to per-segment analysis (mirror-buffered, nothing lost, retry after a 120 s cooldown), the live WS stream flushes as a single block, voiceprint scoring is skipped, and analysis jobs are requeued. The backend still starts fine without a kernel — TTS can be swapped by implementing `backend/services/tts_player.py`. Deployment details: [docs/kernel/EULA.md](../kernel/EULA.md) and [docs/kernel-contract.md](../kernel-contract.md).

The optional voice wake word (KWS) runs entirely in the kernel; the outer layer only keeps the config switch and the keyword file. See [Voice Wake Word](#voice-wake-word-optional).

### Other

| Feature         | Dependency                    | Notes                                               |
| --------------- | ----------------------------- | --------------------------------------------------- |
| Audio understanding (multimodal) | MiMo Cloud API | Optional but recommended; the AI can send audio to MiMo's multimodal model to analyze it. Requires `api.mimo_key` |
| TTS synthesis   | MiMo Cloud API                | Not a local model, requires `api.mimo_key`          |

---

## Installation

### Public 0.1.0 Source Layout

The public `kinship` repository is the source tree for the backend, clients, Loom harness, and docs. It intentionally omits private components:

- `ai/` is absent. Create it from `ai-template/` and point `data.ai_root` at your AI root (default `<project>/ai`).
- Kernel source is absent. Source lives in the private `kinship-kernel` repository; end users install the prebuilt release asset at `<project>/kernel`. The onboarding `kernel` step verifies the release manifest SHA-256 and installs it there.
- `tools/moss-shadow/` and the CircuitJS1 runtime are absent. MOSS is private; CircuitJS1 is fetched from the separate `kinship-circuitjs` repository at dev/build time.
- `kernel_models` downloads every kernel model, including ERes2NetV2. The kernel tarball contains no `models/` directory and no `.ckpt` files.

Keep the code checkout separate from configuration and data. A typical layout is code at `/opt/kinship`, config at `/opt/kinship-data/config/config.yaml`, and runtime data at `/opt/kinship-data`. See [Staging Paths](#staging-paths) for the environment variables.

### Phase 1: Backend

#### 1.1 Clone

```bash
git clone https://github.com/Xehuri/kinship.git
cd kinship
```

#### 1.2 Python environment

Use the platform setup script. It creates `.venv`, installs the backend requirements, creates `config.yaml` from `config.example.yaml` when missing, and copies `ai-template/` to `ai/` when missing:

```bash
# Linux / macOS
./scripts/setup.sh

# Windows
setup.bat
```

The manual equivalent is:

```bash
# Create a virtual environment (conda or venv)
python -m venv .venv
# Windows: .venv\Scripts\activate
# Linux:   source .venv/bin/activate

pip install -r backend/requirements.txt
```

The requirements above are the **complete** backend install: pure web framework + audio IO libraries (numpy / soundfile / librosa). There is **no `[ml]` extra anymore** (removed with Wave C4) and no torch / funasr / modelscope / pyannote / sherpa-onnx in it — the backend runs zero ML.

The audio kernel (`<project>/kernel`) is a **separate closed-source process** — spawned by the backend with the configured kernel interpreter (`kernel.python`, then `AXEUH_KERNEL_PYTHON`, `/opt/kinship/.venv-kernel`, `<project>/.venv-kernel`, finally the backend interpreter; cwd `<project>/kernel`) — whose modules lazily import the ML stack they need (funasr / modelscope declared by the kernel; torch / pyannote.audio / silero-vad / sherpa-onnx imported at call time). So the environment must still have those packages **for the kernel to work**; the distinction is that the backend no longer imports any of them. Install and deploy the kernel per [docs/kernel/EULA.md](../kernel/EULA.md), [docs/kernel/README.md](../kernel/README.md) and [docs/kernel-contract.md](../kernel-contract.md). Notes that now belong to the **kernel** side, not the backend:

> - If you run the kernel's PyTorch stack on an RTX 50 series (Blackwell, sm_120) GPU, it must use the cu128 wheels (`pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu128`); cu124 has no sm_120 kernels. Verify with a real tensor op, not just an import.
> - The kernel's primary VAD engine is **pyannote segmentation-3.0**, a **gated** HuggingFace repo: accept its terms and provide a token at `~/.cache/huggingface/token` (or `HF_ENDPOINT=https://hf-mirror.com` for a mirror) in the kernel's environment, or pre-place the weights in the kernel model directory (`AXEUH_KERNEL_MODEL_DIR`). Inside the kernel, pyannote failures fall back to Silero; if the kernel itself is unreachable, the backend **degrades** (no wake, whole-block flush, scoring skipped, jobs requeued) — it does not fall back to any local model.

#### 1.3 Configuration

Edit `config.yaml` in the project root. These fields are required:

```yaml
ssl:
  enabled: true                      # HTTPS toggle (Android App requires HTTPS)
  cert: /path/to/your/cert.pem       # Replace with actual path
  key:  /path/to/your/key.pem        # Replace with actual path
```

The shipped template already sets the documented assistant default, `ai_backend: loom`, with `loom.url: http://127.0.0.1:5100`. Onboarding fills the Loom provider, model and token, then writes `ai/.loom/config.yaml`.

> **Keep `config.yaml` at the project root by default.** `CONFIG_PATH` and `AXEUH_CONFIG_PATH` can point at a different file, but the project root is resolved independently from the config location; relative paths in the document still resolve from the project root, not from the config file's directory. Do not assume that moving `config.yaml` moves the data root.

**First-run credential setup**: On the very first launch there is no user yet. Open the web UI (`/mobile/`) and you will be guided to the setup screen, where you choose the admin username and password (at least 6 characters). By default this step requires the one-time bootstrap token described below. Credentials are stored as a bcrypt hash in `backend/config/auth.json`, which is the single source of truth. No credentials live in `config.yaml`.

The first-run endpoint is protected by a one-time bootstrap token by default (`auth.setup_require_token: true`). The setup request must carry it via the `X-Setup-Token` header (generated on first start, printed in the backend log, and stored in `backend/config/.setup_token`; see `config.example.yaml`). Set `auth.setup_require_token: false` only for a trusted private network.

After logging in you can change your username or password at any time from the web UI (Settings -> Change credentials). Changing your **password** invalidates other sessions and devices (for example the phone App), which must log in again with the new password, while the current Web session continues seamlessly via a freshly issued token. Changing only the **username** does not invalidate any existing tokens. The Android app also caches the token in SharedPreferences; after a web password change, open the Android app and log in again so its native token cache is refreshed.

#### 1.3.1 First-Run Onboarding (Zero-Start)

A fresh install can boot without `config.yaml`, a kernel, models, MOSS, or Loom. In this bootstrap mode the backend starts only the core plane: HTTP/HTTPS, setup-token auth, onboarding APIs, and the prebuilt `/mobile/` frontend. Scheduler, audio ingest, Health Cloud, Loom probing, QQ, P2P, and the config watcher are deferred; non-onboarding routes return `503 {"code":"onboarding_required"}` until finish. P2P is experimental and currently unavailable; leave `p2p.enabled: false`.

The wizard has 11 steps:

`welcome -> account -> dependencies -> kernel -> kernel_models -> xiaomi -> qq -> moss -> loom -> clients -> finish`

- `preflight` and `startup` are no longer visible steps. `finish` owns the one-time preflight, optional integration checks, startup validation, promote/commit, and the closing screen. Hard failures return 409; soft items require `allow_degraded=true`.
- `dependencies` checks the AI workspace and asks whether to download the released kernel and model tiers. Download is recommended; declining shows the audio-pipeline warning and continues in a degraded state.
- Kernel/model download jobs first ensure `Config.AI_ROOT` exists and copy missing `ai-template` files without overwriting existing files. The active `<AI_ROOT>/.loom/config.yaml` is still written by the Loom step, not by the download step.
- `kernel` and `kernel_models` are separate steps with visible job status. Released assets come from `onboarding.release_manifest_url` (default `https://github.com/Xehuri/kinship/releases/latest/download/release-manifest.json`); the manifest pins the frontend, kernel, Android APK, and Windows installer names, sizes, and SHA-256 values. Kernel downloads require that manifest (or `onboarding.release_base_url`) to be configured explicitly; see [Kernel Distribution](#132-kernel-distribution-prebuilt-vs-local-build). The kernel job also creates `<root>/.venv-kernel` and installs torch plus the package `requirements.txt`, so a source-less host becomes runnable in one step.
- `kernel_models` downloads come from ModelScope/HuggingFace and, for `kws-zipformer`, a GitHub Release. Required models use public ModelScope repositories, including `iic/speech_eres2netv2_sv_zh-cn_16k-common` and `pyannote/wespeaker-voxceleb-resnet34-LM`; `kws-zipformer` falls back through `ghfast.top` and `gh-proxy.com`, and `cnn14` through `hf-mirror.com`. Release manifests/assets also fall back through those GitHub mirrors. If all candidates fail, prefetch into `<models_root>/.cache/...` and re-check the model status; do not mark required models present without their required files.
- The `kernel_models` step also shows the storage block. `GET /api/system/onboarding/storage` reports `data_root` and `models_root` (config keys `data.root` / `models.dir`), free space, writability, legacy caches, and system-disk warnings. `POST` saves only an absolute `models.dir` (current password required); it never creates directories, migrates or deletes caches, and does not accept `data.root`. Keep `data.root` on a data disk through `AXEUH_DATA_ROOT` or `data.root`.
- `xiaomi` is a separate pre-AI step. It can enable the Health Cloud source, show a QR code, and poll the login result. It only saves configuration and never starts the pull thread or performs a first fetch; pulling starts after finish.
- `qq` is a separate pre-AI step. It validates and saves `qq_gateway.*` plus token files under `<data.root>/secrets/`, but does not start the gateway. Tokens never appear in responses or token file paths.
- `moss` is optional and only manages `moss.enabled`, `moss.base_url` (default `http://127.0.0.1:8100`), and `moss.model` (default `moss-audio-4b`). MOSS is an external vLLM service: the wizard does not manage systemd units, run a helper or command, or start/stop the service, and the backend has no MOSS consumer.
- `loom` shows five fields: port, provider, base_url, model, and api_key. One action, "启动并应用", validates the provider, writes `<AI_ROOT>/.loom/config.yaml`, starts Loom, checks health and catalog, and persists `ai_backend=loom`. The key is stored inline as `providers[].apiKey` in a 0600 config file; responses only expose `api_key_configured`. Token discovery/generation is automatic. There is no token input or manual runtime UI. The `${ENV_VAR}` credential fallback remains for providers without an inline key.
- `clients` links to the Android APK and Windows desktop installer. Resolution is `local` > `configured` > `manifest` > `github` > `none`; the GitHub fallback only opens the release page and does not verify the asset. Debug APKs are labeled. The PC sensor collector is not part of this step.
- After admin creation, the wizard keeps the new password in memory and injects it into later write requests; individual steps no longer show a current-password input. If an existing admin opens the wizard later, the entry gate verifies the password once via `POST /auth/verify-password`. The password is never written to storage or logs, and it is cleared when the wizard closes or finish completes; reopening or reloading the wizard requires verification again.

State files are version 4. A v3 or v2 install that already reached `finish` becomes complete without re-gating; `xiaomi` and `qq` receive synthetic step data with `migrated=true` and a `v3_upgrade` or `v2_upgrade` reason. A v3 or v2 install that had not finished keeps its progress, records `xiaomi` and `qq` as skipped, and must run the real v4 finish gates. v1 state is mapped by the legacy step map before the same v4 completion rule. `preflight` and `startup` step data is moved to `legacy_step_data` with `removed_in_v4=true`. Bootstrap mode is selected automatically when no user exists or the onboarding state is incomplete. A legacy install with users and no state file always starts in full mode. The env override `AXEUH_ONBOARDING_BOOTSTRAP=1` (bootstrap) or `0` (full) applies only while the state is missing or incomplete; a completed state always starts in full mode. If `frontend/mobile/dist/index.html` is missing, the backend logs the warning and tries to download the released frontend in the background; an existing dist is never overwritten. Full v4 contract: [onboarding-v4-2026-10-27.md](../dev/onboarding-v4-2026-10-27.md).

On Windows there is no systemd: Loom uses `child` or `none`, and stopping a child uses `TerminateProcess`. `chmod(0600)` does not set NTFS ACLs, so the `secrets/loom.env` protection depends on the user-directory ACL. See [windows-parity-2026-10-26.md](../dev/windows-parity-2026-10-26.md).

#### 1.3.2 Kernel Distribution (Prebuilt vs Local Build)

The kernel source tree is not distributed. Source lives in the private `kinship-kernel` repository. Release artifacts contain the protected `axeuh_kernel` package plus `requirements.txt`, `LICENSE`, `COMMERCIAL.md`, `EULA.md`, and `BUILD_INFO.json`. They do not contain a `models/` directory or any `.ckpt` file. A development checkout is the only place that builds from source.

- **Release pipeline (maintainers).** `scripts/build-kernel-asset.sh [version] [output-dir] [release-manifest.json]` runs `python kernel/build_dist.py --protection "${PROTECTION:-pyc}"`, which writes `<dist>/requirements.txt` from `kernel/pyproject.toml` `[project].dependencies` (one per line, no `torch`, no editable entries). The script verifies `axeuh_kernel/__main__.pyc` (or `__main__.py` for a PyArmor build), `EULA.md`, and `requirements.txt`, tars `kernel/dist/axeuh-kernel` into `axeuh-kernel-<version>.tar.gz` (archive root contains `axeuh_kernel/` directly), computes SHA-256 and size, and upserts `assets.kernel` (`file`/`sha256`/`size`/`api_version`) in the release manifest while preserving all other fields. The version comes from `BUILD_INFO.json`, then `kernel/pyproject.toml`; pass the first argument or `KERNEL_VERSION` to override it. `scripts/build-kernel-asset.sh --self-check` exercises the manifest merge without building.
- **End users.** The `kernel` onboarding step reads `onboarding.release_manifest_url` (falling back to `onboarding.release_base_url`; the `KERNEL_MANIFEST_URL` environment variable overrides the config key), downloads `assets.kernel` over HTTPS, verifies its SHA-256, extracts to a staging directory, and atomically installs the runtime at `<root>/kernel` with a `kernel/.installed-from-release` marker. With neither key configured the job fails fast with `kernel_release_not_configured`; set the manifest URL to a release that carries `assets.kernel`. Model download is a separate `kernel_models` step: no weights are inside the kernel tarball. License texts are in [docs/kernel/](../kernel/).
- **Kernel runtime (prebuilt path).** After the download the same job provisions the Python runtime in `<root>/.venv-kernel`, because a source-less host has no usable kernel interpreter:
  1. `nvidia-smi` classifies the GPU (driver >= 550 selects CUDA wheels; otherwise CPU).
  2. `python -m venv <root>/.venv-kernel` is created (an existing venv is reused).
  3. `pip install torch` runs first, from `kernel.torch_index_url` or the auto-selected `cu124`/`cu128` index; a CUDA failure falls back once to CPU. Expected download is roughly **1.1 GB on CPU** and **6.3 GB on CUDA**; budget several minutes.
  4. `pip install -r <root>/kernel/requirements.txt` installs the kernel dependencies (`fastapi`, `uvicorn`, `numpy`, `funasr`, `modelscope`).
  5. `python -m axeuh_kernel --help` runs from `<root>/kernel` with the new venv to prove the runtime imports. The spawn chain (`kernel.python` > `AXEUH_KERNEL_PYTHON` > `/opt/kinship/.venv-kernel` > `<root>/.venv-kernel` > backend interpreter) then picks the venv automatically.

  Job phases are `kernel_venv`, `kernel_torch`, `kernel_deps`, and `kernel_verify`; progress combines the download bytes and the runtime budget and only moves forward. The job runs in the backend, so closing the wizard page does not stop it. If the runtime phase fails (`kernel_requirements_missing`, `kernel_deps_install_failed`, `kernel_verify_failed`, ...), the downloaded `<root>/kernel` package is kept; fix the cause and run the step again — the venv is reused and the package is not re-downloaded unless the manifest version changes.
- **Development checkouts.** When `kernel/axeuh_kernel/` is present (no release marker), the same wizard action builds locally with `python kernel/build_dist.py --protection pyc` instead of downloading, and never overwrites the source directory. The button reads "本地构建内核（开发）" instead of "下载内核". `setup.ps1` notices the absence of `kernel/pyproject.toml` on a source-less package and skips the local build/bootstrap with a pointer to `KERNEL_MANIFEST_URL` / `onboarding.release_manifest_url`.

#### Staging Paths

For staging, keep code, config, and data in separate roots:

```bash
export AXEUH_PROJECT_ROOT=/opt/kinship
export CONFIG_PATH=/opt/kinship/backend/config/config.yaml   # symlink to <DATA_ROOT>/config/config.yaml
export AXEUH_AUTH_STATE_DIR=/opt/kinship-data/auth
export AXEUH_DATA_ROOT=/opt/kinship-data/var
export AXEUH_ONBOARDING_STATE=/opt/kinship-data/onboarding/onboarding_state.json
export AXEUH_ONBOARDING_BOOTSTRAP=1
```

`AXEUH_PROJECT_ROOT` fixes the project root; the config file location does not. A root-level `config.yaml` can be passed through `CONFIG_PATH` or `AXEUH_CONFIG_PATH`. Set `data.ai_root` to `/opt/kinship-data/ai`, `data.dir` to `/opt/kinship-data/ai/data`, `data.root` to `/opt/kinship-data/var`, and `models.dir` to `/opt/kinship-data/models`. Set `AXEUH_AI_ROOT=/opt/kinship-data/ai` for helper scripts that read it; the backend loader uses `data.ai_root`. Do not omit `AXEUH_PROJECT_ROOT`: `copy_ai_template` and asset paths resolve from it.

#### 1.4 SSL Certificate (Android App requires this)

The Android App enforces HTTPS. For development, use a self-signed certificate:

```bash
# Generate a self-signed certificate (365-day validity)
openssl req -x509 -newkey rsa:3072 -keyout key.pem -out cert.pem \
  -days 365 -nodes -subj "/CN=<YOUR_SERVER_IP_OR_DOMAIN>"

# Set ssl.cert / ssl.key in config.yaml to the generated files
```

**The Android app only trusts system certificates.** `app/src/main/res/xml/network_security_config.xml` declares only `<certificates src="system" />`. So a self-signed certificate **cannot** be made to work for the app by accepting it once in the browser (browser and app use different trust stores), and installing it as an Android *user* certificate will not be accepted either — it must go into the *system* store (requires root/Magisk). With a self-signed cert, either use the web UI only or repackage the app; **for production use a CA-trusted certificate** (e.g., Let's Encrypt).

(For reference, a browser on the device can accept the self-signed cert via the warning page → Advanced → Proceed, but that has no effect on the app.)

> **HTTPS is not enabled by cert/key alone.** Keep `ssl.enabled: true` in `config.yaml` as well. If it is missing or false, the backend serves HTTP on the same `server.port` (8768) while a Caddy vhost expecting `https://127.0.0.1:8768` returns 502. Check `ss -lntp` and `journalctl -u axeuh-health` before restarting; HotServer can hot-migrate the listener when `ssl.enabled` changes.

#### 1.5 Third-party API Key (Optional)

```yaml
api:
  mimo_key: YOUR_MIMO_API_KEY        # Xiaomi MiMo API (audio understanding + TTS)
  # Get one at: https://mimo.xiaomi.com/
```

MiMo is **not required, but strongly recommended**: the AI uses MiMo's multimodal model to analyze audio, and MiMo also powers TTS synthesis. Without `mimo_key`, core features still work, but audio understanding and the TTS endpoints are unavailable. A Baidu Maps AK (used by `analysis/geocode_tool.py` for reverse geocoding) is optional.

> **Before you start:** Loom runs inside the AI root named by `data.ai_root` (default `ai`) and keeps its managed config at `ai/.loom/config.yaml`. Set that directory up first (see [AI Working Directory Setup](#ai-working-directory-setup)).

#### 1.6 Start the Backend

```bash
# Linux / macOS (recommended)
./scripts/start.sh

# Windows
start.bat

# Manual start from the backend directory
cd backend && python -m core.hot_server
```

`scripts/start.sh` runs `python -m core.hot_server` from `backend/` in the foreground. The backend uses `server.port` 8768 for both HTTP and HTTPS; `ssl.enabled` decides the protocol.

Verify:

```bash
curl http://127.0.0.1:8768/health
# {"status":"healthy"}
```

#### 1.7 Startup Reference

Startup, first-run initialization, platform scripts and the production systemd example are documented in [STARTUP.md](STARTUP.md). `launcher.py` is retired; do not use it for new deployments.

---

### Phase 2: Frontend

**The compiled frontend is NOT shipped in the repository.** `dist/` is git-ignored, so a fresh clone has no `frontend/mobile/dist/` and `/mobile/` returns 404 until a build or the onboarding download completes. The backend serves whatever is in `frontend/mobile/dist/` at the `/mobile/` path.

```bash
cd frontend/mobile
npm install
npm run build    # Outputs to dist/; also fetches CircuitJS1 assets
```

CircuitJS1 is not vendored in this tree. `npm run build` first runs `scripts/fetch-circuitjs.mjs`, which shallow-clones the separate `kinship-circuitjs` repository into `public/circuitjs1/`. If that repository is unreachable or you are offline, set `CIRCUITJS_LOCAL_DIR` to a local `kinship-circuitjs` checkout, or skip the manual build: onboarding downloads the released frontend in the background when `frontend/mobile/dist/index.html` is missing, and the API stays available while the download runs.

After starting the backend, visit `https://<SERVER_IP>:<PORT>/mobile/` (HTTP also works in dev mode).

> Note: if you fill in `api.baidu_map_ak` in `config.yaml`, you must **rebuild**, because the AK is injected by `vite.config.ts` at build time.

---

### Phase 3: Android App

Download the latest APK from [GitHub Releases](https://github.com/Xehuri/kinship/releases), or build it yourself:

```bash
# Build Debug APK (gradlew lives at the repository root; run from there)
./gradlew :app:assembleDebug
# Output: app/build/outputs/apk/debug/app-debug.apk
```

Build requirements (if building from source):

- Android Studio Hedgehog (2023.1)+ or Gradle CLI
- JDK 17
- Android SDK 36
- Network access to JitPack: the on-device KWS dependency `com.github.k2-fsa.sherpa-onnx:v1.13.8` is not on Maven Central (`settings.gradle.kts` adds the JitPack repo). Native libs are limited to `arm64-v8a` and the unused C/C++ API `.so` files are excluded to keep the APK small.

---

### Phase 4: Phone Setup

This phase requires hands-on work on your phone.

#### 4.1 Install and Open the App

1. Transfer the APK to your phone and install it
2. Open the app. The settings page will open automatically on first launch

#### 4.2 Configure Server Address

In the Settings page, fill in the **Server Address** field:

```
https://<YOUR_SERVER_IP>:<PORT>
```

- LAN: `https://192.168.x.x:8768` (single port; `ssl.enabled` decides HTTP or HTTPS)
- Public network: `https://your-domain.com:8768`
- Local test: `http://localhost:8768` (Android App default; the backend uses the same port for HTTP and HTTPS)

Tap **Save and Test Connection** and wait for "Connection successful".

#### 4.3 Login

Enter the username and password. On a fresh install there is no user yet: open the web UI first and complete the setup screen to create the admin account, then log in here. After successful login, the token is saved automatically.

#### 4.4 Grant Permissions

Follow the prompts to grant each permission. Each step has an in-app guide:

| Permission                | Purpose                             | Notes                        |
| ------------------------- | ----------------------------------- | ---------------------------- |
| Notification listener     | Collect notification stats          | Enable manually in system settings |
| Microphone                | Ambient audio recording and analysis | Dialog prompt                |
| GPS location              | Location tracking                   | Dialog prompt (recommend "Allow all the time") |
| Storage                   | Read Gadgetbridge database          | Dialog prompt                |
| Accessibility service     | Foreground app / screen state       | Enable manually in system settings |
| Display pop-ups           | Show notifications                  | Extra step for Xiaomi/OPPO   |
| Battery optimization -> unrestricted | Prevent Service from being killed | Required on Xiaomi/OPPO/Huawei |

> **Xiaomi/Redmi users**: Lock the app in the recent tasks screen (pull down on the card until a lock icon appears) to prevent the system from clearing it.

#### 4.5 Verify

Return to the main screen. The status bar should show "Sensors running". The sensor preview area in Settings should display live data.

---

### Phase 5: Band Health Data (Gadgetbridge)

Health data (heart rate, steps, SpO2, stress, sleep stages) comes from your band through **Gadgetbridge**, an open-source third-party app.

#### 5.1 Install Gadgetbridge

From F-Droid: https://f-droid.org/packages/nodomain.freeyourgadget.gadgetbridge/

Alternative: GitHub Releases: https://github.com/Freeyourgadget/Gadgetbridge/releases

> Do not install from Google Play. The F-Droid or GitHub versions are updated much faster.

#### 5.2 Pair the Band

Open Gadgetbridge and scan for your band.

**About the Auth Key**: Xiaomi Band 8 Pro and 9 Pro require a 32-character hexadecimal Auth Key to connect. Here is how to obtain one:

1. Install the official **Mi Fitness** app (version must be below 3.36; newer versions cannot extract the key). Connect your band normally and use it at least once.
2. Enable **USB debugging** on your phone and connect it to a computer, then run:
   ```
   adb shell
   cd /storage/emulated/0/Android/data/com.mi.health/files/log/
   cat Transfer.device.log | grep token
   ```
3. The log contains two tokens: your **Mi Account token** and the **band Auth Key** (a 32-character hex string). The latter is what Gadgetbridge needs for pairing.
4. Try both tokens if unsure. The Auth Key is the one you enter in the Gadgetbridge pairing screen.
5. If your Mi Fitness version is too new and cannot extract the key, search for alternative methods on Chinese forums like Mitan or Bilibili.

> The Auth Key is only needed for initial pairing. Once paired, you will not need it again unless you unbind the band.

#### 5.3 Enable Auto-Export

```
Gadgetbridge Settings -> Automation
  |- Auto export database -> ON
  |- Export path -> Keep default (/storage/emulated/0/Gadgetbridge.db)
  |- Tap "Run auto export now" (top-right menu) -> Verify it works
```

#### 5.4 Enable Intent API (Recommended)

```
Gadgetbridge Settings -> Developer options -> Intent API
  |- Allow activity sync trigger        -> ON
  |- Broadcast after activity sync      -> ON
  |- Allow database export              -> ON
  |- Broadcast after database export    -> ON
```

With this enabled, the Kinship App background service can broadcast an intent to trigger Gadgetbridge to export its database on demand, achieving **automatic periodic collection** (roughly every 5 minutes) instead of waiting for Gadgetbridge's built-in one-hour interval.

#### 5.5 Set Database Path in the App

```
Kinship App Settings -> Data Collection -> Band database path
  -> Select /storage/emulated/0/Gadgetbridge.db
```

If the path is correct, the health data status section below will show heart rate, steps, and other values. Tap "Sync data now" to test manually.

#### 5.6 Disable Mi Fitness Background (Critical)

Both apps will fight for the BLE connection, causing Gadgetbridge to disconnect constantly. **You must prevent Mi Fitness from connecting to the band automatically:**

```
Phone Settings -> App Management -> Mi Fitness
  -> Auto-start -> OFF
  -> Battery optimization -> Restricted
  -> Permissions -> Nearby devices -> DENY (or disable Bluetooth scanning in system settings)

If the band is already unpaired from Mi Fitness:
  -> Bluetooth settings -> Find Xiaomi Band -> Unpair / Forget device
```

After this, only Gadgetbridge will connect to your band. Data collection will be stable.

#### 5.7 Xiaomi Cloud Health Source (Optional)

Besides the Gadgetbridge push path, the system can pull health data from the **Mi Fitness cloud** (heart rate, steps, SpO2, stress, calories, resting heart rate, sleep) as a supplementary source. Stress, resting heart rate, and active calories are only available from the cloud.

Three steps (run from the project root):

```bash
# 1. Scan the QR code; credentials are written to config.yaml (with a backup).
#    You can also use Settings -> Health Data -> Mi Health in the web UI.
python backend/scripts/mi_cloud_setup.py --qr
# 2. Enable the background auto-pull (runtime toggle, no restart; period = health.cloud_poll_interval_min)
python backend/scripts/mi_cloud_setup.py --enable
# 3. Verify
python backend/scripts/mi_cloud_setup.py --status
```

- Headless server: the CLI prints a one-time `loginUrl` you can open in a phone browser; the QR PNG is saved to `backend/data/mi_qr.png`. Treat the URL as a credential and do not save or share it.
- Credentials are written only to the gitignored `config.yaml`; `userId` and `passToken` are masked in CLI output. The one-time `loginUrl` is shown only in the interactive terminal and is not written to backend logs.
- Cloud data goes to its own shard `ai/data/users/{user}/health/{date}/cloud.json` and never overwrites `phone.json`
- An expired token shows `code=401`; re-run `--qr`. A notification is pushed after 3 consecutive failures
- Late-arrival tolerance: every pull re-reads `health.cloud.overlap_days` (default 7 days) and `store.write` merges by sample timestamp, so band back-fills land on the correct date
- Backfill: `python backend/scripts/mi_cloud_setup.py --backfill 110` imports cloud history missing locally
- Lag diagnosis: `python backend/scripts/mi_cloud_setup.py --latest` shows the newest cloud sample per metric
- Consumers need no change: dashboard, health manifest, facts file and biweekly review all read through `read_view`; the facts file simply omits the physiology line when no health data exists
- Full guide (Chinese): use the xiaomi onboarding step or the Web UI settings page.

---

## Sensor Reference

| Sensor        | Collector              | Data                                    | Interval | Togglable? |
| ------------- | ---------------------- | --------------------------------------- | -------- | ---------- |
| Band health   | HealthDataCollector    | Heart rate, steps, SpO2, stress, sleep stages | 5 min | Yes        |
| GPS           | GpsCollector           | Lat/lng, speed, accuracy                | 5 min    | Yes        |
| Ambient audio | AudioCollector         | Audio segments (fixed-length by `audio_segment_ms`, WAV/FLAC dual format); batched upload + crash-safe checkpoint. Speaker recognition (voiceprint embedding / scoring) is computed later by the audio kernel, not on the phone | Continuous | Yes  |
| System state  | SystemStateCollector   | WiFi/BT state, screen on/off, foreground app, battery | 5 sec | Yes |
| Notifications | NotificationCollector  | Notification count, source app           | 5 sec    | Yes        |
| Accessibility | AccessibilityService   | Foreground app, typed content (requires accessibility permission) | 5 sec | Yes |

All sensors can be toggled independently. Nothing is forced on.

---

### AI Working Directory Setup

The AI does not roam your filesystem. It is confined to one AI root, named by `data.ai_root` in `config.yaml` (default `ai`). Agent prompts, analysis scripts, task definitions, Loom workspace config, and the AI's long-term memory all live inside that directory.

`ai-template/` is a clean, instance-free copy of that directory. It ships placeholder configuration and skeleton files only, with no real data or keys. To create the working directory for a new instance:

1. **Copy the template into place.** Copy `ai-template/` to `ai/`, the default `data.ai_root`:

   ```bash
   cp -r ai-template ai
   ```

   If an `ai/` directory already exists with data you want to keep, merge the template's placeholder files in instead of overwriting it.

2. **Configure MCP.** Backend settings stay in the project-root `config.yaml` (see [Phase 1.3](#13-configuration)); Loom's own provider and model settings live in `ai/.loom/config.yaml` and are written by the onboarding `loom` step. The full checklist (部署配置清单) is at the top of `ai-template/系统初始化指南.md`:
   - Loom: register the 4-tool MCP service at `ai/mcp/ai_mcp.py` in `mcp.servers`. Do not hand-copy a legacy assistant client config; let onboarding create the managed Loom config.

3. **Replace the remaining placeholders.** Every placeholder is defined in the placeholder list (占位符替换清单) inside `ai-template/系统初始化指南.md`. Replace them in `ai/AGENTS.md`, `ai/agents/*.md`, and the analysis scripts. Loom sub-agent models live in `ai/agents/*.md` frontmatter, currently defaulting to `deepseek/deepseek-flash`; change it if you use another provider. In particular, `ai/analysis/geocode_tool.py` needs your Baidu Maps AK (Web Service API). Do not invent new placeholder names.

   > **Model requirement:** the main agent must be able to read images (screenshots, study material). `deepseek-flash` is **not a built-in model**. Declare it in `ai/.loom/config.yaml` under `providers[]` and `models[]`, with `vision: true` on the model entry (`deepseek-v4-flash` is text-only and cannot see images). The model id is referenced in multiple `ai/agents/*.md`, `ai/data/tasks/*.py`, `ai/data/tasks/*.yaml`, and `ai/data/tasks/AGENTS.md`; change them together.

4. **Run the AI system initialization.** On first launch there is no assistant session yet; onboarding starts Loom and registers the main session. Then have the main agent follow `ai-template/系统初始化指南.md` end to end: scan the directory, get to know the user, register voiceprints, confirm data is flowing, discuss and enable tasks, then commit. This is a one-time process.

#### Automated Pipeline Architecture

### Voice Wake Word (Optional)

Always-on keyword spotting ("小贺同学") followed by voiceprint verification, voice-command recording, and transcription delivered to the main agent. There are two detection paths:

| Mode | Where KWS runs | How the phone streams |
| ---- | -------------- | --------------------- |
| **Server-side (streaming)** | Audio **kernel** (sherpa-onnx inside `axeuh_kernel`), over the phone's continuous stream relayed by the backend | Continuous PCM to `/ws/audio-stream` (App `audio_stream_enabled=true`, `local_kws_enabled=false`) |
| **End-side (on-device)** | Phone App (`wakeword/LocalKwsEngine.kt`, sherpa-onnx via JNI) | Only streams after a local hit (`local_kws_enabled=true`), prefixed by a ~2 s pre-roll |

```
App PCM stream --WS /ws/audio-stream--> backend --WS /v1/stream--> kernel
  (server-side) KWS hit in kernel (wakeup.hit) --------------------\
  (end-side)   audio_start {local_hit:true} ------------------------/
  -> voiceprint entry check (kernel) -> record (kernel VAD / voiceprint endpointing)
    -> ASR (kernel) -> "【语音唤醒】" prefix -> main-task
  wake start/end signal --WS--> App plays the hint tone
```

Both paths converge on the same downstream chain (voiceprint entry check -> record -> ASR -> deliver), so the state machine and thresholds do not care which side detected the word.

The feature is **off by default** and has three prerequisites: a **running kernel with its KWS model available**, a keyword file, and an **enrolled voiceprint**. The backend itself needs no extra package for this — sherpa-onnx lives in the kernel.

**1. Kernel-side KWS model (prerequisite).** The wake-word detector runs inside the kernel; it resolves its model through the kernel's three-level chain (contract §3.4): `AXEUH_KERNEL_MODEL_DIR` > inside the kernel package > download landing dir. Place the sherpa-onnx KWS model directory (`sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20/`) plus a sibling `keywords.txt` into one of those roots (e.g. `%LOCALAPPDATA%/axeuh-kernel/models/` on Windows). Neither git nor `ai-template/` ships the model:

```bash
# Model archive (download and unpack into the kernel model dir, not backend/ai dirs):
wget https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20.tar.bz2
tar xf sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20.tar.bz2
rm sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20.tar.bz2
```

Other models and details: [sherpa-onnx KWS documentation](https://k2-fsa.github.io/sherpa/onnx/kws/pretrained_models/index.html). The kernel is spawned automatically by the backend on first audio use; when its KWS model is missing the kernel answers `model.unavailable` and the wake chain degrades to "no wake" (rate-limited ERROR in the backend log) — there is **no local fallback model** anymore.

**2. Create the keyword file** `ai/data/wake_word/keywords.txt` (path = `audio.wake_word.keywords_file`) — one line, pinyin tokens plus an `@` echo label:

```
x iǎo h è t óng x ué @小贺同学
```

The file is written by the backend (`/api/screen/wake_word/keywords`, which encodes via the kernel `kws_encode` endpoint); keep it in sync with the kernel-side `keywords.txt` above.

**3. Enroll your voiceprint (required).** The state machine is `detect -> verify -> record`, and the voiceprint entry check (also computed in the kernel) must pass before recording starts. With no enrolled speaker the check always fails and the wake word appears to do nothing:

```
POST /api/screen/speakers/enroll
```

**4. Enable it in `config.yaml`:**

```yaml
audio:
  wake_word:
    enabled: true          # default false (fail-safe)
```

Tune `keywords_score` (1.8), `keywords_threshold` (0.25), `entry_threshold_ready` / `entry_threshold_cold`, `exit_threshold`, `exit_hold_ms`, `vad_silence_ms`, `min_record_ms` (2.5 s), `max_record_ms` (30 min) as needed (note: `chunk` / `num_threads` are kernel-internal constants; the keys are kept for display/compat).

**5. Restart and verify** (`POST /api/screen/restart`). The kernel loads the model lazily on the first audio stream:

- Say the phrase -> `命中唤醒词` -> `进门验证通过` -> stop speaking -> `录制停止 reason=...` -> `语音指令已投递 main-task`

**Client side.** The phone App streams PCM to `/ws/audio-stream` and plays the hint tone when it receives the server's `{"type":"wake","stage":"start|end"}` frames (App 1.3.0+). A browser-only client cannot use this feature.

**End-side KWS (on-device).** Toggle it in the App under Settings -> Data Collection -> Sound ("端侧唤醒"). When on, `AudioCollector` keeps a ~2 s pre-roll ring buffer, runs `LocalKwsEngine` (sherpa-onnx `KeywordSpotter`, model files in `app/src/main/assets/kws/`) on the recording thread, and only opens a WebSocket once a keyword hits, sending `audio_start` with `local_hit: true` and the matched `keyword`. The backend marks the session as locally hit and feeds the App-provided pre-roll (which contains the full wake word) straight into the voiceprint entry check — the wake does not wait for the server-side KWS bridge.

| Preference (`data_collector`) | Default | Meaning |
| ----------------------------- | ------- | ------- |
| `local_kws_enabled` | `false` | Master switch for on-device KWS |
| `kws_score` | `1.8` | Keyword boosting score (higher = harder to trigger); mirrors `audio.wake_word.keywords_score` |
| `kws_threshold` | `0.25` | Decision threshold; mirrors `audio.wake_word.keywords_threshold` |
| `kws_interval_ms` | `100` | Inference interval, UI offers 100 / 200 / 300 ms (clamped 100-1000). The engine **accumulates** samples until one interval is full instead of skipping frames, so the audio fed to the model stays continuous |
| `kws_keywords` | `""` | Custom keyword list (encoded tokens, one per line); empty = use the bundled `assets/kws/keywords.txt` |
| `kws_cloud_test_enabled` | `false` | Cloud test mode (see below) |

Multi-word lists are configured in the Settings page: enter Chinese keywords (comma/newline separated), the server encodes them to tokens via `POST /api/screen/wake_word/encode` (encoding happens in the kernel), then `POST /api/screen/wake_word/keywords` writes the keyword file and refreshes the runtime target list. Note: the kernel's stream KWS resolves its own keyword file lazily and caches the engine — for the *server-side* detection path to pick up a changed word list, the kernel-side `keywords.txt` must be in place (and the kernel restarted if the engine was already loaded); the outer runtime list always filters hits immediately (it gates every `wakeup.hit` / `local_hit` before the wake fires).

**Cloud test mode.** With `kws_cloud_test_enabled` on, the App sends `audio_start` with `test: true`. The server runs the detect/verify/record chain but does **not** deliver to the AI and does **not** persist the wake audio; instead it pushes the full result back over the same WebSocket as `{"type":"kws_test_result", ...}` (matched keyword, sliding-window voiceprint score series `vp_scores`, duration, ASR text, stop reason, and a parameter snapshot). The Settings page shows it in the "唤醒词测试" panel.

**Notes**

- The target phrases live in a runtime list in `backend/services/wake_word_service.py` (initial value `["小贺同学"]`). **Multiple wake words are supported**: the Settings page encodes them to tokens via `POST /api/screen/wake_word/encode`, then `POST /api/screen/wake_word/keywords` writes the keyword file and refreshes the runtime target list (kernel-side engine re-resolution requires a kernel restart). Only an exact match against the current list triggers a wake (no substring/fuzzy matching), and `wake_start` echoes the actual matched word. If the list is empty/unconfigured it falls back to `["小贺同学"]`.
- If the kernel's KWS model or sherpa-onnx is missing, the kernel answers `error model.unavailable` on the stream session and the backend logs a rate-limited `内核不可用，唤醒链降级为不唤醒` ERROR; the kernel caches the load failure and does not retry until the kernel process restarts. There is no local model fallback.
- Trailing-silence endpointing is judged by the kernel (`POST /v1/inspect/vad_curve`, pyannote domain inside the kernel); when that call fails the recording is only stopped by voiceprint-low and the 30-minute hard limit.
- **The wake chain does not feed the incremental data.** Wake audio is neither written to `perception.jsonl` nor archived under `daily/{date}/audio/` (only the ASR result is delivered to the main agent as a voice command). This is separate from ambient-audio collection, which is a distinct upload path — see [Audio Collection and Upload Pipeline](#audio-collection-and-upload-pipeline).
- **End-side hit confirmation.** In on-device mode the App waits for the server's `wake/start` (voiceprint entry check) and aborts the stream if it does not arrive within 5 s of the WebSocket becoming ready (connection-setup time is not counted); this avoids an endless push when the speaker fails verification.
- Entry-check thresholds come from `audio.wake_word.entry_score_cohort_ready` / `entry_score_no_cohort` (production tuned to 0.7 / 0.45 on 2026-09-15). `entry_threshold_ready` / `entry_threshold_cold` are accepted aliases for the same keys.

### PC Sensor

A standalone service that runs on Windows and collects PC state:

- System idle / locked state
- Current foreground window title

```bash
cd desktop/pc-sensor
pip install -r requirements.txt
python pc_sensor_app.py
```

PC Sensor configuration is in `desktop/pc-sensor/config.json`. The `agent_token` is used for API authentication, including `GET /pc-sensor/auth-token`, which the desktop shell calls to obtain the backend token for SPA auto-login. The endpoint returns only an in-memory snapshot and never logs the token.

> Note: the PC Sensor has no user-facing screenshot, file-operation, or command APIs. It only collects foreground window, idle, and screen-lock state; `tasklist` is invoked internally for lock detection.

### Windows Desktop App

The optional Windows desktop app bundles the PC sensor and opens the web UI at `${server}/mobile/` in a native Electron window. It includes a private Python 3.11.9 runtime and pinned wheels for the PC sensor; no system Python installation is required.

The app uses a **single window**: the remote SPA owns the window's web contents, and the local setup/settings/error page is a `WebContentsView` overlay inside the same window. Opening settings does not create a second window, and "return to main" only hides the overlay. The SPA's system settings row uses `axeuh://open-settings`: Android opens the Android settings screen, while the desktop main window intercepts the same scheme and shows the local settings view at `#/settings` in place. The SPA code path is unchanged.

**Credentials and auto-login.** The PC sensor is the authentication broker. Once it has authenticated with a backend token or account credentials, the desktop shell requests `GET /pc-sensor/auth-token` with the local Bearer `agent_token`, injects the returned token into the SPA (`localStorage.mobile_token`) via `executeJavaScript`, and fires `CustomEvent('axeuh-token-refresh', { detail: token })`. The SPA updates its in-memory token, storage, and login state in place, so there is no page reload and no second login. The shell syncs on page load and then polls, injecting only when the token changes. The desktop shell never places tokens in URLs or logs. Android now uses the same event through `WebTokenBridge`: on page finish, resume, and `auth_token` changes it injects the token into the SPA; the Android bootstrap URL may carry the token once and the SPA strips it immediately. Android does not log the token. See [android-webview-token-bridge-2026-10-25.md](../dev/android-webview-token-bridge-2026-10-25.md).

1. Download and run `Kinship-Desktop-Setup-<version>-x64.exe`, or use the portable exe if you do not want an install. The build is unsigned, so Windows SmartScreen may ask for confirmation.
2. On first run, enter the server origin (protocol, host, and port, with no path), test the connection, and trust the certificate if it is self-signed. Then configure the PC sensor credentials; the same credentials drive both sensor uploads and SPA auto-login.
3. Do not run the standalone tray app at the same time. The desktop app starts its own sensor instance; if it finds a running instance with a matching identity it adopts it, otherwise it reports a port conflict.

> **Upgrading from a pre-rebrand build.** The old `%LOCALAPPDATA%\Programs\Axeuh Health Desktop` install directory and its uninstall entry remain after installing the new version. Run `desktop/scripts/cleanup-legacy-install.ps1` (or uninstall the old version manually) so two app identities do not compete for the PC sensor port. User data in `%APPDATA%\Axeuh Health Desktop` is kept and reused by the new app.

> **Missing bundled PC sensor runtime.** If saving settings reports `缺少内置 PC 采集端运行时` with a `%TEMP%\<random>\resources\pc-sensor\runtime\python.exe` path, the portable build's self-extraction was blocked or the file was quarantined by antivirus. Prefer the NSIS installer (stable install directory), or extract the zip into a local folder instead of running it from the archive or a temporary directory, and add the app folder to the antivirus whitelist. New portable builds extract to `%TEMP%\KinshipDesktop`. The app also checks `%APPDATA%\Axeuh Health Desktop\pc-sensor-runtime`, `%LOCALAPPDATA%\Programs\Kinship Desktop\resources\pc-sensor`, `%LOCALAPPDATA%\Programs\Axeuh Health Desktop\resources\pc-sensor`, and `AXEUH_PC_SENSOR_ROOT`. The sensor configuration is saved even when the runtime is missing; install or repair the runtime and restart the desktop app.

See [`../desktop/README.md`](../../desktop/README.md) for the full setup, TLS trust rules, build steps, and verification commands.

---
