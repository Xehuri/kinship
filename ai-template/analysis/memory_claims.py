#!/usr/bin/env python3
"""CLI for validating and listing the append-only claims sidecar."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Sequence

from memory_claims_lib import (
    DEFAULT_CLAIMS,
    CheckResult,
    Finding,
    ParsedClaim,
    check_claims,
    derive_claim_id,
    list_active,
    read_claims,
)

__all__ = [
    "CheckResult",
    "DEFAULT_CLAIMS",
    "Finding",
    "ParsedClaim",
    "check_claims",
    "derive_claim_id",
    "list_active",
    "main",
    "read_claims",
]


def _claims_path(root: str | Path, value: str) -> Path:
    path = Path(value)
    return path if path.is_absolute() else Path(root) / path


def _print_json(payload: Any) -> None:
    print(json.dumps(payload, ensure_ascii=False, indent=2))


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="memory_claims.py", description="Validate the claims sidecar."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    check_parser = subparsers.add_parser("check", help="validate schema, sources, supersedes")
    check_parser.add_argument("--root", default=".")
    check_parser.add_argument("--claims", default=DEFAULT_CLAIMS)

    list_parser = subparsers.add_parser("list", help="print active claims")
    list_parser.add_argument("--root", default=".")
    list_parser.add_argument("--claims", default=DEFAULT_CLAIMS)
    list_parser.add_argument("--json", action="store_true")

    args = parser.parse_args(argv)
    claims_path = _claims_path(args.root, args.claims)

    if args.command == "check":
        result = check_claims(Path(args.root), claims_path)
        _print_json(result.summary())
        return 0 if not result.findings else 1

    claims = list_active(claims_path)
    if args.json:
        _print_json(claims)
    else:
        for claim in claims:
            print(
                f"{claim.get('claim_id')}\t{claim.get('subject')}\t"
                f"{claim.get('predicate')}\t{claim.get('object')}"
            )
    return 0


if __name__ == "__main__":
    sys.exit(main())
