# -*- coding: utf-8 -*-
"""HMAC 信令票据格式、验签与边界。"""
import base64
import hashlib
import hmac

import pytest

from services.p2p.tokens import MAX_TICKET_TTL_SECONDS, SignalTicketIssuer


SECRET = "unit-test-secret"
CLOCK_START = 1_700_000_000.0


class FakeClock:
    def __init__(self, now=CLOCK_START):
        self.now = now

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


def _issuer(clock=None, ttl=600, room="home"):
    return SignalTicketIssuer(
        SECRET,
        ttl_seconds=ttl,
        room=room,
        clock=clock or FakeClock(),
    )


def _sign(payload):
    digest = hmac.new(SECRET.encode(), payload.encode(), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(digest).decode().rstrip("=")


def test_ticket_format_and_expiry():
    clock = FakeClock()
    issuer = _issuer(clock, ttl=600)

    ticket, expires_at_ms = issuer.issue("phone-1")
    parts = ticket.split(".")

    assert len(parts) == 6
    assert parts[0] == "v1"
    assert parts[1] == "phone-1"
    assert parts[2] == "home"
    assert int(parts[3]) == expires_at_ms
    assert expires_at_ms == int(clock.now * 1000) + 600_000
    assert "=" not in parts[5]


def test_verify_accepts_valid_ticket():
    issuer = _issuer()
    ticket, _expires = issuer.issue("phone-1")

    assert issuer.verify(ticket, "phone-1", "home") is True
    assert issuer.verify(ticket, "phone-1") is True


def test_verify_rejects_wrong_device_or_room():
    issuer = _issuer()
    ticket, _expires = issuer.issue("phone-1")

    assert issuer.verify(ticket, "phone-2", "home") is False
    assert issuer.verify(ticket, "phone-1", "other-room") is False
    assert issuer.verify(ticket, "", "home") is False


def test_verify_rejects_tampering():
    issuer = _issuer()
    ticket, _expires = issuer.issue("phone-1")
    parts = ticket.split(".")

    tampered_signature = list(parts)
    original_signature = tampered_signature[5]
    replacement = "B" if original_signature[0] != "B" else "C"
    tampered_signature[5] = replacement + original_signature[1:]
    assert issuer.verify(".".join(tampered_signature), "phone-1", "home") is False

    tampered_device = list(parts)
    tampered_device[1] = "phone-2"
    assert issuer.verify(".".join(tampered_device), "phone-2", "home") is False

    tampered_room = list(parts)
    tampered_room[2] = "other-room"
    assert issuer.verify(".".join(tampered_room), "phone-1", "other-room") is False

    tampered_exp = list(parts)
    tampered_exp[3] = str(int(tampered_exp[3]) + 60_000)
    assert issuer.verify(".".join(tampered_exp), "phone-1", "home") is False

    assert issuer.verify("not-a-ticket", "phone-1", "home") is False
    assert issuer.verify("v1.a.b.c.d", "a", "b") is False


def test_verify_rejects_expired_ticket():
    clock = FakeClock()
    issuer = _issuer(clock, ttl=60)
    ticket, _expires = issuer.issue("phone-1")

    clock.advance(61)
    assert issuer.verify(ticket, "phone-1", "home") is False


def test_verify_rejects_exp_more_than_15_minutes_future():
    clock = FakeClock()
    issuer = _issuer(clock)
    now_ms = int(clock.now * 1000)
    payload = f"v1.phone-1.home.{now_ms + 901_000}.{'n' * 16}"
    ticket = f"{payload}.{_sign(payload)}"

    assert issuer.verify(ticket, "phone-1", "home") is False


def test_verify_accepts_max_future_boundary():
    clock = FakeClock()
    issuer = _issuer(clock)
    now_ms = int(clock.now * 1000)
    payload = f"v1.phone-1.home.{now_ms + 900_000}.{'n' * 16}"
    ticket = f"{payload}.{_sign(payload)}"

    assert issuer.verify(ticket, "phone-1", "home") is True


def test_verify_rejects_wrong_secret():
    clock = FakeClock()
    issuer = _issuer(clock)
    ticket, _expires = issuer.issue("phone-1")
    attacker = SignalTicketIssuer("other-secret", room="home", clock=clock)

    assert attacker.verify(ticket, "phone-1", "home") is False


def test_issue_clamps_ttl_to_900_seconds():
    clock = FakeClock()
    issuer = SignalTicketIssuer(SECRET, ttl_seconds=5000, room="home", clock=clock)

    _ticket, expires_at_ms = issuer.issue("phone-1")

    assert issuer.ttl_seconds == MAX_TICKET_TTL_SECONDS
    assert expires_at_ms == int(clock.now * 1000) + MAX_TICKET_TTL_SECONDS * 1000


def test_issue_rejects_empty_or_dotted_parts():
    issuer = _issuer()
    with pytest.raises(ValueError):
        issuer.issue("")
    with pytest.raises(ValueError):
        issuer.issue("phone.1")
    with pytest.raises(ValueError):
        issuer.issue("a" * 65)


def test_verify_rejects_malformed_fields_before_hmac():
    clock = FakeClock()
    issuer = _issuer(clock)
    now_ms = int(clock.now * 1000)

    short_nonce_payload = f"v1.phone-1.home.{now_ms + 60_000}.short"
    assert (
        issuer.verify(
            f"{short_nonce_payload}.{_sign(short_nonce_payload)}", "phone-1", "home"
        )
        is False
    )

    long_device_payload = f"v1.{'a' * 65}.home.{now_ms + 60_000}.{'n' * 16}"
    assert (
        issuer.verify(
            f"{long_device_payload}.{_sign(long_device_payload)}",
            "a" * 65,
            "home",
        )
        is False
    )

    bad_signature_payload = f"v1.phone-1.home.{now_ms + 60_000}.{'n' * 16}"
    assert (
        issuer.verify(f"{bad_signature_payload}.{'s' * 40}", "phone-1", "home")
        is False
    )


def test_issue_rejects_dotted_room():
    with pytest.raises(ValueError):
        SignalTicketIssuer(SECRET, ttl_seconds=60, room="home.lan").issue("phone-1")


def test_nonces_are_unique():
    issuer = _issuer()
    first, _ = issuer.issue("phone-1")
    second, _ = issuer.issue("phone-1")

    assert first.split(".")[4] != second.split(".")[4]
