from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping


def _as_bool(value: Any, default: bool) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        text = value.strip().lower()
        if text in {"1", "true", "yes", "on"}:
            return True
        if text in {"0", "false", "no", "off"}:
            return False
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return bool(value)
    return default


def _as_int(value: Any, default: int) -> int:
    if isinstance(value, bool):
        return default
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        try:
            return int(value.strip())
        except ValueError:
            return default
    return default


def _as_str(value: Any, default: str = "") -> str:
    if value is None:
        return default
    return str(value)


def _as_str_tuple(value: Any) -> tuple[str, ...]:
    if value is None:
        return ()
    if isinstance(value, str):
        items = [item.strip() for item in value.split(",")]
    elif isinstance(value, (list, tuple, set)):
        items = [str(item).strip() for item in value]
    else:
        return ()
    return tuple(item for item in items if item)


def _section(raw: Mapping[str, Any], key: str) -> Mapping[str, Any]:
    value = raw.get(key)
    return value if isinstance(value, Mapping) else {}


@dataclass(frozen=True)
class AccountConfig:
    self_qq: str = ""
    peer_allowlist: tuple[str, ...] = ()
    ws_url: str = "ws://127.0.0.1:3001"
    ws_token: str = ""
    ws_token_file: str = ""

    @classmethod
    def from_dict(cls, raw: Mapping[str, Any]) -> "AccountConfig":
        token_env = _as_str(raw.get("ws_token_env"), "NAPCAT_WS_TOKEN")
        token = _as_str(raw.get("ws_token")) or os.environ.get(token_env, "")
        token_file = _as_str(raw.get("ws_token_file"))
        if not token and token_file:
            token = _read_secret(token_file)
        return cls(
            self_qq=_as_str(raw.get("self_qq")),
            peer_allowlist=_as_str_tuple(raw.get("peer_allowlist")),
            ws_url=_as_str(raw.get("ws_url"), "ws://127.0.0.1:3001"),
            ws_token=token,
            ws_token_file=token_file,
        )


@dataclass(frozen=True)
class ConnectionConfig:
    heartbeat_interval_sec: float = 20.0
    heartbeat_timeout_sec: float = 90.0
    action_timeout_sec: float = 15.0
    reconnect_min_sec: float = 1.0
    reconnect_max_sec: float = 30.0
    max_msg_size_mb: int = 50

    @classmethod
    def from_dict(cls, raw: Mapping[str, Any]) -> "ConnectionConfig":
        return cls(
            heartbeat_interval_sec=float(raw.get("heartbeat_interval_sec", 20.0)),
            heartbeat_timeout_sec=float(raw.get("heartbeat_timeout_sec", 90.0)),
            action_timeout_sec=float(raw.get("action_timeout_sec", 15.0)),
            reconnect_min_sec=float(raw.get("reconnect_min_sec", 1.0)),
            reconnect_max_sec=float(raw.get("reconnect_max_sec", 30.0)),
            max_msg_size_mb=max(1, min(50, _as_int(raw.get("max_msg_size_mb"), 50))),
        )


@dataclass(frozen=True)
class InboundConfig:
    enabled: bool = True
    deliver: bool = True
    shadow: bool = False
    private: bool = True
    groups: bool = False
    group_allowlist: tuple[str, ...] = ()
    require_at: bool = True
    self_messages: bool = False
    notices: bool = True
    requests: bool = True

    @classmethod
    def from_dict(cls, raw: Mapping[str, Any]) -> "InboundConfig":
        return cls(
            enabled=_as_bool(raw.get("enabled"), True),
            deliver=_as_bool(raw.get("deliver"), True),
            shadow=_as_bool(raw.get("shadow"), False),
            private=_as_bool(raw.get("private"), True),
            groups=_as_bool(raw.get("groups"), False),
            group_allowlist=_as_str_tuple(raw.get("group_allowlist")),
            require_at=_as_bool(raw.get("require_at"), True),
            self_messages=_as_bool(raw.get("self_messages"), False),
            notices=_as_bool(raw.get("notices"), True),
            requests=_as_bool(raw.get("requests"), True),
        )


@dataclass(frozen=True)
class OutboundConfig:
    enabled: bool = True
    dry_run: bool = False
    private: bool = True
    groups: bool = False
    group_allowlist: tuple[str, ...] = ()
    send_rate_per_min: int = 20
    min_interval_ms: int = 300
    max_upload_mb: int = 100

    @classmethod
    def from_dict(cls, raw: Mapping[str, Any]) -> "OutboundConfig":
        return cls(
            enabled=_as_bool(raw.get("enabled"), True),
            dry_run=_as_bool(raw.get("dry_run"), False),
            private=_as_bool(raw.get("private"), True),
            groups=_as_bool(raw.get("groups"), False),
            group_allowlist=_as_str_tuple(raw.get("group_allowlist")),
            send_rate_per_min=max(1, _as_int(raw.get("send_rate_per_min"), 20)),
            min_interval_ms=max(0, _as_int(raw.get("min_interval_ms"), 300)),
            max_upload_mb=max(1, _as_int(raw.get("max_upload_mb"), 100)),
        )


@dataclass(frozen=True)
class ForwardConfig:
    enabled: bool = True
    max_depth: int = 3
    max_nodes: int = 200
    max_chars: int = 8000
    cache_ttl_sec: int = 3600
    parse_mult_msg: bool = False

    @classmethod
    def from_dict(cls, raw: Mapping[str, Any]) -> "ForwardConfig":
        return cls(
            enabled=_as_bool(raw.get("enabled"), True),
            max_depth=max(1, min(3, _as_int(raw.get("max_depth"), 3))),
            max_nodes=max(1, _as_int(raw.get("max_nodes"), 200)),
            max_chars=max(100, _as_int(raw.get("max_chars"), 8000)),
            cache_ttl_sec=max(0, _as_int(raw.get("cache_ttl_sec"), 3600)),
            parse_mult_msg=_as_bool(raw.get("parse_mult_msg"), False),
        )


@dataclass(frozen=True)
class MediaConfig:
    dir: str = "data/qq_gateway/media"
    max_mb: int = 100
    keep_days: int = 7
    gif_sniff: bool = True

    @classmethod
    def from_dict(cls, raw: Mapping[str, Any]) -> "MediaConfig":
        return cls(
            dir=_as_str(raw.get("dir"), "data/qq_gateway/media"),
            max_mb=max(1, _as_int(raw.get("max_mb"), 100)),
            keep_days=max(1, _as_int(raw.get("keep_days"), 7)),
            gif_sniff=_as_bool(raw.get("gif_sniff"), True),
        )


@dataclass(frozen=True)
class DeliveryConfig:
    session: str = "main-task"
    max_retries: int = 5
    retry_backoff_sec: int = 5
    queue_limit: int = 1000
    reconcile: bool = True

    @classmethod
    def from_dict(cls, raw: Mapping[str, Any]) -> "DeliveryConfig":
        return cls(
            session=_as_str(raw.get("session"), "main-task"),
            max_retries=max(1, _as_int(raw.get("max_retries"), 5)),
            retry_backoff_sec=max(1, _as_int(raw.get("retry_backoff_sec"), 5)),
            queue_limit=max(1, _as_int(raw.get("queue_limit"), 1000)),
            reconcile=_as_bool(raw.get("reconcile"), True),
        )


@dataclass(frozen=True)
class QZoneConfig:
    enabled: bool = False
    mode: str = "off"
    allow_send: bool = False
    allow_delete: bool = False
    allow_read: bool = False
    rate_per_hour: int = 5

    @classmethod
    def from_dict(cls, raw: Mapping[str, Any]) -> "QZoneConfig":
        mode = _as_str(raw.get("mode"), "off").lower()
        if mode not in {"off", "native", "http_sidecar", "snowluma"}:
            mode = "off"
        return cls(
            enabled=_as_bool(raw.get("enabled"), False),
            mode=mode,
            allow_send=_as_bool(raw.get("allow_send"), False),
            allow_delete=_as_bool(raw.get("allow_delete"), False),
            allow_read=_as_bool(raw.get("allow_read"), False),
            rate_per_hour=max(1, _as_int(raw.get("rate_per_hour"), 5)),
        )


@dataclass(frozen=True)
class MCPConfig:
    enabled: bool = True
    host: str = "127.0.0.1"
    port: int = 8770
    token: str = ""
    token_file: str = ""
    token_env: str = "QQ_GATEWAY_MCP_TOKEN"

    @classmethod
    def from_dict(cls, raw: Mapping[str, Any]) -> "MCPConfig":
        token = _as_str(raw.get("token")) or os.environ.get(
            _as_str(raw.get("token_env"), "QQ_GATEWAY_MCP_TOKEN"), ""
        )
        token_file = _as_str(raw.get("token_file"))
        if not token and token_file:
            token = _read_secret(token_file)
        return cls(
            enabled=_as_bool(raw.get("enabled"), True),
            host=_as_str(raw.get("host"), "127.0.0.1"),
            port=max(0, min(65535, _as_int(raw.get("port"), 8770))),
            token=token,
            token_file=token_file,
            token_env=_as_str(raw.get("token_env"), "QQ_GATEWAY_MCP_TOKEN"),
        )


@dataclass(frozen=True)
class LoggingConfig:
    level: str = "INFO"
    log_payloads: bool = False

    @classmethod
    def from_dict(cls, raw: Mapping[str, Any]) -> "LoggingConfig":
        return cls(
            level=_as_str(raw.get("level"), "INFO").upper(),
            log_payloads=_as_bool(raw.get("log_payloads"), False),
        )


@dataclass(frozen=True)
class QQGatewayConfig:
    enabled: bool = False
    mode: str = "lifespan"
    account: AccountConfig = field(default_factory=AccountConfig)
    connection: ConnectionConfig = field(default_factory=ConnectionConfig)
    inbound: InboundConfig = field(default_factory=InboundConfig)
    outbound: OutboundConfig = field(default_factory=OutboundConfig)
    forward: ForwardConfig = field(default_factory=ForwardConfig)
    media: MediaConfig = field(default_factory=MediaConfig)
    delivery: DeliveryConfig = field(default_factory=DeliveryConfig)
    qzone: QZoneConfig = field(default_factory=QZoneConfig)
    mcp: MCPConfig = field(default_factory=MCPConfig)
    logging: LoggingConfig = field(default_factory=LoggingConfig)

    @classmethod
    def from_dict(cls, raw: Mapping[str, Any]) -> "QQGatewayConfig":
        mode = _as_str(raw.get("mode"), "lifespan").lower()
        if mode not in {"lifespan", "subprocess", "external"}:
            mode = "lifespan"
        return cls(
            enabled=_as_bool(raw.get("enabled"), False),
            mode=mode,
            account=AccountConfig.from_dict(_section(raw, "account")),
            connection=ConnectionConfig.from_dict(_section(raw, "connection")),
            inbound=InboundConfig.from_dict(_section(raw, "inbound")),
            outbound=OutboundConfig.from_dict(_section(raw, "outbound")),
            forward=ForwardConfig.from_dict(_section(raw, "forward")),
            media=MediaConfig.from_dict(_section(raw, "media")),
            delivery=DeliveryConfig.from_dict(_section(raw, "delivery")),
            qzone=QZoneConfig.from_dict(_section(raw, "qzone")),
            mcp=MCPConfig.from_dict(_section(raw, "mcp")),
            logging=LoggingConfig.from_dict(_section(raw, "logging")),
        )

    @classmethod
    def load(cls) -> "QQGatewayConfig":
        from config.config import get_config

        raw = getattr(get_config(), "QQ_GATEWAY", {}) or {}
        return cls.from_dict(raw)

    def validate(self) -> list[str]:
        if not self.enabled:
            return []
        problems: list[str] = []
        if self.enabled and not self.account.ws_url:
            problems.append("qq_gateway.account.ws_url is empty")
        if self.enabled and not self.account.ws_token:
            problems.append("qq_gateway.account.ws_token is empty")
        if self.inbound.groups and not self.inbound.group_allowlist:
            problems.append("qq_gateway.inbound.groups=true requires group_allowlist")
        if self.outbound.groups and not self.outbound.group_allowlist:
            problems.append("qq_gateway.outbound.groups=true requires group_allowlist")
        if self.mcp.enabled and not self.mcp.token:
            problems.append("qq_gateway.mcp.enabled=true requires token/token_file")
        if self.qzone.enabled and self.qzone.mode == "off":
            problems.append("qq_gateway.qzone.enabled=true requires a non-off mode")
        if self.qzone.mode == "http_sidecar" and not self.qzone.allow_read:
            problems.append("qzone.mode=http_sidecar requires allow_read=true")
        return problems


def _read_secret(path: str) -> str:
    try:
        return Path(path).read_text(encoding="utf-8").strip()
    except OSError:
        return ""
