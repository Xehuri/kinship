# -*- coding: utf-8 -*-
"""
Axeuh PC 感知采集器 - 系统托盘应用

单一进程，多线程模型：
- 主线程：托盘图标（Windows 下必须运行在主线程，否则托盘会卡死）；
  无托盘模式（--no-tray）下主线程等待 shutdown_event
- 子线程：uvicorn HTTP API（本地配置页 + 状态接口），可设置 should_exit 优雅退出
- pc_sensor.SensorManager：自带守护线程，采集窗口 / 无人 / 锁屏数据

启动方式:
    python pc_sensor_app.py            # 用户双击，自动打开配置网页
    python pc_sensor_app.py --silent   # 开机自启，静默驻留托盘，不弹网页
    python pc_sensor_app.py --silent --no-tray --data-dir DIR --parent-pid PID
                                       # 桌面应用内嵌：无托盘、独立数据目录、父进程退出即退出
"""

import hmac
import json
import logging
import os
import re
import secrets
import shutil
import signal
import sys
import threading
import time
import webbrowser
from collections import deque
from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta, timezone
from logging.handlers import RotatingFileHandler
from typing import Any

import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse

# 作为入口脚本运行时，脚本目录在 sys.path 上，pc_sensor 为同级包
from pc_sensor import SensorManager, get_foreground_window, default_device_name  # pyright: ignore[reportImplicitRelativeImport]
from pc_sensor import pairing  # pyright: ignore[reportImplicitRelativeImport]
from pc_sensor.transport import CandidateError  # pyright: ignore[reportImplicitRelativeImport]

try:
    import winreg
except ImportError:  # pragma: no cover - winreg 仅存在于 Windows
    winreg = None


# ============================================================
# 路径处理（兼容 PyInstaller --onefile）
# ============================================================

VERSION = "2.1.0"


def get_resource_dir() -> str:
    """只读资源目录。

    - 打包后：sys._MEIPASS（PyInstaller 解压出的临时目录），包含 static/ 和默认配置
    - 开发时：本模块所在目录
    """
    if getattr(sys, "frozen", False):
        return getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(sys.executable)))
    return os.path.dirname(os.path.abspath(__file__))


def get_app_dir() -> str:
    """可写应用目录。

    - 打包后：exe 所在目录（未指定 --data-dir 时作为默认数据目录）
    - 开发时：本模块所在目录
    """
    if getattr(sys, "frozen", False):
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.dirname(os.path.abspath(__file__))


def parse_arg_value(argv: Sequence[str], flag: str) -> str | None:
    """从命令行参数中取值，支持 `--flag value` 与 `--flag=value`。"""
    prefix = flag + "="
    for index, arg in enumerate(argv):
        if arg.startswith(prefix):
            value = arg[len(prefix):].strip()
            return value or None
        if arg == flag:
            if index + 1 >= len(argv):
                return None
            value = str(argv[index + 1]).strip()
            if value and not value.startswith("--"):
                return value
            return None
    return None


def resolve_data_dir(
    argv: Sequence[str] | None = None,
    env: Mapping[str, str] | None = None,
) -> str:
    """解析数据目录：CLI > PC_SENSOR_DATA_DIR > 当前应用目录。"""
    args = list(sys.argv[1:] if argv is None else argv)
    environ = os.environ if env is None else env
    cli_value = parse_arg_value(args, "--data-dir")
    if cli_value:
        return os.path.abspath(os.path.expanduser(cli_value))
    env_value = str(environ.get("PC_SENSOR_DATA_DIR", "") or "").strip()
    if env_value:
        return os.path.abspath(os.path.expanduser(env_value))
    return get_app_dir()


RESOURCE_DIR = get_resource_dir()
APP_DIR = get_app_dir()
DATA_DIR = resolve_data_dir()
os.makedirs(DATA_DIR, exist_ok=True)

CONFIG_PATH = os.environ.get("PC_SENSOR_CONFIG_PATH") or os.path.join(DATA_DIR, "config.json")
PC_SENSOR_CONFIG_PATH = os.path.join(DATA_DIR, "pc_sensor_config.json")
STATIC_DIR = os.path.join(RESOURCE_DIR, "static")
STATIC_DIR_ABS = os.path.abspath(STATIC_DIR)
LOG_PATH = os.path.join(DATA_DIR, "pc-sensor.log")


def _ensure_default_file(filename: str) -> None:
    """首次运行时把打包进 exe 的默认配置复制到数据目录。

    开发模式下资源目录内的 config.json / pc_sensor_config.json 可能是本机用户配置，
    不复制，避免把真实凭据带进临时数据目录。
    """
    target = os.path.join(DATA_DIR, filename)
    if os.path.exists(target):
        return
    if not getattr(sys, "frozen", False):
        return
    source = os.path.join(RESOURCE_DIR, filename)
    if not os.path.exists(source):
        return
    if os.path.abspath(source) == os.path.abspath(target):
        return
    try:
        shutil.copyfile(source, target)
        logging.getLogger("pc_sensor_app").info("已复制默认配置: %s -> %s", source, target)
    except Exception as e:  # noqa: BLE001 - 复制失败时退化为默认配置
        logging.getLogger("pc_sensor_app").warning("复制默认配置失败: %s", e)


_ensure_default_file("config.json")
_ensure_default_file("pc_sensor_config.json")


# ============================================================
# 日志
# ============================================================

_logging_configured = False


def setup_logging() -> None:
    """配置日志：始终写入轮转文件，存在控制台时同时输出到 stdout。

    打包为 --noconsole 时没有 stdout，不能依赖 print 做诊断。
    """
    global _logging_configured
    if _logging_configured:
        return
    _logging_configured = True

    root = logging.getLogger()
    root.setLevel(logging.INFO)
    formatter = logging.Formatter(
        "%(asctime)s - %(name)s - %(levelname)s - %(message)s"
    )

    try:
        file_handler = RotatingFileHandler(
            LOG_PATH, maxBytes=2 * 1024 * 1024, backupCount=3, encoding="utf-8"
        )
        file_handler.setFormatter(formatter)
        root.addHandler(file_handler)
    except Exception:  # noqa: BLE001 - 日志文件不可写时不能阻断启动
        pass

    # --noconsole 下 sys.stdout 为 None，此时不加控制台处理器
    if sys.stdout is not None:
        try:
            stream_handler = logging.StreamHandler(sys.stdout)
            stream_handler.setFormatter(formatter)
            root.addHandler(stream_handler)
        except Exception:  # noqa: BLE001
            pass


logger = logging.getLogger("pc_sensor_app")


# ============================================================
# 代理配置（config.json）
# ============================================================

DEFAULT_AGENT_CONFIG: dict[str, Any] = {
    "server_host": "127.0.0.1",
    "server_port": 18888,
    "agent_token": "",
    "instance_id": "",
}

# 无托盘模式下由 /shutdown、父进程看门狗或信号处理置位；
# 托盘模式下同时用于关闭图标，统一退出路径。
shutdown_event = threading.Event()

# PC-M5：长度不足该值的 Token 一律视为可预测（含空串、旧版出厂占位值），启动时轮换
MIN_AGENT_TOKEN_LENGTH = 32
# 首次生成随机 Token 时记录的一次性提示（在 setup_logging 之后补打一次）
_token_rotation_notice: str | None = None


def load_config() -> dict[str, Any]:
    """加载 config.json；缺失或损坏时回退默认值。"""
    try:
        if os.path.exists(CONFIG_PATH):
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                data = json.load(f)
                if isinstance(data, dict):
                    return data
    except Exception as e:  # noqa: BLE001
        logger.warning("读取 config.json 失败，使用默认配置: %s", e)
    return dict(DEFAULT_AGENT_CONFIG)


def _persist_agent_config(cfg: dict[str, Any]) -> None:
    """把 Agent 配置写回 config.json（仅用于 Token 轮换）。"""
    try:
        with open(CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(cfg, f, indent=2, ensure_ascii=False)
    except Exception as e:  # noqa: BLE001
        logger.warning("保存 config.json 失败: %s", e)


def _ensure_agent_token(cfg: dict[str, Any]) -> str:
    """PC-M5：空、过短或历史占位 Token 时生成随机 Token 并持久化。

    判定标准：Token 长度小于 MIN_AGENT_TOKEN_LENGTH 即视为可预测
    （覆盖空串、旧版出厂占位值等），一律替换为 secrets.token_urlsafe(32)
    生成的随机串（长度 43 >= 32）。返回最终生效的 Token；轮换时记录一次性提示。
    """
    global _token_rotation_notice
    token = str(cfg.get("agent_token", "") or "")
    if len(token) >= MIN_AGENT_TOKEN_LENGTH:
        return token

    token = secrets.token_urlsafe(32)
    cfg["agent_token"] = token
    _persist_agent_config(cfg)
    _token_rotation_notice = (
        f"检测到空/可预测的 agent_token，已自动生成随机 Token 并保存到 {CONFIG_PATH}，"
        "配置网页会自动注入该 Token。"
    )
    logger.warning(_token_rotation_notice)
    return token


config = load_config()

HOST = config.get("server_host", "127.0.0.1")
PORT = int(config.get("server_port", 18888))
AGENT_TOKEN = _ensure_agent_token(config)


# ============================================================
# PC 感知管理器（懒加载单例）
# ============================================================

_pc_sensor_manager: SensorManager | None = None


def get_manager() -> SensorManager:
    """获取 SensorManager 单例（首次调用时创建）。"""
    global _pc_sensor_manager
    if _pc_sensor_manager is None:
        _pc_sensor_manager = SensorManager(config_path=PC_SENSOR_CONFIG_PATH)
    return _pc_sensor_manager


def load_device_identity() -> tuple[str, str]:
    """读取设备身份 (agent_id, agent_name)，不触发 manager 初始化。

    设备身份归属 pc_sensor_config.json；agent_name 缺失时回退计算机名。
    仅用于 /health、启动日志等轻量展示场景。
    """
    cfg: dict[str, Any] = {}
    try:
        if os.path.exists(PC_SENSOR_CONFIG_PATH):
            with open(PC_SENSOR_CONFIG_PATH, "r", encoding="utf-8") as f:
                loaded = json.load(f)
            if isinstance(loaded, dict):
                cfg = loaded
    except Exception as e:  # noqa: BLE001 - 读取失败回退默认身份
        logger.debug("读取设备身份失败: %s", e)
    agent_id = str(cfg.get("agent_id") or "").strip() or "default-agent"
    agent_name = str(cfg.get("agent_name") or "").strip() or default_device_name()
    return agent_id, agent_name


def load_instance_id() -> str:
    """读取桌面壳写入的实例标识；缺失或读取失败时返回空串。"""
    try:
        if os.path.exists(CONFIG_PATH):
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                loaded = json.load(f)
            if isinstance(loaded, dict):
                return str(loaded.get("instance_id") or "")
    except Exception as e:  # noqa: BLE001 - 身份读取失败不影响服务
        logger.debug("读取 instance_id 失败: %s", e)
    return str(config.get("instance_id") or "")


# ============================================================
# 开机自启动（注册表 HKCU Run）
# ============================================================

AUTOSTART_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
AUTOSTART_NAME = "AxeuhPCSensor"


def _autostart_command() -> str:
    """生成写入注册表的启动命令。

    - 打包后：exe 自身
    - 开发时：python 解释器 + 脚本路径
    """
    if getattr(sys, "frozen", False):
        return f'"{sys.executable}" --silent'
    # 开发模式：使用本文件绝对路径（sys.argv[0] 在 -c/-m 启动时不可靠）
    script = os.path.abspath(__file__)
    return f'"{sys.executable}" "{script}" --silent'


def is_autostart_enabled() -> bool:
    """读取注册表判断是否已开启开机自启。"""
    if winreg is None:
        return False
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, AUTOSTART_KEY, 0, winreg.KEY_READ) as key:
            value, _ = winreg.QueryValueEx(key, AUTOSTART_NAME)
            return bool(value)
    except FileNotFoundError:
        return False
    except OSError:
        return False


def set_autostart(enabled: bool) -> bool:
    """写入 / 删除注册表自启项，返回是否成功。"""
    if winreg is None:
        logger.warning("当前环境不支持注册表自启动")
        return False
    try:
        with winreg.CreateKeyEx(
            winreg.HKEY_CURRENT_USER, AUTOSTART_KEY, 0, winreg.KEY_SET_VALUE
        ) as key:
            if enabled:
                winreg.SetValueEx(key, AUTOSTART_NAME, 0, winreg.REG_SZ, _autostart_command())
                logger.info("已开启开机自启动: %s", _autostart_command())
            else:
                try:
                    winreg.DeleteValue(key, AUTOSTART_NAME)
                    logger.info("已关闭开机自启动")
                except FileNotFoundError:
                    pass
        return True
    except OSError as e:
        logger.error("设置开机自启动失败: %s", e)
        return False


# ============================================================
# PC 事件聚合（纯函数，便于单元测试）
# ============================================================

def hms_to_seconds(t: Any) -> int:
    """把 "HH:MM:SS" / "HH:MM" 转成自 0 点起的秒数；解析失败返回 0。"""
    try:
        parts = str(t or "").split(":")
        if len(parts) < 2:
            return 0
        h = int(parts[0])
        m = int(parts[1])
        s = int(parts[2]) if len(parts) > 2 else 0
        return h * 3600 + m * 60 + s
    except (ValueError, TypeError):
        return 0


def _event_seconds(ev: dict) -> int:
    """取事件的当日秒数，优先 t；缺失时从 t_iso 中提取时分秒。"""
    t_val = ev.get("t")
    if not t_val:
        iso = ev.get("t_iso") or ""
        if "T" in iso:
            t_val = iso.split("T", 1)[1][:8]
    return hms_to_seconds(t_val)


def aggregate_pc_events(events: list[dict], cutoff_seconds: int | None = None) -> dict:
    """把一天的 pc_* 事件聚合成图表所需统计结构（纯函数，无 I/O）。

    Args:
        events: pc_* 事件列表。
        cutoff_seconds: 末段截止的当日秒数（PC-M3）。末个事件没有后继事件，
            其持续时长默认按到当天结束(86400)计算，会虚增活跃时长；当日数据
            应传入当前时刻秒数截断。None 表示按完整一天处理（历史日期）。

    返回:
        {
          "totals": {active_seconds, idle_seconds, locked_seconds},
          "top_processes": [{process, title, seconds} ...] (倒序，最多 10),
          "hourly_active_minutes": [24 个一位小数],
          "timeline": [{type, t, value} ...] (按时间升序),
        }
    """
    empty = {
        "totals": {"active_seconds": 0, "idle_seconds": 0, "locked_seconds": 0},
        "top_processes": [],
        "hourly_active_minutes": [0.0] * 24,
        "timeline": [],
    }
    if not events:
        return empty

    pc_events = [
        ev
        for ev in events
        if isinstance(ev, dict)
        and isinstance(ev.get("type"), str)
        and ev["type"].startswith("pc_")
    ]
    if not pc_events:
        return empty

    pc_events.sort(key=lambda ev: str(ev.get("t_iso") or ev.get("t") or ""))

    active_seconds = 0
    idle_seconds = 0
    locked_seconds = 0
    proc_seconds: dict[str, int] = {}
    proc_titles: dict[str, str] = {}
    hourly_active = [0.0] * 24
    timeline: list[dict] = []

    total = len(pc_events)
    for i, ev in enumerate(pc_events):
        etype = ev["type"]
        payload = ev.get("payload")
        if not isinstance(payload, dict):
            payload = {}

        start = _event_seconds(ev)
        if i + 1 < total:
            # 存在后继事件：持续到下一个事件的时刻
            end = _event_seconds(pc_events[i + 1])
        elif cutoff_seconds is not None:
            # 末个事件：按给出的截止时刻（当日当前时刻）截断，避免虚增（PC-M3）
            end = max(0, int(cutoff_seconds))
        else:
            # 历史日期：无更精确的截止时间，按当天结束处理
            end = 86400
        if end < start:  # 跨午夜：补一天
            end += 86400
        duration = max(0, end - start)

        # 状态与时间轴取值
        if etype == "pc_window":
            state = "active"
            value = str(payload.get("process") or "")
        elif etype == "pc_idle":
            raw = str(payload.get("state") or "")
            state = "idle" if raw == "idle" else "active"
            value = raw
        elif etype == "pc_screen":
            raw = str(payload.get("state") or "")
            state = "locked" if raw == "lock" else "active"
            value = raw
        else:
            state = "active"
            value = ""

        if state == "active":
            active_seconds += duration
        elif state == "idle":
            idle_seconds += duration
        else:
            locked_seconds += duration

        # 前台窗口进程累计（仅活跃段，记录最新非空标题）
        if etype == "pc_window" and state == "active" and value:
            proc_seconds[value] = proc_seconds.get(value, 0) + duration
            title = str(payload.get("title") or "")
            if title:
                proc_titles[value] = title

        # 活跃时长按小时桶按比例分配
        if state == "active" and duration > 0:
            for h in range(24):
                hs = h * 3600
                overlap = min(end, hs + 3600) - max(start, hs)
                if overlap > 0:
                    hourly_active[h] += overlap

        timeline.append(
            {"type": etype[len("pc_"):], "t": ev.get("t"), "value": value}
        )

    top_processes = [
        {
            "process": name,
            "title": proc_titles.get(name, ""),
            "seconds": int(round(secs)),
        }
        for name, secs in sorted(
            proc_seconds.items(), key=lambda kv: kv[1], reverse=True
        )[:10]
    ]

    return {
        "totals": {
            "active_seconds": int(round(active_seconds)),
            "idle_seconds": int(round(idle_seconds)),
            "locked_seconds": int(round(locked_seconds)),
        },
        "top_processes": top_processes,
        "hourly_active_minutes": [round(v / 60, 1) for v in hourly_active],
        "timeline": timeline,
    }


# ============================================================
# FastAPI 应用
# ============================================================

app = FastAPI(
    title="Kinship Sensor（PC 感知采集器）",
    description="本地 PC 状态采集服务 - 窗口 / 无人 / 锁屏",
    version=VERSION,
)

# 本地配置页与后端同源，且服务仅绑定回环地址，无需 CORS。
# 注意：不要把服务重新绑到 0.0.0.0 —— 配置页会注入 agent_token，会重新暴露敏感凭据。

# 公开路径（无需 token）：仅健康检查与本地配置页
PUBLIC_PATHS = {"/health", "/", "/pc-config"}
# 无公开的 GET 路径（config/status/charts 均需认证）
PUBLIC_GET_PATHS: set[str] = set()
# 不再豁免配置路径，任何方法都需要认证
PUBLIC_CONFIG_PATH = ""

PC_CONFIG_CSP = (
    "default-src 'self'; script-src 'self' 'unsafe-inline'; "
    "style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
    "connect-src 'self'; font-src 'self'"
)
PC_CONFIG_HEADERS = {
    "Content-Security-Policy": PC_CONFIG_CSP,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
}


async def verify_token(request: Request) -> None:
    """验证 Bearer token（常量时间比较，空 token 一律拒绝）。"""
    path = request.url.path
    if path in PUBLIC_PATHS:
        return
    if path.startswith("/static/"):
        return
    if request.method == "GET" and path in PUBLIC_GET_PATHS:
        return
    if PUBLIC_CONFIG_PATH and path == PUBLIC_CONFIG_PATH:
        return

    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="缺少 Authorization 头，格式: Bearer {token}")

    token = auth_header[7:]
    # 空 token / 未配置 token 一律拒绝；使用常量时间比较避免时序侧信道
    if not token or not AGENT_TOKEN or not hmac.compare_digest(token, AGENT_TOKEN):
        raise HTTPException(status_code=401, detail="Token 无效")


@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    """认证中间件。"""
    try:
        await verify_token(request)
    except HTTPException:
        return JSONResponse(
            status_code=401,
            content={"detail": "未授权访问，请提供有效的 Bearer token"},
        )
    except Exception as e:  # noqa: BLE001
        logger.error("认证中间件异常: %s", e)
        return JSONResponse(status_code=500, content={"detail": "认证服务内部错误"})
    return await call_next(request)


# ============================================================
# API 端点
# ============================================================

@app.get("/health")
async def health():
    """健康检查（公开）。"""
    agent_id, agent_name = load_device_identity()
    return {
        "status": "ok",
        "agent_id": agent_id,
        "agent_name": agent_name,
        "pid": os.getpid(),
        "version": VERSION,
    }


@app.get("/", include_in_schema=False)
@app.get("/pc-config", include_in_schema=False)
async def serve_pc_config_page():
    """本地配置页（公开）。

    该页面同源且服务仅监听回环地址，故以脚本方式注入 agent_token 供页面
    API 调用携带 Authorization 头。若把服务改绑 0.0.0.0，将随页面泄露该 Token。
    """
    html_path = os.path.join(STATIC_DIR, "pc_config.html")
    if os.path.exists(html_path):
        with open(html_path, "r", encoding="utf-8") as f:
            html = f.read()
        snippet = (
            "<script>window.__PC_AGENT_TOKEN__ = "
            f"{json.dumps(AGENT_TOKEN)};</script>"
        )
        # 注入到 </head> 之前，确保早于页面主脚本执行；
        # 否则主脚本执行时 window.__PC_AGENT_TOKEN__ 尚未定义，会导致 token 为空、API 全部 401。
        if "</head>" in html:
            html = html.replace("</head>", snippet + "</head>", 1)
        elif "</body>" in html:
            html = html.replace("</body>", snippet + "</body>", 1)
        else:
            html = html + snippet
        return HTMLResponse(content=html, headers=PC_CONFIG_HEADERS)
    return HTMLResponse(
        "<h1>PC 感知配置</h1><p>页面文件未找到</p>",
        headers=PC_CONFIG_HEADERS,
    )


STATIC_MIME_TYPES = {
    ".js": "text/javascript",
    ".css": "text/css",
    ".html": "text/html",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".json": "application/json",
    ".map": "application/json",
}


def resolve_static_path(relative_path: str) -> str | None:
    """把 URL 相对路径解析为 STATIC_DIR 内的普通文件；越界或目录返回 None。"""
    parts = [
        part
        for part in relative_path.replace("\\", "/").split("/")
        if part not in ("", ".")
    ]
    if not parts or any(part == ".." for part in parts):
        return None
    root = os.path.realpath(STATIC_DIR_ABS)
    candidate = os.path.realpath(os.path.join(root, *parts))
    try:
        if os.path.commonpath([root, candidate]) != root:
            return None
    except ValueError:
        return None
    if not os.path.isfile(candidate):
        return None
    return candidate


@app.api_route(
    "/static/{file_path:path}",
    methods=["GET", "HEAD"],
    include_in_schema=False,
)
async def serve_static_file(file_path: str):
    """本地静态资源（公开，仅限 STATIC_DIR，无目录列表）。"""
    candidate = resolve_static_path(file_path)
    if candidate is None:
        raise HTTPException(status_code=404, detail="Not Found")
    media_type = STATIC_MIME_TYPES.get(os.path.splitext(candidate)[1].lower())
    return FileResponse(candidate, media_type=media_type)


@app.get("/pc-sensor/config")
async def get_pc_sensor_config():
    """获取 PC 感知配置（密码已脱敏）。"""
    return get_manager().config


@app.post("/pc-sensor/config")
def update_pc_sensor_config(data: dict[str, Any]):
    """更新 PC 感知配置，并按需启停采集器。

    使用同步 def，FastAPI 会在工作线程中执行，避免登录阻塞事件循环。
    """
    manager = get_manager()
    old_enabled = manager.config.get("enabled", False)
    try:
        new_cfg = manager.update_config(data)
    except CandidateError as e:
        raise HTTPException(status_code=400, detail=str(e)) from None
    new_enabled = new_cfg.get("enabled", False)

    if old_enabled != new_enabled:
        if new_enabled:
            manager.start()
        else:
            manager.stop()
    elif new_enabled and not manager.running:
        manager.start()

    return {"success": True, "config": new_cfg}


@app.post("/pc-sensor/pair")
def pair_pc_sensor(data: dict[str, Any]):
    """用 8 位配对码换取设备 Token 并更新配置（需 agent_token）。

    使用同步 def，网络请求由 FastAPI 在工作线程执行。
    响应只返回脱敏配置，绝不回显设备 Token。
    """
    manager = get_manager()
    cfg = manager.config
    code = str(data.get("pairing_code") or "").strip()
    server_url = (
        str(data.get("server_url") or "").strip()
        or str(cfg.get("server_url") or "").strip()
    )

    try:
        result = pairing.enroll(
            server_url=server_url,
            pairing_code=code,
            device_id=str(cfg.get("agent_id") or "default-agent"),
            device_name=str(cfg.get("agent_name") or ""),
            platform=pairing.detect_platform(),
            ssl_verify=bool(cfg.get("ssl_verify", True)),
            ssl_ca_file=str(cfg.get("ssl_ca_file") or ""),
        )
    except pairing.PairingError as e:
        raise HTTPException(status_code=400, detail=str(e)) from None

    updates: dict[str, Any] = {
        "server_url": server_url,
        "backend_token": str(result.get("device_token") or ""),
    }
    updates["endpoint_candidates"] = pairing.candidates_from_endpoints(
        result.get("endpoints")
    )

    try:
        new_cfg = manager.update_config(updates, encrypt_backend_token=True)
    except CandidateError as e:
        raise HTTPException(status_code=400, detail=str(e)) from None

    logger.info("设备配对完成，上报配置已更新")
    return {"success": True, "config": new_cfg}


@app.get("/pc-sensor/auth-token")
async def get_pc_sensor_auth_token():
    """返回后端 Bearer Token 快照，供桌面壳给 SPA 复用（需 token）。

    只返回当前内存中的 Token 快照；接口不写日志，避免 Token 落盘。
    """
    return get_manager().uploader.auth_token_snapshot()


@app.post("/pc-sensor/test-login")
def test_pc_sensor_login():
    """重新测试后端登录（需 token）。

    使用同步 def，FastAPI 在工作线程执行，避免登录网络请求阻塞事件循环。
    只触发上传器重新认证，不改变采集状态，也不重启采集器。
    响应只含用户可读原因，绝不回显密码或 Token。
    """
    manager = get_manager()
    try:
        success = bool(manager.uploader.force_relogin())
    except Exception as e:  # noqa: BLE001 - 测试登录绝不 500
        logger.warning("测试登录异常: %s", e)
        success = False
    logged_in = bool(getattr(manager.uploader, "has_token", False))
    auth_error = str(getattr(manager.uploader, "auth_error", "") or "")
    if success and logged_in:
        message = "登录成功"
    elif auth_error:
        message = auth_error
    else:
        message = "登录失败，请检查账号密码与服务器地址"
    return {
        "success": success and logged_in,
        "logged_in": logged_in,
        "auth_error": auth_error,
        "message": message,
    }


@app.get("/pc-sensor/status")
async def get_pc_sensor_status():
    """获取 PC 感知运行状态（需 token）。"""
    status = get_manager().get_status()
    status.update(
        {
            "pid": os.getpid(),
            "data_dir": DATA_DIR,
            "instance_id": load_instance_id(),
            "version": VERSION,
        }
    )
    return status


DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _today_cst() -> str:
    """CST（UTC+8）的今天，格式 YYYY-MM-DD。"""
    return datetime.now(timezone(timedelta(hours=8))).strftime("%Y-%m-%d")


def _now_seconds_cst() -> int:
    """CST（UTC+8）当前时刻的当日秒数，用于聚合末段截断（PC-M3）。"""
    now = datetime.now(timezone(timedelta(hours=8)))
    return now.hour * 3600 + now.minute * 60 + now.second


@app.get("/pc-sensor/charts")
def get_pc_sensor_charts(date: str | None = None):
    """图表数据：聚合指定日期的 PC 感知事件（需 token）。

    使用同步 def，FastAPI 会在工作线程中执行（拉取远端数据可能较慢）。
    任何内部错误都返回 ok=false 且 HTTP 200，避免前端报错。
    """
    if not date or not DATE_RE.match(date):
        date = _today_cst()

    try:
        manager = get_manager()
        events = manager.uploader.fetch_perception_events(date)
        # 当日数据：末段截止到当前时刻，避免按 86400 计算虚增活跃时长（PC-M3）
        cutoff = _now_seconds_cst() if date == _today_cst() else None
        agg = aggregate_pc_events(events, cutoff_seconds=cutoff)
        return {
            "ok": True,
            "date": date,
            "agent_id": load_device_identity()[0],
            **agg,
        }
    except Exception as e:  # noqa: BLE001 - 图表接口绝不 500
        logger.warning("生成图表数据失败: %s", e)
        return {"ok": False, "date": date, "error": str(e)}


LOG_TAIL_DEFAULT = 300
LOG_TAIL_MAX = 5000


def _read_log_tail(path: str, limit: int) -> list[str]:
    """读取文本文件末尾 limit 行，内存占用与 limit 成正比。"""
    if not os.path.exists(path):
        return []
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            return list(deque(f, maxlen=limit))
    except Exception as e:  # noqa: BLE001 - 读日志失败不应 500
        logger.warning("读取日志失败: %s", e)
        return []


@app.get("/pc-sensor/logs")
def get_pc_sensor_logs(lines: int = LOG_TAIL_DEFAULT):
    """读取运行日志尾部（需 token）。

    使用同步 def，FastAPI 在工作线程执行，避免大文件读取阻塞事件循环。
    """
    try:
        limit = max(1, min(int(lines), LOG_TAIL_MAX))
    except (TypeError, ValueError):
        limit = LOG_TAIL_DEFAULT
    return {
        "ok": True,
        "path": LOG_PATH,
        "lines": _read_log_tail(LOG_PATH, limit),
    }


@app.post("/restart")
def restart_pc_sensor():
    """优雅重启采集器（需 token）。"""
    manager = get_manager()
    manager.stop()
    time.sleep(0.2)
    manager.start()
    return {"success": True, "running": manager.running}


@app.post("/shutdown")
async def shutdown_service():
    """优雅关闭整个进程（需 token）。

    延迟置位事件，让 HTTP 响应先返回；主循环负责停采集器与 HTTP 服务。
    """
    timer = threading.Timer(0.15, shutdown_event.set)
    timer.daemon = True
    timer.start()
    return {"success": True}


# ============================================================
# uvicorn Server 实例（由子线程运行）
# ============================================================

uvicorn_config = uvicorn.Config(
    app,
    host=HOST,
    port=PORT,
    log_level="info",
    log_config=None,  # 交给上面的 logging 统一处理
)
server = uvicorn.Server(uvicorn_config)


# ============================================================
# 托盘图标
# ============================================================

def load_tray_image(size: int = 64) -> Any:
    """加载 Kinship 吉祥物托盘图标；资源缺失时退回纯玫瑰色方块并告警。"""
    from PIL import Image

    assets_dir = os.path.join(RESOURCE_DIR, "assets")
    candidates: list[int] = []
    for candidate in (size, 64, 32):
        if candidate not in candidates:
            candidates.append(candidate)
    for candidate in candidates:
        path = os.path.join(assets_dir, f"tray-icon-{candidate}.png")
        if not os.path.isfile(path):
            continue
        try:
            with Image.open(path) as image:
                return image.convert("RGBA")
        except Exception as e:  # noqa: BLE001 - 坏图标不应阻止托盘启动
            logger.warning("加载托盘图标失败: %s (%s)", path, e)
    logger.warning("托盘图标资源缺失，使用纯色占位: %s", assets_dir)
    return Image.new("RGBA", (size, size), (244, 63, 94, 255))


def _message_box(title: str, text: str) -> None:
    """弹出系统消息框；失败时退回日志。"""
    try:
        import ctypes

        ctypes.windll.user32.MessageBoxW(0, text, title, 0x40)  # MB_ICONINFORMATION
    except Exception:  # noqa: BLE001
        logger.info("%s: %s", title, text)


def _spawn(target, *args) -> None:
    """把可能阻塞的操作放到后台线程，避免卡住托盘菜单。"""
    threading.Thread(target=target, args=args, daemon=True).start()


# ---- 菜单回调 ----

def on_open_config(icon, item):
    """打开本地配置网页。"""
    def work():
        try:
            webbrowser.open(f"http://localhost:{PORT}/pc-config")
        except Exception as e:  # noqa: BLE001
            logger.warning("打开配置网页失败: %s", e)

    _spawn(work)


def on_toggle_enabled(icon, item):
    """切换总开关：启用 / 停用 PC 感知。"""
    def work():
        manager = get_manager()
        new_value = not manager.config.get("enabled", False)
        manager.update_config({"enabled": new_value})
        if new_value:
            manager.start()
        else:
            manager.stop()
        try:
            icon.update_menu()
        except Exception:  # noqa: BLE001
            pass

    _spawn(work)


def _toggle_sub(icon, key: str) -> None:
    """切换某个采集子项，并在运行时同步启停对应追踪器。"""
    manager = get_manager()
    new_value = not manager.config.get(key, True)
    manager.update_config({key: new_value})

    if manager.running:
        if key == "window_enabled":
            if new_value:
                manager.window_tracker.start()
            else:
                manager.window_tracker.stop()
        elif key in ("idle_enabled", "screen_enabled"):
            need_idle = manager.config.get("idle_enabled", True) or manager.config.get("screen_enabled", True)
            if need_idle:
                manager.idle_tracker.start()
            else:
                manager.idle_tracker.stop()

    try:
        icon.update_menu()
    except Exception:  # noqa: BLE001
        pass


def on_toggle_window(icon, item):
    _spawn(_toggle_sub, icon, "window_enabled")


def on_toggle_idle(icon, item):
    _spawn(_toggle_sub, icon, "idle_enabled")


def on_toggle_screen(icon, item):
    _spawn(_toggle_sub, icon, "screen_enabled")


def on_toggle_autostart(icon, item):
    """切换开机自启动（静默）。"""
    def work():
        set_autostart(not is_autostart_enabled())
        try:
            icon.update_menu()
        except Exception:  # noqa: BLE001
            pass

    _spawn(work)


def on_show_status(icon, item):
    """弹窗显示当前运行状态与前台窗口。"""
    def work():
        manager = get_manager()
        status = manager.get_status()
        win = get_foreground_window()
        current = f"{win.process} - {win.title}" if win else "（未获取到）"
        text = (
            f"采集器: {'运行中' if status.get('running') else '已停止'}\n"
            f"已启用: {'是' if status.get('enabled') else '否'}\n"
            f"登录状态: {'已登录' if status.get('logged_in') else '未登录'}\n"
            f"窗口追踪: {'运行中' if status.get('window') else '已停止'}\n"
            f"无人检测: {'运行中' if status.get('idle') else '已停止'}\n"
            f"队列待发: {status.get('queue_size', 0)}\n\n"
            f"当前窗口:\n{current}"
        )
        _message_box("PC 感知状态", text)

    _spawn(work)


def on_open_log(icon, item):
    """用系统默认程序打开日志文件。"""
    def work():
        try:
            if os.path.exists(LOG_PATH):
                os.startfile(LOG_PATH)  # type: ignore[attr-defined]
            else:
                _message_box("PC 感知", f"日志文件尚未生成:\n{LOG_PATH}")
        except Exception as e:  # noqa: BLE001
            logger.warning("打开日志失败: %s", e)

    _spawn(work)


def on_restart_sensor(icon, item):
    """重启采集器。"""
    def work():
        manager = get_manager()
        manager.stop()
        time.sleep(0.3)
        manager.start()
        try:
            icon.update_menu()
        except Exception:  # noqa: BLE001
            pass

    _spawn(work)


def on_quit(icon, item):
    """优雅退出：停采集器 -> 停 HTTP -> 停托盘。"""
    logger.info("收到退出请求，正在关闭...")
    shutdown_event.set()
    try:
        get_manager().stop()
    except Exception as e:  # noqa: BLE001
        logger.warning("停止采集器异常: %s", e)
    try:
        server.should_exit = True
    except Exception:  # noqa: BLE001
        pass
    try:
        icon.stop()
    except Exception:  # noqa: BLE001
        pass


def _watch_shutdown_for_tray(icon) -> None:
    """托盘模式下让 /shutdown 也能关闭图标。"""
    shutdown_event.wait()
    try:
        icon.stop()
    except Exception as e:  # noqa: BLE001
        logger.warning("停止托盘图标失败: %s", e)


def build_menu() -> Any:
    """构建托盘右键菜单。"""
    import pystray  # pyright: ignore[reportMissingImports]

    return pystray.Menu(
        pystray.MenuItem("打开配置网页", on_open_config),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem(
            "启用 PC 感知",
            on_toggle_enabled,
            checked=lambda item: get_manager().config.get("enabled", False),
        ),
        pystray.MenuItem(
            "采集选项",
            pystray.Menu(
                pystray.MenuItem(
                    "窗口追踪",
                    on_toggle_window,
                    checked=lambda item: get_manager().config.get("window_enabled", True),
                ),
                pystray.MenuItem(
                    "无人检测",
                    on_toggle_idle,
                    checked=lambda item: get_manager().config.get("idle_enabled", True),
                ),
                pystray.MenuItem(
                    "锁屏检测",
                    on_toggle_screen,
                    checked=lambda item: get_manager().config.get("screen_enabled", True),
                ),
            ),
        ),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem(
            "开机自启动（静默）",
            on_toggle_autostart,
            checked=lambda item: is_autostart_enabled(),
        ),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("查看状态", on_show_status),
        pystray.MenuItem("打开日志", on_open_log),
        pystray.MenuItem("重启采集器", on_restart_sensor),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("退出", on_quit),
    )


# ============================================================
# 主入口
# ============================================================

def _safe_start_manager() -> None:
    """后台启动采集器（登录可能阻塞，不能卡住主线程）。"""
    try:
        get_manager().start()
    except Exception as e:  # noqa: BLE001
        logger.error("启动采集器失败: %s", e)


def parse_parent_pid(argv: Sequence[str]) -> int:
    """解析 --parent-pid；非法或 <=0 返回 0（不启用看门狗）。"""
    raw = parse_arg_value(argv, "--parent-pid")
    if raw is None:
        return 0
    try:
        pid = int(raw)
    except (TypeError, ValueError):
        return 0
    return pid if pid > 0 else 0


def _pid_exists(pid: int) -> bool:
    """检查进程是否仍存在；优先 psutil，失败时回退 os.kill(pid, 0)。"""
    if pid <= 0:
        return False
    try:
        import psutil
    except ImportError:
        psutil = None
    if psutil is not None:
        try:
            return bool(psutil.pid_exists(pid))
        except Exception as e:  # noqa: BLE001 - 回退到 os.kill
            logger.debug("psutil 检查进程 %s 失败: %s", pid, e)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def _watch_parent(parent_pid: int) -> None:
    """父进程消失时触发退出（不杀父进程）。"""
    while not shutdown_event.wait(2.0):
        if not _pid_exists(parent_pid):
            logger.info("父进程 %s 已退出，触发关闭", parent_pid)
            shutdown_event.set()


def _install_shutdown_signal_handlers() -> None:
    """把 SIGINT / SIGTERM 映射到 shutdown_event。"""

    def _handle(signum, _frame) -> None:
        logger.info("收到退出信号: %s", signum)
        shutdown_event.set()

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            signal.signal(sig, _handle)
        except (OSError, ValueError) as e:
            logger.warning("注册信号处理器失败 (%s): %s", sig, e)


def main() -> int:
    setup_logging()
    argv = list(sys.argv[1:])
    silent = "--silent" in argv
    headless = "--no-tray" in argv
    parent_pid = parse_parent_pid(argv)

    # 模块导入时若发生过 Token 轮换，在日志就绪后补打一次提示
    if _token_rotation_notice:
        logger.warning(_token_rotation_notice)

    logger.info("=" * 50)
    logger.info("Kinship Sensor 启动")
    logger.info("版本: %s", VERSION)
    logger.info("服务地址: http://%s:%s", HOST, PORT)
    _agent_id, _agent_name = load_device_identity()
    logger.info("Agent ID: %s", _agent_id)
    logger.info("Agent 名称: %s", _agent_name)
    logger.info("数据目录: %s", DATA_DIR)
    logger.info("资源目录: %s", RESOURCE_DIR)
    logger.info("静默模式: %s", silent)
    logger.info("无托盘模式: %s", headless)
    if parent_pid:
        logger.info("父进程看门狗: %s", parent_pid)
    logger.info("=" * 50)

    # 1. 启动 HTTP API（子线程）
    http_thread = threading.Thread(target=server.run, daemon=True, name="http-api")
    http_thread.start()

    # 2. 等待绑定结果：端口占用时 uvicorn 线程退出，不能留下空转进程
    deadline = time.monotonic() + 5.0
    while not server.started and time.monotonic() < deadline:
        if server.should_exit or not http_thread.is_alive():
            break
        time.sleep(0.05)
    if not server.started and (server.should_exit or not http_thread.is_alive()):
        logger.error("HTTP API 启动失败：%s:%s 可能已被占用", HOST, PORT)
        server.should_exit = True
        http_thread.join(timeout=5)
        return 1
    if server.started:
        logger.info("HTTP API 已启动（后台线程）")
    else:
        logger.warning("HTTP API 在 5 秒内未报告就绪，继续等待")

    # 3. 按配置启动采集器（后台线程，登录可能阻塞）
    _spawn(_safe_start_manager)

    # 3b. 父进程看门狗（托盘 / 无托盘模式均生效）
    if parent_pid:
        threading.Thread(
            target=_watch_parent,
            args=(parent_pid,),
            daemon=True,
            name="parent-watchdog",
        ).start()

    # 4. 仅交互式托盘模式自动打开配置网页；--silent / --no-tray 均不弹浏览器
    if not silent and not headless:
        def _open_once():
            time.sleep(1.5)
            try:
                webbrowser.open(f"http://localhost:{PORT}/pc-config")
            except Exception as e:  # noqa: BLE001
                logger.warning("自动打开配置网页失败: %s", e)

        _spawn(_open_once)

    # 5a. 无托盘模式：主线程等待退出事件
    if headless:
        _install_shutdown_signal_handlers()
        logger.info("无托盘模式运行中，POST /shutdown 可退出")
        while not shutdown_event.wait(1.0):
            pass

        logger.info("收到退出请求，正在关闭...")
        try:
            get_manager().stop()
        except Exception as e:  # noqa: BLE001
            logger.warning("停止采集器异常: %s", e)
        try:
            server.should_exit = True
        except Exception:  # noqa: BLE001
            pass
        http_thread.join(timeout=5)
        logger.info("Kinship Sensor 已退出")
        return 0

    # 5b. 托盘模式：主线程运行图标（Windows 要求主线程）
    import pystray  # pyright: ignore[reportMissingImports]

    icon = pystray.Icon(
        "AxeuhPCSensor",
        load_tray_image(),
        "Kinship Sensor",
        menu=build_menu(),
    )
    threading.Thread(
        target=_watch_shutdown_for_tray,
        args=(icon,),
        daemon=True,
        name="shutdown-watch",
    ).start()
    try:
        icon.run()
    except Exception as e:  # noqa: BLE001
        logger.error("托盘运行异常: %s", e)

    # 6. 托盘退出后清理
    shutdown_event.set()
    logger.info("托盘已退出，正在关闭 HTTP 服务...")
    try:
        get_manager().stop()
    except Exception as e:  # noqa: BLE001
        logger.warning("停止采集器异常: %s", e)
    try:
        server.should_exit = True
    except Exception:  # noqa: BLE001
        pass
    http_thread.join(timeout=5)
    logger.info("Kinship Sensor 已退出")
    return 0


if __name__ == "__main__":
    sys.exit(main())
