# -*- coding: utf-8 -*-
"""config.yaml 的声明式 schema 真源。

供 API 校验、前端表单、--init 问卷与引导共用；只读 config.example.yaml，
不写文件、不发网络请求。高级字段在导入时由模板叶子派生，核心字段显式定义。
"""

from __future__ import annotations

import copy
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Final, Literal, TypedDict

import yaml

from core.redaction import is_secret_path

SCHEMA_VERSION: Final[int] = 1

PROJECT_ROOT: Final[Path] = Path(__file__).resolve().parents[2]
EXAMPLE_CONFIG_PATH: Final[Path] = PROJECT_ROOT / "config.example.yaml"

FieldType = Literal["string", "int", "float", "bool", "enum", "path", "secret", "list"]
ApplyStrategy = Literal["hot", "reconnect", "respawn", "deployment", "none"]
# 旧调用方的只读兼容别名；新代码一律判断 apply_strategy。
RestartScope = Literal["backend", "supervisor", "manual", "none"]
Severity = Literal["error", "warning"]
ScalarValue = str | int | float | bool | None
ConfigValue = ScalarValue | list["ConfigValue"] | dict[str, "ConfigValue"]
ConfigDocument = dict[str, ConfigValue]

ERROR_CODES: Final[frozenset[str]] = frozenset(
    {
        "unknown_key",
        "type_mismatch",
        "enum_invalid",
        "range_invalid",
        "out_of_range",
        "required_missing",
        "cross_field",
        "deprecated_key",
    }
)

DEPRECATED_PATHS: Final[set[str]] = {
    "log.level",
    "voiceprint.min_snr",
    "voiceprint.min_seg_snr",
    "voiceprint.min_consistency",
    "voiceprint.min_speech_ratio",
    "voiceprint.min_duration",
    "voiceprint.vad_threshold",
    "voiceprint.cohort_max_samples",
    "memory.search_threshold",
    "memory.search_limit",
    "agent.default_type",
    "agent.available",
}

_DEPRECATED_TOP_LEVELS: Final[frozenset[str]] = frozenset(
    {"log", "voiceprint", "memory", "agent"}
)
_SENSITIVE_PATHS: Final[frozenset[str]] = frozenset(
    {
        "loom.token",
        "loom.token_file",
        "loom.credentials_file",
        "api.mimo_key",
        "api.dashscope_key",
        "api.baidu_map_ak",
        "opencode.server_password",
        "health.cloud.userid",
        "health.cloud.passtoken",
        "qq_gateway.account.ws_token_file",
        "qq_gateway.mcp.token_file",
    }
)
_LIVE_APPLY_STRATEGY: Final[dict[str, ApplyStrategy]] = {
    "server": "hot",
    "data": "hot",
    "models": "hot",
    "ssl": "hot",
    "auth": "hot",
    "ai_backend": "hot",
    "loom": "hot",
    "opencode": "hot",
    "api": "hot",
    "tts": "hot",
    "audio": "hot",
    "audio_compressor": "hot",
    "unknown_speaker": "hot",
    "health": "hot",
    "pc_sensor": "hot",
    "ota": "hot",
    "scripts": "hot",
    "features": "hot",
    "onboarding": "hot",
    "moss": "reconnect",
    "clients": "hot",
    "qq_gateway": "reconnect",
    "p2p": "reconnect",
    "kernel": "respawn",
    "launcher": "deployment",
}
_APPLY_STRATEGY_EXACT: Final[dict[str, ApplyStrategy]] = {
    # 内核解释器与模型目录只在 spawn 时读取，热改必须重新拉起内核。
    "kernel.python": "respawn",
    "kernel.model_dir": "respawn",
    "opencode.enabled": "deployment",
    "opencode.url": "hot",
    # OpenCode 子进程在 spawn 时读取 Basic 凭据；热改只会轮换客户端凭据而
    # 子进程仍旧持有旧口令（401），故诚实标为部署接线项。
    "opencode.server_password": "deployment",
    "opencode.server_username": "deployment",
    # 前端反向地理编码在构建期注入；后端热应用无法重建已发布的前端产物。
    "api.baidu_map_ak": "deployment",
}
_PLACEHOLDER_MARKERS: Final[tuple[str, ...]] = ("YOUR_", "path/to/your", "example.com")
_TYPE_OVERRIDES: Final[dict[str, FieldType]] = {
    "kernel.nice": "int",
    "qq_gateway.qzone.mode": "string",
}
_FORCED_DEFAULTS: Final[dict[str, ConfigValue]] = {
    "launcher.conda_python": "python",
    "launcher.opencode_cmd": "opencode",
    "health.primary_user": "",
}


class CategoryInfo(TypedDict):
    id: str
    title: str
    description: str
    advanced: bool


CATEGORIES: Final[tuple[CategoryInfo, ...]] = (
    {"id": "server", "title": "服务与端口", "description": "监听地址与 HTTP/HTTPS 端口", "advanced": False},
    {"id": "data", "title": "数据路径", "description": "数据根目录、会话与运行时文件位置", "advanced": False},
    {"id": "ssl", "title": "HTTPS 证书", "description": "TLS 证书与私钥", "advanced": False},
    {"id": "auth", "title": "初始化认证", "description": "首次初始化的防接管开关", "advanced": False},
    {"id": "onboarding", "title": "首次引导", "description": "发行源、前端自愈与内核/模型下载策略", "advanced": False},
    {"id": "ai", "title": "AI 后端", "description": "AI 通道、模型与 Loom 连接", "advanced": False},
    {"id": "api", "title": "第三方密钥", "description": "外部 API 凭据", "advanced": False},
    {"id": "tts", "title": "TTS 路由", "description": "语音回传的设备定向与回退", "advanced": False},
    {"id": "qq_gateway", "title": "QQ 网关", "description": "NapCat WebSocket、收发与投递", "advanced": False},
    {"id": "p2p", "title": "P2P 直连", "description": "设备信令、配对与 WebRTC 数据面", "advanced": False},
    {"id": "kernel", "title": "音频内核", "description": "内核推理设备、CPU 亲和与状态目录", "advanced": False},
    {"id": "moss", "title": "MOSS 深度音频", "description": "外部 vLLM 服务连接", "advanced": False},
    {"id": "health", "title": "健康数据", "description": "多源健康存储与小米云拉取", "advanced": False},
    {"id": "audio", "title": "音频链路", "description": "切分、VAD、声纹、唤醒词与助手", "advanced": False},
    {"id": "audio_compressor", "title": "音频归档", "description": "每日 WAV/FLAC 压缩归档", "advanced": True},
    {"id": "launcher", "title": "启动器", "description": "launcher.py 使用的解释器与命令路径", "advanced": True},
    {"id": "pc_sensor", "title": "PC 采集端", "description": "PC 状态采集器可执行文件", "advanced": True},
    {"id": "features", "title": "功能开关", "description": "调试与实验开关", "advanced": True},
    {"id": "scripts", "title": "自定义脚本", "description": "脚本任务目录", "advanced": True},
    {"id": "ota", "title": "OTA 更新", "description": "APK 构建输出目录", "advanced": True},
    {"id": "clients", "title": "客户端下载", "description": "Android 与 Windows 桌面端发行地址及校验和", "advanced": False},
    {"id": "unknown_speaker", "title": "陌生人识别", "description": "业务开关与内核生命周期参数", "advanced": True},
)

_CATEGORY_IDS: Final[frozenset[str]] = frozenset(category["id"] for category in CATEGORIES)


@dataclass(frozen=True)
class ConfigField:
    path: str
    type: FieldType
    default: ConfigValue
    category: str
    title: str
    help: str
    enum: tuple[str, ...] = ()
    min: float | None = None
    max: float | None = None
    sensitive: bool = False
    apply_strategy: ApplyStrategy = "hot"
    deprecated: bool = False
    advanced: bool = False
    core: bool = False

    @property
    def restart_scope(self) -> RestartScope:
        """旧调用方兼容别名：deployment -> supervisor，其余 -> backend。"""
        if self.apply_strategy == "deployment":
            return "supervisor"
        if self.apply_strategy == "none":
            return "none"
        return "backend"


@dataclass(frozen=True)
class SchemaError:
    path: str
    code: str
    message: str
    severity: Severity = "error"


def _apply_strategy(path: str) -> ApplyStrategy:
    exact = _APPLY_STRATEGY_EXACT.get(path)
    if exact is not None:
        return exact
    top = path.split(".", 1)[0]
    strategy = _LIVE_APPLY_STRATEGY.get(top)
    if strategy is None:
        raise ValueError(f"配置项 {path!r} 的顶层节 {top!r} 缺少 apply_strategy 定义")
    return strategy


def _core(
    path: str,
    field_type: FieldType,
    default: ConfigValue,
    category: str,
    title: str,
    help: str,
    *,
    enum: tuple[str, ...] = (),
    minimum: float | None = None,
    maximum: float | None = None,
    sensitive: bool = False,
    apply_strategy: ApplyStrategy = "hot",
) -> ConfigField:
    return ConfigField(
        path=path,
        type=field_type,
        default=default,
        category=category,
        title=title,
        help=help,
        enum=enum,
        min=minimum,
        max=maximum,
        sensitive=sensitive,
        apply_strategy=apply_strategy,
        core=True,
    )


CORE_FIELDS: Final[tuple[ConfigField, ...]] = (
    _core("server.host", "string", "0.0.0.0", "server", "监听地址",
          "服务监听地址；0.0.0.0 表示全部网卡。"),
    _core("server.port", "int", 8768, "server", "服务端口",
          "App 与 Web 入口端口；HTTP/HTTPS 共用，协议由 ssl.enabled 决定。",
          minimum=1, maximum=65535),
    _core("data.ai_root", "path", "", "data", "AI 根目录",
          "AI 数据、配置、会话与会话产物的单一根目录；空 = 由 data.dir 的父目录推导，"
          "data.dir 也为空时 = <项目根>/ai；相对路径按项目根解析。"),
    _core("data.dir", "path", "", "data", "数据目录",
          "感知与健康数据的根目录；空 = <data.ai_root>/data；相对路径按项目根解析。"),
    _core("data.root", "path", "", "data", "运行时数据根目录",
          "secrets/run/logs 与本地模型的父目录；空 = <项目根>/var；相对路径按项目根解析。"),
    _core("models.dir", "path", "", "data", "模型根目录",
          "本地模型权重根目录；空 = <data.root>/models；相对路径按项目根解析。"),
    _core("ssl.enabled", "bool", True, "ssl", "启用 HTTPS",
          "开启后必须提供可用的证书与私钥。", apply_strategy="deployment"),
    _core("ssl.cert", "path", "", "ssl", "证书文件",
          "PEM 证书路径；相对路径按项目根解析。", apply_strategy="deployment"),
    _core("ssl.key", "path", "", "ssl", "私钥文件",
          "PEM 私钥路径；相对路径按项目根解析。", apply_strategy="deployment"),
    _core("auth.setup_require_token", "bool", True, "auth", "初始化强制令牌",
          "首次初始化是否必须携带 X-Setup-Token；默认开启，显式 false 可关闭 /auth/setup 的令牌校验。"),
    _core("onboarding.release_manifest_url", "string", "", "onboarding", "发行清单地址",
          "引导读取的 release manifest URL；空 = 使用内置默认。"),
    _core("onboarding.release_base_url", "string", "", "onboarding", "发行资产根地址",
          "发行资产的下载根地址；空 = 使用发行清单内的地址。"),
    _core("onboarding.frontend_autodownload", "bool", True, "onboarding", "前端自动下载",
          "dist 缺失时后台下载前端资产；不覆盖已有 dist。"),
    _core("onboarding.kernel_release_tag", "string", "", "onboarding", "内核发行标签",
          "内核发行资产标签；空 = 使用最新发行。"),
    _core("onboarding.allow_model_download", "bool", True, "onboarding", "允许下载模型",
          "允许引导阶段从模型源下载内核模型。"),
    _core("onboarding.model_tiers", "list", ["required", "recommended"], "onboarding", "模型档位",
          "引导默认下载的模型档位列表。"),
    _core("ai_backend", "enum", "opencode", "ai", "AI 后端",
          "助手通道：opencode 或 loom。", enum=("opencode", "loom")),
    _core("opencode.enabled", "bool", True, "ai", "启用 OpenCode 启动",
          "仅控制 launcher 启动与 SSE hub，不切换 ai_backend。", apply_strategy="deployment"),
    _core("opencode.directory", "path", "", "ai", "OpenCode 工作目录",
          "随请求发送的 x-opencode-directory；空 = <data.ai_root>，相对路径按项目根解析。"),
    _core("opencode.url", "string", "http://127.0.0.1:4096", "ai", "OpenCode 地址",
          "OpenCode 服务 URL；启用 OpenCode 时必填。", apply_strategy="hot"),
    _core("opencode.default_agent", "string", "main-task", "ai", "默认 Agent",
          "请求体 agent 字段；缺失时降级运行。"),
    _core("opencode.default_model", "string", "deepseek-flash", "ai", "默认模型",
          "请求体 modelID；缺失时降级运行。"),
    _core("opencode.default_provider", "string", "deepseek", "ai", "默认 Provider",
          "请求体 providerID；缺失时降级运行。"),
    _core("loom.url", "string", "http://127.0.0.1:5100", "ai", "Loom 地址",
          "ai_backend=loom 时必填的助手宿主 URL。"),
    _core("loom.token", "secret", "", "ai", "Loom Token",
          "Bearer 令牌；为空时回退环境变量 LOOM_TOKEN。", sensitive=True),
    _core("api.mimo_key", "secret", "", "api", "MiMo API Key",
          "音频理解与 TTS 使用；仅写入 gitignored 配置。", sensitive=True),
    _core("tts.enabled", "bool", True, "tts", "启用 TTS 路由",
          "关闭后退化为原有广播行为。"),
    _core("tts.device_channel_ttl_seconds", "int", 3600, "tts", "设备通道 TTL",
          "最近发消息设备取得回传所有权的滑动秒数。", minimum=60, maximum=86400),
    _core("qq_gateway.enabled", "bool", False, "qq_gateway", "启用 QQ 网关",
          "启用后校验 QQ 号与 NapCat 地址。", apply_strategy="reconnect"),
    _core("qq_gateway.account.self_qq", "string", "", "qq_gateway", "机器人 QQ 号",
          "纯数字；启用网关时必填。", apply_strategy="reconnect"),
    _core("qq_gateway.account.ws_url", "string", "ws://127.0.0.1:3001", "qq_gateway", "NapCat WebSocket",
          "必须以 ws:// 或 wss:// 开头。", apply_strategy="reconnect"),
    _core("p2p.enabled", "bool", False, "p2p", "启用 P2P",
          "关闭时 /api/p2p/* 返回 404。", apply_strategy="reconnect"),
    _core("p2p.signal_url", "string", "", "p2p", "信令服务地址",
          "启用 P2P 时必填，如 wss://signal.example.net。", apply_strategy="reconnect"),
    _core("p2p.server_id", "string", "home", "p2p", "本机 ID",
          "启用 P2P 时必填；room 为空时作为房间标识。", apply_strategy="reconnect"),
    _core("p2p.pairing_code_ttl_seconds", "int", 300, "p2p", "配对码 TTL",
          "配对码有效期（秒）。", minimum=60, maximum=900, apply_strategy="reconnect"),
    _core("kernel.device", "enum", "cpu", "kernel", "内核推理设备",
          "内核 torch 推理设备。", enum=("cpu", "gpu", "auto", "cuda", "cuda:0", "cuda:1"), apply_strategy="respawn"),
    _core("kernel.python", "path", "", "kernel", "内核解释器",
          "现有 kernel venv 的 Python 路径；空 = 自动探测。", apply_strategy="respawn"),
    _core("kernel.model_dir", "path", "", "kernel", "内核模型目录",
          "内核模型根目录；空 = 内核默认解析链。", apply_strategy="respawn"),
    _core("moss.enabled", "bool", False, "moss", "启用 MOSS",
          "启动/停止 MOSS 分析链（文件订阅与深度分析），不管理 vLLM 推理服务。", apply_strategy="respawn"),
    _core("moss.python", "path", "", "moss", "MOSS 解释器",
          "MOSS watcher 的 Python；空 = 自动探测现有 venv。", apply_strategy="respawn"),
    _core("moss.base_url", "string", "http://127.0.0.1:8100", "moss", "MOSS 服务地址",
          "外部 vLLM MOSS 服务基址（http:// 或 https://）。", apply_strategy="reconnect"),
    _core("moss.model", "string", "moss-audio-4b", "moss", "MOSS 模型",
          "MOSS 服务模型名（非空）。", apply_strategy="reconnect"),
    _core("health.cloud_poll_interval_min", "int", 30, "health", "云端拉取周期",
          "小米云自动拉取间隔（分钟）。", minimum=5, maximum=1440),
    _core("audio.store.upload_ext", "enum", "wav", "audio", "兜底上传格式",
          "magic 嗅探失败时的落盘扩展名。", enum=("wav", "flac")),
    _core("audio.stream.silence_cut_s", "float", 1.5, "audio", "静音切分时长",
          "静音端点持续多久后优先切分（秒）。", minimum=0.5, maximum=10.0),
    _core("audio.stream.force_cut_s", "float", 60.0, "audio", "强制切分上限",
          "直播流硬上限（秒）。", minimum=10.0, maximum=300.0),
    _core("audio.stream.stitch_enabled", "bool", True, "audio", "无缝流",
          "上传分段按时间连续性合并为一条流分析。"),
    _core("audio.wake_word.enabled", "bool", False, "audio", "启用唤醒词",
          "默认关闭；启用前需准备 KWS 模型与词表。"),
    _core("audio.wake_word.keywords_file", "path", "", "audio", "唤醒词表",
          "每行一个词的 UTF-8 词表文件；空 = <data.ai_root>/data/wake_word/keywords.txt。"),
    _core("audio.wake_word.keywords_threshold", "float", 0.25, "audio", "唤醒阈值",
          "KWS 判定阈值。", minimum=0.0, maximum=1.0),
    _core("clients.android_url", "string", "", "clients", "Android 下载地址",
          "Android App 发行资产地址；空 = 尚未发布。"),
    _core("clients.android_sha256", "string", "", "clients", "Android SHA-256",
          "Android App 资产校验和。"),
    _core("clients.desktop_url", "string", "", "clients", "桌面端下载地址",
          "Windows 桌面端发行资产地址；空 = 尚未发布。"),
    _core("clients.desktop_sha256", "string", "", "clients", "桌面端 SHA-256",
          "Windows 桌面端资产校验和。"),
    _core("clients.github_release_tag", "string", "onboarding-v1.0.0", "clients",
          "GitHub 发行标签", "发行页回退使用的标签；空 = releases/latest。"),
    _core("clients.github_release_base", "string", "https://github.com/Xehuri/kinship",
          "clients", "GitHub 仓库基址", "发行页回退基址；空 = 禁用发行页回退。"),
)


def _extra(
    path: str,
    field_type: FieldType,
    default: ConfigValue,
    category: str,
    title: str,
    *,
    sensitive: bool = False,
) -> ConfigField:
    return ConfigField(
        path=path,
        type=field_type,
        default=default,
        category=category,
        title=title,
        help="",
        sensitive=sensitive,
        apply_strategy=_apply_strategy(path),
        advanced=True,
    )


_EXTRA_FIELDS: Final[tuple[ConfigField, ...]] = (
    _extra("api.dashscope_key", "string", "", "api", "DashScope Key", sensitive=True),
    _extra("loom.token_file", "path", "", "ai", "Loom Token 文件", sensitive=True),
    _extra("loom.credentials_file", "path", "", "ai", "Loom 凭据文件", sensitive=True),
    _extra("loom.manage_config", "bool", False, "ai", "托管 Loom 配置"),
    _extra("opencode.model_config_path", "path", "", "ai", "模型配置路径"),
    _extra("data.upload_dir", "path", "", "data", "上传目录"),
    _extra("data.health_cloud_state", "path", "", "data", "小米云状态文件"),
    _extra("data.health_devices", "path", "", "data", "健康设备注册表"),
    _extra("data.health_source_selection", "path", "", "data", "健康源选择文件"),
    _extra("data.task_logs", "path", "", "data", "任务日志目录"),
    _extra("data.stream_dir", "path", "", "data", "流式音频目录"),
    _extra("kernel.state_dir", "path", "backend/data/kernel_state", "kernel", "内核状态目录"),
    _extra("kernel.torch_index_url", "string", "", "kernel", "Torch 安装源"),
    _extra("features.opencode_mock_enabled", "bool", False, "features", "OpenCode Mock"),
    _extra("scripts.dir", "path", "", "scripts", "脚本目录"),
    _extra("ota.apk_dir", "path", "app/build/outputs/apk/debug", "ota", "APK 输出目录"),
    _extra("unknown_speaker.enabled", "bool", False, "unknown_speaker", "启用陌生人识别"),
    _extra("unknown_speaker.detection.two_step.window_ms", "int", 1500, "unknown_speaker", "滑窗长度"),
    _extra("unknown_speaker.detection.two_step.hop_ms", "int", 750, "unknown_speaker", "滑窗步长"),
    _extra("unknown_speaker.lifecycle.ttl_days", "int", 30, "unknown_speaker", "未确认档案 TTL"),
    _extra("unknown_speaker.lifecycle.cleanup_hour", "int", 3, "unknown_speaker", "每日清理小时"),
    _extra("unknown_speaker.lifecycle.max_unknown_count", "int", 200, "unknown_speaker", "未确认档案上限"),
    _extra("unknown_speaker.lifecycle.confirm_min_count", "int", 5, "unknown_speaker", "确认阈值"),
    _extra("unknown_speaker.lifecycle.support_vectors_max", "int", 50, "unknown_speaker", "支持向量上限"),
    _extra("unknown_speaker.lifecycle.dynamic_confirm.enabled", "bool", True, "unknown_speaker", "动态确认"),
    _extra("unknown_speaker.lifecycle.dynamic_confirm.single_confirm_min_count", "int", 5, "unknown_speaker", "单人确认阈值"),
    _extra("unknown_speaker.lifecycle.dynamic_confirm.multi_confirm_min_count", "int", 8, "unknown_speaker", "多人确认阈值"),
)


def _infer_type(path: str, value: ConfigValue) -> FieldType:
    if path in _TYPE_OVERRIDES:
        return _TYPE_OVERRIDES[path]
    if isinstance(value, bool):
        return "bool"
    if isinstance(value, int):
        return "int"
    if isinstance(value, float):
        return "float"
    if isinstance(value, list):
        return "list"
    if path in _SENSITIVE_PATHS:
        return "secret"
    return "string"


def _category_for_path(path: str) -> str:
    top = path.split(".", 1)[0]
    if top in {"ai_backend", "loom", "opencode"}:
        return "ai"
    if top == "models":
        return "data"
    if top not in _CATEGORY_IDS:
        raise ValueError(f"config.example.yaml 顶层节 {top!r} 缺少 CATEGORIES 定义")
    return top


def _sanitize_default(path: str, value: ConfigValue) -> ConfigValue:
    if path in _SENSITIVE_PATHS:
        return ""
    if path in _FORCED_DEFAULTS:
        return _FORCED_DEFAULTS[path]
    if value is None:
        field_type = _infer_type(path, value)
        return {"int": 0, "float": 0.0, "bool": False, "list": []}.get(field_type, "")
    if isinstance(value, str):
        if any(marker in value for marker in _PLACEHOLDER_MARKERS):
            return ""
        return value
    return copy.deepcopy(value)


def _load_example_document() -> ConfigDocument:
    try:
        raw = yaml.safe_load(EXAMPLE_CONFIG_PATH.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError):
        return {}
    return raw if isinstance(raw, dict) else {}


def _get_path(doc: ConfigValue, path: str) -> ConfigValue | None:
    node: ConfigValue = doc
    for part in path.split("."):
        if not isinstance(node, dict) or part not in node:
            return None
        node = node[part]
    return node


def _has_path(doc: ConfigValue, path: str) -> bool:
    node: ConfigValue = doc
    for part in path.split("."):
        if not isinstance(node, dict) or part not in node:
            return False
        node = node[part]
    return True


def _set_path(doc: ConfigDocument, path: str, value: ConfigValue) -> None:
    parts = path.split(".")
    node: ConfigDocument = doc
    for part in parts[:-1]:
        child = node.get(part)
        if not isinstance(child, dict):
            child = {}
            node[part] = child
        node = child
    node[parts[-1]] = copy.deepcopy(value)


def _delete_path(doc: ConfigDocument, path: str) -> None:
    parts = path.split(".")
    node: ConfigValue = doc
    for part in parts[:-1]:
        if not isinstance(node, dict):
            return
        node = node.get(part)
    if isinstance(node, dict):
        node.pop(parts[-1], None)


def iter_leaf_paths(doc: ConfigValue) -> list[str]:
    if not isinstance(doc, dict):
        return []
    paths: list[str] = []

    def walk(node: dict[str, ConfigValue], prefix: str) -> None:
        for key, value in node.items():
            path = f"{prefix}.{key}" if prefix else str(key)
            if isinstance(value, dict) and value:
                walk(value, path)
            else:
                paths.append(path)

    walk(doc, "")
    return paths


def _build_advanced_fields() -> tuple[ConfigField, ...]:
    example = _load_example_document()
    core_paths = {field.path for field in CORE_FIELDS}
    rows: dict[str, ConfigField] = {}
    for path in iter_leaf_paths(example):
        if path.split(".", 1)[0] in _DEPRECATED_TOP_LEVELS or path in core_paths:
            continue
        value = _get_path(example, path)
        rows[path] = ConfigField(
            path=path,
            type=_infer_type(path, value),
            default=_sanitize_default(path, value),
            category=_category_for_path(path),
            title=path,
            help="",
            sensitive=path in _SENSITIVE_PATHS,
            apply_strategy=_apply_strategy(path),
            advanced=True,
        )
    for field in _EXTRA_FIELDS:
        rows[field.path] = field
    order = {category["id"]: index for index, category in enumerate(CATEGORIES)}
    return tuple(sorted(rows.values(), key=lambda field: (order[field.category], field.path)))


ADVANCED_FIELDS: Final[tuple[ConfigField, ...]] = _build_advanced_fields()
FIELDS: Final[tuple[ConfigField, ...]] = CORE_FIELDS + ADVANCED_FIELDS
_FIELD_INDEX: Final[dict[str, ConfigField]] = {field.path: field for field in FIELDS}


def get_field(path: str) -> ConfigField | None:
    return _FIELD_INDEX.get(path)


def apply_strategy_for_path(path: str) -> ApplyStrategy | None:
    field = get_field(path)
    if field is not None:
        return field.apply_strategy
    if path in DEPRECATED_PATHS:
        return "none"
    return None


def resolve_apply_strategy(path: str) -> ApplyStrategy | None:
    """解析任意变更路径的应用策略。

    已知字段/废弃键按字段级声明返回；模板派生的未知叶子回退到所属顶层节
    的默认策略（例如 ``qq_gateway.base_url`` 按 ``qq_gateway`` 判为
    reconnect）。仅用于运行时分派与副作用过滤，写入门禁仍以
    ``apply_strategy_for_path`` 的字段级结果为准。
    """
    strategy = apply_strategy_for_path(path)
    if strategy is not None:
        return strategy
    return _LIVE_APPLY_STRATEGY.get(path.split(".", 1)[0])


def defaults_document() -> ConfigDocument:
    doc: ConfigDocument = {}
    for field in FIELDS:
        _set_path(doc, field.path, field.default)
    ssl = doc.get("ssl")
    if isinstance(ssl, dict) and ssl.get("enabled") is True:
        cert, key = ssl.get("cert"), ssl.get("key")
        if not (isinstance(cert, str) and cert and isinstance(key, str) and key):
            ssl["enabled"] = False
    return doc


def _is_secret_config_path(path: str) -> bool:
    return path in _SENSITIVE_PATHS or is_secret_path(path)


def _mask_secret_leaves(node: ConfigValue, prefix: str = "") -> None:
    """按键名递归遮盖未登记字段：覆盖 *token / *key / *secret / *password。"""
    if isinstance(node, list):
        for item in node:
            if isinstance(item, dict):
                _mask_secret_leaves(item, prefix)
        return
    if not isinstance(node, dict):
        return
    for key, value in node.items():
        path = f"{prefix}.{key}" if prefix else str(key)
        if isinstance(value, dict):
            _mask_secret_leaves(value, path)
        elif isinstance(value, list):
            if _is_secret_config_path(path):
                node[key] = "***"
            else:
                _mask_secret_leaves(value, path)
        elif value is not None and value != "" and _is_secret_config_path(path):
            node[key] = "***"


def mask_document(doc: ConfigDocument) -> ConfigDocument:
    masked = copy.deepcopy(doc)
    for field in FIELDS:
        if not field.sensitive or not _has_path(masked, field.path):
            continue
        value = _get_path(masked, field.path)
        if value is None or value == "":
            continue
        _set_path(masked, field.path, "***")
    _mask_secret_leaves(masked)
    return masked


def _type_error(field: ConfigField, value: ConfigValue) -> SchemaError:
    return SchemaError(
        field.path,
        "type_mismatch",
        f"{field.path} 期望 {field.type}，实际为 {type(value).__name__}",
    )


def _range_error(field: ConfigField, value: float) -> SchemaError | None:
    code = "out_of_range" if field.path == "server.port" else "range_invalid"
    if field.min is not None and value < field.min:
        return SchemaError(field.path, code, f"{field.path} 不得小于 {field.min}")
    if field.max is not None and value > field.max:
        return SchemaError(field.path, code, f"{field.path} 不得大于 {field.max}")
    return None


def _check_field_value(field: ConfigField, value: ConfigValue) -> SchemaError | None:
    if field.type == "bool":
        if not isinstance(value, bool):
            return _type_error(field, value)
        return None
    if field.type == "int":
        if isinstance(value, bool) or not isinstance(value, int):
            return _type_error(field, value)
        return _range_error(field, value)
    if field.type == "float":
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return _type_error(field, value)
        return _range_error(field, float(value))
    if field.type == "list":
        if not isinstance(value, list):
            return _type_error(field, value)
        return None
    if not isinstance(value, str):
        return _type_error(field, value)
    if field.enum and value not in field.enum:
        return SchemaError(
            field.path,
            "enum_invalid",
            f"{field.path} 只允许 {', '.join(field.enum)}",
        )
    return None


def _effective(doc: ConfigDocument, path: str) -> ConfigValue:
    field = _FIELD_INDEX[path]
    value = _get_path(doc, path)
    return field.default if value is None else value


def _effective_text(doc: ConfigDocument, path: str) -> str | None:
    value = _effective(doc, path)
    return value if isinstance(value, str) else None


def _effective_bool(doc: ConfigDocument, path: str) -> bool | None:
    value = _effective(doc, path)
    return value if isinstance(value, bool) else None


def _resolve_path(project_root: Path | str, raw: str) -> Path:
    path = Path(raw)
    return path if path.is_absolute() else Path(project_root) / path


def _validate_cross_field(
    doc: ConfigDocument, project_root: Path | str | None
) -> list[SchemaError]:
    errors: list[SchemaError] = []

    host = _effective_text(doc, "server.host")
    if host is not None and not host.strip():
        errors.append(SchemaError("server.host", "required_missing", "server.host 不能为空"))

    if _effective_bool(doc, "ssl.enabled") is True:
        for path in ("ssl.cert", "ssl.key"):
            value = _effective_text(doc, path)
            if value is None:
                continue
            if not value.strip():
                errors.append(SchemaError(path, "required_missing", f"启用 HTTPS 时 {path} 必填"))
            elif project_root is not None and not _resolve_path(project_root, value).is_file():
                errors.append(SchemaError(path, "cross_field", f"{path} 指向的文件不存在"))

    backend = _effective_text(doc, "ai_backend")
    if backend == "loom":
        loom_url = _effective_text(doc, "loom.url")
        if loom_url is not None and not loom_url.strip():
            errors.append(SchemaError("loom.url", "required_missing", "loom.url 不能为空"))
        token = _effective_text(doc, "loom.token") or os.environ.get("LOOM_TOKEN", "")
        if not token.strip():
            token_file = _effective_text(doc, "loom.token_file") or ""
            if not token_file.strip():
                errors.append(
                    SchemaError(
                        "loom.token",
                        "required_missing",
                        "loom.token、LOOM_TOKEN 或 loom.token_file 必填",
                    )
                )
    elif backend == "opencode":
        opencode_url = _effective_text(doc, "opencode.url")
        if opencode_url is not None and not opencode_url.strip():
            errors.append(
                SchemaError("opencode.url", "required_missing", "opencode.url 不能为空")
            )

    for path in (
        "opencode.default_agent",
        "opencode.default_model",
        "opencode.default_provider",
    ):
        if not _has_path(doc, path):
            errors.append(SchemaError(path, "required_missing", f"{path} 必填（缺失时降级运行）"))
            continue
        value = _get_path(doc, path)
        if not isinstance(value, str) or not value.strip():
            errors.append(SchemaError(path, "required_missing", f"{path} 不能为空"))

    if _effective_bool(doc, "qq_gateway.enabled") is True:
        self_qq = _effective_text(doc, "qq_gateway.account.self_qq")
        if self_qq is not None:
            if not self_qq.strip():
                errors.append(
                    SchemaError(
                        "qq_gateway.account.self_qq",
                        "required_missing",
                        "启用 QQ 网关时 self_qq 必填",
                    )
                )
            elif not self_qq.isdigit():
                errors.append(
                    SchemaError(
                        "qq_gateway.account.self_qq",
                        "cross_field",
                        "self_qq 必须为纯数字",
                    )
                )
        ws_url = _effective_text(doc, "qq_gateway.account.ws_url")
        if ws_url is not None:
            if not ws_url.strip():
                errors.append(
                    SchemaError(
                        "qq_gateway.account.ws_url",
                        "required_missing",
                        "启用 QQ 网关时 ws_url 必填",
                    )
                )
            elif not ws_url.startswith(("ws://", "wss://")):
                errors.append(
                    SchemaError(
                        "qq_gateway.account.ws_url",
                        "cross_field",
                        "ws_url 必须以 ws:// 或 wss:// 开头",
                    )
                )

    if _effective_bool(doc, "p2p.enabled") is True:
        signal_url = _effective_text(doc, "p2p.signal_url")
        if signal_url is not None and not signal_url.strip():
            errors.append(
                SchemaError("p2p.signal_url", "required_missing", "启用 P2P 时 signal_url 必填")
            )
        server_id = _effective_text(doc, "p2p.server_id")
        if server_id is not None and not server_id.strip():
            errors.append(
                SchemaError("p2p.server_id", "required_missing", "启用 P2P 时 server_id 必填")
            )

    return errors


def _dedupe(errors: list[SchemaError]) -> list[SchemaError]:
    seen: set[tuple[str, str]] = set()
    unique: list[SchemaError] = []
    for error in errors:
        key = (error.path, error.code)
        if key in seen:
            continue
        seen.add(key)
        unique.append(error)
    return unique


def has_blocking_errors(errors: list[SchemaError]) -> bool:
    return any(error.severity == "error" for error in errors)


def _apply_startup_severity(errors: list[SchemaError], strict: bool) -> list[SchemaError]:
    if strict:
        return errors
    return [
        SchemaError(error.path, error.code, error.message, "warning")
        if error.code == "required_missing" and error.severity == "error"
        else error
        for error in errors
    ]


def validate_document(
    doc: ConfigDocument,
    project_root: Path | str | None = None,
    strict: bool = False,
) -> list[SchemaError]:
    if not isinstance(doc, dict):
        return [SchemaError("", "type_mismatch", "配置根节点必须是映射")]
    errors: list[SchemaError] = []
    for field in FIELDS:
        value = _get_path(doc, field.path)
        if value is None:
            continue
        error = _check_field_value(field, value)
        if error is not None:
            errors.append(error)
    for path in sorted(DEPRECATED_PATHS):
        if _has_path(doc, path):
            # 旧安装里的废弃键是既有事实，只提示不阻塞：显式写入仍由
            # validate_changes 的 changes 分支拒绝。
            errors.append(
                SchemaError(
                    path, "deprecated_key", f"{path} 已废弃，不再生效", "warning"
                )
            )
    errors.extend(_validate_cross_field(doc, project_root))
    return _apply_startup_severity(_dedupe(errors), strict)


def validate_changes(
    current_doc: ConfigDocument,
    changes: dict[str, Any],
    clear_keys: list[str] | None = None,
    project_root: Path | str | None = None,
    strict: bool = False,
) -> tuple[ConfigDocument, list[SchemaError]]:
    merged = copy.deepcopy(current_doc)
    errors: list[SchemaError] = []

    for path, value in changes.items():
        field = get_field(path)
        if field is None:
            if path in DEPRECATED_PATHS:
                errors.append(SchemaError(path, "deprecated_key", f"{path} 已废弃，不再生效"))
            else:
                errors.append(SchemaError(path, "unknown_key", f"{path} 不是已知配置项"))
            continue
        if field.sensitive and (value is None or value == "***" or value == ""):
            continue
        _set_path(merged, path, value)

    for path in clear_keys or []:
        if get_field(path) is None:
            # 删除是收敛动作：文档里真实存在的路径（含废弃键、自定义未知键）
            # 一律允许清除；只有文档里不存在的路径才按未知/废弃拒绝。
            if _has_path(merged, path):
                _delete_path(merged, path)
                continue
            if path in DEPRECATED_PATHS:
                errors.append(SchemaError(path, "deprecated_key", f"{path} 已废弃，不再生效"))
            else:
                errors.append(SchemaError(path, "unknown_key", f"{path} 不是已知配置项"))
            continue
        _delete_path(merged, path)

    errors.extend(validate_document(merged, project_root, strict=strict))
    return merged, _dedupe(errors)
