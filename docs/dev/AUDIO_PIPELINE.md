# Audio Collection and Upload Pipeline

> Extracted from `README.md` (2026-10-22). The data contract is in `DATA_FORMAT.md`; the kernel contract is in `kernel-contract.md`.

## Audio Collection and Upload Pipeline

Ambient audio and voice wake word are **two independent paths**. Ambient audio enters the incremental data (it is what the AI analyzes per day); wake audio does not. They must not be conflated when debugging.

> **Data boundary.** In this document, "upload" means the App sending audio to your own backend. The audio kernel is a local compute step: the backend sends it audio over loopback and receives results. The kernel does not upload any data, including audio, transcripts, or voiceprints, to any external service. Model weights are fetched inbound from ModelScope/HuggingFace, either by onboarding or by an explicit opt-in kernel download; that traffic carries no audio and is not an upload. See [kernel/README.md](../kernel/README.md#data-boundary).

> Wake-word transport and settings are documented in [Voice Wake Word](#voice-wake-word-optional).

### App side: segmentation decoupled from upload cadence

Segment length, upload frequency, and upload format are independent knobs (all in the `data_collector` preferences):

| Preference | Default | Role |
| ---------- | ------- | ---- |
| `audio_segment_ms` | `60000` | **Fixed segment length** (default 60 s): the App cuts every segment at this length and does **no semantic splitting** (there is no in-code VAD endpoint at all); semantic continuity is handled by the backend seamless stream |
| `audio_upload_batch_ms` | `600000` | **Batch upload interval** (10 min); only decides how often accumulated segments are sent |
| `audio_upload_format` | `wav` | **Upload quality (two tiers, added 2026-09-23)**: `wav` = raw lossless; `flac` = lossless compression, saves ~46% traffic (WAV 2.76 GB/day vs FLAC 1.50 GB/day). Chosen in the App under Settings -> Ambient audio -> Upload format; **re-read at each segment start, takes effect on the next segment, no restart needed**. FLAC encoding uses MediaCodec first with a pure-Java fallback, and auto-degrades to WAV on failure so no audio is ever lost |
| `audio_stream_enabled` | `true` | Legacy switch for the continuous streaming path (only used when end-side KWS is off) |

- Cutting is pure policy in `service/collectors/AudioSegmentPolicy.kt` (`isBatchUploadDue` / `overlapTail` / `nextSegmentStartMs`, no Android dependency): a segment is cut at the fixed `audio_segment_ms` boundary (the App has no VAD endpoint logic), and the next segment starts with the previous ~500 ms tail as overlap so the first syllable is not clipped.
- A batch upload fires when the interval `audio_upload_batch_ms` has elapsed, when pending data reaches `PENDING_UPLOAD_THRESHOLD_MS` (30 min), or immediately on stop / interruption / backgrounding. On a perceivable interruption the collector also flushes any `upload_cache` entries finalized earlier **even if it did not claim an in-flight segment** (no batch scheduler survives a stop); if a flush pass is already in flight the trigger is queued for one more pass instead of starting a second thread, so no entry is lost and the same entry is never uploaded twice. Only a process kill relies on the checkpoint + `CheckpointRecovery` path.
- **Crash-safe checkpoint.** Each in-flight segment is written through `service/uploader/PcmCheckpointWriter.kt`, which appends raw PCM to `filesDir/audio_checkpoint/pending/<sessionId>/<segStartMs>.part` plus a sidecar `.json`, flushing (flush + fsync) every 10 s; on completion it encodes by `audio_upload_format` (WAV prepends a 44-byte header / FLAC via `FlacFinalizer`, auto-degrading to WAV on encode failure) and atomically lands a `cacheDir/upload_cache/{segStartMs}-{seq}.wav|.flac` + `.json` pair (the JSON carries a `format` field). Process kill loses at most one flush window instead of the whole segment.
- **Recovery.** On service start, `DataCollectorService` -> `CollectorManager.recoverAudioCheckpoints()` -> `service/uploader/CheckpointRecovery.kt` converts orphan `.part` files into `upload_cache` entries using the sidecar `format` and re-uploads them. `stop()`, turning off the Sound collection switch, and `onTaskRemoved` all finalize the current segment into `upload_cache` so recorded audio is not lost.
- Cleanup follows LRU + 7-day TTL + 500 MB cap (`CheckpointCleanup`), but **entries that were never uploaded successfully are never evicted**.

### Server side: seamless upload stream

Fixed-length cutting splits one sentence across two files, so the multipart upload route no longer analyzes each segment in isolation. Instead it keeps one **virtual continuous audio stream per `device_id`** — each uploaded WAV/FLAC is just "one part of the stream" (the backend magic-sniffs the real format, decodes to unified PCM so the watermark/dedup/cut logic is format-agnostic, and re-encodes each emitted chunk in the uploaded format on disk):

- `services/audio_ingest_registry.py` keeps a `{device_id: DeviceIngestSession}` map with a background idle-sweep thread (every 5 s); `services/audio_ingest_session.py` holds the per-device stream on the **absolute timeline**.
- **Continuity test:** `B.start_ms <= A.end_ms + tolerance_ms` (`audio.stream.stitch.tolerance_ms`, default **1000 ms**) means the same stream, so the segment is appended and the cut is **not** made at the file boundary. The App overlaps ~500 ms of the previous tail, so the head/tail need not match exactly; any gap within the tolerance is padded with silence to keep the timeline aligned.
- **Cuts happen at in-stream silence endpoints**, not file boundaries: the cut decision is delegated to the kernel's WS `mode:"segment"` channel (`services/segment_channel.py`, per-frame RMS energy computed inside the kernel). It cuts at a silence endpoint (`stitch.silence_cut_s`, default 1.5 s) or the hard cap (`stitch.max_chunk_s`, default 120 s), and only once `stitch.min_chunk_s` (default 10 s) has accumulated. A cut can land in the middle of a file. The outer layer keeps the timeline bookkeeping (continuity, watermark, dedup, holdback) and the mirror buffer; if the segment channel is down the stream **degrades to whole-block flushing** (no local segmenter exists anymore — it was deleted with Wave C5; audio is never lost).
- **Merging happens at the audio layer:** the accumulated PCM is handed to `analyze_audio_file` as a single input (the kernel's pyannote VAD then does semantic splitting and ASR), so a sentence spanning two files is not split by ASR. This is not "transcribe each file then join the text".
- **Discontinuity** (beyond tolerance / device change / time going backwards) flushes the current stream first and then starts a new one; audio is never stitched across a gap. Both continuous and discontinuous arrivals are logged at INFO with both timestamps, the gap and the verdict.
- **Finalization:** `holdback_s` (default 90 s, measured by **receive idleness**) flushes a retained tail; the end of a session or an explicit `flush()` flushes immediately. `min_flush_speech_ratio` (default 0.05) is the speech-ratio floor: a chunk below it counts as pure silence and produces no `voice` entry.
- Deduplication covers App retries and cache replays (`device_id / session_id / seq / start_ms`); segments that fall entirely inside the processed watermark are safely dropped.
- `audio.stream.stitch_enabled: false` disables the whole path and falls back to the legacy per-segment analysis.
- Non-standard formats or segments without an absolute timestamp also fall back to the legacy path (no risk of mis-cutting).

### Stream vs upload isolation

- `analyze_audio_file(..., origin="upload"|"stream")` traces the source. `origin="stream"` skips `append_perception`, so streamed (wake) audio never creates a `voice` entry in `perception.jsonl`.
- Streamed audio is archived under `stream/{date}/audio/` (outside `daily/`); uploaded audio under `daily/{date}/audio/`.
- `audio.stream.persist_perception` (default `false`) forces streamed audio back into `perception.jsonl` for debugging/rollback only.

---
