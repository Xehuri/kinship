# Flow Phase A 退休运维手册

> 目的：在把 `flow.enabled` 设为 `false` 之前，安全、可逆地把 Flow 状态（磁盘数据 + wake 队列条目）
> 清出生产路径，**不删除、不移动、不改动**任何用户数据。Phase B（移除 Flow 代码）是后续独立任务。

## 工具位置

- 核心模块：`loom-harness/packages/server/src/maintenance/flow-retire.ts`（`dryRun` / `apply` / `verify` / `liveInstancePresent`）
- CLI 包装：`loom-harness/scripts/retire-flow.mjs`
- 测试：`loom-harness/packages/server/src/maintenance/flow-retire.test.ts`

## 数据范围与假设

- Flow 真源：`<stateRoot>/session/<sid>/flow/`（subjects / items / index.json / unset.jsonl）
- Flow 唤醒条目：`<stateRoot>/session/wake-queue/<sid>.json`（schema 2），`source=flow` 或 `action=flow.check` 的条目
- 实例锁：`<stateRoot>/session/wake-queue/.instance.json`（含 `pid`），由 WakeQueue 在运行时持有

`apply` 的唤醒条目过滤规则（与 `wake-queue.ts` 对齐）：
- 删除：`source === "flow"`，或 `action === "flow.check"`
- 保留：`source=plan`、`source=special`（含 `action=special.continue`），以及其它任何非 flow 条目；schema / session_id / delivered 全部原样保留

原子性：wake sidecar 改写走「同目录 temp + fsync + rename」，读侧永不见半截；任一 sidecar 不可读时整体中止、不留下破坏性写入。

## 前置：配置备份（永远先备份）

```bash
# 生产配置（私有实例目录，不要改它，只备份）
sudo cp -a kinship-data/ai/.loom/config.yaml kinship-data/ai/.loom/config.yaml.bak-$(date +%Y%m%d-%H%M%S)

# 状态根整目录也建议先整盘备份 / 快照（工具本身是复制而非删除，仍建议有回滚锚点）
```

**严禁**在本任务中编辑 `kinship-data/ai/.loom/config.yaml`。

## 步骤 1：停止服务（只用 systemd，禁止 pkill / killall）

```bash
sudo systemctl stop axeuh-loom
# 确认端口已释放、进程已退出
sudo systemctl status axeuh-loom --no-pager | head -5
```

仅按 PID `kill <PID>` 允许；**禁止** `pkill` / `killall`（会误伤其它进程）。

## 步骤 2：dry-run（只读，绝不写）

```bash
cd loom-harness
node scripts/retire-flow.mjs --state-root /path/to/stateRoot --dry-run
```

输出：每个会话的 subjects / items / nonClosed 计数、flow 唤醒条目清单、目标归档路径。
确认 `totalFlowDirs` 与预期一致，再继续。

## 步骤 3：apply（复制 + 取消 flow 唤醒 + 写 manifest）

```bash
node scripts/retire-flow.mjs --state-root /path/to/stateRoot --apply
```

行为：
- 若检测到存活实例锁（`.instance.json` 中 pid 仍存活），**拒绝**并退出非 0，不做任何写入。
- 创建 `<stateRoot>/flow.retired-<UTC时间戳>/`，**复制**每个 `session/<sid>/flow` 整棵目录树（不移动）。
- 写 `retired.json` manifest（含 sessions / 文件数 / 取消的 wake 条目数 / 时间戳）。
- 原子改写所有 wake sidecar，删 flow 唤醒条目，保留其余与 schema。
- **原 `session/<sid>/flow` 与 wake sidecar 完全保留**（只是 sidecar 少了 flow 条目）。

幂等：重复 `apply` 只会再建一个带随机后缀的新归档目录，绝不覆盖或删除既有归档/原数据。

## 步骤 4：启动服务

```bash
sudo systemctl start axeuh-loom
sudo systemctl status axeuh-loom --no-pager | head -5
```

此时若 `flow.enabled` 仍为 `true`，boot 会按既有逻辑构造零 Flow 面（无任何改动）；若已设为 `false`
且仍有 flow 状态目录残留，boot 会打印**单条 WARN**：

```
[warn] loom flow state remains but flow.enabled=false
       hint: 运行 node scripts/retire-flow.mjs --state-root <stateRoot> --apply ...
       sessions: ["s1", ...]
```

该 WARN 仅提示，不改变任何 boot 行为。

## 步骤 5：verify（确认退休完成）

```bash
node scripts/retire-flow.mjs --state-root /path/to/stateRoot --verify \
  --config kinship-data/ai/.loom/config.yaml
```

- 若存在任何 `session/*/flow` 目录或 flow 唤醒条目 → 失败、退出非 0（此时通常是尚未手动清原目录）。
- `--config` 传入时，若配置文件仍 `flow.enabled: true` 也会报失败（提示你还没切开关）。
- 输出机器可读 JSON；`ok: true` 即通过。

> 工具本身**不删除**原 `session/<sid>/flow` 目录（那一步是 Phase B / 人工确认后的动作）。
> 只有在你手动 `rm -rf session/<sid>/flow` 后，`verify` 才会通过。退休归档 `flow.retired-*` 即回滚锚点。

## 回滚（Rollback）

由于 `apply` 只复制、不删除、不改动原数据：

1. 若尚未手动删原 flow 目录：直接把 `config.yaml` 里 `flow.enabled` 设回 `true` 并 `systemctl restart axeuh-loom` 即可，wake sidecar 中被取消的 flow 条目可由 Flow 子系统在下次 reconcile 时重建。
2. 若已手动删原 flow 目录、需要找回：从 `flow.retired-<时间戳>/session/<sid>/flow` **复制回**原路径即可。

## 退出码约定（CLI）

- `0`：dry-run 成功 / apply 成功 / verify 通过（或 `--help`）
- `1`：运行时错误（含存活实例锁拒绝、sidecar 不可读中止）/ verify 失败
- `2`：参数错误（缺 `--state-root` 或未指定模式）

## 测试与类型检查

```bash
cd loom-harness
npx vitest run packages/server/src/maintenance/flow-retire.test.ts
npm run typecheck
```
