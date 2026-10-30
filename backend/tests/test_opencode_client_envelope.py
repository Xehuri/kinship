# -*- coding: utf-8 -*-
"""OpenCode 信封公共层单测 - 覆盖 mock 模式和统一错误格式。

V6 拍扁（原网关测试文件的 13 条用例逐断言改指
services.opencode_client 信封公共层，覆盖不净删）：
信封方法现落在 OpenCodeClient 实例上，三级栈压成两级。
本 venv 无 pytest-asyncio，统一以 asyncio.run 同步驱动。
"""
import asyncio
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from config.config import get_config
import services.opencode_client as oc


def _set_mock(enabled: bool):
    cfg = get_config()
    cfg._data.setdefault('features', {})['opencode_mock_enabled'] = enabled


class TestClientEnvelopeMockMode:
    """测试 mock 模式下信封公共层"""

    def setup_method(self):
        _set_mock(True)
        self.client = oc.OpenCodeClient()

    def teardown_method(self):
        _set_mock(False)

    def test_singleton(self, monkeypatch):
        # 桩掉端口探测：零触网验证同步工厂单例语义（原 gateway 单测同义）
        monkeypatch.setattr(
            oc, "discover_opencode_url",
            lambda max_offset=10: "http://127.0.0.1:5096",
        )
        oc._reset_opencode_client()
        try:
            g1, g2 = oc.get_opencode_client(), oc.get_opencode_client()
            assert g1 is g2
        finally:
            oc._reset_opencode_client()

    def test_health_check(self):
        r = asyncio.run(self.client.health_check())
        assert r['ok'] is True
        assert r['data']['status'] == 'mock'

    def test_create_session(self):
        r = asyncio.run(self.client.create_session(title='test'))
        assert r['ok'] is True
        assert 'mock_' in r['data']['session_id']

    def test_list_sessions(self):
        r = asyncio.run(self.client.list_sessions())
        assert r['ok'] is True
        assert 'sessions' in r['data']

    def test_send_message(self):
        r = asyncio.run(self.client.send_message(session_id='s1', message='hello'))
        assert r['ok'] is True and r['data']['sent'] is True

    def test_abort_session(self):
        r = asyncio.run(self.client.abort_session(session_id='s1'))
        assert r['ok'] is True and r['data']['aborted'] is True

    def test_get_session_status(self):
        r = asyncio.run(self.client.get_session_status(session_id='s1'))
        assert r['ok'] is True

    def test_get_available_models(self):
        r = asyncio.run(self.client.get_available_models())
        assert r['ok'] is True
        assert 'providers' in r['data']

    def test_get_active_sessions(self):
        r = asyncio.run(self.client.get_active_sessions())
        assert r['ok'] is True
        assert 'active_sessions' in r['data']

    def test_default_config(self):
        gw = self.client
        assert isinstance(gw.get_default_model(), str)
        assert isinstance(gw.get_default_provider(), str)

    def test_error_format(self):
        r = asyncio.run(self.client.health_check())
        assert set(r.keys()) == {'ok', 'data', 'error'}
        assert r['error'] is None or r['error']['source'] == 'mock'

    def test_summarize_session_mock(self):
        r = asyncio.run(self.client.summarize_session(session_id='s1'))
        assert r['ok'] is True
        assert r['data']['compacted'] is True
        assert r['data']['mock'] is True


class TestClientEnvelopeOnlineMode:
    """测试 online 模式（OpenCode 不可用时优雅降级）"""

    def setup_method(self):
        _set_mock(False)

    def test_health_check_offline(self):
        """online 模式但 OpenCode 未运行，返回 offline 状态"""
        # 显式必拒端口，跳过真实端口探测，零触网
        client = oc.OpenCodeClient(base_url="http://127.0.0.1:1")
        r = asyncio.run(client.health_check())
        assert r['ok'] is True
        assert r['data']['status'] in ('online', 'offline')
