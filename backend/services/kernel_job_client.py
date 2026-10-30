# -*- coding: utf-8 -*-
"""外层内核作业客户端（K3f）。

自包含实现: K2 的 spawn/握手客户端(kernel_client.py)由兄弟轨道提供,
本模块不依赖也不修改它, 避免跨轨冲突; 这里只做纯 HTTP 作业面。

约定(设计文档 §4.3):
  - POST /v1/jobs                    带 Idempotency-Key 防重复计算
  - GET  /v1/jobs/{id}?wait=         长轮询取终态
实现: 纯标准库 urllib(零新增依赖); HTTP 错误抛 KernelJobError 不吞。
"""
from __future__ import annotations

import json
import logging
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


class KernelJobError(Exception):
    """内核作业 HTTP 调用失败(带状态码与响应体, 由调用方决定策略)。"""

    def __init__(self, method: str, url: str, status: int, body: str) -> None:
        self.method = method
        self.url = url
        self.status = status
        self.body = body
        super().__init__("%s %s -> HTTP %s: %s" % (method, url, status, body[:300]))


class KernelJobClient:
    """内核作业 HTTP 客户端(Bearer 认证, 全部走 127.0.0.1 回环)。"""

    def __init__(
        self,
        base_url: str,
        token: str,
        timeout: float = 15.0,
    ) -> None:
        if not base_url:
            raise ValueError("base_url 不能为空")
        if not token:
            raise ValueError("token 不能为空")
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.timeout = timeout

    def _request(
        self,
        method: str,
        path: str,
        payload: Optional[dict] = None,
        params: Optional[dict] = None,
        idempotency_key: Optional[str] = None,
    ) -> Dict[str, Any]:
        url = self.base_url + path
        if params:
            pairs = [(k, v) for k, v in params.items() if v is not None]
            if pairs:
                url = "%s?%s" % (url, urllib.parse.urlencode(pairs))
        data = (
            json.dumps(payload, ensure_ascii=False).encode("utf-8")
            if payload is not None
            else None
        )
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Authorization", "Bearer %s" % self.token)
        if payload is not None:
            req.add_header("Content-Type", "application/json")
        if idempotency_key:
            req.add_header("Idempotency-Key", idempotency_key)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read().decode("utf-8")
        except urllib.error.HTTPError as exc:
            raise KernelJobError(
                method, url, exc.code, exc.read().decode("utf-8", "replace")
            ) from None
        except urllib.error.URLError as exc:
            raise KernelJobError(method, url, 0, str(exc.reason)) from None
        if not raw:
            return {}
        parsed = json.loads(raw)
        if not isinstance(parsed, dict):
            raise KernelJobError(method, url, 200, raw[:300])
        return parsed

    # ─── 查询 ─────────────────────────────────────────────

    def get_job(self, job_id: str, wait: Optional[int] = None) -> Dict[str, Any]:
        """GET /v1/jobs/{id}; wait>0 时长轮询(秒, 内核上限 30)。"""
        params = {"wait": wait} if wait else None
        return self._request("GET", "/v1/jobs/%s" % job_id, params=params)

    # ─── 提交 ──────────────────────────────────────────────

    def submit(
        self,
        kind: str,
        input: Optional[dict] = None,
        options: Optional[dict] = None,
        idempotency_key: Optional[str] = None,
    ) -> Dict[str, Any]:
        """POST /v1/jobs; 同 Idempotency-Key 幂等回放既有作业。"""
        return self._request(
            "POST",
            "/v1/jobs",
            payload={
                "kind": kind,
                "input": input if input is not None else {},
                "options": options if options is not None else {},
            },
            idempotency_key=idempotency_key,
        )


def run_audio_analysis_jobs(
    audio_path: str,
    *,
    kinds: "Optional[List[str]]" = None,
    options_by_kind: "Optional[Dict[str, dict]]" = None,
    wait: int = 30,
    deadline_s: float = 600.0,
) -> "Optional[Dict[str, Dict[str, Any]]]":
    """B1 hybrid: 提交 vad/asr/scene/diarize 四类音频作业并长轮询取 facts。

    契约(设计锁定 hybrid 方案):
      - base_url/token 经 kernel_client.ensure()/现有公开接口获取(只 import 调用,
        绝不修改 kernel_client.py —— 该文件归并行任务 T6 所有);
      - input={"path": wav 绝对路径}: 同机内核直读文件, 零 artifact 上传;
      - 提交后 get_job(wait=30) 长轮询等完成信号(内核挂 future 唤醒,
        绝不 sleep 轮询; 超时返回当前状态后继续下一轮长轮询直至 deadline);
      - 任一环节失败(内核不可达/提交 503或429/作业 failed/超时) -> 返回 None。
        B2 起调用方不再回退本地全家桶, 而是 requeue 延迟重投
        (见 audio_analysis_queue / audio_analysis_pipeline 的重试链)。

    Args:
        audio_path: wav 文件路径(转绝对路径后作为 input.path 传给内核)
        kinds: 覆盖默认四 kind(测试用)
        options_by_kind: {kind: options} 每 kind 的作业选项(如 breath 的
            vad_timeline; B2 残留两件用)
        wait: 单次长轮询挂起秒数(内核上限 30)
        deadline_s: 全部作业取齐的总时限(秒, 覆盖模型首载)

    Returns:
        {"analyze.vad": facts, "analyze.asr": facts, "analyze.scene": facts,
         "analyze.diarize": facts} 或 None(通道不可用/任一作业失败)。
    """
    import os
    import time

    job_kinds = list(kinds) if kinds else [
        "analyze.vad", "analyze.asr", "analyze.scene", "analyze.diarize",
    ]
    opt_map = options_by_kind or {}
    try:
        # 只 import 调用 kernel_client 的公开接口, 不改其文件(T6 所有)
        from services.kernel_client import get_kernel_client

        kc = get_kernel_client()
        kc.ensure()
        if not kc.base_url or not kc.token:
            raise KernelJobError(
                "ENSURE", str(kc.base_url or ""), 0, "内核 base_url/token 未就绪"
            )
        # HTTP 超时须大于单次长轮询挂起秒数, 否则 wait 未醒先被本地砍断
        client = KernelJobClient(kc.base_url, kc.token, timeout=float(wait) + 15.0)

        abs_path = os.path.abspath(audio_path)
        # 1) 先全部提交(内核侧线程池并行执行, 外层再顺序收割)
        job_ids: "Dict[str, str]" = {}
        for kind in job_kinds:
            resp = client.submit(kind, input={"path": abs_path},
                                 options=opt_map.get(kind))
            job_id = str(resp.get("id") or "")
            if not job_id:
                raise KernelJobError(
                    "POST", "/v1/jobs", 200, json.dumps(resp, ensure_ascii=False)[:300]
                )
            job_ids[kind] = job_id

        # 2) 长轮询逐个取终态(完成信号唤醒, 非 sleep 轮询)
        facts: "Dict[str, Dict[str, Any]]" = {}
        deadline = time.time() + float(deadline_s)
        for kind, job_id in job_ids.items():
            while True:
                remaining = deadline - time.time()
                if remaining <= 0:
                    raise KernelJobError(
                        "GET", "/v1/jobs/%s" % job_id, 0,
                        "等待作业超时(deadline=%.0fs)" % deadline_s,
                    )
                poll = min(int(wait), max(int(remaining), 1))
                job = client.get_job(job_id, wait=poll)
                state = str(job.get("state") or "")
                if state == "done":
                    kernel_env = ((job.get("result") or {}).get("kernel") or {})
                    facts[kind] = kernel_env.get("facts") or {}
                    break
                if state in ("failed", "cancelled", "interrupted"):
                    err = job.get("error") or {}
                    raise KernelJobError(
                        "GET", "/v1/jobs/%s" % job_id, 200,
                        "作业进入终态 %s: %s" % (state, json.dumps(err, ensure_ascii=False)[:300]),
                    )
                # queued/running: 长轮询到点未醒 -> 继续下一轮挂起等待
        return facts
    except Exception as exc:
        logger.warning(
            "[AudioAnalysis] 内核作业通道不可用(调用方按 requeue 处理): %s", exc
        )
        return None


# B2: 残留两件(A1 移植 aed/breath)的 kind 名
# 2026-10-07 analyze.emotion 整体移除: emotion2vec_plus_base 在 funasr 1.3.22
# 下 decoder 权重 miss、输出恒空(零消费方), 不再提交(内核 handlers 不动)。
RESIDUAL_KINDS = ("analyze.aed", "analyze.breath")


def run_residual_analysis_jobs(
    audio_path: str,
    *,
    vad_timeline_ms: "Optional[List[Dict[str, int]]]" = None,
    wait: int = 30,
    deadline_s: float = 600.0,
) -> "Dict[str, Optional[Dict[str, Any]]]":
    """B2: 提交 analyze.aed/breath 两残留作业, 逐 kind 独立收割。

    与主链四 kind 的差异是失败粒度: 主链任一失败 -> 整体 None(requeue);
    残留两件任一失败/不可达 -> 仅该 kind 值为 None(字段级降级为
    空/未校准, 对齐旧代码 try/except 粒度), 绝不回退本地模型, 也不触发重投
    (主链已成功, 重投会白耗四个重作业)。

    Args:
        audio_path: 旁路 wav 绝对路径(同机直读)
        vad_timeline_ms: [{"start_ms","end_ms"}] VAD 段(breath 掩码, 缺省内核自跑)

    Returns:
        {"analyze.aed": facts|None, "analyze.breath": facts|None}
    """
    import os
    import time

    out: "Dict[str, Optional[Dict[str, Any]]]" = {
        "analyze.aed": None, "analyze.breath": None,
    }
    abs_path = os.path.abspath(audio_path)
    specs: "Dict[str, dict]" = {}
    specs["analyze.aed"] = {}
    if vad_timeline_ms:
        specs["analyze.breath"] = {"vad_timeline": [
            {"start_ms": int(v["start_ms"]), "end_ms": int(v["end_ms"])}
            for v in vad_timeline_ms
        ]}
    else:
        specs["analyze.breath"] = {}
    try:
        from services.kernel_client import get_kernel_client

        kc = get_kernel_client()
        kc.ensure()
        if not kc.base_url or not kc.token:
            raise KernelJobError(
                "ENSURE", str(kc.base_url or ""), 0, "内核 base_url/token 未就绪"
            )
        client = KernelJobClient(kc.base_url, kc.token, timeout=float(wait) + 15.0)

        job_ids: "Dict[str, str]" = {}
        for kind, options in specs.items():
            try:
                resp = client.submit(kind, input={"path": abs_path}, options=options)
                job_id = str(resp.get("id") or "")
                if not job_id:
                    raise KernelJobError(
                        "POST", "/v1/jobs", 200,
                        json.dumps(resp, ensure_ascii=False)[:300],
                    )
                job_ids[kind] = job_id
            except Exception as exc:
                # 单 kind 提交失败(503/429/断连) -> 该字段降级, 其余照常
                logger.warning(
                    "[AudioAnalysis] 残留作业提交失败(%s, 字段降级): %s", kind, exc
                )

        deadline = time.time() + float(deadline_s)
        for kind, job_id in job_ids.items():
            try:
                while True:
                    remaining = deadline - time.time()
                    if remaining <= 0:
                        raise KernelJobError(
                            "GET", "/v1/jobs/%s" % job_id, 0, "等待残留作业超时"
                        )
                    poll = min(int(wait), max(int(remaining), 1))
                    job = client.get_job(job_id, wait=poll)
                    state = str(job.get("state") or "")
                    if state == "done":
                        kernel_env = ((job.get("result") or {}).get("kernel") or {})
                        out[kind] = kernel_env.get("facts") or {}
                        break
                    if state in ("failed", "cancelled", "interrupted"):
                        err = job.get("error") or {}
                        logger.warning(
                            "[AudioAnalysis] 残留作业失败(%s, 字段降级): %s",
                            kind, json.dumps(err, ensure_ascii=False)[:200],
                        )
                        break
            except Exception as exc:
                logger.warning(
                    "[AudioAnalysis] 残留作业收割异常(%s, 字段降级): %s", kind, exc
                )
        return out
    except Exception as exc:
        # 通道整体不可用: 三字段全降级(主链已成功, 不触发 requeue)
        logger.warning(
            "[AudioAnalysis] 残留作业通道不可用(三字段降级): %s", exc
        )
        return out


def unknown_track(
    file_key: str,
    *,
    audio_path: "Optional[str]" = None,
    artifact: "Optional[str]" = None,
    start_epoch_ms: "Optional[int]" = None,
    device_t: "Optional[str]" = None,
    timeout: float = 300.0,
) -> "Optional[Dict[str, Any]]":
    """B2: POST /v1/unknown/track 薄封装(sync 通道, 走 kernel_client.srequest)。

    陌生人 L1-L4 整链在内核内闭环(A4), 外层只喂音频+读结论:
      - file_key: 幂等溯源键(同 key 重复调用内核回 reason=duplicate 不再喂送)
      - audio_path: 本地 16k mono s16 WAV 路径 -> 读一次字节 base64 直传
        (不转 numpy 数组, 避免 float32 二次膨胀; 120s chunk ≈ 3.9MB)
      - artifact: 已上传产物 id(与 audio_path 二选一)
      - 失败/不可达 -> None(unknown 字段留空, 绝不回退本地建档)

    Returns:
        facts {"file_key","blocks":[{start_ms,end_ms,unk_id,kind,name,ref_sim,
        count,is_new}],"profiles_touched","pending_count","reason"} 或 None。
    """
    try:
        import base64

        from services.kernel_client import get_kernel_client

        body: "Dict[str, Any]" = {"file_key": file_key}
        if artifact is not None:
            body["artifact"] = artifact
        elif audio_path is not None:
            with open(audio_path, "rb") as fh:
                body["audio_b64"] = base64.b64encode(fh.read()).decode("ascii")
        if start_epoch_ms is not None:
            body["start_epoch_ms"] = int(start_epoch_ms)
        if device_t:
            body["device_t"] = str(device_t)
        result = get_kernel_client().srequest(
            "POST", "/v1/unknown/track", json=body, timeout=timeout,
        )
        return (result or {}).get("facts") or {}
    except Exception as exc:
        # 含 KernelUnavailable/KernelHttpError/OSError: 统一降级不抛(陌生人不建档)
        logger.warning(
            "[UnknownTrack] track 调用失败(unknown 字段留空, 不本地建档) "
            "file_key=%s: %s", str(file_key)[:80], str(exc)[:200],
        )
        return None
