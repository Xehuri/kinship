# 编排器迁移：四阶段 + 回滚（stage1-4）

本目录是**生产迁移**脚本，不是日常运维工具。四阶段必须按 1 → 2 → 3 → 4 串行执行，
每阶段之间至少留一个观察窗；**不允许一次跑完**。

| 脚本 | 做什么 | 中断面 |
| --- | --- | --- |
| `stage1.sh` | 部署新代码，drop-in 钉 `AXEUH_ORCHESTRATOR=off`，重启后端 | 后端 8768 数秒；内核随 cgroup 重启（懒加载重建） |
| `stage2.sh` | 只 `systemctl disable --now axeuh-moss-watch` | 零主链影响（纯旁路 watcher） |
| `stage3.sh` | 编排器 ON，逐个接管 kernel / moss_watcher / loom；Loom 最后 | 后端重启一次；Loom 停-接窗口有 60 秒硬预算 |
| `stage4.sh` | ExecStart 从 `launcher.py` 切到 `core.hot_server`，删迁移 drop-in | 后端 8768 数秒 |

所有脚本共同遵守的契约（`lib.sh`）：

1. 先做 PRE 检查（`/health`、`/api/services`、`perception.jsonl` 行数快照），失败即停；
2. `set -euo pipefail`，ERR trap 打印失败行号并提示回滚；
3. 输出固定三段：`PRE` → `EXEC` → `POST`，同时写入状态目录的审计日志；
4. 写操作全部经 `sudo` 并逐条打印（`EXEC run: sudo ...`）；
5. 凭据永不打印：API token / LOOM_TOKEN 只经 stdin 交给 `curl -K -`；
6. 绝不 `pkill` / `killall` / `taskkill`；结束进程只按 PID（`kill <PID>`）；
7. 绝不写 `ai/data/**`：perception 只做 `wc -l` 只读快照。

默认行为：**不带 `--yes` 就是 dry-run**（只读检查 + 打印命令计划）。真实执行必须显式
`--yes`。

---

## 1. 前置条件

### 1.1 代码部署（stage1 之前，人工完成）

`stage1.sh` 默认**不会** `git checkout` 生产检出：生产工作区通常带大量数据脏文件，脚本内切代码
无法安全回滚。两种部署方式：

```bash
# 方式 A（推荐，v1）：人工部署，stage1 只校验 + 记录 rev
git -C /opt/kinship-wt/process-orchestrator-refactor rev-parse HEAD
git -C /opt/kinship checkout --detach <sha>

# 方式 B：把部署交给 stage1（会先 tar 备份 backend/ deploy/ launcher.py 并记录 pre-rev）
AXEUH_DEPLOY_REV=<sha> bash stage1.sh --yes
```

两种方式都**不要手工重启后端**（重启会让新代码以默认 `AXEUH_ORCHESTRATOR=on` 接管服务，
正好绕过 stage1）。方式 B 的 `git checkout` 失败时脚本在重启前就停，什么都不动。

stage1 会校验：`backend/core/hot_server.py`、`backend/services/orchestrator/runtime.py`、
`deploy/axeuh-health.service`（且 `ExecStart` 含 `core.hot_server`）都存在。可选的
`EXPECTED_REV=<sha>` 会额外断言生产检出的 HEAD。

如果误重启导致 `/api/services` 已经返回 `orchestrator=on`，stage1 会拒绝继续（这是双实例
风险的入口）。

### 1.2 配置前置（stage3 之前）

`moss_watcher` 的 spec 要求 `moss.enabled=true`，默认值是 `false`（生产 `config.yaml`
当前没有该键）。stage3 会读 `GET /api/system/config` 的有效配置并检查；不满足会直接停。

**在代码部署（1.1）之前设置**，此时跑的还是旧代码：旧 schema 里 `moss.enabled` 的
`apply_strategy` 是 `hot`，配置页/`POST /api/config/apply` 可以正常落盘。

注意：新代码把该键的 `apply_strategy` 改成了 `respawn`，而 respawn 钩子在编排器 off 时
会抛 `编排器未启用，无法重启 moss_watcher`，apply 会失败、值留在草稿里。所以：

- 推荐顺序：旧代码在线时先 apply `moss.enabled=true` → 再部署代码 → stage1；
- 如果代码已经部署（off）才想起这件事：仓库约定允许直接改生产 `config.yaml`
  （单文件、无覆盖层），改完用 `GET /api/system/config` 确认 `config.moss.enabled=true`。
  此时 store 的 respawn 策略会在 `apply_failures` 里留一条失败记录，可忽略。

同时确认：`ai_backend=loom`、`loom.url` 是 loopback（child 模式只允许
`http://127.0.0.1:*` / `http://localhost:*`）、`ai/.loom/config.yaml` 存在、
`loom-harness/packages/server/dist/cli.js` 存在、`node` 在 PATH。

### 1.3 凭据

- **API token**（访问 `/api/services` 与闸门）：优先 `AXEUH_API_TOKEN`，其次
  `AXEUH_TOKEN_FILE`（文件内容只有 token），否则从 `AXEUH_AUTH_FILE`
  （默认 `<root>/backend/config/auth.json`）里挑一个**未过期的 user token**。
  注意 `/api/services` 走 `require_config_read`，**service/device token 会被 403**。
- **LOOM_TOKEN**（探测 Loom 自己的 `/health`）：优先 `AXEUH_LOOM_TOKEN`，否则从
  `/etc/kinship-loom/credentials.conf`（root:xehuri 0640，组内可读）提取。

两者都不会出现在 argv、`ps` 或日志里：`curl` 通过 `-K -` 从 stdin 读 `Authorization`
头。

### 1.4 sudo

`systemctl enable/disable/restart`、`install`、`rm /etc/...` 需要 root。脚本会先
`sudo -v` 提示一次，然后每 60 秒后台续期（长观察窗里 sudo 时间戳不会过期），退出时按 PID
结束续期进程。

---

## 2. 阶段顺序与理由（为什么 Loom 最后）

- **stage1 先 off 再部署**：新代码默认 `on`。如果先重启再装 off 开关，编排器会立刻接管
  kernel/moss/loom，形成"旧 systemd Loom + 新 child Loom"双实例。stage1 的唯一目的就是
  让新代码以"不接管任何服务"的姿态上线，行为等同旧版。
- **stage2 只停 MOSS**：`moss_watcher` 是纯 sidecar，只写 `audio_deepdive.jsonl`，停多久
  都不影响采集/分析主链。先停它，stage3 启动编排器时才不会出现两个 watcher 同时订阅同一
  目录（重复 deepdive 行）。
- **stage3 逐个接管，Loom 最后**：Loom 是唯一"停掉就立刻影响对话"的服务。kernel 与
  moss_watcher 在编排器 ON 的第一次启动里就完成接管（kernel 走 pidfile / spawn，moss 走
  spawn），**Loom 此时必须失败在 `port_in_use`**，因为 systemd 的 Loom 还占着 5100。
  这个"失败"是正向证据：编排器没有 adopt 一个不受控的 Loom，也没有起第二个实例。
  最后一步才 `disable --now axeuh-loom`，紧接着 `resume loom`。
  注意：切换 `AXEUH_ORCHESTRATOR` 必须重启后端，systemd 重启会清空 cgroup，内核随之
  冷启动一次；3.2 的 `resume kernel` 在此时只是幂等确认，不会再产生额外中断。冷启动耗时
  由 `wait_service_state kernel ready 300` 兜住，超时即失败。
- **stage4 最后切 ExecStart**：只有前三阶段验证通过，才把 launcher 摘掉，让 systemd
  直接跑 `core.hot_server`。这样回滚面最小：stage4 之前 ExecStart 一直是 launcher。

---

## 3. 60 秒预算（定义、分解、怎么测）

**被测窗口**：从 `systemctl disable --now axeuh-loom` **开始**，到 Loom 自己的
`GET http://127.0.0.1:5100/health` 返回 `200 {"status":"ok"}` 为止。也就是"用户真正无法
使用 Loom"的那段时间。

**断言**（`lib.sh:run_loom_handoff` + `assert_within_budget_ms`）：

1. `LOOM_WINDOW_MS = t(health ok) - t(stop 开始)`，必须 `<= 60000`；
2. `LOOM_HANDOFF_GAP_MS = t(resume 发出) - t(stop 返回)`，必须 `<= 5000`——这就是
   "两者之间不得插入其他步骤"的可测量形式；
3. 全部数值写入 `$AXEUH_STATE_DIR/loom-window.txt` 和 POST 日志行。

**时间分解**（脚本无法压缩，只能监控）：

| 段 | 上界 | 来源 |
| --- | --- | --- |
| systemd 停 Loom | 15s | `axeuh-loom.service` 的 `TimeoutStopSec=15`（boot.ts 自身排水 5s，通常 1-5s） |
| `resume loom`（child 健康等待） | 45s | `loom_spec.HEALTH_TIMEOUT_S = 45`：`_start_loom` 在 start 动作里等 `/health` |
| 合计（到 /health ok） | 60s | 最坏情况刚好等于预算；正常实测远低于此 |

编排器的 `loom` 状态变成 `ready` 还额外经过 `SPAWN_GRACE_S = 10` 秒（`runtime.py`）。
因此脚本**只把 60 秒预算压到 `/health ok`**，`ready` 作为独立断言（`wait_service_state
loom ready 180`）并把耗时打印出来。两者都写进证据，避免"ready 晚了 10 秒"被误判成
Loom 不可用 70 秒。

**降级模式的风险**：`AXEUH_GATE_MODE=restart` 时 3.3 用 `systemctl restart axeuh-health`
代替 `resume`。这个重启会连内核一起重建，且 `start_all()` 里内核 spawn 会阻塞事件循环，
Loom child 可能排在内核后面启动，窗口可能超过 60 秒。脚本会照常断言并在超预算时失败。
**F4 应使用 api 模式。**

---

## 4. 观察窗（不得跳过）

| 阶段 | 服务 | 时长 | 环境变量 |
| --- | --- | --- | --- |
| 3.1 | kernel + moss_watcher | 600s | `AXEUH_OBSERVE_MOSS_S` |
| 3.2 | kernel + moss_watcher | 600s | `AXEUH_OBSERVE_KERNEL_S` |
| 3.3 | kernel + moss_watcher + loom | 1800s | `AXEUH_OBSERVE_LOOM_S` |

每 15 秒复核所有列出的服务 `state=ready`；每 60 秒复核 `/api/services` 可达与当日
`perception.jsonl` 行数不减少。任何一项不满足立即失败并停止。

stage3 全程 10 + 10 + 30 分钟，请放在 `tmux` / `setsid` 里跑，别挂在会断的 SSH 会话上。

---

## 5. 每个阶段的具体动作

### stage1.sh（off 上线）

PRE：`/health`、`/api/services`（允许 404，旧代码没有该端点）、perception 快照、
代码部署检查、三个单元 active、kernel pidfile 归属检查。

EXEC：

```bash
# 文件：/etc/systemd/system/axeuh-health.service.d/20-orchestrator-migration.conf
[Service]
Environment=AXEUH_ORCHESTRATOR=off

sudo systemctl daemon-reload
sudo systemctl restart axeuh-health
```

POST：`/api/services` 200 且 `{"orchestrator":"off","services":[]}`；Loom/MOSS 单元仍
active；kernel pidfile 不指向"非 hot_server 子进程"的存活 PID；perception 不减。

### stage2.sh（只停 MOSS）

PRE：`orchestrator=off`、moss 单元 active、无游离 watcher（排除 systemd MainPID）、
Loom active。

EXEC：`sudo systemctl disable --now axeuh-moss-watch`。

POST：moss 单元 inactive + disabled；Loom 仍 active；`/health` 200；`orchestrator=off`；
无游离 watcher；perception 不减。

### stage3.sh（ON + 逐个接管）

PRE：`orchestrator=off`、moss 单元 inactive/disabled、Loom active 且
`http://127.0.0.1:5100/health` 返回 ok、`moss.enabled=true`、配置/构建产物齐全、
kernel 无游离 pidfile、闸门可用性探测。

EXEC 3.0：drop-in 改为

```bash
[Service]
Environment=AXEUH_ORCHESTRATOR=on
Environment=AXEUH_LOOM_MODE=child
```

`daemon-reload` + `restart axeuh-health`。期望：`kernel=ready`、`moss_watcher=ready`、
`loom=failed` 且 `detail` 含 `port_in_use`。**若 loom 变成 ready/starting，脚本立即失败**
（双实例风险，回滚 `rollback-stage3.sh --yes`）。

EXEC 3.1：`resume moss_watcher`（已 ready 时幂等）→ 观察 10 分钟。
EXEC 3.2：`resume kernel`（已 ready 时幂等）→ 观察 10 分钟。
EXEC 3.3：Loom 交接（见第 3 节）→ 观察 30 分钟。

POST：三个服务全 ready；Loom pid 的父进程是 `core.hot_server`；两个 systemd 单元
inactive/disabled；perception 不减。

### stage4.sh（ExecStart 切换）

PRE：`orchestrator=on`、三个服务全 ready、ExecStart 是 `launcher.py`、deploy unit 含
`core.hot_server` 与 `AXEUH_ORCHESTRATOR=on`、kernel 无游离 pidfile。

EXEC：

```bash
# 备份到 $AXEUH_STATE_DIR/backup/
sudo install -m0644 <root>/deploy/axeuh-health.service /etc/systemd/system/axeuh-health.service
sudo rm -f /etc/systemd/system/axeuh-health.service.d/20-orchestrator-migration.conf
sudo systemctl daemon-reload
sudo systemctl restart axeuh-health
```

POST：`ExecStart` 含 `core.hot_server`；`orchestrator=on`；三个服务 ready；
Loom pid 的 ppid 等于 unit `MainPID`；Loom/MOSS 单元 inactive；perception 不减。

> 主机级 drop-in `/etc/systemd/system/axeuh-health.service.d/10-p2p.conf` 不在仓库内，
> 覆盖主 unit 不会删除它，`P2P_SIGNAL_SECRET` 继续生效。

---

## 6. 运维闸门（pause / resume）

T8 的 `pause(id)` / `resume(id)` 只存在于**后端进程内**的运行时单例；T9 只暴露了
`GET /api/services`。外部脚本无法调用进程内对象，所以闸门必须有一个 HTTP 面。

**约定的闸门契约（本脚本按此调用）**：

```
POST /api/services/{id}/resume    Authorization: Bearer <user token>   -> 200
POST /api/services/{id}/pause     Authorization: Bearer <user token>   -> 200
id ∈ {kernel, moss_watcher, loom}
```

脚本不解析响应体，只要求 HTTP 200，然后轮询 `/api/services` 断言目标状态（对响应形状
不敏感）。

`AXEUH_GATE_MODE`：

| 值 | 行为 |
| --- | --- |
| `auto`（默认） | 用 `GET /api/services/kernel/resume` 探测路由存在（405/200/401/403 视为存在，404 视为缺失）。存在走 api，缺失**直接停**（exit 7）并打印两个选项 |
| `api` | 强制 api；缺失即停 |
| `restart` | 降级：3.3 用 `systemctl restart axeuh-health` 代替 resume。会重建内核，窗口可能超 60s，仅作应急 |

**当前 HEAD 的现状**：闸门路由不存在（`auto` 会在 stage3 预检停下）。F4 之前二选一：

1. 推荐：加最小路由（`POST /api/services/{id}/pause|resume`，Bearer user token，
   直接调 `get_orchestrator().pause/resume`，返回 200）；
2. 应急：`AXEUH_GATE_MODE=restart`，接受内核重建与窗口风险。

---

## 7. 回滚矩阵

| 失败/回退点 | 脚本 | 动作 | 恢复后的状态 |
| --- | --- | --- | --- |
| stage1 之后 | `rollback-stage1.sh --yes` | 需要 `AXEUH_ALLOW_CODE_ROLLBACK=1`；rev 取 `AXEUH_ROLLBACK_REV`，否则读 `stage1-pre-rev`（方式 B 部署时自动记录）：tar 备份 `backend/ deploy/ launcher.py` → `git checkout <rev> -- <path>` → 删 drop-in → `daemon-reload` → `restart` | 旧代码 + launcher；`/api/services` 404 |
| stage2 之后 | `rollback-stage2.sh --yes` | `systemctl enable --now axeuh-moss-watch` | MOSS 回到 systemd；Loom 未动 |
| stage3 之后 | `rollback-stage3.sh --yes` | `AXEUH_ORCHESTRATOR=off` drop-in → `daemon-reload` → `restart`（子进程随 cgroup 退出）→ `systemctl enable --now axeuh-loom axeuh-moss-watch` | 迁移前拓扑：三单元 active、编排器 off |
| stage4 之后 | `rollback-stage4.sh --yes` | 还原备份的 unit + drop-in → `daemon-reload` → `restart` | stage3 状态（launcher + on，子进程受管） |

**顺序规则（违反会造成双实例）**：

- `rollback-stage3` 必须"先 off + 重启，再 enable 单元"。先 enable 会让 systemd Loom 与
  仍在运行的 loom child 抢 5100，MOSS 也会双订阅。
- `rollback-stage4` **不** enable Loom/MOSS 单元：它只回到 stage3 状态。要回到迁移前拓扑，
  在它之后继续跑 `rollback-stage3.sh`。
- 全量回退：`rollback-stage4` → `rollback-stage3` → `rollback-stage2` → `rollback-stage1`。

回滚是恢复路径：后端不可达时 PRE 只 WARN 不阻断（`rollback_preflight`），但 sudo、备份
文件、数据根仍硬校验。

---

## 8. 状态目录、日志与证据

默认 `AXEUH_STATE_DIR=<root>/backend/data/migration-state`（`backend/data/` 已被
`.gitignore` 覆盖）：

```
logs/<stage>-<ts>.log          每次运行的完整三段日志
perception-total-<tag>         全局 perception 行数快照
perception-today-<tag>         当日 perception 行数快照
perception-total.last          上一阶段 POST 的快照（单调断言基线）
loom-window.txt                stage3 的 window/gap/stop/mode 实测值
stage1-deployed-rev            stage1 记录的部署 sha
backup/axeuh-health.service.*  stage4 的 unit 备份
backup/latest-unit             最近一次 unit 备份路径
backup/dropin-*.conf           drop-in 备份
backup/code-<ts>.tar.gz        rollback-stage1 的代码备份
```

F4 取证：把 `logs/stage3-*.log` 里 `LOOM_WINDOW_MS=` 行与 `loom-window.txt` 抄进
`.omo/evidence/process-orchestrator-refactor/F4.txt`。

---

## 9. 绝不触碰 `ai/data/**`

迁移脚本对数据目录只有两种只读操作：`wc -l perception.jsonl` 与 `find ... -name
perception.jsonl`。没有重定向、没有 `rm`/`mv`/`cp`/`tee` 指向 `ai/data`。`lib.sh` 的
`assert_no_ai_data_write` 在每次运行开始时自检脚本目录，发现可疑写法直接失败。

`perception.jsonl` 单调不减是每个阶段 POST 的硬断言（当日 + 全局两个口径）。

---

## 10. 故障处置

| 症状 | 判据 | 处置 |
| --- | --- | --- |
| `kernel` 状态 `failed`，detail 含 `stale_kernel_detected` | pidfile 里的 pid 存活但不是 `core.hot_server` 的子进程 | 按 PID 停：`sudo kill <pid>`（先确认 `/proc/<pid>/cmdline` 是 `axeuh_kernel`），再 `POST /api/services/kernel/resume` |
| `kernel` 状态 `failed`，detail 含 `pidfile_corrupt` | pidfile 不可读/非法 JSON，新代码拒绝猜测 | 确认没有 `axeuh_kernel` 在跑后删除 `<root>/backend/data/kernel_state/kernel.pid`，再 `POST /api/services/kernel/resume` |
| stage3.0 后 `loom=ready` | systemd Loom 还占着 5100 却出现了 child | 立即 `rollback-stage3.sh --yes`（先 off+重启再 enable） |
| stage3.3 `loom` 一直 `failed` | detail 含 `health_failed` / `spawn_failed` | 看 `$AXEUH_ROOT/backend/data/logs/loom-child.log`；`sudo systemctl enable --now axeuh-loom` 恢复 systemd Loom（60 秒内） |
| `systemctl restart axeuh-health` 卡在 `deactivating (stop-sigterm)` | 内核子进程还在 cgroup | 按 pidfile 的 PID `sudo kill <pid>`；systemd 随后完成 stop 并按 `Restart=always` 拉起（不要按名杀） |
| `systemctl restart axeuh-loom` 卡住 | Loom 对 SIGTERM 不退出 | `TimeoutStopSec=15` 会兜底 SIGKILL；仍不退时按 `systemctl show -p MainPID --value axeuh-loom` 取 PID 手动 `kill -TERM` / `kill -KILL` |
| `moss_watcher` 状态 `blocked/disabled` | 有效配置 `moss.enabled=false` | 在 stage3 之前把它改成 true 并 apply |

---

## 11. F4 执行清单

1. 代码部署到生产检出（1.1），**不重启**（可用 `AXEUH_DEPLOY_REV=<sha> bash stage1.sh --yes` 交给 stage1 做）。
2. 配置 `moss.enabled=true` 并 apply（1.2）。
3. `bash stage1.sh --dry-run` → 通过后 `bash stage1.sh --yes`；确认 `orchestrator=off`。
4. `bash stage2.sh --yes`；确认 moss 单元 inactive、Loom 未动。
5. 确认闸门：`GET /api/services/kernel/resume` 不是 404（否则见第 6 节）。**不要**用
   `AXEUH_GATE_MODE=restart` 跑生产，除非接受内核重建。
6. 在 tmux 里 `bash stage3.sh --yes`；记录 `LOOM_WINDOW_MS`、`LOOM_HANDOFF_GAP_MS`、
   `LOOM_STOP_MS`、`mode`，断言窗口 `<= 60000`。
7. `bash stage4.sh --yes`；确认 `ExecStart` 是 `core.hot_server`、`orchestrator=on`、
   三个服务 ready、Loom ppid 等于 unit MainPID。
8. 把每次运行的三段日志与 `loom-window.txt` 归档到 F4 证据；任一阶段失败按第 7 节回滚。
