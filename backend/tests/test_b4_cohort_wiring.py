# -*- coding: utf-8 -*-
"""B4 外层接线测试：admin cohort 三端点 + vaudit cohort 面板全部切内核。

约定（对齐 test_kernel_wiring.py 的 fake-httpx 缝手法，但全部在本新文件，
不改 B2 领地文件）：
  - POST /api/admin/cohort/{reload,compact}、GET /api/admin/cohort/stats ->
    内核 /v1/voiceprint/cohort/{reload,compact,stats}（httpx MockTransport 桩，
    绝不 spawn 真内核）；响应形状向后兼容（success/active/message/buffer 键）
  - GET /api/vaudit/cohort?source=audit -> 内核 GET /v1/voiceprint/cohort/audit
    （offset/limit/date/sim_min 透传 + limit clamp 1000；audio_url 外层拼接）
  - GET /api/vaudit/cohort?source=active -> 内核 GET /v1/voiceprint/cohort
    （工作集全量，过滤/分页/统计在外层）
  - 内核不可达 -> admin 503 {"error":{"code":"state.unavailable"}}、
    vaudit 503 detail 字符串；内核业务错误原样透传
"""
import json

import httpx
import pytest

from services import kernel_client as kc


# ============================================================
# 测试辅助（本文件自带，不 import test_kernel_wiring）
# ============================================================

def _envelope(facts: dict) -> dict:
    return {
        "schema_version": "1",
        "facts": facts,
        "provenance": {
            "model_id": "m", "model_hash": "h", "cohort_hash": "c",
            "preprocessing_version": "p", "computed_at": "2026-01-01T00:00:00Z",
        },
    }


def _stub(handler):
    """构造打桩内核客户端（已连接，不 spawn）。"""
    return kc.KernelClient(
        base_url="http://kernel.test", token="t",
        transport=httpx.MockTransport(handler),
    )


def _down_client():
    def _raise(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)

    return _stub(_raise)


@pytest.fixture
def patch_kernel(monkeypatch):
    """工厂夹具：patch_kernel(handler_or_client) -> 安装内核桩。"""

    def _install(client_or_factory):
        client = (client_or_factory() if callable(client_or_factory)
                  else client_or_factory)
        monkeypatch.setattr(kc, "get_kernel_client", lambda: client)
        kc._reset_down_state()
        return client

    return _install


_AUDIT_ITEM = {
    "t": "2026-09-05T10:00:00", "src": "100000_default.wav",
    "src_start": 1.0, "src_end": 3.5, "dur": 2.5, "sim": 0.15,
    "rms": 0.09, "env": "", "speech_prob": 0.9, "status": "auto",
    "reviewed": False, "rejected": False, "quality": {},
}


# ============================================================
# 1) admin 三端点转发与响应映射
# ============================================================

def test_admin_reload_forwards_and_maps(client, auth_headers, patch_kernel):
    seen = {}

    def _handler(request: httpx.Request) -> httpx.Response:
        seen["method"] = request.method
        seen["path"] = request.url.path
        assert request.headers["Authorization"] == "Bearer t"
        return httpx.Response(200, json=_envelope({"reloaded": True, "count": 3}))

    patch_kernel(_stub(_handler))
    resp = client.post("/api/admin/cohort/reload", headers=auth_headers)
    assert resp.status_code == 200, resp.text
    assert seen == {"method": "POST", "path": "/v1/voiceprint/cohort/reload"}
    # 向后兼容旧形状: {success, active, message}
    body = resp.json()
    assert body["success"] is True
    assert body["active"] == 3
    assert "3 条" in body["message"]


def test_admin_compact_forwards_and_maps(client, auth_headers, patch_kernel):
    seen = {}

    def _handler(request: httpx.Request) -> httpx.Response:
        seen["method"] = request.method
        seen["path"] = request.url.path
        return httpx.Response(200, json=_envelope({
            "active_count": 500, "audit_count": 1523, "kept": 500,
            "dropped_rejected": 12, "before": 480,
        }))

    patch_kernel(_stub(_handler))
    resp = client.post("/api/admin/cohort/compact", headers=auth_headers)
    assert resp.status_code == 200, resp.text
    assert seen == {"method": "POST", "path": "/v1/voiceprint/cohort/compact"}
    body = resp.json()
    # 旧键全集: success/active/total_audit/message；total_audit 修正为审计总数
    assert body["success"] is True
    assert body["active"] == 500
    assert body["total_audit"] == 1523
    assert "压缩完成" in body["message"]
    # 内核增量信息（additive 键）
    assert body["dropped_rejected"] == 12
    assert body["before"] == 480


def test_admin_stats_maps_buffer(client, auth_headers, patch_kernel):
    seen = {}

    def _handler(request: httpx.Request) -> httpx.Response:
        seen["method"] = request.method
        seen["path"] = request.url.path
        return httpx.Response(200, json=_envelope({"active": 7, "buffer": 0}))

    patch_kernel(_stub(_handler))
    resp = client.get("/api/admin/cohort/stats", headers=auth_headers)
    assert resp.status_code == 200, resp.text
    assert seen == {"method": "GET", "path": "/v1/voiceprint/cohort/stats"}
    # 旧形状逐键一致 {active, buffer}
    assert resp.json() == {"active": 7, "buffer": 0}


def test_admin_stats_missing_facts_degrades_to_zero(
    client, auth_headers, patch_kernel,
):
    """内核返回非法/缺 facts -> 计数回 0（不 500，不猜值）。"""
    patch_kernel(_stub(lambda r: httpx.Response(200, json={})))
    resp = client.get("/api/admin/cohort/stats", headers=auth_headers)
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"active": 0, "buffer": 0}


# ============================================================
# 2) admin 不可达降级 / 内核错误透传
# ============================================================

def test_admin_endpoints_kernel_down_503(client, auth_headers, patch_kernel):
    patch_kernel(_down_client())
    for method, path in (("POST", "/api/admin/cohort/reload"),
                         ("POST", "/api/admin/cohort/compact"),
                         ("GET", "/api/admin/cohort/stats")):
        resp = client.request(method, path, headers=auth_headers)
        assert resp.status_code == 503, (path, resp.text)
        err = resp.json()["error"]
        assert err["code"] == "state.unavailable"
        assert err["retryable"] is True


def test_admin_kernel_business_error_passthrough(client, auth_headers, patch_kernel):
    """内核封闭错误（如 state.unavailable 读盘失败 503 / input.invalid 400）原样透传。"""
    body = {"error": {"code": "input.invalid", "message": "nope",
                      "retryable": False}}
    patch_kernel(_stub(lambda r: httpx.Response(400, json=body)))
    resp = client.post("/api/admin/cohort/reload", headers=auth_headers)
    assert resp.status_code == 400, resp.text
    assert resp.json() == body


# ============================================================
# 3) vaudit cohort 面板：audit 源（内核分页端点）
# ============================================================

def test_vaudit_cohort_audit_via_kernel(client, auth_headers, patch_kernel):
    seen = {}

    def _handler(request: httpx.Request) -> httpx.Response:
        seen["path"] = request.url.path
        seen["query"] = dict(request.url.params)
        return httpx.Response(200, json=_envelope({
            "count": 1, "total": 2, "offset": 0, "limit": 300,
            "stats": {"n": 2, "mean": 0.16, "median": 0.16,
                      "min": 0.15, "max": 0.17},
            "items": [dict(_AUDIT_ITEM)],
        }))

    patch_kernel(_stub(_handler))
    resp = client.get("/api/vaudit/cohort",
                      params={"source": "audit", "offset": 0, "limit": 300},
                      headers=auth_headers)
    assert resp.status_code == 200, resp.text
    assert seen["path"] == "/v1/voiceprint/cohort/audit"
    assert seen["query"]["offset"] == "0"
    assert seen["query"]["limit"] == "300"
    body = resp.json()
    # 旧响应形状向后兼容: status/source/total/offset/limit/stats/voices
    assert body["status"] == "ok"
    assert body["source"] == "audit"
    assert body["total"] == 2
    assert body["stats"]["n"] == 2
    assert len(body["voices"]) == 1
    v = body["voices"][0]
    # audio_url 由外层按溯源字段拼接（业务保留）
    assert v["audio_url"] == ("/api/vaudit/cohort/audio?date=2026-09-05"
                              "&src=100000_default.wav&start=1.0&end=3.5")
    assert v["sim"] == 0.15
    assert "embedding" not in v


def test_vaudit_cohort_audit_delegates_filters(client, auth_headers, patch_kernel):
    """date/sim_min 透传给内核（内核侧过滤，外层不再二次过滤）。"""
    seen = {}

    def _handler(request: httpx.Request) -> httpx.Response:
        seen["query"] = dict(request.url.params)
        return httpx.Response(200, json=_envelope({
            "count": 0, "total": 0, "offset": 10, "limit": 50,
            "stats": {}, "items": [],
        }))

    patch_kernel(_stub(_handler))
    resp = client.get("/api/vaudit/cohort",
                      params={"source": "audit", "offset": 10, "limit": 50,
                              "date": "2026-09-05", "sim_min": 0.2},
                      headers=auth_headers)
    assert resp.status_code == 200, resp.text
    q = seen["query"]
    assert q["date"] == "2026-09-05" and q["sim_min"] == "0.2"
    body = resp.json()
    assert body["total"] == 0 and body["voices"] == []
    # stats 缺省形状（空 stats 不炸前端）
    assert body["stats"] == {}


def test_vaudit_cohort_audit_limit_clamped(client, auth_headers, patch_kernel):
    """limit 超限被外层 clamp 到内核上限 1000（负 offset 归 0）。"""
    seen = {}

    def _handler(request: httpx.Request) -> httpx.Response:
        seen["query"] = dict(request.url.params)
        return httpx.Response(200, json=_envelope({
            "count": 0, "total": 0, "offset": 0, "limit": 1000,
            "stats": {}, "items": [],
        }))

    patch_kernel(_stub(_handler))
    resp = client.get("/api/vaudit/cohort",
                      params={"source": "audit", "offset": -5, "limit": 99999},
                      headers=auth_headers)
    assert resp.status_code == 200, resp.text
    assert seen["query"]["limit"] == "1000"
    assert seen["query"]["offset"] == "0"


# ============================================================
# 4) vaudit cohort 面板：active 源（内核工作集清单 + 外层过滤分页）
# ============================================================

def test_vaudit_cohort_active_via_kernel(client, auth_headers, patch_kernel):
    def _handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/voiceprint/cohort"
        return httpx.Response(200, json=_envelope({
            "count": 3, "source": "active",
            "items": [
                dict(_AUDIT_ITEM),
                dict(_AUDIT_ITEM, sim=0.30, t="2026-09-06T10:00:00"),
                dict(_AUDIT_ITEM, sim=0.10),
            ],
        }))

    patch_kernel(_stub(_handler))
    resp = client.get("/api/vaudit/cohort",
                      params={"source": "active"}, headers=auth_headers)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["source"] == "active"
    assert body["total"] == 3
    # stats 覆盖过滤后全集（三值 0.15/0.30/0.10 -> mean 0.1833）
    assert body["stats"]["n"] == 3
    assert body["stats"]["min"] == 0.1 and body["stats"]["max"] == 0.3
    assert len(body["voices"]) == 3

    # date 过滤: 只留 2026-09-05 两条
    resp2 = client.get("/api/vaudit/cohort",
                       params={"source": "active", "date": "2026-09-05"},
                       headers=auth_headers)
    body2 = resp2.json()
    assert body2["total"] == 2
    assert body2["stats"]["n"] == 2


def test_vaudit_cohort_active_pagination_and_sim_min(client, auth_headers, patch_kernel):
    def _handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=_envelope({
            "count": 3, "source": "active",
            "items": [
                dict(_AUDIT_ITEM),
                dict(_AUDIT_ITEM, sim=0.30),
                dict(_AUDIT_ITEM, sim=0.10),
            ],
        }))

    patch_kernel(_stub(_handler))
    resp = client.get("/api/vaudit/cohort",
                      params={"source": "active", "sim_min": 0.12,
                              "offset": 0, "limit": 1},
                      headers=auth_headers)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    # sim_min=0.12 过滤掉 0.10 -> total 2；limit 1 -> 本页 1 条
    assert body["total"] == 2
    assert len(body["voices"]) == 1
    assert body["voices"][0]["sim"] in (0.15, 0.30)


def test_vaudit_cohort_invalid_source_400(client, auth_headers, patch_kernel):
    patch_kernel(_stub(lambda r: httpx.Response(200, json=_envelope({}))))
    resp = client.get("/api/vaudit/cohort",
                      params={"source": "bogus"}, headers=auth_headers)
    assert resp.status_code == 400, resp.text


# ============================================================
# 5) vaudit 不可达降级（不回退读外层旧快照文件）
# ============================================================

def test_vaudit_cohort_kernel_down_503(client, auth_headers, patch_kernel):
    patch_kernel(_down_client())
    for src in ("audit", "active"):
        resp = client.get("/api/vaudit/cohort",
                          params={"source": src}, headers=auth_headers)
        assert resp.status_code == 503, (src, resp.text)
        # 外层统一异常处理器形状: {success:false, error:{code,message}}
        body = resp.json()
        assert body["error"]["code"] == "SERVICE_UNAVAILABLE"
        assert "内核不可达" in body["error"]["message"]


def test_vaudit_cohort_kernel_business_error_status(client, auth_headers, patch_kernel):
    body = {"error": {"code": "state.unavailable",
                      "message": "cohort 第 3 行损坏", "retryable": True}}
    patch_kernel(_stub(lambda r: httpx.Response(503, json=body)))
    resp = client.get("/api/vaudit/cohort",
                      params={"source": "audit"}, headers=auth_headers)
    assert resp.status_code == 503, resp.text
    assert "state.unavailable" in resp.json()["error"]["message"]


# ============================================================
# 6) 回归锁：admin.py 不再依赖 voiceprint_service（import 面清零）
# ============================================================

def test_admin_router_imports_no_voiceprint_service():
    import routers.admin as admin_mod

    src = open(admin_mod.__file__, encoding="utf-8").read()
    assert "voiceprint_service" not in src, \
        "admin.py 必须摘除 voiceprint_service 依赖（cohort 真相源在内核）"


def test_admin_router_no_local_cohort_file_io():
    """admin 域代码零文件 IO（真相源在内核 state-dir，路由只转发不读盘）。"""
    import routers.admin as admin_mod

    src = open(admin_mod.__file__, encoding="utf-8").read()
    # 剔除 docstring 后不允许出现文件 IO 原语（docstring 提及历史归档路径是注释）
    import ast

    tree = ast.parse(src)
    code_parts = []
    for node in ast.walk(tree):
        if isinstance(node, (ast.Import, ast.ImportFrom, ast.Call,
                             ast.Assign, ast.AnnAssign)):
            code_parts.append(ast.get_source_segment(src, node) or "")
    code = "\n".join(code_parts)
    assert "open(" not in code, "admin.py 不应有文件读取"
    assert "voiceprint_service" not in code, \
        "admin.py 不应 import voiceprint_service"
    assert "os.path" not in code, "admin.py 不应拼本地 cohort 路径"


# ============================================================
# 7) vaudit metrics 中继保持不动（回归）
# ============================================================

def test_vaudit_cohort_metrics_still_via_kernel(client, auth_headers, patch_kernel):
    seen = {}

    def _handler(request: httpx.Request) -> httpx.Response:
        seen["path"] = request.url.path
        return httpx.Response(200, json=_envelope({"status": "ok", "n": 500}))

    patch_kernel(_stub(_handler))
    resp = client.get("/api/vaudit/cohort/metrics", headers=auth_headers)
    assert resp.status_code == 200, resp.text
    assert seen["path"] == "/v1/voiceprint/cohort/metrics"
    assert resp.json()["metrics"]["n"] == 500


# ============================================================
# 8) rebuild 脚本层：请求形状 / 候选筛选 / dry-run 零网络
# ============================================================

import base64  # noqa: E402
import importlib.util  # noqa: E402
import io  # noqa: E402
import os  # noqa: E402
import struct  # noqa: E402
import wave  # noqa: E402

_SCRIPTS_DIR = os.path.join(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__))), "scripts")


def _load_script(name):
    """按文件加载脚本模块（脚本 import 副作用含 os.chdir，用后即恢复）。"""
    cwd0 = os.getcwd()
    try:
        spec = importlib.util.spec_from_file_location(
            name, os.path.join(_SCRIPTS_DIR, name + ".py"))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod
    finally:
        os.chdir(cwd0)


def _write_wav16k(path: str, seconds: float = 5.0) -> None:
    """写 16k/mono/16bit 方波 WAV（RMS≈0.37, 足以通过脚本能量预筛）。"""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    sr = 16000
    n = int(sr * seconds)
    with wave.open(path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(b"".join(
            struct.pack("<h", 12000 if (i // 800) % 2 == 0 else -12000)
            for i in range(n)))


def test_rebuild_cohort_score_window_request_shape(monkeypatch):
    """逐窗 POST 内核 score：collect:true + collect_meta 四溯源键 + 16k WAV b64。"""
    rc = _load_script("rebuild_cohort")
    import numpy as np

    captured = {}

    class _FakeClient:
        def srequest(self, method, path, *, json=None, timeout=None):
            captured["method"] = method
            captured["path"] = path
            captured["body"] = json
            return _envelope({"scores": {}, "collected": True,
                              "collect_reason": "written"})

    facts = rc.score_window(
        _FakeClient(), np.zeros(32000, dtype=np.float32),
        "100000_default.wav", "10:00:00", 1.0, 3.0,
    )
    assert facts["collected"] is True
    assert captured["method"] == "POST"
    assert captured["path"] == "/v1/voiceprint/score"
    body = captured["body"]
    assert body["collect"] is True
    assert "sliding" not in body
    meta = body["collect_meta"]
    assert meta == {"src_file": "100000_default.wav", "src_t": "10:00:00",
                    "src_start": 1.0, "src_end": 3.0}
    # audio_b64 必须是合法 16k/mono/16bit WAV（内核输入硬约束）
    raw = base64.b64decode(body["audio_b64"])
    with wave.open(io.BytesIO(raw), "rb") as wf:
        assert wf.getnchannels() == 1
        assert wf.getsampwidth() == 2
        assert wf.getframerate() == 16000


def test_rebuild_cohort_audit_total_via_kernel(monkeypatch):
    """audit 进度计数走内核 audit 端点（limit=1 只取 total）。"""
    rc = _load_script("rebuild_cohort")
    seen = {}

    class _FakeClient:
        def srequest(self, method, path, *, json=None, timeout=None):
            seen["method"] = method
            seen["path"] = path
            return _envelope({"count": 1, "total": 1523, "offset": 0,
                              "limit": 1, "stats": {}, "items": []})

    assert rc.audit_total(_FakeClient()) == 1523
    assert seen["method"] == "GET"
    assert seen["path"].startswith("/v1/voiceprint/cohort/audit")
    assert "limit=1" in seen["path"]


def test_rebuild_cohort_dry_run_no_kernel_calls(tmp_path, monkeypatch, capsys):
    """dry-run 只扫描计数：srequest 一旦被调用即 AssertionError（零网络证明）。"""
    rc = _load_script("rebuild_cohort")
    wav = str(tmp_path / "data" / "daily" / "2026-09-03" / "audio" / "100000_default.wav")
    _write_wav16k(wav, seconds=5.0)

    def _boom(*a, **k):
        raise AssertionError("dry-run 不得调用内核")

    monkeypatch.setattr(kc.KernelClient, "srequest", _boom)
    monkeypatch.setattr(kc.KernelClient, "available", lambda self, **k: True)
    rc.main(["10", "--days", "2026-09-03",
             "--data-root", str(tmp_path / "data"), "--dry-run"])
    out = capsys.readouterr().out
    assert "试采" in out and "扫描 1 文件" in out


def test_rebuild_from_perception_candidates_filter(tmp_path):
    """perception 候选筛选：有文本 + sim<0.25 + dur>=2s + 仅 .wav + 路径解析。"""
    rp = _load_script("rebuild_cohort_from_perception")
    day = "2026-09-03"
    audio_rel = f"daily/{day}/audio/100000_default.wav"
    _write_wav16k(str(tmp_path / "data" / audio_rel), seconds=5.0)
    lines = [
        # 命中：真文本, sim<0.25, dur=3s
        {"type": "voice", "t": "10:00:00", "audio": audio_rel,
         "segs": [{"text": "你好世界呀", "start": 0.5, "end": 3.5,
                   "vp": {"sim": 0.1}}]},
        # 拒：nospeech
        {"type": "voice", "t": "10:01:00", "audio": audio_rel,
         "segs": [{"text": "<|nospeech|>", "start": 0.0, "end": 5.0,
                   "vp": {"sim": 0.1}}]},
        # 拒：sim 过高
        {"type": "voice", "t": "10:02:00", "audio": audio_rel,
         "segs": [{"text": "这是本人语音", "start": 0.0, "end": 4.0,
                   "vp": {"sim": 0.6}}]},
        # 拒：时长不足
        {"type": "voice", "t": "10:03:00", "audio": audio_rel,
         "segs": [{"text": "太短了", "start": 0.0, "end": 1.0,
                   "vp": {"sim": 0.1}}]},
        # 非 voice 类型忽略
        {"type": "sensor", "t": "10:04:00"},
    ]
    pf = tmp_path / "data" / "daily" / day / "perception.jsonl"
    pf.parent.mkdir(parents=True, exist_ok=True)
    pf.write_text("\n".join(json.dumps(d, ensure_ascii=False) for d in lines),
                  encoding="utf-8")

    cands = rp.collect_candidates(str(tmp_path / "data"), [day])
    assert len(cands) == 1
    c = cands[0]
    assert c["start"] == 0.5 and c["end"] == 3.5
    assert c["ts"] == "2026-09-03T10:00:00"
    assert os.path.isfile(c["wav"])


def test_rebuild_scripts_no_voiceprint_service_import():
    """两个 rebuild 脚本 import 面清零：不依赖 voiceprint_service / 本地模型。

    用 AST 检查真实代码（docstring 提及迁移历史属合法，不算 import）。
    """
    for name in ("rebuild_cohort", "rebuild_cohort_from_perception"):
        path = os.path.join(_SCRIPTS_DIR, name + ".py")
        src = open(path, encoding="utf-8").read()
        tree = __import__("ast").parse(src)
        imported = []
        for node in __import__("ast").walk(tree):
            if isinstance(node, __import__("ast").ImportFrom):
                imported.append(node.module or "")
            elif isinstance(node, __import__("ast").Import):
                imported.extend(a.name for a in node.names)
        assert not any("voiceprint_service" in m for m in imported), \
            f"{name} 仍在 import voiceprint_service: {imported}"
        # 不得再引用本地评分入口
        assert "vp.score_all_v2" not in src, name
        assert "_cohort_mgr" not in src, name

