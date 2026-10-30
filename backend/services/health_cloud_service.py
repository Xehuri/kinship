"""小米健康云后台服务：配置开关、状态机、自动拉取、扫码登录与历史回填。

数据流：定时拉取 -> CloudPullSource.fetch -> HealthStore.write(cloud 分片)。
运行时开关与最近状态落 backend/data/health_cloud_state.json（前端可即时切换，
无需重启后端）；部署默认值经 ConfigStore live 快照读 health.cloud.enabled。
"""

import base64
import json
import logging
import os
import threading
import time
from typing import Any, Dict, Optional

import requests

from config.config import get_config
from config.store import ConfigStoreError, get_config_store
from core.redaction import mask_secret, redact_text
from services.health.sources.cloud_pull import CloudAuthError, CloudPullSource
from services.health_storage import get_health_store

logger = logging.getLogger(__name__)

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

STATE_DISABLED = "disabled"
STATE_UNCONFIGURED = "unconfigured"
STATE_AUTH_EXPIRED = "auth_expired"
STATE_ERROR = "error"
STATE_OK = "ok"
STATE_SYNCING = "syncing"

_service: Optional["HealthCloudService"] = None
_service_lock = threading.Lock()


class HealthCloudService:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._stop_event = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._pull_lock = threading.Lock()
        self._source: Optional[CloudPullSource] = None
        self._qr_source: Optional[CloudPullSource] = None
        self._qr_lp: str = ""

    # ---- 状态文件 -------------------------------------------------------

    def state_path(self) -> str:
        raw = get_config().HEALTH_CLOUD_STATE_PATH
        return raw if os.path.isabs(raw) else os.path.join(ROOT, raw)

    def _load_state(self) -> Dict[str, Any]:
        path = self.state_path()
        if not os.path.exists(path):
            return {}
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
            return data if isinstance(data, dict) else {}
        except (OSError, json.JSONDecodeError):
            return {}

    def _save_state(self, state: Dict[str, Any]) -> None:
        path = self.state_path()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(state, f, ensure_ascii=False, indent=2)
        os.replace(tmp, path)

    def _update_state(self, **fields: Any) -> Dict[str, Any]:
        with self._lock:
            state = self._load_state()
            state.update(fields)
            self._save_state(state)
            return state

    # ---- 配置与开关 -----------------------------------------------------

    def configured(self) -> bool:
        cfg = get_config()
        return bool(cfg.HEALTH_CLOUD_USERID and cfg.HEALTH_CLOUD_PASSTOKEN)

    def is_enabled(self) -> bool:
        state = self._load_state()
        if "enabled" in state:
            return bool(state["enabled"])
        return bool(get_config().HEALTH_CLOUD_ENABLED)

    def set_enabled(
        self, enabled: bool, start_pull: bool = True
    ) -> Dict[str, Any]:
        """持久化运行时开关；``start_pull=False`` 只写状态，不拉起拉取线程。

        关闭时总是停掉已存在的后台线程；引导流程用 ``start_pull=False``
        记录启用意图，实际拉取等引导结束（服务面启动）后再进行。
        """
        state = self._update_state(enabled=bool(enabled))
        if not enabled:
            if self._thread is not None:
                self.stop()
            return state
        if start_pull and self._thread is None:
            self.start()
        return state

    def invalidate_source(self) -> None:
        """丢弃缓存的云端数据源，下次拉取按新凭据/区域重建（配置热重载钩子）。"""
        with self._lock:
            self._source = None
            self._qr_source = None
            self._qr_lp = ""

    # ---- 状态机 ---------------------------------------------------------

    def status(self, probe: bool = False) -> Dict[str, Any]:
        cfg = get_config()
        state = self._load_state()
        if not self.is_enabled():
            phase = STATE_DISABLED
        elif not self.configured():
            phase = STATE_UNCONFIGURED
        elif probe:
            phase, error = self.probe()
            if error:
                state["last_error"] = error
                self._save_state(state)
        elif state.get("last_error"):
            phase = (
                STATE_AUTH_EXPIRED
                if "401" in str(state["last_error"])
                else STATE_ERROR
            )
        elif state.get("last_success"):
            phase = STATE_OK
        else:
            phase = STATE_UNCONFIGURED if not self.configured() else STATE_ERROR

        configured_userid = str(cfg.HEALTH_CLOUD_USERID or "")
        return {
            "enabled": self.is_enabled(),
            "configured": self.configured(),
            "phase": phase,
            "userid": mask_secret(configured_userid) if configured_userid else "",
            "userid_configured": bool(configured_userid),
            "region": cfg.HEALTH_CLOUD_REGION,
            "poll_interval_min": cfg.HEALTH_CLOUD_POLL_INTERVAL_MIN,
            "overlap_days": cfg.HEALTH_CLOUD_OVERLAP_DAYS,
            "last_attempt": state.get("last_attempt"),
            "last_success": state.get("last_success"),
            "watermark": state.get("watermark"),
            "last_error": redact_text(state.get("last_error") or ""),
            "last_batches": state.get("last_batches", 0),
            "consecutive_failures": state.get("consecutive_failures", 0),
            "latest_cloud_shard": self._latest_cloud_shard(),
        }

    def probe(self) -> tuple:
        try:
            now = int(time.time())
            self._get_source().latest_sample_ts_between(
                ["heart_rate"], now - 3600, now
            )
            return STATE_OK, ""
        except CloudAuthError as exc:
            return STATE_AUTH_EXPIRED, str(exc)
        except Exception as exc:
            return STATE_ERROR, str(exc)

    def _latest_cloud_shard(self) -> str:
        store = get_health_store()
        user_id = store.primary_user
        if not user_id:
            return ""
        root = os.path.join(store.data_root, user_id, "health")
        if not os.path.isdir(root):
            return ""
        for date in sorted(os.listdir(root), reverse=True):
            if os.path.exists(os.path.join(root, date, "cloud.json")):
                return date
        return ""

    # ---- 拉取 -----------------------------------------------------------

    def _resolve_user_id(self) -> str:
        store = get_health_store()
        if store.primary_user:
            return store.primary_user
        from auth import get_auth_config

        users = get_auth_config().users
        return next(iter(users)) if users else ""

    def _get_source(self) -> CloudPullSource:
        with self._lock:
            if self._source is None:
                self._source = CloudPullSource()
            return self._source

    def _pull_window(self, days: Optional[int]) -> int:
        cfg = get_config()
        now = int(time.time())
        if days is not None:
            return now - max(1, int(days)) * 86400
        state = self._load_state()
        watermark = state.get("watermark")
        if not watermark:
            return now - cfg.HEALTH_CLOUD_INITIAL_LOOKBACK_DAYS * 86400
        overlap = cfg.HEALTH_CLOUD_OVERLAP_DAYS * 86400
        return min(int(watermark), now - overlap)

    def pull_once(self, days: Optional[int] = None) -> Dict[str, Any]:
        if not self._pull_lock.acquire(blocking=False):
            return {"ok": False, "written": 0, "error": "已有拉取任务在运行"}
        try:
            return self._pull_once_locked(days)
        finally:
            self._pull_lock.release()

    def _pull_once_locked(self, days: Optional[int] = None) -> Dict[str, Any]:
        if not self.configured():
            message = "缺少小米云凭据，请先扫码登录"
            self._update_state(last_error=message)
            return {"ok": False, "written": 0, "error": message}

        user_id = self._resolve_user_id()
        if not user_id:
            message = "无法解析本地用户，请设置 health.primary_user"
            self._update_state(last_error=message)
            return {"ok": False, "written": 0, "error": message}

        since = self._pull_window(days)
        self._update_state(last_attempt=int(time.time()))
        try:
            batches = self._get_source().fetch(since=since, user_id=user_id)
            written = 0
            if batches:
                store = get_health_store()
                for batch in batches:
                    store.write(batch)
                    written += 1
            now = int(time.time())
            self._update_state(
                last_success=now,
                watermark=now,
                last_batches=written,
                consecutive_failures=0,
                last_error="",
            )
            logger.info(
                "小米云拉取完成: batches=%s since=%s user=%s", written, since, user_id
            )
            return {"ok": True, "written": written, "since": since}
        except CloudAuthError as exc:
            failures = int(self._load_state().get("consecutive_failures", 0)) + 1
            self._update_state(
                consecutive_failures=failures, last_error=f"凭据失效: {exc}"
            )
            logger.warning("小米云凭据失效: %s", exc)
            return {"ok": False, "written": 0, "error": str(exc)}
        except Exception as exc:
            failures = int(self._load_state().get("consecutive_failures", 0)) + 1
            self._update_state(consecutive_failures=failures, last_error=str(exc))
            logger.exception("小米云拉取失败")
            return {"ok": False, "written": 0, "error": str(exc)}

    def backfill(self, days: int) -> Dict[str, Any]:
        return self.pull_once(days=days)

    def latest_cloud_samples(self, window_hours: int = 48) -> Dict[str, Any]:
        if not self.configured():
            return {"ok": False, "error": "缺少小米云凭据", "samples": {}}
        end_ts = int(time.time())
        start_ts = end_ts - max(1, int(window_hours)) * 3600
        try:
            samples = self._get_source().latest_sample_ts_between(
                None, start_ts, end_ts
            )
            return {
                "ok": True,
                "window_hours": int(window_hours),
                "samples": samples,
                "now": end_ts,
            }
        except CloudAuthError as exc:
            return {"ok": False, "error": f"凭据失效: {exc}", "samples": {}}
        except Exception as exc:
            return {"ok": False, "error": str(exc), "samples": {}}

    # ---- 扫码登录 -------------------------------------------------------

    def request_qr(self) -> Dict[str, Any]:
        source = CloudPullSource()
        info = source.request_qr()
        png = requests.get(info["qr"], timeout=10).content
        with self._lock:
            self._qr_source = source
            self._qr_lp = info["lp"]
        return {
            "lp": info["lp"],
            "qr_base64": base64.b64encode(png).decode("ascii"),
            "expires_in": int(info.get("timeout", 300)),
            "login_url": info.get("loginUrl", ""),
        }

    def poll_qr_once(self, lp: str, start_pull: bool = False) -> Dict[str, Any]:
        """单次轮询扫码结果；``start_pull`` 透传给 :meth:`apply_credentials`。

        默认不触发首次拉取，引导流程可安全轮询；设置页显式传 ``start_pull``
        保持原有的“扫码成功后立即同步”。
        """
        with self._lock:
            source = self._qr_source if self._qr_lp == lp else None
        if source is None:
            source = CloudPullSource()
        result = source.poll_once(lp)
        if not result:
            return {"state": "waiting"}
        user_id, pass_token = result
        self.apply_credentials(user_id, pass_token, start_pull=start_pull)
        return {
            "state": "success",
            "user_id": mask_secret(str(user_id)) if user_id else "",
        }

    def apply_credentials(
        self, user_id: str, pass_token: str, start_pull: bool = True
    ) -> None:
        """把扫码凭据写入当前配置载体（web 路径，经 ConfigStore 热写）。

        不调用 ``store.apply``：health cloud reconciler 会递归回本服务；
        source 重置与首次拉取由本方法自行完成。CLI
        ``backend/scripts/mi_cloud_setup.py`` 仍保留直写 YAML 的老路径。

        ``start_pull=False``（引导流程）只写配置与运行时状态，绝不发起首次
        拉取；默认 ``True`` 保持设置页“扫码成功后立即同步”的既有行为。
        """
        region = str(get_config().HEALTH_CLOUD_REGION or "cn")
        changes = {
            "health.cloud.userid": user_id,
            "health.cloud.passtoken": pass_token,
            "health.cloud.region": region,
        }
        try:
            get_config_store().save(changes)
        except ConfigStoreError as exc:
            logger.warning("小米云凭据写入配置失败: %s", exc.code)
            raise RuntimeError(f"云端凭据写入配置失败（{exc.code}）") from exc
        except OSError as exc:
            logger.warning("小米云凭据写入配置失败: %s", type(exc).__name__)
            raise RuntimeError("云端凭据写入配置失败") from exc

        with self._lock:
            self._source = None
        self._update_state(last_error="", needs_login=False)
        logger.info("小米云凭据已写入配置存储（region=%s）", region)
        if start_pull:
            threading.Thread(
                target=self.pull_once, name="health-cloud-first-pull", daemon=True
            ).start()

    # ---- 后台循环 -------------------------------------------------------

    def start(self) -> None:
        with self._lock:
            if self._thread and self._thread.is_alive():
                return
            self._stop_event.clear()
            self._thread = threading.Thread(
                target=self._loop, name="health-cloud", daemon=True
            )
            self._thread.start()
            logger.info("小米云后台拉取线程已启动")

    def stop(self) -> None:
        self._stop_event.set()
        thread = self._thread
        if thread:
            thread.join(timeout=5)
        with self._lock:
            self._thread = None

    def _loop(self) -> None:
        while not self._stop_event.is_set():
            try:
                if self.is_enabled() and self.configured():
                    self.pull_once()
            except Exception:
                logger.exception("小米云后台循环异常")
            interval = max(1, get_config().HEALTH_CLOUD_POLL_INTERVAL_MIN) * 60
            self._stop_event.wait(interval)


def get_health_cloud_service() -> HealthCloudService:
    global _service
    with _service_lock:
        if _service is None:
            _service = HealthCloudService()
        return _service
