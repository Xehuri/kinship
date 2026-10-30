from __future__ import annotations

import asyncio
import json
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Optional


SCHEMA = """
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account TEXT NOT NULL,
    kind TEXT NOT NULL,
    chat_type TEXT,
    target TEXT,
    message_id TEXT,
    dedupe_key TEXT NOT NULL UNIQUE,
    text TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at REAL NOT NULL,
    delivered INTEGER NOT NULL DEFAULT 0,
    dead INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_at REAL NOT NULL DEFAULT 0,
    last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_due ON events(delivered, dead, next_at, id);
CREATE TABLE IF NOT EXISTS actions (
    echo TEXT PRIMARY KEY,
    action TEXT NOT NULL,
    params_hash TEXT,
    state TEXT NOT NULL,
    result TEXT,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS cursors (
    account TEXT NOT NULL,
    chat_type TEXT NOT NULL,
    target TEXT NOT NULL,
    last_time REAL NOT NULL,
    last_message_id TEXT,
    PRIMARY KEY (account, chat_type, target)
);
CREATE TABLE IF NOT EXISTS sticker_meta (
    res_id TEXT PRIMARY KEY,
    md5 TEXT,
    note TEXT,
    usage TEXT,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS water_state (
    group_id TEXT PRIMARY KEY,
    mode TEXT NOT NULL DEFAULT 'mentions',
    threshold REAL NOT NULL DEFAULT 12,
    water_until REAL NOT NULL DEFAULT 0,
    last_wake_at REAL NOT NULL DEFAULT 0,
    updated_at REAL NOT NULL
);
"""

WATER_MODES = ("mentions", "water", "mute")


def default_water_state(group_id: str) -> dict[str, Any]:
    return {
        "group_id": group_id,
        "mode": "mentions",
        "threshold": 12.0,
        "water_until": 0.0,
        "last_wake_at": 0.0,
        "updated_at": 0.0,
    }


class EventStore:
    def __init__(self, path: str) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(str(self.path), check_same_thread=False, isolation_level=None)
        self._conn.row_factory = sqlite3.Row
        with self._lock:
            self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.execute("PRAGMA synchronous=NORMAL")
            self._conn.execute("PRAGMA busy_timeout=5000")
            self._conn.executescript(SCHEMA)

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    async def enqueue_event(self, *, account: str, kind: str, chat_type: str,
                            target: str, message_id: str, dedupe_key: str,
                            text: str, payload: dict[str, Any]) -> bool:
        return await asyncio.to_thread(
            self._enqueue_event, account, kind, chat_type, target, message_id,
            dedupe_key, text, payload,
        )

    def _enqueue_event(self, account: str, kind: str, chat_type: str, target: str,
                       message_id: str, dedupe_key: str, text: str,
                       payload: dict[str, Any]) -> bool:
        with self._lock:
            cur = self._conn.execute(
                """INSERT OR IGNORE INTO events
                   (account, kind, chat_type, target, message_id, dedupe_key, text, payload, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (account, kind, chat_type, target, message_id, dedupe_key, text,
                 json.dumps(payload, ensure_ascii=False), time.time()),
            )
            return cur.rowcount > 0

    async def claim_deliveries(self, limit: int = 20) -> list[dict[str, Any]]:
        return await asyncio.to_thread(self._claim_deliveries, limit)

    def _claim_deliveries(self, limit: int) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(
                """SELECT * FROM events
                   WHERE delivered = 0 AND dead = 0 AND next_at <= ?
                   ORDER BY id LIMIT ?""",
                (time.time(), limit),
            ).fetchall()
            return [dict(row) for row in rows]

    async def mark_delivered(self, event_id: int) -> None:
        await asyncio.to_thread(self._mark_delivered, event_id)

    def _mark_delivered(self, event_id: int) -> None:
        with self._lock:
            self._conn.execute(
                "UPDATE events SET delivered = 1, attempts = attempts + 1, last_error = NULL WHERE id = ?",
                (event_id,),
            )

    async def mark_retry(self, event_id: int, error: str, delay: float,
                         max_attempts: int) -> None:
        await asyncio.to_thread(self._mark_retry, event_id, error, delay, max_attempts)

    def _mark_retry(self, event_id: int, error: str, delay: float, max_attempts: int) -> None:
        with self._lock:
            row = self._conn.execute(
                "SELECT attempts FROM events WHERE id = ?", (event_id,)
            ).fetchone()
            attempts = int(row["attempts"]) + 1 if row else max_attempts
            dead = 1 if attempts >= max_attempts else 0
            self._conn.execute(
                """UPDATE events SET attempts = ?, dead = ?, next_at = ?, last_error = ?
                   WHERE id = ?""",
                (attempts, dead, time.time() + delay, error[:500], event_id),
            )

    async def record_action(self, echo: str, action: str, params_hash: str) -> None:
        await asyncio.to_thread(self._record_action, echo, action, params_hash)

    def _record_action(self, echo: str, action: str, params_hash: str) -> None:
        now = time.time()
        with self._lock:
            self._conn.execute(
                """INSERT OR REPLACE INTO actions
                   (echo, action, params_hash, state, created_at, updated_at)
                   VALUES (?, ?, ?, 'pending', ?, ?)""",
                (echo, action, params_hash, now, now),
            )

    async def finish_action(self, echo: str, state: str, result: Optional[dict[str, Any]] = None) -> None:
        await asyncio.to_thread(self._finish_action, echo, state, result)

    def _finish_action(self, echo: str, state: str, result: Optional[dict[str, Any]]) -> None:
        with self._lock:
            self._conn.execute(
                "UPDATE actions SET state = ?, result = ?, updated_at = ? WHERE echo = ?",
                (state, json.dumps(result, ensure_ascii=False) if result is not None else None,
                 time.time(), echo),
            )

    async def get_action(self, echo: str) -> Optional[dict[str, Any]]:
        return await asyncio.to_thread(self._get_action, echo)

    def _get_action(self, echo: str) -> Optional[dict[str, Any]]:
        with self._lock:
            row = self._conn.execute("SELECT * FROM actions WHERE echo = ?", (echo,)).fetchone()
            return dict(row) if row else None

    async def set_cursor(self, account: str, chat_type: str, target: str,
                         last_time: float, last_message_id: str) -> None:
        await asyncio.to_thread(
            self._set_cursor, account, chat_type, target, last_time, last_message_id
        )

    def _set_cursor(self, account: str, chat_type: str, target: str,
                    last_time: float, last_message_id: str) -> None:
        with self._lock:
            self._conn.execute(
                """INSERT INTO cursors (account, chat_type, target, last_time, last_message_id)
                   VALUES (?, ?, ?, ?, ?)
                   ON CONFLICT(account, chat_type, target) DO UPDATE SET
                   last_time = excluded.last_time, last_message_id = excluded.last_message_id""",
                (account, chat_type, target, last_time, last_message_id),
            )

    async def get_cursor(self, account: str, chat_type: str,
                         target: str) -> Optional[dict[str, Any]]:
        return await asyncio.to_thread(self._get_cursor, account, chat_type, target)

    def _get_cursor(self, account: str, chat_type: str,
                    target: str) -> Optional[dict[str, Any]]:
        with self._lock:
            row = self._conn.execute(
                """SELECT last_time, last_message_id FROM cursors
                   WHERE account = ? AND chat_type = ? AND target = ?""",
                (account, chat_type, target),
            ).fetchone()
            if not row:
                return None
            return {
                "last_time": float(row["last_time"]),
                "last_message_id": row["last_message_id"] or "",
            }

    async def get_water_state(self, group_id: str) -> Optional[dict[str, Any]]:
        return await asyncio.to_thread(self._get_water_state, group_id)

    def _get_water_state(self, group_id: str) -> Optional[dict[str, Any]]:
        with self._lock:
            row = self._conn.execute(
                """SELECT group_id, mode, threshold, water_until, last_wake_at, updated_at
                   FROM water_state WHERE group_id = ?""",
                (group_id,),
            ).fetchone()
            return dict(row) if row else None

    async def list_water_states(self) -> list[dict[str, Any]]:
        return await asyncio.to_thread(self._list_water_states)

    def _list_water_states(self) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(
                """SELECT group_id, mode, threshold, water_until, last_wake_at, updated_at
                   FROM water_state ORDER BY group_id"""
            ).fetchall()
            return [dict(row) for row in rows]

    async def upsert_water_state(self, group_id: str, *, mode: Optional[str] = None,
                                 threshold: Optional[float] = None,
                                 water_until: Optional[float] = None,
                                 last_wake_at: Optional[float] = None) -> dict[str, Any]:
        return await asyncio.to_thread(
            self._upsert_water_state, group_id, mode, threshold, water_until, last_wake_at
        )

    def _upsert_water_state(self, group_id: str, mode: Optional[str],
                            threshold: Optional[float], water_until: Optional[float],
                            last_wake_at: Optional[float]) -> dict[str, Any]:
        with self._lock:
            row = self._conn.execute(
                """SELECT group_id, mode, threshold, water_until, last_wake_at, updated_at
                   FROM water_state WHERE group_id = ?""",
                (group_id,),
            ).fetchone()
            state = dict(row) if row else default_water_state(group_id)
            if mode is not None:
                state["mode"] = mode
            if threshold is not None:
                state["threshold"] = float(threshold)
            if water_until is not None:
                state["water_until"] = float(water_until)
            if last_wake_at is not None:
                state["last_wake_at"] = float(last_wake_at)
            state["updated_at"] = time.time()
            self._conn.execute(
                """INSERT INTO water_state
                   (group_id, mode, threshold, water_until, last_wake_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?)
                   ON CONFLICT(group_id) DO UPDATE SET
                   mode = excluded.mode, threshold = excluded.threshold,
                   water_until = excluded.water_until, last_wake_at = excluded.last_wake_at,
                   updated_at = excluded.updated_at""",
                (state["group_id"], state["mode"], state["threshold"],
                 state["water_until"], state["last_wake_at"], state["updated_at"]),
            )
            return state

    async def counts(self) -> dict[str, int]:
        return await asyncio.to_thread(self._counts)

    def counts_sync(self) -> dict[str, int]:
        return self._counts()

    async def set_sticker_meta(self, res_id: str, md5: str, note: str, usage: str) -> None:
        await asyncio.to_thread(self._set_sticker_meta, res_id, md5, note, usage)

    def _set_sticker_meta(self, res_id: str, md5: str, note: str, usage: str) -> None:
        now = time.time()
        with self._lock:
            self._conn.execute(
                """INSERT INTO sticker_meta (res_id, md5, note, usage, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?)
                   ON CONFLICT(res_id) DO UPDATE SET
                   md5 = excluded.md5, note = excluded.note, usage = excluded.usage,
                   updated_at = excluded.updated_at""",
                (res_id, md5, note, usage, now, now),
            )

    async def all_sticker_meta(self) -> dict[str, dict[str, str]]:
        return await asyncio.to_thread(self._all_sticker_meta)

    async def delete_sticker_meta(self, res_id: str) -> None:
        await asyncio.to_thread(self._delete_sticker_meta, res_id)

    def _delete_sticker_meta(self, res_id: str) -> None:
        with self._lock:
            self._conn.execute("DELETE FROM sticker_meta WHERE res_id = ?", (res_id,))
            self._conn.execute("DELETE FROM sticker_meta WHERE md5 = ?", (res_id,))

    def _all_sticker_meta(self) -> dict[str, dict[str, str]]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT res_id, md5, note, usage FROM sticker_meta"
            ).fetchall()
            return {
                str(row["res_id"]): {
                    "md5": str(row["md5"] or ""),
                    "note": str(row["note"] or ""),
                    "usage": str(row["usage"] or ""),
                }
                for row in rows
            }

    def _counts(self) -> dict[str, int]:
        with self._lock:
            row = self._conn.execute(
                """SELECT
                   SUM(CASE WHEN delivered = 0 AND dead = 0 THEN 1 ELSE 0 END) AS pending,
                   SUM(CASE WHEN dead = 1 THEN 1 ELSE 0 END) AS dead,
                   SUM(CASE WHEN delivered = 1 THEN 1 ELSE 0 END) AS delivered
                   FROM events"""
            ).fetchone()
            actions = self._conn.execute("SELECT COUNT(*) AS n FROM actions").fetchone()
            return {
                "pending": int(row["pending"] or 0) if row else 0,
                "dead": int(row["dead"] or 0) if row else 0,
                "delivered": int(row["delivered"] or 0) if row else 0,
                "actions": int(actions["n"] or 0) if actions else 0,
            }
