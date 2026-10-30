from __future__ import annotations

import asyncio
import tempfile
from pathlib import Path

from services.qq_gateway.store import EventStore


def test_store_dedupe_and_restart() -> None:
    async def scenario() -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = str(Path(tmp) / "events.db")
            store = EventStore(path)
            first = await store.enqueue_event(
                account="1", kind="message", chat_type="private", target="2",
                message_id="m1", dedupe_key="msg:1:private:2:m1",
                text="hello", payload={"message_id": "m1"},
            )
            second = await store.enqueue_event(
                account="1", kind="message", chat_type="private", target="2",
                message_id="m1", dedupe_key="msg:1:private:2:m1",
                text="hello", payload={"message_id": "m1"},
            )
            assert first is True
            assert second is False
            rows = await store.claim_deliveries(10)
            assert len(rows) == 1
            await store.mark_retry(rows[0]["id"], "boom", 0.0, 2)
            assert (await store.counts())["pending"] == 1
            await store.mark_retry(rows[0]["id"], "boom", 0.0, 2)
            assert (await store.counts())["pending"] == 0
            assert (await store.counts())["dead"] == 1
            await store.record_action("e1", "send_private_msg", "hash")
            await store.finish_action("e1", "ok", {"message_id": "x"})
            row = await store.get_action("e1")
            assert row["state"] == "ok"
            store.close()
            reopened = EventStore(path)
            assert (await reopened.counts())["actions"] == 1
            reopened.close()

    asyncio.run(scenario())


def test_store_cursor_roundtrip_and_restart() -> None:
    async def scenario() -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = str(Path(tmp) / "events.db")
            store = EventStore(path)
            assert await store.get_cursor("default", "group", "10003") is None
            await store.set_cursor("default", "group", "10003", 1700000000.0, "42")
            store.close()
            reopened = EventStore(path)
            assert await reopened.get_cursor("default", "group", "10003") == {
                "last_time": 1700000000.0,
                "last_message_id": "42",
            }
            assert await reopened.get_cursor("default", "friend", "12345") is None
            reopened.close()

    asyncio.run(scenario())


def test_water_state_missing_group_and_partial_upsert() -> None:
    async def scenario() -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = EventStore(str(Path(tmp) / "events.db"))
            assert await store.get_water_state("g-missing") is None

            created = await store.upsert_water_state("g1", mode="water", threshold=8)
            assert created["group_id"] == "g1"
            assert created["mode"] == "water"
            assert created["threshold"] == 8
            assert created["water_until"] == 0
            assert created["last_wake_at"] == 0
            assert created["updated_at"] > 0

            woken = await store.upsert_water_state("g1", last_wake_at=1700000000.5)
            assert woken["group_id"] == "g1"
            assert woken["mode"] == "water"
            assert woken["threshold"] == 8
            assert woken["water_until"] == 0
            assert woken["last_wake_at"] == 1700000000.5

            expiring = await store.upsert_water_state("g1", water_until=1800000000.0)
            assert expiring["mode"] == "water"
            assert expiring["threshold"] == 8
            assert expiring["last_wake_at"] == 1700000000.5
            assert expiring["water_until"] == 1800000000.0
            store.close()

    asyncio.run(scenario())


def test_water_state_list_and_restart() -> None:
    async def scenario() -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = str(Path(tmp) / "events.db")
            store = EventStore(path)
            assert await store.list_water_states() == []

            await store.upsert_water_state("g2", mode="mute")
            await store.upsert_water_state("g1", threshold=0, water_until=1800000000.0)
            rows = await store.list_water_states()
            assert [row["group_id"] for row in rows] == ["g1", "g2"]
            assert rows[0]["mode"] == "mentions"
            assert rows[0]["threshold"] == 0
            assert rows[1]["mode"] == "mute"
            assert rows[1]["threshold"] == 12
            store.close()

            reopened = EventStore(path)
            persisted = await reopened.get_water_state("g1")
            assert persisted is not None
            assert persisted["updated_at"] > 0
            assert {
                key: persisted[key]
                for key in ("group_id", "mode", "threshold", "water_until", "last_wake_at")
            } == {
                "group_id": "g1",
                "mode": "mentions",
                "threshold": 0,
                "water_until": 1800000000.0,
                "last_wake_at": 0,
            }
            reopened.close()

    asyncio.run(scenario())
