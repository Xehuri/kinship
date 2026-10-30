# -*- coding: utf-8 -*-
"""
小米云拉取适配器（H5，架构文档 §3.6 协议，实测验证过的逆向实现移植）。

职责：
  - 登录       : serviceLogin(sid=miothealth) + &&&START&&& 剥离 + location 会话 Cookie
  - 签名       : RC4（预热丢前 1024 字节密钥流，小米特有不可省）+ SHA1 签名 + SHA256 派生
  - 取数       : get_fitness_data_by_time / get_sport_records_by_time，
                 next_key 游标去重 + 200 页硬上限
  - 认证失效   : HTTP 401/403 或业务码 -6/-10001 -> 重新登录并重试一次
  - 归一       : 云记录 -> HealthBatch。睡眠 state 码表（实测对账 App）：
                 2=deep, 3=light, 4=rem, 5=awake；1/未知 -> unknown。
                 同一归日组可有多条睡眠记录（主觉+小睡），各存一条 session，
                 顶层字段镜像 duration 最长的主觉。
                 steps/卡路里只有日总 -> 只写 daily_summary，绝不造样本
   - 落盘       : P2-V8 起归一产物（canonical HealthBatch）由任务脚本直写
                  HealthStore（source=cloud 分片；P2-V9 起 export_legacy
                  派生视图双写已退役）；
                  旧 canonical->/sync 线格式->再 canonical 的有损 round-trip
                  已退役（batch_to_sync_payload 删除，睡眠分段明细随直写落分片）

凭据来自 config health.cloud（userid / passtoken）；真实值只进 gitignored config.yaml。
测试一律用录制 fixture / monkeypatch，禁止真实网络调用。
"""
import base64
import hashlib
import json
import os
import struct
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional
from urllib.parse import urlencode

import requests

from config.config import get_config
from ..models import (
    DailySummary,
    DeviceRef,
    HealthBatch,
    HealthSample,
    SleepData,
    SleepSegment,
    SleepSession,
    sleep_session_key,
)
from .base import HealthSource

# 东八区（cn 区域时区，架构 §3.6：cn 用 UTC+8）
_CST = timezone(timedelta(hours=8))

# 登录响应前缀（serviceLogin 返回体以 &&&START&&& 开头，先剥掉再解析 JSON）
LOGIN_PREFIX = b"&&&START&&&"
ACCOUNT_LOGIN_URL = "https://account.xiaomi.com/pass/serviceLogin"
QR_LOGIN_URL = "https://account.xiaomi.com/longPolling/loginUrl"
DATA_SID = "miothealth"
# 扫码登录用 xiaomiio（小米账号通用）；换到的 passToken 对 miothealth 同样有效
QR_SID = "xiaomiio"
FITNESS_PATH = "/app/v1/data/get_fitness_data_by_time"
SPORT_PATH = "/app/v1/data/get_sport_records_by_time"

# 分页硬上限（架构 §3.6：建议上限 200 页）
MAX_PAGES = 200

# 云睡眠 state 码表（2026-10-27 逐条对账小米运动 App 的实测真值）：
# 2=deep, 3=light, 4=rem, 5=awake；1 与未知码一律 unknown，2/3 绝不合并
CLOUD_SLEEP_STATE_TO_ENUM = {
    2: "deep",
    3: "light",
    4: "rem",
    5: "awake",
}


class CloudAuthError(Exception):
    """云侧认证失效（HTTP 401/403 或业务码 -6/-10001），可重新登录重试。"""

    def __init__(self, code: Any):
        self.code = code
        super().__init__(f"小米云认证失效 code={code}")


def rc4_crypt(key: bytes, payload: bytes) -> bytes:
    """标准 RC4，但预热阶段丢弃前 1024 字节密钥流（小米特有，不能省）。"""
    s = list(range(256))
    j = 0
    key_len = len(key)
    for i in range(256):
        j = (j + s[i] + key[i % key_len]) % 256
        s[i], s[j] = s[j], s[i]

    i = 0
    j = 0

    def next_byte() -> int:
        nonlocal i, j
        i = (i + 1) % 256
        j = (j + s[i]) % 256
        s[i], s[j] = s[j], s[i]
        return s[(s[i] + s[j]) % 256]

    for _ in range(1024):
        next_byte()

    return bytes(value ^ next_byte() for value in payload)


def gen_nonce() -> bytes:
    """12 字节随机数：8 字节 urandom + 4 字节大端「当前分钟时间戳」。"""
    raw = bytearray(os.urandom(8))
    raw.extend(struct.pack(">I", int(datetime.now().timestamp() // 60)))
    return bytes(raw)


def gen_signed_nonce(ssecurity: bytes, nonce: bytes) -> bytes:
    """SHA256(ssecurity + nonce) 派生签名密钥。"""
    return hashlib.sha256(ssecurity + nonce).digest()


def gen_signature(method: str, path: str, values: Dict[str, str],
                  signed_nonce: bytes) -> str:
    """SHA1 签名串（base64），构造顺序见架构 §3.6。"""
    base = method + "&" + path + "&data=" + values["data"]
    if "rc4_hash__" in values:
        base += "&rc4_hash__=" + values["rc4_hash__"]
    base += "&" + base64.b64encode(signed_nonce).decode()
    return base64.b64encode(hashlib.sha1(base.encode()).digest()).decode()


def read_login_payload(text: str) -> dict:
    """登录接口响应带 &&&START&&& 前缀，剥掉后解析 JSON。"""
    body = text.encode()
    if not body.startswith(LOGIN_PREFIX):
        raise RuntimeError("非预期的登录响应（缺少 &&&START&&& 前缀）")
    return json.loads(body[len(LOGIN_PREFIX):].decode())


def poll_interval_minutes() -> int:
    """云端拉取周期（分钟），来自 config health.cloud_poll_interval_min（默认 30）。"""
    return get_config().HEALTH_CLOUD_POLL_INTERVAL_MIN


def _parse_value(raw: Any) -> Dict[str, Any]:
    """记录 value 字段：JSON 字符串二次 loads（架构 §3.6），已是 dict 则直用。"""
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
        except (ValueError, TypeError):
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return raw if isinstance(raw, dict) else {}


class CloudPullSource(HealthSource):
    """小米健康云 pull 适配器。"""

    source_id = "cloud"
    direction = "pull"

    def __init__(
        self,
        user_id: Optional[str] = None,
        pass_token: Optional[str] = None,
        region: Optional[str] = None,
        timeout: float = 20.0,
    ):
        cfg = get_config()
        # 凭据：显式参数 > config health.cloud（真实值只在 gitignored config.yaml）
        self.user_id = str(user_id or cfg.HEALTH_CLOUD_USERID or "")
        self.pass_token = str(pass_token or cfg.HEALTH_CLOUD_PASSTOKEN or "")
        self.region = region or cfg.HEALTH_CLOUD_REGION or "cn"
        self._ssecurity: bytes = b""
        self._cookies: str = ""
        self._logged_in = False
        self._session = requests.Session()
        self._timeout = timeout

    # ---- 区域与时间 ---------------------------------------------------

    def base_url(self) -> str:
        """区域路由：cn -> https://hlth.io.mi.com；其他 -> https://{region}.hlth.io.mi.com。"""
        if self.region in ("", "cn"):
            return "https://hlth.io.mi.com"
        return f"https://{self.region}.hlth.io.mi.com"

    def _tz(self):
        """cn 用 UTC+8，其他区域用 UTC（架构 §3.6）。"""
        return _CST if self.region in ("", "cn") else timezone.utc

    # ---- 登录 ---------------------------------------------------------

    def login(self) -> None:
        """建立 miothealth 会话（幂等；凭据缺失/失效时抛异常，供校验与工具调用）。"""
        if not self._logged_in:
            self._login()

    def request_qr(self) -> Dict[str, Any]:
        """申请扫码登录：返回 {qr, lp, loginUrl, timeout}。

        只申请参数，不下载图片、不落盘；文件与终端呈现由调用方决定。
        """
        params = {
            "_qrsize": "480",
            "qs": "%3Fsid%3Dxiaomiio%26_json%3Dtrue",
            "callback": "https://sts.api.io.mi.com/sts",
            "_hasLogo": "false",
            "sid": QR_SID,
            "serviceParam": "",
            "_locale": "zh_CN",
            "_dc": str(int(datetime.now().timestamp() * 1000)),
        }
        resp = self._session.get(QR_LOGIN_URL, params=params, timeout=self._timeout)
        resp.raise_for_status()
        text = resp.text
        if text.startswith(LOGIN_PREFIX.decode()):
            text = text[len(LOGIN_PREFIX):]
        data = json.loads(text)
        if not data.get("qr") or not data.get("lp"):
            raise RuntimeError(f"小米未返回二维码参数：{list(data)[:8]}")
        return data

    def poll_once(self, lp: str) -> Optional[tuple]:
        """单次查询扫码结果；未完成返回 None，成功返回 (user_id, pass_token)。"""
        try:
            poll = self._session.get(lp, timeout=min(5, self._timeout))
        except requests.RequestException:
            return None
        if poll.status_code != 200:
            return None
        text = poll.text
        if text.startswith(LOGIN_PREFIX.decode()):
            text = text[len(LOGIN_PREFIX):]
        try:
            body = json.loads(text)
        except json.JSONDecodeError:
            return None
        if body.get("code") == 0 and body.get("userId"):
            pass_token = body.get("passToken", "")
            if not pass_token:
                raise RuntimeError("扫码成功但未返回 passToken")
            self.user_id = str(body["userId"])
            self.pass_token = pass_token
            return self.user_id, self.pass_token
        return None

    def poll_qr(self, lp: str, timeout_seconds: int = 300) -> tuple:
        """轮询扫码结果，成功返回 (user_id, pass_token)，超时抛 TimeoutError。"""
        deadline = time.time() + max(1, int(timeout_seconds))
        while time.time() < deadline:
            result = self.poll_once(lp)
            if result:
                return result
            time.sleep(1)
        raise TimeoutError("扫码超时，请重试")

    def latest_sample_ts(
        self, keys: Optional[List[str]] = None, window_hours: int = 48
    ) -> Dict[str, int]:
        """探测云端各指标最新样本时间戳（秒）；失败指标跳过。"""
        end_ts = int(time.time())
        start_ts = end_ts - max(1, int(window_hours)) * 3600
        return self.latest_sample_ts_between(keys, start_ts, end_ts)

    def latest_sample_ts_between(
        self, keys: Optional[List[str]], start_ts: int, end_ts: int
    ) -> Dict[str, int]:
        """在给定窗口内探测各指标最新样本时间戳（秒）；失败指标跳过。"""
        from .registry import CLOUD_FETCH_KEYS

        if not self._logged_in:
            self._login()
        result: Dict[str, int] = {}
        errors: List[Exception] = []
        for key in keys or CLOUD_FETCH_KEYS:
            try:
                records = self.fetch_key(key, int(start_ts), int(end_ts))
            except Exception as exc:
                errors.append(exc)
                continue
            latest = 0
            for rec in records:
                try:
                    ts = int(rec.get("time") or 0)
                except (TypeError, ValueError):
                    continue
                latest = max(latest, ts)
            if latest:
                result[key] = latest
        if not result and errors:
            auth_error = next(
                (e for e in errors if isinstance(e, CloudAuthError)), None
            )
            raise auth_error or errors[0]
        return result

    def _login(self) -> None:
        """userId + passToken 换 miothealth 会话（ssecurity + 会话 Cookie）。"""
        if not self.user_id or not self.pass_token:
            raise RuntimeError(
                "缺少小米云凭据（config health.cloud.userid / passtoken）"
            )
        resp = self._session.get(
            f"{ACCOUNT_LOGIN_URL}?_json=true&sid={DATA_SID}",
            headers={
                "Cookie": f"userId={self.user_id}; passToken={self.pass_token}"
            },
            timeout=self._timeout,
            allow_redirects=False,
        )
        if resp.status_code in (401, 403):
            raise CloudAuthError(resp.status_code)
        resp.raise_for_status()
        payload = read_login_payload(resp.text)
        missing = [
            k for k in ("passToken", "ssecurity", "userId", "location")
            if k not in payload
        ]
        if missing:
            raise RuntimeError(
                f"token 登录失败，缺少字段 {missing}；"
                f"code={payload.get('code')} desc={payload.get('desc') or payload.get('description')}"
            )
        self._ssecurity = base64.b64decode(payload["ssecurity"])
        self.pass_token = payload.get("passToken") or self.pass_token
        # GET location 收集会话 Cookie（cUserId / serviceToken），数据请求显式携带
        redirect = self._session.get(
            payload["location"], timeout=self._timeout, allow_redirects=False
        )
        redirect.raise_for_status()
        set_cookies = (
            redirect.raw.headers.getlist("Set-Cookie")
            if getattr(redirect, "raw", None) is not None
            else []
        )
        self._cookies = "; ".join(
            c.split(";", 1)[0] for c in set_cookies
        )
        self._logged_in = True

    # ---- 签名请求 -------------------------------------------------------

    def _signed_post(self, path: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        """按小米云协议加密 POST 并解密响应，返回 result。

        认证失效（HTTP 401/403 或业务码 -6/-10001）抛 CloudAuthError 交给
        _post_retry 重新登录；其余业务码非 0 抛 RuntimeError。
        """
        if not self._logged_in:
            self._login()
        nonce = gen_nonce()
        signed_nonce = gen_signed_nonce(self._ssecurity, nonce)

        form: Dict[str, str] = {
            "data": json.dumps(payload, separators=(",", ":")),
        }
        form["rc4_hash__"] = gen_signature("POST", path, form, signed_nonce)
        encrypted = {
            k: base64.b64encode(rc4_crypt(signed_nonce, v.encode())).decode()
            for k, v in form.items()
        }
        encrypted["signature"] = gen_signature(
            "POST", path, encrypted, signed_nonce
        )
        encrypted["_nonce"] = base64.b64encode(nonce).decode()

        resp = self._session.post(
            self.base_url() + path,
            headers={
                "Cookie": self._cookies,
                "Content-Type": "application/x-www-form-urlencoded",
            },
            data=urlencode(encrypted),
            timeout=self._timeout,
        )
        if resp.status_code in (401, 403):
            raise CloudAuthError(resp.status_code)
        resp.raise_for_status()
        plaintext = rc4_crypt(signed_nonce, base64.b64decode(resp.text))
        body = json.loads(plaintext)
        code = body.get("code")
        if code in (401, 403, -6, -10001):
            raise CloudAuthError(code)
        if code != 0:
            raise RuntimeError(
                f"接口错误 code={code} msg={body.get('message')}"
            )
        return body.get("result", {})

    def _post_retry(self, path: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        """认证失效时重新登录并重试一次（重试仍失败直接上抛，绝不无限重登）。"""
        try:
            return self._signed_post(path, payload)
        except CloudAuthError:
            self._login()
            return self._signed_post(path, payload)

    # ---- 取数 -----------------------------------------------------------

    def fetch_key(self, key: str, start_time: int, end_time: int) -> List[dict]:
        """拉取单指标全部记录：next_key 游标去重防环 + 200 页硬上限。"""
        items: List[dict] = []
        seen: set = set()
        next_key: Optional[str] = None
        for _ in range(MAX_PAGES):
            req: Dict[str, Any] = {
                "start_time": int(start_time),
                "end_time": int(end_time),
                "key": key,
            }
            if next_key:
                req["next_key"] = next_key
            result = self._post_retry(FITNESS_PATH, req)
            items.extend(result.get("data_list", []))
            if not result.get("has_more") or not result.get("next_key"):
                break
            cursor = str(result["next_key"])
            if cursor in seen:
                break  # 游标成环，防御性截断
            seen.add(cursor)
            next_key = cursor
        return items

    def fetch_sport_records(self, start_time: int, end_time: int) -> List[dict]:
        """运动记录端点（分页规则同上；数据暂不进 canonical，供后续扩展）。"""
        items: List[dict] = []
        seen: set = set()
        next_key: Optional[str] = None
        for _ in range(MAX_PAGES):
            req: Dict[str, Any] = {
                "start_time": int(start_time),
                "end_time": int(end_time),
                "limit": 50,
            }
            if next_key:
                req["next_key"] = next_key
            result = self._post_retry(SPORT_PATH, req)
            items.extend(result.get("sport_records", []))
            if not result.get("has_more") or not result.get("next_key"):
                break
            cursor = str(result["next_key"])
            if cursor in seen:
                break
            seen.add(cursor)
            next_key = cursor
        return items

    def fetch(
        self,
        since: Optional[int] = None,
        until: Optional[int] = None,
        user_id: Optional[str] = None,
    ) -> List[HealthBatch]:
        """按 since 水位拉取全部指标 -> 按日分组 -> 归一为 HealthBatch 列表。

        分组规则：睡眠按 wake_up_time 归【起床日】（架构 §9），其余按 record.time
        归日（cn 区域 UTC+8）。单指标拉取失败不断全盘（告警后继续下一指标）。

        H6：归一必须带 user_id（调用方传入已解析用户）；缺失时 normalize 会
        显式报错而非降级 default —— 拉取任务须把 token 对应的本地用户传进来。
        """
        if not self._logged_in:
            self._login()
        end_ts = int(until or time.time())
        start_ts = int(since or end_ts - 3 * 86400)

        records: List[dict] = []
        errors: List[Exception] = []
        from .registry import CLOUD_FETCH_KEYS  # 惰性导入避免环
        for key in CLOUD_FETCH_KEYS:
            try:
                records.extend(self.fetch_key(key, start_ts, end_ts))
            except Exception as exc:
                errors.append(exc)
                continue
        if not records and errors:
            auth_error = next(
                (e for e in errors if isinstance(e, CloudAuthError)), None
            )
            raise auth_error or errors[0]

        groups: Dict[str, List[dict]] = {}
        for rec in records:
            date_str = self._record_date(rec)
            groups.setdefault(date_str, []).append(rec)

        device_id = f"cloud:{self.user_id}" if self.user_id else "cloud"
        batches = [
            self.normalize({
                "date": date_str,
                "records": groups[date_str],
                "device_id": device_id,
                "user_id": user_id,
            })
            for date_str in sorted(groups)
        ]
        return batches

    def _record_date(self, rec: dict) -> str:
        """记录归日：睡眠按 wake_up_time（起床日），其余按 time（东八区）。"""
        tz = self._tz()
        if rec.get("key") == "sleep":
            value = _parse_value(rec.get("value"))
            wake = value.get("wake_up_time") or value.get("device_wake_up_time")
            if wake:
                try:
                    return datetime.fromtimestamp(int(wake), tz).strftime("%Y-%m-%d")
                except (ValueError, OSError, TypeError):
                    pass
        try:
            return datetime.fromtimestamp(int(rec.get("time") or 0), tz).strftime(
                "%Y-%m-%d"
            )
        except (ValueError, OSError):
            return datetime.now(tz).strftime("%Y-%m-%d")

    # ---- 归一 -----------------------------------------------------------

    def normalize(self, raw: Dict[str, Any]) -> HealthBatch:
        """云记录集（单日）-> HealthBatch。

        raw: {date, records, user_id?, device_id?}
        - steps / calories : 日总 -> daily_summary（绝不造样本）
        - heart_rate/spo2/stress : -> 样本（同 t 合并为一条）
        - resting_heart_rate -> hr_resting；sleep -> SleepData（多条各存 session）
        - weight / abnormal_heart_beat : canonical 模型暂无落点，取数但不落批
        """
        from ...health import devices as devices_mod

        date_str = raw["date"]
        records = raw.get("records") or []
        # H6：user_id 必须由调用方显式传入（任务脚本从 auth.json 的 token 记录
        # 解析出的本地用户，P2-V8 直写链以此绑定分片归属；旧 round-trip 时代由
        # /sync 认证身份覆盖）；缺失即报错，绝不自造 "default"。本层的降级只会
        # 污染内存批次与设备注册表 owner，故直接拒绝
        user_id = raw.get("user_id")
        if not user_id:
            raise ValueError(
                "cloud_pull.normalize 缺少 user_id：必须由调用方传入"
                "已解析用户（回传 /sync 后由路由层认证身份覆盖），禁止 default 降级"
            )
        device_id = raw.get("device_id") or (
            f"cloud:{self.user_id}" if self.user_id else "cloud"
        )

        sample_fields: Dict[int, Dict[str, Any]] = {}

        def _merge(t: int, **fields: Any) -> None:
            entry = sample_fields.setdefault(int(t), {"t": int(t)})
            for name, value in fields.items():
                if value is not None:
                    entry[name] = value

        daily: Dict[str, Any] = {}
        steps_best: Optional[Dict[str, Any]] = None  # 日总取 time 最新快照
        calories_best: Optional[Dict[str, Any]] = None
        sleep_values: List[dict] = []

        for rec in records:
            key = rec.get("key")
            value = _parse_value(rec.get("value"))
            try:
                t = int(rec.get("time") or 0)
            except (TypeError, ValueError):
                continue

            if key == "steps":
                # 云侧只有日总快照：只写 daily_summary.total_steps，绝不造样本
                steps_val = value.get("steps")
                if steps_val is not None and (
                    steps_best is None or t >= int(steps_best.get("time") or 0)
                ):
                    steps_best = {"time": t, "steps": int(steps_val)}
            elif key == "calories":
                cal_val = value.get("calories")
                if cal_val is not None and (
                    calories_best is None
                    or t >= int(calories_best.get("time") or 0)
                ):
                    calories_best = {"time": t, "calories": int(cal_val)}
            elif key == "heart_rate":
                bpm = value.get("bpm")
                if bpm is not None:
                    _merge(t, hr=int(bpm))
            elif key == "spo2":
                spo2 = value.get("spo2")
                if spo2 is not None:
                    _merge(t, spo2=int(spo2))
            elif key == "stress":
                stress = value.get("stress")
                if stress is not None:
                    _merge(t, stress=int(stress))
            elif key == "resting_heart_rate":
                bpm = value.get("bpm")
                if bpm is not None:
                    daily["hr_resting"] = int(bpm)
            elif key == "sleep":
                sleep_values.append(value)
            # weight / abnormal_heart_beat：canonical 无落点，跳过

        sleep_obj = self._normalize_sleep(sleep_values)
        samples = [HealthSample(**fields) for _, fields in sorted(sample_fields.items())]

        # 日汇总派生（与 upload-db 同口径；hr_resting 优先云侧 resting 记录）
        hr_vals = [s.hr for s in samples if s.hr is not None]
        if hr_vals:
            if "hr_resting" not in daily:
                daily["hr_resting"] = min(hr_vals)
            daily["hr_avg"] = int(sum(hr_vals) / len(hr_vals))
            daily["hr_max"] = max(hr_vals)
            daily["hr_min"] = min(hr_vals)
        stress_vals = [s.stress for s in samples if s.stress is not None]
        if stress_vals:
            daily["stress_avg"] = int(sum(stress_vals) / len(stress_vals))
        spo2_vals = [s.spo2 for s in samples if s.spo2 is not None]
        if spo2_vals:
            daily["spo2_avg"] = int(sum(spo2_vals) / len(spo2_vals))
        if steps_best is not None:
            daily["total_steps"] = steps_best["steps"]
        if calories_best is not None:
            daily["calories"] = calories_best["calories"]

        device = DeviceRef(
            device_id=device_id,
            label=None,
            kind="cloud",
            owner_user_id=user_id,
            source_id="cloud",
        )
        # 自动注册（首见建档；失败不阻断归一）
        try:
            devices_mod.register(
                device_id=device_id,
                device_name=None,
                owner=user_id,
                kind="cloud",
                source_id="cloud",
            )
        except Exception:
            pass

        return HealthBatch(
            source_id="cloud",
            user_id=user_id,
            device=device,
            date=date_str,
            samples=samples,
            daily_summary=DailySummary.from_dict(daily) if daily else None,
            sleep=sleep_obj,
            battery=[],
            fetched_at=int(time.time()),
        )

    @staticmethod
    def _normalize_sleep(values: List[dict]) -> Optional[SleepData]:
        """云睡眠记录（可多条）-> canonical SleepData。

        每条记录 = 一个 SleepSession（主觉/小睡各存、原始 items 保留）；
        顶层字段镜像 duration 最长的主觉。原始 sleep_*_duration / awake_count
        优先且 0 值保真，缺失时才由 items 段时长推导。
        """
        sessions: List[SleepSession] = []
        for value in values:
            session = _sleep_session(value)
            if session is not None:
                sessions.append(session)
        if not sessions:
            return None

        unkeyed: List[SleepSession] = []
        keyed: Dict[tuple, SleepSession] = {}
        for session in sessions:
            key = sleep_session_key(session.to_dict())
            if key is None:
                unkeyed.append(session)
            else:
                keyed[key] = session  # 同键后到者覆盖
        sessions = unkeyed + list(keyed.values())
        sessions.sort(
            key=lambda s: (s.wakeup is None, s.wakeup or 0, s.bedtime or 0)
        )

        primary = max(
            sessions,
            key=lambda s: (
                s.duration
                if s.duration is not None
                else sum(
                    seg.duration_min for seg in s.stages if seg.stage != "awake"
                ) or 0,
                s.wakeup or 0,
            ),
        )
        return SleepData(
            duration_min=primary.duration,
            deep_min=primary.deep,
            light_min=primary.light,
            rem_min=primary.rem,
            awake_min=primary.awake,
            wakeup_time=primary.wakeup,
            segments=list(primary.stages),
            awake_count=primary.awake_count,
            bedtime=primary.bedtime,
            sleep_sessions=sessions,
        )


def _sleep_session(value: Any) -> Optional[SleepSession]:
    """单条云睡眠记录 -> SleepSession；无任何可识别字段时返回 None。"""
    if not isinstance(value, dict) or not value:
        return None
    segments, items = _parse_sleep_items(value.get("items"))
    has_items = bool(items)

    deep = _raw_int(value, "sleep_deep_duration")
    if deep is None and has_items:
        deep = _sum_stage(segments, "deep")
    light = _raw_int(value, "sleep_light_duration")
    if light is None and has_items:
        light = _sum_stage(segments, "light")
    rem = _raw_int(value, "sleep_rem_duration")
    if rem is None and has_items:
        rem = _sum_stage(segments, "rem")
    awake = _raw_int(value, "sleep_awake_duration")
    if awake is None and has_items:
        awake = _sum_stage(segments, "awake")
    awake_count = _raw_int(value, "awake_count")
    if awake_count is None and has_items:
        awake_count = sum(1 for seg in segments if seg.stage == "awake")

    duration = _raw_int(value, "duration")
    if duration is None:
        if deep is not None and light is not None and rem is not None:
            duration = deep + light + rem
        elif has_items:
            duration = sum(
                seg.duration_min for seg in segments if seg.stage != "awake"
            )

    bedtime = _raw_int(value, "bedtime")
    if bedtime is None:
        bedtime = _raw_int(value, "device_bedtime")
    if bedtime is None and items:
        bedtime = min(item["start_time"] for item in items)

    wakeup = _raw_int(value, "wake_up_time")
    if wakeup is None:
        wakeup = _raw_int(value, "device_wake_up_time")
    if wakeup is None and items:
        wakeup = max(item["end_time"] for item in items)

    scalars = (bedtime, wakeup, duration, deep, light, rem, awake, awake_count)
    if all(field is None for field in scalars) and not items:
        return None

    return SleepSession(
        bedtime=bedtime,
        wakeup=wakeup,
        duration=duration,
        deep=deep,
        light=light,
        rem=rem,
        awake=awake,
        awake_count=awake_count,
        items=items,
        stages=segments,
    )


def _parse_sleep_items(raw_items: Any) -> tuple:
    """云 items -> (SleepSegment 列表, 按 start_time 排序的原始 item 列表)。"""
    parsed: List[tuple] = []
    for item in raw_items if isinstance(raw_items, list) else []:
        if not isinstance(item, dict):
            continue
        try:
            start = int(item["start_time"])
            end = int(item["end_time"])
            state = int(item.get("state", 0))
        except (KeyError, TypeError, ValueError):
            continue
        parsed.append((start, end, state))
    parsed.sort(key=lambda entry: entry[0])

    segments: List[SleepSegment] = []
    items: List[Dict[str, int]] = []
    for start, end, state in parsed:
        stage = CLOUD_SLEEP_STATE_TO_ENUM.get(state, "unknown")
        segments.append(
            SleepSegment(
                start_ts=start,
                stage=stage,
                duration_min=int(max(0, end - start) // 60),
            )
        )
        items.append({"start_time": start, "end_time": end, "state": state})
    return segments, items


def _sum_stage(segments: List[SleepSegment], stage: str) -> int:
    """阶段段时长合计（无该阶段时为 0，0 是合法值而非缺失）。"""
    return sum(seg.duration_min for seg in segments if seg.stage == stage)


def _raw_int(value: Dict[str, Any], key: str) -> Optional[int]:
    """原始字段取整：键存在且非 None 才采用（0 合法）；非法值视同缺失。"""
    if key not in value or value[key] is None:
        return None
    return _as_int_or_none(value[key])


def _as_int_or_none(v: Any) -> Optional[int]:
    """可选整数字段：None 保留，其余转 int；非法值返回 None。"""
    if v is None:
        return None
    try:
        return int(v)
    except (TypeError, ValueError):
        return None
