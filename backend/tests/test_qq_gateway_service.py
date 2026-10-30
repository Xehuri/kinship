from __future__ import annotations

import asyncio
import tempfile
import time
from pathlib import Path

from services.qq_gateway.config import QQGatewayConfig
from services.qq_gateway.service import QQGatewayService
from tests.qq_gateway_fixtures.fake_napcat import FakeNapCat


def test_service_delivers_private_message_once() -> None:
    async def scenario() -> None:
        fake = FakeNapCat()
        await fake.start()
        delivered: list[dict] = []

        async def send(row: dict) -> bool:
            delivered.append(row)
            return True

        with tempfile.TemporaryDirectory() as tmp:
            raw = {
                "enabled": True,
                "account": {
                    "self_qq": "100",
                    "peer_allowlist": ["200"],
                    "ws_url": fake.url,
                    "ws_token": "test-token",
                },
                "connection": {"action_timeout_sec": 1.0},
                "inbound": {"private": True, "deliver": True},
                "outbound": {"enabled": True},
                "media": {"dir": str(Path(tmp) / "media")},
                "delivery": {"session": "main-task", "max_retries": 2, "retry_backoff_sec": 1},
                "mcp": {"enabled": False},
            }
            service = QQGatewayService(QQGatewayConfig.from_dict(raw), send=send)
            await service.start()
            deadline = time.monotonic() + 3
            while not service.transport.connected and time.monotonic() < deadline:
                await asyncio.sleep(0.02)
            assert service.transport.connected
            assert service.qzone is not None
            assert service.ipc.qzone is service.qzone
            event = {
                "post_type": "message",
                "message_type": "private",
                "self_id": 100,
                "message_id": 42,
                "time": 1700000000,
                "sender": {"user_id": 200, "nickname": "tester"},
                "message": [{"type": "text", "data": {"text": "hello gateway"}}],
            }
            await fake.broadcast(event)
            deadline = time.monotonic() + 3
            while not delivered and time.monotonic() < deadline:
                await asyncio.sleep(0.05)
            assert delivered, "message was not delivered"
            assert "hello gateway" in delivered[0]["text"]
            assert delivered[0]["dedupe_key"] == "msg:100:private:200:42"
            health = service.health()
            assert health["stats"]["messages_seen"] == 1
            assert health["stats"]["events_queued"] == 1
            qzone = health["qzone"]
            assert qzone["enabled"] is False
            assert qzone["mode"] == "off"
            assert qzone["read"] is False
            assert qzone["send"] is False
            assert qzone["write_limit_per_hour"] == 5
            await fake.broadcast(event)
            await asyncio.sleep(0.3)
            assert len(delivered) == 1
            await service.stop()
            assert service.qzone._closed is True
            await service.qzone.close()
            await service.qzone.close()
        await fake.stop()

    asyncio.run(scenario())
