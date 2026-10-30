# 故障处置手册（症状、判据、处置）

> 状态：现行（2026-10-29）。本文取代 `docs/部署踩坑与注意事项.md` 的排障部分；原文件只保留历史记录。
> 适用：Ubuntu + systemd + 进程编排器的生产部署。
> 相关手册：[部署](deploy-linux.md)、编排器迁移（公开树不包含）、[备份与恢复](backup-restore.md)。
> 总规则：结束进程只按精确 PID。先证明进程归属，再发信号。禁止按进程名批量结束。

## 使用方式

每个条目固定三段：

- **症状**：你能观察到的现象。
- **判据**：确认根因所需的命令与阈值。判据不成立就不要执行处置。
- **处置**：按顺序可执行的命令。需要重启时，必须满足条目里写明的重启判据。

通用前置：

```bash
cd /opt/kinship
ROOT=$(pwd)
```

API 调用需要 **user** Bearer。下面的 helper 把 token 从 stdin 交给 curl，不进入 argv：

```bash
api() {
  local method=$1 path=$2
  {
    printf 'header = "Authorization: Bearer %s"\n' "${AXEUH_API_TOKEN:?先 export AXEUH_API_TOKEN}"
    printf 'header = "Content-Type: application/json"\n'
    [ "$method" = "POST" ] && printf 'data = "{}"\n'
  } | curl -kfsS -X "$method" -K - "https://127.0.0.1:8768${path}"
}
```

进程归属证明：

```bash
show_proc() {
  local pid=$1
  test -n "$pid" || { echo "pid 为空"; return 1; }
  test -d "/proc/$pid" || { echo "pid=$pid 不存在"; return 1; }
  tr '\0' ' ' < "/proc/$pid/cmdline"; echo
  ps -o pid,ppid,user,etime,args -p "$pid"
}
```

按 PID 结束进程的固定动作：

```bash
stop_pid() {
  local pid=$1
  test -n "$pid" || return 1
  show_proc "$pid" || return 1
  sudo kill -TERM "$pid"
  for _ in $(seq 1 10); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.5
  done
  sudo kill -KILL "$pid"
}
```

## 症状 01：端口被占用

**症状**

- 启动日志出现 `address already in use`，或 `ss` 显示 8768、5100、8100、18888、8770 等端口已有监听。
- 迁移 stage3.0 后 `loom` 的 detail 出现 `port_in_use`。

**判据**

```bash
ss -lntp | grep -E ':(8768|5100|8100|18888|8770)\b'
```

- 8768 的监听者应该是 `core.hot_server`，父进程是 `axeuh-health`。
- 5100 的监听者在稳定态应该是 `node .../cli.js serve`，父进程是 `core.hot_server`；迁移期是 systemd `axeuh-loom`。
- 8100 的监听者应该是 `axeuh-moss` 的 vLLM 进程。
- 18888 是 Windows PC 采集器，不应出现在 Ubuntu 生产。
- 8770 是后端内的 QQ 网关，不应有独立进程占端口。

如果监听者的 `ppid` 与预期一致，端口占用是正常状态，不要处理。只有监听者属于退役单元、旧进程、外来进程，或同一服务出现两个实例时，才进入处置。

**处置**

1. 取 PID：

   ```bash
   ss -lntp 'sport = :5100'
   ```

2. 证明归属：

   ```bash
   PID=<上一步的 pid>
   show_proc "$PID"
   ```

3. 按场景处理：

   - 迁移 stage3.0，5100 属于 systemd `axeuh-loom`，`loom` 为 `failed/port_in_use`：这是预期。不要停它，继续 stage3.3 的 `disable --now` 与 `resume loom`。
   - 稳定态，5100 属于 systemd `axeuh-loom`，同时 `loom` child 也存在：双实例风险。按迁移手册的 `rollback-stage3.sh --yes` 执行，不要手工停一个。
   - 稳定态，5100 属于孤立 node 进程，`/api/services` 中 `loom` 不是 ready：确认 cmdline 是 `loom-harness/packages/server/dist/cli.js` 后，`stop_pid "$PID"`，然后 `api POST /api/services/loom/resume`。
   - 8768 属于旧进程或第二个后端：先 `show_proc`，确认不是当前 `axeuh-health` 的 `MainPID`，再 `stop_pid "$PID"`。不要对 `axeuh-health` 之外的进程发 `systemctl` 命令。
   - 8100 属于旧 vLLM 进程：确认 cmdline 含 `moss_serve.sh` 或 vLLM，`stop_pid "$PID"`，再 `sudo systemctl start axeuh-moss`。

4. 处理完复查：

   ```bash
   ss -lntp | grep -E ':(8768|5100|8100)\b'
   systemctl is-active axeuh-health axeuh-moss axeuh-loom
   ```

## 症状 02：后端启动失败或 Loom 必填项缺失

**症状**

- `axeuh-health` 反复 `activating` 后 `failed`，或启动日志出现配置校验阻断错误。
- 配置可以加载但 Loom 步骤提示缺少 URL 或 token。

**判据**

```bash
journalctl -u axeuh-health -n 120 --no-pager
test -f "$ROOT/config.yaml"; echo "config.yaml=$?"
```

- 日志出现 `ConfigValidationError`、类型错误、非法枚举或明确的启动校验阻断项。
- 注意：`config.yaml` 缺失本身按降级启动处理，不必然导致进程退出。
- `ai_backend: loom` 时 `loom.url` 为空，或 `loom.token`、环境变量 `LOOM_TOKEN`、`loom.token_file` 都没有提供，会表现为 Loom 不可用或降级，不会自动切到其他助手。

**处置**

1. 没有配置时，从模板复制，不要凭记忆手写：

   ```bash
   cp -a config.example.yaml config.yaml
   chmod 600 config.yaml
   ```

2. 自定义配置路径可放任意位置，并设置 `AXEUH_CONFIG_PATH`（兼容 `CONFIG_PATH`）。项目根由 `AXEUH_PROJECT_ROOT` 决定，不从配置文件位置推导；相对数据路径按项目根解析。

3. 补齐 Loom 必填项：`ai_backend: loom`、`loom.url`，以及任一 token 来源。主会话模型在 `ai/.loom/config.yaml` 的 `models[0]`；子智能体模型在 `ai/agents/*.md` 各自设置。

4. 配置修复后，只有 `systemctl is-active axeuh-health` 仍为 `failed` 时才重启：

   ```bash
   systemctl is-active axeuh-health
   sudo systemctl restart axeuh-health
   curl -kfsS https://127.0.0.1:8768/health
   ```

## 症状 03：内核起不来（spawn_failed、health_timeout、解释器错误）

**症状**

- `/api/services` 中 `kernel` 为 `failed`，detail 含 `spawn_failed`、`health_check_failed` 或 `model.unavailable`。
- 音频分析、唤醒、声纹结果缺失，但上传接口仍返回成功。

**判据**

```bash
api GET /api/services
journalctl -u axeuh-health -n 200 --no-pager | grep -i kernel
tail -n 80 backend/data/kernel_state/kernel.stderr.log
test -x /opt/kinship/.venv-kernel/bin/python; echo "kernel_python=$?"
```

- `kernel` 为 `failed`，且不是 `stale_kernel_detected` 或 `pidfile_corrupt`。
- `AXEUH_KERNEL_PYTHON` 指向的解释器不存在或不可执行。
- stderr 日志有 `model.unavailable`、`torch`、`CUDA`、`no kernel image` 等明确错误。

**处置**

1. 核对 unit 的解释器：

   ```bash
   systemctl show -p Environment axeuh-health | tr ' ' '\n' | grep AXEUH_KERNEL_PYTHON
   /opt/kinship/.venv-kernel/bin/python -c "import torch; print(torch.__version__)"
   ```

2. 按 stderr 修根因。模型缺失按 `docs/kernel-contract.md` 的三级解析链放权重；不要往 `backend/models/` 放。

3. 修复后重新拉起内核：

   ```bash
   api POST /api/services/kernel/resume
   ```

4. 如果 T36 路由尚未部署，且 `kernel` 为 `failed`、pidfile 不存在或 pid 已死，才允许重启后端：

   ```bash
   sudo systemctl restart axeuh-health
   ```

5. 不要手动执行 `python -m axeuh_kernel`。手动 spawn 会改写共享 pidfile，后端可能复用到错误解释器。

## 症状 04：`stale_kernel_detected`

**症状**

- `/api/services` 的 `kernel.detail` 含 `stale_kernel_detected: pid=<数字>`。
- 日志出现 "pidfile 记录了存活内核，但本进程没有接管它"。

**判据**

```bash
python3 - <<'PY'
import json
d = json.load(open("backend/data/kernel_state/kernel.pid"))
print("pid=%s port=%s" % (d.get("pid"), d.get("port")))
PY
```

- pidfile 里的 pid 存活。
- `/proc/<pid>/cmdline` 含 `axeuh_kernel`。
- 该 pid 的父进程不是当前 `axeuh-health` 的 `MainPID`。

后两条同时成立才是 stale。不要在不看 cmdline 的情况下直接结束进程。

**处置**

1. 证明归属：

   ```bash
   PID=<pidfile 里的 pid>
   show_proc "$PID"
   ```

2. 按 PID 停止：

   ```bash
   stop_pid "$PID"
   ```

3. 确认内核进程已消失：

   ```bash
   ps -eo pid,ppid,args | grep '[a]xeuh_kernel'
   ```

4. 重新拉起：

   ```bash
   api POST /api/services/kernel/resume
   ```

5. 如果 `resume` 不可用，且确认没有内核进程，才重启后端：

   ```bash
   sudo systemctl restart axeuh-health
   ```

## 症状 05：`pidfile_corrupt`

**症状**

- `kernel.detail` 含 `pidfile_corrupt: <路径>`。
- 后端拒绝 spawn 第二个内核，日志提示 "请先确认没有 axeuh_kernel 进程在运行，然后删除该 pidfile 再重试"。

**判据**

```bash
ls -l backend/data/kernel_state/kernel.pid
file backend/data/kernel_state/kernel.pid
wc -c backend/data/kernel_state/kernel.pid
ps -eo pid,ppid,args | grep '[a]xeuh_kernel'
```

不要打印 pidfile 全文，它含内核 token。只需要上面的元信息与进程列表。

- pidfile 存在，但为空、非法 JSON、顶层不是对象、pid 不是正整数。
- 先确认有没有存活内核。有内核时按 `stale_kernel_detected` 处理，不能直接删文件。

**处置**

1. 没有内核进程时，先备份损坏文件：

   ```bash
   cp -a backend/data/kernel_state/kernel.pid \
     "backend/data/kernel_state/kernel.pid.bak-$(date +%Y%m%d-%H%M%S)"
   ```

2. 删除损坏 pidfile：

   ```bash
   rm -f backend/data/kernel_state/kernel.pid
   ```

3. 重新拉起：

   ```bash
   api POST /api/services/kernel/resume
   ```

4. 有内核进程时，先按 PID 停止，确认消失后再删 pidfile。不要在有存活内核时删文件，否则会丢失归属线索并可能双 spawn。

## 症状 06：编排服务 blocked（disabled、missing_config、gate_failed、manually_paused）

**症状**

- `/api/services` 中某个服务 `state=blocked`，带 `reason_code`。
- 后端整体健康，但该功能不可用。

**判据**

```bash
api GET /api/services
api GET /api/system/config
```

`/api/services` 的 `reason_code` 是收敛后的稳定枚举，具体键在 `detail`。按两者判定：

| `reason_code` | `detail` 示例 | 常见原因 |
| --- | --- | --- |
| `missing_config` | `missing_config: moss.enabled` | 配置没有该键 |
| `missing_config` | `missing_config: loom.url` | Loom 地址为空 |
| `disabled` | `disabled` | `moss.enabled=false`，或 `ai_backend` 不是 `loom` |
| `gate_failed` | `gate_failed: python_missing` | MOSS 解释器不存在 |
| `gate_failed` | 其他闸门文本 | spec 闸门返回非预期值 |
| `manually_paused` | `paused by operator` | 运维执行过 `pause`，不是故障 |

**处置**

1. 先修配置，再用 `resume` 重新判定。不要直接重启后端来绕过 blocked。

2. `moss.enabled=false`：

   ```bash
   # 通过设置页或配置 API 写入 true，然后 apply
   api GET /api/system/config
   ```

   旧代码在线时该键是 `hot` 策略，可以直接 apply。新代码且编排器 off 时，respawn 钩子会失败；此时直接改 `config.yaml`，确认 `GET /api/system/config` 读到 `true`。

3. `python_missing`：

   ```bash
   test -x /opt/kinship/.venv-moss/bin/python
   sudo /opt/kinship/.venv-moss/bin/pip install -r tools/moss-shadow/requirements.txt
   ```

4. `ai_backend` 不是 `loom`：

   ```bash
   api GET /api/system/config
   # 把 ai_backend 改为 loom，loom.url 改为 http://127.0.0.1:5100，再 apply
   ```

5. 配置修复后：

   ```bash
   api POST /api/services/moss_watcher/resume
   # 或
   api POST /api/services/loom/resume
   ```

6. `manually_paused` 只在你确认要恢复时执行 `resume`。不要把它当故障自动解除。

## 症状 07：配置 apply 部分失败

**症状**

- `POST /api/config/apply` 返回中只有部分键成功，失败键留在草稿。
- `GET /api/config/pending` 仍列出失败键。
- 失败的键没有写入 `config.yaml`。

**判据**

```bash
api GET /api/config/pending
grep -n '<失败键>' config.yaml
```

- 响应中 `applied` 是成功子集，`failed` 非空。
- 失败键在 `config.yaml` 中仍是旧值。
- 失败原因通常是前置条件不满足、respawn 钩子失败、值非法。

**处置**

1. 读失败项的 `error` 与 `requires`，不要整批重试。

2. 按失败原因修复。典型情况：

   - `respawn` 策略在编排器 off 时失败：先完成 stage3，或临时直接改 `config.yaml`。
   - 值非法：按 `docs/CONFIGURATION.md` 修正类型与范围。
   - 依赖键缺失：先 apply 依赖键。

3. 修复后重新提交失败键，确认：

   ```bash
   api GET /api/config/pending   # 期望 count=0
   api GET /api/system/config    # 期望读到新值
   ```

4. 不要为了"让 apply 通过"而删除失败项或改判定口径。失败项留在草稿是设计行为，成功的键已经落盘。

## 症状 08：Loom child 起不来

**症状**

- `/api/services` 中 `loom` 为 `failed` 或 `blocked`。
- 网页或 QQ 对话不可用，Loom `/health` 不可达。

**判据**

```bash
api GET /api/services
tail -n 120 backend/data/logs/loom-child.log
test -f loom-harness/packages/server/dist/cli.js; echo "dist=$?"
test -f ai/.loom/config.yaml; echo "config=$?"
command -v node
```

按 `detail` 判定：

| detail | 判据 | 处置 |
| --- | --- | --- |
| `port_in_use: 127.0.0.1:5100 (pid=...)` | 5100 有监听者 | 迁移 stage3.0 属预期；稳定态见下 |
| `node_missing` | `command -v node` 为空 | 安装 node 或修正 unit PATH |
| `config_missing` | `ai/.loom/config.yaml` 不存在 | 从备份恢复配置 |
| `token_missing` | `/etc/kinship-loom/credentials.conf` 无 `LOOM_TOKEN` 或不可读 | 修复凭据文件权限与内容 |
| `health_failed` | child 起来了但 `/health` 不通过 | 看 `loom-child.log`，检查 dist 与配置 |
| `spawn_failed` | `OSError`、权限、cwd 错误 | 看日志中的具体 errno |

**处置**

1. `port_in_use`：

   - 迁移 stage3.0 且 systemd Loom 仍 active：预期，继续 stage3.3。
   - 稳定态且 `axeuh-loom` 为 active：双实例风险。先确认 5100 的监听 PID 属于 systemd 单元：

     ```bash
     ss -lntp 'sport = :5100'
     PID=<监听 pid>
     show_proc "$PID"
     systemctl show -p MainPID --value axeuh-loom
     ```

     两者一致时，说明旧的 systemd Loom 还在。迁移期按 `rollback-stage3.sh --yes`；如果你明确要切换到 child，执行：

     ```bash
     sudo systemctl disable --now axeuh-loom
     api POST /api/services/loom/resume
     ```

   - 监听者不是预期进程时，确认 cmdline 后再 `stop_pid "$PID"`，然后 `resume loom`。

2. `node_missing`：安装 node 后，只有满足"loom 为 failed 且没有 child 进程"才重启后端：

   ```bash
   sudo systemctl restart axeuh-health
   ```

3. `config_missing`：从[备份](backup-restore.md)恢复 `ai/.loom/config.yaml`，保持权限 600。

4. `token_missing`：

   ```bash
   sudo ls -l /etc/kinship-loom/credentials.conf
   sudo grep -c '^LOOM_TOKEN=' /etc/kinship-loom/credentials.conf
   ```

   修复后 `api POST /api/services/loom/resume`。

5. `health_failed`：看 `loom-child.log`。如果是 dist 缺失或损坏，在 `loom-harness` 重新构建，然后：

   ```bash
   api POST /api/services/loom/pause
   api POST /api/services/loom/resume
   ```

6. 连续两次 `resume` 都失败，且对话不可用超过 5 分钟：按迁移手册回滚，不要无限重试。

## 症状 09：Loom systemd 单元停不下来（迁移期或回滚期）

**症状**

- `systemctl restart axeuh-loom` 长时间不返回。
- `systemctl status axeuh-loom` 停在 `deactivating (stop-sigterm)`。

**判据**

```bash
systemctl status axeuh-loom --no-pager
systemctl show -p MainPID -p TimeoutStopUSec -p ActiveState axeuh-loom
```

- `ActiveState=deactivating` 持续超过 20 秒。
- `TimeoutStopSec=15`，超时后 systemd 会补 SIGKILL；仍不退时需要人工按 PID 处理。

**处置**

1. 取 MainPID：

   ```bash
   PID=$(systemctl show -p MainPID --value axeuh-loom)
   show_proc "$PID"
   ```

2. 先 TERM：

   ```bash
   sudo kill -TERM "$PID"
   sleep 3
   kill -0 "$PID" 2>/dev/null && sudo kill -KILL "$PID"
   ```

3. 复查：

   ```bash
   systemctl is-active axeuh-loom
   ```

4. 迁移期不要为了让 unit "看起来正常"而重新启动它。稳定态下 systemd Loom 必须保持 inactive。

## 症状 10：后端重启卡在 `deactivating (stop-sigterm)`

**症状**

- `systemctl restart axeuh-health` 长时间不返回，8768 短暂不可用。
- `systemctl status axeuh-health` 停在 `deactivating (stop-sigterm)`。

**判据**

```bash
systemctl status axeuh-health --no-pager
python3 - <<'PY'
import json
d = json.load(open("backend/data/kernel_state/kernel.pid"))
print(d.get("pid"))
PY
```

- `ActiveState=deactivating` 持续超过 20 秒。
- pidfile 的 pid 存活，且 `/proc/<pid>/cmdline` 含 `axeuh_kernel`。

**处置**

1. 证明归属：

   ```bash
   PID=<pidfile 中的 pid>
   show_proc "$PID"
   ```

2. 按 PID 停止内核：

   ```bash
   stop_pid "$PID"
   ```

3. 等待 systemd 完成 stop。`Restart=always` 会拉起新后端：

   ```bash
   for _ in $(seq 1 30); do
     systemctl is-active --quiet axeuh-health && break
     sleep 1
   done
   systemctl status axeuh-health --no-pager
   ```

4. 如果 30 秒后仍为 `deactivating`，取单元 MainPID，确认后按 PID 强制结束：

   ```bash
   PID=$(systemctl show -p MainPID --value axeuh-health)
   show_proc "$PID"
   sudo kill -KILL "$PID"
   ```

## 症状 11：MOSS watcher 不产出 deepdive

**症状**

- `moss_watcher` 显示 `ready`，但 `audio_deepdive.jsonl` 长时间没有新行。
- 新音频文件持续落盘。

**判据**

```bash
TODAY=$(date +%F)
find "ai/data/daily/$TODAY/audio" -type f -mmin -15 | wc -l
wc -l "ai/data/daily/$TODAY/audio_deepdive.jsonl" 2>/dev/null || true
curl -fsS http://127.0.0.1:8100/v1/models | head -c 200
api GET /api/services
```

- 过去 15 分钟有新音频文件。
- `audio_deepdive.jsonl` 行数在 15 分钟内不变。
- `moss_watcher=ready`。

如果新音频为 0，先不要判故障。如果 deepdive 新行是 `_sc` 静音短路行，也不是故障。只有"有新音频、watcher ready、deepdive 完全无新行"才进入处置。

**处置**

1. 看 watcher 日志。稳定态 watcher 是后端子进程，输出在 `journalctl -u axeuh-health`：

   ```bash
   journalctl -u axeuh-health -n 300 --no-pager | grep -Ei 'MOSS|watcher|deepdive|backlog'
   ```

2. 如果日志有 `backlog dropped`，这是背压信号，不是数据丢失。等下一趟，或降低入水速度。

3. 如果 serve 不可达（`/v1/models` 非 200），按征兆 12 处理。watcher 会冷却 120 秒后重试新流。

4. 如果 `moss_watcher` 不是 ready：

   ```bash
   api POST /api/services/moss_watcher/resume
   ```

5. 如果 `moss.enabled` 被改为 false，watcher 会 blocked/disabled。改回 true 并 apply，再 `resume`。

6. 只读冒烟，不写行：

   ```bash
   /opt/kinship/.venv-moss/bin/python tools/moss-shadow/watcher.py --once --dry
   ```

   如果 dry 显示 backlog 为 0 且 serve 探活失败，问题在 serve 或新音频发现，不在 watcher 写入。

## 症状 12：MOSS serve OOM 或 8100 暴露

**症状**

- `axeuh-moss` 反复重启，日志 `CUDA out of memory`。
- `ss` 显示 `0.0.0.0:8100`，不是 `127.0.0.1:8100`。
- 8100 可被局域网访问。

**判据**

```bash
systemctl status axeuh-moss --no-pager
journalctl -u axeuh-moss -n 120 --no-pager | grep -i 'out of memory\|CUDA'
ss -lntp 'sport = :8100'
nvidia-smi --query-gpu=index,memory.used,memory.total --format=csv
nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv
```

- 卡 2 显存接近上限，或日志明确 OOM。
- 监听地址不是回环。

**处置**

1. OOM：

   - 确认 MOSS 独占卡 2。8G 卡上任何共卡都会 OOM。
   - 不要调大 `stitch.max_chunk_s`，120 秒段是贴边预算。
   - 按 `docs/moss-8g-deploy/` 降低 `max-model-len` 或 `gpu-memory-utilization`。
   - 需要结束占用进程时，先 `nvidia-smi` 取 PID，`show_proc "$PID"` 证明是本机预期进程，再 `stop_pid "$PID"`。
   - 只有 `systemctl is-active axeuh-moss` 为 active 且 `/v1/models` 连续 2 次（间隔 60 秒）失败，才重启：

     ```bash
     sudo systemctl restart axeuh-moss
     ```

2. 8100 暴露：

   - 给 `tools/moss-shadow/moss_serve.sh` 或装机脚本加 `--host 127.0.0.1`，或设置 `AXEUH_MOSS_HOST=127.0.0.1`。
   - 重启 `axeuh-moss` 后复查：

     ```bash
     ss -lntp 'sport = :8100'
     curl -fsS http://127.0.0.1:8100/v1/models | head -c 120
     ```

   - 8100 没有鉴权，不能裸露公网。防火墙只放行本机不是长期方案，优先改绑定地址。

## 症状 13：音频分析没有结果或 `model.unavailable`

**症状**

- 上传成功，`perception.jsonl` 有音频指针，但 ASR、声纹、唤醒结果缺失或明显变差。
- 作业返回 503 `model.unavailable`。
- RTX 50 系显卡上 `torch.cuda.is_available()` 为 True，一跑张量就报 `no kernel image is available`。

**判据**

```bash
api GET /api/services
python3 - <<'PY'
import json
d = json.load(open("backend/data/kernel_state/kernel.pid"))
print("pid=%s port=%s" % (d.get("pid"), d.get("port")))
PY
KPORT=$(python3 -c 'import json; print(json.load(open("backend/data/kernel_state/kernel.pid"))["port"])')
curl -fsS "http://127.0.0.1:${KPORT}/v1/health"
tail -n 80 backend/data/kernel_state/kernel.stderr.log
/opt/kinship/.venv-kernel/bin/python -c "import torch; print(torch.__version__)"
```

- 内核 `/v1/health` 不可达，或 stderr 有模型缺失。
- `model.unavailable` 明确指向 pyannote、KWS、Cnn14 等模型。
- torch 版本是 cu124 而显卡是 RTX 50 系。

**处置**

1. 内核不可达时按征兆 03、04、05 处理。后端没有本地模型兜底，功能降级不是配置问题。

2. `model.unavailable`：按 `docs/kernel-contract.md` 的三级解析链放权重。KWS 的模型目录与 `keywords.txt` 要放在同一解析根。pyannote 需要接受 gated 条款并放 HF token。

3. RTX 50 系：

   ```bash
   sudo /opt/kinship/.venv-kernel/bin/pip install torch torchaudio \
     --index-url https://download.pytorch.org/whl/cu128
   sudo /opt/kinship/.venv-kernel/bin/python -c \
     "import torch; x=torch.randn(8, device='cuda'); print((x*2).sum().item())"
   ```

4. 换模型或换 torch 后，内核必须重新 spawn。先 `pause` 再 `resume`：

   ```bash
   api POST /api/services/kernel/pause
   api POST /api/services/kernel/resume
   ```

   只 `resume` 不会重启已经在 ready 的内核。

## 症状 14：磁盘满

**症状**

- 日志出现 `No space left on device`。
- 后端、构建或内核引导失败。
- `df` 的 Use% 达到 90% 以上。

**判据**

```bash
df -h / /mnt/d
du -x -h -d1 /srv 2>/dev/null | sort -h | tail
du -x -h -d1 /opt/venvs 2>/dev/null | sort -h | tail
```

- 根分区或 `/mnt/d` 剩余空间低于 10%，或低于内核引导要求的 8 GiB（CUDA 路径 12 GiB）。
- 明确是日志、缓存、备份、venv 占用，不是 `ai/data` 源数据。

**处置**

1. 只有写入已经连续失败，或剩余空间低于 2 GiB，才停止写入：

   ```bash
   sudo systemctl stop axeuh-health
   ```

   编排器会随 cgroup 停止子服务。`axeuh-moss` 不写 `ai/data`，可暂时保留。

2. 清理已知可再生内容，按从安全到谨慎的顺序：

   - `backend/logs/` 中超过保留期的日志。
   - `<TMP_DIR>` 临时目录。
   - 旧备份目录中超过保留策略的副本。
   - pip、npm、torch 缓存。
   - 不要删除 `ai/data/daily/**`、`ai/memory/**`、`backend/config/auth.json`。

3. venv 放大盘并用符号链接，不要复制回系统盘：

   ```bash
   du -sh /opt/venvs/*
   # 迁移时使用与现有部署一致的路径，不要覆盖正在使用的 venv
   ```

4. 腾出空间后启动并验证：

   ```bash
   sudo systemctl start axeuh-health
   curl -kfsS https://127.0.0.1:8768/health
   api GET /api/services
   df -h / /mnt/d
   ```

5. 如果 `ai/data` 确实需要扩容，先做[备份](backup-restore.md)，不要直接删除音频原件。

## 症状 15：迁移失败需要回滚

**症状**

- 任一迁移阶段 PRE/POST 断言失败，脚本非零退出。
- stage3.0 后 `loom` 不是 `failed/port_in_use`。
- `LOOM_WINDOW_MS > 60000`。
- 出现双实例或 `perception.jsonl` 行数下降。

**判据**

```bash
ls -lt backend/data/migration-state/logs | head
tail -n 80 backend/data/migration-state/logs/<最新日志>
cat backend/data/migration-state/loom-window.txt 2>/dev/null || true
```

- 日志明确显示失败的阶段与断言。
- 记录最后完成的阶段。回滚从最高已完成阶段开始。

**处置**

1. 立即停止后续阶段，不要"再跑一次看看"。

2. 按最高已完成阶段选择回滚脚本，顺序固定为 4 -> 3 -> 2 -> 1：

   ```bash
   cd /opt/kinship-wt/process-orchestrator-refactor
   bash scripts/migrate-orchestrator/rollback-stage4.sh --dry-run
   bash scripts/migrate-orchestrator/rollback-stage4.sh --yes
   bash scripts/migrate-orchestrator/rollback-stage3.sh --dry-run
   bash scripts/migrate-orchestrator/rollback-stage3.sh --yes
   bash scripts/migrate-orchestrator/rollback-stage2.sh --dry-run
   bash scripts/migrate-orchestrator/rollback-stage2.sh --yes
   AXEUH_ALLOW_CODE_ROLLBACK=1 bash scripts/migrate-orchestrator/rollback-stage1.sh --dry-run
   AXEUH_ALLOW_CODE_ROLLBACK=1 bash scripts/migrate-orchestrator/rollback-stage1.sh --yes
   ```

   如果只完成了 stage1 或 stage2，从对应阶段回滚，不必执行更高阶段。

3. 顺序不可反：

   - `rollback-stage4` 只回到 stage3 状态，不启用 Loom/MOSS 单元。
   - `rollback-stage3` 必须先 off + 重启，让 child 退出，再 `enable --now` 两个单元。先启用会双实例。
   - `rollback-stage1` 要求 ExecStart 是 `launcher.py`；stage4 已执行时先跑 rollback-stage4。

4. 回滚后验证：

   ```bash
   systemctl is-active axeuh-health axeuh-loom axeuh-moss-watch
   curl -kfsS https://127.0.0.1:8768/health
   api GET /api/services   # 旧代码可能 404；新代码应为 orchestrator=off
   wc -l ai/data/daily/$(date +%F)/perception.jsonl
   ```

5. 完整步骤与状态矩阵见迁移手册（公开树不包含）第 8 节。

## 症状 16：`/mobile/` 404

**症状**

- 后端 `/health` 正常，但浏览器打开 `/mobile/` 返回 404。
- `frontend/mobile/dist/index.html` 不存在或资源引用不完整。

**判据**

```bash
test -f frontend/mobile/dist/index.html; echo "dist=$?"
curl -kfsS https://127.0.0.1:8768/health
```

- 后端健康，dist 缺失。
- 不是 Caddy 502，也不是证书错误。

**处置**

```bash
cd frontend/mobile
npm ci
npm run build:atomic
npm run verify:dist
```

按构建输出的 `dist-<时间戳>` 原子替换：

```bash
cd ../..
STAMP=$(date +%Y%m%d-%H%M%S)
if [ -d frontend/mobile/dist ]; then
  cp -a frontend/mobile/dist "frontend/mobile/dist-backup-$STAMP"
  mv frontend/mobile/dist "frontend/mobile/dist-old-$STAMP"
fi
NEW=$(find frontend/mobile -maxdepth 1 -type d -name 'dist-2*' | LC_ALL=C sort | tail -n 1)
test -n "$NEW"
mv "$NEW" frontend/mobile/dist
```

静态产物按请求读取，不需要重启后端。回滚时把备份目录换回 `dist/`，同样不需要重启。

## 症状 17：Caddy 502、证书错误或 IPv6 8443 不通

**症状**

- 浏览器 502，或证书告警。
- IPv4 443 正常，IPv6 8443 超时。

**判据**

```bash
curl -kfsS https://127.0.0.1:8768/health
ss -lntp 'sport = :8768'
sudo caddy validate --config /etc/caddy/Caddyfile
curl -4 -kfsS https://<domain>/health
curl -6 -kfsS https://<domain>:8443/health
```

- 上游 8768 不可达：先修后端，不要改 Caddy。
- Caddy 配置校验失败：修配置后再 reload。
- IPv4 正常、IPv6 超时：查 DNS AAAA 与 ip6tables 8443。

**处置**

1. 上游不可达时按征兆 03、10 处理。Caddy 只是反代，502 通常不是 Caddy 本身。

2. 配置校验通过后 reload，不要 restart：

   ```bash
   sudo caddy validate --config /etc/caddy/Caddyfile
   sudo systemctl reload caddy
   ```

3. IPv6：

   ```bash
   sudo ip6tables -L INPUT -n --line-numbers | head -30
   sudo grep -n '8443' /etc/ip6tables.rules
   ```

   放行 8443 后持久化并恢复。不要使用 IPv6 443，运营商封禁家宽 80/443。

4. DNS 必须同时有 A 和 AAAA。只有 AAAA 会让 IPv4 入口和证书续期断掉；泛解析 A 不覆盖已有 AAAA 的子域名。

5. 不要回退到 nginx 或宝塔。当前入口是 Caddy。

## 症状 18：QQ 网关 8770 不通

**症状**

- `curl 127.0.0.1:8770/v1/health` 失败。
- NapCat 3001 没有连接。

**判据**

```bash
systemctl is-active axeuh-health
ss -lntp 'sport = :8770'
ss -tnp | grep ':3001' || true
api GET /api/system/config
sudo ls -l /etc/kinship-qq-gateway/mcp.token
```

- `qq_gateway.enabled` 为 false。
- `mcp.enabled` 为 false，或 token 文件缺失、权限不对。
- 后端已经启动，但配置是 `lru_cache` 读的，改完没有重启。

**处置**

1. 确认配置：

   ```bash
   api GET /api/system/config
   ```

   需要 `qq_gateway.enabled=true`、`qq_gateway.mcp.enabled=true`、`token_file` 指向正确路径。

2. 修复 token 文件：

   ```bash
   sudo install -d -m 0750 /etc/kinship-qq-gateway
   sudo test -s /etc/kinship-qq-gateway/mcp.token || \
     sudo install -m 0600 /dev/null /etc/kinship-qq-gateway/mcp.token
   sudoedit /etc/kinship-qq-gateway/mcp.token
   ```

3. 配置或 token 修改后，只有满足"`/health` 200 且 8770 无监听"才重启后端：

   ```bash
   sudo systemctl restart axeuh-health
   ss -lntp 'sport = :8770'
   ```

4. 3001 没有连接时，检查 NapCat 自身与网络；不要结束 QQ 网关进程来"重连"。

## 历史事件与已退役做法

> 本节保留原《部署踩坑与注意事项》的历史事件，供追溯。它不是现行操作依据；现行处置见上文章节。

### H1 2026-10-08 之前的 Windows 时代

当时的生产实例（历史值）运行在 Windows 11，后端 HTTPS 为 8767，助手由旧版自建服务承载，公网入口是 VPS nginx + frps 20077，Python 环境是 conda `axeuh-multi-agent`，证书用 certbot 或宝塔，进程管理用 `start.bat` / `start.ps1`。这些路径在 Ubuntu 迁移后全部失效。

历史值对照：

| 历史（Windows 11 时代） | 现行（2026-10-29 Ubuntu） |
| --- | --- |
| 后端 HTTPS 8767（历史） | 后端 8768，HTTP/HTTPS 同端口 |
| `http_port` 8768 未启用时曾回落 8769（已废弃，现统一 8768） | 8769 已退役，不再监听 |
| 旧版助手服务 | Loom 5100 是唯一助手宿主 |
| VPS nginx + frps 20077 | frpc 80/443 透传 + 本机 Caddy 443/8443 |
| `start.bat` / `start.ps1` / PowerShell | systemd `axeuh-health` |
| `C:\Kinship`、`%LOCALAPPDATA%` | `/opt/kinship`、`~/.cache/...` |
| conda `axeuh-multi-agent` | `/opt/kinship/.venv-health`、`axeuh-kernel`、`axeuh-moss` |
| `backend/models/` 放权重 | 内核私有模型目录，三级解析链 |
| certbot / 宝塔 / nginx 反代 | Caddy 自动证书 + 反代 |
| `Test-NetConnection` 判断端口 | `ss` + 应用层 `curl` |

### H2 2026-10-20 旧版助手端点退役

旧版助手端点曾由后端使用。退役后不再监听，任何助手路径不得引用旧端口。现行助手宿主只有 Loom（`127.0.0.1:5100`）；故障时不要把 `ai_backend` 切到其他后端，也不要把任何旧实例当作回退。

### H3 2026-10-22 系统盘被 venv 占满

系统盘曾经只剩约 2.3 GiB，原因是内核与 MOSS 的 venv 放在 `/opt/venvs`。处置是把 `axeuh-kernel`、`axeuh-moss` 等 venv 迁到 D 盘，并在 `/opt/venvs` 留符号链接。升级 venv 时不要把目录复制回系统盘。内核引导自身也有磁盘守卫：CPU 路径至少 8 GiB，CUDA 路径至少 12 GiB。

### H4 2026-10-22 MOSS 8100 绑定到 0.0.0.0

仓库参考 unit 声明回环，但生产实测 `ss` 显示 `0.0.0.0:8100`。原因是 vLLM 默认绑定所有地址，启动脚本没有显式 `--host`。处置是加 `--host 127.0.0.1` 或用防火墙限制。8100 无鉴权，不能裸露公网。该事件说明"unit 文件写了回环"不等于"进程实际绑定回环"，每次部署都要用 `ss` 核对。

### H5 2026-10-29 launcher 退役与 stage4 切换

任务 25 把 systemd 入口从 `launcher.py` 切到 `core.hot_server`，但生产切换被拆到迁移 stage4。stage4 之前 ExecStart 一直是 launcher，以便回滚面最小。`launcher.py` 已退役，不再管理任何助手进程，其启动逻辑只在迁移期回滚中保留。不要在 stage1 之前手工重启新代码，否则编排器会在 off 开关安装前接管服务。

### H6 2026-10-29 内核损坏 pidfile 可能触发二次 spawn（T34）

旧实现读取 pidfile 时对不可读、非法 JSON、pid 非正数过于宽松，可能在后端重启后 spawn 第二个内核。T34 改为严格读取：pidfile 存在但不可信时抛 `pidfile_corrupt`，不 spawn、不删除、不隔离文件。处置权留给运维。这也是为什么本手册要求先确认没有内核进程，再备份并删除 pidfile。

### H7 2026-10-29 Loom 未按 `ai_backend` 门控（T35）

旧 `loom_spec` 只检查 `loom.url` 和 `ai_backend` 是否存在，未检查值是否为 `loom`。全新安装或助手通道未归一为 `loom` 的部署会尝试 spawn 未构建的 Loom，反复失败。T35 增加 gate：只有 `ai_backend` 归一后等于 `loom` 才允许启动，否则保持 `blocked/disabled`。

### H8 Loom 对 SIGTERM 不退出（历史实测）

Loom 在部分环境下收到 SIGTERM 后不退出，systemd 会停在 `deactivating (stop-sigterm)`。`axeuh-loom.service` 的 `TimeoutStopSec=15` 会兜底 SIGKILL。人工处置只按 MainPID 发 TERM，短等不退再 KILL。不要按进程名结束 node。迁移到 child 模式后，LOOM 的停止由 `loom_spec` 先 TERM，等待 5 秒排水，再 KILL。

### H9 手动 spawn 内核劫持 pidfile

历史上曾出现手工执行 `python -m axeuh_kernel` 的情况。内核会把新 pidfile 写到共享状态目录，后端下次请求可能复用到错误解释器，表现为音频分析全部静默失败。现行规则是内核只由后端 spawn；需要重启时用 `pause`/`resume` 或按精确 PID 停止。

### H10 旧 Windows 脚本按进程名结束端口占用进程

历史 `start.ps1` 曾用按进程名结束的方式释放端口，且端口清单已过时。该做法与现行操作准则冲突，属于已知问题，不再维护。Ubuntu 生产只允许 systemd 管理服务，结束残留进程只按精确 PID。
