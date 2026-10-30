# -*- coding: utf-8 -*-
"""
PC 感知采集管理器

统一管理各采集器的生命周期和主循环调度。
在后台线程中运行，通过回调接收采集事件并上传。
"""

import os
import socket
import time
import json
import logging
import threading
from datetime import datetime, timezone, timedelta
from typing import Optional, Any

from .window_tracker import WindowTracker, get_foreground_window, WindowInfo
from .idle_tracker import IdleTracker, get_idle_seconds, is_screen_locked
from .uploader import Uploader
from .transport import CandidateError, EndpointCandidate, TransportSelector, normalize_candidates
from . import secret_store

logger = logging.getLogger("pc_sensor.manager")

CST = timezone(timedelta(hours=8))

# PC-M6：锁屏检测依赖全进程扫描（psutil + tasklist），频率过高会持续占用 CPU。
# 空闲检测走廉价的 GetLastInputInfo，仍按 2s 轮询；全进程扫描降频到 30s。
SCREEN_SCAN_INTERVAL = 30.0
# 空闲/活跃状态检查间隔（秒），仅调用 GetLastInputInfo，开销很小
IDLE_CHECK_INTERVAL = 2.0
# PC-M4：stop() 等待主循环线程退出的最长时间（秒）
JOIN_TIMEOUT = 15.0

# 默认配置
# PC-M7：不再持久化后端登录密码，改用长期有效的 backend_token（Bearer Token）。
DEFAULT_CONFIG: dict[str, Any] = {
    "enabled": False,
    "server_url": "",
    # Windows Phase 1：可选的多端点候选（IPv6 优先，frp 回退）
    "endpoint_candidates": [],
    "username": "",
    "backend_token": "",
    # PC-M8：勾选后把密码用 DPAPI 加密持久化，重启自动登录（明文仍不落盘）
    "remember_password": False,
    "idle_threshold": 300,
    "window_enabled": True,
    "idle_enabled": True,
    "screen_enabled": True,
    # TLS 校验：默认完整校验；自签名后端可指定 CA bundle，或显式关闭校验
    "ssl_verify": True,
    "ssl_ca_file": "",
    # 设备身份：agent_id 用于后端区分数据来源；agent_name 为可读设备名
    # （agent_name 留空时回退到 Windows 计算机名，见 default_device_name）
    "agent_id": "default-agent",
    "agent_name": "",
}


def default_device_name() -> str:
    """默认设备名：Windows 计算机名；获取失败时回退为“我的电脑”。"""
    try:
        name = socket.gethostname().strip()
        return name or "我的电脑"
    except Exception:  # noqa: BLE001 - 主机名获取失败不应影响启动
        return "我的电脑"


# PC-M7：旧版配置中的明文密码字段名，加载时迁移移除，绝不重新落盘
LEGACY_PASSWORD_KEY = "password"
# PC-M8：勾选"记住密码"时，DPAPI 密文写入的字段名（非明文，仅本机本用户可解）
ENCRYPTED_PASSWORD_KEY = "password_enc"
# 配对获得的设备 Token 可优先用 DPAPI 密文保存，明文不落盘
ENCRYPTED_TOKEN_KEY = "backend_token_enc"
# PC-M7：配置接口中需要脱敏返回的敏感凭据字段
SENSITIVE_FIELDS = ("backend_token",)
# PC-M8：接口中完全不返回的字段（密文虽不可读，也无需暴露给前端）
HIDDEN_FIELDS = (ENCRYPTED_PASSWORD_KEY, ENCRYPTED_TOKEN_KEY)
# 脱敏占位值；收到该值表示"未修改"，保留原值
MASK = "******"


def _write_config(config_path: str, cfg: dict[str, Any]) -> None:
    """写入 pc_sensor_config.json（始终剔除明文密码；有密文时不写明文 Token）。"""
    safe = {k: v for k, v in cfg.items() if k != LEGACY_PASSWORD_KEY}
    if safe.get(ENCRYPTED_TOKEN_KEY) and safe.get("backend_token"):
        safe.pop("backend_token", None)
    try:
        os.makedirs(os.path.dirname(config_path) or ".", exist_ok=True)
        with open(config_path, "w", encoding="utf-8") as f:
            json.dump(safe, f, indent=2, ensure_ascii=False)
    except Exception as e:
        logger.warning("保存 PC 感知配置失败: %s", e)


def _ensure_config(config_path: str) -> tuple[dict[str, Any], str]:
    """确保 pc_sensor_config.json 存在，返回 (配置, 内存登录密码)。

    PC-M7：
    - 文件缺失时写入不含密码的默认配置；
    - 若发现旧版 ``password`` 字段，读出到返回值（仅供内存登录）后，
      立即重写文件，擦除磁盘上的明文密码。

    PC-M8：
    - 若启用了 ``remember_password``，尝试用 DPAPI 解密 ``password_enc``
      恢复密码，实现重启后自动登录；解密失败（换 Windows 账户/换机器）时
      降级为"需重新输入"，不影响启动。
    """
    if not config_path:
        return dict(DEFAULT_CONFIG), ""
    try:
        if os.path.exists(config_path):
            with open(config_path, "r", encoding="utf-8") as f:
                raw = json.load(f)
            if not isinstance(raw, dict):
                return dict(DEFAULT_CONFIG), ""
            # 旧版明文密码：读出后立即擦除磁盘字段，仅保留在内存
            legacy_pwd = str(raw.pop(LEGACY_PASSWORD_KEY, "") or "")
            if legacy_pwd:
                _write_config(config_path, raw)
                logger.info("已从配置文件中移除明文密码字段（PC-M7）")

            password = legacy_pwd
            # PC-M8：记住密码时，从本机 DPAPI 密文恢复（无需手动输入）
            if not password and bool(raw.get("remember_password", False)):
                password = secret_store.unprotect(
                    str(raw.get(ENCRYPTED_PASSWORD_KEY, "") or "")
                ) or ""
                if password:
                    logger.info("已从本机加密存储恢复后端密码（DPAPI），无需重新输入")
                else:
                    logger.warning(
                        "已启用记住密码，但无法解密本机存储的密码"
                        "（可能更换了 Windows 账户或机器），请重新输入密码"
                    )

            # 配对 Token：优先使用 DPAPI 密文，兼容旧版明文 backend_token
            if str(raw.get("backend_token") or "").strip():
                raw.pop(ENCRYPTED_TOKEN_KEY, None)
            elif raw.get(ENCRYPTED_TOKEN_KEY):
                token = secret_store.unprotect(str(raw.get(ENCRYPTED_TOKEN_KEY) or ""))
                if token:
                    raw["backend_token"] = token
                    logger.info("已从本机加密存储恢复后端 Token（DPAPI）")
                else:
                    logger.warning(
                        "无法解密本机存储的后端 Token（可能更换了 Windows 账户或机器），"
                        "请重新配对或填写 Token"
                    )
            return raw, password
        _write_config(config_path, DEFAULT_CONFIG)
        return dict(DEFAULT_CONFIG), ""
    except Exception as e:
        logger.warning("读取 PC 感知配置失败: %s", e)
        return dict(DEFAULT_CONFIG), ""


class SensorManager:
    """PC 感知采集管理器

    负责：
    - 加载/保存配置
    - 启动/停止各采集器
    - 在主循环中调度各采集器的 tick()
    - 通过 Uploader 将数据上报到后端
    """

    def __init__(self, config_path: str = ""):
        """
        Args:
            config_path: pc_sensor_config.json 路径
        """
        self.config_path = config_path
        # PC-M7：配置与内存密码分开保存，密码绝不进入 _cfg
        self._cfg, self._password = _ensure_config(config_path)
        # 设备身份兜底：agent_id 保证非空；agent_name 缺省时取 Windows 计算机名
        if not str(self._cfg.get("agent_id") or "").strip():
            self._cfg["agent_id"] = "default-agent"
        if not str(self._cfg.get("agent_name") or "").strip():
            self._cfg["agent_name"] = default_device_name()
        # 旧配置没有该字段时也保证配置接口返回可编辑的空列表
        self._cfg.setdefault("endpoint_candidates", [])

        self._init_uploader()

        self.window_tracker = WindowTracker(on_change=self._on_window_change)
        self.idle_tracker = IdleTracker(
            idle_threshold=self._cfg.get("idle_threshold", 300),
            on_idle=self._on_idle,
            on_active=self._on_active,
            on_screen_change=self._on_screen_change,
        )

        self._thread: Optional[threading.Thread] = None
        self._running = False
        # PC-M4：串行化 start/stop，避免并发调用导致重复启动主循环
        self._lock = threading.Lock()

    def _build_transport(self) -> TransportSelector:
        """按配置构建端点选择器；文件中的非法候选只告警并忽略。"""
        candidates: list[dict[str, Any]] = []
        try:
            candidates = normalize_candidates(self._cfg.get("endpoint_candidates") or [])
        except CandidateError as e:
            logger.warning("endpoint_candidates 配置无效，已忽略: %s", e)

        server_url = str(
            self._cfg.get("server_url") or os.environ.get("AGENT_SERVER_URL", "") or ""
        ).strip().rstrip("/")
        return TransportSelector(
            [EndpointCandidate(**entry) for entry in candidates],
            ssl_verify=bool(self._cfg.get("ssl_verify", True)),
            ssl_ca_file=str(self._cfg.get("ssl_ca_file", "") or ""),
            fallback_url=server_url,
        )

    def _init_uploader(self):
        """根据配置创建 Uploader 实例"""
        transport = self._build_transport()
        self.uploader = Uploader(
            server_url=str(self._cfg.get("server_url") or os.environ.get("AGENT_SERVER_URL", "")),
            username=self._cfg.get("username", ""),
            # PC-M7：密码仅来自内存（每次输入 / 旧配置迁移），不读取持久化字段
            password=self._password,
            agent_id=self._cfg.get("agent_id", "default-agent"),
            agent_name=str(self._cfg.get("agent_name", "") or default_device_name()),
            ssl_verify=bool(self._cfg.get("ssl_verify", True)),
            ssl_ca_file=str(self._cfg.get("ssl_ca_file", "") or ""),
            auth_token=str(self._cfg.get("backend_token", "") or ""),
            transport=transport,
        )
        if transport.has_candidates:
            self.uploader.server_url = transport.current_url
            self._cfg["server_url"] = transport.current_url

    def _refresh_selected_endpoint(self, force: bool = False) -> None:
        """探测并记录当前生效端点（仅在显式更新候选时调用）。"""
        transport = getattr(self.uploader, "transport", None)
        if transport is None or not transport.has_candidates:
            return
        selected = transport.select(force=force)
        if selected:
            self.uploader.server_url = selected
            self._cfg["server_url"] = selected

    # ---- 配置读写 ----

    @property
    def config(self) -> dict[str, Any]:
        c = dict(self._cfg)
        # PC-M7：敏感凭据一律脱敏返回；明文密码从不进入配置
        for key in SENSITIVE_FIELDS:
            if c.get(key):
                c[key] = MASK
        c.pop(LEGACY_PASSWORD_KEY, None)
        # PC-M8：DPAPI 密文不返回给前端（前端只需 remember_password 布尔值）
        for key in HIDDEN_FIELDS:
            c.pop(key, None)
        return c

    def update_config(
        self,
        new_cfg: dict[str, Any],
        *,
        encrypt_backend_token: bool = False,
    ) -> dict[str, Any]:
        """更新配置并保存。

        PC-M7：
        - 传入的 ``password`` 只更新内存中的登录密码，绝不写入配置文件；
          传空或 ``******`` 表示未修改。
        - 敏感字段 ``backend_token`` 收到 ``******`` 表示未修改，保留原值。

        PC-M8：
        - ``remember_password`` 为真且本次提供了密码时，用 DPAPI 加密后写入
          ``password_enc``（明文仍不落盘），重启后自动登录；
        - 关闭 ``remember_password`` 时一并清除已保存的密文。

        Windows Phase 1：
        - ``endpoint_candidates`` 接受列表或 {name: url} 对象，校验后规范化保存；
        - ``encrypt_backend_token=True``（配对流程）时优先用 DPAPI 密文保存 Token。
        """
        new_cfg = dict(new_cfg)
        previous_endpoint = self.uploader.current_endpoint if hasattr(self, "uploader") else ""

        candidates_changed = "endpoint_candidates" in new_cfg
        if candidates_changed:
            new_cfg["endpoint_candidates"] = normalize_candidates(
                new_cfg.get("endpoint_candidates")
            )

        # 明文密码只保存在内存，供本次/后续登录使用
        incoming_pwd = new_cfg.pop(LEGACY_PASSWORD_KEY, None)
        pwd_changed = incoming_pwd not in (None, "", MASK)
        if pwd_changed:
            self._password = str(incoming_pwd)

        # 掩码值表示未修改，保留磁盘原值
        for key in SENSITIVE_FIELDS:
            if new_cfg.get(key) == MASK:
                new_cfg.pop(key, None)

        # 密文只由服务端生成，拒绝前端注入
        new_cfg.pop(ENCRYPTED_PASSWORD_KEY, None)
        new_cfg.pop(ENCRYPTED_TOKEN_KEY, None)

        if "backend_token" in new_cfg:
            token_value = str(new_cfg.get("backend_token") or "").strip()
            new_cfg["backend_token"] = token_value
            encrypted_token = (
                secret_store.protect(token_value)
                if encrypt_backend_token and token_value
                else None
            )
            if encrypted_token:
                new_cfg[ENCRYPTED_TOKEN_KEY] = encrypted_token
            else:
                self._cfg.pop(ENCRYPTED_TOKEN_KEY, None)

        self._cfg.update(new_cfg)

        # PC-M8：按"记住密码"开关维护 DPAPI 密文
        remember = bool(self._cfg.get("remember_password", False))
        if remember:
            if pwd_changed:
                encrypted = secret_store.protect(self._password)
                if encrypted:
                    self._cfg[ENCRYPTED_PASSWORD_KEY] = encrypted
                    logger.info("已记住后端密码（DPAPI 加密存储，仅本机本用户可解）")
                else:
                    logger.warning("已开启记住密码，但本机加密失败，密码未持久化")
            elif not self._cfg.get(ENCRYPTED_PASSWORD_KEY):
                logger.info("已开启记住密码，但尚未收到密码，暂无可持久化的凭据")
        else:
            # 关闭记住密码：连密文一起清除，回到"仅内存"模式
            self._cfg.pop(ENCRYPTED_PASSWORD_KEY, None)

        # 同步到各组件
        self._init_uploader()
        transport = getattr(self.uploader, "transport", None)
        candidate_urls = {entry.base_url for entry in transport.candidates} if transport else set()
        if candidates_changed:
            self._refresh_selected_endpoint(force=True)
        elif previous_endpoint and previous_endpoint in candidate_urls:
            self.uploader.server_url = previous_endpoint
            self._cfg["server_url"] = previous_endpoint
        self.idle_tracker.idle_threshold = self._cfg.get("idle_threshold", 300)

        # 持久化（_write_config 剔除 password 明文；password_enc 密文正常写入）
        if self.config_path:
            _write_config(self.config_path, self._cfg)

        return self.config

    # ---- 生命周期 ----

    @property
    def running(self) -> bool:
        return self._running

    def start(self):
        """启动所有采集器（后台线程）。

        PC-M4：与 stop() 通过同一把锁串行化；若上一次主循环线程尚未退出，
        先等待其结束，确保任一时刻至多一个主循环。
        """
        with self._lock:
            if self._running:
                logger.info("PC 采集管理器已在运行")
                return

            # 上一次线程若仍在退出过程（如 flush 阻塞），先等它结束避免双主循环
            if self._thread is not None and self._thread.is_alive():
                logger.warning("上一次采集线程尚未退出，等待其结束")
                self._thread.join(timeout=JOIN_TIMEOUT)
                if self._thread.is_alive():
                    logger.error("上一次采集线程未能在 %ss 内退出，暂不重复启动", JOIN_TIMEOUT)
                    return

            enabled = self._cfg.get("enabled", False)
            if not enabled:
                logger.info("PC 感知采集未启用（可在配置中开启）")
                return

            # 检查登录状态
            if not self.uploader.has_token:
                logger.info("尚未登录，尝试登录...")
                self.uploader.force_relogin()

            if not self.uploader.has_token:
                logger.warning("无法登录，采集器暂不启动。请检查用户名密码和服务器地址")
                return

            self._running = True

            if self._cfg.get("window_enabled", True):
                self.window_tracker.start()
            if self._cfg.get("idle_enabled", True) or self._cfg.get("screen_enabled", True):
                self.idle_tracker.start()

            self._thread = threading.Thread(target=self._run_loop, daemon=True, name="pc-sensor")
            self._thread.start()
            logger.info("PC 采集管理器已启动 (idle_threshold=%ds)", self.idle_tracker.idle_threshold)

    def stop(self):
        """停止所有采集器。

        PC-M4：置位停止标志后 join 主循环线程，保证 stop() 返回时线程已退出；
        整个过程持锁，避免与 start() 交错。
        """
        with self._lock:
            self._running = False
            self.window_tracker.stop()
            self.idle_tracker.stop()

            thread = self._thread
            if (
                thread is not None
                and thread.is_alive()
                and thread is not threading.current_thread()
            ):
                thread.join(timeout=JOIN_TIMEOUT)
                if thread.is_alive():
                    logger.warning("采集线程在 %ss 内未退出", JOIN_TIMEOUT)
            self._thread = None

            self.uploader.flush()
            logger.info("PC 采集管理器已停止")

    def get_status(self) -> dict[str, Any]:
        """获取运行状态"""
        return {
            "running": self._running,
            "enabled": self._cfg.get("enabled", False),
            "logged_in": self.uploader.has_token,
            "auth_error": getattr(self.uploader, "auth_error", ""),
            "window": self.window_tracker.running,
            "idle": self.idle_tracker.running,
            "last_events": self._last_events,
            "queue_size": self.uploader.buffer_size,
            "current_endpoint": self.uploader.current_endpoint,
        }

    # ---- 主循环 ----

    def _run_loop(self):
        """采集主循环"""
        last_window = 0.0
        last_idle = 0.0
        last_screen_scan = 0.0
        last_upload = 0.0

        while self._running:
            now = time.monotonic()

            if self._cfg.get("window_enabled", True) and now - last_window >= 1.0:
                self.window_tracker.tick()
                last_window = now

            if (self._cfg.get("idle_enabled", True) or self._cfg.get("screen_enabled", True)) \
                    and now - last_idle >= IDLE_CHECK_INTERVAL:
                # PC-M6：全进程锁屏扫描降频到 SCREEN_SCAN_INTERVAL，其余 tick 只做廉价空闲检测
                need_screen_scan = now - last_screen_scan >= SCREEN_SCAN_INTERVAL
                self.idle_tracker.tick(check_screen=need_screen_scan)
                if need_screen_scan:
                    last_screen_scan = now
                last_idle = now

            if now - last_upload >= 5.0:
                self.uploader.flush()
                last_upload = now

            time.sleep(0.2)

        self.uploader.flush()

    # ---- 事件回调 ----

    _last_events: list[dict[str, Any]] = []
    _MAX_EVENTS = 50

    def _record_event(self, data: dict[str, Any]):
        self._last_events.append(data)
        if len(self._last_events) > self._MAX_EVENTS:
            self._last_events = self._last_events[-self._MAX_EVENTS:]

    def _on_window_change(self, win: WindowInfo):
        data = {
            "type": "pc_window",
            "t": datetime.now(CST).strftime("%H:%M:%S"),
            "t_iso": datetime.now(CST).isoformat(),
            "payload": {
                "process": win.process,
                "title": win.title[:200] if win.title else "",
                "pid": win.pid,
            },
        }
        self.uploader.enqueue(data)
        self._record_event(data)
        logger.info("窗口变化: %s - %s", win.process, win.title[:60])

    def _on_idle(self, idle_seconds: int):
        data = {
            "type": "pc_idle",
            "t": datetime.now(CST).strftime("%H:%M:%S"),
            "t_iso": datetime.now(CST).isoformat(),
            "payload": {
                "state": "idle",
                "idle_seconds": idle_seconds,
            },
        }
        self.uploader.enqueue(data)
        self._record_event(data)
        logger.info("无人状态: 已空闲 %d 秒", idle_seconds)

    def _on_active(self):
        data = {
            "type": "pc_idle",
            "t": datetime.now(CST).strftime("%H:%M:%S"),
            "t_iso": datetime.now(CST).isoformat(),
            "payload": {
                "state": "active",
                "idle_seconds": 0,
            },
        }
        self.uploader.enqueue(data)
        self._record_event(data)
        logger.info("用户恢复使用")

    def _on_screen_change(self, locked: bool):
        data = {
            "type": "pc_screen",
            "t": datetime.now(CST).strftime("%H:%M:%S"),
            "t_iso": datetime.now(CST).isoformat(),
            "payload": {
                "state": "lock" if locked else "unlock",
            },
        }
        self.uploader.enqueue(data)
        self._record_event(data)
        logger.info("屏幕%s", "锁定" if locked else "解锁")
