"""
计划解析器 - 解析统一 schedule 字段格式，计算下次执行时间

支持两种格式：
1. 字符串简写: "daily 08:00", "weekly mon,wed,fri 09:00"
2. 结构化字典: {"daily": "08:00"}, {"weekly": {"days": "mon,wed,fri", "at": "09:00"}}
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)

# 时间格式正则 HH:MM
TIME_RE = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")
# 延迟格式正则 如 5m, 30s, 2h, 1d
DELAY_RE = re.compile(r"^(\d+)([smhd])$")
# 日期格式正则 MM-DD
DATE_RE = re.compile(r"^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$")

# 星期名称到 Python weekday 数字映射 (0=Monday, 6=Sunday)
WEEKDAY_MAP = {
    "mon": 0, "tue": 1, "wed": 2, "thu": 3,
    "fri": 4, "sat": 5, "sun": 6,
}

# 有效模式关键字
VALID_MODES = {"daily", "hourly", "weekly", "monthly", "yearly", "delay"}

# 延迟单位到秒的映射
DELAY_UNITS = {"s": 1, "m": 60, "h": 3600, "d": 86400}


@dataclass
class ScheduleConfig:
    """计划配置 - 解析后的统一格式"""
    mode: str = "invalid"  # daily, hourly, weekly, monthly, yearly, delay, invalid
    time: Optional[str] = None  # "HH:MM" 格式
    days: Optional[list] = None  # 星期名列表 ["mon","wed"] 或日期数字列表 [1,15] 或日期字符串 ["01-01"]
    delay_seconds: Optional[int] = None  # 延迟模式专用，单位秒
    date_times: Optional[Dict[str, str]] = None  # 按月不同时间 {day_num: "HH:MM"}

    def _parse_time(self) -> tuple:
        """解析 self.time 为 (hour, minute)，默认返回 (0, 0)"""
        if self.time and TIME_RE.match(self.time):
            parts = self.time.split(":")
            return int(parts[0]), int(parts[1])
        return 0, 0

    def next_run_time(self, from_dt: Optional[datetime] = None) -> Optional[datetime]:
        """
        计算 from_dt 之后的下次执行时间

        Args:
            from_dt: 起始时间（默认当前时间）

        Returns:
            下次执行时间，None 表示无法执行
        """
        if from_dt is None:
            from_dt = datetime.now()

        if self.mode == "daily":
            return self._next_daily(from_dt)
        elif self.mode == "hourly":
            return self._next_hourly(from_dt)
        elif self.mode == "weekly":
            return self._next_weekly(from_dt)
        elif self.mode == "monthly":
            return self._next_monthly(from_dt)
        elif self.mode == "yearly":
            return self._next_yearly(from_dt)
        elif self.mode == "delay":
            if self.delay_seconds is not None and self.delay_seconds > 0:
                return from_dt + timedelta(seconds=self.delay_seconds)
            return None

        return None

    def _next_daily(self, from_dt: datetime) -> Optional[datetime]:
        """计算每日模式的下次执行时间"""
        hour, minute = self._parse_time()
        target = from_dt.replace(hour=hour, minute=minute, second=0, microsecond=0)
        if target <= from_dt:
            target += timedelta(days=1)
        return target

    def _next_hourly(self, from_dt: datetime) -> Optional[datetime]:
        """计算每小时模式的下次执行时间"""
        _hour, minute = self._parse_time()
        target = from_dt.replace(minute=minute, second=0, microsecond=0)
        if target <= from_dt:
            target += timedelta(hours=1)
        return target

    def _next_weekly(self, from_dt: datetime) -> Optional[datetime]:
        """计算每周模式的下次执行时间"""
        if not self.days:
            return None
        hour, minute = self._parse_time()
        day_numbers = [WEEKDAY_MAP[d] for d in self.days if d in WEEKDAY_MAP]
        if not day_numbers:
            return None

        # 从起始日开始查找最近的匹配星期
        current = from_dt.replace(hour=hour, minute=minute, second=0, microsecond=0)
        if current <= from_dt:
            current += timedelta(days=1)

        for _ in range(7):
            if current.weekday() in day_numbers:
                return current
            current += timedelta(days=1)

        return None

    def _next_monthly(self, from_dt: datetime) -> Optional[datetime]:
        """计算每月模式的下次执行时间，支持不同日期的不同时间"""
        if not self.days:
            return None

        default_hour, default_minute = self._parse_time()

        for month_offset in range(12):
            year = from_dt.year
            month = from_dt.month + month_offset
            while month > 12:
                month -= 12
                year += 1

            for day in sorted(self.days):
                try:
                    day_int = int(day)
                    # 检查是否有为该日期定制的不同时间
                    day_key = str(day_int)
                    if self.date_times and day_key in self.date_times:
                        h, m = ScheduleConfig._parse_time_str(self.date_times[day_key])
                    else:
                        h, m = default_hour, default_minute

                    target = datetime(year, month, day_int, h, m, 0)
                    if target > from_dt:
                        return target
                except (ValueError, TypeError):
                    logger.debug("跳过无效日期: %d-%02d-%s", year, month, str(day))
                    continue

        return None

    def _next_yearly(self, from_dt: datetime) -> Optional[datetime]:
        """计算每年模式的下次执行时间"""
        if not self.days:
            return None

        hour, minute = self._parse_time()

        for year_offset in range(3):  # 最多查3年
            year = from_dt.year + year_offset

            for date_str in sorted(self.days):
                try:
                    parts = str(date_str).split("-")
                    month, day = int(parts[0]), int(parts[1])

                    target = datetime(year, month, day, hour, minute, 0)
                    if target > from_dt:
                        return target
                except (ValueError, TypeError):
                    logger.debug("跳过无效日期: %s", date_str)
                    continue

        return None

    @staticmethod
    def _parse_time_str(time_str: str) -> tuple:
        """解析 "HH:MM" 字符串为 (hour, minute)，失败返回 (0, 0)"""
        if time_str and TIME_RE.match(time_str):
            parts = time_str.split(":")
            return int(parts[0]), int(parts[1])
        return 0, 0


class ScheduleParser:
    """计划解析器 - 解析 schedule 字段并计算下次执行时间"""

    @staticmethod
    def parse(raw) -> ScheduleConfig:
        """
        解析 schedule 字段（自动识别字符串或字典）

        Args:
            raw: 字符串简写或结构化字典

        Returns:
            ScheduleConfig 对象
        """
        if isinstance(raw, dict):
            return ScheduleParser.from_dict(raw)
        elif isinstance(raw, str):
            return ScheduleParser.from_string(raw)
        else:
            logger.warning("不支持的 schedule 类型: %s", type(raw).__name__)
            return ScheduleConfig(mode="invalid")

    @staticmethod
    def from_dict(data: dict) -> ScheduleConfig:
        """
        解析结构化字典格式

        Args:
            data: 单键字典
                  {"daily": "08:00"}
                  {"hourly": 30}
                  {"weekly": {"days": "mon,wed,fri", "at": "09:00"}}
                  {"monthly": "1,15 14:30"}
                  {"monthly": {1: "14:30", 15: "10:00"}}
                  {"yearly": "01-01,12-25 09:00"}
                  {"delay": "5m"}

        Returns:
            ScheduleConfig 对象
        """
        if not data:
            logger.warning("空的 schedule 字典")
            return ScheduleConfig(mode="invalid")

        keys = list(data.keys())
        if len(keys) != 1:
            logger.warning("schedule 字典必须有且只有一个键，实际有 %d 个", len(keys))
            return ScheduleConfig(mode="invalid")

        mode = keys[0].lower()
        if mode not in VALID_MODES:
            logger.warning("未知的计划模式: %s", mode)
            return ScheduleConfig(mode="invalid")

        value = data[mode]

        if mode == "delay":
            return ScheduleParser._parse_delay_value(value)

        if isinstance(value, str):
            return ScheduleParser._parse_mode_string(mode, value)

        elif isinstance(value, (int, float)):
            return ScheduleParser._parse_mode_value(mode, value)

        elif isinstance(value, dict):
            return ScheduleParser._parse_mode_dict(mode, value)

        else:
            logger.warning("不支持的 schedule 值类型: %s", type(value).__name__)
            return ScheduleConfig(mode="invalid")

    @staticmethod
    def from_string(text: str) -> ScheduleConfig:
        """
        解析字符串简写格式

        格式:
            "daily [HH:MM]"
            "hourly [MM]"
            "weekly <days> [HH:MM]"
            "monthly <dates> [HH:MM]"
            "yearly <dates> [HH:MM]"
            "delay <duration>"

        Args:
            text: 计划字符串

        Returns:
            ScheduleConfig 对象
        """
        if not text or not text.strip():
            logger.warning("空的 schedule 字符串")
            return ScheduleConfig(mode="invalid")

        parts = text.strip().lower().split()
        mode = parts[0]

        if mode not in VALID_MODES:
            logger.warning("未知的计划模式: %s", mode)
            return ScheduleConfig(mode="invalid")

        if mode == "delay":
            return ScheduleParser._parse_delay_tokens(parts[1:])

        if len(parts) == 1:
            # 只有模式关键字，无参数
            return ScheduleConfig(
                mode=mode,
                time="00:00",
                days=ScheduleParser._default_days(mode)
            )

        # 剩余参数
        remaining = parts[1:]

        if mode == "daily":
            # "daily 08:00"
            time_str = remaining[0]
            if TIME_RE.match(time_str):
                return ScheduleConfig(mode=mode, time=time_str)
            logger.warning("无效的时间格式: %s", time_str)
            return ScheduleConfig(mode="invalid")

        elif mode == "hourly":
            # "hourly 30" 或 "hourly" (已处理)
            time_str = remaining[0]
            if time_str.isdigit():
                minute = int(time_str)
                if 0 <= minute <= 59:
                    return ScheduleConfig(mode=mode, time=f"00:{minute:02d}")
                logger.warning("无效的分钟值: %d", minute)
                return ScheduleConfig(mode="invalid")
            if TIME_RE.match(time_str):
                minute = int(time_str.split(":")[1])
                if 0 <= minute <= 59:
                    return ScheduleConfig(mode=mode, time=f"00:{minute:02d}")
            logger.warning("无效的分钟格式: %s", time_str)
            return ScheduleConfig(mode="invalid")

        elif mode == "weekly":
            # "weekly mon,wed,fri 09:00" 或 "weekly mon,wed,fri"
            return ScheduleParser._parse_weekly_monthly_string(mode, remaining)

        elif mode == "monthly":
            # "monthly 1,15 14:30" 或 "monthly 1,15"
            return ScheduleParser._parse_weekly_monthly_string(mode, remaining)

        elif mode == "yearly":
            # "yearly 01-01,12-25 09:00" 或 "yearly 01-01"
            return ScheduleParser._parse_yearly_string(mode, remaining)

        else:
            logger.warning("无法解析模式: %s", mode)
            return ScheduleConfig(mode="invalid")

    # ============ 各模式解析方法 ============

    @staticmethod
    def _parse_delay_value(value) -> ScheduleConfig:
        """解析 delay 模式的值（字符串或数字）"""
        if isinstance(value, (int, float)):
            delay_seconds = int(value)
            if delay_seconds > 0:
                return ScheduleConfig(mode="delay", delay_seconds=delay_seconds)
            logger.warning("延迟时间必须大于 0，实际: %d", delay_seconds)
            return ScheduleConfig(mode="invalid")

        if isinstance(value, str):
            return ScheduleParser._parse_delay_tokens([value])

        logger.warning("不支持的 delay 值类型: %s", type(value).__name__)
        return ScheduleConfig(mode="invalid")

    @staticmethod
    def _parse_delay_tokens(tokens: list) -> ScheduleConfig:
        """解析延迟 token 列表，如 ['5m'] 或 ['2h', '30m']"""
        if not tokens:
            logger.warning("缺少延迟参数")
            return ScheduleConfig(mode="invalid")

        total_seconds = 0
        for token in tokens:
            match = DELAY_RE.match(token)
            if not match:
                logger.warning("无效的延迟格式: %s (应为数字+单位 s/m/h/d)", token)
                return ScheduleConfig(mode="invalid")
            amount = int(match.group(1))
            unit = match.group(2)
            total_seconds += amount * DELAY_UNITS[unit]

        if total_seconds <= 0:
            logger.warning("延迟时间必须大于 0")
            return ScheduleConfig(mode="invalid")

        return ScheduleConfig(mode="delay", delay_seconds=total_seconds)

    @staticmethod
    def _parse_mode_string(mode: str, value: str) -> ScheduleConfig:
        """解析字符串类型的模式值"""
        value = value.strip()
        if not value:
            return ScheduleConfig(mode=mode, time="00:00", days=ScheduleParser._default_days(mode))

        if mode == "daily":
            if TIME_RE.match(value):
                return ScheduleConfig(mode=mode, time=value)
            logger.warning("无效的时间格式: %s", value)
            return ScheduleConfig(mode="invalid")

        if mode == "hourly":
            if value.isdigit():
                minute = int(value)
                if 0 <= minute <= 59:
                    return ScheduleConfig(mode=mode, time=f"00:{minute:02d}")
                logger.warning("无效的分钟值: %d", minute)
                return ScheduleConfig(mode="invalid")
            if TIME_RE.match(value):
                minute = int(value.split(":")[1])
                if 0 <= minute <= 59:
                    return ScheduleConfig(mode=mode, time=f"00:{minute:02d}")
            logger.warning("无效的分钟格式: %s", value)
            return ScheduleConfig(mode="invalid")

        if mode in ("weekly", "monthly"):
            # "mon,wed,fri 09:00" 或 "1,15 14:30"
            parts_s = value.split()
            if len(parts_s) == 1:
                days = ScheduleParser._parse_days(mode, parts_s[0])
                if days is None:
                    return ScheduleConfig(mode="invalid")
                return ScheduleConfig(mode=mode, time="00:00", days=days)
            elif len(parts_s) == 2:
                days_str, time_str = parts_s
                if not TIME_RE.match(time_str):
                    logger.warning("无效的时间格式: %s", time_str)
                    return ScheduleConfig(mode="invalid")
                days = ScheduleParser._parse_days(mode, days_str)
                if days is None:
                    return ScheduleConfig(mode="invalid")
                return ScheduleConfig(mode=mode, time=time_str, days=days)
            else:
                logger.warning("无效的 %s 参数: %s", mode, value)
                return ScheduleConfig(mode="invalid")

        if mode == "yearly":
            # "01-01,12-25 09:00" 或 "01-01"
            parts_s = value.split()
            if len(parts_s) == 1:
                dates_str = parts_s[0]
                time_str = "00:00"
            elif len(parts_s) == 2:
                dates_str, time_str = parts_s
                if not TIME_RE.match(time_str):
                    logger.warning("无效的时间格式: %s", time_str)
                    return ScheduleConfig(mode="invalid")
            else:
                logger.warning("无效的 yearly 参数: %s", value)
                return ScheduleConfig(mode="invalid")

            valid_dates = ScheduleParser._validate_dates(dates_str)
            if not valid_dates:
                return ScheduleConfig(mode="invalid")
            return ScheduleConfig(mode=mode, time=time_str, days=valid_dates)

        logger.warning("未知的解析模式: %s", mode)
        return ScheduleConfig(mode="invalid")

    @staticmethod
    def _parse_mode_value(mode: str, value: int | float) -> ScheduleConfig:
        """解析单值模式（如 hourly: 30）"""
        if mode == "hourly":
            minute = int(value)
            if 0 <= minute <= 59:
                return ScheduleConfig(mode=mode, time=f"00:{minute:02d}")
            logger.warning("无效的分钟值: %d", minute)
            return ScheduleConfig(mode="invalid")

        logger.warning("不支持的 %s 单值模式", mode)
        return ScheduleConfig(mode="invalid")

    @staticmethod
    def _parse_mode_dict(mode: str, value: dict) -> ScheduleConfig:
        """解析字典类型的模式值"""
        if mode == "daily":
            time_str = str(value.get("at", "00:00"))
            if not TIME_RE.match(time_str):
                logger.warning("无效的时间格式: %s", time_str)
                return ScheduleConfig(mode="invalid")
            return ScheduleConfig(mode=mode, time=time_str)

        elif mode == "hourly":
            at = value.get("at", 0)
            minute = int(at) if isinstance(at, (int, float)) else 0
            if 0 <= minute <= 59:
                return ScheduleConfig(mode=mode, time=f"00:{minute:02d}")
            logger.warning("无效的分钟值: %d", minute)
            return ScheduleConfig(mode="invalid")

        elif mode == "weekly":
            days_str = str(value.get("days", ""))
            time_str = str(value.get("at", "00:00"))
            if not TIME_RE.match(time_str):
                logger.warning("无效的时间格式: %s", time_str)
                return ScheduleConfig(mode="invalid")
            days = ScheduleParser._parse_days(mode, days_str)
            if days is None:
                return ScheduleConfig(mode="invalid")
            return ScheduleConfig(mode=mode, time=time_str, days=days)

        elif mode == "monthly":
            # 支持两种子格式:
            #   1. {"monthly": {"days": "1,15", "at": "14:30"}}
            #   2. {"monthly": {1: "14:30", 15: "10:00"}}  (按日不同时间)

            # 先检查是否是 "days" 键的格式
            if "days" in value:
                days_str = str(value.get("days", ""))
                time_str = str(value.get("at", "00:00"))
                if not TIME_RE.match(time_str):
                    logger.warning("无效的时间格式: %s", time_str)
                    return ScheduleConfig(mode="invalid")
                days = ScheduleParser._parse_days(mode, days_str)
                if days is None:
                    return ScheduleConfig(mode="invalid")
                return ScheduleConfig(mode=mode, time=time_str, days=days)

            # 否则是 {day: time} 格式
            days = []
            date_times: Dict[str, str] = {}
            for day_key, time_val in value.items():
                try:
                    day_num = int(day_key)
                    if not (1 <= day_num <= 31):
                        logger.warning("无效的日期数字: %d (应在 1-31 之间)", day_num)
                        return ScheduleConfig(mode="invalid")
                    days.append(day_num)
                    time_str = str(time_val).strip() if time_val else "00:00"
                    if not TIME_RE.match(time_str):
                        logger.warning("无效的时间格式: %s", time_str)
                        return ScheduleConfig(mode="invalid")
                    date_times[str(day_num)] = time_str
                except (ValueError, TypeError):
                    logger.warning("无效的日期键: %s", day_key)
                    return ScheduleConfig(mode="invalid")

            if not days:
                logger.warning("没有有效的每月日期")
                return ScheduleConfig(mode="invalid")

            return ScheduleConfig(
                mode=mode,
                time="00:00",
                days=sorted(days),
                date_times=date_times,
            )

        elif mode == "yearly":
            if "dates" in value:
                dates_raw = value["dates"]
                time_str = str(value.get("at", "00:00"))
                if not TIME_RE.match(time_str):
                    logger.warning("无效的时间格式: %s", time_str)
                    return ScheduleConfig(mode="invalid")
                if isinstance(dates_raw, list):
                    valid_dates = []
                    for d in dates_raw:
                        d_str = str(d).strip()
                        if DATE_RE.match(d_str):
                            valid_dates.append(d_str)
                        else:
                            logger.warning("无效的日期格式: %s", d)
                    if not valid_dates:
                        logger.warning("没有有效的 yearly 日期")
                        return ScheduleConfig(mode="invalid")
                    return ScheduleConfig(mode=mode, time=time_str, days=valid_dates)
            logger.warning("不支持的 yearly 字典格式")
            return ScheduleConfig(mode="invalid")

        logger.warning("不支持的 %s 字典模式", mode)
        return ScheduleConfig(mode="invalid")

    @staticmethod
    def _parse_weekly_monthly_string(mode: str, tokens: list) -> ScheduleConfig:
        """解析 weekly/monthly 字符串简写"""
        if not tokens:
            return ScheduleConfig(
                mode=mode,
                time="00:00",
                days=ScheduleParser._default_days(mode),
            )

        # 最后一个 token 可能是时间
        if TIME_RE.match(tokens[-1]):
            time_str = tokens[-1]
            days_str = " ".join(tokens[:-1])
        else:
            time_str = "00:00"
            days_str = " ".join(tokens)

        if not days_str.strip():
            days = ScheduleParser._default_days(mode)
        else:
            days = ScheduleParser._parse_days(mode, days_str)
            if days is None:
                return ScheduleConfig(mode="invalid")

        return ScheduleConfig(mode=mode, time=time_str, days=days)

    @staticmethod
    def _parse_yearly_string(mode: str, tokens: list) -> ScheduleConfig:
        """解析 yearly 字符串简写"""
        if not tokens:
            logger.warning("缺少 yearly 日期参数")
            return ScheduleConfig(mode="invalid")

        if TIME_RE.match(tokens[-1]):
            time_str = tokens[-1]
            dates_str = tokens[0]
        else:
            time_str = "00:00"
            dates_str = tokens[0]

        valid_dates = ScheduleParser._validate_dates(dates_str)
        if not valid_dates:
            return ScheduleConfig(mode="invalid")

        return ScheduleConfig(mode=mode, time=time_str, days=valid_dates)

    @staticmethod
    def _validate_dates(dates_str: str) -> Optional[list]:
        """验证 MM-DD 格式的日期字符串，返回有效日期列表"""
        if not dates_str.strip():
            logger.warning("空的 yearly 日期字符串")
            return None

        raw_dates = [d.strip() for d in dates_str.split(",")]
        valid_dates = []
        for d in raw_dates:
            if DATE_RE.match(d):
                valid_dates.append(d)
            else:
                logger.warning("无效的日期格式 (应为 MM-DD): %s", d)

        if not valid_dates:
            logger.warning("没有有效的 yearly 日期")
            return None

        return valid_dates

    @staticmethod
    def _parse_days(mode: str, days_str: str) -> Optional[list]:
        """解析日期字符串为列表"""
        if not days_str.strip():
            return ScheduleParser._default_days(mode)

        if mode == "weekly":
            names = [d.strip() for d in days_str.split(",")]
            for name in names:
                if name not in WEEKDAY_MAP:
                    logger.warning("无效的星期名称: %s (有效值: mon,tue,wed,thu,fri,sat,sun)", name)
                    return None
            return names

        if mode == "monthly":
            parts = [p.strip() for p in days_str.split(",")]
            numbers = []
            for p in parts:
                try:
                    num = int(p)
                    if 1 <= num <= 31:
                        numbers.append(num)
                    else:
                        logger.warning("无效的日期数字: %d (必须在 1-31 之间)", num)
                        return None
                except ValueError:
                    logger.warning("无效的日期: %s", p)
                    return None
            return sorted(numbers)

        logger.warning("不支持的 days 解析模式: %s", mode)
        return None

    @staticmethod
    def _default_days(mode: str) -> Optional[list]:
        """获取模式默认的 days 值"""
        if mode == "weekly":
            return ["mon"]
        elif mode == "monthly":
            return [1]
        return None


# ============ 手动测试 ============

if __name__ == "__main__":
    print("=" * 60)
    print("ScheduleParser 测试")
    print("=" * 60)

    passed = 0
    failed = 0

    def check(desc: str, condition: bool):
        global passed, failed
        if condition:
            print(f"  [通过] {desc}")
            passed += 1
        else:
            print(f"  [失败] {desc}")
            failed += 1

    # ---- 1. 每日 ----
    print("\n--- 每日 (daily) ---")
    c = ScheduleParser.parse("daily 08:00")
    check("daily 08:00 -> mode=daily", c.mode == "daily")
    check("daily 08:00 -> time=08:00", c.time == "08:00")

    c = ScheduleParser.parse("daily")
    check("daily -> mode=daily", c.mode == "daily")
    check("daily -> time=00:00", c.time == "00:00")

    c = ScheduleParser.parse({"daily": "08:00"})
    check('{"daily": "08:00"} -> time=08:00', c.time == "08:00")

    # ---- 2. 每小时 ----
    print("\n--- 每小时 (hourly) ---")
    c = ScheduleParser.parse("hourly 30")
    check("hourly 30 -> time=00:30", c.time == "00:30")

    c = ScheduleParser.parse("hourly")
    check("hourly -> time=00:00", c.time == "00:00")

    c = ScheduleParser.parse({"hourly": 30})
    check('{"hourly": 30} -> time=00:30', c.time == "00:30")

    # ---- 3. 每周 ----
    print("\n--- 每周 (weekly) ---")
    c = ScheduleParser.parse("weekly mon,wed,fri 09:00")
    check("weekly mon,wed,fri 09:00 -> mode=weekly", c.mode == "weekly")
    check("weekly mon,wed,fri 09:00 -> time=09:00", c.time == "09:00")
    check("weekly mon,wed,fri 09:00 -> days=[mon,wed,fri]", c.days == ["mon", "wed", "fri"])

    c = ScheduleParser.parse("weekly mon,wed,fri")
    check("weekly mon,wed,fri -> time=00:00", c.time == "00:00")
    check("weekly mon,wed,fri -> days=[mon,wed,fri]", c.days == ["mon", "wed", "fri"])

    c = ScheduleParser.parse("weekly")
    check("weekly -> days default=[mon]", c.days == ["mon"])

    c = ScheduleParser.parse({"weekly": {"days": "mon,wed,fri", "at": "09:00"}})
    check('{"weekly": {...}} -> time=09:00', c.time == "09:00")
    check('{"weekly": {...}} -> days=[mon,wed,fri]', c.days == ["mon", "wed", "fri"])

    # ---- 4. 每月 ----
    print("\n--- 每月 (monthly) ---")
    c = ScheduleParser.parse("monthly 1,15 14:30")
    check("monthly 1,15 14:30 -> mode=monthly", c.mode == "monthly")
    check("monthly 1,15 14:30 -> time=14:30", c.time == "14:30")
    check("monthly 1,15 14:30 -> days=[1,15]", c.days == [1, 15])

    c = ScheduleParser.parse("monthly 1,15")
    check("monthly 1,15 -> time=00:00", c.time == "00:00")
    check("monthly 1,15 -> days=[1,15]", c.days == [1, 15])

    c = ScheduleParser.parse({"monthly": "1,15 14:30"})
    check('{"monthly": "1,15 14:30"} -> days=[1,15]', c.days == [1, 15])

    c = ScheduleParser.parse({"monthly": {1: "14:30", 15: "10:00"}})
    check('{"monthly": {1: "14:30", 15: "10:00"}} -> days=[1,15]', c.days == [1, 15])
    check('{"monthly": {...}} -> date_times', c.date_times == {"1": "14:30", "15": "10:00"})

    # ---- 5. 每年 ----
    print("\n--- 每年 (yearly) ---")
    c = ScheduleParser.parse("yearly 01-01,12-25 09:00")
    check("yearly 01-01,12-25 09:00 -> mode=yearly", c.mode == "yearly")
    check("yearly 01-01,12-25 09:00 -> time=09:00", c.time == "09:00")
    check("yearly 01-01,12-25 09:00 -> days", c.days == ["01-01", "12-25"])

    c = ScheduleParser.parse("yearly 01-01")
    check("yearly 01-01 -> time=00:00", c.time == "00:00")
    check("yearly 01-01 -> days=[01-01]", c.days == ["01-01"])

    c = ScheduleParser.parse({"yearly": "01-01,12-25 09:00"})
    check('{"yearly": "01-01,12-25 09:00"} -> ok', c.mode == "yearly" and c.days == ["01-01", "12-25"])

    # ---- 6. 延迟 ----
    print("\n--- 延迟 (delay) ---")
    c = ScheduleParser.parse("delay 5m")
    check("delay 5m -> delay_seconds=300", c.delay_seconds == 300)

    c = ScheduleParser.parse("delay 30s")
    check("delay 30s -> delay_seconds=30", c.delay_seconds == 30)

    c = ScheduleParser.parse("delay 2h")
    check("delay 2h -> delay_seconds=7200", c.delay_seconds == 7200)

    c = ScheduleParser.parse("delay 1d")
    check("delay 1d -> delay_seconds=86400", c.delay_seconds == 86400)

    c = ScheduleParser.parse({"delay": "5m"})
    check('{"delay": "5m"} -> delay_seconds=300', c.delay_seconds == 300)

    c = ScheduleParser.parse({"delay": 300})
    check('{"delay": 300} -> delay_seconds=300', c.delay_seconds == 300)

    # ---- 7. 无效输入 ----
    print("\n--- 无效输入 ---")
    c = ScheduleParser.parse("")
    check("空字符串 -> mode=invalid", c.mode == "invalid")

    c = ScheduleParser.parse("unknown 08:00")
    check("未知模式 -> mode=invalid", c.mode == "invalid")

    c = ScheduleParser.parse("daily 25:00")
    check("无效时间 25:00 -> mode=invalid", c.mode == "invalid")

    c = ScheduleParser.parse({"daily": "08:00", "weekly": "mon"})
    check("多键字典 -> mode=invalid", c.mode == "invalid")

    c = ScheduleParser.parse("delay 0s")
    check("delay 0s -> mode=invalid", c.mode == "invalid")

    c = ScheduleParser.parse(None)
    check("None -> mode=invalid", c.mode == "invalid")

    # ---- 8. next_run_time ----
    print("\n--- next_run_time ---")

    # daily - 今日已过
    c = ScheduleParser.parse("daily 08:00")
    n = c.next_run_time(datetime(2026, 6, 24, 10, 0, 0))
    check("daily 08:00 (今日已过) -> 明天 08:00", n == datetime(2026, 6, 25, 8, 0, 0))

    # daily - 今日未过
    c = ScheduleParser.parse("daily 08:00")
    n = c.next_run_time(datetime(2026, 6, 24, 6, 0, 0))
    check("daily 08:00 (今日未过) -> 今天 08:00", n == datetime(2026, 6, 24, 8, 0, 0))

    # hourly - 同小时
    c = ScheduleParser.parse("hourly 30")
    n = c.next_run_time(datetime(2026, 6, 24, 10, 15, 0))
    check("hourly 30 (同小时中) -> 今天 10:30", n == datetime(2026, 6, 24, 10, 30, 0))

    # hourly - 下个小时
    c = ScheduleParser.parse("hourly 30")
    n = c.next_run_time(datetime(2026, 6, 24, 10, 45, 0))
    check("hourly 30 (分钟已过) -> 今天 11:30", n == datetime(2026, 6, 24, 11, 30, 0))

    # delay
    c = ScheduleParser.parse("delay 5m")
    n = c.next_run_time(datetime(2026, 6, 24, 10, 0, 0))
    check("delay 5m -> 今天 10:05", n == datetime(2026, 6, 24, 10, 5, 0))

    # weekly (2026-06-24 是星期三)
    c = ScheduleParser.parse("weekly mon,wed,fri 09:00")
    n = c.next_run_time(datetime(2026, 6, 24, 6, 0, 0))
    check("weekly (今天周三 06:00) -> 今天 09:00", n == datetime(2026, 6, 24, 9, 0, 0))

    c = ScheduleParser.parse("weekly mon,wed,fri 09:00")
    n = c.next_run_time(datetime(2026, 6, 24, 10, 0, 0))
    check("weekly (今天周三 10:00) -> 周五 09:00", n == datetime(2026, 6, 26, 9, 0, 0))

    # monthly (2026-06-24)
    c = ScheduleParser.parse("monthly 1,15 14:30")
    n = c.next_run_time(datetime(2026, 6, 24, 10, 0, 0))
    check("monthly 1,15 (6月24) -> 下月1日14:30", n == datetime(2026, 7, 1, 14, 30, 0))

    c = ScheduleParser.parse("monthly 1,15 14:30")
    n = c.next_run_time(datetime(2026, 6, 1, 16, 0, 0))
    check("monthly 1,15 (6月1日16:00) -> 6月15日14:30", n == datetime(2026, 6, 15, 14, 30, 0))

    # monthly with date_times
    c = ScheduleParser.parse({"monthly": {1: "14:30", 15: "10:00"}})
    n = c.next_run_time(datetime(2026, 6, 24, 10, 0, 0))
    check("monthly dict (6月24) -> 7月1日14:30", n == datetime(2026, 7, 1, 14, 30, 0))

    n = c.next_run_time(datetime(2026, 6, 1, 20, 0, 0))
    check("monthly dict (6月1日20:00) -> 6月15日10:00", n == datetime(2026, 6, 15, 10, 0, 0))

    # yearly (2026-06-24)
    c = ScheduleParser.parse("yearly 01-01,12-25 09:00")
    n = c.next_run_time(datetime(2026, 6, 24, 10, 0, 0))
    check("yearly 01-01,12-25 (6月24) -> 12月25日09:00", n == datetime(2026, 12, 25, 9, 0, 0))

    n = c.next_run_time(datetime(2027, 1, 15, 10, 0, 0))
    check("yearly 01-01,12-25 (1月15) -> 12月25日09:00", n == datetime(2027, 12, 25, 9, 0, 0))

    print()
    print("=" * 60)
    print(f"结果: {passed} 通过, {failed} 失败")
    print("=" * 60)
