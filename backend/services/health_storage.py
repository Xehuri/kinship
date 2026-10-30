"""
健康数据存储服务（H2 薄外观）

按天存储用户健康数据（心率、步数、压力、血氧、睡眠等）。
H2 起写路径切换为 HealthStore：源分片为唯一真源。
P2-V9：派生兼容视图 daily/{date}/health.json 的 export_legacy
"每次写强制双落"已退役——新写只落源分片，不再产生/更新派生文件；
派生文件物理保留（历史日懒引导种子源 + 查询回落兜底源），
物理清理另立决策点（计划 §遗留决策点④）。

P1-V7 分组合一（历史沿革）：save_health_data 不再自带分组代码，改调
services.health.sources.phone_push.batches_from_request（push 方向分组
唯一实现）后接 store.write —— 与 /api/health/sync phone/cloud 两支
同一条 normalize→store 路径。分组/睡眠归一原语已迁往 phone_push。

P2-V8 云直写（历史沿革）：get_health_store() 转为公共访问器，云拉取任务
子进程直写 cloud 分片（当时曾同步 export_legacy 刷新派生视图；V9 起
该双写一并退役）。并发裁定取证见 /tmp/opencode/vunit-V8.md。

目录结构:
    ai/data/users/{user_id}/health/{date}/phone.json   源分片（HealthStore.write）
    ai/data/daily/{date}/health.json                    派生视图（V9 停写：
        仅存 H2~V8 期间的历史日文件，新日期不再产生）

公开签名与响应形状保持 H2 前不变：
    save_health_data / query_health_data / list_health_dates
    响应 {"status":"ok","dates":[...],"stats":{"samples","dates_updated",...}}
"""

import os
import json
import logging
import threading
from typing import Optional, Dict, Any, List
from datetime import datetime, timezone, timedelta

from config.config import get_config
from services.health import HealthStore
from services.health.sources.phone_push import batches_from_request

logger = logging.getLogger(__name__)

# 东八区
_CST = timezone(timedelta(hours=8))
_paths_lock = threading.Lock()
_DATA_BASE = ""


def reload_paths() -> None:
    """按当前配置重算派生视图根目录（配置热重载钩子）。"""
    data_base = os.path.join(get_config().HEALTH_DIR, "daily")
    global _DATA_BASE
    with _paths_lock:
        _DATA_BASE = data_base


reload_paths()

# HealthStore 按 (data_root, primary_user) 缓存（保持 (user,date) 锁跨请求复用）；
# 两者每次调用时从配置读取，primary_user 变更不会复用旧 store。
_store_cache: Dict[tuple[str, str], HealthStore] = {}
_store_cache_lock = threading.Lock()


def get_health_store() -> HealthStore:
    """公共 store 访问器：调用时解析 data_root 并取（或建）HealthStore。

    P2-V8：云拉取任务子进程直写分片经此取 store。注意 RLock 仅在进程内生效——
    直写合法性来自"cloud 分片唯一自动化写者=任务脚本 + 分片同 t 覆盖幂等 +
    os.replace 原子替换"（取证见 /tmp/opencode/vunit-V8.md 并发裁定节）。
    P2-V9：export_legacy 双写退役后，跨进程共享面仅剩各自的源分片，
    派生视图不再被任何新写链触碰。
    """
    cfg = get_config()
    data_root = cfg.DATA_DIR
    primary_user = cfg.HEALTH_PRIMARY_USER or None
    cache_key = (data_root, primary_user or "")
    with _store_cache_lock:
        store = _store_cache.get(cache_key)
        if store is None:
            # H6：接线 health.primary_user（H4a 配置键）——V9 后该配置仍服务于
            # 两处读语义：① 懒引导条件 0（仅主用户可从 legacy 派生文件种子）；
            # ② 派生回落读权限（_may_read_derived，防跨用户泄露）。
            # （V9 前此处还决定"派生视图导出给谁"，双写链已退役）
            store = HealthStore(data_root=data_root, primary_user=primary_user)
            _store_cache[cache_key] = store
        return store


def _date_dir(date_str: str) -> str:
    """确保某天的数据目录存在"""
    path = os.path.join(_DATA_BASE, date_str)
    os.makedirs(path, exist_ok=True)
    return path


def _today_str() -> str:
    """获取今天的日期字符串（东八区）"""
    return datetime.now(_CST).strftime("%Y-%m-%d")


def _date_to_path(date_str: str, user_id: str = "default") -> str:
    """获取某天的健康数据文件路径"""
    return os.path.join(_date_dir(date_str), "health.json")


def save_health_data(
    samples: List[Dict[str, Any]],
    daily_summary: Optional[Dict[str, Any]] = None,
    battery_levels: Optional[List[Any]] = None,
    sleep_data: Optional[Dict[str, Any]] = None,
    user_id: str = "default",
    device_name: Optional[str] = None,
    source: str = "phone",
    device_id: Optional[str] = None,
    explicit_date: Optional[str] = None,
) -> Dict[str, Any]:
    """
    保存健康数据到对应日期的文件（按样本时间戳归属日期）。

    P1-V7 合一入口：分组归一改调 phone_push.batches_from_request
    （push 方向唯一实现，与 /api/health/sync 两支同一条路径），
    本函数不再自带分组代码；随后仅 HealthStore.write（源分片）。
    P2-V9：export_legacy 派生视图双写已退役，本函数不再产生
    daily/{date}/health.json。

    Args:
        samples: 时间序列数据点列表 [{t, hr, steps, stress, spo2}, ...]
        daily_summary: 每日汇总 {steps, hr_resting, hr_avg, hr_max, ...}
        battery_levels: 电量记录 [{t, level}, ...]
        sleep_data: 睡眠数据 {duration, deep, light, rem, ...}
        user_id: 用户标识
        device_name: 设备名称（如 Mi Band 8 Pro）
        source: 数据源（phone/cloud，决定分片归属；缺省 phone——保持
            H2 前直调方（脚本/测试）零感知）
        device_id: 设备标识（仅 cloud 生效；phone 分支按现行口径忽略，
            device_id 兜底 device_name or "phone"）
        explicit_date: 显式归属日期（仅云补拉使用；phone 现行不传）

    Returns:
        {"status": "ok", "dates": [...], "stats": {...}}
    """
    writer = user_id or "default"

    # 1. 分组归一（唯一实现处：phone_push.batches_from_request；
    #    battery_levels 并入同日期组，store 合并语义自持）
    payload: Dict[str, Any] = {
        "samples": samples,
        "battery_levels": battery_levels,
        "daily_summary": daily_summary,
        "sleep_data": sleep_data,
        "device_name": device_name,
        "device_id": device_id,
        "source": source,
    }
    batches = batches_from_request(payload, user_id=writer, explicit_date=explicit_date)

    # 2. 逐日期写源分片（P2-V9：唯一落点。派生视图双写已退役，
    #    写链不再调用 store.export_legacy）
    store = get_health_store()
    stats: Dict[str, Any] = {"samples": 0, "dates_updated": []}
    for batch in batches:
        store.write(batch)

        date_str = batch.date
        stats["samples"] += len(batch.samples) + len(batch.battery)
        stats["dates_updated"].append(date_str)

        # 构建详细日志：HR 范围、步数、睡眠
        log_detail = (
            f"[Health] 已保存 {date_str}: {len(batch.samples)} 条样本"
            f"（源分片经 HealthStore）"
        )
        if device_name:
            log_detail += f" device={device_name}"
        hr_vals = [s.hr for s in batch.samples if s.hr is not None]
        steps_vals = [s.steps for s in batch.samples if s.steps is not None]
        if hr_vals:
            log_detail += f" hr={min(hr_vals)}-{max(hr_vals)} ({len(hr_vals)}pts)"
        if steps_vals:
            log_detail += f" steps={steps_vals[-1]}"
        if batch.daily_summary is not None:
            log_detail += f" daily: {json.dumps(daily_summary, ensure_ascii=False)}"
        if batch.sleep is not None and sleep_data:
            log_detail += (
                f" sleep: dur={sleep_data.get('duration_min', '?')}min"
                f" deep={sleep_data.get('deep_min', '?')}"
                f" light={sleep_data.get('light_min', '?')}"
                f" rem={sleep_data.get('rem_min', '?')}"
            )
        logger.info(log_detail)

    # 3. P2-V9：原"派生视图 export_legacy 每次写强制双落"退役——
    #    新写只落源分片；daily/{date}/health.json 仅存历史日文件，
    #    由查询回落/懒引导只读消费（写链恢复双落必须重走读方核验）。
    stats["dates"] = stats["dates_updated"]
    return {"status": "ok", "dates": stats["dates_updated"], "stats": stats}


def _may_read_derived(store: HealthStore, user_id: str) -> bool:
    """是否允许回落读取共享派生视图 daily/{date}/health.json（H6/A5）。

    派生视图是主用户兼容视图、无用户维度：仅主用户（或未配置主用户时的
    任意用户）可回落读取，其他用户分片缺失即视为无数据 —— 防跨用户泄露。

    P2-V9 语义注记：新写链已不再产生该文件，此回落仅覆盖两类历史场景——
    ① 懒引导之前的历史日数据（H2~V8 期间导出的存量文件）；
    ② 迁移工具产出。新日期分片缺失即真无数据（返回 empty 是正确行为）。
    """
    primary = (store.primary_user or "").strip()
    return not primary or user_id == primary


def query_health_data(
    date: Optional[str] = None,
    user_id: str = "default",
) -> Dict[str, Any]:
    """
    查询某天的健康数据。

    Args:
        date: 日期 YYYY-MM-DD，默认今天
        user_id: 用户标识（H6：优先读该用户自己的源分片，A5 物理隔离）

    Returns:
        当日健康数据，或 error/empty
    """
    if date is None:
        date = _today_str()

    # H6：优先只读合成该用户自己的 phone+cloud 分片（不触发懒引导、不写盘）
    store = get_health_store()
    view = store.read_view(user_id, date)
    if view is not None:
        view["status"] = "ok"
        return view

    # 分片全缺：回落派生视图（仅主用户/未配置主用户 —— 防跨用户泄露）。
    # P2-V9：回落仅命中历史日存量文件（H2~V8 导出）；新写不再产生该文件，
    # 新日期走到这里返回 empty 属预期行为。
    if not _may_read_derived(store, user_id):
        return {"status": "empty", "date": date, "message": "无数据"}

    path = _date_to_path(date, user_id)
    if not os.path.exists(path):
        return {"status": "empty", "date": date, "message": "无数据"}

    try:
        with open(path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        data["status"] = "ok"
        return data
    except Exception as e:
        return {"status": "error", "date": date, "message": str(e)}


def list_health_dates(user_id: str = "default") -> List[str]:
    """列出有数据的所有日期（H6：优先列该用户分片日期）"""
    store = get_health_store()

    # 1) 该用户自己的分片日期目录（users/{user}/health/{date}/{source}.json）
    user_health_root = os.path.join(store.data_root, "users", user_id, "health")
    if os.path.isdir(user_health_root):
        dates: List[str] = []
        for d in sorted(os.listdir(user_health_root)):
            ddir = os.path.join(user_health_root, d)
            if not os.path.isdir(ddir):
                continue
            if any(
                os.path.exists(os.path.join(ddir, f"{source}.json"))
                for source in ("phone", "cloud")
            ):
                dates.append(d)
        if dates:
            return dates

    # 2) 用户无分片：回落派生视图目录（仅主用户/未配置主用户，防跨用户泄露）。
    #    P2-V9：派生目录只剩 H2~V8 存量历史日（新写不再产生文件），
    #    此回落仅在用户完全没有分片时兜底历史日期列表。
    if not _may_read_derived(store, user_id):
        return []
    if not os.path.exists(_DATA_BASE):
        return []
    dirs = [d for d in os.listdir(_DATA_BASE) if os.path.isdir(os.path.join(_DATA_BASE, d))]
    # 过滤出包含 health.json 的目录
    dates = []
    for d in sorted(dirs):
        health_file = os.path.join(_DATA_BASE, d, "health.json")
        if os.path.exists(health_file):
            dates.append(d)
    return dates
