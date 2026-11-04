"""Validate the frozen Stratum prompt contract on Windows and Linux CI."""

from pathlib import Path

ROOT = Path("ai-template/agents")
FILES = {
    "复盘-公共.md": ("stratum status", "报告契约"),
    "01-data-check.md": ("stratum ingest source",),
    "02-daily-review.md": ("stratum ingest report", "bulk-promote", "## 检索条目"),
    "03-biweekly-review.md": ("stratum query", "SELF_PROMOTION_FORBIDDEN"),
    "04-weekly-review.md": ("stratum ingest report", "stratum review promote"),
    "main.md": ("stratum query",),
}


def main() -> None:
    for name, needles in FILES.items():
        path = ROOT / name
        if not path.is_file():
            raise SystemExit(f"missing {path}")
        text = path.read_text(encoding="utf-8")
        for needle in needles:
            if needle not in text:
                raise SystemExit(f"{path}: missing {needle!r}")
        if "--request" in text:
            raise SystemExit(f"{path}: legacy JSON request")
        if "stratum --json" in text:
            raise SystemExit(f"{path}: JSON CLI")
    print("Stratum prompt contract OK")


if __name__ == "__main__":
    main()
