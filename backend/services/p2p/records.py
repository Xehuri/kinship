from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional


class DeviceRecordError(ValueError):
    """设备记录格式非法。"""


@dataclass(frozen=True, slots=True)
class DeviceRecord:
    device_id: str
    name: str
    platform: str
    user_id: str
    created_at: int
    last_seen: int
    revoked_at: Optional[int] = None
    token_fingerprint: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "device_id": self.device_id,
            "name": self.name,
            "platform": self.platform,
            "user_id": self.user_id,
            "created_at": self.created_at,
            "last_seen": self.last_seen,
            "revoked_at": self.revoked_at,
            "token_fingerprint": self.token_fingerprint,
        }

    @classmethod
    def from_dict(cls, device_id: str, data: Any) -> "DeviceRecord":
        if not isinstance(data, dict):
            raise DeviceRecordError("device record must be an object")
        return cls(
            device_id=device_id,
            name=str(data.get("name") or ""),
            platform=str(data.get("platform") or ""),
            user_id=str(data.get("user_id") or ""),
            created_at=int(data.get("created_at") or 0),
            last_seen=int(data.get("last_seen") or 0),
            revoked_at=(
                int(data["revoked_at"]) if data.get("revoked_at") is not None else None
            ),
            token_fingerprint=str(data.get("token_fingerprint") or ""),
        )
