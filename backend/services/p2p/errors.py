from __future__ import annotations


class P2PError(Exception):
    """P2P 业务错误基类。"""


class P2PDisabledError(P2PError):
    pass


class P2PValidationError(P2PError):
    pass


class P2PAccessError(P2PError):
    pass


class P2PUnavailableError(P2PError):
    pass
