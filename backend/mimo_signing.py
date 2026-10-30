# -*- coding: utf-8 -*-
"""MiMo 音频签名 URL 工具

为 /api/mimo/audio/{filename} 提供短 TTL 签名 URL，替代"仅靠随机文件名保密"
的免认证模式。URL 形如:

    /api/mimo/audio/{filename}?exp=<unix秒>&sig=<hmac-sha256>

- exp: 过期时间戳（秒）
- sig: HMAC-SHA256(secret, f"{filename}|{exp}") 的十六进制

调用方（AI 分析脚本）在进程内导入本模块生成签名路径；播放方（MiMo）
直接用签名 URL 拉取，无需携带 token。签名密钥从 backend/config/auth.json
中的 service token（优先）或用户密码哈希派生，不新增独立密钥配置。
"""
import hashlib
import hmac
import json
import os
import time

# 签名有效期（秒）：音频供 MiMo 立即拉取，300s 足够
MIMO_AUDIO_TTL = 300

# 音频访问路径前缀（与 main.py 注册前缀 /api + 路由 /mimo/audio 一致）
MIMO_AUDIO_PREFIX = "/api/mimo/audio/"

_AUTH_JSON = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config", "auth.json")


def _signing_secret() -> bytes:
    """派生签名密钥（稳定，不随登录 token 增删变化）。

    优先使用 auth.json 中的 service token（后端已有的长期随机 secret），
    其次使用全部用户的密码哈希；二者都不可用时回退到固定串（仅首次安装、
    尚无任何凭据时可达，此时 MiMo 音频链路本也不可用）。
    """
    material = ""
    try:
        with open(_AUTH_JSON, "r", encoding="utf-8") as f:
            data = json.load(f)
        for tok, info in (data.get("tokens") or {}).items():
            if isinstance(info, dict) and info.get("kind") == "service":
                material = tok
                break
        if not material:
            users = data.get("users") or {}
            parts = []
            for name, info in sorted(users.items()):
                ph = info.get("password_hash", "") if isinstance(info, dict) else str(info)
                parts.append("%s:%s" % (name, ph))
            material = "|".join(parts)
    except Exception:
        material = ""
    if not material:
        material = "axeuh-mimo-audio-fallback"
    return hashlib.sha256(("axeuh-mimo-url-v1:" + material).encode("utf-8")).digest()


def _sign(filename: str, exp: int) -> str:
    """对 filename + exp 生成 HMAC-SHA256 十六进制签名。"""
    msg = ("%s|%d" % (filename, exp)).encode("utf-8")
    return hmac.new(_signing_secret(), msg, hashlib.sha256).hexdigest()


def build_signed_path(filename: str, ttl: int = MIMO_AUDIO_TTL, now: float | None = None) -> str:
    """生成带签名的音频访问路径（不含 host），供 MiMo 直接拉取。"""
    exp = int((now if now is not None else time.time()) + max(1, int(ttl)))
    return "%s%s?exp=%d&sig=%s" % (MIMO_AUDIO_PREFIX, filename, exp, _sign(filename, exp))


def verify_signed_params(
    filename: str,
    exp: str | int | None,
    sig: str | None,
    now: float | None = None,
) -> str:
    """校验签名与有效期。

    返回空串 "" 表示有效；否则返回拒绝原因:
      - "invalid": 参数缺失/签名不匹配
      - "expired": 签名有效但已过期
    """
    if exp is None:
        return "invalid"
    try:
        exp_int = int(exp)
    except (TypeError, ValueError):
        return "invalid"
    if not sig:
        return "invalid"
    expected = _sign(filename, exp_int)
    try:
        matched = hmac.compare_digest(str(sig), expected)
    except (TypeError, ValueError):
        matched = False
    if not matched:
        return "invalid"
    if (now if now is not None else time.time()) > exp_int:
        return "expired"
    return ""
