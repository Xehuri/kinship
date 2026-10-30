# -*- coding: utf-8 -*-
"""内核 segment 切分通道（C5：无缝流/WS 流的物理切分上移内核，D1 决策落地）。

职责边界（内容归内核 / 位置与编排归外层）
------------------------------------------
本模块把一条**连续的 PCM 字节流**推给内核 ``WS /v1/stream`` 的
``mode:"segment"`` 会话（A6 交付），由内核逐帧 RMS 能量做静音端点切分；
外层收 ``segment.closed {artifact, start_ms, end_ms, seq}`` 事件，经
``GET /v1/artifacts/{id}`` 取回 WAV 字节并解码为原始 PCM（``SegmentChunk``），
并**立即经契约面 ``DELETE /v1/artifacts/{id}`` 删除 artifact**（消费即删是
外层义务，但手段是 HTTP 而非跨进程 rm——P3-V15 根除 W2；内核 K2a 起有
幂等 DELETE 端点 + 启动清扫兜底，切分产物不再无限堆积）。

时间连续性判定、去重水位、holdback 冲刷、产出块语音占比过滤**全部留在
外层**（:mod:`services.audio_ingest_session` / :mod:`services.audio_stream_session`）。
本模块只是"切分计算 + artifact 搬运"的传输通道，自身零音频算法——**内核
不可用不回退本地切分**（本地 segmenter 本波删除），失败以异常上抛，由
调用方降级为"无静音切分的逐段独立分析"（stitch=false 既有语义）。

契约要点（kernel/axeuh_kernel/stream/session.py，A6 segment 模式）
------------------------------------------------------------------
- ``session.start {device_id, sample_rate:16000, mode:"segment", t0_ms,
  segment:{rms_threshold, frame_ms, silence_cut_s, min_chunk_s, max_chunk_s}}``；
  ``t0_ms`` 为时间轴锚（本通道恒显式传入：该流首段的绝对 epoch 毫秒）。
- 二进制帧必须**偶数字节**（奇数帧内核直接拒绝且不进缓冲）——通道内部保留
  半字节残余跨 push 拼接，绝不把奇数帧发给内核。
- 出站只有 JSON 帧；``segment.closed`` 的 ``start_ms/end_ms`` 为绝对 epoch
  毫秒（``t0_ms`` + 样本计数单调推轴），``seq`` 自 1 会话内单调递增。
- ``session.stop``：内核冲刷尾段（允许短于 min_chunk）后复位会话；断连未
  stop 的内核缓冲**一律丢弃**——所以调用方必须自带镜像缓冲兜底（见各会话
  模块），本通道对"未交付即断连"的音频不负送达责任。
- artifact 取回 ``GET /v1/artifacts/{id}`` → ``content_b64``（逐字节一致）；
  **WS 断连不影响已落盘 artifact**，通道死亡后仍可用 ``drain_pending()``
  经 HTTP 取回队列里未消费的 ``segment.closed``（音频不丢的关键性质）。
- 删除走契约面 ``DELETE /v1/artifacts/{id}``（P3-K2a，鉴权同 GET；幂等：
  缺失/二次删也 200 ``deleted:false``）。旧内核无此 kind/路由 → 405/404，
  残留交内核启动清扫（契约 §8 生命周期），外层绝不回退跨进程 rm。
  任何删除失败只告警不阻断（WARNING-only，K2a 裁定）。

失败语义（fail-fast，调用方负责降级与镜像兜底）
-----------------------------------------------
- ``open()``：建连/握手/发 start 任一失败 → 通道置死并抛
  :class:`SegmentChannelError`。
- ``push()``：发送失败置死并抛错——**抛错时本段可能已进内核也可能没有**
  （WS 半程失败不可知）：内核若实际收到，未 stop 即断连的缓冲会被内核丢弃，
  且本通道随后 close 弃连，绝不产生重复段；若未收到，调用方镜像里有完整字节。
- ``stop()``：发 stop 失败先收割队列再抛 :class:`StopWithChunksError`（已
  取回的段挂在异常 ``chunks`` 属性上随降级路径传递，不丢音频）。
- 收到内核 error 帧 / WS 关闭 → 置死；后续操作抛错（close/drain_pending 仍可用）。
- artifact 取回失败：**该帧放回队列**并置死停止收割（drain_pending 可重试
  同一帧），取回已成功的段照常返回。

并发模型：所有 WS 协程跑在模块级共享的 ``asyncio`` 事件循环守护线程上；
调用方（HTTP 请求线程 / 注册表冲刷线程 / WS 主循环经 to_thread）通过
``run_coroutine_threadsafe`` 同步等待。每个通道实例约定**单调用方串行
使用**（会话层自带互斥锁），读循环是唯一并发生产者（经线程安全队列交接）。

依赖：标准库 + aiohttp（经 kernel_client）+ 惰性导入 services.kernel_client。
"""

from __future__ import annotations

import asyncio
import base64
import concurrent.futures
import io
import json
import logging
import queue
import threading
import time
import wave
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional

logger = logging.getLogger(__name__)

# 内核 WS 握手探测窗口传给 ws_connect_stream（鉴权失败回帧为毫秒级回环）
_WS_HANDSHAKE_TIMEOUT = 0.5
# 建连总预算（含 ensure/spawn/发 start）：超时=放弃（调用方降级）
_OPEN_BUDGET_S = 8.0
# 单次 WS 帧发送超时（回环；超时视为断连）
_SEND_TIMEOUT_S = 5.0
# push 后的收帧等待：首事件最多等这么久（回环内核出帧毫秒级；无切点时
# 到点即返回，不拖慢上传路径）
_PUSH_FIRST_WAIT_S = 0.12
# stop 冲刷尾段的静默轮询：一轮 quiet 无新帧即视为收完，总预算封顶
_FLUSH_QUIET_S = 0.4
_FLUSH_BUDGET_S = 5.0
# artifact GET 超时（回环；chunk 最大 120s × 32KB/s ≈ 3.8MB）
_FETCH_TIMEOUT_S = 15.0
# artifact DELETE 超时（P3-K2a 幂等轻操作，无需随 GET 大文件口径）
_DELETE_TIMEOUT_S = 5.0
# 出站事件队列上限（内核出站帧远快于消费方；超限=置死，绝不无界堆积）
_EVENT_QUEUE_MAXSIZE = 256

_INTERNAL_EVENTS = ("_transport", "_error")


class SegmentChannelError(Exception):
    """通道不可用/操作失败。调用方捕获后按语义降级（本模块零本地算法）。"""


class StopWithChunksError(SegmentChannelError):
    """stop 发送失败但已收割到段：段挂在 ``chunks`` 属性上随降级路径传递。"""

    def __init__(self, chunks: "List[SegmentChunk]", message: str = "") -> None:
        self.chunks = chunks
        super().__init__(message or "session.stop 发送失败（已回收入到的段）")


@dataclass
class SegmentChunk:
    """内核切出的一个音频段（artifact 已取回并解码为原始 PCM）。"""

    pcm: bytes          # 原始 PCM（16kHz/单声道/16bit 小端）
    start_ms: int       # 绝对墙钟起点（epoch 毫秒，内核 t0 轴推得）
    end_ms: int         # 绝对墙钟终点
    sample_count: int   # 单声道样本数


def _wav_to_pcm(data: bytes) -> Optional[bytes]:
    """标准 WAV 字节 -> 原始 PCM 帧数据；解析失败返回 None。"""
    try:
        with wave.open(io.BytesIO(data), "rb") as wf:
            return wf.readframes(wf.getnframes())
    except Exception:
        return None


# ─── 模块级共享事件循环（守护线程；全部通道的 WS 协程共用） ───
_loop: Optional[asyncio.AbstractEventLoop] = None
_loop_lock = threading.Lock()


def _get_loop() -> asyncio.AbstractEventLoop:
    global _loop
    with _loop_lock:
        if _loop is not None and _loop.is_running():
            return _loop
        loop = asyncio.new_event_loop()
        ready = threading.Event()

        def _run() -> None:
            asyncio.set_event_loop(loop)
            ready.set()
            loop.run_forever()

        threading.Thread(target=_run, name="SegmentChannelLoop", daemon=True).start()
        if not ready.wait(5.0):
            raise SegmentChannelError("切分通道事件循环启动失败")
        _loop = loop
    return _loop


def _run_sync(coro: Any, timeout: float) -> Any:
    """把协程投递到共享循环并同步等待（超时/异常统一折叠为通道错误）。"""
    loop = _get_loop()
    fut = asyncio.run_coroutine_threadsafe(coro, loop)
    try:
        return fut.result(timeout=timeout)
    except concurrent.futures.TimeoutError:
        fut.cancel()
        raise SegmentChannelError(f"内核切分通道操作超时({timeout}s)")
    except SegmentChannelError:
        raise
    except Exception as exc:
        raise SegmentChannelError(
            f"内核切分通道操作失败: {type(exc).__name__}: {str(exc)[:200]}"
        ) from exc


class SegmentChannel:
    """一条内核 segment 模式 WS 通道（生命周期 == 外层的一条虚拟流）。

    使用::

        ch = SegmentChannel(name=..., t0_ms=..., rms_threshold=..., ...)
        ch.open()                    # 建连 + session.start(mode=segment, t0)
        chunks = ch.push(pcm_bytes)  # 送帧 + 收割此刻已到达的 segment.closed
        chunks = ch.stop()           # session.stop 冲刷尾段并收集，随后关连接
        ch.drain_pending()           # 死亡后取回队列里未消费的段（artifact 仍在）
        ch.close()                   # 不发 stop 的静默弃连（降级/重建路径）

    任何失败置 ``dead``：此后除 close/drain_pending 外一律抛
    :class:`SegmentChannelError`。``dead`` 供调用方廉价探活。
    """

    def __init__(
        self,
        *,
        name: str = "",
        t0_ms: Optional[int] = None,
        sample_rate: int = 16000,
        bytes_per_sample: int = 2,
        rms_threshold: float = 5.0,
        frame_ms: int = 30,
        silence_cut_s: float = 1.5,
        min_chunk_s: float = 10.0,
        max_chunk_s: float = 120.0,
        client_provider: Optional[Callable[[], Any]] = None,
    ) -> None:
        """
        Args:
            name: 设备/会话标识（写入 session.start.device_id，内核侧仅溯源）。
            t0_ms: 时间轴锚（该流首样本的绝对 epoch 毫秒）；None=内核首帧墙钟。
            sample_rate/bytes_per_sample: 16000/2（内核 segment v1 仅接受 16k/16bit）。
            rms_threshold/frame_ms/silence_cut_s/min_chunk_s/max_chunk_s:
                透传给内核 segment 会话的切分参数（外层 audio.stream.* 映射）。
            client_provider: 内核客户端工厂（测试注入；缺省惰性取
                ``services.kernel_client.get_kernel_client`` 进程单例）。
        """
        if int(sample_rate) != 16000 or int(bytes_per_sample) != 2:
            # 内核 segment v1 固定 16k/16bit；非法参数是接线错误，立即暴露
            raise SegmentChannelError(
                f"内核 segment v1 仅支持 16000Hz/16bit，收到 {sample_rate}Hz/{bytes_per_sample}B"
            )
        self._name = str(name or "")
        self._t0_ms = None if t0_ms is None else int(t0_ms)
        self._sample_rate = int(sample_rate)
        self._bytes_per_sample = int(bytes_per_sample)
        self._segment_opts = {
            "rms_threshold": float(rms_threshold),
            "frame_ms": int(frame_ms),
            "silence_cut_s": float(silence_cut_s),
            "min_chunk_s": float(min_chunk_s),
            "max_chunk_s": float(max_chunk_s),
        }
        self._client_provider = client_provider

        self._conn: Any = None
        self._reader: Optional["asyncio.Task[None]"] = None
        self._events: "queue.Queue[Dict[str, Any]]" = queue.Queue(maxsize=_EVENT_QUEUE_MAXSIZE)
        self._odd: bytes = b""      # 半字节残余（内核拒奇数帧，跨 push 保留）
        self._abandoned = False     # open 超时放弃后，迟到的建连协程自关连接
        self.dead = False

    # ========== 生命周期 ==========

    @property
    def is_open(self) -> bool:
        """通道已建立且未降级（供调用方廉价判定）。"""
        return self._conn is not None and not self.dead

    def _client(self) -> Any:
        if self._client_provider is not None:
            return self._client_provider()
        from services import kernel_client as kc

        return kc.get_kernel_client()

    def open(self) -> None:
        """建立 WS 并完成 ``session.start``（mode=segment，显式 t0_ms）。

        失败（不可达/超时/error 帧）抛 :class:`SegmentChannelError` 并置死。
        """
        if self.dead:
            raise SegmentChannelError("切分通道已降级（dead），请重建")
        if self._conn is not None:
            return
        self._abandoned = False
        try:
            _run_sync(self._open_async(), _OPEN_BUDGET_S)
        except SegmentChannelError:
            self._abandoned = True
            self.dead = True
            raise

    async def _open_async(self) -> None:
        conn = await self._client().ws_connect_stream(timeout=_WS_HANDSHAKE_TIMEOUT)
        if conn is None:
            raise SegmentChannelError("内核 /v1/stream 连接不可用")
        if self._abandoned:
            # open 已被调用方超时放弃：不留悬空连接
            await conn.close()
            raise SegmentChannelError("切分通道建立已被放弃")
        start: Dict[str, Any] = {
            "type": "session.start",
            "device_id": self._name or "unknown",
            "sample_rate": self._sample_rate,
            "mode": "segment",
            "segment": dict(self._segment_opts),
        }
        if self._t0_ms is not None:
            start["t0_ms"] = int(self._t0_ms)
        try:
            await conn.send_json(start)
        except Exception as exc:
            await conn.close()
            raise SegmentChannelError(
                f"session.start 发送失败: {type(exc).__name__}: {str(exc)[:200]}"
            ) from exc
        self._conn = conn
        self._reader = asyncio.create_task(self._read_loop(conn))

    # ========== 数据面 ==========

    def push(self, pcm: bytes, *, first_wait: float = _PUSH_FIRST_WAIT_S) -> List[SegmentChunk]:
        """送一段 PCM 进内核切分，并收割此刻已到达的 ``segment.closed``。

        切点判定在内核即时发生，但回帧异步：本方法发送完成后最多再等
        ``first_wait`` 秒收第一帧，随后取空队列。未在此窗口到达的段由后续
        push/stop/drain 收割（时间为内核绝对轴，迟到不损害正确性）。

        Raises:
            SegmentChannelError: 未建立/已降级/发送失败（发送失败前已进内核
                与否不可知，调用方按"本段未送达"处理 + 镜像兜底）。
        """
        if self.dead:
            raise SegmentChannelError("切分通道已降级（dead），请重建")
        if self._conn is None:
            raise SegmentChannelError("切分通道未建立（先 open()）")
        buf = self._odd + bytes(pcm or b"")
        self._odd = b""
        if len(buf) % 2:
            self._odd, buf = buf[-1:], buf[:-1]
        if not buf:
            # 本次只凑出半个样本：攒着，仍收割已到帧
            return self._collect(first_wait)
        try:
            _run_sync(self._conn.send_bytes(buf), _SEND_TIMEOUT_S)
        except SegmentChannelError:
            self.dead = True
            raise
        return self._collect(first_wait)

    def stop(self, *, budget_s: float = _FLUSH_BUDGET_S) -> List[SegmentChunk]:
        """发 ``session.stop`` 冲刷尾段，静默轮询收完帧后关闭连接。

        幂等性由调用方保证（通道一次 stop）。未建立/已降级抛错；stop 帧
        发送失败时先收割队列，已取回的段挂 :class:`StopWithChunksError` 外抛。
        """
        if self.dead:
            raise SegmentChannelError("切分通道已降级（dead），无法 stop")
        if self._conn is None:
            raise SegmentChannelError("切分通道未建立，无法 stop")
        try:
            _run_sync(self._conn.send_json({"type": "session.stop"}), _SEND_TIMEOUT_S)
        except SegmentChannelError:
            self.dead = True
            collected = self._collect(0.0, allow_dead=True)   # 能取回的先取回
            self.close()
            if collected:
                raise StopWithChunksError(collected)
            raise
        chunks = self._collect_until_quiet(budget_s)
        self.close()
        return chunks

    def drain_pending(self) -> List[SegmentChunk]:
        """取回事件队列里已到达但未消费的段（通道已死也能取——artifact 是文件）。

        只处理队列当前快照；取回失败的那帧放回不弹（下次再取）。
        """
        return self._collect(0.0, allow_dead=True)

    def close(self) -> None:
        """静默弃连（不发 stop；内核丢弃未 stop 缓冲——调用方镜像兜底）。幂等。"""
        conn, reader = self._conn, self._reader
        self._conn, self._reader = None, None
        self._odd = b""
        if conn is None and reader is None:
            return
        try:
            loop = _get_loop()
        except Exception:
            return
        fut = asyncio.run_coroutine_threadsafe(self._close_async(conn, reader), loop)
        try:
            fut.result(timeout=2.0)
        except Exception:
            pass

    async def _close_async(self, conn: Any, reader: Any) -> None:
        if reader is not None:
            reader.cancel()
            try:
                await reader
            except (asyncio.CancelledError, Exception):
                pass
        if conn is not None:
            try:
                await conn.close()
            except Exception:
                pass

    # ========== 读循环与收帧 ==========

    async def _read_loop(self, conn: Any) -> None:
        """消费内核出站帧 -> 线程安全事件队列（唯一并发生产者）。"""
        def _put(evt: Dict[str, Any]) -> None:
            try:
                self._events.put_nowait(evt)
            except queue.Full:
                self.dead = True
                logger.error("[SegmentChannel] 事件队列溢出，通道降级（调用方镜像兜底）")

        try:
            while True:
                kind, data = await conn.receive(timeout=30.0)
                if kind == "timeout":
                    continue
                if kind in ("closed", "error"):
                    _put({"type": "_transport", "kind": kind})
                    return
                if kind != "text":
                    continue
                try:
                    frame = json.loads(data)
                except (TypeError, ValueError):
                    continue
                if not isinstance(frame, dict):
                    continue
                ftype = frame.get("type")
                if ftype == "segment.closed":
                    _put({
                        "type": "segment.closed",
                        "artifact": str(frame.get("artifact") or ""),
                        "start_ms": int(frame.get("start_ms") or 0),
                        "end_ms": int(frame.get("end_ms") or 0),
                        "seq": frame.get("seq"),
                    })
                elif isinstance(frame.get("error"), dict):
                    _put({
                        "type": "_error",
                        "code": str(frame["error"].get("code") or ""),
                    })
                # wakeup.hit / speaker.changed：segment 模式不会出现，忽略
        except asyncio.CancelledError:
            raise
        except Exception:
            _put({"type": "_transport", "kind": "exception"})

    def _collect(
        self, first_wait: float, *, allow_dead: bool = False
    ) -> List[SegmentChunk]:
        """收事件：首帧最多等 first_wait，随后取空；error/transport -> 置死。

        ``segment.closed`` 帧 -> 取回 artifact -> SegmentChunk；取回失败时
        **该帧放回队列**并置死停止（drain_pending 可重试），已成功的段照常返回。
        """
        if self.dead and not allow_dead:
            return []
        chunks: List[SegmentChunk] = []
        wait = max(first_wait, 0.0)
        while True:
            try:
                if wait <= 0:
                    evt = self._events.get_nowait()
                else:
                    evt = self._events.get(timeout=wait)
            except queue.Empty:
                break
            wait = 0.0
            ftype = evt.get("type")
            if ftype == "segment.closed":
                try:
                    chunks.append(self._fetch_chunk(evt))
                except SegmentChannelError as exc:
                    # 帧不丢：放回（尽力而为——队列满只能认丢，镜像兜底）
                    self.dead = True
                    try:
                        self._events.put_nowait(evt)
                    except queue.Full:
                        logger.error(
                            f"[SegmentChannel] artifact 取回失败且队列已满，本帧放弃: {exc}"
                        )
                    break
                continue
            if ftype in _INTERNAL_EVENTS:
                if ftype == "_error":
                    logger.error(
                        f"[SegmentChannel] 内核 error 帧 code={evt.get('code')!r}，通道降级"
                    )
                else:
                    logger.debug(
                        f"[SegmentChannel] 内核流关闭 kind={evt.get('kind')!r}，通道降级"
                    )
                self.dead = True
                break
            # 未知事件（理论不可达）：忽略继续
        return chunks

    def _collect_until_quiet(self, budget_s: float) -> List[SegmentChunk]:
        """静默轮询收帧：连续一轮 quiet 无新帧即结束（stop 尾段通常一帧即全）。"""
        deadline = time.monotonic() + budget_s
        chunks: List[SegmentChunk] = []
        while time.monotonic() < deadline:
            got = self._collect(_FLUSH_QUIET_S)
            chunks.extend(got)
            if self.dead or not got:
                break
        return chunks

    # ========== artifact 取回 / 删除 ==========

    def _fetch_chunk(self, evt: Dict[str, Any]) -> SegmentChunk:
        artifact_id = str(evt.get("artifact") or "")
        if not artifact_id.startswith("art_"):
            raise SegmentChannelError(f"artifact id 非法: {artifact_id!r}")
        wav_bytes = self._fetch_artifact(artifact_id)
        pcm = _wav_to_pcm(wav_bytes)
        if pcm is None:
            raise SegmentChannelError(f"artifact {artifact_id} 不是可解析的 WAV")
        self._delete_artifact(artifact_id)
        return SegmentChunk(
            pcm=pcm,
            start_ms=int(evt.get("start_ms") or 0),
            end_ms=int(evt.get("end_ms") or 0),
            sample_count=len(pcm) // self._bytes_per_sample,
        )

    def _fetch_artifact(self, artifact_id: str) -> bytes:
        """GET /v1/artifacts/{id} -> content_b64 解码；传输类异常重试一次。"""
        from services import kernel_client as kc

        path = "/v1/artifacts/%s" % artifact_id
        last_exc: Optional[Exception] = None
        for _attempt in range(2):
            try:
                body = self._client().srequest("GET", path, timeout=_FETCH_TIMEOUT_S)
                b64 = (body or {}).get("content_b64")
                if not b64:
                    raise SegmentChannelError(f"artifact {artifact_id} 响应缺少 content_b64")
                return base64.b64decode(b64)
            except kc.KernelUnavailable as exc:
                last_exc = exc
                continue
            except kc.KernelHttpError as exc:
                raise SegmentChannelError(
                    f"artifact {artifact_id} 取回失败: {exc}"
                ) from exc
            except SegmentChannelError:
                raise
            except Exception as exc:
                raise SegmentChannelError(
                    f"artifact {artifact_id} 取回异常: {type(exc).__name__}: {str(exc)[:200]}"
                ) from exc
        raise SegmentChannelError(f"artifact {artifact_id} 取回失败（重试后）: {last_exc}")

    def _delete_artifact(self, artifact_id: str) -> None:
        """删除已消费的内核 artifact（P3-V15：契约面 HTTP DELETE，根除 W2 跨进程 rm）。

        ``DELETE /v1/artifacts/{id}``（P3-K2a，契约 §8.1）幂等：不存在/二次删
        也返回 200 ``{id, deleted:false}``，"消费即删"重试无需特判。200 恒成功
        语义下失败处置对齐 K2a 裁定——**一律 WARNING-only，不抛错、不置死**
        （段已取回，删除失败不影响本帧交付）；401/403/503 真异常路径维持
        现处置（告警不阻断，残余有界：max_chunk × 流寿命）。

        运行期存在性锚裁定（V15）：外层无现成 caps 缓存查询机制，直连
        DELETE——旧内核无此路由对 GET-only 路径回 405（路径整体缺失则 404），
        同样 WARNING，残留交内核启动清扫（K2a §8 生命周期）；绝不回退
        文件直删（那是 W2 本身）。caps ``artifacts.delete`` kind 为部署面
        校验锚（§8.1：旧内核不得依赖 HTTP 删除），运行期由本告警兜住窗口。
        """
        from services import kernel_client as kc

        path = "/v1/artifacts/%s" % artifact_id
        try:
            self._client().srequest("DELETE", path, timeout=_DELETE_TIMEOUT_S)
        except kc.KernelHttpError as exc:
            # 405/404=旧内核不支持（残留交启动清扫）；401/403/503=真异常路径
            # 维持现处置：告警不阻断。KernelHttpError 字符串自带 status。
            logger.warning(
                f"[SegmentChannel] artifact HTTP 删除失败（忽略，残留交内核启动清扫）: "
                f"{artifact_id}: {exc}"
            )
        except Exception as exc:
            # 传输类（KernelUnavailable 等）：与旧实现 OSError 同口径
            logger.warning(
                f"[SegmentChannel] artifact HTTP 删除异常（忽略）: "
                f"{artifact_id}: {type(exc).__name__}: {str(exc)[:200]}"
            )


__all__ = [
    "SegmentChannel",
    "SegmentChannelError",
    "StopWithChunksError",
    "SegmentChunk",
]
