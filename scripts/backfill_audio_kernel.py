# -*- coding: utf-8 -*-
"""内核路径音频回填：重放 daily/<date>/audio 下未被 perception 引用的文件。

统一走 services.audio_analysis_pipeline.analyze_audio_file（内核作业链），
不 import 本地 ML。预检要求内核已存活、健康且 argv0 与 AXEUH_KERNEL_PYTHON
一致；本脚本绝不 spawn 内核。

用法：
    python scripts/backfill_audio_kernel.py --dates 2026-10-21 --dry-run
    python scripts/backfill_audio_kernel.py --all --limit 10
退出码：0 完成；2 遇到 retry 停止批次；3 预检/参数/致命错误。
"""
# noqa: SIZE_OK - 单文件回填 CLI（扫描/预检/批处理同源），拆分需新增第三文件
import argparse
import json
import os
import re
import sys
import time
from dataclasses import dataclass
from pathlib import Path

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_PROJECT_ROOT = os.path.normpath(os.path.join(_SCRIPT_DIR, ".."))
_BACKEND_DIR = os.path.join(_PROJECT_ROOT, "backend")
for _path in (_SCRIPT_DIR, _BACKEND_DIR):
    if _path not in sys.path:
        sys.path.insert(0, _path)

from audit_orphan_audio import AUDIO_EXT, collect_references

_DEVICE_RE = re.compile(r"^\d{6}-\d{6}_(.+)_\d{13}\.\w+$")
_START_RE = re.compile(r"_(\d{13})$")
_PIDFILE_NAME = "kernel.pid"


def _parse_start_epoch_ms(filename: str) -> int | None:
    """从扩展名前的 `_<13位毫秒>` 解析起始时间；无则 None。"""
    match = _START_RE.search(Path(filename).stem)
    return int(match.group(1)) if match else None


def _parse_device_name(filename: str, override: str) -> str:
    """设备名优先取 --device，否则按文件名片段解析，仍无则空串。"""
    if override:
        return override
    match = _DEVICE_RE.match(filename)
    return match.group(1) if match else ""


def _now_ms() -> int:
    """当前 epoch 毫秒（测试打桩点）。"""
    return int(time.time() * 1000)


@dataclass(frozen=True, slots=True)
class Options:
    dates: tuple[str, ...] | None
    scan_all: bool
    data_base: str | None
    force: bool = False
    limit: int = 0
    sleep_s: float = 1.0
    min_age_s: int = 300
    dry_run: bool = False
    fail_fast: bool = False
    device: str = ""


@dataclass(frozen=True, slots=True)
class Target:
    date: str
    path: Path
    start_epoch_ms: int | None
    device_name: str

    @property
    def rel(self) -> str:
        return f"daily/{self.date}/audio/{self.path.name}"


@dataclass(frozen=True, slots=True)
class References:
    full: frozenset[str]
    basename: frozenset[str]


@dataclass(slots=True)
class Stats:
    """批处理计数器（按设计可变的累加器）。"""

    started: float
    targets: int = 0
    ok: int = 0
    retry: int = 0
    errors: int = 0
    skipped: int = 0


def _load_references(data_base: Path) -> References:
    full, base = collect_references(str(data_base))
    return References(full=frozenset(full), basename=frozenset(base))


def _load_day_references(data_base: Path, date: str) -> References:
    """单日 perception 行引用（逐文件复核用；口径同 collect_references）。"""
    full: set[str] = set()
    base: set[str] = set()
    path = data_base / date / "perception.jsonl"
    if not path.is_file():
        return References(frozenset(), frozenset())
    with path.open("rb") as f:
        for raw in f:
            try:
                row = json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, ValueError):
                continue
            audio = row.get("audio") if isinstance(row, dict) else None
            if isinstance(audio, str) and audio:
                full.add(audio)
                base.add(os.path.basename(audio))
    return References(frozenset(full), frozenset(base))


def _is_referenced(target: Target, refs: References) -> bool:
    return target.rel in refs.full or target.path.name in refs.basename


def _iter_targets(
    options: Options, data_base: Path, now_ms: int
) -> tuple[list[Target], int]:
    """枚举候选；跳过 analysis 旁路件与过新文件，返回 (目标, 过新跳过数)。"""
    dates = options.dates or ()
    if options.scan_all:
        dates = tuple(
            sorted(
                name
                for name in os.listdir(data_base)
                if (data_base / name / "audio").is_dir()
            )
        )
    targets: list[Target] = []
    recent = 0
    for date in dates:
        audio_dir = data_base / date / "audio"
        if not audio_dir.is_dir():
            continue
        for name in sorted(os.listdir(audio_dir)):
            if not name.endswith(AUDIO_EXT) or name.endswith(".analysis.wav"):
                continue
            start = _parse_start_epoch_ms(name)
            if start is not None and now_ms - start < options.min_age_s * 1000:
                recent += 1
                continue
            targets.append(
                Target(
                    date,
                    audio_dir / name,
                    start,
                    _parse_device_name(name, options.device),
                )
            )
    return targets, recent


def _select_targets(
    targets: list[Target], refs: References, options: Options
) -> tuple[list[Target], int]:
    """去掉已被引用的文件（--force 保留），再应用 --limit。"""
    picked = [
        target
        for target in targets
        if options.force or not _is_referenced(target, refs)
    ]
    skipped = len(targets) - len(picked)
    if options.limit > 0:
        picked = picked[: options.limit]
    return picked, skipped


def _preflight() -> str | None:
    """校验已有内核健康且解释器一致；None=通过。绝不 spawn。"""
    if os.name == "nt":
        return "预检失败: 回填仅支持 POSIX"
    expected = os.environ.get("AXEUH_KERNEL_PYTHON", "").strip()
    if not expected:
        return "预检失败: 未设置 AXEUH_KERNEL_PYTHON（内核专用 venv 解释器）"
    from services import kernel_client as kc

    state_dir = kc._state_dir()
    link = kc._read_pidfile(state_dir)
    if not link:
        return (
            f"预检失败: 无内核 pidfile ({state_dir / _PIDFILE_NAME})，"
            "请先启动后端内核（本脚本绝不 spawn）"
        )
    try:
        pid, port = int(link.get("pid") or 0), int(link.get("port") or 0)
    except (TypeError, ValueError):
        return "预检失败: pidfile 的 pid/port 字段非法"
    if not pid or not port:
        return "预检失败: pidfile 缺少 pid/port"
    if not kc._pid_alive(pid):
        return f"预检失败: 内核 pid={pid} 不存活，请重启后端（绝不 spawn）"
    if not kc._probe_health(port, timeout=10.0):
        return f"预检失败: 内核 pid={pid} port={port} /v1/health 非 200"
    actual = kc._proc_argv0(pid)
    if actual is None:
        return f"预检失败: 无法读取内核 pid={pid} 的 argv0"
    if not kc._same_interpreter(actual, expected):
        return (
            f"预检失败: 内核解释器不符 expected={expected} "
            f"actual={actual} pid={pid}"
        )
    return None


def analyze_audio_file(
    audio_abs_path: str,
    start_epoch_ms: int | None,
    device_name: str = "",
    ts_val: str | None = None,
    origin: str = "upload",
    attempt: int = 0,
) -> str:
    """惰性导入生产分析入口（模块导入不加载后端流水线）。"""
    from services.audio_analysis_pipeline import analyze_audio_file as impl

    return impl(audio_abs_path, start_epoch_ms, device_name, ts_val=ts_val, origin=origin, attempt=attempt)


def _print_summary(stats: Stats) -> None:
    elapsed = time.monotonic() - stats.started
    print(
        f"summary targets={stats.targets} ok={stats.ok} retry={stats.retry} "
        f"errors={stats.errors} skipped={stats.skipped} elapsed={elapsed:.1f}s"
    )


def run(options: Options) -> int:
    stats = Stats(started=time.monotonic())
    if options.data_base:
        data_base = Path(options.data_base)
    else:
        from config.config import get_config

        data_base = Path(get_config().DATA_DIR) / "daily"
    if not data_base.is_dir():
        print(f"错误: 数据根不存在: {data_base}", file=sys.stderr)
        return 3
    if not options.scan_all and not options.dates:
        print("错误: 必须提供 --dates 或 --all", file=sys.stderr)
        return 3

    targets, recent = _iter_targets(options, data_base, _now_ms())
    base_refs = _load_references(data_base)
    dated = [target for target in targets if target.start_epoch_ms is not None]
    undated = sum(
        1
        for target in targets
        if target.start_epoch_ms is None
        and (options.force or not _is_referenced(target, base_refs))
    )
    if undated:
        print(f"[skip] 无 13 位时间戳的未分析文件不参与回填: {undated} 个")
    stats.skipped += recent + undated
    selected, dropped = _select_targets(dated, base_refs, options)
    stats.targets, stats.skipped = len(selected), stats.skipped + dropped

    if options.dry_run:
        for target in selected:
            print(
                f"[dry-run] {target.rel} start_epoch_ms={target.start_epoch_ms} "
                f"device={target.device_name!r}"
            )
        _print_summary(stats)
        return 0

    problem = _preflight()
    if problem is not None:
        print(problem, file=sys.stderr)
        return 3

    for index, target in enumerate(selected):
        if index and options.sleep_s > 0:
            time.sleep(options.sleep_s)
        if not options.force and (
            _is_referenced(target, base_refs)
            or _is_referenced(target, _load_day_references(data_base, target.date))
        ):
            stats.skipped += 1
            print(f"[skip] 分析前已被引用: {target.rel}")
            continue
        print(
            f"[{index + 1}/{len(selected)}] {target.rel} "
            f"start_epoch_ms={target.start_epoch_ms} device={target.device_name!r}",
            flush=True,
        )
        try:
            result = analyze_audio_file(
                str(target.path),
                target.start_epoch_ms,
                target.device_name,
                ts_val=None,
                origin="upload",
                attempt=0,
            )
        except Exception as exc:  # noqa: BROAD_EXCEPT_OK - 批处理边界按文件容错
            stats.errors += 1
            print(f"[error] {target.rel}: {exc}", file=sys.stderr)
            if options.fail_fast:
                _print_summary(stats)
                return 3
            continue
        match result:
            case "ok":
                stats.ok += 1
            case "retry":
                stats.retry += 1
                print(
                    f"[retry] {target.rel} 要求重投，立即停止批次（避免重复分析）",
                    file=sys.stderr,
                )
                _print_summary(stats)
                return 2
            case other:
                stats.errors += 1
                print(f"[error] {target.rel}: 未知返回 {other!r}", file=sys.stderr)
                if options.fail_fast:
                    _print_summary(stats)
                    return 3

    _print_summary(stats)
    return 3 if stats.errors else 0


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="内核路径音频回填（绝不 spawn 内核）"
    )
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--dates", default=None, help="YYYY-MM-DD[,YYYY-MM-DD...]")
    group.add_argument(
        "--all", dest="scan_all", action="store_true", help="扫描全部 daily/<date>/audio"
    )
    parser.add_argument(
        "--data-base", default=None, help="daily 数据根覆盖（默认 config DATA_DIR/daily）"
    )
    parser.add_argument(
        "--force", action="store_true", help="包含已被 perception 引用的文件"
    )
    parser.add_argument("--limit", type=int, default=0, help="0 = 全部")
    parser.add_argument(
        "--sleep", dest="sleep_s", type=float, default=1.0, help="文件间休眠秒数"
    )
    parser.add_argument(
        "--min-age-s", dest="min_age_s", type=int, default=300, help="跳过过新文件"
    )
    parser.add_argument("--dry-run", action="store_true", help="只列出目标，不分析")
    parser.add_argument("--fail-fast", action="store_true", help="首个错误即终止")
    parser.add_argument(
        "--device", default="", help="设备名覆盖（缺省按文件名解析）"
    )
    return parser


def main(argv: "list[str] | None" = None) -> int:
    args = _build_parser().parse_args(argv)
    args.dates = (
        tuple(part.strip() for part in args.dates.split(",") if part.strip())
        if args.dates
        else None
    )
    return run(Options(**vars(args)))


if __name__ == "__main__":
    sys.exit(main())
