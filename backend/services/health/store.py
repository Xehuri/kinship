# -*- coding: utf-8 -*-
"""
健康数据分片存储（H1 暗接入骨架）。

依据 health-data-source-architecture.md 第 5 节：
  - 按 (user_id, date) 粒度 threading.RLock 串行化读-改-写（创建字典由一把创建锁保护）
  - 崩溃安全：同目录临时文件 + os.replace 原子替换（同盘）
  - 同 t 样本后写覆盖先写（与既有单文件实现的合并语义一致）
  - device label 缺省时保留已存标签，绝不因不传而清空
    （修复 health_storage.py:162 一类"不传即清空"的隐患；本模块不 import、
    不修改该文件，保持暗接入零行为变更）
  - total_steps 在写入/导出时按样本增量求和（绝不取末值、绝不差分）
  - 派生兼容视图（legacy health.json）历史上只由本类 export_legacy 写出；
    P2-V9 起新写链已退役（生产写路径不再调用），函数保留供迁移工具与
    历史读路径语义依赖，派生文件转为"历史日只读存量"
  - 懒引导（H2 正确性守卫）：write / export_legacy 进锁后，若 phone+cloud 分片
    全部缺失而 legacy 派生视图已有数据，先一次性把 legacy 内容导入 phone 分片，
    再执行正常的合并/导出 —— 保证切换后「首次同步」不清空历史 daily/{date}/health.json
    （分片一旦存在即永久跳过，每个 (user_id,date) 至多种子一次；种子与后续写入
    同持一把 (user_id,date) RLock，并发首同步下后到者见分片存在直接跳过）

H1 不接线任何路由/配置：构造与测试一律显式传 data_root。
"""
import json
import logging
import os
import tempfile
import threading
import time
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, Optional

from .models import (
    DailySummary,
    DeviceRef,
    HealthBatch,
    HealthSample,
    SleepData,
    SleepSegment,
    sleep_session_key,
)
from .paths import legacy_path, shard_path

logger = logging.getLogger(__name__)

# 东八区（与既有健康存储的时区保持一致）
_CST = timezone(timedelta(hours=8))

# 导出合并时的源顺序：cloud 先、phone 后（同 t 时 phone 覆盖 cloud）
_MERGE_ORDER = ("cloud", "phone")

# 懒引导用的反向映射：Android 数字编码 -> canonical 枚举。
# 与 health_storage._stage_to_enum 同口径（本包不 import 该文件，按同一份
# 架构文档第 9 节源 A 映射复制，保证 round-trip 一致）
_STAGE_CODE_TO_ENUM = {2: "deep", 3: "light", 4: "rem", 5: "awake"}
_STAGE_ENUMS = {"deep", "light", "rem", "awake", "unknown"}


def _epoch_to_iso(ts: int) -> str:
    """epoch 秒 -> 东八区可读时间（yyyy-MM-dd HH:mm:ss）。"""
    try:
        return datetime.fromtimestamp(ts, _CST).strftime("%Y-%m-%d %H:%M:%S")
    except (ValueError, OSError, OverflowError, TypeError):
        return str(ts)


def _epoch_to_hm(ts: Any) -> Optional[str]:
    """epoch 秒 -> 东八区 HH:MM（legacy stages 的 t 字段格式）；非法时间返回 None。"""
    if not isinstance(ts, (int, float)):
        return None
    try:
        return datetime.fromtimestamp(ts, _CST).strftime("%H:%M")
    except (ValueError, OSError, OverflowError, TypeError):
        return None


def _legacy_stage_to_enum(raw: Any) -> str:
    """Android 数字编码 / 枚举字符串 -> canonical 枚举（与 health_storage._stage_to_enum 同口径）。"""
    if isinstance(raw, bool):
        return "unknown"
    if isinstance(raw, int):
        return _STAGE_CODE_TO_ENUM.get(raw, "unknown")
    if isinstance(raw, str):
        s = raw.strip().lower()
        if s in _STAGE_ENUMS:
            return s
        if s.isdigit():
            return _STAGE_CODE_TO_ENUM.get(int(s), "unknown")
    return "unknown"


def _hm_to_epoch(hm: Any, date_str: str) -> Optional[int]:
    """legacy stages 的 "HH:mm" 锚定到指定日期（东八区）转 epoch 秒；无法解析返回 None。"""
    if not isinstance(hm, str):
        return None
    try:
        dt = datetime.strptime(f"{date_str} {hm.strip()}", "%Y-%m-%d %H:%M")
    except ValueError:
        return None
    return int(dt.replace(tzinfo=_CST).timestamp())


def _legacy_sleep_to_canonical(
    sleep_payload: Dict[str, Any], anchor_date: str
) -> Optional[SleepData]:
    """legacy sleep_data dict -> canonical SleepData（与 health_storage._build_sleep 同口径）。

    stages 适配：legacy {"t":"HH:mm","stage":2/3/4/5|枚举} -> SleepSegment
    {start_ts(epoch，锚定日期), stage(枚举), duration_min}；
    duration_min 由下一段 start_ts 推算（末段为 0）。
    """
    if not sleep_payload:
        return None
    parsed = []
    for st in sleep_payload.get("stages") or []:
        if not isinstance(st, dict):
            continue
        ts = _hm_to_epoch(st.get("t"), anchor_date)
        if ts is None:
            continue
        parsed.append((ts, _legacy_stage_to_enum(st.get("stage"))))

    segments: list = []
    for i, (ts, stage) in enumerate(parsed):
        if i + 1 < len(parsed):
            duration = max(0, (parsed[i + 1][0] - ts)) // 60
        else:
            duration = 0
        segments.append(
            SleepSegment(
                start_ts=int(ts), stage=str(stage), duration_min=int(duration)
            )
        )

    return SleepData(
        duration_min=sleep_payload.get("duration_min"),
        deep_min=sleep_payload.get("deep_min"),
        light_min=sleep_payload.get("light_min"),
        rem_min=sleep_payload.get("rem_min"),
        awake_min=sleep_payload.get("awake_min"),
        wakeup_time=sleep_payload.get("wakeup_time"),
        segments=segments,
    )


# 多会话合并时由主觉统一重建的顶层标量键
_SLEEP_TOP_LEVEL_KEYS = (
    "duration_min",
    "deep_min",
    "light_min",
    "rem_min",
    "awake_min",
    "awake_count",
    "bedtime",
    "wakeup_time",
)

# 会话标量 -> SleepData 顶层键映射
_SESSION_TO_TOP_LEVEL = (
    ("duration", "duration_min"),
    ("deep", "deep_min"),
    ("light", "light_min"),
    ("rem", "rem_min"),
    ("awake", "awake_min"),
    ("awake_count", "awake_count"),
    ("bedtime", "bedtime"),
    ("wakeup", "wakeup_time"),
)


def _session_duration(session: Dict[str, Any]) -> int:
    """会话时长：duration 优先，缺失时按非 awake 阶段段合计。"""
    value = session.get("duration")
    if value is not None:
        try:
            return int(value)
        except (TypeError, ValueError):
            pass
    total = 0
    for stage in session.get("stages") or []:
        if not isinstance(stage, dict) or stage.get("stage") == "awake":
            continue
        try:
            total += int(stage.get("duration_min") or 0)
        except (TypeError, ValueError):
            continue
    return total


def _merge_sessions(existing: list, new: list) -> list:
    """按 sleep_session_key 合并会话：同键新值覆盖，无键会话保留。"""
    unkeyed: list = []
    keyed: Dict[tuple, Dict[str, Any]] = {}
    for session in list(existing or []) + list(new or []):
        if not isinstance(session, dict):
            continue
        key = sleep_session_key(session)
        if key is None:
            unkeyed.append(dict(session))
        else:
            keyed[key] = dict(session)
    merged = unkeyed + list(keyed.values())
    merged.sort(
        key=lambda s: (
            s.get("wakeup") is None,
            s.get("wakeup") or 0,
            s.get("bedtime") or 0,
        )
    )
    return merged


def _primary_session(sessions: list) -> Optional[dict]:
    """主觉会话：时长最长，同长时起床更晚者优先。"""
    if not sessions:
        return None
    return max(
        sessions,
        key=lambda s: (_session_duration(s), s.get("wakeup") or 0),
    )


def _top_level_from_session(session: Dict[str, Any]) -> Dict[str, Any]:
    """会话标量 -> SleepData 顶层键（None 省略）。"""
    out: Dict[str, Any] = {}
    for src, dst in _SESSION_TO_TOP_LEVEL:
        value = session.get(src)
        if value is not None:
            out[dst] = value
    return out


def _top_level_key(existing: Dict[str, Any]) -> Optional[tuple]:
    """已存顶层标量拼成会话形状后取键，用于校验阶段段归属。"""
    session = {
        "bedtime": existing.get("bedtime"),
        "wakeup": existing.get("wakeup_time"),
        "duration": existing.get("duration_min"),
        "deep": existing.get("deep_min"),
        "light": existing.get("light_min"),
        "rem": existing.get("rem_min"),
        "awake": existing.get("awake_min"),
    }
    return sleep_session_key(session)


_EMPTY_SLEEP_VALUES = (None, "", [], {})


def _merge_sleep_data(existing: Dict[str, Any], new: Dict[str, Any]) -> Dict[str, Any]:
    """睡眠数据合并：有会话时按会话键合并，顶层标量由主觉重建。

    phone/legacy 载荷（无 sleep_sessions 键）维持字段级 update 语义；
    仅小睡重拉不得覆盖已存 legacy 主觉标量（LEGACY NAP GUARD）。

    2026-11-01 本地补丁（数据丢失修复）：新载荷里的空值（None / "" / [] / {}）
    一律不参与覆盖。此前「只同步了步数、sleep 字段为空」的推送或云端回补会把
    当天已存的睡眠数据整段抹掉，且无日志（详见 bug 报告 bug-健康分片合并清空
    睡眠数据-20261101.md）。
    """
    existing = existing or {}
    if not new:
        return existing

    # 丢弃空值字段，避免空载荷覆盖既有非空数据
    cleaned = {
        key: value for key, value in new.items()
        if value not in _EMPTY_SLEEP_VALUES
    }
    if not cleaned:
        return dict(existing)

    if "sleep_sessions" not in cleaned:
        merged = dict(existing)
        merged.update(cleaned)
        return merged

    merged_sessions = _merge_sessions(
        existing.get("sleep_sessions") or [],
        cleaned.get("sleep_sessions") or [],
    )
    if not merged_sessions:
        # 合并结果为空：保留既存，绝不用空结果覆盖
        return dict(existing)

    primary = _primary_session(merged_sessions)
    existing_duration = existing.get("duration_min")
    if not existing.get("sleep_sessions") and existing_duration is not None:
        try:
            existing_duration_int = int(existing_duration)
        except (TypeError, ValueError):
            existing_duration_int = None
        if (
            existing_duration_int is not None
            and _session_duration(primary) < existing_duration_int
        ):
            guarded = dict(existing)
            guarded["sleep_sessions"] = merged_sessions
            return guarded

    out = dict(existing)
    for key, value in cleaned.items():
        if key != "sleep_sessions":
            out[key] = value
    for key in _SLEEP_TOP_LEVEL_KEYS:
        out.pop(key, None)
    out.update(_top_level_from_session(primary))
    out["sleep_sessions"] = merged_sessions

    primary_stages = primary.get("stages")
    if primary_stages:
        out["stages"] = [
            dict(stage) for stage in primary_stages if isinstance(stage, dict)
        ]
    elif existing.get("stages") and _top_level_key(existing) == sleep_session_key(primary):
        out["stages"] = existing["stages"]
    else:
        out.pop("stages", None)
    return out


def _to_legacy_stages(stages: list) -> list:
    """阶段段 -> legacy {t: HH:MM, stage}；已是 legacy 形状的 t 原样保留。"""
    converted = []
    for seg in stages:
        if not isinstance(seg, dict):
            continue
        hm = seg.get("t")
        if hm is None:
            hm = _epoch_to_hm(seg.get("start_ts"))
        if hm is None:
            continue
        converted.append({"t": hm, "stage": seg.get("stage", "unknown")})
    return converted


def _atomic_write_json(path: str, payload: Dict[str, Any]) -> None:
    """临时文件写入 + os.replace 原子替换（同目录保证同盘）。"""
    directory = os.path.dirname(path)
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=directory, suffix=".tmp", prefix=".health_")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        os.replace(tmp, path)
    except BaseException:
        # 失败时清理临时文件，避免残留
        try:
            if os.path.exists(tmp):
                os.unlink(tmp)
        except OSError:
            pass
        raise


class HealthStore:
    """按 (user_id, date, source) 分片的健康数据存储。"""

    def __init__(self, data_root: str, primary_user: Optional[str] = None):
        self.data_root = data_root
        # 主用户（方案第 8 节 health.primary_user）；H1 仅保留引用，不接线
        self.primary_user = primary_user
        self._locks: Dict[Any, threading.RLock] = {}
        self._legacy_locks: Dict[str, threading.RLock] = {}
        self._creation_lock = threading.Lock()

    def _lock_for(self, user_id: str, date: str) -> threading.RLock:
        """获取 (user_id, date) 粒度的 RLock（惰性创建，创建锁保护字典）。"""
        key = (user_id, date)
        with self._creation_lock:
            lock = self._locks.get(key)
            if lock is None:
                lock = threading.RLock()
                self._locks[key] = lock
            return lock

    def _legacy_lock_for(self, date: str) -> threading.RLock:
        """派生视图按 date 粒度的写锁（叶锁，永不嵌套其他锁）。"""
        with self._creation_lock:
            lock = self._legacy_locks.get(date)
            if lock is None:
                lock = threading.RLock()
                self._legacy_locks[date] = lock
            return lock

    @staticmethod
    def _load_raw(path: str, kind: str = "分片") -> Dict[str, Any]:
        """读取 JSON dict；缺失或损坏返回 {}（与既有实现的容错口径一致）。"""
        if not os.path.exists(path):
            return {}
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (json.JSONDecodeError, OSError) as exc:
            logger.warning("[HealthStore] %s读取失败，按空处理: %s (%s)", kind, path, exc)
            return {}
        return data if isinstance(data, dict) else {}

    @staticmethod
    def _merge_shard(existing: Dict[str, Any], new: Dict[str, Any]) -> Dict[str, Any]:
        """字段级合并：同 t 后写覆盖；daily/sleep/battery 按键缺省保留旧值。"""
        payload = dict(existing)
        # 身份字段以新批次为准
        payload["source"] = new["source"]
        payload["user_id"] = new["user_id"]
        payload["date"] = new["date"]
        # fetched_at 缺省时保留已存值
        if "fetched_at" in new:
            payload["fetched_at"] = new["fetched_at"]

        # device：label 缺省时保留已存标签（绝不因不传而清空）
        merged_device = dict(new["device"])
        if "label" not in merged_device:
            old_label = (existing.get("device") or {}).get("label")
            if old_label is not None:
                merged_device["label"] = old_label
        payload["device"] = merged_device

        # samples：同 t 覆盖（批内与跨批一致），按 t 排序
        samples_by_t: Dict[Any, Dict[str, Any]] = {}
        for s in existing.get("samples") or []:
            if isinstance(s, dict) and "t" in s:
                samples_by_t[s["t"]] = s
        for s in new.get("samples") or []:
            if isinstance(s, dict) and "t" in s:
                samples_by_t[s["t"]] = s  # 后写覆盖先写
        merged_samples = [samples_by_t[k] for k in sorted(samples_by_t)]
        payload["samples"] = merged_samples

        # battery_levels：提供才合并（同 t 覆盖）；缺省保留已存
        if "battery_levels" in new:
            batt_by_t: Dict[Any, Dict[str, Any]] = {}
            for b in existing.get("battery_levels") or []:
                if isinstance(b, dict) and "t" in b:
                    batt_by_t[b["t"]] = b
            for b in new["battery_levels"] or []:
                if isinstance(b, dict) and "t" in b:
                    batt_by_t[b["t"]] = b
            payload["battery_levels"] = [batt_by_t[k] for k in sorted(batt_by_t)]

        # daily_summary：提供才字段级 update；total_steps 有增量即按求和刷新
        if "daily_summary" in new:
            merged_daily = dict(existing.get("daily_summary") or {})
            merged_daily.update(new["daily_summary"])
            payload["daily_summary"] = merged_daily
        if payload.get("daily_summary"):
            step_vals = [
                s["steps"] for s in merged_samples if s.get("steps") is not None
            ]
            if step_vals:
                payload["daily_summary"]["total_steps"] = sum(step_vals)

        # sleep_data：提供才合并（多会话键控合并；无会话载荷仍为字段级 update）
        # 2026-11-01 本地补丁：空字典视为「未提供」，不进入合并，避免清空既存睡眠数据
        if new.get("sleep_data"):
            payload["sleep_data"] = _merge_sleep_data(
                existing.get("sleep_data") or {}, new["sleep_data"]
            )

        return payload

    def _bootstrap_from_legacy_locked(self, user_id: str, date: str) -> bool:
        """懒引导：legacy 派生视图 -> phone 分片的一次性种子（调用方须已持 (user_id,date) 锁）。

        触发条件（全部满足才执行）：
          0) （H6 多用户）user_id 为主用户或未配置 primary_user —— legacy
             派生视图是主用户兼容视图，非主用户首写绝不能把主用户数据
             种子进自己的分片（否则跨用户串数据，A5 隔离失效）；
          1) phone 与 cloud 分片文件均不存在（分片尚未成为真源）；
          2) legacy daily/{date}/health.json 存在且 samples 非空（有历史数据可导入）。
        种子把 legacy 条目拆回 canonical 形状写入 phone 分片（battery 条目拆回
        battery_levels，stages 按 Android 数字编码映射为枚举），随后正常的
        incoming write / export 都以分片为真源合并 —— 历史数据不丢、单一写者不变。
        分片文件一旦落盘，后续调用因条件 1 不满足而永久跳过（每 (user_id,date)
        至多种子一次；同锁串行下并发首同步的后到者直接跳过）。
        返回是否执行了种子写入。
        """
        if self.primary_user and user_id != self.primary_user:
            # H6：非主用户跳过懒引导（条件 0），直接空分片起步
            return False
        phone_path = shard_path(self.data_root, user_id, date, "phone")
        cloud_path = shard_path(self.data_root, user_id, date, "cloud")
        if os.path.exists(phone_path) or os.path.exists(cloud_path):
            return False

        legacy_raw = self._load_raw(legacy_path(self.data_root, date), kind="legacy 派生视图")
        entries = legacy_raw.get("samples") or []
        if not entries:
            return False

        # 条目拆分：{t, ..., battery} 电量条目回拆 battery_levels，其余进 samples
        samples: list = []
        battery: list = []
        for entry in entries:
            if not isinstance(entry, dict) or "t" not in entry:
                continue
            if "battery" in entry:
                batt: Dict[str, Any] = {"t": entry["t"]}
                if entry["battery"] is not None:
                    batt["level"] = entry["battery"]
                battery.append(batt)
            else:
                samples.append(
                    HealthSample(
                        t=entry["t"],
                        hr=entry.get("hr"),
                        steps=entry.get("steps"),
                        stress=entry.get("stress"),
                        spo2=entry.get("spo2"),
                        resting_hr=entry.get("resting_hr"),
                        calories=entry.get("calories"),
                    )
                )
        if not samples and not battery:
            return False

        legacy_daily = legacy_raw.get("daily_summary")
        daily = (
            DailySummary.from_dict(legacy_daily)
            if isinstance(legacy_daily, dict) and legacy_daily
            else None
        )
        legacy_sleep = legacy_raw.get("sleep_data")
        sleep = (
            _legacy_sleep_to_canonical(legacy_sleep, date)
            if isinstance(legacy_sleep, dict) and legacy_sleep
            else None
        )
        device_name = legacy_raw.get("device_name")

        seed = HealthBatch(
            source_id="phone",
            user_id=user_id,
            device=DeviceRef(
                device_id="legacy",
                label=device_name,  # None 时省略键 -> 与既有 label 保留语义一致
                kind="phone",
                owner_user_id=user_id,
                source_id="phone",
            ),
            date=date,
            samples=samples,
            daily_summary=daily,
            sleep=sleep,
            battery=battery,
            fetched_at=int(time.time()),
        )
        payload = self._merge_shard(self._load_raw(phone_path), seed.to_dict())
        _atomic_write_json(phone_path, payload)
        logger.info(
            "[HealthStore] 懒引导: legacy %s 条目种子入 phone 分片（%s, samples=%d, battery=%d）",
            legacy_path(self.data_root, date), date, len(samples), len(battery),
        )
        return True

    def write(self, batch: HealthBatch) -> str:
        """写入（合并）一个批次到其源分片，返回分片路径。"""
        # 先经路径校验：非法 user_id/date/source 抛 ValueError
        path = shard_path(self.data_root, batch.user_id, batch.date, batch.source_id)
        with self._lock_for(batch.user_id, batch.date):
            # 懒引导与 incoming 写入同锁串行：种子先落盘，incoming 同 t 覆盖种子
            self._bootstrap_from_legacy_locked(batch.user_id, batch.date)
            existing = self._load_raw(path)
            payload = self._merge_shard(existing, batch.to_dict())
            _atomic_write_json(path, payload)
        return path

    def read(self, user_id: str, date: str, source: str) -> Optional[HealthBatch]:
        """读取一个源分片；文件缺失或损坏返回 None。"""
        path = shard_path(self.data_root, user_id, date, source)
        with self._lock_for(user_id, date):
            if not os.path.exists(path):
                return None
            raw = self._load_raw(path)
            if not raw or "source" not in raw:
                return None
            return HealthBatch.from_dict(raw)

    def export_legacy(self, user_id: str, date: str) -> str:
        """写出处派生兼容视图 daily/{date}/health.json（P2-V9 起新写链已退役）。

        仅存使用方 = 一次性迁移工具 scripts/migrate_health_store.py 与历史读路径
        语义（懒引导 _bootstrap_from_legacy_locked 依赖其存在性契约）；
        生产写链（save_health_data / /sync / 云直写任务）自 V9 起不再调用本方法。
        函数本体保留：勿删（迁移工具/懒引导/回滚窗口依赖）。
        """
        # 派生兼容视图：除迁移工具外禁止任何其他代码直写 daily/{date}/health.json
        target = legacy_path(self.data_root, date)
        with self._lock_for(user_id, date):
            # 懒引导兜底：write 已在同锁内种子过则此处秒跳（分片存在）；
            # 若 legacy 有数据而分片全缺（如仅 export 无 write 的调用序），
            # 先种子再合并导出，避免原子替换清空历史数据
            self._bootstrap_from_legacy_locked(user_id, date)
            payload = self._compose_legacy_locked(user_id, date)
            with self._legacy_lock_for(date):
                _atomic_write_json(target, payload)
        return target

    def read_view(self, user_id: str, date: str) -> Optional[Dict[str, Any]]:
        """只读合成某用户的派生视图形状（H6 查询路径，A5 物理隔离）。

        只合并 (user_id, date) 自己的 phone+cloud 分片，不触发懒引导、不写盘。
        分片全缺返回 None（调用方决定是否回落派生视图文件）。
        """
        if not any(
            os.path.exists(shard_path(self.data_root, user_id, date, source))
            for source in ("phone", "cloud")
        ):
            return None
        with self._lock_for(user_id, date):
            return self._compose_legacy_locked(user_id, date)

    def _compose_legacy_locked(self, user_id: str, date: str) -> Dict[str, Any]:
        """合并两源分片为派生视图 payload（调用方须持 (user_id,date) 锁；只读）。

        与 export_legacy 的落盘形状逐键一致（date/updated_at/samples/
        daily_summary/sleep_data/device_name），read_view 与导出共用同一口径。
        """
        merged_samples: Dict[Any, Dict[str, Any]] = {}
        daily: Dict[str, Any] = {}
        sleep: Dict[str, Any] = {}
        battery: Dict[Any, Dict[str, Any]] = {}
        device_label = None
        for source in _MERGE_ORDER:
            raw = self._load_raw(
                shard_path(self.data_root, user_id, date, source)
            )
            if not raw:
                continue
            for s in raw.get("samples") or []:
                if isinstance(s, dict) and "t" in s:
                    merged_samples[s["t"]] = s
            daily.update(raw.get("daily_summary") or {})
            sleep.update(raw.get("sleep_data") or {})
            for b in raw.get("battery_levels") or []:
                if isinstance(b, dict) and "t" in b:
                    battery[b["t"]] = b
            label = (raw.get("device") or {}).get("label")
            if label is not None:
                device_label = label  # phone 后合并，覆盖 cloud 的标签

        # total_steps：只要样本含增量就按求和口径落盘（绝不取末值、绝不差分）
        step_vals = [
            s["steps"] for s in merged_samples.values() if s.get("steps") is not None
        ]
        if step_vals:
            daily["total_steps"] = sum(step_vals)

        # legacy samples：补 t_iso；电量条目并入 samples（与既有单文件形状一致）
        legacy_samples = []
        for t in sorted(merged_samples):
            entry = dict(merged_samples[t])
            entry["t_iso"] = _epoch_to_iso(t)
            legacy_samples.append(entry)
        for t in sorted(battery):
            entry = {"t": t, "t_iso": _epoch_to_iso(t)}
            level = battery[t].get("level")
            if level is not None:
                entry["battery"] = level
            legacy_samples.append(entry)
        legacy_samples.sort(key=lambda x: x["t"])

        # sleep stages 转换为 legacy 的 {t: "HH:mm", stage} 形状
        # 派生视图输出字符串枚举（读取端 fact_extractor== 'awake' 依赖；
        # Android 客户端已做码表映射，后端收到的就是字符串）。
        # H4 的 OQ2 曾误映射回数字编码，破坏 109 天语料的字节兼容，
        # 此处按读取端 ground truth 输出 canonical 枚举字符串
        legacy_sleep = dict(sleep)
        stages = legacy_sleep.get("stages")
        if isinstance(stages, list):
            legacy_sleep["stages"] = _to_legacy_stages(stages)

        # 会话阶段同样转换；items 原样保留
        sessions = legacy_sleep.get("sleep_sessions")
        if isinstance(sessions, list):
            converted_sessions = []
            for session in sessions:
                if not isinstance(session, dict):
                    continue
                rebuilt = dict(session)
                session_stages = rebuilt.get("stages")
                if isinstance(session_stages, list):
                    rebuilt["stages"] = _to_legacy_stages(session_stages)
                converted_sessions.append(rebuilt)
            legacy_sleep["sleep_sessions"] = converted_sessions

        return {
            "date": date,
            "updated_at": datetime.now(_CST).isoformat(),
            "samples": legacy_samples,
            "daily_summary": daily,
            "sleep_data": legacy_sleep,
            "device_name": device_label,  # 无数据时为 null（与既有实现一致）
        }
