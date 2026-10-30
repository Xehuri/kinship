"""
维护管理路由 - 系统维护相关端点
"""

import os
import sys
import asyncio
import logging
import subprocess
from pathlib import Path

from fastapi import APIRouter, HTTPException

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/screen")

_RESTART_DELAY_S = 0.5
_BACKEND_DIR = Path(__file__).resolve().parents[1]


def _is_windows() -> bool:
    return sys.platform == "win32"


def _resolve_script_runner():
    try:
        from services.script_runner import get_script_runner

        return get_script_runner()
    except Exception:
        logger.exception("重启前获取 ScriptRunner 失败，跳过脚本停止")
        return None


async def _stop_scripts_before_exit() -> None:
    runner = _resolve_script_runner()
    if runner is None:
        logger.info("重启前无已初始化的 ScriptRunner，跳过脚本停止")
        return
    try:
        await runner.stop()
    except Exception:
        logger.exception("重启前停止脚本任务失败，继续退出")
        return
    logger.info("重启前已停止脚本任务管理器")


def _hard_exit(code: int) -> None:
    os._exit(code)


def _spawn_new_process() -> None:
    # 入口已从 `uvicorn main:app` 切到程序化 HotServer；显式 -m + cwd=backend
    # 保证重启后的进程与 launcher 启动形态一致（sys.argv 只含模块路径）。
    subprocess.Popen([sys.executable, "-m", "core.hot_server"], cwd=str(_BACKEND_DIR))


def _stop_kernel_for_restart() -> tuple[bool, str]:
    """重启前按 PID 停内核；返回 (能否继续, 原因)。

    Windows 上新后端会重新 spawn 内核，旧内核不停掉就会占用同一 state-dir，
    新实例的 ensure() 会抛 stale_kernel_detected（自动复用已删除）。因此必须先
    停内核再 Popen 新后端。归属无法证明等"拒绝终止"结果归一为 False，由路由
    映射成可读的 409；真正的停止异常（TerminateProcess/等待超时）上抛 500。
    成功后立刻关闸（fence_kernel_respawn），避免 os._exit 前的空窗里后台请求
    又拉起一个孤儿内核。
    """
    from services.kernel_client import fence_kernel_respawn, stop_kernel_process

    result = stop_kernel_process()
    reason = str(result.get("reason") or "")
    if result.get("stopped") or reason in ("no-pidfile", "not-running"):
        fence_kernel_respawn()
        return True, reason or "stopped"
    return False, reason or "unknown"


async def _do_restart() -> None:
    await asyncio.sleep(_RESTART_DELAY_S)
    await _stop_scripts_before_exit()
    # Linux：不自行 Popen 新进程——launcher.py 监控循环检测到后端退出会自动
    # 重启（systemd Restart=always 兜底），自行 Popen 会与监控重启形成双实例
    # 抢端口。必须先停脚本再硬退出，避免脚本包装进程成为孤儿。
    code = 0
    if _is_windows():
        try:
            _spawn_new_process()
        except Exception:
            logger.exception("重启时启动新进程失败")
            code = 1
        finally:
            _hard_exit(code)
        return
    _hard_exit(0)


@router.post("/restart")
async def restart_backend():
    """重启后端服务

    流程:
    1. Windows：先按 PID 停止内核（归属证明通过才终止）；失败返回 409/500，
       不启动新后端——否则新实例会与存活旧内核抢同一 state-dir
    2. 立即返回重启确认消息
    3. 后台等待 0.5 秒（确保响应已发送）
    4. 停止脚本任务管理器
    5. Windows 启动新进程后退出；Linux 交给 launcher/systemd 重启
    """
    if _is_windows():
        try:
            ok, detail = await asyncio.to_thread(_stop_kernel_for_restart)
        except Exception as exc:
            logger.exception("重启前停止内核失败，拒绝重启")
            raise HTTPException(
                status_code=500,
                detail="重启前停止内核失败: %s" % exc,
            ) from exc
        if not ok:
            logger.error("重启已拒绝：内核停止未成功 reason=%s", detail)
            raise HTTPException(
                status_code=409,
                detail="重启前停止内核失败: %s" % detail,
            )
    asyncio.create_task(_do_restart())
    return {"success": True, "message": "后端服务正在重启..."}
