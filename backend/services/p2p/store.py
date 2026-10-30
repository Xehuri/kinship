from __future__ import annotations

import json
import logging
import os
import secrets
import tempfile
import threading
import time
from dataclasses import replace
from typing import Any, Callable, Optional

from services.p2p.records import DeviceRecord


logger = logging.getLogger(__name__)

_SCHEMA_VERSION = 1
_DEVICE_ID_MAX_LEN = 64
_NAME_MAX_LEN = 128
_DEVICE_ID_CHARS = frozenset(
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-"
)
_PAIRING_CODE_MIN = 10_000_000
_PAIRING_CODE_RANGE = 90_000_000


def is_valid_device_id(value: str) -> bool:
    if not isinstance(value, str):
        return False
    if not 1 <= len(value) <= _DEVICE_ID_MAX_LEN:
        return False
    return all(char in _DEVICE_ID_CHARS for char in value)


class DeviceStoreError(ValueError):
    """设备注册表输入非法。"""


class PairingCodeError(RuntimeError):
    """配对码无法生成。"""


class DeviceStore:
    """设备注册表（JSON 文件，原子写 + 0600）。

    所有读写都在进程内锁下完成；落盘先写同目录临时文件再 os.replace，
    避免部分写入导致注册表损坏。
    """

    def __init__(self, path: str, clock: Callable[[], float] = time.time) -> None:
        self._path = str(path)
        self._clock = clock
        self._lock = threading.RLock()
        self._devices: dict[str, DeviceRecord] = {}
        self._loaded = False

    @property
    def path(self) -> str:
        return self._path

    def _ensure_loaded(self) -> None:
        if self._loaded:
            return
        self._loaded = True
        if not self._path or not os.path.exists(self._path):
            return
        try:
            with open(self._path, "r", encoding="utf-8") as handle:
                data = json.load(handle)
        except (OSError, ValueError) as exc:
            logger.warning("[P2P] 设备注册表读取失败，按空表继续: %s", type(exc).__name__)
            return
        devices = data.get("devices") if isinstance(data, dict) else None
        if not isinstance(devices, dict):
            logger.warning("[P2P] 设备注册表格式非法，按空表继续")
            return
        loaded: dict[str, DeviceRecord] = {}
        for device_id, record in devices.items():
            try:
                loaded[str(device_id)] = DeviceRecord.from_dict(str(device_id), record)
            except (TypeError, ValueError):
                logger.warning("[P2P] 跳过损坏的设备记录 device_id=%s", device_id)
        self._devices = loaded

    def _save_locked(self) -> None:
        directory = os.path.dirname(os.path.abspath(self._path)) or "."
        os.makedirs(directory, mode=0o700, exist_ok=True)
        payload = {
            "version": _SCHEMA_VERSION,
            "devices": {
                device_id: record.to_dict()
                for device_id, record in self._devices.items()
            },
        }
        fd, tmp_path = tempfile.mkstemp(
            dir=directory, prefix=".p2p_devices_", suffix=".tmp"
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, ensure_ascii=False, indent=2)
                handle.flush()
                os.fsync(handle.fileno())
            os.chmod(tmp_path, 0o600)
            os.replace(tmp_path, self._path)
            os.chmod(self._path, 0o600)
        except Exception:  # noqa: BROAD_EXCEPT_OK - cleanup then re-raise
            try:
                if os.path.exists(tmp_path):
                    os.remove(tmp_path)
            except OSError as exc:
                logger.debug("[P2P] 临时文件清理失败: %s", type(exc).__name__)
            raise
        try:
            os.chmod(directory, 0o700)
        except OSError as exc:
            logger.debug("[P2P] 设备目录权限设置失败: %s", type(exc).__name__)

    def save(self) -> None:
        with self._lock:
            self._ensure_loaded()
            self._save_locked()

    def register(
        self,
        device_id: str,
        name: str,
        platform: str,
        user_id: str,
        token_fingerprint: str = "",
    ) -> DeviceRecord:
        if not is_valid_device_id(device_id):
            raise DeviceStoreError("invalid device_id")
        with self._lock:
            self._ensure_loaded()
            now = int(self._clock())
            existing = self._devices.get(device_id)
            if existing is None:
                record = DeviceRecord(
                    device_id=device_id,
                    name=(name or device_id)[:_NAME_MAX_LEN],
                    platform=(platform or "")[:32],
                    user_id=user_id,
                    created_at=now,
                    last_seen=now,
                    revoked_at=None,
                    token_fingerprint=token_fingerprint,
                )
            else:
                record = replace(
                    existing,
                    name=(name or existing.name)[:_NAME_MAX_LEN],
                    platform=(platform or existing.platform)[:32],
                    user_id=user_id,
                    last_seen=now,
                    revoked_at=None,
                    token_fingerprint=token_fingerprint or existing.token_fingerprint,
                )
            self._devices[device_id] = record
            self._save_locked()
            return record

    def get(self, device_id: str) -> Optional[DeviceRecord]:
        with self._lock:
            self._ensure_loaded()
            return self._devices.get(device_id)

    def list(self, user_id: Optional[str] = None) -> list[DeviceRecord]:
        with self._lock:
            self._ensure_loaded()
            records = list(self._devices.values())
        if user_id is not None:
            records = [record for record in records if record.user_id == user_id]
        return sorted(records, key=lambda record: (record.created_at, record.device_id))

    def revoke(self, device_id: str) -> bool:
        with self._lock:
            self._ensure_loaded()
            record = self._devices.get(device_id)
            if record is None:
                return False
            if record.revoked_at is None:
                self._devices[device_id] = replace(
                    record, revoked_at=int(self._clock())
                )
                self._save_locked()
            return True

    def is_revoked(self, device_id: str) -> bool:
        record = self.get(device_id)
        return bool(record is not None and record.revoked_at is not None)

    def touch(self, device_id: str) -> None:
        with self._lock:
            self._ensure_loaded()
            record = self._devices.get(device_id)
            if record is None:
                return
            self._devices[device_id] = replace(
                record, last_seen=int(self._clock())
            )
            self._save_locked()


class PairingCodes:
    """内存配对码：8 位数字、单次使用、TTL 与失败次数上限。

    配对码只存在于内存，既不写盘也不进日志；进程重启后全部失效。
    """

    def __init__(
        self,
        ttl_seconds: int = 300,
        max_attempts: int = 5,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._ttl_seconds = max(1, int(ttl_seconds))
        self._max_attempts = max(1, int(max_attempts))
        self._clock = clock
        self._lock = threading.Lock()
        self._codes: dict[str, dict[str, Any]] = {}

    def _purge_locked(self, now: float) -> None:
        expired = [code for code, item in self._codes.items() if item["expires_at"] <= now]
        for code in expired:
            self._codes.pop(code, None)

    def issue(self, user_id: str) -> tuple[str, int]:
        with self._lock:
            now = self._clock()
            self._purge_locked(now)
            code = ""
            for _ in range(10):
                candidate = str(
                    secrets.randbelow(_PAIRING_CODE_RANGE) + _PAIRING_CODE_MIN
                )
                if candidate not in self._codes:
                    code = candidate
                    break
            if not code:
                raise PairingCodeError("unable to allocate pairing code")
            expires_at = int(now) + self._ttl_seconds
            self._codes[code] = {
                "user_id": user_id,
                "expires_at": expires_at,
                "attempts": 0,
            }
            return code, expires_at

    def consume(self, code: str, device_id: str) -> Optional[str]:
        normalized = (code or "").strip()
        with self._lock:
            now = self._clock()
            self._purge_locked(now)
            entry = self._codes.get(normalized)
            if entry is None:
                return None
            entry["attempts"] += 1
            if entry["attempts"] > self._max_attempts:
                self._codes.pop(normalized, None)
                return None
            if not is_valid_device_id(device_id):
                return None
            self._codes.pop(normalized, None)
            return str(entry["user_id"])

    def clear(self) -> None:
        with self._lock:
            self._codes.clear()

    def __len__(self) -> int:
        with self._lock:
            return len(self._codes)
