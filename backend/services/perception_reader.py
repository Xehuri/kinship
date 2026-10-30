# -*- coding: utf-8 -*-
"""perception.jsonl 唯一读取层（P2-V11）。

背景（audit raw/04 §3）：perception.jsonl 历史上只有写入封装
（perception_store.append_perception），读取侧 preview / voiceprint_audit /
mobile / rebuild_cohort / ai 分析脚本至少 6 套各自逐行解析，容错语义互有
出入。本模块收编为唯一 reader：**缺文件返回空列表、空行跳过、坏行
（非 UTF-8 字节 / JSON 解析失败 / 顶层非 dict）逐行跳过、底层 IO 中断
返回已收集部分** ——即六读方容错语义的并集（只放宽不收紧），逐家核对
表见 /tmp/opencode/vunit-V11.md。

消费方约定：
- read_day() 返回当日条目 dict 列表（保持文件行序）；调用方在其上做
  字段级处理，字段级异常（如坏 seg）不属本层容错范围，行为与各家收编
  前一致（照常抛出）。
- types / predicate 只是便利过滤，不改变条目内容。
- data_root 缺省 = config.DATA_DIR（与 perception_store 写侧同根）；
  独立脚本可显式传入自己的数据根。
"""
import json
import os
import re
from datetime import datetime, timedelta
from typing import Any, Callable, Dict, Iterable, Iterator, List, Optional, Tuple

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

PERCEPTION_FILENAME = "perception.jsonl"


def _default_data_root() -> str:
    """默认数据根：与 perception_store 写侧同源（config.DATA_DIR）。

    延迟 import：本模块可被独立脚本经 sys.path 复用，不强绑 config 环境。
    """
    from config.config import get_config
    return get_config().DATA_DIR


def perception_path(date_str: str, *, data_root: Optional[str] = None) -> str:
    """某日 perception.jsonl 的绝对路径（纯拼接，不建目录）。"""
    root = data_root or _default_data_root()
    return os.path.join(root, "daily", str(date_str), PERCEPTION_FILENAME)


def has_perception(date_str: str, *, data_root: Optional[str] = None) -> bool:
    """某日是否存在 perception.jsonl（调用方据此区分 404/空列表语义）。"""
    return os.path.isfile(perception_path(date_str, data_root=data_root))


def daily_root(*, data_root: Optional[str] = None) -> str:
    """daily 根目录路径（供调用方自行扫描）。"""
    return os.path.join(data_root or _default_data_root(), "daily")


def day_dirs(*, data_root: Optional[str] = None, reverse: bool = True) -> List[str]:
    """daily/ 下符合 YYYY-MM-DD 命名的日期目录名列表（默认降序）。

    daily 根不存在返回空列表。目录存在性判定保留给调用方组合
    （如 preview /days 只要"有 perception.jsonl 的日"，vaudit /days 要
    "有 voice 或 audio 的日"——各自组合 has_perception/条目统计）。
    """
    base = daily_root(data_root=data_root)
    try:
        names = os.listdir(base)
    except OSError:
        return []
    out = [n for n in names
           if _DATE_RE.match(n) and os.path.isdir(os.path.join(base, n))]
    out.sort(reverse=reverse)
    return out


def _normalize_types(types) -> Optional[set]:
    if types is None:
        return None
    if isinstance(types, str):
        return {types}
    return set(types)


def read_day(date_str: str, *,
             types=None,
             predicate: Optional[Callable[[Dict[str, Any]], bool]] = None,
             data_root: Optional[str] = None) -> List[Dict[str, Any]]:
    """读取某日 perception.jsonl 条目列表（唯一解析入口）。

    Args:
        date_str: YYYY-MM-DD
        types: 条目 type 字段过滤（str 或 str 集合；None=全部）
        predicate: 额外谓词（条目 dict -> bool），抛出的异常不吞（字段级
            错误语义与收编前各读方一致）
        data_root: 数据根（缺省 config.DATA_DIR）

    容错（六读方并集，只放宽不收紧）：
      - 文件缺失 / 日期格式异常无法成路径 / open 失败 -> 返回 []
      - 空行 / 纯空白行 -> 跳过
      - 非 UTF-8 字节行 -> 跳过（逐行解码，不受读缓冲分块影响）
      - JSON 解析失败行 -> 跳过
      - 顶层 JSON 非 dict（数字/数组/字符串行）-> 跳过
      - 底层 IO 中断（OSError）-> 返回中断前已收集条目
    """
    path = perception_path(date_str, data_root=data_root)
    want_types = _normalize_types(types)
    entries: List[Dict[str, Any]] = []
    try:
        f = open(path, "rb")
    except OSError:
        return entries  # 缺文件/无权限：统一空语义
    with f:
        try:
            for raw in f:
                try:
                    line = raw.decode("utf-8").strip()
                except UnicodeDecodeError:
                    continue
                if not line:
                    continue
                try:
                    d = json.loads(line)
                except (json.JSONDecodeError, ValueError):
                    continue
                if not isinstance(d, dict):
                    continue
                if want_types is not None and d.get("type") not in want_types:
                    continue
                if predicate is not None and not predicate(d):
                    continue
                entries.append(d)
        except OSError:
            return entries  # 读到一半 IO 坏：返回已有部分
    return entries


def iter_days(start: str, end: str, *,
              types=None,
              predicate: Optional[Callable[[Dict[str, Any]], bool]] = None,
              data_root: Optional[str] = None,
              include_empty: bool = False) -> Iterator[Tuple[str, List[Dict[str, Any]]]]:
    """按日遍历 [start, end] 闭区间（YYYY-MM-DD），产出 (date, entries)。

    - start > end：产出 (start, 当日条目) 与 (end, 当日条目)（双端点约定）
    - 缺数据日：默认跳过，include_empty=True 时产出空列表
    - 逐日容错同 read_day
    """
    try:
        d0 = datetime.strptime(start, "%Y-%m-%d").date()
        d1 = datetime.strptime(end, "%Y-%m-%d").date()
    except ValueError:
        return
    if d0 > d1:
        yield (start, read_day(start, types=types, predicate=predicate,
                               data_root=data_root))
        yield (end, read_day(end, types=types, predicate=predicate,
                             data_root=data_root))
        return
    day = d0
    while day <= d1:
        ds = day.strftime("%Y-%m-%d")
        entries = read_day(ds, types=types, predicate=predicate,
                           data_root=data_root)
        if entries or include_empty:
            yield (ds, entries)
        day += timedelta(days=1)
