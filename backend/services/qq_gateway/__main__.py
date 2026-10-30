from __future__ import annotations

import asyncio
import logging
import signal

from .config import QQGatewayConfig
from .service import QQGatewayService


async def _run() -> None:
    config = QQGatewayConfig.load()
    if not config.enabled:
        logging.getLogger(__name__).info("qq_gateway disabled")
        return
    service = QQGatewayService(config)
    await service.start()
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    try:
        loop.add_signal_handler(signal.SIGTERM, stop.set)
        loop.add_signal_handler(signal.SIGINT, stop.set)
    except NotImplementedError:
        signal.signal(signal.SIGINT, lambda *_: loop.call_soon_threadsafe(stop.set))
        signal.signal(signal.SIGTERM, lambda *_: loop.call_soon_threadsafe(stop.set))
    try:
        await stop.wait()
    finally:
        await service.stop()


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    asyncio.run(_run())


if __name__ == "__main__":
    main()
