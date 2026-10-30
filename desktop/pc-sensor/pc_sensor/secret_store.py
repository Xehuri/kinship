# -*- coding: utf-8 -*-
"""Windows DPAPI 加解密（CryptProtectData / CryptUnprotectData）。

用于在本机安全持久化后端登录密码：密文与当前 Windows 用户的登录凭据绑定，
只有同一用户在同一台机器上才能解开；换 Windows 账户或换机器都会解密失败，
此时调用方应回退为「要求手动输入密码」，绝不会因此崩溃。

设计取舍（PC-M8）：
- 直接 ctypes 调用 crypt32.dll，不引入 pywin32 等第三方加密依赖；
- 仅加密，不参与业务逻辑；非 Windows 平台整体不可用（返回 None）。

安全说明：
- 密文以 base64 文本写入 pc_sensor_config.json，即使文件被拷走，
  在其它账户/机器上也无法还原明文；
- 密码明文始终不落盘。
"""

import base64
import ctypes
import logging
import sys
from ctypes import wintypes
from functools import lru_cache
from typing import Optional

logger = logging.getLogger("pc_sensor.secret_store")

# CRYPTPROTECT_UI_FORBIDDEN：禁止弹任何 UI。
# 托盘进程为静默后台运行，一旦弹窗会卡死且无人可点，必须置位。
_UI_FORBIDDEN = 0x1


class _DataBlob(ctypes.Structure):
    """DPAPI 的 DATA_BLOB 结构。"""

    _fields_ = [
        ("cbData", wintypes.DWORD),
        ("pbData", ctypes.POINTER(ctypes.c_char)),
    ]


def _is_supported() -> bool:
    """当前环境是否支持 DPAPI（Windows 且 crypt32 可加载）。"""
    if sys.platform != "win32":
        return False
    try:
        ctypes.WinDLL("crypt32.dll")
        return True
    except (OSError, AttributeError):
        return False


# 导入期求值一次，供调用方（配置接口 / 配置页）判断是否展示"记住密码"
SUPPORTED = _is_supported()


@lru_cache(maxsize=1)
def _crypt32():
    """惰性加载并配置 crypt32 函数签名（仅 Windows 可用）。"""
    lib = ctypes.WinDLL("crypt32.dll", use_last_error=True)
    lib.CryptProtectData.argtypes = [
        ctypes.POINTER(_DataBlob),   # pDataIn
        wintypes.LPCWSTR,            # szDataDescr
        ctypes.POINTER(_DataBlob),   # pOptionalEntropy
        ctypes.c_void_p,             # pvReserved
        ctypes.c_void_p,             # pPromptStruct
        wintypes.DWORD,              # dwFlags
        ctypes.POINTER(_DataBlob),   # pDataOut
    ]
    lib.CryptProtectData.restype = wintypes.BOOL
    lib.CryptUnprotectData.argtypes = [
        ctypes.POINTER(_DataBlob),   # pDataIn
        ctypes.POINTER(wintypes.LPWSTR),  # ppszDataDescr（可空）
        ctypes.POINTER(_DataBlob),   # pOptionalEntropy
        ctypes.c_void_p,             # pvReserved
        ctypes.c_void_p,             # pPromptStruct
        wintypes.DWORD,              # dwFlags
        ctypes.POINTER(_DataBlob),   # pDataOut
    ]
    lib.CryptUnprotectData.restype = wintypes.BOOL
    return lib


def _free_blob(blob: _DataBlob) -> None:
    """释放 DPAPI 分配的输出缓冲（失败静默，不掩盖主流程）。"""
    if blob.pbData:
        try:
            ctypes.windll.kernel32.LocalFree(ctypes.cast(blob.pbData, ctypes.c_void_p))
        except Exception:  # noqa: BLE001 - 释放失败不应影响调用方
            pass


def is_available() -> bool:
    """DPAPI 是否可用。"""
    return SUPPORTED


def protect(plaintext: str) -> Optional[str]:
    """加密字符串，返回 base64 密文；平台不支持或失败时返回 None。"""
    if not SUPPORTED or plaintext is None or plaintext == "":
        return None
    try:
        data = plaintext.encode("utf-8")
        buf = ctypes.create_string_buffer(data, len(data))  # 持有引用防止被回收
        blob_in = _DataBlob(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))
        blob_out = _DataBlob()

        ok = _crypt32().CryptProtectData(
            ctypes.byref(blob_in),
            None,           # 描述文本（可选）
            None,           # 附加熵（可选）
            None,           # 保留
            None,           # 提示结构
            _UI_FORBIDDEN,  # 禁止 UI
            ctypes.byref(blob_out),
        )
        if not ok:
            logger.warning("DPAPI 加密失败（ErrorCode=%s）", ctypes.get_last_error())
            return None
        try:
            raw = ctypes.string_at(blob_out.pbData, blob_out.cbData)
        finally:
            _free_blob(blob_out)
        return base64.b64encode(raw).decode("ascii")
    except Exception as e:  # noqa: BLE001 - 加密失败只降级为"不记住"，不抛出
        logger.warning("DPAPI 加密异常: %s", e)
        return None


def unprotect(blob_b64: str) -> Optional[str]:
    """解密 protect() 产出的 base64 密文；失败（换账户/换机器/数据损坏）返回 None。"""
    if not SUPPORTED or not blob_b64:
        return None
    try:
        raw = base64.b64decode(blob_b64)
        if not raw:
            return None
        buf = ctypes.create_string_buffer(raw, len(raw))
        blob_in = _DataBlob(len(raw), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))
        blob_out = _DataBlob()

        ok = _crypt32().CryptUnprotectData(
            ctypes.byref(blob_in),
            None,           # 不接受描述输出
            None,           # 附加熵（需与加密时一致，此处均为空）
            None,           # 保留
            None,           # 提示结构
            _UI_FORBIDDEN,  # 禁止 UI
            ctypes.byref(blob_out),
        )
        if not ok:
            logger.warning("DPAPI 解密失败（ErrorCode=%s），可能更换了 Windows 账户或机器", ctypes.get_last_error())
            return None
        try:
            data = ctypes.string_at(blob_out.pbData, blob_out.cbData)
        finally:
            _free_blob(blob_out)
        return data.decode("utf-8")
    except Exception as e:  # noqa: BLE001 - 解密失败一律降级为"需重新输入"
        logger.warning("DPAPI 解密异常: %s", e)
        return None
