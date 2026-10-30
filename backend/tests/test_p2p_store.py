# -*- coding: utf-8 -*-
"""设备注册表与配对码存储。"""
import json
import os
import re
import stat

import pytest

from services.p2p.store import DeviceStore, PairingCodes


class FakeClock:
    def __init__(self, now=1_700_000_000.0):
        self.now = now

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


def test_register_persists_atomically_with_0600(tmp_path):
    clock = FakeClock()
    path = tmp_path / "p2p" / "devices.json"
    store = DeviceStore(str(path), clock=clock)

    record = store.register("phone-1", "Phone", "android", "Axeuh", "fingerprint")

    assert record.device_id == "phone-1"
    assert record.created_at == int(clock.now)
    assert record.last_seen == int(clock.now)
    assert record.revoked_at is None
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
    payload = json.loads(path.read_text(encoding="utf-8"))
    assert payload["version"] == 1
    assert payload["devices"]["phone-1"]["token_fingerprint"] == "fingerprint"


def test_store_reloads_from_disk(tmp_path):
    clock = FakeClock()
    path = tmp_path / "devices.json"
    DeviceStore(str(path), clock=clock).register(
        "phone-1", "Phone", "android", "Axeuh", "fp"
    )

    reloaded = DeviceStore(str(path), clock=clock).get("phone-1")

    assert reloaded is not None
    assert reloaded.user_id == "Axeuh"
    assert reloaded.token_fingerprint == "fp"


def test_touch_and_revoke(tmp_path):
    clock = FakeClock()
    store = DeviceStore(str(tmp_path / "devices.json"), clock=clock)
    store.register("phone-1", "Phone", "android", "Axeuh")

    clock.advance(60)
    store.touch("phone-1")
    assert store.get("phone-1").last_seen == int(clock.now)
    assert store.is_revoked("phone-1") is False

    clock.advance(60)
    assert store.revoke("phone-1") is True
    record = store.get("phone-1")
    assert record.revoked_at == int(clock.now)
    assert store.is_revoked("phone-1") is True
    assert store.revoke("missing") is False


def test_list_filters_by_user_and_sorts(tmp_path):
    clock = FakeClock()
    store = DeviceStore(str(tmp_path / "devices.json"), clock=clock)
    clock.advance(2)
    store.register("phone-1", "Phone", "android", "Axeuh")
    clock.advance(2)
    store.register("laptop-1", "Laptop", "windows", "Axeuh")
    clock.advance(2)
    store.register("other-1", "Other", "android", "Other")

    assert [record.device_id for record in store.list("Axeuh")] == [
        "phone-1",
        "laptop-1",
    ]
    assert len(store.list()) == 3


def test_register_accepts_max_length_device_id(tmp_path):
    store = DeviceStore(str(tmp_path / "devices.json"))
    device_id = "a" * 64

    record = store.register(device_id, "Phone", "android", "Axeuh")

    assert record.device_id == device_id


def test_register_rejects_device_id_longer_than_64(tmp_path):
    store = DeviceStore(str(tmp_path / "devices.json"))

    with pytest.raises(ValueError):
        store.register("a" * 65, "Phone", "android", "Axeuh")


def test_register_clears_revocation_and_rejects_bad_device_id(tmp_path):
    store = DeviceStore(str(tmp_path / "devices.json"))
    store.register("phone-1", "Phone", "android", "Axeuh")
    store.revoke("phone-1")

    store.register("phone-1", "Phone 2", "android", "Axeuh")

    assert store.is_revoked("phone-1") is False
    with pytest.raises(ValueError):
        store.register("bad id", "x", "x", "Axeuh")


def test_pairing_code_is_eight_digits_and_single_use(tmp_path):
    clock = FakeClock()
    codes = PairingCodes(ttl_seconds=300, max_attempts=5, clock=clock)

    code, expires_at = codes.issue("Axeuh")

    assert re.fullmatch(r"\d{8}", code)
    assert expires_at == int(clock.now) + 300
    assert codes.consume(code, "phone-1") == "Axeuh"
    assert codes.consume(code, "phone-1") is None


def test_pairing_code_expires(tmp_path):
    clock = FakeClock()
    codes = PairingCodes(ttl_seconds=300, clock=clock)
    code, _expires_at = codes.issue("Axeuh")

    clock.advance(301)

    assert codes.consume(code, "phone-1") is None


def test_pairing_code_attempt_limit():
    clock = FakeClock()
    codes = PairingCodes(ttl_seconds=300, max_attempts=5, clock=clock)
    code, _expires_at = codes.issue("Axeuh")

    for _ in range(5):
        assert codes.consume(code, "bad id") is None
    assert len(codes) == 1
    assert codes.consume(code, "bad id") is None
    assert len(codes) == 0


def test_pairing_codes_are_unique():
    codes = PairingCodes()
    issued = {codes.issue("Axeuh")[0] for _ in range(50)}
    assert len(issued) == 50
