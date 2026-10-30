# ADR 0002：配置两阶段，apply 是唯一执行入口

- 状态：已实施
- 日期：2026-10-29
- 相关任务：3、4、5、6、19、20

## Context

改造前，`ConfigStore.save()` 直接写 config.yaml、发布内存快照并通知 watcher 与 applier。用户在设置页改一个字段就立即改变运行行为；改到一半放弃时，系统已经处于混合状态。引导步骤同样是一步一写，失败后无法区分哪些已生效。

需要解决的问题：

1. 编辑期不能影响运行行为。
2. 应用失败时只保留失败项，已成功项不能重复执行。
3. 敏感值不能在 pending 响应中回显。
4. 引导 finish 与设置页 apply 必须共用同一套执行逻辑，不能出现两份实现。

## Decision

1. 草稿层独立于已提交配置。`ConfigStore.stage()` 只做校验与草稿持久化，不写 config.yaml、不发布快照、不触发 applier 或 watcher（`backend/config/store.py:1030-1088`，docstring 在 `backend/config/store.py:1035-1038`）。草稿真源是 `<项目根>/backend/data/config_draft.json`（`backend/config/store.py:255-256`），内存态为 `_staged_doc` 与 `_staged_clear_keys`。

2. 差异查询与丢弃。`pending()` 返回 staged 相对 committed 的 `{path: {from, to}}`，删除用 `to: None`（`backend/config/store.py:1090-1119`）；`discard()` 清内存并删除草稿文件（`backend/config/store.py:1121-1127`）。API 层对敏感路径做掩码（`backend/routers/system_config.py:622-690`）。

3. 应用事务。`apply_staged()` 是草稿唯一的执行器，组顺序固定为 hot、reconnect、respawn、deployment（`backend/services/config_reconciler.py:237-244`、`backend/services/config_reconciler.py:319-409`）。执行期先用 `begin_preview()` 发布一次性内存快照，让 respawn 与 reconnect 钩子读到新值，结束后 `end_preview()` 恢复已提交快照（`backend/services/config_reconciler.py:369-409`、`backend/config/store.py:1137-1190`）。

4. 部分成功。只有成功路径经 `store.commit(paths=applied)` 落盘；失败路径留在草稿里等待重试，坏值不会进入 config.yaml（`backend/services/config_reconciler.py:411-412`、`backend/config/store.py:1191-1276`）。响应带 `partial` 标志（`backend/services/config_reconciler.py:440-448`；`backend/routers/system_config.py:793-823`）。

5. 唯一入口。设置页 `/api/config/apply` 与 `/api/config/apply/retry` 都调用 `apply_staged()`（`backend/routers/system_config.py:793-857`）；引导 finish 复用同一函数，失败即 409 且不写 completed（`backend/services/onboarding_finish.py:474-503`、`backend/services/onboarding_finish.py:541-550`）。引导步骤本身只 stage，不 apply（`backend/services/onboarding_service.py:1013-1025`）。

6. 策略执行。hot 只登记给领域 applier；reconnect 调 QQ、P2P、MOSS 的重连钩子；respawn 调内核重启或编排器 stop 与 start watcher，并在执行前校验解释器路径；deployment 不执行动作，只返回 `requires_restart` 条目（`backend/services/config_reconciler.py:124-135`、`backend/services/config_reconciler.py:144-234`、`backend/services/config_reconciler.py:264-316`）。

## Consequences

正面：

- 编辑期零副作用，放弃只需 `discard()`。
- 失败可重试且只重跑失败项，已成功项不会二次重启服务。
- apply 的返回结构同时给出 applied、failed、deferred_restart、partial，前端可以直接渲染。
- 引导与设置页共用一条执行链，行为一致。

代价与边界：

- 系统有草稿与已提交两份状态，排障时必须先看 `pending()` 才能知道差异。草稿文件损坏时只告警并忽略，不影响启动；有效草稿中已与已提交快照相同的条目会在启动时被修剪（`backend/config/store.py:945-990` 附近）。
- 部分成功是设计语义，不是异常：一次 apply 后可能一半生效、一半留在草稿。
- deployment 类改动会被 commit，但运行时不会变，必须重启后端。只看 `applied` 会误以为已生效。
- hot applier 在 commit 之后执行，applier 失败时值已经落盘，只记录错误日志（`backend/services/config_reconciler.py:411-438`）。这不是事务回滚。
- 手工直接编辑 config.yaml 绕过草稿层，由外部 watcher 直接 `store.apply()`（`backend/config/store.py:1390-1409`）。两阶段只约束 API 与引导路径。

## Alternatives

1. 保留即时写盘，前端加确认弹窗。否决：确认只在前端，后端仍立即生效；多客户端或刷新页面无法保证。
2. 全量事务，失败整体回滚。否决：respawn 与 reconnect 有外部副作用（进程已重启、连接已重建），无法真正回滚；强行回滚会把系统留在更差的状态。
3. 每个键独立 apply。否决：同组键会触发多次重启或重连，且顺序不可控。
4. 单独起一个配置守护进程。否决：多一个进程与生命周期，且与后端内存快照不同步；现有 ConfigStore 已持有唯一快照。
