from __future__ import annotations

import asyncio
import logging
from typing import Any, Awaitable, Callable, Optional

from .config import DeliveryConfig
from .store import EventStore

Sender = Callable[[dict[str, Any]], Awaitable[bool]]


class DeliveryWorker:
    def __init__(self, store: EventStore, send: Sender, config: DeliveryConfig,
                 logger: Optional[logging.Logger] = None) -> None:
        self.store = store
        self.send = send
        self.config = config
        self.log = logger or logging.getLogger(__name__)
        self._task: Optional[asyncio.Task[None]] = None
        self._stop = asyncio.Event()

    async def start(self) -> None:
        if self._task is None:
            self._stop.clear()
            self._task = asyncio.create_task(self._run(), name="qq-gateway-delivery")

    async def stop(self) -> None:
        self._stop.set()
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    async def _run(self) -> None:
        while not self._stop.is_set():
            rows = await self.store.claim_deliveries(10)
            if not rows:
                try:
                    await asyncio.wait_for(self._stop.wait(), timeout=0.25)
                except asyncio.TimeoutError:
                    pass
                continue
            for row in rows:
                if self._stop.is_set():
                    break
                try:
                    ok = await self.send(row)
                except Exception as exc:
                    ok = False
                    self.log.warning("qq-gateway delivery failed: %s", exc)
                if ok:
                    await self.store.mark_delivered(int(row["id"]))
                    continue
                attempts = int(row.get("attempts") or 0) + 1
                delay = self.config.retry_backoff_sec * min(attempts, 6)
                await self.store.mark_retry(int(row["id"]), "delivery failed", delay,
                                            self.config.max_retries)

    @property
    def running(self) -> bool:
        return self._task is not None and not self._task.done()
