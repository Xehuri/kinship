from __future__ import annotations

import asyncio
import base64
import tempfile
from pathlib import Path

from services.qq_gateway.media import MediaFetcher


PNG_BYTES = b"\x89PNG\r\n\x1a\n" + b"fake-image"


def test_fetch_reuses_existing_file_without_gateway_call() -> None:
    async def scenario() -> None:
        with tempfile.TemporaryDirectory() as tmp:
            media_dir = Path(tmp) / "media"
            media_dir.mkdir()
            target = media_dir / "1001_1.png"
            target.write_bytes(b"\x89PNG\r\n\x1a\nfake")
            fetcher = MediaFetcher(str(media_dir), 10)
            calls: list[tuple[str, dict]] = []

            async def fail_call(action: str, params: dict) -> dict:
                calls.append((action, params))
                raise AssertionError("gateway should not be called for cached media")

            path = await fetcher.fetch(
                {"type": "image", "data": {"file_id": "f1"}}, 1, "1001", fail_call
            )

            assert path == str(target)
            assert calls == []

    asyncio.run(scenario())


def test_fetch_image_uses_napcat_file_param() -> None:
    async def scenario() -> None:
        with tempfile.TemporaryDirectory() as tmp:
            fetcher = MediaFetcher(str(Path(tmp) / "media"), 10)
            calls: list[tuple[str, dict]] = []

            async def fake_call(action: str, params: dict) -> dict:
                calls.append((action, params))
                return {"base64": base64.b64encode(PNG_BYTES).decode("ascii")}

            path = await fetcher.fetch(
                {"type": "image", "data": {"file": "abc.jpg", "file_unique": "u"}},
                1,
                "1001",
                fake_call,
            )

            assert calls == [("get_image", {"file": "abc.jpg"})]
            assert path is not None
            assert path.endswith(".png")
            assert Path(path).is_file()

    asyncio.run(scenario())


def test_fetch_file_uses_napcat_file_id_and_file_params() -> None:
    async def scenario() -> None:
        with tempfile.TemporaryDirectory() as tmp:
            fetcher = MediaFetcher(str(Path(tmp) / "media"), 10)
            calls: list[tuple[str, dict]] = []

            async def fake_call(action: str, params: dict) -> dict:
                calls.append((action, params))
                return {"base64": base64.b64encode(b"%PDF-1.4 fake").decode("ascii")}

            path = await fetcher.fetch(
                {
                    "type": "file",
                    "data": {"file_id": "fid", "file": "a.pdf", "name": "a.pdf"},
                },
                0,
                "1002",
                fake_call,
            )

            assert calls == [("get_file", {"file_id": "fid", "file": "a.pdf"})]
            assert path is not None
            assert path.endswith(".pdf")
            assert Path(path).is_file()

    asyncio.run(scenario())


def test_fetch_does_not_reuse_colliding_index_prefix() -> None:
    async def scenario() -> None:
        with tempfile.TemporaryDirectory() as tmp:
            media_dir = Path(tmp) / "media"
            media_dir.mkdir()
            (media_dir / "1001_10.png").write_bytes(PNG_BYTES)
            fetcher = MediaFetcher(str(media_dir), 10)
            calls: list[tuple[str, dict]] = []

            async def fake_call(action: str, params: dict) -> dict:
                calls.append((action, params))
                return {"base64": base64.b64encode(PNG_BYTES).decode("ascii")}

            path = await fetcher.fetch(
                {"type": "image", "data": {"file_id": "f1"}}, 1, "1001", fake_call
            )

            assert calls == [("get_image", {"file": "f1"})]
            assert path is not None
            assert path.endswith("1001_1.png")
            assert not path.endswith("1001_10.png")

    asyncio.run(scenario())
