# -*- coding: utf-8 -*-
"""
音频流 WebSocket 路由 - /ws/audio-stream

接收 Android 客户端的连续 PCM 音频流，按「每连接一个会话」的方式驱动
物理切分、WAV 落盘与单 worker 分析队列。旧 multipart 上传路径保持不变。

鉴权：优先一次性 ticket（?ticket=），其次 token（OQ2 后 voice_assistant_ws 已删，本路由沿用其鉴权模式）；
      先验证后 accept，失败以 1008（policy violation）关闭。

协议（方案第 5 节）：
    Client -> Server:
        - 二进制帧：PCM s16le（建议 100ms/帧，3200B）
        - {"type":"hello","device_id":"...","sample_rate":16000,"channels":1}
        - {"type":"audio_start","session_id":"...","seq":0,"start_wall_ms":<epoch_ms>}
        - {"type":"audio_start","session_id":"...","start_wall_ms":<epoch_ms>,"local_hit":true,"keyword":"小贺同学","confidence":0.97}
          （端侧 KWS 命中：跳过服务端 KWS 解码，直接进入声纹进门验证 -> 录制；
            keyword/confidence 可选，与内核 /v1/stream 的 wakeup.hit 帧字段对齐
            （confidence 收进 [0,1]）；keyword 缺省为服务端目标唤醒词。
            该会话不运行服务端 KWS 解码）
        - {"type":"audio_stop"}
        - {"type":"ping"}
    Server -> Client:
        - {"type":"connected","session_id":"..."}
        - {"type":"wake","stage":"start","keyword":"小贺同学"}   唤醒确认（进门验证通过）
        - {"type":"wake","stage":"end","reason":"vad_silence"}   录制结束（reason: vad_silence/voiceprint_low/hard_limit）
        - {"type":"throttle"}          服务端过载，请客户端转本地缓存
        - {"type":"audio_stopped"}
        - {"type":"pong"}
        - {"type":"error","message":"..."}

内核桥接（B1: 手机协议零变化，KWS 检测只在内核）：
    audio_start 后把 PCM 并行转发内核 ``/v1/stream``（KWS 全速在内核跑），
    内核 ``wakeup.hit {keyword, confidence}`` -> ``trigger_local_hit``（K4c
    已锁）驱动同一状态机，wake 回帧照旧经 _emit_wake_event 回手机。
    **B1 起外层零本地算法**：内核不可达/中途失败一律「降级不唤醒」——
    限频 ERROR 告警，会话可继续（pre-roll/录制状态机照跑）但服务端不做
    唤醒检测；App 侧 5s 收不到 wake/start 自会兜底退出（既有契约）。
    local_hit=true 直通路径（端侧唤醒）本就不依赖服务端 KWS，不受降级影响
    （但其进门验证同样要求内核可达——fail-closed 由 wake 层保证）。
    手机 token 与内核 token 两套独立，严禁混用（内核地址/凭证只来自
    kernel_client）。

依赖：只依赖轻量模块；重服务全部在会话/队列内部惰性导入。
"""

from __future__ import annotations

import asyncio
import json
import logging
import threading
import time
import uuid
from typing import Any, Callable, Dict, Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from auth import TICKET_SCOPE_GENERIC, verify_token, consume_ws_ticket

logger = logging.getLogger(__name__)

router = APIRouter(tags=["audio-stream-websocket"])

# 内核流建连总预算（含 ensure/spawn）：超时视为内核不可达 -> 降级不唤醒
_KERNEL_CONNECT_BUDGET_S = 5.0
# 单帧转发超时：内核停顿时不拖死手机上行（超时即关闭内核连接，停止转发）
_KERNEL_FORWARD_TIMEOUT_S = 2.0
# 内核 error 帧触发降级（关连接、停止转发）的封闭码；其余只记日志、会话照旧
_KERNEL_DEGRADE_CODES = frozenset({
    "model.unavailable",
    "state.unavailable",
    "auth.failed",
})


# 内核降级告警限频（B1: 降级=不唤醒，必须可被运维感知但不许刷屏）
_kernel_warn_lock = threading.Lock()
_kernel_warn_ts = 0.0
_KERNEL_WARN_INTERVAL_S = 60.0


def _warn_kernel_no_wake(reason: str) -> None:
    """内核不可用 -> 降级不唤醒的限频 ERROR（整个进程 60s 最多一条）。"""
    global _kernel_warn_ts
    now = time.monotonic()
    with _kernel_warn_lock:
        if now - _kernel_warn_ts < _KERNEL_WARN_INTERVAL_S:
            return
        _kernel_warn_ts = now
    logger.error(
        f"[AudioStreamWS] 内核不可用，唤醒链降级为不唤醒（限频60s，App 5s 兜底退出）: {reason}"
    )


class _KernelStreamBridge:
    """内核 ``/v1/stream`` 桥接（B1）：一会话一内核连接，失败即降级不唤醒。

    职责边界（与 AudioStreamSession 不重叠）：
      - KWS 检测唯一路径：转发手机 PCM、消费 ``wakeup.hit`` -> 注入的命中回调
        （路由侧接到 ``wake_state.trigger_local_hit``）；
      - ``segment.closed`` / ``speaker.changed`` 与外层切分/声纹职责重叠
        -> 丢弃（debug log）；
      - 内核 ``error`` 帧记日志；``model.unavailable`` 等封闭码触发降级
        （关连接、本会话不再转发=不唤醒）；
      - 任何失败不抛异常、不阻断手机音频链路（pre-roll/会话/上行照常），
        仅停止唤醒检测；连接关闭即隐式结束内核会话（内核 handle_disconnect
        复位，无需补发 stop）。降级信号统一经 ``on_degraded`` 回调（限频告警）。
    """

    def __init__(
        self,
        on_wakeup_hit: Callable[[str, Optional[float]], None],
        *,
        client_provider: Optional[Callable[[], Any]] = None,
        on_degraded: Optional[Callable[[str], None]] = None,
    ) -> None:
        """
        Args:
            on_wakeup_hit: ``wakeup.hit`` 命中回调 ``(keyword, confidence)``，
                路由侧注入 -> ``wake_state.trigger_local_hit``。
            client_provider: 内核客户端工厂（测试注入；缺省惰性取单例）。
            on_degraded: 内核不可用降级回调（reason 字符串），路由侧注入
                限频告警；缺省走模块级 ``_warn_kernel_no_wake``。
        """
        self._on_hit = on_wakeup_hit
        self._client_provider = client_provider
        self._on_degraded = on_degraded or _warn_kernel_no_wake
        self._conn: Any = None
        self._reader: Optional["asyncio.Task[None]"] = None
        self._started = False

    @property
    def available(self) -> bool:
        """内核连接当前可用（转发前的廉价检查）。"""
        conn = self._conn
        return conn is not None and not conn.closed

    def _client(self) -> Any:
        if self._client_provider is not None:
            return self._client_provider()
        from services import kernel_client as kc

        return kc.get_kernel_client()

    async def start(self, device_id: str) -> bool:
        """连接内核并发 ``session.start``；任何失败返回 False（不抛）。

        失败 = 降级信号（不唤醒）：调用方不保留桥，本会话不再有命中来源；
        wake_state 仍处理 pre-roll/上行，但检测态永不收到命中登记。
        """
        try:
            # 总预算包住 ws_connect_stream（其 ensure/spawn 可能耗秒级）
            conn = await asyncio.wait_for(
                self._client().ws_connect_stream(),
                timeout=_KERNEL_CONNECT_BUDGET_S,
            )
        except Exception as exc:
            self._on_degraded(
                f"内核流连接失败: {type(exc).__name__}: {str(exc)[:200]}"
            )
            return False
        if conn is None:
            self._on_degraded("内核流不可用（握手失败/传输异常）")
            return False
        self._conn = conn
        try:
            await conn.send_json({
                "type": "session.start",
                "device_id": device_id or "unknown",
                # 内核 v1 仅接受 16000（stream/session.py 契约）
                "sample_rate": 16000,
            })
        except Exception as exc:
            self._on_degraded(
                f"内核 session.start 失败: {type(exc).__name__}: {str(exc)[:200]}"
            )
            await self._close_conn(conn)
            return False
        self._started = True
        self._reader = asyncio.create_task(self._read_loop())
        return True

    async def forward(self, pcm: bytes) -> None:
        """把手机 PCM 转发内核；不可用静默跳过，发送失败关连接停转发（不抛）。"""
        conn = self._conn
        if conn is None or conn.closed:
            return
        try:
            await asyncio.wait_for(
                conn.send_bytes(pcm), timeout=_KERNEL_FORWARD_TIMEOUT_S
            )
        except Exception as exc:
            self._on_degraded(
                f"内核流转发失败: {type(exc).__name__}: {str(exc)[:200]}"
            )
            await self._close_conn(conn)

    async def stop(self) -> None:
        """audio_stop/断线收尾：发 ``session.stop`` -> 停读循环 -> 关连接。

        幂等：连接已降级（为 None）时无操作——内核侧断连即复位会话。
        """
        conn, self._conn = self._conn, None
        reader, self._reader = self._reader, None
        started, self._started = self._started, False
        if conn is None:
            if reader is not None:
                reader.cancel()
            return
        if started:
            # 先发 stop（读循环仍在消费回帧），再取消读循环、关连接
            try:
                await conn.send_json({"type": "session.stop"})
            except Exception as exc:
                logger.debug(
                    f"[AudioStreamWS] 内核 session.stop 发送失败（忽略）: {exc}"
                )
        if reader is not None:
            reader.cancel()
            try:
                await reader
            except (asyncio.CancelledError, Exception):
                pass
        try:
            await conn.close()
        except Exception as exc:
            logger.debug(f"[AudioStreamWS] 内核流关闭失败（忽略）: {exc}")

    # ---------------- 读循环（内核出站帧消费） ----------------

    async def _read_loop(self) -> None:
        """消费内核出站帧：wakeup.hit 派发；其余按契约处理。"""
        conn = self._conn
        if conn is None:
            return
        cancelled = False
        try:
            while True:
                kind, data = await conn.receive()
                if kind == "text":
                    if not self._handle_text(str(data)):
                        break  # 降级码 -> 关连接，本会话停止唤醒检测
                elif kind in ("closed", "error"):
                    logger.debug(
                        f"[AudioStreamWS] 内核流关闭 kind={kind}（本会话不再唤醒）"
                    )
                    break
                # binary/timeout: 内核出站只有 JSON 帧，忽略继续等
        except asyncio.CancelledError:
            cancelled = True
            raise
        except Exception as exc:
            self._on_degraded(
                f"内核流读取异常: {type(exc).__name__}: {str(exc)[:200]}"
            )
        finally:
            if not cancelled:
                # 对端关闭/错误帧降级：释放连接防泄漏（stop 幂等无操作）
                await self._close_conn(conn)

    def _handle_text(self, data: str) -> bool:
        """处理一帧内核 JSON 出站。返回 False = 读循环应退出（降级）。"""
        try:
            frame = json.loads(data)
        except (TypeError, ValueError):
            logger.debug("[AudioStreamWS] 内核流非法 JSON 帧已忽略")
            return True
        if not isinstance(frame, dict):
            return True
        ftype = frame.get("type")
        if ftype == "wakeup.hit":
            keyword = str(frame.get("keyword") or "")
            conf_raw = frame.get("confidence")
            try:
                confidence = None if conf_raw is None else float(conf_raw)
            except (TypeError, ValueError):
                confidence = None
            try:
                self._on_hit(keyword, confidence)
            except Exception as exc:
                logger.warning(
                    f"[AudioStreamWS] 内核命中分发失败（忽略）: {exc}"
                )
            return True
        if ftype in ("segment.closed", "speaker.changed"):
            # 与 AudioStreamSession 切分/声纹职责重叠 -> 丢弃
            logger.debug(f"[AudioStreamWS] 内核流帧已丢弃 type={ftype}")
            return True
        if "error" in frame:
            err = frame.get("error")
            code = str(err.get("code") or "") if isinstance(err, dict) else ""
            logger.warning(
                f"[AudioStreamWS] 内核流 error 帧 code={code} "
                f"message={str(err.get('message') if isinstance(err, dict) else '')[:120]}"
            )
            if code in _KERNEL_DEGRADE_CODES:
                self._on_degraded(f"内核流降级码 {code}（本会话停止唤醒检测）")
                return False
            return True
        logger.debug(f"[AudioStreamWS] 内核流未知帧 type={ftype!r} 已忽略")
        return True

    async def _close_conn(self, conn: Any) -> None:
        """释放单条连接（幂等；读循环降级与 stop 收尾共用）。"""
        if self._conn is conn:
            self._conn = None
        self._started = False
        try:
            await conn.close()
        except Exception:
            pass


@router.websocket("/ws/audio-stream")
async def audio_stream_ws(websocket: WebSocket):
    """WebSocket 端点 - 音频流式上行。"""
    # Token 认证：WS 请求不走 AuthMiddleware，必须在端点内验证。
    # 优先一次性 ticket；其次查询参数或 Authorization 头中的 token。
    # 先验证后 accept，未通过则直接以 1008 关闭，不完成握手。
    ticket = websocket.query_params.get("ticket") or ""
    if ticket:
        is_valid, _user_id = consume_ws_ticket(
            ticket, required_scope=TICKET_SCOPE_GENERIC
        )
    else:
        token = websocket.query_params.get("token") or ""
        auth_header = websocket.headers.get("Authorization", "")
        if auth_header.startswith("Bearer "):
            token = token or auth_header[7:]
        is_valid, _user_id = verify_token(token)
    if not is_valid:
        await websocket.close(code=1008)
        return

    # 会话级惰性导入，避免启动时加载重依赖
    from services.audio_stream_session import AudioStreamSession
    from services import wake_word_service

    await websocket.accept()

    # 服务端生成的会话 ID（hello 时下发，audio_start 未带 session_id 时兜底）
    session_id = uuid.uuid4().hex
    device_id = ""
    session: AudioStreamSession | None = None
    # 唤醒词检测态（每连接独立，非阻塞投递，与现有分析链路并行）
    wake_state: wake_word_service.WakeWordState | None = None
    # 内核 /v1/stream 桥（与 wake_state 同生命周期；None = 降级不唤醒）
    kernel_bridge: _KernelStreamBridge | None = None

    logger.info(f"[AudioStreamWS] 新音频流连接 session={session_id}")

    async def _safe_send(payload: dict) -> None:
        """发送 JSON，连接已关闭时仅记录调试日志。"""
        try:
            await websocket.send_json(payload)
        except Exception as e:
            logger.debug(f"[AudioStreamWS] 发送失败: {e}")

    def _emit_wake_event(event: str, payload: Dict[str, Any]) -> None:
        """唤醒事件回调：运行在 wake 工作线程中，调度到主事件循环发送提示信号。

        约定帧格式（服务端 -> 客户端文本帧）：
            {"type": "wake", "stage": "start", "keyword": "小贺同学"}
            {"type": "wake", "stage": "end", "reason": "vad_silence"}
        工作线程不能 await，故经 event_loop_manager 取主循环 +
        run_coroutine_threadsafe 投递。任何失败都只告警，绝不影响音频链路。
        """
        try:
            if event == "wake_start":
                frame = {
                    "type": "wake",
                    "stage": "start",
                    "keyword": payload.get("keyword", ""),
                }
            elif event == "wake_end":
                frame = {
                    "type": "wake",
                    "stage": "end",
                    "reason": payload.get("reason", ""),
                }
            elif event == "kws_test_result":
                # 测试模式：payload 直接作为帧体回推（不投递 AI）
                frame = {"type": "kws_test_result", **(payload or {})}
            else:
                return
            from services.event_loop_manager import get_main_loop

            loop = get_main_loop()
            if loop is None or not loop.is_running():
                logger.warning("[AudioStreamWS] 主事件循环不可用，唤醒提示信号未发送")
                return
            asyncio.run_coroutine_threadsafe(_safe_send(frame), loop)
        except Exception as e:
            logger.warning(f"[AudioStreamWS] 唤醒提示信号发送失败（忽略）: {e}")

    def _on_kernel_wakeup_hit(keyword: str, confidence: float | None) -> None:
        """内核 ``wakeup.hit {keyword, confidence}`` -> 同一状态机入口。

        走 ``trigger_local_hit``（L582 签名，K4c 契约由
        test_local_hit_contract.py 锁定）；后续 detect -> verify -> record
        与端侧命中完全同链路，wake 回帧照旧经 _emit_wake_event 回手机。
        读取的是循环内最新 wake_state（audio_stop 后释放 -> 忽略迟到命中）。
        """
        st = wake_state
        if st is None:
            logger.debug("[AudioStreamWS] 内核命中但唤醒态已释放，忽略")
            return
        try:
            st.trigger_local_hit(keyword or None, confidence=confidence)
        except Exception as e:
            logger.warning(
                f"[AudioStreamWS] 内核命中登记失败（不影响分析链路）: {e}"
            )

    try:
        while True:
            message = await websocket.receive()

            # 忽略断开事件（Starlette 会下发 websocket.disconnect）。
            # 若不在此处跳出循环而继续 receive()，会抛出
            # RuntimeError: Cannot call "receive" once a disconnect message has been received.
            if isinstance(message, dict) and message.get("type") == "websocket.disconnect":
                break

            if message.get("text") is not None:
                # ---- 文本：JSON 控制消息 ----
                try:
                    msg_data = json.loads(message["text"])
                except json.JSONDecodeError:
                    await _safe_send({"type": "error", "message": "无效的 JSON 格式"})
                    continue

                msg_type = msg_data.get("type", "")

                if msg_type == "hello":
                    # 握手：记录设备标识并回传服务端会话 ID
                    device_id = msg_data.get("device_id", "") or ""
                    await _safe_send({"type": "connected", "session_id": session_id})
                    logger.info(f"[AudioStreamWS] hello device={device_id}")

                elif msg_type == "audio_start":
                    # 开始推流：用客户端携带的绝对起始时间建立会话
                    start_wall_ms = msg_data.get("start_wall_ms")
                    # 测试模式：命中后不投递 AI、不落盘，仅回推 KWS 结果与参数快照
                    test_mode = bool(msg_data.get("test", False))
                    # 端侧 KWS 命中：跳过服务端 KWS 解码，直接进入
                    # 声纹进门验证 -> 录制（VAD / 声纹端点）链路；keyword 可选
                    local_hit = bool(msg_data.get("local_hit", False))
                    local_keyword = str(msg_data.get("keyword") or "").strip()
                    # K4b wakeup.hit 对齐: 可选 confidence [0,1] 一并驱动状态机
                    # （trigger_local_hit 内收进 0-1，非法值降 None，仅观测）
                    local_conf_raw = msg_data.get("confidence")
                    if local_conf_raw is None:
                        local_confidence = None
                    else:
                        try:
                            local_confidence = float(local_conf_raw)
                        except (TypeError, ValueError):
                            local_confidence = None
                    if start_wall_ms is None:
                        await _safe_send(
                            {"type": "error", "message": "audio_start 缺少 start_wall_ms"}
                        )
                        continue
                    # 已有会话未结束时先冲刷，避免泄漏（C5: feed/finish 含内核
                    # 切分通道的阻塞 IO，统一丢线程池执行，不卡手机 WS 事件循环）
                    if session is not None:
                        await asyncio.to_thread(session.finish)
                    # 上一轮内核桥未收尾则先停（一会话一内核连接，防泄漏）
                    if kernel_bridge is not None:
                        try:
                            await kernel_bridge.stop()
                        except Exception as e:
                            logger.debug(f"[AudioStreamWS] 旧内核桥释放失败: {e}")
                        kernel_bridge = None
                    sid = msg_data.get("session_id") or session_id
                    session = AudioStreamSession(
                        device_id=device_id,
                        session_id=sid,
                        start_wall_ms=int(start_wall_ms),
                    )
                    # 唤醒检测态：与音频会话同生命周期；失败不影响主链路
                    if wake_state is not None:
                        try:
                            await asyncio.to_thread(wake_state.close)
                        except Exception as e:
                            logger.debug(f"[AudioStreamWS] 旧唤醒态释放失败: {e}")
                        wake_state = None
                    try:
                        # 唤醒态仅管理 pre-roll/状态机（零本地模型）；KWS 检测
                        # 在内核 /v1/stream。local_hit=True 时为端侧命中直通。
                        wake_state = await asyncio.to_thread(
                            wake_word_service.start_state,
                            device_id,
                            sid,
                            int(start_wall_ms),
                            _emit_wake_event,
                            test_mode,
                            local_hit,
                        )
                    except Exception as e:
                        logger.warning(f"[AudioStreamWS] 启动唤醒检测失败（不影响分析链路）: {e}")
                        wake_state = None
                    # 端侧命中：登记待处理命中，由唤醒状态机在检测态消费
                    # （与内部 KWS 命中走完全相同的下游链路）
                    if wake_state is not None and local_hit:
                        try:
                            wake_state.trigger_local_hit(
                                local_keyword or None,
                                confidence=local_confidence,
                            )
                        except Exception as e:
                            logger.warning(
                                f"[AudioStreamWS] 本地命中登记失败（不影响分析链路）: {e}"
                            )
                    logger.info(
                        f"[AudioStreamWS] audio_start session={sid} "
                        f"start_wall_ms={start_wall_ms} wake={wake_state is not None} "
                        f"local_hit={local_hit}"
                    )
                    # B1: 内核 /v1/stream 桥（KWS 唯一检测路径）——与 wake_state
                    # 同生命周期。唤醒态未建立（wake_word 关闭/启动失败）时不建
                    # 连接：命中无消费方，且不为死会话 spawn 内核。建桥失败 ->
                    # 本会话不保留桥 = **降级不唤醒**（限频 ERROR 已在桥内记录；
                    # App 5s 收不到 wake/start 自会兜底退出，pre-roll/上行不受影响）。
                    if wake_state is not None:
                        bridge = _KernelStreamBridge(_on_kernel_wakeup_hit)
                        if await bridge.start(device_id or sid):
                            kernel_bridge = bridge

                elif msg_type == "audio_stop":
                    # 主动停流：冲刷尾段并回复（阻塞 IO 丢线程池，见上）
                    if session is not None:
                        await asyncio.to_thread(session.finish)
                        session = None
                    # 内核桥收尾：session.stop -> 关连接（读循环在 stop 内取消）
                    if kernel_bridge is not None:
                        try:
                            await kernel_bridge.stop()
                        except Exception as e:
                            logger.debug(f"[AudioStreamWS] 内核桥收尾失败: {e}")
                        kernel_bridge = None
                    if wake_state is not None:
                        try:
                            await asyncio.to_thread(wake_state.close)
                        except Exception as e:
                            logger.debug(f"[AudioStreamWS] 唤醒态释放失败: {e}")
                        wake_state = None
                    await _safe_send({"type": "audio_stopped"})
                    logger.info("[AudioStreamWS] audio_stop 已冲刷尾段")

                elif msg_type == "ping":
                    await _safe_send({"type": "pong"})

                else:
                    await _safe_send(
                        {"type": "error", "message": f"未知消息类型: {msg_type}"}
                    )

            elif message.get("bytes") is not None:
                # ---- 二进制：PCM 帧 ----
                if session is None:
                    await _safe_send(
                        {"type": "error", "message": "收到音频帧但尚未 audio_start"}
                    )
                    continue
                raw = bytes(message["bytes"])
                # 唤醒状态机投递：非阻塞，承担 pre-roll 环形缓冲（进门验证与
                # 录制起点的音频来源）+ verify/record 状态推进；B1 起不再做任何
                # 本地解码。
                if wake_state is not None:
                    try:
                        wake_state.feed(raw)
                    except Exception as e:
                        logger.debug(f"[AudioStreamWS] 唤醒投递失败（忽略）: {e}")
                # B1: KWS 唯一检测路径 = 转发内核 /v1/stream。
                # 内核桥不可用（未建/已降级为 None）-> 本会话不唤醒（无命中来源），
                # pre-roll/上行/会话分析完全不受影响（fail-closed 只在唤醒动作上）。
                # local_hit 会话的桥命中与端侧登记重复触发由 trigger_local_hit
                # 的 pending 去重兜底（与旧行为一致）。
                if kernel_bridge is not None:
                    await kernel_bridge.forward(raw)
                try:
                    # C5: 切分计算在内核（segment 通道）；feed 含阻塞投递，丢线程池
                    signal = await asyncio.to_thread(session.feed, raw)
                except Exception as e:
                    logger.error(f"[AudioStreamWS] 处理音频帧失败: {e}", exc_info=True)
                    await _safe_send({"type": "error", "message": f"音频处理失败: {e}"})
                    continue
                if signal == "throttle":
                    # 服务端过载：要求客户端转本地缓存
                    await _safe_send({"type": "throttle"})

    except WebSocketDisconnect:
        logger.info(f"[AudioStreamWS] 客户端断开 session={session_id}")
    except Exception as e:
        logger.error(f"[AudioStreamWS] 连接异常: {e}", exc_info=True)
    finally:
        # 内核桥收尾 / 会话冲刷 / 唤醒态释放：对宿主取消鲁棒（见 _shield 注释）。
        # TestClient 在收到 disconnect 后会取消本协程所在的 anyio cancel
        # scope（生产 uvicorn 无此行为），清理段绝不因此半途而废。
        async def _shield(aw) -> None:
            """跑一段清理协程：宿主被取消时该段在后台继续跑完，吞掉取消。

            shield 的内部任务不在宿主 cancel scope 的直接取消目标里，
            因此 session.stop / wake close 不会因端点被取消而泄漏。
            """
            try:
                await asyncio.shield(aw)
            except asyncio.CancelledError:
                logger.debug("[AudioStreamWS] 清理段遇宿主取消，后台任务继续")

        # 断线/异常都必须冲刷尾段，避免丢尾部语音（C5: feed/finish 含内核
        # 切分通道的阻塞 IO，丢线程池执行并包 _shield——宿主取消不半途而废）
        if session is not None:
            try:
                await _shield(asyncio.to_thread(session.finish))
                logger.info(f"[AudioStreamWS] 断线已冲刷尾段 session={session_id}")
            except Exception as e:
                logger.error(f"[AudioStreamWS] 尾段冲刷失败: {e}", exc_info=True)
            session = None

        if kernel_bridge is not None:
            bridge, kernel_bridge = kernel_bridge, None

            async def _stop_bridge() -> None:
                try:
                    await bridge.stop()
                except Exception as e:
                    logger.warning(
                        f"[AudioStreamWS] 内核桥断线收尾失败（忽略）: {e}"
                    )

            await _shield(_stop_bridge())
        # 唤醒态：停止/join 检测线程并释放 stream（防泄漏）
        if wake_state is not None:
            st, wake_state = wake_state, None

            async def _close_wake() -> None:
                try:
                    await asyncio.to_thread(st.close)
                except Exception as e:
                    logger.warning(f"[AudioStreamWS] 唤醒态释放失败: {e}")

            await _shield(_close_wake())
        logger.info(f"[AudioStreamWS] 连接已清理 session={session_id}")
