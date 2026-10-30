# -*- coding: utf-8 -*-
"""用户提醒板持久化存储（reminders 通道，v2 单文本板模型）。

v2 领域模型：每用户一块**常驻文本板**，AI 先读全文、编辑后整块覆盖写回——
没有条目 id、没有完成/删除生命周期（v1 逐条清单模型已废除）。设备端小部件
滚动展示板内全文，"读→改→覆盖"循环即全部生命周期。

与通知历史（notifications.py 的内存字典，重启即丢）刻意不同：本存储以
**文件系统为唯一真源**，每次写入全量重写用户文件，后端重启后数据仍在。

目录布局（沿用 health/paths.py 的 users/{user_id}/ 分用户约定）：
    {DATA_DIR}/users/{user_id}/reminders.json
    DATA_DIR = config.config.get_config().DATA_DIR（data.dir，默认 ai/data；
    每次操作时现读，测试重定向配置单例即可生效，不缓存快照）。

文件形状（v2，全量重写，文件恒小）：
    {"text": str, "updated_at": int}   # updated_at = unix 秒，0 = 从未写入
    - 读到一个"形状不是 v2"的文件（含 v1 遗留 {"next_id","items"} 与损坏
      JSON）一律按**空板**处理（text=""、updated_at=0）：不抛错、不自动迁移；
      下一次成功写入自然原子覆盖为 v2 形状。

并发与崩溃安全：
    - 读 / 写全程持一把模块级 RLock（单文件全量重写，锁粒度到进程级即可）；
    - 落盘走"同目录临时文件 + os.replace 原子替换"（health/store.py 同款模式，
      同盘 rename 原子，崩溃不留半个 JSON）。
"""
import json
import logging
import os
import tempfile
import threading
import time
from typing import Optional, Tuple

from config.config import get_config

logger = logging.getLogger(__name__)

# 提醒板全文长度上限（字符）：去首尾空白后校验，超限拒绝写入（路由层映射 400）
MAX_TEXT_LEN = 2000

# 空板返回值：text=""、updated_at=0（0 = 从未成功写入过）
_EMPTY_BOARD: Tuple[str, int] = ("", 0)

# 每用户文件名（位于 {DATA_DIR}/users/{user_id}/ 下）
_FILE_NAME = "reminders.json"

# 读/写互斥锁：全量重写语义下粗粒度即安全（文件小、操作低频）
_LOCK = threading.RLock()


def _validate_user_id(user_id: str) -> None:
    """user_id 非空且不含路径分隔符（防目录穿越，health/paths.py 同款规则）。"""
    if not isinstance(user_id, str) or not user_id.strip():
        raise ValueError(f"user_id 不能为空: {user_id!r}")
    if user_id in (".", "..") or any(sep in user_id for sep in ("/", "\\")):
        raise ValueError(f"user_id 含非法路径字符: {user_id!r}")


class RemindersBoard:
    """单用户提醒板的持久化仓储（无内存缓存，一切以落盘文件为准）。

    data_root 显式传入时固定使用（测试/独立实例）；缺省 None 时每次操作
    现读 config.DATA_DIR——配置单例被重定向（测试夹具）即随之生效。
    """

    def __init__(self, data_root: Optional[str] = None):
        self._data_root = data_root

    # ── 路径解析 ──────────────────────────────────────

    def _resolve_root(self) -> str:
        """数据根目录：构造参数优先，否则现读配置 DATA_DIR（不快照）。"""
        if self._data_root is not None:
            return self._data_root
        return get_config().DATA_DIR

    def _user_file(self, user_id: str) -> str:
        """用户提醒板文件绝对路径：{root}/users/{user_id}/reminders.json。"""
        _validate_user_id(user_id)
        return os.path.join(self._resolve_root(), "users", user_id, _FILE_NAME)

    # ── 文件读写（内部原语，调用方须已持锁）──────────────

    def _load_unlocked(self, user_id: str) -> Tuple[str, int]:
        """读用户提醒板文件，返回 (text, updated_at)。

        容错规则（v2 契约）：文件不存在、JSON 损坏、或形状不是
        {"text": str, "updated_at": int}（含 v1 遗留清单形状）时，一律
        返回空板 ("", 0)——不抛错、不改写文件（读侧零副作用，绝不把
        legacy 文件"顺手迁移"掉；下一次成功写入才原子覆盖为 v2）。
        """
        path = self._user_file(user_id)
        if not os.path.exists(path):
            return _EMPTY_BOARD
        try:
            with open(path, "r", encoding="utf-8") as f:
                raw = json.load(f)
        except (OSError, ValueError):
            # ValueError 覆盖 json.JSONDecodeError 与 UnicodeDecodeError：
            # 损坏文件按空板处理（v2 契约，与 v1"失败要看得见"刻意相反）
            logger.warning(f"[Reminders] 提醒板文件不可解析，按空板处理: {path}")
            return _EMPTY_BOARD
        if (
            isinstance(raw, dict)
            and isinstance(raw.get("text"), str)
            and isinstance(raw.get("updated_at"), int)
            and not isinstance(raw.get("updated_at"), bool)
        ):
            return (raw["text"], raw["updated_at"])
        # 形状非 v2（v1 {"next_id","items"} 或任意他形）：空板，原文件保留
        logger.warning(f"[Reminders] 提醒板文件形状非 v2，按空板处理: {path}")
        return _EMPTY_BOARD

    def _save_unlocked(self, user_id: str, text: str, updated_at: int) -> None:
        """全量重写用户文件为 v2 形状：同目录临时文件 + os.replace 原子替换。"""
        path = self._user_file(user_id)
        directory = os.path.dirname(path)
        os.makedirs(directory, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=directory, suffix=".tmp", prefix=".reminders_")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump({"text": text, "updated_at": updated_at}, f,
                          ensure_ascii=False, indent=2)
            os.replace(tmp, path)
        except BaseException:
            # 失败时清理临时文件，避免残留
            try:
                if os.path.exists(tmp):
                    os.unlink(tmp)
            except OSError:
                pass
            raise

    # ── 对外操作 ──────────────────────────────────────

    def get_board(self, user_id: str) -> Tuple[str, int]:
        """读当前提醒板全文，返回 (text, updated_at)。

        从未写入 / 形状非 v2 / 文件损坏 → ("", 0)（空板，不抛错）。
        """
        with _LOCK:
            return self._load_unlocked(user_id)

    def put_board(self, user_id: str, text: str) -> Tuple[str, int]:
        """整块覆盖提醒板，返回落盘后的 (text, updated_at)。

        规则（v2 契约）：
        - text 必须是 str（非 str 抛 ValueError，路由层映射 400）；
        - 去首尾空白后落盘；空白内容 = 合法"清空"（板置空，updated_at 照刷）；
        - 去首尾空白后长度 > MAX_TEXT_LEN 抛 ValueError（路由层映射 400）；
        - updated_at = int(time.time())，服务端写入时刻现取。
        """
        if not isinstance(text, str):
            raise ValueError(f"提醒板内容必须是字符串: {type(text).__name__}")
        cleaned = text.strip()
        if len(cleaned) > MAX_TEXT_LEN:
            raise ValueError(f"提醒板内容超过 {MAX_TEXT_LEN} 字符上限")
        updated_at = int(time.time())
        with _LOCK:
            self._save_unlocked(user_id, cleaned, updated_at)
        if cleaned:
            logger.info(f"[Reminders] 提醒板已覆盖 user={user_id}: len={len(cleaned)}")
        else:
            logger.info(f"[Reminders] 提醒板已清空 user={user_id}")
        return (cleaned, updated_at)


# ── 模块级单例（懒建，路由层唯一入口）────────────────────

_board_instance: Optional[RemindersBoard] = None
_board_lock = threading.Lock()


def get_reminders_board() -> RemindersBoard:
    """提醒板存储单例（data_root 动态跟随配置 DATA_DIR，测试重定向即生效）。"""
    global _board_instance
    if _board_instance is None:
        with _board_lock:
            if _board_instance is None:
                _board_instance = RemindersBoard()
    return _board_instance
