# 解决 OpenMP 库冲突问题 (libomp.dll vs libiomp5md.dll)
import os
os.environ['KMP_DUPLICATE_LIB_OK'] = 'TRUE'
# 关闭 tqdm 进度条输出（Wave C1 后外层零 ML 模型，本行仅防御间接依赖链
# 或第三方库的 tqdm 噪声，行为无害保留）
os.environ['TQDM_DISABLE'] = '1'

"""Axeuh Health Monitor - FastAPI Main Entry"""
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse
from pathlib import Path
from typing import Optional
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from starlette.datastructures import MutableHeaders
from starlette.responses import JSONResponse
from middleware.auth_middleware import AuthMiddleware
from middleware.onboarding_gate import OnboardingGateMiddleware
from contextlib import asynccontextmanager
import asyncio, logging, time
from core.log_setup import setup_logging
from core.redaction import install_uvicorn_redaction
setup_logging(None)  # 配置 root logger，所有子模块继承 INFO 级别
install_uvicorn_redaction()  # uvicorn 自身 logger 的入站/异常日志同样脱敏
logging.getLogger("uvicorn.access").setLevel(logging.WARNING)  # 关掉 uvicorn 访问日志
# 调试期: 放开音频感知链路的日志级别(DEBUG), 便于定位问题
# Wave C1 收口: 本地算法模块(audio_processor/vad_processor/sound_scene/
# speaker_diarization/multimodal_audio_manager)已物理删除, 其 logger 名一并摘除;
# 剩余条目均为存活的感知落盘/事件路由/陌生人配置模块。
for noisy in ("routers.events",):
    logging.getLogger(noisy).setLevel(logging.WARNING)
for dbg in ("services.perception_store",
            "routers.perception", "services.unknown_speaker_config"):
    logging.getLogger(dbg).setLevel(logging.DEBUG)
# root 模块（模型 init param 逐参数打印）保持 INFO, 不单独压级别
logger = logging.getLogger(__name__)
from config.config import get_config
from config.paths import frontend_dist_dir, project_root
from config.store import ConfigStore, get_config_store
from services.config_authz import ensure_bootstrap_token
from services.config_reconciler import register_default_appliers
from routers import tts, model_config, ota, session, ws_main, audio_stream_ws, speakers as speakers_router, maintenance as maintenance_router, notifications as notifications_router, reminders as reminders_router, plan as plan_router, pc as pc_router, perception as perception_router, auth_api, events, admin, web_backend, p2p as p2p_router
from routers.model_config import router as model_config_router
from routers.health import router as health_router
from routers.health_cloud import router as health_cloud_router
from routers.mobile import router as mobile_router
from routers.mimo import router as mimo_router
from routers.voiceprint_audit import router as vaudit_router
from routers.wake_word import router as wake_word_router
from routers.pc_sensor_download import router as pc_sensor_download_router
from routers.preview import router as preview_router
from routers.phi4_api import router as phi4_router
from routers.sources import router as sources_router
from routers.services_status import router as services_status_router
from routers.system_config import draft_router as system_config_draft_router
from routers.system_config import router as system_config_router
from routers.system_onboarding import router as system_onboarding_router
from routers.onboarding_startup import router as onboarding_startup_router
from routers.onboarding_storage import router as onboarding_storage_router
from routers.clients import router as onboarding_clients_router
from routers.loom_onboarding import router as loom_onboarding_router
from routers.moss import router as moss_onboarding_router
from routers.onboarding_xiaomi import router as onboarding_xiaomi_router
from routers.onboarding_qq import router as onboarding_qq_router
from routers.onboarding_finish import router as onboarding_finish_router
from services.task_scheduler import TaskScheduler, init_task_scheduler
from services.scheduler_gating import bind_scheduler_gating
from services.task_executor import TaskExecutor, init_task_executor
from services.script_runner import ScriptRunner, init_script_runner
from services import onboarding_service
from services.bootstrap_runtime import BootstrapRuntime
from services.startup_validation import MODE_VALIDATION, StartupValidation
import services.loom_health as loom_health


async def _unknown_speaker_cleanup_once() -> None:
    """单次调用内核 POST /v1/unknown/cleanup（B5 收口；V13 起作为调度器
    内建任务 builtin_unknown_speaker_cleanup 的回调，定时语义由
    TaskScheduler ScheduleParser/next_run 统一驱动，原散装每日 sleep 循环删除）。

    取代本地 UnknownSpeakerCleaner 线程：陌生人 L1-L4 链已在内核 A4 闭环，
    档案库真相源迁入内核 state-dir，本地清理线程读写的冻结镜像不再是清理
    对象。契约 §11.1 明确「调度归外层，内核无定时器」，故外层只保留定时
    语义（照旧 unknown_speaker.enabled 门控 + lifecycle.cleanup_hour），
    执行体经内核端点完成 TTL/上限清理 + 簇间融合体检 + 空闲轨道封存。
    lifecycle 节经 config_override 透传（白名单节，契约 §11.3），保持外层
    config.yaml 仍是这些阈值的配置入口。

    失败语义与原循环一致：内核不可达/失败不影响主系统、明日再试——
    next_run 在执行前已推进至次日；原「记 WARNING」保留在下方，异常上抛
    让调度器把本次执行如实记为 failed（tasks_state/执行历史可观测）。
    """
    from services.kernel_client import get_kernel_client
    from services.unknown_speaker_config import get_unknown_speaker_config

    try:
        lifecycle = (get_unknown_speaker_config().get("lifecycle") or {})
        resp = await get_kernel_client().arequest(
            "POST", "/v1/unknown/cleanup",
            json={"config_override": {"lifecycle": lifecycle}},
            timeout=120.0,
        )
        facts = (resp or {}).get("facts") or {}
        logger.info(
            "[UnknownSpeaker] 内核清理完成: cleaned=%s flushed_sessions=%s "
            "health_alerts=%s reason=%s",
            facts.get("cleaned"), facts.get("flushed_sessions"),
            facts.get("health_alerts"), facts.get("reason"),
        )
    except Exception as e:
        logger.warning(f"[UnknownSpeaker] 内核清理调用失败（明日重试）: {e}")
        raise


async def _start_frontend_self_heal(app: FastAPI) -> None:
    """T6: frontend dist 缺失时后台自愈；日志是唯一观测面，不阻塞启动。"""
    from services.release_assets import cleanup_stale_downloads, start_frontend_self_heal

    cleanup_stale_downloads()
    app.state.frontend_self_heal_task = start_frontend_self_heal()


def _subsystem(report: dict, name: str, status: str, error: str | None = None) -> None:
    report["subsystems"][name] = status
    if error is not None:
        report["errors"].append({"subsystem": name, "error": error})


def _register_builtin_tasks(cfg, scheduler, report: dict) -> None:
    """Register the daily builtin callbacks (idle while the scheduler is paused)."""
    try:
        if not cfg.AUDIO_COMPRESSOR_ENABLED:
            logger.info("[AudioCompressor] 配置未启用（audio_compressor.enabled=false），跳过")
            _subsystem(report, "audio_compressor", "skipped")
        elif scheduler is None:
            _subsystem(report, "audio_compressor", "skipped")
        else:
            from services.audio_compressor import get_compressor

            _compressor = get_compressor(
                keep_days=cfg.AUDIO_COMPRESSOR_KEEP_DAYS,
                ffmpeg_threads=cfg.AUDIO_COMPRESSOR_FFMPEG_THREADS,
                nice=cfg.AUDIO_COMPRESSOR_NICE,
            )
            scheduler.register_builtin(
                "audio_compressor_daily", "daily 00:05", _compressor.compress_all
            )
            logger.info(
                f"[AudioCompressor] 已启用（每日 00:05 调度器内建任务, "
                f"keep_days={cfg.AUDIO_COMPRESSOR_KEEP_DAYS}）"
            )
            _subsystem(report, "audio_compressor", "ok")
    except Exception as e:
        logger.warning(f"音频压缩服务启动失败: {e}")
        _subsystem(report, "audio_compressor", "failed", str(e))

    try:
        from services.unknown_speaker_config import get_unknown_speaker_config

        _unk_cfg = get_unknown_speaker_config()
        if not _unk_cfg.get("enabled"):
            logger.info("[UnknownSpeaker] 配置未启用，跳过")
            _subsystem(report, "unknown_speaker_cleanup", "skipped")
        elif scheduler is None:
            _subsystem(report, "unknown_speaker_cleanup", "skipped")
        else:
            _cleanup_hour = int((_unk_cfg.get("lifecycle") or {}).get("cleanup_hour", 3))
            scheduler.register_builtin(
                "unknown_speaker_cleanup",
                f"daily {_cleanup_hour:02d}:00",
                _unknown_speaker_cleanup_once,
            )
            logger.info(
                f"[UnknownSpeaker] 定时清理已注册为调度器内建任务（每日 {_cleanup_hour} "
                f"点调内核 POST /v1/unknown/cleanup，task_id=builtin_unknown_speaker_cleanup）"
            )
            _subsystem(report, "unknown_speaker_cleanup", "ok")
    except Exception as e:
        logger.warning(f"[UnknownSpeaker] 清理任务启动失败（不影响主系统）: {e}")
        _subsystem(report, "unknown_speaker_cleanup", "failed", str(e))


async def _start_deferred_integrations(app: FastAPI, report: dict) -> None:
    """Start health cloud, Loom probe, QQ gateway and P2P in the legacy order."""
    app.state.deferred_integrations_started = True

    try:
        from services.health_cloud_service import get_health_cloud_service

        get_health_cloud_service().start()
        _subsystem(report, "health_cloud", "ok")
    except Exception as e:
        logger.warning(f"小米云后台服务启动失败（不影响主系统）: {e}")
        _subsystem(report, "health_cloud", "failed", str(e))

    try:
        loom_health.start_loom_health_probe()
        logger.info("[LoomHealth] 健康探针已启动")
        _subsystem(report, "loom_health", "ok")
    except Exception as e:
        logger.warning(f"Loom 健康探针启动失败（不影响主系统）: {e}")
        _subsystem(report, "loom_health", "failed", str(e))

    try:
        from services.qq_gateway.service import get_qq_gateway

        _qq_gateway = get_qq_gateway()
        await _qq_gateway.start()
        logger.info("[QQGateway] 已启动（enabled=%s）", _qq_gateway.config.enabled)
        _subsystem(report, "qq_gateway", "ok")
    except Exception as e:
        logger.warning(f"QQ Gateway 启动失败（不影响主系统）: {e}")
        _subsystem(report, "qq_gateway", "failed", str(e))

    try:
        from services.p2p.manager import get_p2p_manager

        await get_p2p_manager().start()
        _subsystem(report, "p2p", "ok")
    except Exception as e:
        logger.warning(f"P2P 服务启动失败（不影响主系统）: {e}")
        _subsystem(report, "p2p", "failed", str(e))


async def _start_core(app: FastAPI) -> None:
    """Start config, tokens and the onboarding runtime before any request."""
    logger.info("[Axeuh Health Monitor] Starting...")
    # 启动日志：显示加载的关键文件/配置
    _cfg = get_config()
    logger.info(f"  配置: port={_cfg.BACKEND_HTTPS_PORT or _cfg.BACKEND_HTTP_PORT}, data_dir={_cfg.DATA_DIR}")
    # V10（2026-10-08）：声纹注册数启动日志随外层镜像退役删除——计数真相源
    # 在内核，启动期探测会强制 ensure/spawn（违 B5 启动纯度，b5 探针子进程
    # 会真的拉起内核）；管线日志每段带 vp=Nspk/Mco(AS|raw)，面板随时可查。

    loop = asyncio.get_running_loop()
    from services.event_loop_manager import set_main_loop
    set_main_loop(loop)

    store = get_config_store()
    app.state.config_store = store
    _refresh_cors(store)

    # 确保 AI 自动化脚本使用的长期服务 Token 存在（幂等，失败不影响启动）
    try:
        from auth import ensure_service_token
        _svc_token = ensure_service_token()
        if _svc_token:
            logger.info("[Auth] 服务 Token 已就绪（供 AI 自动化脚本使用）")
        else:
            logger.info("[Auth] 暂无用户，跳过服务 Token 创建")
    except Exception as e:
        logger.warning(f"[Auth] 服务 Token 初始化失败（不影响启动）: {e}")

    # 引导模式下确保 setup token 已生成；完整令牌由 ensure_bootstrap_token
    # 写入启动日志（仅首次配置用，配置完成后失效），绝不通过 HTTP 返回。
    # 此处只记录文件路径。
    try:
        token_path = ensure_bootstrap_token()
        if token_path:
            logger.info("[Auth] 引导令牌已就绪，文件: %s", token_path)
        else:
            logger.info("[Auth] 非引导模式，跳过引导令牌生成")
    except Exception as e:
        logger.warning(f"[Auth] 引导令牌初始化失败（不影响启动）: {e}")

    await _start_frontend_self_heal(app)

    # 全新安装先落地 v4 状态文件，避免"已建管理员、首个步骤未写"的窗口在
    # 重启后被 legacy_complete 误判为升级安装。
    try:
        created_state = onboarding_service.ensure_fresh_state()
    except Exception as e:
        created_state = False
        logger.warning(f"[Onboarding] 引导状态初始化失败（不影响启动）: {e}")
    logger.info(
        "[Onboarding] %s",
        "已创建全新 v4 引导状态文件" if created_state else "沿用现有引导状态",
    )

    # 单一启动路径（任务 17）：是否完成引导不再决定服务面起不起。运行时恒以
    # active=False 创建，lifespan 启动服务面后 mark_started() 进入 committed；
    # 未配置实例由编排器的 blocked 服务表达，而不是"整层不启动"。
    # start/stop 回调只为回滚脚本保留（主入口已不再调用 attempt/activate）。
    validation = StartupValidation()
    app.state.startup_validation = validation
    app.state.bootstrap_runtime = BootstrapRuntime(
        active=False,
        start=lambda: _start_service_plane(app, strict=False),
        stop=lambda: _stop_service_plane(app),
    )
    app.state.service_plane_started = False
    app.state.service_plane_stopped = False
    app.state.deferred_integrations_started = False
    logger.info("[Bootstrap] 单一启动路径：服务面随 lifespan 启动")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifecycle"""
    runtime: BootstrapRuntime | None = None
    await _start_core(app)
    runtime = app.state.bootstrap_runtime
    # 启动与 yield 同处 try：即使服务面启动抛异常，finally 里的
    # deactivate 也必须执行一次（关停契约不允许被启动失败绕过）。
    try:
        await _start_service_plane(app)
        runtime.mark_started()
        yield
    finally:
        if runtime is not None:
            await runtime.deactivate()
        logger.info("[Axeuh Health Monitor] Shutting down...")


def _register_orchestrator_specs() -> None:
    """按固定顺序注册进程编排 spec（幂等）。

    顺序即注册表顺序：kernel -> moss_watcher -> loom。``/api/services`` 的
    展示顺序与 ``stop_all()`` 的逆序停止都依赖它；runtime 本身不 import 各
    spec，注册只发生在服务面启动这一处（测试与运维脚本可显式调用）。
    """
    from services.orchestrator.kernel_spec import register_kernel_spec
    from services.orchestrator.loom_spec import register_loom_spec
    from services.orchestrator.moss_spec import register_moss_spec

    register_kernel_spec()
    register_moss_spec()
    register_loom_spec()


def _log_orchestrator_start_done(task: asyncio.Task) -> None:
    """后台 ``start_all`` 完成回调：只记录，绝不让异常逃逸到事件循环。

    ``asyncio`` 默认会把未取回的 task 异常打到事件循环异常处理器；这里显式
    取回并按 INFO/ERROR 落到项目日志，同时保证进程不会因服务拉起失败而退出。
    """
    if task.cancelled():
        logger.info("[Orchestrator] start_all 已取消（服务面关停）")
        return
    exc = task.exception()
    if exc is not None:
        logger.error(
            "[Orchestrator] start_all 失败: %s",
            exc,
            exc_info=(type(exc), exc, exc.__traceback__),
        )
        return
    try:
        entries = task.result()
    except Exception as e:  # pragma: no cover - exception() 已覆盖失败分支
        logger.error("[Orchestrator] start_all 结果读取失败: %s", e)
        return
    summary = ", ".join(
        f"{entry.get('id')}={entry.get('state')}"
        for entry in entries
        if isinstance(entry, dict)
    ) or "no services"
    logger.info("[Orchestrator] start_all 完成: %s", summary)


async def _cancel_orchestrator_start_task(
    app: FastAPI, *, reason: str
) -> None:
    """取消并等待后台 ``start_all``；已完成/已失败/不存在时安全返回。

    关停必须先取消在途启动，再交给 ``stop_all`` 按已登记的 pid 回收子进程；
    否则正在 spawn/等待健康的服务会在 stop_all 之后才落地，形成孤儿。
    """
    task = getattr(app.state, "orchestrator_start_task", None)
    app.state.orchestrator_start_task = None
    if not isinstance(task, asyncio.Task) or task.done():
        return
    logger.info("[Orchestrator] 取消后台 start_all（%s）", reason)
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        # 本任务自身被取消时也走这里：关停期不重新抛出，继续执行 stop_all。
        pass
    except Exception as e:
        # 任务失败已由完成回调记录；此处只防止关停被二次异常打断。
        logger.error("[Orchestrator] 后台 start_all 取消期间异常: %s", e)


async def _start_service_plane(
    app: FastAPI, *, strict: bool = True, mode: str = "full"
) -> dict[str, dict[str, str] | list[dict[str, str]]]:
    """Start schedulers, integrations and config appliers in the legacy order.

    ``mode="validation"`` starts only the safe in-process subset: the scheduler
    runs paused, deferred integrations (health cloud / Loom probe / QQ / P2P)
    stay unstarted, and every required failure is raised so the attempt fails.
    """
    validation_mode = mode == MODE_VALIDATION
    report: dict[str, dict[str, str] | list[dict[str, str]]] = {
        "subsystems": {},
        "errors": [],
    }
    cfg = get_config()
    store = getattr(app.state, "config_store", None)
    if store is None:
        store = get_config_store()
        app.state.config_store = store
    app.state.service_plane_started = True
    app.state.service_plane_stopped = False
    app.state.service_plane_mode = mode
    app.state.deferred_integrations_started = False
    scheduler = None

    # 启动定时任务调度器
    try:
        executor = init_task_executor()
        scheduler = init_task_scheduler(execute_callback=executor.execute)
        scheduler.set_paused(validation_mode)
        # 任务 18：业务就绪门控。注册点必须早于 scheduler.start()，保证未配置
        # 实例从第一个 tick 起就不派发；之后完全由编排器状态回调驱动，无轮询。
        # validation 模式不启动编排器，保留"只起安全子集且暂停派发"的既有语义。
        previous_unsubscribe = getattr(
            app.state, "scheduler_gating_unsubscribe", None
        )
        if callable(previous_unsubscribe):
            try:
                previous_unsubscribe()
            except Exception as e:
                logger.warning(f"[SchedulerGating] 门控回调注销失败: {e}")
            app.state.scheduler_gating_unsubscribe = None
        if not validation_mode:
            try:
                from services.orchestrator.runtime import get_orchestrator

                app.state.scheduler_gating_unsubscribe = bind_scheduler_gating(
                    get_orchestrator(), scheduler
                )
            except Exception as e:
                logger.warning(
                    f"[SchedulerGating] 编排器门控注册失败"
                    f"（保持当前派发状态）: {e}"
                )
        await scheduler.start()
        _subsystem(report, "scheduler", "ok")
    except Exception as e:
        logger.exception(f"定时任务调度器启动失败: {e}")
        _subsystem(report, "scheduler", "failed", str(e))
        if strict or validation_mode:
            raise

    # 启动脚本任务管理器
    try:
        script_runner = init_script_runner()
        await script_runner.start()
        _subsystem(report, "script_runner", "ok")
    except Exception as e:
        logger.warning(f"脚本任务管理器启动失败: {e}")
        _subsystem(report, "script_runner", "failed", str(e))
        if validation_mode:
            raise

    # P3-V17（2026-10-08）：音频连续性摄入单例入 lifespan。原
    # routers/perception.py 模块 import 副作用（创建 AudioIngestRegistry 单例、
    # 懒起 AudioIngestSweeper 守护线程、接线空闲冲刷 sink）已删除，交还路由
    # import 侧纯净性（test_b5_startup_purity 探针锁定）；此处显式创建单例并
    # 接线 sink——回调本体 _on_registry_sweep 平迁保留在 perception.py 内
    # （函数不依赖单例），multipart 上传停止后的尾部残片仍靠 sweeper 派发。
    try:
        from services.audio_ingest_registry import get_audio_ingest_registry
        from routers.perception import _on_registry_sweep
        registry = get_audio_ingest_registry()
        registry.set_sweep_sink(_on_registry_sweep)
        registry.start_sweeper()
        logger.info("[VoiceSession] 连续性摄入注册表已在 lifespan 接线（sweeper 随单例启动）")
        _subsystem(report, "audio_ingest", "ok")
    except Exception as e:
        logger.warning(f"[VoiceSession] 连续性摄入注册表初始化失败: {e}")
        _subsystem(report, "audio_ingest", "failed", str(e))
        if validation_mode:
            raise

    # B5 预加载摘除：声纹 ERes2NetV2 / multimodal 全家桶 / pyannote 切分模型
    # 三个本地模型预热已删除——生产路径 B1/B2/B3 已全量切内核
    # (kernel_client 评分 + kernel_job_client 五类分析作业)，预热拉起的
    # torch/funasr/pyannote 是纯负担（数秒启动 + 数百 MB 常驻内存）。
    # 唤醒链微型预热在 wake_word_service（B1）内按连接懒触发，不在此重复。

    # 音频压缩归档（V13：原 AudioCompressor 自扫 hour==0 循环删除，收编为
    # 调度器内建回调任务；原窗口 00:05~00:30 取 00:05 为唯一定时点，每日
    # 单触发由 next_run 推进天然保证。门控不变: audio_compressor.enabled）
    # V18：compress_all 扫描桶扩为 daily+stream 两支（同一实现），本注册
    # 零接线变化——stream/{date}/audio 单向堆积由到点的同一内建任务清扫。
    _register_builtin_tasks(cfg, scheduler, report)

    if validation_mode:
        for name in ("health_cloud", "loom_health", "qq_gateway", "p2p"):
            _subsystem(report, name, "skipped")
        logger.info("[Bootstrap] validation 模式：延迟集成保持未启动")
    else:
        await _start_deferred_integrations(app, report)

    # 单一启动路径：注册声明后由编排器统一拉起；缺配置的服务保持 blocked，
    # 不再用"不启动服务面"表达未完成引导。validation 模式保留"只起安全
    # 子集"的既有能力，因此不拉起任何编排子进程。
    if validation_mode:
        _subsystem(report, "orchestrator", "skipped")
        logger.info("[Bootstrap] validation 模式：编排器服务保持未启动")
    else:
        try:
            from services.orchestrator.runtime import get_orchestrator

            await _cancel_orchestrator_start_task(app, reason="服务面重启")
            _register_orchestrator_specs()
            orchestrator = get_orchestrator()
            # 冷启动预算硬约束（hot_server.STARTUP_TIMEOUT_S=60）：Loom 健康
            # 等待最长 45s + 每个服务 10s 观察窗，同步 await 会顶爆预算。
            # spec 注册仍同步完成，start_all 转为后台任务；lifespan 立即返回，
            # 服务状态由 /api/services 以 starting/blocked 过渡态表达。
            start_task = asyncio.create_task(
                orchestrator.start_all(), name="orchestrator-start-all"
            )
            start_task.add_done_callback(_log_orchestrator_start_done)
            app.state.orchestrator_start_task = start_task
            _subsystem(report, "orchestrator", "ok")
            logger.info(
                "[Orchestrator] start_all 已转入后台任务（不阻塞服务面启动）"
            )
        except Exception as e:
            logger.exception(f"[Orchestrator] 服务编排启动失败: {e}")
            _subsystem(report, "orchestrator", "failed", str(e))
            if strict or validation_mode:
                raise

    # 配置热应用：服务全部就绪后注册领域应用器，再启动外部文件 watcher
    try:
        from routers.perception import _on_registry_sweep
        _registry_sink = _on_registry_sweep
    except Exception as e:
        _registry_sink = None
        logger.warning(f"[Config] 音频摄入 sink 获取失败: {e}")
    try:
        _applier_names = register_default_appliers(
            store,
            registry_sink=_registry_sink,
            cors_refresh=lambda: _refresh_cors(store),
        )
    except Exception as e:
        logger.exception(f"[Config] 热应用器注册失败: {e}")
        _subsystem(report, "config_appliers", "failed", str(e))
        if strict or validation_mode:
            raise
    else:
        logger.info("[Config] 热应用器已注册: %s", ", ".join(_applier_names))
        _subsystem(report, "config_appliers", "ok")
    try:
        store.start_watcher(asyncio.get_running_loop())
        logger.info("[Config] 配置 watcher 已启动")
        _subsystem(report, "config_watcher", "ok")
    except Exception as e:
        logger.warning(f"[Config] 配置 watcher 启动失败（API 写入仍即时生效）: {e}")
        _subsystem(report, "config_watcher", "failed", str(e))
        if validation_mode:
            raise
    return report


# 15 秒尾段预算中预留给内核优雅退出的窗口；预算耗尽时按 0.1 秒下限
# 立即升级 SIGKILL（只针对 pidfile 记录且归属已证明的精确 PID）。
_SHUTDOWN_KERNEL_RESERVE_S = 3.0
_KERNEL_STOP_FLOOR_S = 0.1


async def _stop_service_plane(app: FastAPI) -> None:
    """Stop the service plane; safe when only part of it ever started."""
    if getattr(app.state, "service_plane_stopped", False):
        return
    app.state.service_plane_stopped = True
    app.state.service_plane_started = False
    app.state.service_plane_mode = None
    gating_unsubscribe = getattr(
        app.state, "scheduler_gating_unsubscribe", None
    )
    if callable(gating_unsubscribe):
        try:
            gating_unsubscribe()
        except Exception as e:
            logger.warning(f"[SchedulerGating] 门控回调注销失败: {e}")
        app.state.scheduler_gating_unsubscribe = None
    deferred_started = bool(
        getattr(app.state, "deferred_integrations_started", False)
    )
    app.state.deferred_integrations_started = False
    store = getattr(app.state, "config_store", None)
    if store is None:
        store = get_config_store()

    # shutdown：先停配置 watcher，避免关停过程中还向事件循环投递 apply
    try:
        store.stop_watcher()
        logger.info("[Config] 配置 watcher 已停止")
    except Exception as e:
        logger.error(f"[Config] 配置 watcher 停止失败: {e}")

    if deferred_started:
        try:
            from services.p2p.manager import stop_p2p_manager
            await stop_p2p_manager()
        except Exception as e:
            logger.error(f"P2P 服务停止失败: {e}")
        try:
            from services.qq_gateway.service import stop_qq_gateway
            await stop_qq_gateway()
        except Exception as e:
            logger.error(f"QQ Gateway 停止失败: {e}")
        try:
            await loom_health.stop_loom_health_probe()
        except Exception as e:
            logger.error(f"Loom 健康探针停止失败: {e}")
        try:
            from services.health_cloud_service import get_health_cloud_service
            get_health_cloud_service().stop()
        except Exception as e:
            logger.error(f"小米云后台服务停止失败: {e}")
    try:
        from services.task_scheduler import get_task_scheduler
        s = get_task_scheduler()
        if s: await s.stop()
    except Exception as e:
        logger.error(f"调度器停止失败: {e}")
    # 停止脚本任务管理器
    try:
        from services.script_runner import get_script_runner
        sr = get_script_runner()
        if sr:
            await sr.stop()
    except Exception as e:
        logger.error(f"脚本任务管理器停止失败: {e}")
    # P3-V17: 停音频摄入 sweeper 线程（置位唤醒+限时 join）。peek 语义保证
    # 单例从未创建（启动接线失败）时不反向触发创建。
    try:
        from services.audio_ingest_registry import peek_audio_ingest_registry
        _ingest_reg = peek_audio_ingest_registry()
        if _ingest_reg is not None:
            _ingest_reg.stop_sweeper()
            logger.info("[VoiceSession] 音频摄入 sweeper 线程已停止")
    except Exception as e:
        logger.error(f"音频摄入 sweeper 停止失败: {e}")

    # 编排器子服务（consumer -> producer 逆序）与内核共用 15 秒尾段预算。
    # 内核至少留 3 秒 SIGTERM 窗口，避免 stop_all 吃满预算后内核无时间优雅退出。
    from services.orchestrator.runtime import STOP_ALL_BUDGET_S, peek_orchestrator

    # 后台 start_all 可能仍在 spawn/等健康；必须先取消并等它退出，再让
    # stop_all 按已登记的 pid 逆序停止，避免"停止之后才落地"的孤儿进程。
    await _cancel_orchestrator_start_task(app, reason="服务面关停")
    shutdown_deadline = time.monotonic() + STOP_ALL_BUDGET_S
    orchestrator = peek_orchestrator()
    kernel_managed = False
    stop_all_failed = False
    if orchestrator is not None:
        snapshot = getattr(orchestrator, "snapshot", None)
        if callable(snapshot):
            try:
                data = snapshot()
                entries = (
                    data.get("services") if isinstance(data, dict) else None
                )
                kernel_managed = any(
                    entry.get("id") == "kernel"
                    and (
                        entry.get("pid") is not None
                        or entry.get("state") in ("starting", "ready", "stopping")
                    )
                    for entry in (entries or [])
                    if isinstance(entry, dict)
                )
            except Exception as e:
                logger.error(f"编排器状态快照读取失败（按内核未接管处理）: {e}")
        try:
            await orchestrator.stop_all(
                timeout=max(
                    0.0,
                    shutdown_deadline
                    - time.monotonic()
                    - _SHUTDOWN_KERNEL_RESERVE_S,
                )
            )
            logger.info("[Shutdown] 编排器子服务已停止")
        except Exception as e:
            stop_all_failed = True
            logger.error(f"编排器子服务停止失败: {e}")
    if kernel_managed and not stop_all_failed:
        logger.info("[Shutdown] 内核由编排器接管，已随 stop_all 逆序停止")
    else:
        remaining = max(0.0, shutdown_deadline - time.monotonic())
        if remaining <= 0:
            logger.error(
                "[Shutdown] 15 秒关停预算已耗尽，内核按精确 PID 补 SIGKILL"
            )
        try:
            from services.kernel_client import stop_kernel_process

            result = stop_kernel_process(
                timeout_s=max(remaining, _KERNEL_STOP_FLOOR_S)
            )
            logger.info(f"[Shutdown] 内核停止结果: {result}")
        except Exception as e:
            logger.error(f"内核停止失败: {e}")
    # V13：原「停 compressor 自扫循环」「取消 unknown_cleanup_task」两段 shutdown
    # 清理随散装循环删除而移除——内建任务的生命周期唯一归 TaskScheduler.stop()
    # （上方）管辖，在途执行与 YAML prompt 任务的处置语义一致。


# 生产环境关闭交互式 API 文档与 OpenAPI schema（BE-SEC-H2）：
# /docs、/redoc、/openapi.json 均不再注册，未认证访问返回 404。
app = FastAPI(
    title="Kinship",
    description="Kinship — self-hosted personal AI companion API",
    version="1.0.0",
    lifespan=lifespan,
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)

# 统一错误处理
from core.errors import http_exception_handler, validation_exception_handler, unhandled_exception_handler
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException
app.add_exception_handler(StarletteHTTPException, http_exception_handler)
app.add_exception_handler(RequestValidationError, validation_exception_handler)
app.add_exception_handler(Exception, unhandled_exception_handler)

# ── 安全响应头中间件 (D6: 仅非 CSP 头; CSP 由后续任务单独处理) ──────────────
# 用纯 ASGI 中间件而非 BaseHTTPMiddleware: 直接改写 http.response.start 消息,
# 不缓冲响应体, 对 SSE 等流式响应无副作用。
_SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",                              # 禁止浏览器 MIME 嗅探
    "X-Frame-Options": "SAMEORIGIN",                                  # 禁止跨站 iframe 嵌套
    "Referrer-Policy": "strict-origin-when-cross-origin",             # 限制 Referer 泄露粒度
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()", # 关闭浏览器敏感能力
}


class SecurityHeadersMiddleware:
    """为所有 HTTP 响应注入非 CSP 安全头。"""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_with_security_headers(message):
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                for _name, _value in _SECURITY_HEADERS.items():
                    headers.setdefault(_name, _value)
                # HSTS 仅在 HTTPS 下有效; 明文 HTTP 下浏览器会忽略, 故按需注入
                if scope.get("scheme") == "https":
                    headers.setdefault(
                        "Strict-Transport-Security", "max-age=31536000; includeSubDomains"
                    )
            await send(message)

        await self.app(scope, receive, send_with_security_headers)


class P2PDisabledGuardMiddleware:
    """p2p.enabled=false 时在认证前把 /api/p2p/* 统一返回 404。

    放在 Auth 外层，避免未认证请求先拿到 401 而暴露 P2P 路由存在性。
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            path = scope.get("path", "")
            if path == "/api/p2p" or path.startswith("/api/p2p/"):
                try:
                    from routers import p2p as p2p_routes
                    enabled = bool(p2p_routes.get_p2p_manager().config.enabled)
                except Exception:
                    enabled = False
                if not enabled:
                    response = JSONResponse({"detail": "Not Found"}, status_code=404)
                    await response(scope, receive, send)
                    return
        await self.app(scope, receive, send)


# 中间件注册顺序: add_middleware 后添加者位于外层, 最终由外到内为
#   CORS -> SecurityHeaders -> OnboardingGate -> P2PDisabledGuard -> Auth -> GZip -> 路由
# CORS 始终最外层(与既有约定一致); GZip 置于 Auth 内层, 直接包装路由响应,
# 这样带 Content-Length 的小响应能被正确跳过压缩
# (若 GZip 在 Auth 外层, BaseHTTPMiddleware 的流式包装会令小响应也走压缩分支)。
app.add_middleware(GZipMiddleware, minimum_size=1024)               # 压缩(最内层); 内置跳过 text/event-stream
app.add_middleware(AuthMiddleware)                                  # 认证
app.add_middleware(P2PDisabledGuardMiddleware)                      # P2P 未启用时 404
app.add_middleware(OnboardingGateMiddleware)                        # bootstrap 门禁(在 Auth 外层)
app.add_middleware(SecurityHeadersMiddleware)                       # 安全响应头

# CORS: 允许来源白名单 (allow_credentials=True 时不允许 "*", 否则浏览器直接拒绝且不安全)
# 前端通过 Bearer Token 认证, 不需要携带 cookie, 因此白名单覆盖同源与本地开发场景即可。
# 端口从配置派生, 避免写死后与 server.port 不一致。
def _cors_origins_for(cfg) -> list[str]:
    """按配置端口派生本地开发/同源 CORS 白名单。"""
    origins = [
        *(f"http://{host}:{cfg.BACKEND_HTTP_PORT}" for host in ("localhost", "127.0.0.1")),
        *(f"https://{host}:{cfg.BACKEND_HTTPS_PORT}" for host in ("localhost", "127.0.0.1")),
        "http://localhost:5173",   # Vite dev server (frontend/mobile)
        "http://127.0.0.1:5173",
    ]
    return list(dict.fromkeys(origins))


def _refresh_cors(store: ConfigStore | None = None) -> list[str]:
    """把最新配置端口原地写入 CORS 白名单，避免重建中间件。"""
    if store is None:
        store = get_config_store()
    origins = _cors_origins_for(get_config())
    _cors_origins[:] = origins
    return origins


_cfg = get_config()
_cors_origins = _cors_origins_for(_cfg)
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Routers
app.include_router(auth_api.router)
app.include_router(tts.router, prefix="/api/screen")
app.include_router(health_router)
app.include_router(health_cloud_router)
app.include_router(model_config_router)
app.include_router(ota.router)
app.include_router(session.router, prefix="/api/screen")
app.include_router(web_backend.router, prefix="/api/screen")
app.include_router(ws_main.router)
app.include_router(audio_stream_ws.router)
app.include_router(speakers_router.router)
app.include_router(maintenance_router.router)
app.include_router(admin.router)
app.include_router(mobile_router, prefix="/api/mobile")
app.include_router(mimo_router, prefix="/api")
app.include_router(notifications_router.router, prefix="/api")
app.include_router(reminders_router.router, prefix="/api")
app.include_router(plan_router.router, prefix="/api")
app.include_router(pc_router.router)
app.include_router(perception_router.router)
app.include_router(wake_word_router)
app.include_router(events.router, prefix="/api/screen")
app.include_router(vaudit_router)
app.include_router(preview_router)
app.include_router(phi4_router)
app.include_router(pc_sensor_download_router)
app.include_router(sources_router, prefix="/api")
app.include_router(p2p_router.router)
app.include_router(system_config_router)
app.include_router(system_config_draft_router)
app.include_router(services_status_router)
app.include_router(system_onboarding_router)
app.include_router(onboarding_startup_router)
app.include_router(onboarding_storage_router)
app.include_router(onboarding_clients_router)
app.include_router(loom_onboarding_router)
app.include_router(moss_onboarding_router)
app.include_router(onboarding_xiaomi_router)
app.include_router(onboarding_qq_router)
app.include_router(onboarding_finish_router)


def _resolve_within(base: Path, rel: str) -> Optional[Path]:
    """将相对路径 rel 安全解析到 base 目录内。

    用 resolve() 归一化 `.` / `..` / 绝对路径 / 符号链接后, 再校验目标是否
    仍位于 base 之下（含 base 自身）。越界、绝对路径、非法路径一律返回 None。
    这样可以阻止 `../../../Windows/win.ini`、`/etc/passwd`、`C:\\...` 等
    路径穿越读取任意文件 (CWE-22)。
    """
    try:
        base_resolved = base.resolve(strict=False)
        target = (base_resolved / rel).resolve(strict=False)
    except (OSError, RuntimeError, ValueError):
        return None
    if target != base_resolved and base_resolved not in target.parents:
        return None
    return target


# 音频处理预览台静态页（frontend/preview/, 免认证; 数据走 /api/preview）
_PREVIEW_DIR = project_root() / "frontend" / "preview"

@app.get("/preview", include_in_schema=False)
async def redirect_preview():
    from starlette.responses import RedirectResponse
    return RedirectResponse("/preview/", status_code=307)

@app.api_route("/preview/", methods=["GET", "HEAD"])
@app.api_route("/preview/{full_path:path}", methods=["GET", "HEAD"])
async def serve_preview(full_path: str = "index.html"):
    fp = _resolve_within(_PREVIEW_DIR, full_path)
    if fp is None:
        return JSONResponse({"detail": "Not Found"}, status_code=404)
    if fp.exists() and fp.is_file():
        return FileResponse(str(fp), headers=_NO_CACHE)
    if any(full_path.lower().endswith(ext) for ext in _ASSET_EXTS):
        return JSONResponse({"detail": "Not Found"}, status_code=404)
    idx = _PREVIEW_DIR / "index.html"
    if idx.exists():
        return FileResponse(str(idx), headers=_NO_CACHE)
    return JSONResponse({"detail": "Not Found"}, status_code=404)


@app.get("/health")
async def health_check():
    cfg = get_config()
    ai_backend = cfg.AI_BACKEND
    loom = loom_health.get_loom_health()
    status = "healthy"
    if ai_backend == "loom" and loom.get("status") == "offline" and loom.get("checked_at") is not None:
        status = "degraded"
    try:
        config_status = {
            "degraded": bool(cfg.DEGRADED),
            "revision": cfg.revision(),
            "provider": cfg.provider_info().kind,
        }
    except Exception:
        config_status = {"degraded": True, "revision": "unknown", "provider": "unknown"}
    return {
        "status": status,
        "service": "kinship-health-monitor",
        "ai_backend": ai_backend,
        "loom": loom,
        "config": config_status,
    }


@app.get("/", include_in_schema=False)
async def root_redirect():
    """根路径重定向到移动端 SPA 入口, 避免直接访问 / 返回 404。"""
    from starlette.responses import RedirectResponse
    return RedirectResponse("/mobile/", status_code=307)


# 移动端页面服务（必须放在最后）
_NO_CACHE = {"Cache-Control": "no-cache, no-store, must-revalidate", "Pragma": "no-cache", "Expires": "0"}
# 【用途 A: SPA fallback 判定, 用于 serve_preview / serve_mobile / serve_vaudit】
# asset 文件扩展名列表 - 这些文件找不到时【不】回退到 index.html, 避免浏览器因 MIME 类型错误拒绝加载。
# 注意(D9): 本表与 middleware/auth_middleware.py 的 _STATIC_EXTS 用途不同
# (那个用于认证豁免, 决定哪些静态请求可以跳过 Token)。二者刻意保持独立, 不合并;
# 具体差异由 tests/test_middleware_hardening.py 固化记录。
_ASSET_EXTS = ('.js', '.css', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.woff', '.woff2', '.ttf', '.eot', '.json', '.wasm')
@app.api_route("/mobile", methods=["GET", "HEAD"])
@app.api_route("/mobile/", methods=["GET", "HEAD"])
@app.api_route("/mobile/{full_path:path}", methods=["GET", "HEAD"])
async def serve_mobile(full_path: str = "index.html"):
    mobile_dir = frontend_dist_dir()
    fp = _resolve_within(mobile_dir, full_path)
    if fp is None:
        return JSONResponse({"detail": "Not Found"}, status_code=404)
    if fp.exists() and fp.is_file():
        return FileResponse(str(fp), headers=_NO_CACHE)
    # asset 文件不存在时不返回 index.html, 避免浏览器 MIME 类型检查失败
    if any(full_path.lower().endswith(ext) for ext in _ASSET_EXTS):
        return JSONResponse({"detail": "Not Found"}, status_code=404)
    idx = mobile_dir / "index.html"
    if idx.exists():
        return FileResponse(str(idx), headers=_NO_CACHE)
    return JSONResponse({"detail": "Not Found"}, status_code=404)


# 声纹审计平台静态页（frontend/vaudit/ 纯静态 3 文件, 免认证加载; 数据走 /api/vaudit）
_VAUDIT_DIR = project_root() / "frontend" / "vaudit"

@app.get("/vaudit", include_in_schema=False)
async def redirect_vaudit():
    """无尾斜杠访问时重定向到 /vaudit/ (保证相对路径正确解析)"""
    from starlette.responses import RedirectResponse
    return RedirectResponse("/vaudit/", status_code=307)

@app.api_route("/vaudit/", methods=["GET", "HEAD"])
@app.api_route("/vaudit/{full_path:path}", methods=["GET", "HEAD"])
async def serve_vaudit(full_path: str = "index.html"):
    fp = _resolve_within(_VAUDIT_DIR, full_path)
    if fp is None:
        return JSONResponse({"detail": "Not Found"}, status_code=404)
    if fp.exists() and fp.is_file():
        return FileResponse(str(fp), headers=_NO_CACHE)
    # asset 文件不存在时不返回 index.html(避免 MIME 错误); 其余回退首页
    if any(full_path.lower().endswith(ext) for ext in _ASSET_EXTS):
        return JSONResponse({"detail": "Not Found"}, status_code=404)
    idx = _VAUDIT_DIR / "index.html"
    if idx.exists():
        return FileResponse(str(idx), headers=_NO_CACHE)
    return JSONResponse({"detail": "Not Found"}, status_code=404)

