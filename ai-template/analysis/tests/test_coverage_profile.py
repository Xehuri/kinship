"""coverage.yaml 契约测试：默认 merged_7、可选 merged_6、夜窗不得留洞。"""

from pathlib import Path

import pytest

yaml = pytest.importorskip("yaml", reason="PyYAML 不可用，无法解析 coverage.yaml")

COVERAGE_PATH = Path(__file__).resolve().parents[2] / "data" / "plan" / "coverage.yaml"

MERGED_7 = {
    "cov-00": ("22:00~00:00", "00:00", "previous_day"),
    "cov-06": ("00:00~06:00", "06:00", "today"),
    "cov-08": ("06:00~08:00", "08:00", "today"),
    "cov-12": ("08:00~12:00", "12:00", "today"),
    "cov-16": ("12:00~16:00", "16:00", "today"),
    "cov-20": ("16:00~20:00", "20:00", "today"),
    "cov-22": ("20:00~22:00", "22:00", "today"),
}

MERGED_6 = {
    "cov-night": ("22:00~06:00", "06:00", "previous_day"),
    "cov-08": ("06:00~08:00", "08:00", "today"),
    "cov-12": ("08:00~12:00", "12:00", "today"),
    "cov-16": ("12:00~16:00", "16:00", "today"),
    "cov-20": ("16:00~20:00", "20:00", "today"),
    "cov-22": ("20:00~22:00", "22:00", "today"),
}

NIGHT_MINUTES = set(range(22 * 60, 24 * 60)) | set(range(0, 6 * 60))


def _load() -> dict:
    assert COVERAGE_PATH.is_file(), f"缺少契约文件: {COVERAGE_PATH}"
    doc = yaml.safe_load(COVERAGE_PATH.read_text(encoding="utf-8"))
    assert isinstance(doc, dict), "coverage.yaml 顶层必须是 mapping"
    return doc


def _validate_profile(doc: dict, name: str, expected: dict) -> dict:
    profiles = doc.get("profiles")
    if not isinstance(profiles, dict) or name not in profiles:
        raise ValueError(f"缺少 profile: {name}")
    checkpoints = profiles[name].get("checkpoints")
    if not isinstance(checkpoints, dict):
        raise ValueError(f"{name}.checkpoints 必须是按 ID 索引的 mapping")
    missing = [cid for cid in expected if cid not in checkpoints]
    if missing:
        raise ValueError(f"{name} 缺少检查点: {', '.join(missing)}")
    extra = [cid for cid in checkpoints if cid not in expected]
    if extra:
        raise ValueError(f"{name} 存在未定义检查点: {', '.join(extra)}")
    for cid, cp in checkpoints.items():
        for field in ("window", "trigger", "target_date"):
            if field not in cp:
                raise ValueError(f"{name}.{cid} 缺少字段: {field}")
    return checkpoints


def _to_minutes(hhmm: str) -> int:
    hours, minutes = hhmm.split(":")
    return int(hours) * 60 + int(minutes)


def _window_minutes(window: str) -> set:
    start_text, end_text = window.split("~")
    start, end = _to_minutes(start_text), _to_minutes(end_text)
    if end <= start:
        end += 24 * 60
    return {minute % (24 * 60) for minute in range(start, end)}


def test_schema_and_default_profile():
    doc = _load()
    assert doc["schema"] == 1
    assert doc["default"] == "merged_7"
    assert doc["profiles"]["merged_7"]["default"] is True
    assert doc["profiles"]["merged_6"]["default"] is False


def test_merged_7_has_seven_checkpoints_and_contract():
    doc = _load()
    checkpoints = _validate_profile(doc, "merged_7", MERGED_7)
    assert len(checkpoints) == 7
    for cid, (window, trigger, target_date) in MERGED_7.items():
        assert checkpoints[cid]["window"] == window, cid
        assert checkpoints[cid]["trigger"] == trigger, cid
        assert checkpoints[cid]["target_date"] == target_date, cid
    assert checkpoints["cov-00"]["target_date"] == "previous_day"
    assert checkpoints["cov-06"]["target_date"] == "today"


def test_merged_6_has_six_checkpoints_and_night_merge():
    doc = _load()
    checkpoints = _validate_profile(doc, "merged_6", MERGED_6)
    assert len(checkpoints) == 6
    night = checkpoints["cov-night"]
    assert night["window"] == "22:00~06:00"
    assert night["trigger"] == "06:00"
    assert night["target_date"] == "previous_day"
    for cid, (window, trigger, target_date) in MERGED_6.items():
        assert checkpoints[cid]["window"] == window, cid
        assert checkpoints[cid]["trigger"] == trigger, cid
        assert checkpoints[cid]["target_date"] == target_date, cid


@pytest.mark.parametrize("profile", ["merged_7", "merged_6"])
def test_no_profile_leaves_night_gap(profile):
    doc = _load()
    expected = MERGED_7 if profile == "merged_7" else MERGED_6
    checkpoints = _validate_profile(doc, profile, expected)
    covered = set()
    for cp in checkpoints.values():
        covered |= _window_minutes(cp["window"])
    assert covered == set(range(24 * 60)), f"{profile} 存在未覆盖时段"
    assert NIGHT_MINUTES <= covered, f"{profile} 夜窗 22:00~06:00 有空洞"


def test_missing_checkpoint_raises_clear_value_error():
    doc = _load()
    broken = {
        "profiles": {
            "merged_7": {
                "checkpoints": {
                    cid: cp
                    for cid, cp in doc["profiles"]["merged_7"]["checkpoints"].items()
                    if cid != "cov-00"
                }
            }
        }
    }
    with pytest.raises(ValueError, match="cov-00"):
        _validate_profile(broken, "merged_7", MERGED_7)
