"""
mi_fitness_fetch.py - 从小米运动健康云端获取指定时段的健康数据（格式化输出，非 JSON）

用法:
    python analysis/mi_fitness_fetch.py <start_date> <end_date>
    python analysis/mi_fitness_fetch.py <start_date> <end_date> --keys steps,heart_rate
    python analysis/mi_fitness_fetch.py <start_date> <end_date> --raw --limit 100
    python analysis/mi_fitness_fetch.py <start_date> <end_date> --qr

示例:
    python analysis/mi_fitness_fetch.py 2026-01-01 2026-01-07
    python analysis/mi_fitness_fetch.py 2026-01-01 2026-01-07 --keys sleep,stress

凭据:
    - 只读 config.yaml 的 health.cloud.userid / health.cloud.passtoken（正式真源）
    - --qr 扫码登录；成功后自动写回 config.yaml
    - 首次接入或凭据失效时运行 backend/scripts/mi_cloud_setup.py --qr

说明:
    - 协议实现唯一真源：backend/services/health/sources/cloud_pull.py
    - 依赖后端目录：脚本按自身位置推导仓库根，再定位 backend/
    - 默认输出按天汇总表；--raw 输出原始采样记录
"""

import argparse
import json
import os
import sys
import unicodedata
from collections import defaultdict
from datetime import datetime, timedelta, timezone

# Windows 终端强制 UTF-8，避免中文表头乱码
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

_AI_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_REPO_ROOT = os.path.dirname(_AI_ROOT)
_BACKEND_DIR = os.path.join(_REPO_ROOT, "backend")
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

QR_PNG = os.path.join(_BACKEND_DIR, "data", "mi_qr.png")

# 可用指标 key（对应 get_fitness_data_by_time 的 key 参数）
ALL_KEYS = [
    "steps",
    "calories",
    "heart_rate",
    "resting_heart_rate",
    "spo2",
    "stress",
    "sleep",
    "weight",
    "abnormal_heart_beat",
]
# 各 key 的中文标签
KEY_LABELS = {
    "steps": "步数",
    "calories": "活动卡路里",
    "heart_rate": "心率",
    "resting_heart_rate": "静息心率",
    "spo2": "血氧",
    "stress": "压力",
    "sleep": "睡眠",
    "weight": "体重",
    "abnormal_heart_beat": "异常心跳",
    "workouts": "运动记录",
}


# --------------------------------------------------------------------------
# 格式化工具（非 JSON 输出）
# --------------------------------------------------------------------------
def _disp_width(text: str) -> int:
    """计算字符串的显示宽度（中日韩全角字符按 2 列计，保证表格对齐）。"""
    return sum(2 if unicodedata.east_asian_width(ch) in ("F", "W") else 1 for ch in str(text))


def pad(text: str, width: int, align: str = "<") -> str:
    """按显示宽度补齐/截断。align: '<' 左对齐，'>' 右对齐。"""
    s = str(text)
    fill = max(0, width - _disp_width(s))
    if align == ">":
        return " " * fill + s
    return s + " " * fill


def render_table(headers: list, rows: list, aligns: list = None) -> str:
    """渲染等宽对齐的文本表格，返回多行字符串。"""
    if not rows:
        return "    （无数据）"
    if aligns is None:
        aligns = ["<"] * len(headers)
    # 列宽 = 表头与各单元格显示宽度的最大值
    widths = []
    for idx, h in enumerate(headers):
        w = _disp_width(str(h))
        for row in rows:
            w = max(w, _disp_width(str(row[idx])))
        widths.append(w)

    lines = []
    lines.append("    " + "  ".join(pad(h, widths[i], aligns[i]) for i, h in enumerate(headers)))
    lines.append("    " + "  ".join("-" * widths[i] for i in range(len(headers))))
    for row in rows:
        lines.append("    " + "  ".join(pad(c, widths[i], aligns[i]) for i, c in enumerate(row)))
    return "\n".join(lines)


def fmt_int(value) -> str:
    """整数格式化：空值显示 -，有值显示千分位。"""
    if value is None:
        return "-"
    try:
        return f"{int(value):,}"
    except (TypeError, ValueError):
        return str(value)


def fmt_float(value, digits: int = 1) -> str:
    """小数格式化：空值显示 -。"""
    if value is None:
        return "-"
    try:
        return f"{float(value):.{digits}f}"
    except (TypeError, ValueError):
        return str(value)


# --------------------------------------------------------------------------
# 小米云客户端
# --------------------------------------------------------------------------
class MiFitnessClient:
    """格式适配层：协议与登录统一委托 backend cloud_pull。"""

    def __init__(self, region: str | None = None, timeout: float = 20.0):
        from services.health.sources.cloud_pull import CloudPullSource

        self._source = CloudPullSource(region=region, timeout=timeout)
        self.region = self._source.region

    @property
    def user_id(self) -> str:
        return self._source.user_id

    @property
    def pass_token(self) -> str:
        return self._source.pass_token

    def login_with_token(self, user_id: str, pass_token: str) -> None:
        self._source.user_id = str(user_id)
        self._source.pass_token = str(pass_token)
        self._source.login()

    def login_with_config(self) -> None:
        self._source.login()

    def qr_login(self, timeout_seconds: int = 300) -> tuple:
        """扫码登录并保存二维码；成功后返回 (user_id, pass_token)。"""
        import requests

        info = self._source.request_qr()
        png = requests.get(info["qr"], timeout=30).content
        os.makedirs(os.path.dirname(QR_PNG), exist_ok=True)
        with open(QR_PNG, "wb") as f:
            f.write(png)
        print(f"[扫码] 二维码已保存：{QR_PNG}")
        print("[扫码] 请用「小米运动健康 / 米家 / 小米账号」App 扫描该图片")
        if sys.platform == "win32":
            try:
                os.startfile(QR_PNG)
                print("[扫码] 已自动打开二维码图片")
            except Exception:
                pass
        if info.get("loginUrl"):
            print(f"[扫码] 也可浏览器打开：{info['loginUrl']}")
        user_id, pass_token = self._source.poll_qr(
            info["lp"], min(timeout_seconds, int(info.get("timeout", 300)))
        )
        print(f"[扫码] 登录成功，userId={user_id}")
        return user_id, pass_token

    def base_url(self) -> str:
        return self._source.base_url()

    def _tz(self) -> timezone:
        return timezone(timedelta(hours=8)) if self.region in ("", "cn") else timezone.utc

    def _range(self, start_date: str, end_date: str) -> tuple:
        tz = self._tz()
        start = datetime.fromisoformat(start_date).replace(tzinfo=tz)
        end = datetime.fromisoformat(end_date + "T23:59:59").replace(tzinfo=tz)
        return int(start.timestamp()), int(end.timestamp())

    def fetch_key(self, key: str, start_date: str, end_date: str) -> list:
        start_time, end_time = self._range(start_date, end_date)
        return self._source.fetch_key(key, start_time, end_time)

    def fetch_workouts(self, start_date: str, end_date: str) -> list:
        start_time, end_time = self._range(start_date, end_date)
        return self._source.fetch_sport_records(start_time, end_time)


# --------------------------------------------------------------------------
# 数据解析辅助
# --------------------------------------------------------------------------
def parse_value(item: dict) -> dict:
    """记录的 value 是 JSON 字符串，需要二次解析。"""
    raw = item.get("value", "{}")
    if isinstance(raw, dict):
        return raw
    try:
        return json.loads(raw)
    except (TypeError, json.JSONDecodeError):
        return {}


def record_date(item: dict) -> str:
    """按记录时间戳（东八区）归属日期 YYYY-MM-DD。"""
    ts = int(item.get("time", 0))
    if not ts:
        return "-"
    return datetime.fromtimestamp(ts, timezone(timedelta(hours=8))).strftime("%Y-%m-%d")


def record_datetime(item: dict) -> str:
    ts = int(item.get("time", 0))
    if not ts:
        return "-"
    return datetime.fromtimestamp(ts, timezone(timedelta(hours=8))).strftime("%Y-%m-%d %H:%M")


def sleep_stage_name(state) -> str:
    """小米睡眠阶段编码 -> 可读名：2 深睡 3 浅睡 4 REM 5 清醒，其余未知。"""
    mapping = {2: "深睡", 3: "浅睡", 4: "REM", 5: "清醒"}
    try:
        return mapping.get(int(state), "未知")
    except (TypeError, ValueError):
        return "未知"


# --------------------------------------------------------------------------
# 按指标格式化（汇总表 / 原始表）
# --------------------------------------------------------------------------
def format_summary(key: str, items: list) -> str:
    """把某个指标的原始记录聚合成按天汇总表。"""
    label = KEY_LABELS.get(key, key)
    header = f"[{key}] {label}    共 {len(items)} 条记录"
    if not items:
        return f"{header}\n    （该时段无数据）\n"

    # 按日期分组
    by_date = defaultdict(list)
    for item in items:
        by_date[record_date(item)].append(item)

    rows = []
    if key == "steps":
        # 步数/卡路里：采样值是区间增量，日总量 = 求和
        for date in sorted(by_date):
            vals = [parse_value(i).get("steps", 0) or 0 for i in by_date[date]]
            total = sum(float(v) for v in vals)
            rows.append([date, len(by_date[date]), fmt_int(total)])
        grand = sum(float(parse_value(i).get("steps", 0) or 0) for i in items)
        body = render_table(
            ["日期", "采样数", "合计步数"], rows, ["<", ">", ">"]
        )
        body += f"\n    时段总计: {fmt_int(grand)} 步"
    elif key == "calories":
        for date in sorted(by_date):
            vals = [parse_value(i).get("calories", 0) or 0 for i in by_date[date]]
            rows.append([date, len(by_date[date]), fmt_float(sum(float(v) for v in vals), 1)])
        grand = sum(float(parse_value(i).get("calories", 0) or 0) for i in items)
        body = render_table(
            ["日期", "采样数", "合计卡路里"], rows, ["<", ">", ">"]
        )
        body += f"\n    时段总计: {fmt_float(grand, 1)} kcal"
    elif key in ("heart_rate", "spo2", "stress"):
        unit = {"heart_rate": "bpm", "spo2": "%", "stress": ""}[key]
        field = {"heart_rate": "bpm", "spo2": "spo2", "stress": "stress"}[key]
        for date in sorted(by_date):
            vals = [
                float(parse_value(i)[field])
                for i in by_date[date]
                if parse_value(i).get(field) is not None
            ]
            if not vals:
                continue
            avg = sum(vals) / len(vals)
            rows.append([
                date, len(vals), fmt_float(avg, 1),
                fmt_float(min(vals), 0), fmt_float(max(vals), 0),
            ])
        headers = ["日期", "采样数", f"平均({unit})", f"最低({unit})", f"最高({unit})"]
        body = render_table(headers, rows, ["<", ">", ">", ">", ">"])
    elif key == "resting_heart_rate":
        for date in sorted(by_date):
            vals = [
                float(parse_value(i).get("bpm", 0))
                for i in by_date[date]
                if parse_value(i).get("bpm")
            ]
            if vals:
                rows.append([date, len(vals), fmt_float(sum(vals) / len(vals), 1)])
        body = render_table(["日期", "采样数", "平均(bpm)"], rows, ["<", ">", ">"])
    elif key == "sleep":
        # 每条记录 = 一次睡眠，列出入睡/起床时间与各阶段时长
        tz = timezone(timedelta(hours=8))

        def _fmt_ts(val):
            """时间戳格式化为本地可读时间，兼容空值。"""
            if not val:
                return "-"
            try:
                return datetime.fromtimestamp(int(val), tz).strftime("%Y-%m-%d %H:%M")
            except (TypeError, ValueError):
                return str(val)

        for item in sorted(items, key=lambda x: int(x.get("time", 0))):
            v = parse_value(item)
            bedtime = v.get("bedtime") or v.get("device_bedtime") or v.get("bed_timestamp")
            wake = v.get("device_wake_up_time") or v.get("wake_up_time") or item.get("time")
            rows.append([
                _fmt_ts(bedtime),
                _fmt_ts(wake),
                fmt_int(v.get("duration")),
                fmt_int(v.get("sleep_deep_duration")),
                fmt_int(v.get("sleep_light_duration")),
                fmt_int(v.get("sleep_rem_duration")),
                fmt_int(v.get("sleep_awake_duration")),
                fmt_int(v.get("awake_count")),
                len(v.get("items") or []),
            ])
        headers = [
            "入睡时间", "起床时间", "总时长(分)", "深睡(分)",
            "浅睡(分)", "REM(分)", "清醒(分)", "清醒次", "阶段数",
        ]
        body = render_table(headers, rows, ["<", "<", ">", ">", ">", ">", ">", ">", ">"])
    elif key == "weight":
        for item in sorted(items, key=lambda x: int(x.get("time", 0))):
            v = parse_value(item)
            rows.append([
                record_datetime(item),
                fmt_float(v.get("weight")),
                fmt_float(v.get("bmi")),
                fmt_float(v.get("body_fat_rate")),
            ])
        body = render_table(
            ["时间", "体重(kg)", "BMI", "体脂(%)"], rows, ["<", ">", ">", ">"]
        )
    elif key == "abnormal_heart_beat":
        for item in sorted(items, key=lambda x: int(x.get("time", 0))):
            v = parse_value(item)
            start = v.get("start_time") or item.get("time")
            end = v.get("end_time") or start
            dur = max(0, int(end) - int(start))
            rows.append([
                datetime.fromtimestamp(int(start), timezone(timedelta(hours=8))).strftime(
                    "%Y-%m-%d %H:%M:%S"
                ),
                datetime.fromtimestamp(int(end), timezone(timedelta(hours=8))).strftime(
                    "%Y-%m-%d %H:%M:%S"
                ),
                f"{dur} 秒",
            ])
        body = render_table(["开始", "结束", "时长"], rows, ["<", "<", ">"])
    else:
        # 其他指标：按天给条数与时间跨度
        for date in sorted(by_date):
            sample = by_date[date][0]
            rows.append([date, len(by_date[date]), str(sample.get("key", key))])
        body = render_table(["日期", "条数", "key"], rows, ["<", ">", "<"])

    return f"{header}\n{body}\n"


def format_raw(key: str, items: list, limit: int) -> str:
    """输出原始采样记录（受 limit 限制，避免刷屏）。"""
    label = KEY_LABELS.get(key, key)
    sorted_items = sorted(items, key=lambda x: int(x.get("time", 0)))
    shown = sorted_items[:limit]
    header = (
        f"[{key}] {label} 原始记录    共 {len(items)} 条"
        f"（显示 {len(shown)} 条，--limit 可调）"
    )
    if not shown:
        return f"{header}\n    （该时段无数据）\n"

    rows = []
    for item in shown:
        v = parse_value(item)
        # 把 value 里主要字段平铺成表格列
        cells = [record_datetime(item)]
        for field in ("steps", "distance", "calories", "bpm", "spo2", "stress",
                      "weight", "duration", "type"):
            if field in v:
                val = v[field]
                if isinstance(val, float):
                    cells.append(fmt_float(val, 2))
                elif isinstance(val, int):
                    cells.append(fmt_int(val))
                else:
                    cells.append(str(val))
        rows.append(cells)

    # 列头与数据对齐：以第一条记录出现的字段为准
    headers = ["时间"]
    first_value = parse_value(shown[0])
    for field in ("steps", "distance", "calories", "bpm", "spo2", "stress",
                  "weight", "duration", "type"):
        if field in first_value:
            headers.append(field)
    body = render_table(headers, rows, ["<"] + [">"] * (len(headers) - 1))
    if len(shown) < len(sorted_items):
        body += f"\n    （已截断，剩余 {len(items) - len(shown)} 条未显示）"
    return f"{header}\n{body}\n"


def _flat_headers(item: dict) -> list:
    v = parse_value(item)
    heads = ["时间"]
    for field in ("steps", "distance", "calories", "bpm", "spo2", "stress",
                  "weight", "duration", "type"):
        if field in v:
            heads.append(field)
    return heads


def format_workouts(items: list) -> str:
    """运动记录格式化（走独立端点）。"""
    label = KEY_LABELS["workouts"]
    header = f"[workouts] {label}    共 {len(items)} 条记录"
    if not items:
        return f"{header}\n    （该时段无数据）\n"
    rows = []
    for item in sorted(items, key=lambda x: int(x.get("time", 0))):
        v = parse_value(item)
        start = v.get("start_time") or item.get("time")
        dur = int(v.get("duration", 0) or 0)
        rows.append([
            datetime.fromtimestamp(int(start), timezone(timedelta(hours=8))).strftime(
                "%Y-%m-%d %H:%M"
            ),
            str(v.get("sport_type") or item.get("category") or "运动"),
            f"{dur // 60}:{dur % 60:02d}" if dur else "-",
            fmt_float(v.get("distance"), 0),
            fmt_float(v.get("calories") or v.get("total_cal"), 0),
            fmt_int(v.get("avg_hrm")),
            fmt_int(v.get("max_hrm")),
        ])
    headers = [
        "开始时间", "类型", "时长", "距离(m)", "卡路里", "平均心率", "最高心率",
    ]
    body = render_table(headers, rows, ["<", "<", ">", ">", ">", ">", ">"])
    return f"{header}\n{body}\n"


# --------------------------------------------------------------------------
# 主流程
# --------------------------------------------------------------------------
def _persist_credentials(user_id: str, pass_token: str, region: str | None) -> None:
    try:
        scripts_dir = os.path.join(_BACKEND_DIR, "scripts")
        if scripts_dir not in sys.path:
            sys.path.insert(0, scripts_dir)
        from mi_cloud_setup import resolve_config_path, upsert_cloud_config, write_config

        path = resolve_config_path()
        if not path.exists():
            print("[提示] 未找到 config.yaml，凭据未持久化")
            return
        text = path.read_text(encoding="utf-8")
        backup = write_config(
            path, upsert_cloud_config(text, str(user_id), pass_token, region=region)
        )
        print(f"[扫码] 凭据已写入 {path}（备份: {backup.name}）")
    except Exception as exc:
        print(f"[提示] 凭据自动写入失败: {exc}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="从小米运动健康云端获取指定时段的健康数据（格式化输出）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "示例:\n"
            "  python analysis/mi_fitness_fetch.py 2026-01-01 2026-01-07\n"
            "  python analysis/mi_fitness_fetch.py 2026-01-01 2026-01-07 --keys sleep,stress\n"
            "  python analysis/mi_fitness_fetch.py 2026-01-01 2026-01-07 --raw --limit 50"
        ),
    )
    parser.add_argument("start_date", help="起始日期 YYYY-MM-DD")
    parser.add_argument("end_date", help="结束日期 YYYY-MM-DD")
    parser.add_argument(
        "--keys",
        default=",".join(ALL_KEYS),
        help="逗号分隔的指标，默认全部: " + ",".join(ALL_KEYS),
    )
    parser.add_argument("--region", default=None, help="区域: cn/ru/de/i2/sg/us（默认跟随 config）")
    parser.add_argument("--qr", action="store_true", help="扫码登录；成功后写回 config.yaml")
    parser.add_argument(
        "--raw", action="store_true", help="输出原始采样记录而非按天汇总"
    )
    parser.add_argument("--limit", type=int, default=50, help="原始记录显示条数上限")
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    # 校验日期
    for name, value in (("start_date", args.start_date), ("end_date", args.end_date)):
        try:
            datetime.fromisoformat(value)
        except ValueError:
            print(f"错误: {name} 格式必须为 YYYY-MM-DD，收到: {value}")
            return 2
    if args.start_date > args.end_date:
        print("错误: 起始日期不能晚于结束日期")
        return 2

    keys = [k.strip() for k in args.keys.split(",") if k.strip()]
    unknown = [k for k in keys if k not in ALL_KEYS and k != "workouts"]
    if unknown:
        print(f"错误: 未知指标 {unknown}，可用: {ALL_KEYS + ['workouts']}")
        return 2

    # ---- 登录：凭据只来自 config.yaml（或 --qr 扫码后写回） ----
    client = MiFitnessClient(region=args.region)
    try:
        if args.qr:
            user_id, pass_token = client.qr_login()
            _persist_credentials(user_id, pass_token, args.region)
            client.login_with_token(user_id, pass_token)
        else:
            client.login_with_config()
    except Exception as exc:
        print(f"错误: 登录失败 -> {type(exc).__name__}: {exc}")
        print("      获取或更新凭据: python backend/scripts/mi_cloud_setup.py --qr")
        return 1

    # ---- 输出抬头 ----
    print("=" * 70)
    print(" 小米运动健康云端数据")
    print(
        f" 账号: {client.user_id}    区域: {client.region}    "
        f"时段: {args.start_date} ~ {args.end_date}"
    )
    print(f" 数据源: {client.base_url()}")
    print(f" 输出: {'原始记录' if args.raw else '按天汇总'}    "
          f"指标: {','.join(keys)}")
    print("=" * 70)
    print()

    # ---- 拉取并输出 ----
    total_records = 0
    for key in keys:
        try:
            if key == "workouts":
                items = client.fetch_workouts(args.start_date, args.end_date)
                if args.raw:
                    print(format_workouts(items), sep="")
                else:
                    # 运动记录本身就是离散事件，汇总与原始一致
                    print(format_workouts(items), sep="")
            else:
                items = client.fetch_key(key, args.start_date, args.end_date)
                total_records += len(items)
                if args.raw:
                    print(format_raw(key, items, args.limit), sep="")
                else:
                    print(format_summary(key, items), sep="")
        except Exception as exc:
            label = KEY_LABELS.get(key, key)
            print(f"[{key}] {label}    获取失败: {type(exc).__name__}: {exc}\n")

    print("-" * 70)
    print(f"完成: 共获取 {total_records} 条记录")
    if total_records == 0:
        print("提示: 无数据可能是该时段云端没有记录，或对应监测未开启。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
