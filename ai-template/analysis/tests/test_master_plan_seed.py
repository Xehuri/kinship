"""master_plan_seed 的隔离测试：临时 planRoot，不碰生产 ai/data。"""

import json
import sys
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import master_plan_seed as seed

FIXED_IDS = [
    "daily-review",
    "night-audit",
    "weekly-review",
    "compactor",
    "loom-probe",
    "weather",
    "loom-fleet",
    "biweekly",
    "plan-build",
    "plan-review",
]
COVERAGE_IDS = ["cov-00", "cov-06", "cov-08", "cov-12", "cov-16", "cov-20", "cov-22"]

EXPECTED_TIMES = {
    "daily-review": "00:40",
    "night-audit": "02:00",
    "compactor": "04:00",
    "loom-probe": "04:00",
    "weather": "07:00",
    "loom-fleet": "08:30",
    "plan-build": "05:00",
    "plan-review": "07:30",
    "cov-00": "00:00",
    "cov-06": "06:00",
    "cov-08": "08:00",
    "cov-12": "12:00",
    "cov-16": "16:00",
    "cov-20": "20:00",
    "cov-22": "22:00",
}


def _checkpoint(trigger: str, window: str, target: str) -> dict:
    return {"trigger": trigger, "window": window, "target_date": target}


def _write_coverage(root: Path) -> None:
    plan_dir = root / "plan"
    plan_dir.mkdir(parents=True, exist_ok=True)
    checkpoints = {
        "cov-00": _checkpoint("00:00", "22:00~00:00", "previous_day"),
        "cov-06": _checkpoint("06:00", "00:00~06:00", "today"),
        "cov-08": _checkpoint("08:00", "06:00~08:00", "today"),
        "cov-12": _checkpoint("12:00", "08:00~12:00", "today"),
        "cov-16": _checkpoint("16:00", "12:00~16:00", "today"),
        "cov-20": _checkpoint("20:00", "16:00~20:00", "today"),
        "cov-22": _checkpoint("22:00", "20:00~22:00", "today"),
    }
    payload = {
        "schema": 1,
        "timezone": "Asia/Shanghai",
        "default": "merged_7",
        "profiles": {"merged_7": {"checkpoints": checkpoints}},
    }
    (plan_dir / "coverage.yaml").write_text(
        yaml.safe_dump(payload, allow_unicode=True, sort_keys=False),
        encoding="utf-8",
    )


def _write_long_task(root: Path) -> None:
    directory = root / "plan" / "long-tasks"
    directory.mkdir(parents=True, exist_ok=True)
    payload = {
        "schema": 1,
        "id": "lt_soak_7d",
        "title": "Loom 七天 soak 观察",
        "intent": "连续 7 天观察 Loom 是否稳定。",
        "cadence": "daily",
        "next_check": "2099-01-02",
        "last_done": None,
        "status": "active",
        "created_at": "2099-01-01T15:02:08.407Z",
        "updated_at": "2099-01-01T15:02:22.770Z",
        "version": 4,
    }
    (directory / "lt_soak_7d.json").write_text(
        json.dumps(payload, ensure_ascii=False), encoding="utf-8"
    )


def _write_tasks(root: Path) -> None:
    directory = root / "tasks"
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "12-daily-review.yaml").write_text(
        "name: 今日复盘\nprompt: |-\n  review prompt\n", encoding="utf-8"
    )
    (directory / "16-weather-morning.yaml").write_text(
        "name: 每日天气\nprompt: |-\n  发到 10000000000，备用 10000000001\n",
        encoding="utf-8",
    )


def _root(tmp_path: Path, *, long_task: bool = False, tasks: bool = False) -> Path:
    _write_coverage(tmp_path)
    if long_task:
        _write_long_task(tmp_path)
    if tasks:
        _write_tasks(tmp_path)
    return tmp_path


def _read_master(root: Path) -> dict:
    return json.loads((root / "plan" / "master.json").read_text(encoding="utf-8"))


def test_seed_produces_exact_17_entries(tmp_path, capsys):
    root = _root(tmp_path, tasks=True)

    assert seed.main(["--root", str(root)]) == 0
    document = _read_master(root)

    assert document["schema"] == 1
    assert document["kind"] == "master-plan"
    assert document["timezone"] == "Asia/Shanghai"
    assert document["version"] == 1
    assert len(document["entries"]) == 17
    assert [entry["id"] for entry in document["entries"]] == FIXED_IDS + COVERAGE_IDS

    by_id = {entry["id"]: entry for entry in document["entries"]}
    assert [by_id[key]["action"] for key in FIXED_IDS] == [
        "review.daily",
        "audit.night",
        "review.weekly",
        "session.compact",
        "probe.run",
        "weather.morning",
        "fleet.run",
        "review.biweekly",
        "plan.build",
        "plan.review",
    ]
    for entry_id, clock in EXPECTED_TIMES.items():
        assert by_id[entry_id]["schedule"]["at"] == clock
    assert by_id["weekly-review"]["schedule"]["days"] == ["mon"]
    assert by_id["biweekly"]["schedule"]["days"] == [1, 15]
    assert by_id["night-audit"]["enabled"] is False
    assert by_id["loom-probe"]["enabled"] is False
    assert by_id["loom-fleet"]["enabled"] is False
    assert by_id["weather"]["enabled"] is False
    assert by_id["cov-00"]["target_date"] == "previous_day"
    assert by_id["cov-06"]["target_date"] == "today"
    assert by_id["daily-review"]["instruction"] == "review prompt"

    weather = by_id["weather"]["instruction"]
    assert "{AI目录}/memory/self/tasks/天气播报.md" in weather
    text = json.dumps(document, ensure_ascii=False)
    assert "10000000000" not in text
    assert "10000000001" not in text

    assert (root / "plan" / "master.md").read_text(encoding="utf-8").startswith("# Master Plan")
    assert "### weather [fixed] 每日天气" in (root / "plan" / "master.md").read_text(
        encoding="utf-8"
    )
    assert "Wrote" in capsys.readouterr().out


def test_missing_long_term_at_refuses_without_writing(tmp_path, capsys):
    root = _root(tmp_path, long_task=True)

    assert seed.main(["--root", str(root)]) != 0
    assert not (root / "plan" / "master.json").exists()
    assert not (root / "plan" / "master.md").exists()
    assert "lt_soak_7d" in capsys.readouterr().err


def test_second_run_refuses_overwrite(tmp_path, capsys):
    root = _root(tmp_path)
    assert seed.main(["--root", str(root)]) == 0
    first = _read_master(root)

    assert seed.main(["--root", str(root)]) != 0
    assert _read_master(root) == first
    assert "拒绝覆盖" in capsys.readouterr().err


def test_dry_run_writes_nothing(tmp_path, capsys):
    root = _root(tmp_path)

    assert seed.main(["--root", str(root), "--dry-run"]) == 0
    assert not (root / "plan" / "master.json").exists()
    assert not (root / "plan" / "master.md").exists()
    assert "DRY RUN" in capsys.readouterr().out


def test_long_task_uses_explicit_time_and_force_bumps_version(tmp_path):
    root = _root(tmp_path, long_task=True)
    args = ["--root", str(root), "--long-term-at", "lt_soak_7d=20:00"]

    assert seed.main(args) == 0
    document = _read_master(root)
    long_term = next(entry for entry in document["entries"] if entry["id"] == "lt_soak_7d")
    assert long_term["schedule"] == {"kind": "daily", "at": "20:00"}
    assert long_term["status"] == "active"
    assert long_term["next_check"] == "2099-01-02"
    assert long_term["legacy_long_task_id"] == "lt_soak_7d"

    forced = args + ["--force", "--expected-version", "1"]
    assert seed.main(forced) == 0
    assert _read_master(root)["version"] == 2
    assert len(_read_master(root)["entries"]) == 18
