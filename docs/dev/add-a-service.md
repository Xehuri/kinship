# 新增一个受管服务

本文是给贡献者的完整接入模板。按顺序做完第 1 到第 7 节，再跑第 8 节的骨架与第 9 节的自检，一个新服务就能在 `/api/services` 可见、可起停、可重试、可关停。

先确认边界：编排器只托管由后端 spawn 的子进程。vLLM 推理服务、MOSS serve、外部 NapCat 等不归编排器管理，MOSS 只托管 watcher 子进程（`backend/services/orchestrator/moss_spec.py:4-13`）。有自己守护体系的服务也不要接进来，否则会出现双父进程。

## 1. 声明 ServiceSpec

在 `backend/services/orchestrator/<id>_spec.py` 里声明一个 `ServiceSpec`。模型是不可变 dataclass，字段定义在 `backend/services/orchestrator/spec.py:29-55`。

| 字段 | 必填 | 语义 | 现有样例 |
| --- | --- | --- | --- |
| `id` | 是 | 注册表主键，全进程唯一；重复注册抛 `ValueError`（`backend/services/orchestrator/spec.py:128-132`） | `kernel`、`moss_watcher`、`loom` |
| `requires` | 是 | 必须存在且非空的配置键元组，点分路径。缺失、`None`、空串、空集合都归 `missing_config`；布尔假值归 `disabled`（`backend/services/orchestrator/spec.py:73-86`） | `("moss.enabled",)`（`backend/services/orchestrator/moss_spec.py:257-265`） |
| `gate` | 是 | `Callable[[Config], tuple[bool, str]]` 或 `None`。只读配置快照，不做 IO、不探端口、不查文件；阻塞探测放进 `start`（`backend/services/orchestrator/spec.py:38-40`、`backend/services/orchestrator/spec.py:100-120`） | Loom 的 `ai_backend` 判定（`backend/services/orchestrator/loom_spec.py:320-331`） |
| `start` | 是 | `async () -> dict`，至少返回 `pid`（int），可选 `process` 句柄。返回 `{"ok": False}`、无有效 pid 或抛异常都归 `spawn_failed`，不重试（`backend/services/orchestrator/runtime.py:24-31`、`backend/services/orchestrator/runtime.py:715-750`） | `backend/services/orchestrator/kernel_spec.py:28-39`、`backend/services/orchestrator/moss_spec.py:194-220`、`backend/services/orchestrator/loom_spec.py:203-289` |
| `stop` | 是 | `async () -> dict`，按精确 pid 停止。先 SIGTERM，超时后 SIGKILL；Windows 走 `TerminateProcess`；禁止按名称杀（`backend/services/orchestrator/runtime.py:40-46`、`backend/services/orchestrator/runtime.py:927-1006`） | `backend/services/orchestrator/moss_spec.py:223-250`、`backend/services/orchestrator/loom_spec.py:292-317` |
| `critical` | 是 | 关键服务标记。任一 `critical=True` 服务 ready 才恢复调度器派发；可选服务起落不影响结论（`backend/services/scheduler_gating.py:4-44`）。它不决定关停顺序 | 只有 kernel 为 `True`（`backend/services/orchestrator/kernel_spec.py:52-60`） |
| `restart` | 是 | 崩溃后是否允许自动重启。仅对 `ready` 之后崩溃生效；启动期失败永远不重试（`backend/services/orchestrator/runtime.py:817-834`、`backend/services/orchestrator/runtime.py:836-902`） | kernel、moss watcher、Loom 都为 `True` |
| `enable_key` | 否 | 可选配置键。`None` 表示总是启用；设为键时该键为假则保持 `blocked/disabled`，供迁移期逐个接管与运维暂停 | 现有三个 spec 都为 `None` |

两个容易写错的点：

- `gate` 畸形返回值按失败处理，原因码 `gate_failed: invalid_result`（`backend/services/orchestrator/spec.py:89-97`）。不要返回 `None` 或字符串。
- `critical=True` 不等于“最后停”。关停顺序只由注册顺序决定，见第 6 节。

## 2. 注册进 REGISTRY

不要在 `runtime.py` 里 import 具体 spec。注册只发生在 `backend/main.py` 的 `_register_orchestrator_specs()`（`backend/main.py:315-328`），运行时只读 `REGISTRY`（`backend/services/orchestrator/spec.py:125-147`）。

推荐照现有模式写一个幂等的 `register_<id>_spec()`：

1. 模块级单例 `_SPEC`，保证 `start` 与 `stop` 闭包对象等价（`backend/services/orchestrator/kernel_spec.py:48-61`、`backend/services/orchestrator/moss_spec.py:253-266`）。
2. 已注册且声明等价时原样返回；同 id 但声明不同时抛 `ValueError`，不静默覆盖（`backend/services/orchestrator/kernel_spec.py:64-79`、`backend/services/orchestrator/loom_spec.py:349-358`）。
3. 在 `_register_orchestrator_specs()` 里按依赖位次调用。

注册顺序同时决定两件事：`/api/services` 的展示顺序，以及 `stop_all()` 的逆序关停顺序（`backend/main.py:315-328`、`backend/services/orchestrator/runtime.py:1215-1226`）。

当前顺序与关停顺序：

| 注册位次 | 服务 | 启动顺序 | 关停顺序 |
| --- | --- | --- | --- |
| 1 | `kernel` | 1 | 3（最后） |
| 2 | `moss_watcher` | 2 | 2 |
| 3 | `loom` | 3 | 1（最先） |

新服务的位次规则：放在它的生产者之后、它的消费者之前。这样启动时生产者先就绪，关停时消费者先退场。若新服务调用内核，注册在内核之后；若新服务为 Loom 提供数据，注册在 Loom 之前。

## 3. 让 `/api/services` 可见

不需要新增路由。`/api/services` 投影 `Orchestrator.snapshot()` 的公开字段（`backend/routers/services_status.py:51-85`、`backend/routers/services_status.py:88-117`）。`snapshot()` 对已注册但尚未启动的 spec 生成 placeholder，条件不满足时直接显示 `blocked`（`backend/services/orchestrator/runtime.py:318-334`、`backend/services/orchestrator/runtime.py:1162-1173`）。

验收方式：

1. 启动后端，用 user token 请求 `GET /api/services`，确认出现新服务的条目。
2. 条目字段应包含 `id`、`state`、`reason_code`、`detail`、`pid`、`requires`、`critical`。不要把内部异常堆栈塞进 `detail`，路由层会做脱敏（`backend/routers/services_status.py:65-85`）。
3. 引导未完成时该端点会被 OnboardingGate 503 挡住（`backend/middleware/onboarding_gate.py:18-50`），这是预期；先完成引导再验收。
4. 需要人工停一下时用 `POST /api/services/{id}/pause`，恢复用 `POST /api/services/{id}/resume`（`backend/routers/services_status.py:175-196`）。

## 4. 补三档状态断言

在 `backend/tests/test_<id>_spec.py` 或 `backend/tests/test_orchestrator_runtime.py` 里至少加三个用例。可以复用 `FakeService` 的写法（`backend/tests/test_orchestrator_runtime.py:66-138`）。

1. blocked：让 `requires` 指向不存在的键，断言 `snapshot()` 在 `start_all()` 之前就是 `blocked`，`reason_code` 为 `missing_config`，且 `retry()` 后 `start_calls` 仍为 0。参考 `backend/tests/test_orchestrator_runtime.py:318-337`。
2. ready：`start` 起一个真实小进程，断言状态进入 `ready` 且 pid 存活。参考 `backend/tests/test_orchestrator_runtime.py:179-187` 的 `_wait_ready_spawn` 与 `:340-365`。
3. failed：`start` 返回 `{"ok": False, "detail": "..."}`，断言状态为 `failed`、`reason_code` 为 `spawn_failed`，并且没有重启任务。也可以让子进程在 `SPAWN_GRACE_S` 内立刻退出，断言同样是不重试的 `spawn_failed`（`backend/services/orchestrator/runtime.py:817-834`；参考 `backend/tests/test_orchestrator_runtime.py:193-213`）。

如果服务有 `gate`，再加一个 gate 失败用例，断言原因码为 `gate_failed` 且 `start` 调用次数为 0（`backend/tests/test_orchestrator_runtime.py:572-588`；Loom 的对应测试在 `backend/tests/test_loom_spec.py:116-149`）。

## 5. 补双实例断言

双实例分两层，两个都要测。

第一层是编排器内的并发启动。`_attempt_start()` 在锁内检查 `STARTING` 与 `READY`，并用 `_starting` 占位挡住并发（`backend/services/orchestrator/runtime.py:610-625`）。加一个测试：同时发起 10 次 `start()`，断言 `start_calls == 1`、真实 spawn 数为 1。模板在 `backend/tests/test_orchestrator_runtime.py:459-477`。

第二层是跨进程或跨来源的实例。编排器只能保证自己不起第二个，不能阻止外部手工启动。若服务绑定固定端口或有 pidfile，`start` 必须先证明归属再 spawn：

- 固定端口：先探测占用，占用时返回 `{"ok": False, "detail": "port_in_use: ..."}`，不 spawn。Loom 的实现见 `backend/services/orchestrator/loom_spec.py:220-226`。
- pidfile：读到存活 pid 时复用或拒绝，不要盲目再 spawn。内核的 `ensure()` 与 `stale_kernel_detected` 分支见 `backend/services/orchestrator/kernel_spec.py:28-39`。

断言写法：先手工起一个假实例占住端口或写一个存活 pidfile，再调 `orchestrator.start(id)`，断言返回状态不是 `ready`、spawn 计数为 0、原实例仍存活。清理时只按记录下来的精确 pid 终止。

## 6. 补关停位次

`stop_all()` 按注册逆序逐个停止，总预算 15 秒；单个服务停止超时 15 秒；预算耗尽或停止动作超时后按精确 pid 补 SIGKILL（`backend/services/orchestrator/runtime.py:43-46`、`backend/services/orchestrator/runtime.py:72-76`、`backend/services/orchestrator/runtime.py:466-540`、`backend/services/orchestrator/runtime.py:927-955`）。后端关停时还会给内核预留 3 秒，编排器失败则退回 `kernel_client.stop_kernel_process()`（`backend/main.py:502-505`、`backend/main.py:584-640`）。

接入时要做的三件事：

1. 在 spec 模块 docstring 里写一行“关停位次：在 X 之前/之后”，和注册位次保持一致。现有 docstring 的 stop 语义写法可参考 `backend/services/orchestrator/kernel_spec.py:2-17`、`backend/services/orchestrator/moss_spec.py:4-13`、`backend/services/orchestrator/loom_spec.py:4-13`；这三份目前没有单独写位次，新服务必须补。
2. 在第 2 节的表里补一行，明确启动位次与关停位次。
3. 加一个顺序断言：用事件列表记录每个 `stop()` 的调用顺序，断言为注册逆序。模板在 `backend/tests/test_orchestrator_runtime.py:371-393`。

判断位次的口诀（当前以 kernel 为最底层生产者）：消费者先停，生产者后停，内核最后。若新服务是内核的消费者，它应排在内核之后注册，从而在内核之前停止；若新服务是 Loom 的数据生产者，它应排在 Loom 之前注册，从而在 Loom 之后停止。

## 7. 补真源矩阵一行

在 `docs/README.md` 第六节“真源矩阵”加一行（当前在 `docs/README.md:92-105`）。格式：

```markdown
| <服务名> 的启停条件与关停位次 | `../backend/services/orchestrator/<id>_spec.py` |
```

只写一个唯一真源，不要写“也可以看某文档”。如果文档分层重组已经把矩阵搬到别处，加到新的唯一矩阵里，不要另建第二份。

## 8. 可复制的约 30 行骨架

把下面内容保存为 `backend/services/orchestrator/demo_spec.py`，再在 `_register_orchestrator_specs()` 里调用 `register_demo_spec()`。骨架用真实子进程验证 ready 与关停，不依赖任何外部服务。

```python
# backend/services/orchestrator/demo_spec.py
from __future__ import annotations
import asyncio, sys
from typing import Any
from .spec import REGISTRY, ServiceSpec, register

_SPEC: ServiceSpec | None = None
_PROC: Any = None

async def _start() -> dict[str, Any]:
    global _PROC
    _PROC = await asyncio.create_subprocess_exec(sys.executable, "-c", "import time; time.sleep(3600)")
    return {"ok": True, "pid": _PROC.pid, "process": _PROC}

async def _stop() -> dict[str, Any]:
    global _PROC
    if _PROC is not None and _PROC.returncode is None:
        _PROC.terminate()
        await _PROC.wait()
    _PROC = None
    return {"stopped": True}

def register_demo_spec() -> ServiceSpec:
    global _SPEC
    if _SPEC is None:
        _SPEC = ServiceSpec(
            id="demo_service", requires=(), gate=None,
            start=_start, stop=_stop, critical=False,
            restart=True, enable_key=None,
        )
        register(_SPEC)
    return _SPEC
```

骨架只用于验证接线与状态可见性。真实长驻服务必须经 `child_entry` 获得父死保护，命令形如 `python -m services.orchestrator.child_entry --target <exe> ...`（`backend/services/orchestrator/loom_spec.py:73-99`、`backend/services/orchestrator/moss_spec.py:123-133`）；`start` 还必须在事件循环线程内 await，禁止用 `asyncio.to_thread` 包装（`backend/services/orchestrator/child_entry.py:24-28`）。骨架的 `stop` 也只做 terminate，生产实现要补超时与 SIGKILL 兜底（`backend/services/orchestrator/moss_spec.py:223-250`）。

## 9. 自检清单

- [ ] spec 文件已创建，八个字段都有值，`id` 与现有三个服务不重复。
- [ ] `register_<id>_spec()` 幂等，重复调用不抛错；同 id 不同声明会抛 `ValueError`。
- [ ] 已加入 `_register_orchestrator_specs()`，位次符合“生产者之后、消费者之前”。
- [ ] `GET /api/services` 能看到新服务，blocked 时有可读的 `reason_code` 与 `detail`。
- [ ] 三档状态断言齐全：blocked、ready、failed/spawn_failed。
- [ ] 双实例断言齐全：并发 `start()` 只 spawn 一次；外部占用端口或 pidfile 时 `start` 返回失败且不 spawn。
- [ ] 关停位次已写进 spec docstring，并有事件顺序断言。
- [ ] 真源矩阵已加一行，且只有一个指向。
- [ ] `cd backend && python -m pytest tests/test_<id>_spec.py tests/test_orchestrator_runtime.py -q` 全绿。
- [ ] `python3 scripts/check_ports.sh` 通过。
- [ ] `python3 tools/docs-check/check_docs.py all` 通过（仓库没有 `scripts/check_docs.py`，实际脚本在 `tools/docs-check/`）。

三十分钟验收路径：

1. 复制第 8 节骨架，按第 2 节注册在 kernel 之后。
2. 跑 `cd backend && python -m pytest tests/test_orchestrator_runtime.py -q`，确认既有单实例与逆序关停用例仍绿。
3. 用测试配置启动后端，请求 `/api/services`，确认 `demo_service` 为 `ready` 且有 pid。
4. 调用 `POST /api/services/demo_service/pause`，确认状态变为 `blocked/manually_paused`，pid 消失。
5. 调用 `POST /api/services/demo_service/resume`，确认重新变为 `ready`，pid 变化。
6. 关停后端，确认 demo 子进程消失；若没有，按 `/api/services` 记录的 pid 排查，不要按名称杀进程。
