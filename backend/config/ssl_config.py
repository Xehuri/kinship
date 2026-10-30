"""
SSL证书配置 - 所有服务统一从此文件读取证书路径

集中管理证书路径，避免各文件分散硬编码。
其他模块通过 `from config.ssl_config import SSL_CERT, SSL_KEY` 导入。
现在从 config.py 统一读取，避免硬编码。
"""
from config.config import get_config

_config = get_config()
SSL_CERT = _config.SSL_CERT
SSL_KEY = _config.SSL_KEY
