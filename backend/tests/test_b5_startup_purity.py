# -*- coding: utf-8 -*-
"""B5 启动链纯净性断言：完整 lifespan 冷进程零本地算法/零 ML 重模块。

为什么用 subprocess 而不是进程内 TestClient：
  - conftest 导入 main 后，同 session 的其他测试文件（如
    test_correctness_phase3a / test_voiceprint_double_write）会在函数内
    import voiceprint_service / unknown_speaker_* 等待删模块，pytorch /
    funasr 一旦进入 sys.modules 就不会离开——进程内断言必然被先导测试
    污染，出现假阴性通过或假阳性失败。
  - 冷 subprocess 复刻 conftest 的最小 patch 面（调度器/执行器/脚本
    管理器/auth IO），真实执行 main.lifespan，是对"启动链不再 import
    torch/funasr 全家桶"的唯一可信证明。

预算 ~5-10s（解释器启动 + import main + lifespan 进入/退出），可接受。
"""
import os
import subprocess
import sys

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

_PROBE_SCRIPT = r'''
import hashlib
import os
import sys
from unittest.mock import MagicMock, AsyncMock

sys.path.insert(0, os.getcwd())

# 与 conftest 相同的最小 patch 面: 不真起调度器/脚本管理器/auth 文件 IO
import main as _main

_mock_executor = MagicMock()
_mock_executor.execute = AsyncMock()
_mock_scheduler = MagicMock()
_mock_scheduler.start = AsyncMock()
_mock_scheduler.stop = AsyncMock()
_mock_sr = MagicMock()
_mock_sr.start = AsyncMock()
_mock_sr.stop = AsyncMock()
_main.init_task_executor = MagicMock(return_value=_mock_executor)
_main.init_task_scheduler = MagicMock(return_value=_mock_scheduler)
_main.init_script_runner = MagicMock(return_value=_mock_sr)

import auth
_test_auth = auth.AuthConfig(
    users={"Axeuh": auth.UserInfo(
        password_hash=hashlib.sha256(b"b5-probe").hexdigest(),
        display_name="Axeuh")},
    tokens={},
)
auth.get_auth_config = MagicMock(return_value=_test_auth)
auth.save_auth_config = MagicMock()
auth._auth_config = _test_auth

# B5 陌生人体内检查开关按"未启用"跑（生产由 config.yaml enabled: true 走
# 内核 cleanup 定时任务；本探针只验启动链 import 纯度，不验调度触发）。
import services.unknown_speaker_config as _ucfg
_ucfg.get_unknown_speaker_config = lambda: {}

from fastapi.testclient import TestClient

with TestClient(_main.app) as client:
    resp = client.get("/health")
    assert resp.status_code == 200, f"/health 返回 {resp.status_code}"

# lifespan 完整进入+退出后, 冷进程 sys.modules 必须零 ML 重模块
heavy = {"torch", "torchaudio", "funasr", "sherpa_onnx", "pyannote", "modelscope"}
leaked = sorted(m for m in sys.modules if m.split(".")[0] in heavy)
assert not leaked, f"启动链泄漏重型 ML 模块: {leaked}"

# 待删本地算法模块（C1 对象）同样不得被启动链触达
algo = {
    "audio_processor", "vad_processor", "sound_scene", "sigh_detector",
    "speaker_diarization",
    "services.voiceprint_service", "services.multimodal_audio_manager",
    "services.pyannote_segmenter", "services.unknown_speaker_pipeline",
    "services.unknown_speaker_session", "services.unknown_speaker_session_feed",
    "services.unknown_speaker_matcher", "services.unknown_speaker_profile",
    "services.unknown_speaker_health", "services.unknown_speaker_cleaner",
    "scripts.sortformer_server",
}
algo_leaked = sorted(m for m in sys.modules if m in algo)
assert not algo_leaked, f"启动链触达待删本地算法模块: {algo_leaked}"

print("B5_PROBE_OK")
'''


def test_startup_chain_imports_no_ml_or_local_algorithms():
    """冷 subprocess 跑完整 lifespan：零 torch/funasr/sherpa/pyannote + 零算法模块。"""
    proc = subprocess.run(
        [sys.executable, "-c", _PROBE_SCRIPT],
        cwd=_BACKEND_DIR,
        capture_output=True,
        text=True,
        timeout=180,
    )
    assert proc.returncode == 0, (
        "启动链探针失败（退出码非 0）。\n"
        f"--- stdout(尾部) ---\n{proc.stdout[-3000:]}\n"
        f"--- stderr(尾部) ---\n{proc.stderr[-3000:]}"
    )
    assert "B5_PROBE_OK" in proc.stdout, (
        f"探针未打印 B5_PROBE_OK。\nstdout: {proc.stdout[-2000:]}"
    )


# ============================================================
# P3-V17：routers.perception import 纯度（音频单例入 lifespan 后）
# ============================================================

_V17_PROBE_SCRIPT = r'''
import os
import sys
import threading

sys.path.insert(0, os.getcwd())

# 只 import 路由模块本体：不跑 lifespan、不发任何请求
import routers.perception as perc

# 1) import 侧不得再创建连续性摄入注册表单例（原模块尾 try: 副作用已迁 lifespan）
import services.audio_ingest_registry as _reg
assert _reg._instance is None, "P3-V17: import routers.perception 不得创建 AudioIngestRegistry 单例"

# 2) import 侧不得拉起 AudioIngestSweeper 守护线程
thread_names = [t.name for t in threading.enumerate()]
assert "AudioIngestSweeper" not in thread_names, (
    f"P3-V17: import routers.perception 不得启动 sweeper 线程: {thread_names}"
)

# 3) sink 回调本体仍是可 import 的平函数（main.py lifespan 接线依赖此缝）
assert callable(perc._on_registry_sweep), "P3-V17: _on_registry_sweep 必须是 perception.py 内可导出的平函数"

print("V17_PROBE_OK")
'''


def test_import_perception_router_creates_no_singleton_or_thread():
    """冷 subprocess 仅 import routers.perception：零单例、零 sweeper 线程。

    V17 前行为（回归护栏的反面锚点）：模块尾 try: 副作用当场创建单例并
    懒起 AudioIngestSweeper 线程——本探针在改动前实测 _instance 非 None、
    线程在册（见 /tmp/opencode/vunit-V17.md 改前取证）。
    """
    proc = subprocess.run(
        [sys.executable, "-c", _V17_PROBE_SCRIPT],
        cwd=_BACKEND_DIR,
        capture_output=True,
        text=True,
        timeout=180,
    )
    assert proc.returncode == 0, (
        "V17 import 纯度探针失败（退出码非 0）。\n"
        f"--- stdout(尾部) ---\n{proc.stdout[-3000:]}\n"
        f"--- stderr(尾部) ---\n{proc.stderr[-3000:]}"
    )
    assert "V17_PROBE_OK" in proc.stdout, (
        f"探针未打印 V17_PROBE_OK。\nstdout: {proc.stdout[-2000:]}"
    )
