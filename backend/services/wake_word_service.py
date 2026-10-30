# -*- coding: utf-8 -*-
"""
服务端常驻唤醒词检测 + 语音指令采集。

对应 `.sisyphus/plans/voice-interaction.md` §2（已确认决策）/ §5（目标架构）/
§7 阶段 1-4。核心约定（B1 起：唤醒链算法全部上移内核，本模块零本地算法）：

  1. KWS 检测只在内核 ``WS /v1/stream``（由 ``routers/audio_stream_ws.py`` 的
     ``_KernelStreamBridge`` 桥接，命中经 ``trigger_local_hit`` 注入本状态机；
     端侧命中 local_hit 直通路径同样经该入口）。内核不可达 -> **降级不唤醒**
     （限频 ERROR 告警；App 侧 5s 收不到 wake/start 自会兜底退出，协议不变）。
  2. 进门/退出声纹打分走 ``services.kernel_client.score_all_v2``（同步评分
     垫片，内核 POST /v1/voiceprint/score；唤醒音频 collect=False 不进
     cohort）。内核不可达/注册为空 -> 打分恒空 -> 进门失败（fail-closed）。
  3. 录停后弱切分+ASR 走 ``services.kernel_job_client.run_audio_analysis_jobs``
     （kind=analyze.asr + options.weak_split 透传配置，长轮询收割 facts.text）。
     失败/不可达 -> 放弃本次指令并记日志，绝不回退本地 SenseVoice。
  4. 录制中尾静音判停走内核 ``POST /v1/inspect/vad_curve``（pyannote 域，
     曲线数学逐位对齐原本地实现：10s 窗、bucket 网格、阈值同配置）。
     失败/不可达 -> 本次判定跳过（与本地 pyannote 推理异常同语义）。
  5. 每连接 ``WakeWordState``：pre-roll 环形缓冲 + 有界投递队列；``feed()``
     永远非阻塞；丢帧只记告警（不再有本地解码流可污染）。
  6. 唤醒命中 -> 声纹进门验证（按 ``as_norm_on`` 切换阈值域）-> 开始录制。
  7. 进入录制态后先保证 ``min_record_ms``（默认 2500ms）内不做任何停止判定：
     用户通常要听到提示音才开始说话，若从命中起算保护会失效（含 pre-roll/验证音频）。
  8. 录制停止条件 **OR**：声纹持续低分 / 内核 VAD 静音 / 硬上限 30 分钟。
  9. 停止后：内核弱切分+ASR -> 场景前缀 -> main-task 主会话；空文本丢弃。

依赖方向：本模块只被 ``routers/audio_stream_ws.py`` 调用；内核客户端
（kernel_client / kernel_job_client）惰性导入，避免拖慢后端启动。
现有离线分析链路不受影响。
"""

from __future__ import annotations

import asyncio
import logging
import os
import queue
import threading
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Tuple

import numpy as np

from services.audio_codec import pcm_to_wav

logger = logging.getLogger(__name__)

# 命名兜底常量：仅当 audio_config 未提供对应键时使用（防御性，非调参入口）
_DEFAULT_SAMPLE_RATE = 16000
_DEFAULT_PRE_ROLL_MS = 800          # 命中前留存的音频长度（进门验证与录制起点）
_DEFAULT_FEED_QUEUE_MAXSIZE = 50    # 每连接投递队列帧数上限（约 5s @100ms/帧）
_SEND_TIMEOUT_S = 60                # 投递 main-task 的超时（秒）
_WORKER_JOIN_TIMEOUT_S = 3.0
_VAD_TICK_TIMEOUT_S = 5.0           # 录制中内核尾静音拉取的单次超时（秒）
_KERNEL_ASR_WAIT_S = 30             # 录停 ASR 作业单次长轮询挂起秒数（内核上限 30）
_KERNEL_ASR_DEADLINE_S = 120.0      # 录停 ASR 作业取齐总时限（覆盖 SenseVoice 首载）

# 默认唤醒词（与历史 小何同学 同音，功能等价，仅回显汉字不同）
_DEFAULT_TARGET_KEYWORD = "小贺同学"

# 运行时目标词表（模块级可变）：首项为主唤醒词，其余为可选别名。
# 由 set_target_keywords() 动态覆盖（如 App 同步唤醒词后）；默认与历史行为一致。
# 注意：使用小写可变列表（非大写常量），setter 原地更新，避免 global 重绑定。
_target_keywords: List[str] = [_DEFAULT_TARGET_KEYWORD]
_target_keywords_lock = threading.Lock()

# 配置模块由另一实施单元提供；缺失/异常时唤醒功能自动关闭，不拖垮后端启动
try:
    from services.audio_config import get_audio_config
except Exception:  # pragma: no cover - 配置模块缺失时降级
    get_audio_config = None  # type: ignore


# ============================ 配置读取 ============================

_cfg_warn_lock = threading.Lock()
_cfg_warned = False


def _warn_once(msg: str) -> None:
    """配置类告警只打一次，避免每帧刷屏。"""
    global _cfg_warned
    with _cfg_warn_lock:
        if not _cfg_warned:
            logger.warning(msg)
            _cfg_warned = True


# 内核不可达告警限频（降级路径可能每窗触发，必须限频）：{key: 上次输出时刻}
_kernel_warn_lock = threading.Lock()
_kernel_warn_ts: Dict[str, float] = {}
_KERNEL_WARN_INTERVAL_S = 60.0    # 同一类别每分钟最多一条 ERROR


def _warn_kernel_down(tag: str, detail: str) -> None:
    """内核不可达/失败限频告警（唤醒链降级不唤醒 / fail-closed 进门 / 判停跳过）。

    tag 为降级类别（wake/entry/exit/asr/vad/warm 等）；同一 tag 限频
    ``_KERNEL_WARN_INTERVAL_S`` 输出一条 ERROR，避免录制滑窗逐次刷屏。
    """
    import time as _time

    now = _time.monotonic()
    with _kernel_warn_lock:
        last = _kernel_warn_ts.get(tag, 0.0)
        if now - last < _KERNEL_WARN_INTERVAL_S:
            return
        _kernel_warn_ts[tag] = now
    logger.error(f"[WakeWord] 内核不可达/失败（{tag}，限频60s）: {detail}")


def _audio_cfg() -> Dict[str, Any]:
    """获取 audio 配置字典；任何异常降级为空 dict（唤醒关闭）。"""
    if get_audio_config is None:
        _warn_once("[WakeWord] audio_config 模块不可用，唤醒功能关闭")
        return {}
    try:
        cfg = get_audio_config()
        return cfg if isinstance(cfg, dict) else {}
    except Exception as e:
        _warn_once(f"[WakeWord] 读取 audio_config 失败，唤醒功能关闭: {e}")
        return {}


def is_enabled() -> bool:
    """唤醒功能总开关（audio.wake_word.enabled）。"""
    return bool((_audio_cfg().get("wake_word") or {}).get("enabled", False))


def get_target_keywords() -> List[str]:
    """返回当前运行时目标词表副本（线程安全）。"""
    with _target_keywords_lock:
        return list(_target_keywords)


def get_primary_keyword() -> str:
    """返回当前主唤醒词（词表首项）；词表异常为空时回退默认词。"""
    with _target_keywords_lock:
        return _target_keywords[0] if _target_keywords else _DEFAULT_TARGET_KEYWORD


def set_target_keywords(keywords) -> List[str]:
    """覆盖运行时目标词表并同步主唤醒词，返回生效后的词表。

    ``keywords`` 支持字符串或字符串列表；按调用顺序去空白、去重。空结果不生效
    （保持原词表，防止误清空）。
    """
    if isinstance(keywords, str):
        keywords = [keywords]
    cleaned: List[str] = []
    for k in (keywords or []):
        k = str(k).strip()
        if k and k not in cleaned:
            cleaned.append(k)
    if not cleaned:
        return get_target_keywords()
    with _target_keywords_lock:
        _target_keywords[:] = cleaned
    logger.info(f"[WakeWord] 运行时目标唤醒词已更新: {cleaned}")
    return list(cleaned)


@dataclass
class WakeParams:
    """单次唤醒配置的快照（创建连接时解析一次，录制期间保持不变）。

    B1 注：keywords_score / keywords_threshold 仅用于测试模式参数回显；
    KWS 解码与弱切分均已上移内核，本模块不再据此加载本地模型或做本地切分。
    """

    sample_rate: int
    pre_roll_ms: int
    feed_queue_maxsize: int
    keywords_score: float
    keywords_threshold: float
    entry_threshold_ready: float
    entry_threshold_cold: float
    exit_threshold: float
    exit_threshold_cold: float
    exit_hold_ms: int
    vad_silence_ms: int
    min_record_ms: int
    max_record_ms: int
    sliding_window_ms: int
    sliding_hop_ms: int
    vad_threshold: float
    vad_window_s: float
    vad_step_s: float
    vad_bucket_ms: int
    weak_split: Dict[str, Any] = field(default_factory=dict)


def _resolve_params() -> Optional[WakeParams]:
    """从 audio 配置解析参数快照；关键键缺失时返回 None（唤醒关闭并告警一次）。"""
    audio = _audio_cfg()
    wake = audio.get("wake_word") or {}
    if not wake:
        return None
    vad = audio.get("vad") or {}
    sliding = (audio.get("voiceprint") or {}).get("sliding") or {}
    stream = audio.get("stream") or {}
    try:
        entry_cold = float(wake["entry_threshold_cold"])
        return WakeParams(
            sample_rate=int(stream.get("sample_rate", _DEFAULT_SAMPLE_RATE)),
            pre_roll_ms=int(wake.get("pre_roll_ms", _DEFAULT_PRE_ROLL_MS)),
            feed_queue_maxsize=int(
                wake.get("feed_queue_maxsize", _DEFAULT_FEED_QUEUE_MAXSIZE)
            ),
            # KWS 调参键改为可选（缺省对齐内核内置常量），不再阻断唤醒启动
            keywords_score=float(wake.get("keywords_score", 1.8)),
            keywords_threshold=float(wake.get("keywords_threshold", 0.25)),
            entry_threshold_ready=float(wake["entry_threshold_ready"]),
            entry_threshold_cold=entry_cold,
            exit_threshold=float(wake["exit_threshold"]),
            # 冷启动域（raw 余弦）没有独立配置键时，复用进门冷阈值
            exit_threshold_cold=float(wake.get("exit_threshold_cold", entry_cold)),
            exit_hold_ms=int(wake["exit_hold_ms"]),
            vad_silence_ms=int(wake["vad_silence_ms"]),
            min_record_ms=int(wake["min_record_ms"]),
            max_record_ms=int(wake["max_record_ms"]),
            sliding_window_ms=int(sliding["window_ms"]),
            sliding_hop_ms=int(sliding["hop_ms"]),
            vad_threshold=float(vad["threshold"]),
            vad_window_s=float(vad["window_s"]),
            vad_step_s=float(vad["step_s"]),
            vad_bucket_ms=int(vad["bucket_ms"]),
            weak_split=dict(wake.get("weak_split") or {}),
        )
    except (KeyError, TypeError, ValueError) as e:
        _warn_once(f"[WakeWord] 唤醒配置不完整，功能关闭（缺少/非法键: {e}）")
        return None


# ============================ 音频工具 ============================


# 内核 analyze.asr 的 weak_split options 白名单（docs/kernel-contract.md §6 A6）；
# 外层配置多出的未知键必须剔除——内核对非法键直接 input.invalid 作业失败。
_WEAK_SPLIT_OPTION_KEYS = (
    "enabled", "window_ms", "low_energy_win_ms", "min_seg_ms", "max_seg_ms",
)


def _weak_split_options(cfg: Dict[str, Any]) -> Dict[str, Any]:
    """把 audio.wake_word.weak_split 配置整理为内核 options.weak_split。

    enabled 恒显式传入（内核缺省 false = 不切；与外层旧默认一致）；
    其余键仅在配置提供时透传，交由内核逐键校验。
    """
    opts: Dict[str, Any] = {"enabled": bool((cfg or {}).get("enabled", False))}
    for k in ("window_ms", "low_energy_win_ms", "min_seg_ms", "max_seg_ms"):
        if k in (cfg or {}):
            opts[k] = int(cfg[k])
    return opts


# ============================ 检测器注册表 ============================


class WakeWordDetector:
    """每连接唤醒态注册表。

    B1 起本模块不再持有本地 KWS 模型：唤醒检测只有两条入口——
      1. 内核 ``/v1/stream`` 的 ``wakeup.hit``（路由层 _KernelStreamBridge
         桥接，经 ``trigger_local_hit`` 注入）；
      2. 端侧命中直通（App ``local_hit=true``，同样经 ``trigger_local_hit``）。
    内核不可达时不做任何唤醒检测（降级不唤醒），由路由层记限频告警。
    """

    def __init__(self) -> None:
        self._states_lock = threading.Lock()
        self._states: Dict[str, "WakeWordState"] = {}

    def create_state(self, device_id: str, session_id: str,
                     start_wall_ms: int, p: WakeParams,
                     on_event: Optional[Callable[[str, Dict[str, Any]], None]] = None,
                     test_mode: bool = False,
                     local_hit: bool = False,
                     ) -> "WakeWordState":
        """创建并注册一个连接级唤醒态，开始工作面线程。

        ``on_event`` 为唤醒事件回调（工作线程调用，注入方负责线程安全），
        用于把 wake_start / wake_end 提示信号转交给 WebSocket 层。
        ``test_mode`` 为 True 时不投递 AI、不落盘，只回推 kws_test_result。
        ``local_hit`` 为 True 时整个会话由端侧 KWS 触发，服务端不做 KWS 解码。
        """
        st = WakeWordState(
            self, device_id, session_id, start_wall_ms, p,
            on_event=on_event, test_mode=test_mode, local_hit=local_hit,
        )
        with self._states_lock:
            self._states[session_id] = st
        return st

    def remove_state(self, session_id: str) -> None:
        with self._states_lock:
            self._states.pop(session_id, None)

    def active_count(self) -> int:
        with self._states_lock:
            return len(self._states)


# ============================ 连接级状态机 ============================

# 状态：detect（KWS 检测）/ verify（进门验证）/ record（录制中）


class WakeWordState:
    """单个 WebSocket 连接的唤醒状态机。

    生命周期：``create_state`` 启动工作面线程；``feed(pcm)`` 非阻塞投递；
    ``close()`` 停止并 join 线程、释放 stream，无泄漏。
    """

    def __init__(self, detector: WakeWordDetector, device_id: str, session_id: str,
                 start_wall_ms: int, p: WakeParams,
                 on_event: Optional[Callable[[str, Dict[str, Any]], None]] = None,
                 test_mode: bool = False,
                 local_hit: bool = False,
                 ) -> None:
        self._detector = detector
        # 唤醒事件回调（在工作线程中调用；None 表示不上报，回调异常不外溢）
        self._on_event = on_event
        # 测试模式：命中后不投递 AI、不落盘，仅把本次结果与参数快照回推给客户端
        self._test_mode = bool(test_mode)
        # 端侧命中模式标记：B1 起两条路径都不做服务端 KWS 解码（KWS 全在内核桥），
        # 该标记现仅决定 pre-roll 保留时长——端侧命中的唤醒词音频只存在于 App
        # 回填的 pre-roll 中并兼作进门验证样本，故保留 max(pre_roll_ms, 验证窗)。
        self._local_hit_mode = bool(local_hit)
        # 外部（端侧）命中登记：由 trigger_local_hit 写入、工作面线程在检测态消费
        # 形状 (keyword, confidence)——与 K4b /v1/stream wakeup.hit 帧字段对齐
        self._pending_local_hit: Optional[Tuple[str, Optional[float]]] = None
        self._pending_lock = threading.Lock()
        # 本次命中的唤醒词（内核命中与端侧命中共用同一后续链路，仅用于回显）
        self._current_keyword = get_primary_keyword()
        # 本次命中置信度 [0,1]（对齐 wakeup.hit confidence；内核 KWS 不暴露后验，
        # 命中恒 1.0 = 过阈值的确定命中，见内核 stream/kws.py 同约定）
        self._hit_confidence: Optional[float] = None
        self._device_id = device_id
        self._session_id = session_id
        self._start_wall_ms = int(start_wall_ms)
        self._p = p
        self._sr = int(p.sample_rate)

        self._closed = False
        self._close_lock = threading.Lock()
        self._drop_lock = threading.Lock()
        self._dropped = False

        self._queue: "queue.Queue[bytes]" = queue.Queue(maxsize=int(p.feed_queue_maxsize))
        self._stop = threading.Event()

        # pre-roll 环形缓冲（bytes），仅保留最近 pre_roll_ms。
        # 端侧命中模式（local_hit）下唤醒词音频只存在于 App 回填的 pre-roll 中，它同时
        # 充当声纹进门验证的样本，因此保留时长必须至少覆盖验证窗口（sliding_window_ms）。
        # 否则验证窗口会退化为「命中之后的音频」：只说唤醒词时窗口内是静音，声纹必然不过。
        retention_ms = p.pre_roll_ms
        if self._local_hit_mode:
            retention_ms = max(p.pre_roll_ms, p.sliding_window_ms)
        self._pre_roll: "deque[bytes]" = deque()
        self._pre_roll_bytes = 0
        self._pre_roll_limit = max(2, int(self._sr * retention_ms / 1000.0) * 2)

        # 状态机字段
        self._state = "detect"
        self._total_samples = 0

        # 测试模式观测数据（仅在 test_mode 下填充）
        self._entry_score = 0.0
        self._entry_as_norm: Optional[bool] = None
        self._vp_scores: List[float] = []

        # verify：进门验证音频（pre-roll + 命中后补充）
        self._verify_pcm: List[bytes] = []
        self._verify_bytes = 0
        self._verify_min_bytes = max(2, int(self._sr * p.sliding_window_ms / 1000.0) * 2)

        # record：完整录制 + 两个滚动缓冲（VAD 10s / 声纹滑窗）
        self._record_pcm: List[bytes] = []
        self._record_samples = 0
        # 进入录制态（提示音下发）后累计的样本数：唤醒后最短录音保护的作用域
        self._record_state_samples = 0
        self._record_start_wall_ms = 0
        self._speaker_name = "用户"
        self._vad_buf = bytearray()
        self._vp_buf = bytearray()
        self._vad_buf_limit = max(2, int(self._sr * p.vad_window_s) * 2)
        self._vp_buf_limit = max(2, int(self._sr * p.sliding_window_ms / 1000.0) * 2)
        self._vad_step_bytes = max(2, int(self._sr * p.vad_step_s) * 2)
        self._vp_hop_bytes = max(2, int(self._sr * p.sliding_hop_ms / 1000.0) * 2)
        self._vad_tick_bytes = 0
        self._vp_tick_bytes = 0
        self._low_windows = 0

        self._thread = threading.Thread(
            target=self._run, name=f"wake-{session_id[:8]}", daemon=True
        )
        self._thread.start()
        logger.info(
            f"[WakeWord] 唤醒态建立 session={session_id} device={device_id} "
            f"pre_roll_ms={p.pre_roll_ms}"
        )

    # ---------------- 公开接口 ----------------

    def feed(self, pcm: bytes) -> None:
        """非阻塞投递一帧 PCM。队列满则标记丢帧（worker 记告警，不静默吞）。"""
        if not pcm or self._closed:
            return
        try:
            self._queue.put_nowait(bytes(pcm))
        except queue.Full:
            with self._drop_lock:
                self._dropped = True

    def close(self) -> None:
        """停止/join 工作面线程（断线/audio_stop 调用，幂等）。"""
        with self._close_lock:
            if self._closed:
                return
            self._closed = True
        self._stop.set()
        # 投递哨兵唤醒可能阻塞在 get(timeout) 的线程
        try:
            self._queue.put_nowait(b"")
        except queue.Full:
            pass
        self._thread.join(timeout=_WORKER_JOIN_TIMEOUT_S)
        self._detector.remove_state(self._session_id)
        logger.info(f"[WakeWord] 唤醒态已释放 session={self._session_id}")

    def trigger_local_hit(self, keyword: Optional[str] = None,
                          confidence: Optional[float] = None) -> bool:
        """外部（端侧 KWS / wakeup.hit 帧桥接）命中入口，线程安全。

        契约与 K4b ``/v1/stream`` 的 ``wakeup.hit {keyword, confidence}`` 对齐：
        两个字段可直接取来驱动本入口，进入与内核命中 **完全相同**的下游链路
        （``_on_hit`` -> verify -> record），不做服务端二次确认。

        语义收口（与内核命中路径一致）：
          - ``keyword`` 必须命中当前运行时目标词表（``get_target_keywords()``
            精确匹配），否则拒绝登记——端侧旧词表/异常词不触发唤醒。
            缺省取主唤醒词（词表首项，恒在表内）。
          - ``confidence`` 收进 [0, 1]（设计铁律 §4.7 分数约定）；非数值降
            None（仅观测字段，不影响是否触发）。
          - 仅登记"待处理命中"，真正的状态迁移由工作面线程在检测态消费，
            从而在 ``feed()`` 之前或之后调用都成立；命中前已采集的音频不会
            被计入命令录制。

        返回 True 表示登记成功；会话已关闭、词不在目标词表、或已存在未消费
        的待处理命中时返回 False（重复登记去重，避免端侧抖动连击）。
        """
        if self._closed:
            return False
        kw = (keyword or "").strip() or get_primary_keyword()
        # 目标词过滤: 与内核命中路径 "忽略非目标命中" 同一语义（词表运行时可热更）
        targets = get_target_keywords()
        if kw not in targets:
            logger.info(
                f"[WakeWord] 本地命中词不在目标词表，忽略登记: {kw} "
                f"(词表={targets}) session={self._session_id}"
            )
            return False
        conf: Optional[float] = None
        if confidence is not None:
            try:
                conf = max(0.0, min(1.0, float(confidence)))
            except (TypeError, ValueError):
                conf = None
        with self._pending_lock:
            if self._pending_local_hit is not None:
                logger.debug(
                    f"[WakeWord] 已有待处理本地命中，忽略重复登记 session={self._session_id}"
                )
                return False
            self._pending_local_hit = (kw, conf)
        logger.info(
            f"[WakeWord] 收到本地命中登记 keyword={kw} confidence={conf} "
            f"session={self._session_id}"
        )
        return True

    def _take_pending_local_hit(self) -> Optional[Tuple[str, Optional[float]]]:
        """取出并清空待处理本地命中（工作面线程调用，线程安全）。

        Returns:
            ``(keyword, confidence)``；无待处理命中时 None。
        """
        with self._pending_lock:
            pending = self._pending_local_hit
            self._pending_local_hit = None
        return pending

    # ---------------- 工作面 ----------------

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                pcm = self._queue.get(timeout=0.2)
            except queue.Empty:
                continue
            if self._stop.is_set():
                break
            if not pcm:
                continue
            # 丢帧检测：本地已无解码流可污染，只记告警（内核桥与手机上行各自独立，
            # 丢帧仅影响本会话 pre-roll/录制完整性，不静默吞掉）
            with self._drop_lock:
                dropped = self._dropped
                self._dropped = False
            if dropped:
                logger.warning(
                    f"[WakeWord] 投递队列溢出丢帧 session={self._session_id}"
                )
            try:
                self._handle(pcm)
            except Exception as e:
                logger.error(f"[WakeWord] 处理音频帧异常: {e}", exc_info=True)

    def _handle(self, pcm: bytes) -> None:
        # pre-roll 环形缓冲：内核命中与端侧本地命中的唤醒词音频共用，
        # 由 _on_hit 作为声纹进门验证与录制的起点
        self._push_pre_roll(pcm)
        n = len(pcm) // 2
        self._total_samples += n
        if self._state == "detect":
            self._handle_detect(pcm)
        elif self._state == "verify":
            self._handle_verify(pcm)
        elif self._state == "record":
            self._handle_record(pcm)

    # ---------------- 检测态 ----------------

    def _handle_detect(self, pcm: bytes) -> None:
        # 命中入口唯一为 trigger_local_hit（内核 wakeup.hit 桥 / 端侧命中直通），
        # 在这里以「待处理命中」消费；服务端不再有任何本地 KWS 解码。
        pending = self._take_pending_local_hit()
        if pending is not None:
            # 不传 seed：以 pre-roll 环形缓冲为验证/录制起点（唤醒词音频即在此）
            self._on_hit(keyword=pending[0], confidence=pending[1])
            return

    def _on_hit(self, keyword: Optional[str] = None,
                seed_pcm: Optional[List[bytes]] = None,
                confidence: Optional[float] = None) -> None:
        """唤醒命中 -> 进入进门验证态（内核 wakeup.hit 与端侧本地命中共用）。

        ``keyword`` 为本次命中的唤醒词，缺省为目标词（仅用于日志/回显）。
        ``seed_pcm`` 为可选的验证/录制起始音频；None（默认）时取 pre-roll 环形
        缓冲。内核命中与端侧本地命中当前均以 pre-roll 为起点。
        ``confidence`` 为命中置信度 [0,1]（对齐 wakeup.hit；内核命中恒 1.0 =
        过阈值确定命中，端侧登记值经 trigger_local_hit 已收进 [0,1]）。
        """
        kw = (keyword or "").strip() or get_primary_keyword()
        if confidence is not None:
            try:
                confidence = max(0.0, min(1.0, float(confidence)))
            except (TypeError, ValueError):
                confidence = None
        if seed_pcm is None:
            seed_pcm = list(self._pre_roll)
        pre_roll = list(seed_pcm)
        pre_bytes = sum(len(b) for b in pre_roll)
        now_wall = self._start_wall_ms + int(self._total_samples * 1000.0 / self._sr)
        self._record_start_wall_ms = now_wall - int(pre_bytes / 2 * 1000.0 / self._sr)
        # 验证音频与录制音频都以 seed 起头：录制包含唤醒短语，避免首字被截
        self._verify_pcm = list(pre_roll)
        self._verify_bytes = pre_bytes
        self._record_pcm = list(pre_roll)
        self._record_samples = pre_bytes // 2
        self._vad_buf = bytearray()
        self._vp_buf = bytearray()
        self._vad_tick_bytes = 0
        self._vp_tick_bytes = 0
        self._low_windows = 0
        # 测试模式：每次命中重置观测数据，避免跨指令串场
        self._vp_scores = []
        self._entry_score = 0.0
        self._entry_as_norm = None
        # 记录本次命中词与置信度，供 wake_start 提示与测试结果回显
        self._current_keyword = kw
        self._hit_confidence = confidence
        self._state = "verify"
        logger.info(
            f"[WakeWord] 命中唤醒词 keyword={kw} confidence={confidence} "
            f"session={self._session_id} "
            f"pre_roll_ms={int(pre_bytes / 2 * 1000.0 / self._sr)}"
        )
        # 预滚已满足验证窗口时立即验证：端侧命中场景下预滚即完整唤醒词，是理想样本，
        # 不需要等待命中后的音频（用户明确要求「不需要攒」）。
        # 内部 KWS 路径预滚通常短于窗口，此处不会触发，行为保持不变。
        if self._verify_bytes >= self._verify_min_bytes:
            self._run_verify()

    # ---------------- 验证态 ----------------

    def _handle_verify(self, pcm: bytes) -> None:
        self._verify_pcm.append(pcm)
        self._verify_bytes += len(pcm)
        self._record_pcm.append(pcm)
        self._record_samples += len(pcm) // 2
        if self._verify_bytes < self._verify_min_bytes:
            return
        self._run_verify()

    def _run_verify(self) -> None:
        """对已累积的验证音频跑声纹进门验证，并按结果迁移状态。

        窗口取**最近** ``_verify_min_bytes``（滑动窗口时长）而非开头：预滚与唤醒词
        位于累积音频的尾部，取尾部才能保证唤醒词不被更早的静音挤出窗口。
        调用方保证 ``_verify_bytes >= _verify_min_bytes``（无音频时绝不验证）。
        """
        data = b"".join(self._verify_pcm)
        if len(data) > self._verify_min_bytes:
            data = data[-self._verify_min_bytes:]
        audio = (
            np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768.0
        )
        ok, name, as_norm_on, score = self._voiceprint_gate(audio)
        # 测试模式观测：记录进门验证分数与所用阈值域
        self._entry_score = float(score)
        self._entry_as_norm = as_norm_on
        if ok:
            self._speaker_name = name
            self._state = "record"
            # 最短录音保护从此处（提示音下发）起算，不含 pre-roll 与进门验证音频
            self._record_state_samples = 0
            domain = "AS-Norm" if as_norm_on else "raw-cosine"
            # 进门验证通过、正式进入录制态：发出唤醒开始提示信号（每次命中恰好一次）
            self._emit("wake_start", {"keyword": self._current_keyword})
            logger.info(
                f"[WakeWord] 进门验证通过 speaker={name} score={score:.3f} "
                f"domain={domain} session={self._session_id}"
            )
        else:
            domain = "AS-Norm" if as_norm_on else "raw-cosine"
            logger.info(
                f"[WakeWord] 进门验证未通过 speaker={name} score={score:.3f} "
                f"domain={domain} session={self._session_id}"
            )
            if self._test_mode:
                # 测试模式：验证失败同样回推结果（要求「无论是否失败都返回」）
                self._emit_test_result(
                    asr_text="", dur_ms=0, reason="verify_fail", speaker=name,
                    vp_scores=[], low_windows=0,
                )
            self._reset_to_detect()

    def _voiceprint_gate(self, audio: np.ndarray) -> Tuple[bool, str, Optional[bool], float]:
        """进门验证：内核 score_all_v2（collect=False，唤醒音频不进 cohort）。

        B1 起打分唯一来源是内核（kernel_client 垫片 -> POST /v1/voiceprint/score）：
          - 内核不可达/失败/注册为空 -> scores 恒空 -> 进门失败（fail-closed：
            无法验证就不开录，对齐旧「无注册恒失败」语义）+ 限频告警。
          - 判停数学语义不变：按 ``as_norm_on`` 选择阈值域比对。
        """
        from services import kernel_client as kc

        detail = kc.score_all_v2(audio, detail=True, collect=False)
        raw_scores = detail.get("scores") if isinstance(detail, dict) else None
        if not isinstance(raw_scores, dict) or not raw_scores:
            # scores 空：内核不可达或无注册声纹。区分告警语义靠内核日志/断连记录，
            # 这里统一按进门失败处理并限频提示。
            _warn_kernel_down(
                "entry",
                "进门打分无结果（内核不可达或注册为空），拒绝开录（fail-closed） "
                f"session={self._session_id}",
            )
            return False, "", None, 0.0
        scores: Dict[str, float] = {
            str(k): float(v) for k, v in raw_scores.items()
        }
        name = max(scores, key=lambda k: scores[k])
        score = scores[name]
        as_norm_on = bool(detail.get("as_norm_on"))
        thr = (
            self._p.entry_threshold_ready
            if as_norm_on
            else self._p.entry_threshold_cold
        )
        return score >= thr, name, as_norm_on, score

    # ---------------- 录制态 ----------------

    def _handle_record(self, pcm: bytes) -> None:
        self._record_pcm.append(pcm)
        self._record_samples += len(pcm) // 2
        self._record_state_samples += len(pcm) // 2
        self._append_rolling(self._vad_buf, pcm, self._vad_buf_limit)
        self._append_rolling(self._vp_buf, pcm, self._vp_buf_limit)
        self._vad_tick_bytes += len(pcm)
        self._vp_tick_bytes += len(pcm)

        dur_ms = int(self._record_samples * 1000.0 / self._sr)
        if dur_ms >= self._p.max_record_ms:
            self._stop_recording("hard_limit", dur_ms)
            return
        # 唤醒后最短录音保护：自进入录制态（提示音下发）起算，期间不做任何停止判定。
        # 用户通常要听到提示音才开始说话，若按总时长（含 pre-roll/验证音频）判定则保护失效。
        since_wake_ms = int(self._record_state_samples * 1000.0 / self._sr)
        if since_wake_ms < self._p.min_record_ms:
            return

        # 停止条件 ①：内核 VAD 尾部静音 >= vad_silence_ms（POST /v1/inspect/vad_curve）
        if self._vad_tick_bytes >= self._vad_step_bytes:
            self._vad_tick_bytes = 0
            silence_s = self._vad_trailing_silence()
            if silence_s is not None and silence_s * 1000.0 >= self._p.vad_silence_ms:
                self._stop_recording("vad_silence", dur_ms)
                return

        # 停止条件 ②：声纹滑窗持续低分（连续 N 窗）
        if self._vp_tick_bytes >= self._vp_hop_bytes:
            self._vp_tick_bytes = 0
            low = self._record_voiceprint_low()
            if low is True:
                self._low_windows += 1
            elif low is False:
                self._low_windows = 0
            needed = max(
                1, int(np.ceil(self._p.exit_hold_ms / max(1, self._p.sliding_hop_ms)))
            )
            if self._low_windows >= needed:
                self._stop_recording("voiceprint_low", dur_ms)

    def _record_voiceprint_low(self) -> Optional[bool]:
        """对最近滑窗内核打分，返回是否低于退出阈值；无分或异常返回 None（跳过本次）。

        B1 数据源切换：kernel_client.score_all_v2（collect=False，与进门同源纪律）。
        判停数学语义与旧本地实现逐项一致（单窗 top 分 vs exit 阈值域、逐 tick 累计
        _low_windows）；内核不可达时打分返回空结果 -> None -> 计数不动、继续录制，
        由 VAD 静音与硬上限兜底停止（对齐旧「打分异常忽略本次」语义）。
        """
        if len(self._vp_buf) < self._vp_buf_limit:
            return None
        from services import kernel_client as kc

        wav = (
            np.frombuffer(bytes(self._vp_buf), dtype=np.int16)
            .astype(np.float32) / 32768.0
        )
        detail = kc.score_all_v2(wav, detail=True, collect=False)
        raw_scores = detail.get("scores") if isinstance(detail, dict) else None
        if not isinstance(raw_scores, dict) or not raw_scores:
            _warn_kernel_down(
                "exit",
                "退出滑窗打分无结果（内核不可达或注册为空），本次判停跳过 "
                f"session={self._session_id}",
            )
            return None
        top = float(max(float(v) for v in raw_scores.values()))
        as_norm_on = bool(detail.get("as_norm_on"))
        thr = (
            self._p.exit_threshold
            if as_norm_on
            else self._p.exit_threshold_cold
        )
        # 测试模式观测：保留滑窗分数序列（限长，避免长指令无限增长）
        if self._test_mode:
            self._vp_scores.append(round(top, 4))
            if len(self._vp_scores) > 200:
                del self._vp_scores[:-200]
        return top < thr

    def _vad_trailing_silence(self) -> Optional[float]:
        """对最近 10s 滚动 buffer 拉一次内核 pyannote 曲线，返回尾部静音秒数。

        B1 数据源切换：kernel_client -> POST /v1/inspect/vad_curve（engine=pyannote，
        内核曲线数学逐位移植自原本地实现：10s sliding 前向、bucket_ms 网格、
        逐帧概率对阈值）。检查周期与现状一致（每 vad_step_s 到达音频一次，
        不引入新延迟）；每次**只喂 10s buffer**（不足则前补零，只影响开头
        不影响尾部静音判定），绝不喂累积音频。

        失败/不可达 -> None（本次判定跳过，与原本地 pyannote 推理异常同语义；
        停止判定仍有声纹低分与硬上限兜底）。
        """
        if not self._vad_buf:
            return None
        import base64

        from services import kernel_client as kc

        win_bytes = max(2, int(self._sr * self._p.vad_window_s) * 2)
        buf = bytes(self._vad_buf)
        if len(buf) < win_bytes:
            buf = b"\x00\x00" * ((win_bytes - len(buf)) // 2) + buf
        else:
            buf = buf[-win_bytes:]
        try:
            payload = {
                "audio_b64": base64.b64encode(
                    pcm_to_wav(buf, self._sr)
                ).decode("ascii"),
                "engine": "pyannote",
                # 网格步长对齐本地桶宽（内核 clamp 10..200ms）
                "frame_ms": max(10, min(200, int(self._p.vad_bucket_ms))),
                "max_points": 50000,
            }
            result = kc.get_kernel_client().srequest(
                "POST", "/v1/inspect/vad_curve",
                json=payload, timeout=_VAD_TICK_TIMEOUT_S,
            )
            facts = (result or {}).get("facts") or {}
            points = facts.get("points")
            dur_ms = float(facts.get("duration_ms") or 0.0)
            step_ms = float(facts.get("step_ms") or 0.0)
            if not points or dur_ms <= 0 or step_ms <= 0:
                return None
            dur = dur_ms / 1000.0
            step = step_ms / 1000.0
            last_on = -1
            for i, p in enumerate(points):
                try:
                    if float(p) >= self._p.vad_threshold:
                        last_on = i
                except (TypeError, ValueError):
                    continue
            if last_on < 0:
                return dur
            return max(0.0, dur - (last_on + 1) * step)
        except Exception as e:
            _warn_kernel_down(
                "vad",
                f"尾静音判停失败（本次跳过）session={self._session_id}: "
                f"{type(e).__name__}: {str(e)[:160]}",
            )
            return None

    def _stop_recording(self, reason: str, dur_ms: int) -> None:
        """停止录制：快照音频、复位状态、回检测态，并把后处理交给独立线程。"""
        if self._state != "record":
            return
        logger.info(
            f"[WakeWord] 录制停止 reason={reason} duration={dur_ms}ms "
            f"session={self._session_id}"
        )
        # 录制结束提示信号：reason 与调用方一致；上面的 guard 保证每次录制恰好一次
        self._emit("wake_end", {"reason": reason})
        pcm = b"".join(self._record_pcm)
        start_wall = self._record_start_wall_ms
        end_wall = start_wall + dur_ms
        speaker = self._speaker_name
        # 测试模式观测数据在此快照：后处理线程读取时状态机可能已被下一次唤醒重置
        vp_scores = list(self._vp_scores)
        low_windows = int(self._low_windows)
        self._reset_to_detect()
        if not pcm:
            return
        threading.Thread(
            target=self._finish_and_send,
            args=(pcm, start_wall, end_wall, speaker, reason, vp_scores, low_windows),
            name=f"wake-send-{self._session_id[:8]}",
            daemon=True,
        ).start()

    # ---------------- 后处理：内核弱切分+ASR -> 发送 ----------------

    def _kernel_asr_transcribe(self, pcm: bytes) -> Optional[str]:
        """录制音频 -> 临时 WAV -> 内核 analyze.asr 作业（options.weak_split 透传配置）。

        Returns:
            转写文本（可能为空串 = 无语音，按现状丢弃本次指令）；
            None = 内核不可达/作业失败（调用方放弃本次指令并记限频告警，
            **绝不回退本地 SenseVoice**）。

        弱切分语义保真：切分数学权威已移植内核（kernel audio/weak_split.py，
        与本模块旧 wake 版逐位对拍锁定，契约 §15-13），外层只做逐段取文本、
        strip、拼接——与旧「本地 weak_split 出字节段 -> 逐段本地 ASR」的
        文本聚合路径逐项一致。
        """
        import tempfile as _tempfile

        fd, path = _tempfile.mkstemp(prefix="wake_", suffix=".wav")
        os.close(fd)
        try:
            with open(path, "wb") as f:
                f.write(pcm_to_wav(pcm, self._sr))
            from services import kernel_job_client as kjc

            facts_map = kjc.run_audio_analysis_jobs(
                path,
                kinds=["analyze.asr"],
                options_by_kind={
                    "analyze.asr": {"weak_split": _weak_split_options(self._p.weak_split)},
                },
                wait=_KERNEL_ASR_WAIT_S,
                deadline_s=_KERNEL_ASR_DEADLINE_S,
            )
            if not facts_map:
                return None
            facts = facts_map.get("analyze.asr") or {}
            texts: List[str] = []
            for seg in (facts.get("segments") or []):
                t = (str(seg.get("text") or "")).strip()
                if t:
                    texts.append(t)
            return "".join(texts).strip()
        finally:
            try:
                os.remove(path)
            except OSError:
                pass

    def _finish_and_send(self, pcm: bytes, start_wall_ms: int,
                         end_wall_ms: int, speaker: str,
                         reason: str = "", vp_scores: Optional[List[float]] = None,
                         low_windows: int = 0) -> None:
        try:
            asr_text = self._kernel_asr_transcribe(pcm)
            if asr_text is None:
                # 内核 ASR 失败/不可达：放弃本次指令（对齐旧「后处理异常丢弃」语义），
                # 不回退本地 SenseVoice；限频 ERROR 供运维感知。
                _warn_kernel_down(
                    "asr",
                    f"录停 ASR 失败（内核不可达/作业失败），放弃本次指令 "
                    f"session={self._session_id}",
                )
                return
            if self._test_mode:
                # 测试模式：不落盘、不投递 AI，仅回推本次结果与参数快照
                self._emit_test_result(
                    asr_text=asr_text,
                    dur_ms=max(0, int(end_wall_ms - start_wall_ms)),
                    reason=reason or "unknown",
                    speaker=speaker,
                    vp_scores=vp_scores or [],
                    low_windows=low_windows,
                )
                return
            if not asr_text:
                logger.warning(
                    f"[WakeWord] ASR 返回空文本，丢弃本次指令 session={self._session_id}"
                )
                return

            # 语音唤醒链路不写增量数据：不进 perception.jsonl，也不落 daily 音频。
            # 唤醒链路的产出只有「ASR 结果作为语音指令投递主会话」；
            # 环境音频（分段上传）才负责写入 AI 可分析的增量数据，两条链路相互独立。
            # 正文首行统一场景前缀 【语音唤醒】，并保留 TTS 语音回复指令
            # （见 ai/AGENTS.md 场景前缀契约）；日志仍记录原始 ASR 文本。
            message = (
                "【语音唤醒】必须第一时间使用tts_speak工具中文回复语音消息。"
                f"\n\n{asr_text}"
            )
            self._send_to_main(message)
            logger.info(
                f"[WakeWord] 语音指令已投递 main-task speaker={speaker} "
                f"text=\"{asr_text[:60]}\""
            )
        except Exception as e:
            logger.error(f"[WakeWord] 后处理失败: {e}", exc_info=True)

    def _send_to_main(self, text: str) -> None:
        """从工作线程把消息投递到主事件循环并等待结果。"""
        from services.event_loop_manager import get_main_loop
        from services.ai_client_factory import acquire_ai_client as acquire_opencode_client  # 双通道工厂，别名保留原符号

        loop = get_main_loop()
        if loop is None or not loop.is_running():
            logger.error("[WakeWord] 主事件循环不可用，语音指令未发送")
            return

        async def _deliver() -> bool:
            client = await acquire_opencode_client()
            return await client.send_voice_to_opencode(text, agent="main-task")

        future = asyncio.run_coroutine_threadsafe(_deliver(), loop)
        try:
            ok = future.result(timeout=_SEND_TIMEOUT_S)
        except Exception as e:
            logger.error(f"[WakeWord] 投递 main-task 异常: {e}")
            return
        if not ok:
            logger.error("[WakeWord] 投递 main-task 失败（网关返回 False）")

    # ---------------- 内部工具 ----------------

    def _emit_test_result(self, asr_text: str, dur_ms: int, reason: str, speaker: str,
                          vp_scores: List[float], low_windows: int) -> None:
        """测试模式：回推本次唤醒的完整结果与参数快照（不落盘、不投递 AI）。"""
        p = self._p
        payload: Dict[str, Any] = {
            "keyword": self._current_keyword,
            "confidence": self._hit_confidence,
            "speaker": speaker,
            "asr_text": asr_text,
            "dur_ms": int(dur_ms),
            "reason": reason,
            "pre_roll_ms": int(p.pre_roll_ms),
            "entry_score": round(float(self._entry_score), 4),
            "entry_as_norm": self._entry_as_norm,
            "entry_threshold": float(
                p.entry_threshold_ready if self._entry_as_norm else p.entry_threshold_cold
            ),
            "vp_scores": [float(x) for x in (vp_scores or [])],
            "vp_low_windows": int(low_windows),
            "params": {
                "sample_rate": int(p.sample_rate),
                "keywords_score": float(p.keywords_score),
                "keywords_threshold": float(p.keywords_threshold),
                "entry_threshold_ready": float(p.entry_threshold_ready),
                "entry_threshold_cold": float(p.entry_threshold_cold),
                "exit_threshold": float(p.exit_threshold),
                "exit_threshold_cold": float(p.exit_threshold_cold),
                "exit_hold_ms": int(p.exit_hold_ms),
                "vad_silence_ms": int(p.vad_silence_ms),
                "min_record_ms": int(p.min_record_ms),
                "max_record_ms": int(p.max_record_ms),
                "sliding_window_ms": int(p.sliding_window_ms),
                "sliding_hop_ms": int(p.sliding_hop_ms),
            },
        }
        self._emit("kws_test_result", payload)

    def _emit(self, event: str, payload: Dict[str, Any]) -> None:
        """把唤醒事件交给注入的回调（工作线程调用）。

        本模块不感知 WebSocket/asyncio；回调由路由层注入并负责线程安全调度。
        回调异常绝不允许影响音频处理或唤醒状态机，因此在此兜底吞掉。
        """
        cb = self._on_event
        if cb is None:
            return
        try:
            cb(event, dict(payload))
        except Exception as e:
            logger.warning(f"[WakeWord] 唤醒事件回调异常（忽略）: {e}")

    def _push_pre_roll(self, pcm: bytes) -> None:
        # 单帧大于等于缓冲容量时只保留帧尾（最新音频）并清空旧数据。
        # 关键：App 的预滚（含唤醒词）是作为一个 2s 的大二进制帧整帧发来的，
        # 若沿用「入队后再 popleft 超限元素」的写法，整个大帧会被一次性弹出，
        # 预滚缓冲被清空，端侧命中的唤醒词音频全部丢失 -> 声纹验证只能拿到
        # 命中之后的音频（用户实测根因）。
        if len(pcm) >= self._pre_roll_limit:
            pcm = pcm[len(pcm) - self._pre_roll_limit:]
            self._pre_roll.clear()
            self._pre_roll_bytes = 0
        self._pre_roll.append(pcm)
        self._pre_roll_bytes += len(pcm)
        while self._pre_roll_bytes > self._pre_roll_limit and self._pre_roll:
            self._pre_roll_bytes -= len(self._pre_roll.popleft())

    @staticmethod
    def _append_rolling(buf: bytearray, pcm: bytes, limit: int) -> None:
        buf.extend(pcm)
        if len(buf) > limit:
            del buf[: len(buf) - limit]

    def _reset_to_detect(self) -> None:
        """复位所有录制/验证字段并回到检测态。"""
        self._state = "detect"
        self._verify_pcm = []
        self._verify_bytes = 0
        self._record_pcm = []
        self._record_samples = 0
        self._record_state_samples = 0
        self._vad_buf = bytearray()
        self._vp_buf = bytearray()
        self._vad_tick_bytes = 0
        self._vp_tick_bytes = 0
        self._low_windows = 0
        self._speaker_name = "用户"


# ============================ 外部入口 ============================

_detector_instance: Optional[WakeWordDetector] = None
_detector_lock = threading.Lock()


def get_detector() -> WakeWordDetector:
    global _detector_instance
    if _detector_instance is None:
        with _detector_lock:
            if _detector_instance is None:
                _detector_instance = WakeWordDetector()
    return _detector_instance


def start_state(device_id: str, session_id: str,
                start_wall_ms: int,
                on_event: Optional[Callable[[str, Dict[str, Any]], None]] = None,
                test_mode: bool = False,
                local_hit: bool = False,
                ) -> Optional[WakeWordState]:
    """为一个音频流连接启动唤醒态；未启用（audio.wake_word.enabled=false 或
    配置不完整）时返回 None。

    ``on_event`` 为可选的唤醒事件回调（wake_start / wake_end / kws_test_result），
    由调用方注入。``test_mode`` 为 True 时不投递 AI、不落盘，只回推结果。
    ``local_hit`` 为 True 时表示本会话由端侧 KWS 触发：登记命中后直接进声纹
    进门验证 -> 录制链路（本就不依赖服务端 KWS）。

    B1 起两条路径都不加载本地模型：KWS 检测在内核 /v1/stream（路由层桥接），
    本模块只持有 pre-roll/状态机；内核不可达时由路由层降级为不唤醒。
    触发一次内核声纹评分微型预热，压低首条唤醒链路的进门验证延迟。
    """
    if not is_enabled():
        return None
    p = _resolve_params()
    if p is None:
        return None
    _schedule_score_warmup()
    detector = get_detector()
    if local_hit:
        logger.info(
            f"[WakeWord] 本地命中模式启动 session={session_id}"
        )
    return detector.create_state(
        device_id, session_id, start_wall_ms, p,
        on_event=on_event, test_mode=test_mode, local_hit=local_hit,
    )


# ---------------- 内核声纹评分微型预热 ----------------

_warm_lock = threading.Lock()
_warm_last_ts = 0.0
_WARM_MIN_INTERVAL_S = 300.0   # 预热节流：模型常驻后无需频繁触发


def _score_warmup_once() -> None:
    """向内核 /v1/voiceprint/score 发一次微型请求（0.1s 静音，collect=false）。

    目的：唤醒链进门验证发生在 App 5s 兜底窗口内，而内核声纹模型懒加载
    首调可能数秒。用静音微型样本预热加载（评分结果无意义、恒容错），
    失败只记限频告警、绝不影响唤醒主链路。
    """
    global _warm_last_ts
    import time as _time

    with _warm_lock:
        now = _time.monotonic()
        if now - _warm_last_ts < _WARM_MIN_INTERVAL_S:
            return
        _warm_last_ts = now
    try:
        import numpy as _np

        from services import kernel_client as kc

        silence = _np.zeros(int(_DEFAULT_SAMPLE_RATE * 0.1), dtype=_np.float32)
        kc.score_all_v2(silence, detail=True, collect=False)
    except Exception as e:  # 预热绝不外溢：任何异常只告警
        logger.debug(f"[WakeWord] 内核评分预热失败（忽略）: {e}")


def _schedule_score_warmup() -> None:
    """后台线程触发预热（不阻塞 audio_start 路径）。测试可 monkeypatch 本函数。"""
    threading.Thread(
        target=_score_warmup_once, name="wake-score-warmup", daemon=True,
    ).start()


__all__ = [
    "WakeParams",
    "WakeWordDetector",
    "WakeWordState",
    "get_detector",
    "get_primary_keyword",
    "get_target_keywords",
    "is_enabled",
    "set_target_keywords",
    "start_state",
]
