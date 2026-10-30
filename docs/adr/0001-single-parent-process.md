# ADR 0001：后端是唯一父进程，父死子清

- 状态：已实施
- 日期：2026-10-29
- 相关任务：8、10、11、12、14、15、25

## Context

改造前，三个子进程有三种归属：音频内核由后端按需 spawn，Loom 由 systemd 单元 `axeuh-loom` 托管，MOSS watcher 由 systemd 单元 `axeuh-moss-watch` 托管。后端退出后，内核依赖自己的 pidfile 与人工处置，Loom 与 watcher 依赖 systemd cgroup 清场。

这带来四个问题：

1. Windows 没有 systemd，父死子清无法用同一套机制表达。
2. 两套守护语义（systemd 与后端）对同一进程的生死判断不一致，排障要看两处日志。
3. 后端崩溃后内核可能变成孤儿，占着显存与端口，下一次启动还可能接错进程。
4. 计划要求后端退出后所有子进程 15 秒内消失，不能只靠操作系统默认行为。

## Decision

1. 编排器是唯一父进程。`backend/main.py:315-328` 按 kernel、moss_watcher、loom 的固定顺序注册服务声明；`backend/main.py:451-455` 在服务面启动时统一调用 `start_all()`。Loom 不再是 systemd 单元；`deploy/kinship.service.example` 只启动 `core.hot_server`，并用 `AXEUH_LOOM_MODE=child` 声明子进程模式。

2. POSIX 父死保护。子进程入口 `backend/services/orchestrator/child_entry.py` 在 exec 目标前调用 `prctl(PR_SET_PDEATHSIG, SIGTERM)`，安装后立即复查 `getppid()`；父进程已消失时拒绝 exec 并以 75 退出（`backend/services/orchestrator/child_entry.py:69-110`、`backend/services/orchestrator/child_entry.py:316-345`）。execve 会保留该设置，所以 exec 后的目标进程仍受保护。

3. Windows 父死保护。父进程在 spawn 后创建带 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 的 Job Object，并把子进程加入（`backend/services/orchestrator/child_entry.py:235-291`）。句柄挂在 `ServiceRecord.job` 上，停止或退出时关闭（`backend/services/orchestrator/runtime.py:1293-1326`）。父进程退出时由 Windows 内核清场，不依赖子进程自检。

4. 线程约束。`PR_SET_PDEATHSIG` 跟随创建子进程的父线程，不是父进程。因此所有 spawn 都在事件循环线程内 await，禁止用 `asyncio.to_thread` 包装（`backend/services/orchestrator/child_entry.py:24-28`、`backend/services/orchestrator/runtime.py:33-38`）。三个 spec 的 start 都遵守这一约束（`backend/services/orchestrator/kernel_spec.py:28-39`、`backend/services/orchestrator/moss_spec.py:194-220`、`backend/services/orchestrator/loom_spec.py:203-289`）。

5. 有序关停。`stop_all()` 按注册逆序停止，即 loom、moss_watcher、kernel（`backend/services/orchestrator/runtime.py:466-540`、`backend/services/orchestrator/runtime.py:1215-1226`）。总预算 15 秒，超时后对残留 pid 直接 SIGKILL（`backend/services/orchestrator/runtime.py:72-76`）。`_stop_service_plane` 再预留 3 秒给内核优雅退出，编排器失败时退回 `kernel_client.stop_kernel_process()`（`backend/main.py:502-505`、`backend/main.py:584-640`）。

6. 只用精确 pid。所有终止路径按 pid 发信号或调用 `TerminateProcess`，不做名称匹配（`backend/services/orchestrator/runtime.py:195-258`、`backend/services/orchestrator/runtime.py:957-1006`）。

## Consequences

正面：

- 三个子进程只有一个生命周期所有者，启动、重启、关停、状态查询都走同一状态机。
- Linux 与 Windows 共用一套编排代码，差异只在父死保护的实现。
- 后端退出后不再依赖 systemd cgroup 兜底，systemd 只负责后端本身。
- `/api/services` 能给出每个子进程的 pid、状态与原因码，排障不用跨两套日志。

代价与边界：

- 后端重启会同时终止 Loom，Web 对话在重启窗口内断线。这是把 Loom 变成子进程的直接代价。
- POSIX 保护绑定 spawn 线程。任何把 spawn 移到工作线程的改动都会让内核误杀子进程，这是硬约束。
- Windows Job Object 创建失败只记录 WARNING 并继续（`backend/services/orchestrator/runtime.py:1305-1311`），此时父死子清退化为无保护。该降级是显式的，不能当成已保护。
- 不覆盖外部手工启动的同名进程。编排器只管理自己 spawn 的 pid，内核 pidfile 的 adopt 路径是显式例外，归属证明在 `kernel_client` 内完成。
- systemd 仍是后端进程的外层守护。后端崩溃后 `Restart=always` 会拉起新后端；新后端若发现旧子进程仍存活，按各 spec 的归属检查处理（内核 pidfile、Loom 端口占用），不会盲目再 spawn。

## Alternatives

1. 每个子进程一个 systemd 单元。否决：Windows 无 systemd，双平台要两套父死语义；后端与 systemd 还会形成双守护，谁负责重启无法唯一。
2. 保留 launcher 作为父进程。否决：launcher 已退役，生产 unit 直接启动 `core.hot_server`（示例见 `deploy/kinship.service.example`）；再加一层父进程只会多一个需要守护的守护者。
3. 父进程轮询子进程并清理。否决：崩溃时父进程已不在，轮询无法执行；按名称杀进程违反项目纪律，也有误杀同名进程的风险。
4. 子进程自己定期检查父 pid。否决：检查间隔内仍有孤儿窗口，每个服务还要重复实现；PDEATHSIG 与 Job Object 是内核级保证。
