# -*- coding: utf-8 -*-
"""
音频分析队列（单 worker + 延迟重试堆）。

设计要点（见方案 6.3；B2 起支持内核不可达的 requeue）：
  1. 模块级单例队列 + 且仅有一个守护 worker 线程。
  2. 作用：既串行 GPU 推理（multimodal_audio_manager 内部 _inference_lock），
     也串行锁外的 CPU 重活（soundfile 读取、声纹打分、两步切分、归档写盘）。
  3. 队列有界（maxsize=32）：队满时 submit 返回 False，由调用方（WS 路由）
     向客户端下发 throttle，要求其转本地缓存，禁止无界堆积。
  4. 不做 N worker：多 worker 会在 GPU 锁上互等并白耗 CPU。
  5. B2 requeue：内核不可达/主链作业失败时 analyze_audio_file 返回 "retry"，
     管线经 schedule_retry() 把该文件登记进**延迟重试堆**（退避 60s 倍增、
     封顶 900s、上限 10 次）；worker 到期后重新入队消费。重试项与主队列共用
     同一 worker（串行语义不变）；超限丢弃必记 ERROR——原始音频永久留存
     daily/，绝不静默丢数据（用户红线）。重试堆不占主队列 maxsize（内核
     宕机积压时不阻塞新上传的 throttle 判定），但入队时队满则延后 5s 再投。

入队内容是「已落盘的 WAV 绝对路径」而非音频字节，故队列内存占用极小。

依赖：Python 标准库（queue、threading、logging、heapq）+ 轻量配置 services.audio_config。
分析重活（analyze_audio_file）在 worker 内惰性导入，避免拖慢后端启动。
"""

from __future__ import annotations

import heapq
import itertools
import logging
import queue
import threading
import time

from services.audio_config import get_audio_config

logger = logging.getLogger(__name__)

# ─── 音频配置(模块级快照: 导入时加载; reset_analysis_queue 会重新读取) ───
_STREAM_CFG = (get_audio_config().get("stream", {}) or {})

# 队列容量：默认约 32 个待分析片段，足够缓冲突发，又不至于无界堆积
_QUEUE_MAXSIZE: int = int(_STREAM_CFG.get("queue_maxsize", 32))

# worker 停止哨兵：投入队列后让阻塞中的 get 立即返回并退出循环
_STOP_SENTINEL = object()

# B2 重投退避参数（与 audio_analysis_pipeline 的 _schedule_retry 语义配套；
# 上限判定在管线侧，堆只负责"到点回投"）
_RETRY_BASE_S = 60.0
_RETRY_MAX_S = 900.0
# worker 空闲阻塞时重查重试堆的最大粒度（秒）——到期即回投，无需新事件唤醒
_RETRY_POLL_CAP_S = 5.0
# 堆为空时的空闲轮询上限（秒）：schedule_retry 可能发生在 worker 阻塞期间，
# 永久阻塞(get timeout=None)会让新登记的重投要等下一条上传才生效；封顶 30s
# 空闲唤醒把最坏延迟收敛到 30s（每 30s 一次空唤醒，成本可忽略）。
_RETRY_IDLE_POLL_S = 30.0


class AudioAnalysisQueue:
    """单 worker 的音频分析队列（附延迟重试堆）。

    使用方式：调用 :func:`get_analysis_queue` 获取全局单例，然后 :meth:`submit`。
    内核不可达的重投由分析管线调用 :meth:`schedule_retry` 登记。
    """

    def __init__(self, maxsize: int = _QUEUE_MAXSIZE) -> None:
        # 主队列条目: (abs_path, start_epoch_ms, device_name, origin) 或
        # 重试回投的 5 元组 (abs_path, start_epoch_ms, device_name, origin, attempt)
        self._queue: queue.Queue[object] = queue.Queue(maxsize=maxsize)
        # 延迟重试堆: (due_ts, tie_seq, (abs_path, start_ms, device, origin, attempt))
        self._retries: list[tuple] = []
        self._retries_lock = threading.Lock()
        self._tie = itertools.count()
        self._stop_event = threading.Event()
        # 懒启动：首次实例化时才拉起 worker 线程（单例在首次 get 时创建）
        self._worker: threading.Thread = threading.Thread(
            target=self._worker_loop,
            name="audio-analysis-worker",
            daemon=True,  # 守护线程：进程退出即回收，不阻塞关闭
        )
        self._worker.start()
        logger.info(f"[AudioAnalysisQueue] 单 worker 已启动 (maxsize={maxsize})")

    def stop(self, timeout: float = 5.0) -> None:
        """停止 worker（幂等）：置位停止标记并投递哨兵唤醒阻塞中的 get。

        timeout 只等待当前任务结束；内核作业/长音频在途时线程可能继续存活，
        会在当前条目完成后自行退出（daemon，不阻塞进程退出）。
        """
        first_stop = not self._stop_event.is_set()
        self._stop_event.set()
        if first_stop:
            try:
                self._queue.put_nowait(_STOP_SENTINEL)
            except queue.Full:
                pass
        worker = self._worker
        if worker is not threading.current_thread() and worker.is_alive():
            worker.join(timeout=timeout)

    def submit(self, abs_path: str, start_epoch_ms: int, device_name: str,
               origin: str = "upload") -> bool:
        """尝试把一个待分析 WAV 路径入队。

        Args:
            abs_path: WAV 文件绝对路径
            start_epoch_ms: 音频真实起始时间（epoch 毫秒）
            device_name: 设备名（写入感知条目）
            origin: 音频来源标记（"upload" | "stream"），默认 "upload" 保持既有行为；
                由消费者透传给 analyze_audio_file，决定是否写入感知增量数据。

        Returns:
            True 表示已入队；False 表示队列已满（调用方应下发 throttle）。
        """
        try:
            self._queue.put_nowait((abs_path, start_epoch_ms, device_name, origin))
            return True
        except queue.Full:
            logger.warning(
                f"[AudioAnalysisQueue] 队列已满，拒绝入队: {abs_path}"
            )
            return False

    def schedule_retry(self, abs_path: str, start_epoch_ms: int | None,
                       device_name: str, origin: str, attempt: int) -> bool:
        """B2 requeue：把分析失败（内核不可达）的文件登记进延迟重试堆。

        退避 = min(base * 2^(attempt-1), max)；attempt 由调用方（管线）递增并
        做上限判定——本方法不重复限次，堆只负责"到点回投"。回投条目带
        attempt 标记（5 元组），worker 消费时透传给 analyze_audio_file。

        按路径去重（不重）：同一路径在堆中只保留一个条目，新的 attempt 覆盖
        旧条目——防止"后台线程直调 + 队列消费"双路径对同一文件重复登记，
        也防止重投链上同一文件出现多档退避并存。

        Returns:
            True 表示已登记；False 表示参数非法（负延迟等防御分支）。
        """
        delay = min(_RETRY_BASE_S * (2 ** max(attempt - 1, 0)), _RETRY_MAX_S)
        due = time.time() + delay
        entry = (abs_path, start_epoch_ms, device_name, origin, attempt)
        with self._retries_lock:
            # 同路径旧条目整组剔除后重推（堆小，线性过滤即可；防重复分析）
            self._retries = [e for e in self._retries if e[2][0] != abs_path]
            heapq.heapify(self._retries)
            heapq.heappush(self._retries, (due, next(self._tie), entry))
        logger.info(
            f"[AudioAnalysisQueue] 重投已登记: {abs_path} "
            f"(attempt={attempt}, {delay:.0f}s 后回投)"
        )
        return True

    def retry_pending(self) -> int:
        """当前重试堆中的待回投条目数（供监控/测试使用）。"""
        with self._retries_lock:
            return len(self._retries)

    def qsize(self) -> int:
        """当前待分析条目数（供监控使用）。"""
        return self._queue.qsize()

    # ========== 内部实现 ==========

    def _promote_due_retries(self) -> None:
        """把已到期的重试条目回投主队列；队满则整体留堆 5s 后再试。"""
        now = time.time()
        due_items: list[tuple] = []
        with self._retries_lock:
            while self._retries and self._retries[0][0] <= now:
                due_items.append(heapq.heappop(self._retries)[2])
        for item in due_items:
            try:
                # 5 元组: 带 attempt 标记，worker 消费时透传给 analyze_audio_file
                self._queue.put_nowait(item)
                logger.info(
                    f"[AudioAnalysisQueue] 重投回队: {item[0]} (attempt={item[4]})"
                )
            except queue.Full:
                # 队满：留堆延后 5s 再投（不丢条目；主队列消费后自然腾位）
                with self._retries_lock:
                    heapq.heappush(
                        self._retries,
                        (now + _RETRY_POLL_CAP_S, next(self._tie), item),
                    )

    def _next_wait(self) -> float:
        """worker 阻塞取队列的超时：有到期近的重投取到点粒度，空闲封顶 30s。

        永不返回 None（不再永久阻塞）：内核宕机期间上传完全停止时，重投
        登记可能发生在 worker 阻塞窗口内，必须靠有界空闲唤醒自行发现。
        """
        with self._retries_lock:
            if self._retries:
                wait = self._retries[0][0] - time.time()
                return max(0.05, min(wait, _RETRY_POLL_CAP_S))
        return _RETRY_IDLE_POLL_S

    def _worker_loop(self) -> None:
        """worker 主循环：串行消费队列，逐条同步执行分析；穿插回投到期重试。"""
        while not self._stop_event.is_set():
            timeout = self._next_wait()
            if timeout is not None:
                self._promote_due_retries()
            try:
                item = self._queue.get(timeout=timeout)
            except queue.Empty:
                continue
            if item is _STOP_SENTINEL:
                self._queue.task_done()
                break
            try:
                # 4 元组=新任务（attempt=0）；5 元组=重投消费（带 attempt）
                attempt = item[4] if len(item) > 4 else 0
                abs_path, start_epoch_ms, device_name, origin = item[:4]
                # 惰性导入：分析链依赖声纹/内核客户端等重服务，绝不能模块级导入
                from services.audio_analysis_pipeline import analyze_audio_file

                logger.info(
                    f"[AudioAnalysisQueue] 开始分析: {abs_path} "
                    f"(device={device_name}, start_ms={start_epoch_ms}, "
                    f"origin={origin}, attempt={attempt})"
                )
                # attempt 仅在 >0 时透传：首投调用形状与旧版完全一致
                # （既有测试的 fake analyze 不带 attempt 形参，保持兼容）
                extra = {"attempt": attempt} if attempt else {}
                analyze_audio_file(
                    abs_path,
                    start_epoch_ms,
                    device_name=device_name,
                    ts_val=None,
                    origin=origin,
                    **extra,
                )
                # 返回 "retry" 时管线已自行经 schedule_retry 登记重投，此处无需动作
            except Exception as e:
                # 单条失败不能拖垮 worker，记录后继续消费
                logger.error(f"[AudioAnalysisQueue] 分析失败: {e}", exc_info=True)
            finally:
                self._queue.task_done()


# ========== 模块级单例 ==========

_queue_instance: AudioAnalysisQueue | None = None
_queue_lock = threading.Lock()
_reset_lock = threading.Lock()


def get_analysis_queue() -> AudioAnalysisQueue:
    """获取全局唯一的音频分析队列（首次调用时创建并启动 worker）。"""
    global _queue_instance
    if _queue_instance is None:
        with _queue_lock:
            # 双重检查：避免并发首次调用创建多个 worker
            if _queue_instance is None:
                _queue_instance = AudioAnalysisQueue()
    return _queue_instance


def reset_analysis_queue() -> AudioAnalysisQueue:
    """按当前配置重建分析队列单例（幂等，未创建过也可调用）。

    先换单例再停旧 worker：换单例后新提交直接进入新队列，不会被旧 worker
    的收尾拖住。旧队列中尚未消费的任务与延迟重试堆不迁移；停止只保证当前
    任务结束后退出，超时未退出的旧线程会在当前条目完成后自行退出。
    """
    global _queue_instance
    with _reset_lock:
        stream_cfg = get_audio_config().get("stream", {}) or {}
        new = AudioAnalysisQueue(
            maxsize=int(stream_cfg.get("queue_maxsize", _QUEUE_MAXSIZE))
        )
        with _queue_lock:
            old = _queue_instance
            _queue_instance = new
        if old is not None:
            old.stop()
    return new


__all__ = ["AudioAnalysisQueue", "get_analysis_queue", "reset_analysis_queue"]
