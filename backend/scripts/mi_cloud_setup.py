#!/usr/bin/env python3
"""小米健康云接入与自检工具。

用法（项目根目录执行）:
    python backend/scripts/mi_cloud_setup.py --qr
    python backend/scripts/mi_cloud_setup.py --user-id 123456789 --pass-token V1:...
    python backend/scripts/mi_cloud_setup.py --check
    python backend/scripts/mi_cloud_setup.py --status
    python backend/scripts/mi_cloud_setup.py --latest
    python backend/scripts/mi_cloud_setup.py --enable
    python backend/scripts/mi_cloud_setup.py --sync --days 1
    python backend/scripts/mi_cloud_setup.py --backfill 110

凭据只写入项目根 config.yaml 的 health.cloud.*，写入前自动备份，写入后校验 YAML。
本 CLI 保持 YAML-only 老路径；Web 扫码（/api/health/cloud/qr/poll）改走
ConfigStore，支持 YAML / JSON / SQLite / env-overlay 载体。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "backend"
for _p in (str(BACKEND), str(ROOT)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from core.redaction import mask_secret


def _resolve_ai_root() -> Path:
    env = os.environ.get("AXEUH_AI_ROOT", "").strip()
    if env:
        return Path(env).expanduser()
    try:
        from config.config import get_config

        return Path(get_config().AI_ROOT)
    except Exception:
        return ROOT / "ai"


AI_ROOT = _resolve_ai_root()
TASK_FILE = AI_ROOT / "data" / "tasks" / "xiaomi_cloud_health.py"
STATE_FILE = AI_ROOT / "data" / "tasks" / ".xiaomi_cloud_health_state.json"
QR_PNG = BACKEND / "data" / "mi_qr.png"
AUTH_FILE = BACKEND / "config" / "auth.json"
CST = timezone(timedelta(hours=8))

CHECK_KEYS = [
    "heart_rate",
    "steps",
    "spo2",
    "stress",
    "calories",
    "resting_heart_rate",
    "sleep",
]


def resolve_config_path() -> Path:
    """与 backend/config/config.py 的查找顺序保持一致。"""
    env = os.environ.get("CONFIG_PATH", "").strip()
    if env:
        return Path(env)
    backend_cfg = BACKEND / "config" / "config.yaml"
    if backend_cfg.exists():
        return backend_cfg
    return ROOT / "config.yaml"


def mask(secret: str) -> str:
    if not secret:
        return "(空)"
    if len(secret) <= 8:
        return "*" * len(secret)
    return f"{secret[:4]}...{secret[-4:]}"


def _yaml_quote(value: str) -> str:
    return '"' + str(value).replace("\\", "\\\\").replace('"', '\\"') + '"'


def _block_end(lines: list, start: int, indent: int) -> int:
    """返回属于该缩进块的最后一行下标（不含）；同缩进的注释视为块外。"""
    i = start + 1
    while i < len(lines):
        raw = lines[i]
        if not raw.strip():
            i += 1
            continue
        current = len(raw) - len(raw.lstrip(" "))
        if current <= indent:
            break
        i += 1
    return i


def _find_key_line(lines: list, start: int, end: int, key: str, indent: int) -> int:
    pattern = re.compile(rf"^(\s*){re.escape(key)}\s*:")
    for i in range(start, end):
        match = pattern.match(lines[i])
        if match and len(match.group(1)) == indent:
            return i
    return -1


def _replace_value(line: str, key: str, value: str) -> str:
    pattern = re.compile(
        rf"^(\s*{re.escape(key)}\s*:\s*)(?:\"[^\"]*\"|'[^']*'|[^#\n]*?)(\s*#.*)?$"
    )
    replacement = rf"\g<1>{_yaml_quote(value)}\g<2>"
    return pattern.sub(replacement, line, count=1)


def upsert_cloud_config(
    text: str,
    userid: str,
    passtoken: str,
    region: str | None = None,
    lookback_days: int | None = None,
) -> str:
    """在 config 文本中写入 health.cloud.*，保留注释与其余内容。"""
    lines = text.splitlines(keepends=True)
    values = {"userid": userid, "passtoken": passtoken}
    if region:
        values["region"] = region
    if lookback_days is not None:
        values["initial_lookback_days"] = str(lookback_days)

    health_line = -1
    for i, line in enumerate(lines):
        if re.match(r"^health\s*:\s*(#.*)?$", line.rstrip("\n")):
            health_line = i
            break

    if health_line < 0:
        trailer = "" if text.endswith("\n") or not text else "\n"
        block = ["health:\n", "  cloud:\n"]
        block.extend(f"    {k}: {_yaml_quote(v)}\n" for k, v in values.items())
        return text + trailer + "".join(block)

    health_end = _block_end(lines, health_line, 0)
    cloud_line = _find_key_line(lines, health_line + 1, health_end, "cloud", 2)

    if cloud_line < 0:
        insert = [
            f"  cloud:\n",
            *(f"    {k}: {_yaml_quote(v)}\n" for k, v in values.items()),
        ]
        lines[health_end:health_end] = insert
        return "".join(lines)

    cloud_end = _block_end(lines, cloud_line, 2)
    for key, value in values.items():
        line_no = _find_key_line(lines, cloud_line + 1, cloud_end, key, 4)
        if line_no >= 0:
            lines[line_no] = _replace_value(lines[line_no], key, value)
        else:
            lines.insert(cloud_end, f"    {key}: {_yaml_quote(value)}\n")
            cloud_end += 1
    return "".join(lines)


def write_config(path: Path, text: str) -> Path:
    import yaml

    parsed = yaml.safe_load(text)
    if not isinstance(parsed, dict):
        raise RuntimeError("生成的新配置不是 YAML 映射，已中止")
    cloud = (parsed.get("health") or {}).get("cloud") or {}
    if not cloud.get("userid") or not cloud.get("passtoken"):
        raise RuntimeError("校验失败：health.cloud 凭据未正确写入")
    backup = path.with_name(f"{path.name}.bak-mi-{datetime.now():%Y%m%d-%H%M%S}")
    shutil.copy2(path, backup)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)
    return backup


def touch_task() -> None:
    if TASK_FILE.exists():
        os.utime(TASK_FILE, None)


def set_task_enabled(enabled: bool) -> bool:
    if not TASK_FILE.exists():
        return False
    text = TASK_FILE.read_text(encoding="utf-8")
    match = re.search(r'"""(.*?)"""', text, re.S)
    if not match:
        return False
    head, count = re.subn(
        r"(?m)^(enabled:\s*)(true|false)\s*$",
        rf"\g<1>{'true' if enabled else 'false'}",
        match.group(1),
        count=1,
    )
    if count == 0:
        return False
    backup = TASK_FILE.with_name(f"{TASK_FILE.name}.bak-mi-{datetime.now():%Y%m%d-%H%M%S}")
    shutil.copy2(TASK_FILE, backup)
    TASK_FILE.write_text(text[: match.start(1)] + head + text[match.end(1) :], encoding="utf-8")
    return True


def task_enabled() -> bool:
    if not TASK_FILE.exists():
        return False
    match = re.search(r'"""(.*?)"""', TASK_FILE.read_text(encoding="utf-8"), re.S)
    if not match:
        return False
    found = re.search(r"(?m)^enabled:\s*(true|false)\s*$", match.group(1))
    return bool(found and found.group(1) == "true")


def load_state() -> dict:
    if not STATE_FILE.exists():
        return {}
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}


def latest_cloud_shard() -> str:
    import glob

    pattern = str(AI_ROOT / "data" / "users" / "*" / "health" / "*" / "cloud.json")
    found = sorted(glob.glob(pattern))
    return Path(found[-1]).parent.name if found else "(无)"


def resolve_user_id() -> str:
    from config.config import get_config

    primary = get_config().HEALTH_PRIMARY_USER
    if primary:
        return primary
    try:
        auth = json.loads(AUTH_FILE.read_text(encoding="utf-8"))
        best = max(auth.get("tokens", {}).items(), key=lambda kv: kv[1].get("expires_at", ""), default=("", {}))
        return best[1].get("user_id", "") or ""
    except (OSError, ValueError):
        return ""


def make_source(args):
    from services.health.sources.cloud_pull import CloudPullSource

    return CloudPullSource(
        user_id=getattr(args, "user_id", None),
        pass_token=getattr(args, "pass_token", None),
        region=getattr(args, "region", None),
    )


def cmd_qr(args) -> int:
    import requests

    src = make_source(args)
    info = src.request_qr()
    QR_PNG.parent.mkdir(parents=True, exist_ok=True)
    png = requests.get(info["qr"], timeout=30).content
    QR_PNG.write_bytes(png)
    print(f"二维码已保存: {QR_PNG}")
    if info.get("loginUrl"):
        print(f"手机浏览器可打开: {info['loginUrl']}")
        # 该 URL 内含一次性登录凭据，只适合当前交互终端；落盘反而留下长期凭据载体。
        print("警告: 该链接为一次性登录地址，内含凭据，请勿保存或分享，也不要粘贴到日志。")
    print("请用「小米运动健康 / 米家 / 小米账号」App 扫码确认…")
    try:
        user_id, pass_token = src.poll_qr(info["lp"], int(info.get("timeout", 300)))
    except (TimeoutError, RuntimeError) as exc:
        print(f"扫码失败: {exc}")
        return 1
    print(f"登录成功: userId={mask_secret(str(user_id))}  passToken={mask(pass_token)}")
    return finish_credentials(args, user_id, pass_token)


def finish_credentials(args, user_id: str, pass_token: str) -> int:
    print("正在验证凭据并抽样最近 24 小时…")
    src = make_source(args)
    src.user_id = str(user_id)
    src.pass_token = pass_token
    try:
        src.login()
        now = int(time.time())
        counts = {}
        for key in ("heart_rate", "steps", "spo2"):
            try:
                counts[key] = len(src.fetch_key(key, now - 86400, now))
            except Exception:
                counts[key] = -1
    except Exception as exc:
        print(f"凭据验证失败: {type(exc).__name__}: {exc}")
        return 1
    print("  最近24h: " + "  ".join(f"{k}={v}" for k, v in counts.items()))

    path = resolve_config_path()
    if not path.exists():
        print(f"未找到配置文件: {path}")
        return 1
    text = path.read_text(encoding="utf-8")
    new_text = upsert_cloud_config(
        text, str(user_id), pass_token, region=args.region, lookback_days=args.lookback_days
    )
    backup = write_config(path, new_text)
    print(f"已写入 {path}（备份: {backup.name}）")
    touch_task()

    if not task_enabled():
        print("拉取任务当前未启用。启用: python backend/scripts/mi_cloud_setup.py --enable")
    else:
        print("拉取任务已启用，任务文件已 touch，调度器会热加载新凭据。")
    print("注意: 运行中的后端进程仍持有旧配置缓存；健康数据由任务子进程写入，通常无需重启。")
    return 0


def cmd_check(args) -> int:
    src = make_source(args)
    if not src.user_id or not src.pass_token:
        print("缺少凭据: config.yaml health.cloud.userid / passtoken 均为空")
        print("获取方式: python backend/scripts/mi_cloud_setup.py --qr")
        return 2
    print(f"凭据: userId={mask_secret(str(src.user_id))}  passToken={mask(src.pass_token)}  region={src.region}")
    now = int(time.time())
    start = now - max(1, args.days) * 86400
    try:
        src.login()
    except Exception as exc:
        print(f"登录失败: {type(exc).__name__}: {exc}")
        print("凭据可能已失效，请重新扫码: python backend/scripts/mi_cloud_setup.py --qr")
        return 1
    print(f"登录成功；统计最近 {args.days} 天各指标记录数：")
    from services.health.sources.cloud_pull import CloudAuthError

    failed_auth = False
    for key in CHECK_KEYS:
        if failed_auth:
            print(f"  {key:22s} 跳过（凭据失效）")
            continue
        try:
            print(f"  {key:22s} {len(src.fetch_key(key, start, now)):6d}")
        except CloudAuthError as exc:
            failed_auth = True
            print(f"  {key:22s} ERROR 凭据失效 code={exc.code}")
        except Exception as exc:
            print(f"  {key:22s} ERROR {type(exc).__name__}: {exc}")
    if failed_auth:
        print("\npassToken 已失效或账号需要重新授权。重新扫码：")
        print("  python backend/scripts/mi_cloud_setup.py --qr")
        return 1
    return 0


def cmd_status(args) -> int:
    from config.config import get_config
    from services.health_cloud_service import get_health_cloud_service

    cfg = get_config()
    state = load_state()
    svc_status = get_health_cloud_service().status()
    print("== 小米健康云数据源状态 ==")
    print(f"配置文件      : {resolve_config_path()}")
    print(f"自动拉取      : {'已启用' if svc_status['enabled'] else '未启用'} / phase={svc_status['phase']}")
    print(f"userId        : {mask_secret(str(cfg.HEALTH_CLOUD_USERID)) if cfg.HEALTH_CLOUD_USERID else '(未配置)'}")
    print(f"passToken     : {mask(cfg.HEALTH_CLOUD_PASSTOKEN)}")
    print(f"region        : {cfg.HEALTH_CLOUD_REGION}")
    print(f"拉取周期      : {cfg.HEALTH_CLOUD_POLL_INTERVAL_MIN} 分钟")
    print(f"重叠窗口      : {cfg.HEALTH_CLOUD_OVERLAP_DAYS} 天")
    print(f"首次回看      : {cfg.HEALTH_CLOUD_INITIAL_LOOKBACK_DAYS} 天")
    print(f"任务文件      : {'存在' if TASK_FILE.exists() else '缺失'} / enabled={task_enabled()}")
    watermark = svc_status.get("watermark")
    if watermark:
        print(f"上次成功水位  : {datetime.fromtimestamp(watermark, CST):%Y-%m-%d %H:%M:%S}")
    else:
        print("上次成功水位  : (从未成功)")
    print(f"连续失败次数  : {svc_status.get('consecutive_failures', 0)}")
    if svc_status.get("last_error"):
        print(f"最近错误      : {svc_status['last_error']}")
    print(f"最近 cloud 分片: {latest_cloud_shard()}")
    if not cfg.HEALTH_CLOUD_USERID or not cfg.HEALTH_CLOUD_PASSTOKEN:
        print("\n下一步: python backend/scripts/mi_cloud_setup.py --qr")
    elif not task_enabled():
        print("\n下一步: python backend/scripts/mi_cloud_setup.py --enable")
    return 0


def cmd_enable(args) -> int:
    from services.health_cloud_service import get_health_cloud_service

    get_health_cloud_service().set_enabled(True)
    print("已启用小米云自动拉取（运行时状态，无需重启后端）")
    print("状态文件: backend/data/health_cloud_state.json")
    return 0


def cmd_disable(args) -> int:
    from services.health_cloud_service import get_health_cloud_service

    get_health_cloud_service().set_enabled(False)
    print("已停用小米云自动拉取（运行时状态，已落盘分片保留）")
    return 0


def cmd_sync(args) -> int:
    from services.health_storage import get_health_store

    user_id = resolve_user_id()
    if not user_id:
        print("无法解析本地用户: 请设置 health.primary_user 或先登录 Web 创建用户")
        return 2
    src = make_source(args)
    if not src.user_id or not src.pass_token:
        print("缺少云端凭据: python backend/scripts/mi_cloud_setup.py --qr")
        return 2
    since = int(time.time()) - max(1, args.days) * 86400
    print(f"拉取 since={datetime.fromtimestamp(since, CST):%Y-%m-%d %H:%M}  user={user_id}")
    try:
        batches = src.fetch(since=since, user_id=user_id)
    except Exception as exc:
        print(f"拉取失败: {type(exc).__name__}: {exc}")
        return 1
    store = get_health_store()
    written = 0
    for batch in batches:
        store.write(batch)
        written += 1
    print(f"写入 {written} 个 cloud 分片批次；最近分片日期: {latest_cloud_shard()}")
    return 0


def _format_lag(seconds: int) -> str:
    if seconds < 60:
        return f"{seconds} 秒"
    if seconds < 3600:
        return f"{seconds // 60} 分钟"
    if seconds < 86400:
        return f"{seconds // 3600} 小时"
    return f"{seconds // 86400} 天"


def cmd_latest(args) -> int:
    from services.health_cloud_service import get_health_cloud_service

    result = get_health_cloud_service().latest_cloud_samples(int(args.hours))
    if not result.get("ok"):
        print(f"云端探测失败: {result.get('error')}")
        return 1
    now = result["now"]
    samples = result.get("samples") or {}
    print(f"云端最新样本（窗口 {result['window_hours']}h）：")
    if not samples:
        print("  (窗口内无任何指标样本)")
        return 1
    for key, ts in sorted(samples.items()):
        stamp = datetime.fromtimestamp(ts, CST).strftime("%Y-%m-%d %H:%M:%S")
        print(f"  {key:20s} {stamp}  (滞后 {_format_lag(now - ts)})")
    return 0


def cmd_backfill(args) -> int:
    from services.health_cloud_service import get_health_cloud_service

    days = int(args.backfill)
    result = get_health_cloud_service().backfill(days)
    if not result.get("ok"):
        print(f"回填失败: {result.get('error')}")
        return 1
    print(f"回填完成: 写入 {result['written']} 个 cloud 批次（{days} 天）")
    print(f"最近 cloud 分片: {latest_cloud_shard()}")
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="小米健康云凭据接入与自检（扫码登录 / 校验 / 启用任务 / 立即同步）"
    )
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--qr", action="store_true", help="扫码登录并写入 config.yaml")
    mode.add_argument("--user-id", help="直接提供小米 userId（配合 --pass-token）")
    mode.add_argument("--check", action="store_true", help="校验现有凭据并统计各指标记录数")
    mode.add_argument("--status", action="store_true", help="显示配置、任务与分片状态")
    mode.add_argument("--latest", action="store_true", help="探测云端各指标最新样本时间（滞后诊断）")
    mode.add_argument("--backfill", type=int, metavar="DAYS", help="回填最近 N 天的云端历史数据")
    mode.add_argument("--enable", action="store_true", help="启用后台自动拉取（运行时状态）")
    mode.add_argument("--disable", action="store_true", help="停用后台自动拉取")
    mode.add_argument("--sync", action="store_true", help="立即拉取并写入 HealthStore cloud 分片")
    parser.add_argument("--pass-token", help="小米 passToken（配合 --user-id）")
    parser.add_argument("--region", help="区域: cn/ru/de/i2/sg/us（默认沿用 config 或 cn）")
    parser.add_argument("--lookback-days", type=int, help="写入 config 的首次回看天数")
    parser.add_argument("--days", type=int, default=1, help="--check/--sync 的统计/回看天数（默认 1）")
    parser.add_argument("--hours", type=int, default=48, help="--latest 的探测窗口小时数（默认 48）")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.qr:
        return cmd_qr(args)
    if args.user_id:
        if not args.pass_token:
            print("--user-id 需要同时提供 --pass-token")
            return 2
        return finish_credentials(args, str(args.user_id), args.pass_token)
    if args.check:
        return cmd_check(args)
    if args.status:
        return cmd_status(args)
    if args.latest:
        return cmd_latest(args)
    if args.backfill:
        return cmd_backfill(args)
    if args.enable:
        return cmd_enable(args)
    if args.disable:
        return cmd_disable(args)
    if args.sync:
        return cmd_sync(args)
    return 2


if __name__ == "__main__":
    sys.exit(main())
