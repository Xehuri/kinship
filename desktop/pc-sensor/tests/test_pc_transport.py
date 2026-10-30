# -*- coding: utf-8 -*-
"""Windows Phase 1：多端点健康探测、优先级、缓存与配置校验。"""

import json
import ssl
from urllib.error import URLError

import pytest

from pc_sensor.manager import SensorManager
from pc_sensor.transport import (
    CandidateError,
    EndpointCandidate,
    TransportSelector,
    normalize_candidates,
)


class _FakeResponse:
    def __init__(self, status: int = 200):
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def _selector_with_probe(monkeypatch, unhealthy_host: str = "") -> tuple[TransportSelector, list[str]]:
    calls: list[str] = []

    def fake_urlopen(req, timeout=None, context=None):
        calls.append(req.full_url)
        if unhealthy_host and unhealthy_host in req.full_url:
            raise URLError("unreachable")
        return _FakeResponse(200)

    monkeypatch.setattr("pc_sensor.transport.urlopen", fake_urlopen)
    selector = TransportSelector(
        [
            EndpointCandidate("frp", "https://frp.example:8768", 90),
            EndpointCandidate("ipv6", "https://home.example:23443", 10),
        ]
    )
    return selector, calls


def test_select_prefers_ipv6_before_frp(monkeypatch):
    selector, calls = _selector_with_probe(monkeypatch)

    assert selector.select() == "https://home.example:23443"
    assert calls == ["https://home.example:23443/health"]


def test_explicit_server_url_candidate_is_probed_first(monkeypatch):
    calls: list[str] = []

    def fake_urlopen(req, timeout=None, context=None):
        calls.append(req.full_url)
        return _FakeResponse(200)

    monkeypatch.setattr("pc_sensor.transport.urlopen", fake_urlopen)
    selector = TransportSelector(
        [
            EndpointCandidate("frp", "https://frp.example:8768", 90),
            EndpointCandidate("ipv6", "https://home.example:23443", 10),
        ],
        fallback_url="https://frp.example:8768",
    )

    assert selector.current_url == "https://frp.example:8768"
    assert selector.select() == "https://frp.example:8768"
    assert calls == ["https://frp.example:8768/health"]


def test_select_falls_back_when_first_candidate_unhealthy(monkeypatch):
    selector, calls = _selector_with_probe(monkeypatch, unhealthy_host="home.example")

    assert selector.select() == "https://frp.example:8768"
    assert calls == [
        "https://home.example:23443/health",
        "https://frp.example:8768/health",
    ]


def test_select_caches_winner_for_ttl_and_force_bypasses(monkeypatch):
    clock = {"now": 100.0}
    selector, calls = _selector_with_probe(monkeypatch)
    selector._clock = lambda: clock["now"]

    assert selector.select() == "https://home.example:23443"
    assert selector.select() == "https://home.example:23443"
    assert len(calls) == 1

    clock["now"] += 301
    assert selector.select() == "https://home.example:23443"
    assert len(calls) == 2

    assert selector.select(force=True) == "https://home.example:23443"
    assert len(calls) == 3


def test_select_keeps_last_successful_url_when_all_probes_fail(monkeypatch):
    state = {"healthy": True}
    calls: list[str] = []

    def fake_urlopen(req, timeout=None, context=None):
        calls.append(req.full_url)
        if not state["healthy"]:
            raise URLError("unreachable")
        return _FakeResponse(200)

    monkeypatch.setattr("pc_sensor.transport.urlopen", fake_urlopen)
    selector = TransportSelector(
        [
            EndpointCandidate("frp", "https://frp.example:8768", 90),
            EndpointCandidate("ipv6", "https://home.example:23443", 10),
        ],
        fallback_url="https://fallback.example:8768",
        clock=lambda: 100.0,
    )

    assert selector.select() == "https://home.example:23443"
    state["healthy"] = False
    calls.clear()

    assert selector.select(force=True) == "https://home.example:23443"
    assert calls == [
        "https://home.example:23443/health",
        "https://frp.example:8768/health",
    ]
    assert selector.current_url == "https://home.example:23443"


def test_no_candidates_uses_existing_server_url_without_probe(monkeypatch):
    def fail_probe(*args, **kwargs):
        raise AssertionError("没有候选端点时不应发起健康探测")

    monkeypatch.setattr("pc_sensor.transport.urlopen", fail_probe)
    selector = TransportSelector([], fallback_url="https://legacy.example:8768/")

    assert selector.current_url == "https://legacy.example:8768"
    assert selector.select() == "https://legacy.example:8768"


def test_probe_uses_selector_ssl_context_and_short_timeout(monkeypatch):
    captured: dict = {}

    def fake_urlopen(req, timeout=None, context=None):
        captured["context"] = context
        captured["timeout"] = timeout
        return _FakeResponse(200)

    monkeypatch.setattr("pc_sensor.transport.urlopen", fake_urlopen)
    selector = TransportSelector(
        [EndpointCandidate("ipv6", "https://home.example:23443", 10)],
        ssl_verify=False,
        ssl_ca_file="",
    )

    selector.select()

    assert captured["context"] is selector.ssl_context
    assert captured["context"].verify_mode == ssl.CERT_NONE
    assert 1.5 <= captured["timeout"] <= 2.5


def test_default_tls_context_verifies_certificates():
    selector = TransportSelector([EndpointCandidate("frp", "https://frp.example:8768", 90)])
    assert selector.ssl_context.verify_mode == ssl.CERT_REQUIRED


def test_normalize_candidates_accepts_dict_and_prefers_ipv6():
    normalized = normalize_candidates(
        {"frp": "https://frp.example:8768", "ipv6": "https://home.example:23443"}
    )

    assert [entry["name"] for entry in normalized] == ["ipv6", "frp"]
    assert normalized[0]["priority"] < normalized[1]["priority"]


def test_normalize_candidates_accepts_list_with_explicit_priority():
    normalized = normalize_candidates(
        [
            {"name": "frp", "url": "https://frp.example:8768", "priority": 1},
            {"name": "ipv6", "url": "https://home.example:23443", "priority": 5},
        ]
    )

    assert [entry["name"] for entry in normalized] == ["frp", "ipv6"]


@pytest.mark.parametrize(
    "entry",
    [
        {"name": "lan", "url": "ftp://192.168.1.2:8769"},
        {"name": "lan", "url": "http://192.168.1.2:8769"},
        {"name": "bad", "url": "https://"},
    ],
)
def test_normalize_candidates_rejects_invalid_urls(entry):
    with pytest.raises(CandidateError):
        normalize_candidates([entry])


@pytest.mark.parametrize(
    "url",
    ["http://localhost:8769", "http://127.0.0.1:8769", "http://[::1]:8769"],
)
def test_normalize_candidates_allows_loopback_http(url):
    normalized = normalize_candidates([{"name": "lan", "url": url}])
    assert normalized[0]["url"] == url


def test_manager_update_config_normalizes_candidates_and_selects(tmp_path, monkeypatch):
    def unreachable(*args, **kwargs):
        raise URLError("unreachable")

    monkeypatch.setattr("pc_sensor.transport.urlopen", unreachable)
    cfg_path = tmp_path / "pc_sensor_config.json"
    manager = SensorManager(config_path=str(cfg_path))

    cfg = manager.update_config(
        {
            "endpoint_candidates": {
                "frp": "https://frp.example:8768",
                "ipv6": "https://home.example:23443",
            }
        }
    )

    assert [entry["name"] for entry in cfg["endpoint_candidates"]] == ["ipv6", "frp"]
    assert cfg["server_url"] == "https://home.example:23443"
    saved = json.loads(cfg_path.read_text(encoding="utf-8"))
    assert saved["endpoint_candidates"][0]["name"] == "ipv6"


def test_manager_update_config_prefers_selected_server_url(tmp_path, monkeypatch):
    def healthy(*args, **kwargs):
        return _FakeResponse(200)

    monkeypatch.setattr("pc_sensor.transport.urlopen", healthy)
    cfg_path = tmp_path / "pc_sensor_config.json"
    manager = SensorManager(config_path=str(cfg_path))

    cfg = manager.update_config(
        {
            "server_url": "https://frp.example:8768",
            "endpoint_candidates": {
                "frp": "https://frp.example:8768",
                "ipv6": "https://home.example:23443",
            },
        }
    )

    assert cfg["server_url"] == "https://frp.example:8768"
    saved = json.loads(cfg_path.read_text(encoding="utf-8"))
    assert saved["server_url"] == "https://frp.example:8768"


def test_manager_update_config_rejects_invalid_candidates(tmp_path):
    cfg_path = tmp_path / "pc_sensor_config.json"
    manager = SensorManager(config_path=str(cfg_path))

    with pytest.raises(CandidateError):
        manager.update_config(
            {"endpoint_candidates": [{"name": "lan", "url": "http://example.com"}]}
        )
    assert manager._cfg["endpoint_candidates"] == []
