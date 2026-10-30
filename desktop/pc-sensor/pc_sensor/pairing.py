# -*- coding: utf-8 -*-
"""配对码换取设备 Token（POST /api/p2p/enroll）。

配对码为 8 位数字、5 分钟有效且单次使用；成功后后端返回设备 Token 与
signal_url/endpoints。本模块只负责网络交换与响应校验，不落盘、不记录
配对码或 Token。仅使用标准库 urllib。
"""

import json
import logging
import sys
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin
from urllib.request import Request, urlopen

from .transport import CandidateError, build_ssl_context, normalize_candidates

logger = logging.getLogger("pc_sensor.pairing")


class PairingError(ValueError):
    """配对失败（消息可安全展示给用户，不含凭据）。"""


def detect_platform() -> str:
    """返回后端可识别的平台标识。"""
    if sys.platform == "win32":
        return "windows"
    if sys.platform == "darwin":
        return "macos"
    return "linux"


def candidates_from_endpoints(endpoints: object) -> list[dict]:
    """把配对响应的 endpoints 转为规范化的端点候选（非法项忽略）。"""
    try:
        return normalize_candidates(endpoints)
    except CandidateError as e:
        logger.warning("配对响应的 endpoints 无效，已忽略: %s", e)
        return []


def enroll(
    server_url: str,
    pairing_code: str,
    device_id: str,
    device_name: str,
    platform: str,
    ssl_verify: bool = True,
    ssl_ca_file: str = "",
    timeout: float = 10.0,
    opener=None,
) -> dict[str, Any]:
    """用配对码换取设备 Token。

    成功返回后端 JSON；缺少 device_token 或 signal_url 时抛 PairingError。
    配对码与返回的 Token 都不会写入日志。
    """
    base_url = str(server_url or "").strip().rstrip("/")
    if not base_url:
        raise PairingError("服务器地址未配置")

    code = str(pairing_code or "").strip()
    if len(code) != 8 or not code.isdigit():
        raise PairingError("配对码应为 8 位数字")

    payload = json.dumps(
        {
            "pairing_code": code,
            "device_id": str(device_id or "").strip(),
            "device_name": str(device_name or "").strip(),
            "platform": str(platform or "").strip(),
        },
        ensure_ascii=False,
    ).encode("utf-8")
    req = Request(
        urljoin(base_url, "/api/p2p/enroll"),
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    send = opener or urlopen
    try:
        with send(
            req,
            timeout=timeout,
            context=build_ssl_context(ssl_verify, ssl_ca_file),
        ) as resp:
            raw = resp.read()
    except HTTPError as e:
        raise PairingError(f"配对失败（HTTP {e.code}）") from None
    except URLError as e:
        raise PairingError(f"无法连接服务器：{getattr(e, 'reason', e)}") from None
    except Exception as e:  # noqa: BLE001 - 网络层异常统一转为可展示错误
        raise PairingError(f"配对请求异常：{e}") from None

    try:
        body = json.loads(raw or b"{}")
    except (TypeError, ValueError):
        raise PairingError("服务器返回的不是有效 JSON") from None
    if not isinstance(body, dict):
        raise PairingError("服务器返回格式无效")

    device_token = str(body.get("device_token") or "").strip()
    signal_url = str(body.get("signal_url") or "").strip()
    if not device_token:
        raise PairingError("配对响应缺少 device_token")
    if not signal_url:
        raise PairingError("配对响应缺少 signal_url")

    logger.info("配对成功（device_id=%s）", str(body.get("device_id") or device_id))
    return body
