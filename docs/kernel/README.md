# Audio Kernel

The Kinship audio kernel (`axeuh_kernel`) is a closed-source Python process that performs all audio computation: ASR, VAD, voiceprint embedding and scoring, keyword spotting, scene classification, diarization, and unknown-speaker profiling. The backend only orchestrates it over HTTP and WebSocket on `127.0.0.1` with an ephemeral port.

## Data boundary

The kernel is a local compute process, not a data service. This section covers the kernel process only; other components have their own network behavior.

- **No data uploads.** The kernel does not upload any data to an external service: no audio, transcripts, voiceprints, embeddings, telemetry, or other user data.
- **Loopback in, results out.** It binds `127.0.0.1` and serves the backend over HTTP/WebSocket on an ephemeral port. Audio goes in; results come out. Local requests from the backend, including artifact uploads to `PUT /v1/artifacts`, stay on loopback.
- **The backend owns persistence.** Audio ingestion, storage, and business writes happen in the backend (`perception.jsonl`, `daily/{date}/audio/`, health shards). The kernel keeps private local runtime state under `--state-dir` (jobs, artifacts, voiceprint and unknown-speaker state), and does not upload it.
- **Model downloads are inbound.** Model weights are fetched inbound by the `kernel_models` onboarding step, or by an explicit opt-in kernel download when `AXEUH_KERNEL_ALLOW_MODEL_DOWNLOAD=1` is set. Both paths carry no audio or user content; neither is a data upload. See [Models](#models).

An optional external AI provider (for example MiMo for multimodal audio understanding) is a separate, operator-configured integration, not part of the kernel.

## Distribution

Kernel source is maintained in the private `kinship-kernel` repository and is not part of the public `kinship` tree. Users install a prebuilt release asset:

- Asset: `axeuh-kernel-<version>.tar.gz` (public 0.1.0: `axeuh-kernel-0.1.0-py312-any.tar.gz`)
- Runtime path: `<project>/kernel`
- API version: `1.0.0`

The asset contains the protected `axeuh_kernel` package, `requirements.txt`, `BUILD_INFO.json`, and the license texts (`LICENSE`, `COMMERCIAL.md`, `EULA.md`). It does not contain a `models/` directory or any `.ckpt` files.

The onboarding `kernel` step downloads the asset from `onboarding.release_manifest_url`, verifies its SHA-256, and atomically installs it at `<project>/kernel` with a `.installed-from-release` marker. The same step can provision `<project>/.venv-kernel`. A source-less host needs no checkout.

## Models

Model weights are downloaded separately by the `kernel_models` onboarding step. This includes ERes2NetV2 (`iic/speech_eres2netv2_sv_zh-cn_16k-common`, ModelScope). No model is shipped inside the kernel asset.

Models resolve through `AXEUH_KERNEL_MODEL_DIR`, then a package `models/` directory if present, then the download landing directory. The wizard writes `models.dir` and downloads required models from ModelScope and HuggingFace; `kws-zipformer` and `cnn14` use their upstream releases and mirrors.

Required models cover ASR, VAD, speaker embedding, diarization, wake-word KWS, and environmental sound classification. See [docs/ops/INSTALL.md](../ops/INSTALL.md) for the current list.

## API

The kernel exposes HTTP and WebSocket on one loopback port. The handshake line reports `{port, pid, api_version}` with `api_version` fixed at `1.0.0`. The endpoint and error contract is [docs/kernel-contract.md](../kernel-contract.md).

Do not start the kernel manually (`python -m axeuh_kernel`). A manual spawn can overwrite the shared pidfile and make the backend reuse the wrong interpreter. The backend starts and supervises the process.

## License

- [LICENSE](LICENSE): PolyForm Noncommercial 1.0.0
- [COMMERCIAL.md](COMMERCIAL.md): commercial licensing option
- [EULA.md](EULA.md): terms for distributed kernel builds
