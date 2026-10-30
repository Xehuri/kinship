# ADR 0003：删除 bootstrap 模式，用 blocked 服务取代延迟服务面

- 状态：已实施
- 日期：2026-10-29
- 相关任务：17、18、19、20

## Context

改造前有两套启动路径：

- 引导未完成：服务面不启动，业务子系统延迟；finish 时一次性 attempt、validate、promote、commit。
- 引导已完成：服务面正常启动。

这带来四个问题：

1. 同一份启动代码有两个入口，测试要覆盖两条路径，生产实际只跑一条。
2. 未配置被表达为整层不存在，排障看不到缺什么，`/api/services` 也没有可展示的对象。
3. 引导步骤没走完时后台能力全部缺席，无法指出哪个服务缺哪个键。
4. 延迟服务面与编排器的状态机重复，编排器本来就有 blocked 状态。

## Decision

1. 单一启动路径。lifespan 无条件先 `_start_core()`，再 `_start_service_plane()`（`backend/main.py:297-312`）。`BootstrapRuntime` 以 `active=False` 创建，只保留 start 与 stop 回调给回滚脚本，主入口不再调用 attempt 或 activate（`backend/main.py:280-294`）。服务面启动后调用 `mark_started()` 进入 committed（`backend/main.py:306-307`；`backend/services/bootstrap_runtime.py:504-511`）。

2. 引导门与进程生命周期解耦。`OnboardingGateMiddleware` 只按 `onboarding_state.completed` 决定是否返回 503，不再读 runtime.active（`backend/middleware/onboarding_gate.py:1-10`、`backend/middleware/onboarding_gate.py:33-50`；`backend/services/onboarding_service.py:971-989`）。

3. 缺配置表达为 blocked。启动时先注册 spec 再 `start_all()`，每个 spec 独立判定；不满足则进入 `blocked`，原因码为 `missing_config`、`disabled`、`gate_failed` 之一，永不自动重试（`backend/main.py:444-455`；`backend/services/orchestrator/runtime.py:7-10`、`backend/services/orchestrator/runtime.py:144-155`、`backend/services/orchestrator/runtime.py:588-624`）。

4. 状态可见。`snapshot()` 对已注册但未启动的 spec 返回 placeholder，未满足条件的直接显示 blocked（`backend/services/orchestrator/runtime.py:318-334`、`backend/services/orchestrator/runtime.py:1162-1173`）；`/api/services` 只投影公开字段（`backend/routers/services_status.py:51-85`、`backend/routers/services_status.py:88-117`）。

5. 调度器门控。任一 `critical=True` 服务 ready 才恢复派发；全部不 ready 时暂停，可选服务起落不改变结论（`backend/services/scheduler_gating.py:4-44`；注册点在 `backend/main.py:360-379`）。

6. finish 退化为审计。finish 的顺序固定为预检、应用草稿、就绪审计、记录 completed，函数不再 attempt、validate 或 promote（`backend/services/onboarding_finish.py:506-513`）。就绪审计要求 `critical=True` 服务处于 ready，或用户在其引导步骤显式 skipped；未就绪即 409，不写 completed（`backend/services/onboarding_finish.py:298-372`、`backend/services/onboarding_finish.py:552-566`）。

## Consequences

正面：

- 启动只有一条路径，测试与生产一致。
- 未配置不再表现为什么都没有，而是每个服务一行 blocked 与具体缺键。
- 新增服务不需要改引导流程，只要注册 spec。
- 调度器不会在关键服务不可用时空跑任务。

代价与边界：

- blocked 是稳定状态，不是临时状态。配置不变时不会自愈；当前只有进程启动时的 `start_all()`、显式 `retry()` 或 `resume()` 会重新判定。配置 apply 本身不会自动重跑整个 `start_all()`，只有带 respawn 策略的服务会被钩子 stop 与 start（`backend/services/config_reconciler.py:82-97`）。
- 全新安装时服务面已经启动，日志里会先出现一批 blocked。这是预期，不是故障。
- `/api/services` 不在引导放行名单内（`backend/middleware/onboarding_gate.py:18-50`），引导完成前该端点仍会被 503 挡住。进程状态本身已存在，但运维可见性要等门开。
- `BootstrapRuntime` 作为兼容外壳仍在，回滚脚本仍使用它，代码层面还留着 deferred 与 attempt 语义；主路径不再依赖它。
- 调度器自动暂停依赖 `critical` 标记。新增关键服务若忘记标 `critical=True`，任务会在无人察觉时保持暂停。

## Alternatives

1. 保留 bootstrap 与 normal 双路径，只做代码整理。否决：两套生命周期仍然存在，测试覆盖与排障成本不会下降。
2. 启动时只起已配置服务，finish 后重启后端。否决：finish 会触发一次完整重启，Loom 与内核断线，且与 finish 内合并校验的目标冲突。
3. 引导未完成时完全不启动服务面，只把 blocked 做成静态清单。否决：清单需要另建一份真源，容易与 REGISTRY 漂移。
4. 让引导门直接控制编排器开关。否决：门是 HTTP 层关注点，进程生命周期是运行时关注点；耦合后一次引导状态读取失败就会影响后台采集。
