# Audio Kernel

The Kinship audio kernel (`axeuh_kernel`) is a closed-source Python process that performs all audio computation: ASR, VAD, voiceprint embedding and scoring, keyword spotting, scene classification, diarization, and unknown-speaker profiling. The backend only orchestrates it over HTTP and WebSocket on `127.0.0.1` with an ephemeral port.

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
