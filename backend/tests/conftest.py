# -*- coding: utf-8 -*-
"""
Kinship - Pytest 基础设施

本文件在测试 session 启动时执行一次，完成以下工作：

阶段一（模块载入时 - import 侧效）：
  1. 修补 main.py 模块中引用的 init_task_executor / init_task_scheduler，
     避免 lifespan 启动真正的定时任务调度器。
  2. 用内存字典替换 auth.py 的文件级认证配置，避免读写 real auth.json。

阶段二（Fixture 层）：
  - client: FastAPI TestClient，带 lifespan 自动化管理。
  - auth_headers: 调用 /login 获取 Axeuh 用户的 Bearer Token。
  - mock_tts_player: 修补 routers.tts.get_tts_player，避免外部 API 调用。
"""
import hashlib
import os
import shutil
import tempfile
from pathlib import Path
from unittest.mock import MagicMock, AsyncMock
import pytest
from fastapi.testclient import TestClient

# ============================================================
# 第零阶段：测试运行时根（必须先于 config/auth/main 导入）
# ============================================================
# lifespan 会真的启动 ScriptRunner / 小米云后台服务，并可能写
# backend/data 与 ai/data（2026-10-26 门禁实测：目标测试跑一次就拉起生产
# 脚本与云端拉取）。这里用一次性临时根 + ConfigStore 的只读 EnvOverlay
# （AXEUH_SETTINGS__<PATH>，见 config/providers.py:EnvOverlay）把所有可变
# 运行时路径和服务开关重定向到临时目录；生产 config.yaml 仍作为只读基线，
# 不改任何生产文件。测试结束时由 session 级 fixture 删除整个临时根。
TEST_RUNTIME_ROOT = tempfile.mkdtemp(prefix="axeuh-test-runtime-")
os.environ["AXEUH_TEST_RUNTIME_ROOT"] = TEST_RUNTIME_ROOT

_TEST_RUNTIME_PATHS = {
    "AXEUH_SETTINGS__DATA__DIR": "data",
    "AXEUH_SETTINGS__DATA__SESSIONS": "data/cache/usersessions.json",
    "AXEUH_SETTINGS__DATA__TASKS": "tasks",
    "AXEUH_SETTINGS__DATA__VOICEPRINTS": "data/cache/voiceprints.json",
    "AXEUH_SETTINGS__DATA__AI_ROOT": "ai",
    "AXEUH_SETTINGS__DATA__UPLOAD_DIR": "data/uploads",
    "AXEUH_SETTINGS__DATA__TASK_LOGS": "tasks/logs",
    "AXEUH_SETTINGS__DATA__STREAM_DIR": "data/stream",
    "AXEUH_SETTINGS__DATA__HEALTH_DEVICES": "data/health_devices.json",
    "AXEUH_SETTINGS__DATA__HEALTH_SOURCE_SELECTION": "data/health_source_selection.json",
    "AXEUH_SETTINGS__DATA__HEALTH_CLOUD_STATE": "data/health_cloud_state.json",
    "AXEUH_SETTINGS__SCRIPTS__DIR": "tasks",
    "AXEUH_SETTINGS__KERNEL__STATE_DIR": "data/kernel_state",
    "AXEUH_SETTINGS__OTA__APK_DIR": "apk",
}
for _env_name, _relative in _TEST_RUNTIME_PATHS.items():
    _absolute = Path(TEST_RUNTIME_ROOT) / _relative
    _absolute.parent.mkdir(parents=True, exist_ok=True)
    os.environ[_env_name] = str(_absolute)

# 数据根/模型根默认位也必须在临时根内（paths.data_root / models_root 的兜底位）
os.environ["AXEUH_DATA_ROOT"] = str(Path(TEST_RUNTIME_ROOT, "var"))
os.environ["AXEUH_MODELS_DIR"] = str(Path(TEST_RUNTIME_ROOT, "var", "models"))

# 认证状态 / 引导状态独立于生产 backend/config 与 backend/data
os.environ["AXEUH_AUTH_STATE_DIR"] = str(Path(TEST_RUNTIME_ROOT, "auth"))
os.environ["AEUH_ONBOARDING_STATE"] = str(
    Path(TEST_RUNTIME_ROOT, "data", "onboarding_state.json")
)

# 外部服务开关：禁止测试进程发起云端拉取 / QQ / P2P 连接
os.environ["AXEUH_SETTINGS__HEALTH__CLOUD__ENABLED"] = "false"
os.environ["AXEUH_SETTINGS__HEALTH__CLOUD__USERID"] = ""
os.environ["AXEUH_SETTINGS__HEALTH__CLOUD__PASSTOKEN"] = ""
os.environ["AXEUH_SETTINGS__QQ_GATEWAY__ENABLED"] = "false"
os.environ["AXEUH_SETTINGS__P2P__ENABLED"] = "false"

# 任务 17 起 lifespan 恒启动服务面：测试默认关闭编排器，避免真的 spawn
# kernel/loom/moss。需要验证 blocked 语义的用例自行打开并注入 fake spec。
os.environ.setdefault("AXEUH_ORCHESTRATOR", "off")

# 从配置读取端口，避免硬编码
from config.config import get_config
_test_cfg = get_config()
TEST_SERVER_HOST = f"localhost:{_test_cfg.BACKEND_HTTPS_PORT}"

# ============================================================
# 第一阶段：在导入 app 之前修补有副作用的模块级引用
# ============================================================

# 1.1 修补定时任务调度器和执行器
# main.py 在模块顶层做了 from services.task_scheduler import init_task_scheduler 等，
# 这些引用都绑定在 main 模块的全局命名空间中。我们在 lifespan 执行前将其替换为 Mock。
import main as _main

# 1.0 摘除 root logger 上的文件 Handler（2026-10-01 修复测试日志污染生产日志）
# main.py 模块级 setup_logging(None) 会给 root 挂 backend/logs/backend.log 的
# 轮转文件 Handler，导致测试期间的 ERROR/WARNING（含故意的故障注入如 'boom'、
# 'nope'）全部写进生产日志——09-26/27 曾因此混入 1500+ 条假 ERROR 并撑爆 136MB。
# 控制台 Handler 保留便于调试；caplog 走 propagate 不受影响。
import logging as _logging
from logging import FileHandler as _FileHandler

_root = _logging.getLogger()
for _h in list(_root.handlers):
    if isinstance(_h, _FileHandler):
        _root.removeHandler(_h)
        try:
            _h.close()
        except OSError:
            pass

_mock_executor = MagicMock()
_mock_executor.execute = AsyncMock()

_mock_scheduler = MagicMock()
_mock_scheduler.start = AsyncMock()
_mock_scheduler.stop = AsyncMock()

_mock_script_runner = MagicMock()
_mock_script_runner.start = AsyncMock()
_mock_script_runner.stop = AsyncMock()

_main.init_task_executor = MagicMock(return_value=_mock_executor)
_main.init_task_scheduler = MagicMock(return_value=_mock_scheduler)
_main.init_script_runner = MagicMock(return_value=_mock_script_runner)

# Loom 健康探针是后台轮询任务；测试进程不探测生产 Loom。
_main.loom_health.start_loom_health_probe = MagicMock(return_value=None)
_main.loom_health.stop_loom_health_probe = AsyncMock()

# 1.2 修补认证配置使用内存字典而非 auth.json 文件
import auth

_test_password_hash = hashlib.sha256(b"test-password-123").hexdigest()
_test_auth_config = auth.AuthConfig(
    users={
        "Axeuh": auth.UserInfo(
            password_hash=_test_password_hash,
            display_name="Axeuh"
        )
    },
    tokens={}
)

# 替换 auth 模块的全局配置和 IO 函数
auth.get_auth_config = MagicMock(return_value=_test_auth_config)
auth.save_auth_config = MagicMock()
auth._auth_config = _test_auth_config  # 让全局指针直接指向测试配置

# ============================================================
# 第二阶段：导入 app（此时 lifespan 尚未被调用）
# ============================================================
from main import app


# ============================================================
# 第三阶段：Fixture 定义
# ============================================================

@pytest.fixture(autouse=True)
def _stub_config_runtime(monkeypatch, request):
    """隔离 ConfigStore / lifespan 后台服务与状态文件副作用。

    TestClient 每个用例都会跑 lifespan：默认关闭 watcher 线程，引导令牌生成
    替换为空操作，服务 Token 不创建，Loom 探针与小米云后台线程不起。
    直接测试这些真实契约的文件（test_config_store / test_service_token /
    test_auth_device_token / test_auth_setup / test_health_cloud_service）
    保留真实实现。
    """
    nodeid = request.node.nodeid
    if "test_config_store" not in nodeid:
        from config.store import ConfigStore

        monkeypatch.setattr(
            ConfigStore,
            "start_watcher",
            lambda self, loop, interval_s=None: None,
        )
    monkeypatch.setattr(_main, "ensure_bootstrap_token", lambda: "")

    if not any(
        marker in nodeid
        for marker in ("test_service_token", "test_auth_device_token", "test_auth_setup")
    ):
        monkeypatch.setattr(auth, "ensure_service_token", lambda: "")

    if "test_health_cloud_service" not in nodeid:
        from services.health_cloud_service import HealthCloudService

        monkeypatch.setattr(HealthCloudService, "start", lambda self: None)
        monkeypatch.setattr(HealthCloudService, "stop", lambda self: None)
    yield


@pytest.fixture(autouse=True)
def _isolate_onboarding_state_and_app_state(tmp_path, monkeypatch):
    """每个测试独占引导状态文件，并在结束后回滚 main.app.state。

    TestClient 会真实执行 lifespan：它读取 AEUH_ONBOARDING_STATE 指向的
    状态文件，并往 app.state 上写 bootstrap_runtime / startup_validation /
    service_plane_* 等运行时键。若这些状态跨测试共享：

    - 任一测试留下未完成（completed=False）的状态文件，后续所有测试会从
      ``is_bootstrap_mode()`` 得到 True，门禁 503 会级联到无关用例；
    - 测试直接替换 app.state.bootstrap_runtime 后，后续不使用 lifespan 的
      TestClient 会看到残留的 active=True。

    因此测试开始前把状态文件指到本测试的 tmp_path，并快照 app.state._state
    （含 lifespan 之后新建的键），测试结束后原样恢复。测试内显式的
    monkeypatch 覆盖仍按自身生命周期生效。
    """
    app_state = _main.app.state._state
    snapshot = dict(app_state)
    monkeypatch.setenv(
        "AEUH_ONBOARDING_STATE", str(tmp_path / "onboarding_state.json")
    )
    monkeypatch.delenv("AXEUH_ONBOARDING_STATE", raising=False)
    monkeypatch.delenv("AXEUH_ONBOARDING_BOOTSTRAP", raising=False)
    try:
        yield
    finally:
        app_state.clear()
        app_state.update(snapshot)


@pytest.fixture(scope="session", autouse=True)
def _cleanup_test_runtime_root():
    """测试 session 结束后删除模块级临时运行时根。"""
    yield
    shutil.rmtree(TEST_RUNTIME_ROOT, ignore_errors=True)


@pytest.fixture
def client():
    """FastAPI TestClient 实例（自动管理 lifespan 进入/退出）"""
    with TestClient(app) as c:
        yield c


@pytest.fixture
def auth_headers(client):
    """登录 Axeuh 用户并返回 Bearer 认证头字典"""
    resp = client.post("/login", json={
        "username": "Axeuh",
        "password": "test-password-123"
    })
    assert resp.status_code == 200, f"登录失败: {resp.text}"
    data = resp.json()
    assert data["success"] is True
    return {"Authorization": f"Bearer {data['token']}"}


@pytest.fixture(autouse=True)
def _redirect_device_registry(tmp_path, monkeypatch):
    """H6：设备注册表一律重定向到 tmp_path，禁止任何测试写真实
    backend/data/health_devices.json（/api/health/sync 现已接入自动建档）。"""
    import services.health.devices as devices_mod
    monkeypatch.setattr(
        devices_mod, "_registry_path",
        lambda: str(tmp_path / "health_devices.json"),
    )


@pytest.fixture
def mock_vad_service():
    """
    模拟 VAD+ASR 服务
    修补 routers.stt.get_vad_asr_service，避免实际加载 torch / numpy / 阿里云 ASR。
    各测试函数只需声明此 fixture 参数即可激活修补。
    """
    service = MagicMock()
    service._is_running = False
    service._is_awake = False
    service._is_speaking = False
    service._recording = []
    service.config = MagicMock()
    service.config.SILERO_SENSITIVITY = 0.5
    service.config.SILERO_THRESHOLD = 0.5
    service.config.MIN_SPEECH_DURATION = 0.3
    service.config.MIN_SILENCE_DURATION = 0.8
    service.wake_word_config = MagicMock()
    service.wake_word_config.WAKE_WORDS = ["小贺同学"]
    service.wake_word_config.WHISPER_MODEL = "small"
    service.wake_word_config.LISTEN_TIMEOUT = 10.0
    service.wake_word_config.MIN_CONFIDENCE = -1.5
    service.wake_word_config.FUZZY_THRESHOLD = 0.7
    service.start = MagicMock(return_value=True)
    service.stop = MagicMock()
    service.on_result = MagicMock()
    service.on_speech_start = MagicMock()
    service.on_speech_end = MagicMock()
    service.on_wake_word = MagicMock()
    service.on_sleep = MagicMock()
    service.on_error = MagicMock()
    service.on_result_send = MagicMock()
    service.on_realtime = MagicMock()
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr('routers.stt.get_vad_asr_service', lambda: service)
        mp.setattr('services.vad_asr_service.get_vad_service', lambda: None)
        yield service


@pytest.fixture
def mock_tts_player():
    """
    模拟 TTS 播放器（避免真实调用 MiMo API）。
    修补 routers.tts.get_tts_player，各测试声明此参数即可激活。
    """
    player = MagicMock()
    player.is_playing = False
    player.speak_async = AsyncMock(return_value=True)
    player.synthesize_to_bytes = AsyncMock(return_value=(b"mock_audio_data", None))
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr('routers.tts.get_tts_player', lambda: player)
        yield player


# （Wave C2 清理：mock_voiceprint_service / test_audio_wav 两个 fixture 原为
#  已删除的 test_voiceprint.py（本地 enroll/score_all/identify/verify 时代）
#  服务；VoiceprintService 瘦身为纯注册库镜像后无任何消费方，一并移除。）
