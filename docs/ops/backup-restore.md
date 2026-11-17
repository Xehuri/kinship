# 备份与恢复手册

> 状态：现行（2026-11-17）。
> 适用：Ubuntu + systemd + 进程编排器的生产部署。
> 本机参考部署的 AI 运行时当前是 dsh（`ai_backend: dsh`）；Loom 相关步骤只在 `ai_backend: loom` 时适用。MOSS watcher 是后端 `moss_watcher` 受管子进程，不再是独立 systemd 单元。
> 相关手册：[部署](deploy-linux.md)、编排器迁移（公开树不包含）、[故障处置](troubleshoot.md)。
> 备份含有账号 token、会话内容和个人音频。备份目录权限必须为 0700，离机副本必须加密。

## 1. 备份对象

核心对象（第 3、4 项按 `ai_backend` 二选一）：

| 对象 | 默认路径 | 内容 | 一致性要求 |
| --- | --- | --- | --- |
| AI 数据 | `ai/data/` | `daily/{date}/perception.jsonl`、音频、`audio_deepdive.jsonl`、`plan/`、`reports/`、`tasks/`、`wake_word/`、`memory` 相关数据 | 写入频繁，必须停机或文件系统快照 |
| 后端配置状态 | `backend/config/` | `auth.json`、`.setup_token`（若存在）；同目录也含代码 | 必须停机；恢复时只取运行时文件 |
| Loom 会话（仅 `ai_backend: loom`） | `ai/.loom/session/` | `{sessionID}.jsonl` 转录分片、`main-session.json`、`wake/`、`wake-queue/`、`queue/`、`compaction/` | Loom 持续写，必须停机 |
| dsh 运行态（仅 `ai_backend: dsh`；本机生产） | `<DSH_HOME>/kinship/` + `<DSH_HOME>/sessions/` | `kinship/binding.json`、`kinship/bridge-token`（0600）、`kinship/paths.json`、`kinship/state/`（唤醒队列/影子文件）；`sessions/` 是 dsh 自己的会话转录 | dsh 持续写，必须停 `axeuh-dsh` |

`<DSH_HOME>` 由 `axeuh-dsh` 单元决定（本机参考部署在项目目录之外）。`kinship/bridge-token` 是凭据，按第 3.4 节加密保存，不要放进普通备份目录。dsh 数据不在项目根下：只备份 `ai/` 而不备份 `<DSH_HOME>/sessions/` 时，恢复后 dsh 会话历史会缺失。

建议同批备份的部署基线：

- 项目根 `config.yaml` 与其侧车备份 `config.yaml.bak-*`，单文件配置，含端口、证书路径、模型开关。
- `/etc/systemd/system/axeuh-health.service` 及 `*.d/*.conf`；`axeuh-dsh`、`axeuh-moss` 的单元与 drop-in。
- `/etc/axeuh-dsh/env`（dsh 的 `KINSHIP_*` 环境变量；不含 token）与 `<DSH_HOME>/profiles/<name>/` 下的 `package.json`、`pnpm-lock.yaml`、`cordis.patch.yml`（`link:` 依赖写在这里，决定桥接插件能否加载）。
- `git rev-parse HEAD` 与 `git status --porcelain` 输出。
- 当前部署的 systemd 单元文件及其 drop-in；通用示例见 `deploy/kinship.service.example`。
- `/etc/kinship-loom/credentials.conf`、`/etc/kinship-qq-gateway/mcp.token`、`/etc/kinship-moss/credentials.conf` 的加密副本。不要放进普通备份目录。

路径以实际配置为准：

```bash
cd /opt/kinship
ROOT=$(pwd)
grep -nE '^(data|  dir|  ai_root)' config.yaml | head
```

默认 `data.dir=ai/data`、`data.ai_root=ai`。如果改过，备份时用实际路径替换本文命令中的 `ai/data`。

## 2. 备份前检查

```bash
STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_ROOT=/opt/kinship-backups
SNAP=$BACKUP_ROOT/$STAMP
install -d -m 0700 "$BACKUP_ROOT" "$SNAP" "$SNAP/ai/.loom" "$SNAP/systemd"

df -h / /mnt/d
du -sh "$ROOT/ai/data" "$ROOT/backend/config" "$ROOT/ai/.loom/session" 2>/dev/null || true
systemctl is-active axeuh-health axeuh-dsh axeuh-moss axeuh-loom axeuh-moss-watch
systemctl list-timers 'axeuh-moss-*' --no-pager
```

- 备份盘剩余空间至少是本次纳入对象大小之和的 1.2 倍。
- 记录当前 `git HEAD` 与 unit 内容，恢复后用于核对版本。
- 预期状态：`axeuh-health`、`axeuh-moss` active；`ai_backend: dsh` 时 `axeuh-dsh` active；`axeuh-loom`、`axeuh-moss-watch` 应为 `inactive`/`failed` 且 `disabled`（仅回滚/旧拓扑用）。MOSS 回归与告警 timer 为 oneshot，可能排在待执行队列里。
- 如果 `ai/.loom/session` 不存在而 `ai_backend: loom`，记录 `session_dir=absent`。这通常表示 Loom 尚未产生会话或 `LOOM_STATE` 指向了别处，不能当作"备份成功"。`ai_backend: dsh` 时对应检查 `<DSH_HOME>/sessions/`；不存在但 `/health` 的 dsh 为 bound 时，说明 `DSH_HOME` 指错了。

## 3. 一致性备份（推荐，停机）

### 3.1 停止写入

```bash
# 可选：备份期间让 MOSS 回归/告警 oneshot 任务避开（不影响主链）
sudo systemctl stop axeuh-moss-alert.timer axeuh-moss-regression.timer 2>/dev/null || true

# AI 运行时：只有备份 <DSH_HOME> 时停 dsh（独立单元，不归后端编排器）
sudo systemctl stop axeuh-dsh 2>/dev/null || true

# 停后端：编排器按注册逆序停止子服务（loom -> moss_watcher -> kernel）
sudo systemctl stop axeuh-health
```

顺序说明：

- dsh 是独立 systemd 单元，`ai_backend: dsh` 时由它托管 bridge 与会话写入；要一致的 dsh 会话/桥接备份就必须停它。`ai_backend: loom` 时不需要这一步。
- 后端关停时由编排器按注册逆序停止子服务：`loom`（仅 loom 模式）→ `moss_watcher` → `kernel`，总预算 15 秒；watcher 是后端子进程，随 `axeuh-health` 一起停，**没有独立的 `axeuh-moss-watch` 单元参与稳定态关停**。
- 不要再去停 `axeuh-loom` / `axeuh-moss-watch`：稳定态它们本就 `inactive`/`disabled`；如果它们是 active，说明拓扑异常（见[故障处置](troubleshoot.md)），先按故障处理再备份。
- `axeuh-moss`（vLLM serve）不读写 `ai/data`，备份期间可以保留运行。

确认没有写入者：

```bash
systemctl is-active axeuh-health axeuh-dsh axeuh-loom axeuh-moss-watch
ps -eo pid,ppid,args | grep -E '[h]ot_server|[l]oom-harness|[m]oss-shadow/watcher|[b]in/dsh ' || true
```

`is-active` 中 `axeuh-health` 与（dsh 模式下的）`axeuh-dsh` 应为 `inactive`/`failed`；`axeuh-loom`、`axeuh-moss-watch` 本来就是 `inactive`/`failed`。`ps` 不应再有 `hot_server`、Loom、watcher 或 dsh 进程。仍有进程时先按[故障处置](troubleshoot.md)的 PID 流程处理，不要直接复制。

### 3.2 复制

```bash
rsync -aH --numeric-ids \
  --exclude 'tmp/' --exclude '*.part' \
  "$ROOT/ai/data/" "$SNAP/ai/data/"

rsync -aH --numeric-ids "$ROOT/backend/config/" "$SNAP/backend/config/"

if [ -d "$ROOT/ai/.loom/session" ]; then
  rsync -aH --numeric-ids "$ROOT/ai/.loom/session/" "$SNAP/ai/.loom/session/"
else
  echo "WARN: ai/.loom/session 不存在（ai_backend=loom 时才需要）" | tee "$SNAP/session-dir-absent.txt"
fi

# ai_backend: dsh 时备份 dsh 运行态（<DSH_HOME> 由 axeuh-dsh 单元决定）
if [ -n "${DSH_HOME:-}" ] && [ -d "$DSH_HOME/sessions" ]; then
  install -d -m 0700 "$SNAP/dsh"
  rsync -aH --numeric-ids "$DSH_HOME/kinship/" "$SNAP/dsh/kinship/"
  rsync -aH --numeric-ids "$DSH_HOME/sessions/" "$SNAP/dsh/sessions/"
  for prof in "$DSH_HOME/profiles"/*/; do
    [ -d "$prof" ] || continue
    name=$(basename "$prof")
    install -d -m 0700 "$SNAP/dsh/profiles/$name"
    cp -a "$prof/package.json" "$prof/pnpm-lock.yaml" "$prof/cordis.patch.yml" \
      "$SNAP/dsh/profiles/$name/" 2>/dev/null || true
  done
fi

cp -a "$ROOT/config.yaml" "$SNAP/config.yaml"
[ -f "$ROOT/ai/.loom/config.yaml" ] && cp -a "$ROOT/ai/.loom/config.yaml" "$SNAP/ai/.loom/config.yaml"

systemctl cat axeuh-health > "$SNAP/systemd/axeuh-health.service"
systemctl cat axeuh-dsh > "$SNAP/systemd/axeuh-dsh.service" 2>/dev/null || true
systemctl cat axeuh-moss > "$SNAP/systemd/axeuh-moss.service" 2>/dev/null || true
systemctl cat axeuh-moss-alert.service > "$SNAP/systemd/axeuh-moss-alert.service" 2>/dev/null || true
systemctl cat axeuh-moss-alert.timer   > "$SNAP/systemd/axeuh-moss-alert.timer" 2>/dev/null || true
systemctl cat axeuh-moss-regression.service > "$SNAP/systemd/axeuh-moss-regression.service" 2>/dev/null || true
systemctl cat axeuh-moss-regression.timer   > "$SNAP/systemd/axeuh-moss-regression.timer" 2>/dev/null || true
# 回滚/旧拓扑单元：内容也留着，恢复时不要随手启用
systemctl cat axeuh-loom > "$SNAP/systemd/axeuh-loom.service" 2>/dev/null || true
systemctl cat axeuh-moss-watch > "$SNAP/systemd/axeuh-moss-watch.service" 2>/dev/null || true
[ -f /etc/axeuh-dsh/env ] && cp -a /etc/axeuh-dsh/env "$SNAP/systemd/axeuh-dsh.env"
git -C "$ROOT" rev-parse HEAD > "$SNAP/git-head.txt"
git -C "$ROOT" status --porcelain > "$SNAP/git-status.txt"
```

`ai/data/tmp/` 是可再生临时目录，默认排除。`*.part` 是未完成文件，不进入备份。`axeuh-moss-watch` 是旧拓扑遗留单元，**不要**把它当稳定态组件恢复或启用；稳定态 watcher 由后端编排器 spawn。

### 3.3 清单与校验

```bash
(
  cd "$SNAP"
  find . -type f -printf '%P\t%s\n' | LC_ALL=C sort > MANIFEST.tsv
  sha256sum config.yaml ai/.loom/config.yaml backend/config/auth.json 2>/dev/null > CRITICAL.sha256 || true
)

du -sh "$SNAP"
wc -l "$SNAP/MANIFEST.tsv"
```

检查 JSON 与 JSONL 可解析：

```bash
python3 - "$SNAP" <<'PY'
import json, pathlib, sys
root = pathlib.Path(sys.argv[1])
bad = []
for p in root.rglob("*.json"):
    try:
        json.loads(p.read_text(encoding="utf-8"))
    except Exception as exc:
        bad.append((str(p), 1, str(exc)))
for p in root.rglob("*.jsonl"):
    with p.open(encoding="utf-8", errors="replace") as fh:
        for i, line in enumerate(fh, 1):
            if not line.strip():
                continue
            try:
                json.loads(line)
            except Exception as exc:
                bad.append((str(p), i, str(exc)))
if bad:
    for item in bad[:20]:
        print("BAD", item)
    raise SystemExit(1)
print("json/jsonl ok")
PY
```

校验复制结果：

```bash
rsync -aHn --delete --itemize-changes "$ROOT/ai/data/" "$SNAP/ai/data/"
rsync -aHn --itemize-changes "$ROOT/backend/config/" "$SNAP/backend/config/"
rsync -aHn --itemize-changes "$ROOT/ai/.loom/session/" "$SNAP/ai/.loom/session/" 2>/dev/null || true
```

`rsync -n` 只演练，不写目标。输出为空表示备份与源一致。`--delete` 在 `-n` 下不会删除任何文件，只用于比较。

### 3.4 加密、离机与保留

- 本地 `$SNAP` 权限 0700。`backend/config` 与 Loom 会话包含凭据或隐私，不能放在共享目录。
- 离机副本先加密：

  ```bash
  tar -C "$BACKUP_ROOT" -czf - "$STAMP" | age -p > "$STAMP.tar.gz.age"
  ```

  没有 `age` 时用组织批准的加密工具。不要把明文备份上传到对象存储或 git。

- 保留策略建议：最近 7 天每日一份，最近 4 周每周一份，最近 3 个月每月一份。迁移前、升级前各加一份永久保留，直到下一次成功恢复演练。
- 备份不是归档。`ai/data` 的音频原件如果需要长期保留，按日期冷归档，不要只依赖每日备份轮转。

## 4. 在线备份（不推荐用于配置和会话）

`ai/data` 可以在线做一次 rsync，再用第二次增量补齐；但 `perception.jsonl`、`audio_deepdive.jsonl` 与音频文件可能跨文件不一致。`backend/config/auth.json`、`ai/.loom/session`（loom 模式）与 `<DSH_HOME>/sessions`（dsh 模式）必须停机备份。

如果必须在线：

```bash
rsync -aH --numeric-ids "$ROOT/ai/data/" "$SNAP/ai/data/"
sleep 60
rsync -aH --numeric-ids "$ROOT/ai/data/" "$SNAP/ai/data/"
```

最终一致性仍不如停机备份。恢复前必须用第 3.3 节的 JSON/JSONL 校验，并接受最后几十秒的数据可能缺失或截断。生产配置和会话不要用在线方式。

## 5. 恢复顺序

恢复顺序固定为：配置基线、后端配置状态、AI 数据、AI 运行时会话（Loom 或 dsh，按 `ai_backend`）、启动、验证。

先准备回退副本。恢复失败时用它回到恢复前状态：

```bash
ASIDE=$BACKUP_ROOT/pre-restore-$(date +%Y%m%d-%H%M%S)
install -d -m 0700 "$ASIDE"
cp -a "$ROOT/config.yaml" "$ASIDE/config.yaml"
```

### 5.1 停止服务并确认没有写入者

```bash
sudo systemctl stop axeuh-dsh 2>/dev/null || true   # 仅 dsh 模式；独立单元
sudo systemctl stop axeuh-health
systemctl is-active axeuh-health axeuh-dsh axeuh-loom axeuh-moss-watch
```

`axeuh-health`（以及 dsh 模式下的 `axeuh-dsh`）应为 `inactive`/`failed`。`axeuh-loom`、`axeuh-moss-watch` 本就是回滚/旧拓扑单元，不要在这里启动它们。

### 5.2 恢复配置基线

如果备份里带 `config.yaml`，最先恢复它。端口、数据路径、证书路径决定后续目录是否正确。

```bash
cp -a "$SNAP/config.yaml" "$ROOT/config.yaml"
chmod 600 "$ROOT/config.yaml"
```

如果备份里带 systemd unit，只有在你确认要回到备份时的部署版本时才恢复：

```bash
sudo install -m 0644 "$SNAP/systemd/axeuh-health.service" /etc/systemd/system/axeuh-health.service
sudo systemctl daemon-reload
```

不要用旧备份的 `backend/config/*.py` 覆盖当前代码。`backend/config/` 同时包含源码与运行时状态，整目录覆盖会造成代码回退。

### 5.3 恢复后端配置状态

只恢复运行时文件：

```bash
for f in auth.json .setup_token; do
  if [ -f "$SNAP/backend/config/$f" ]; then
    [ -f "$ROOT/backend/config/$f" ] && mv "$ROOT/backend/config/$f" "$ASIDE/$f"
    cp -a "$SNAP/backend/config/$f" "$ROOT/backend/config/$f"
    chmod 600 "$ROOT/backend/config/$f"
  fi
done
```

如果这是一次同版本的整机灾难恢复，并且备份里的 `git-head.txt` 与当前检出完全一致，才可以整目录恢复 `backend/config/`。否则只恢复 `auth.json` 与 `.setup_token`，避免把代码回退到旧版本。

`auth.json` 缺失时，管理员账号、token、设备注册会全部丢失。恢复后立即用 `stat` 核对权限：

```bash
stat -c '%a %U:%G %n' "$ROOT/backend/config/auth.json"
```

### 5.4 恢复 AI 数据

```bash
mv "$ROOT/ai/data" "$ASIDE/ai-data"
install -d -m 0755 "$ROOT/ai/data"
rsync -aH --numeric-ids --exclude 'tmp/' --exclude '*.part' \
  "$SNAP/ai/data/" "$ROOT/ai/data/"
```

`mv` 而不是删除，保证恢复失败时可以回退。`ai/data` 可能很大，`mv` 在同一文件系统内是原子的；跨文件系统时会复制，时间会更长。

### 5.5 恢复 Loom 会话（仅 `ai_backend: loom`）

```bash
install -d -m 0700 "$ROOT/ai/.loom"
if [ -d "$SNAP/ai/.loom/session" ]; then
  [ -d "$ROOT/ai/.loom/session" ] && mv "$ROOT/ai/.loom/session" "$ASIDE/loom-session"
  install -d -m 0700 "$ROOT/ai/.loom/session"
  rsync -aH --numeric-ids "$SNAP/ai/.loom/session/" "$ROOT/ai/.loom/session/"
else
  echo "WARN: 备份没有 ai/.loom/session"
fi

if [ -f "$SNAP/ai/.loom/config.yaml" ]; then
  cp -a "$SNAP/ai/.loom/config.yaml" "$ROOT/ai/.loom/config.yaml"
  chmod 600 "$ROOT/ai/.loom/config.yaml"
fi
```

恢复后检查 `main-session.json` 与 `wake-queue/` 是否存在。`main-session.json` 决定 Web 聊天绑定哪个主会话；缺失时 Loom 可能新建会话，表现为"历史会话不见了"。

### 5.6 恢复 dsh 运行态（仅 `ai_backend: dsh`；本机生产）

dsh 的数据不在项目根下。`<DSH_HOME>` 要与 `axeuh-dsh` 单元的 `Environment=` / `EnvironmentFile=` 一致；路径不对时恢复会"成功"但面板仍显示未绑定。下面命令要求先在 shell 里 `export DSH_HOME=<实际路径>`。

```bash
if [ -d "$SNAP/dsh" ]; then
  install -d -m 0700 "$DSH_HOME"
  for sub in kinship sessions; do
    [ -d "$SNAP/dsh/$sub" ] || continue
    [ -e "$DSH_HOME/$sub" ] && mv "$DSH_HOME/$sub" "$ASIDE/dsh-$sub"
    install -d -m 0700 "$DSH_HOME/$sub"
    rsync -aH --numeric-ids "$SNAP/dsh/$sub/" "$DSH_HOME/$sub/"
  done
  chmod 600 "$DSH_HOME/kinship/bridge-token" 2>/dev/null || true
fi
```

profile 的 `package.json` / `pnpm-lock.yaml` / `cordis.patch.yml` 属于部署接线：只有在确认要回到备份时的插件版本时才覆盖，覆盖前先备份当前三件套。`link:` 依赖指向仓库路径，仓库挪位后要重新 `dsh plugin ... add link:...`（见 [dsh-production-rollout.md](dsh-production-rollout.md) 第 9 节）。

如果不想重放备份时点的计划唤醒，恢复前先移走 `<DSH_HOME>/kinship/state/session/wake-queue/`，让 `kinship-plan-scheduler` 启动后重新对账；`binding.json` 与 `sessions/` 仍按上面恢复。

### 5.7 启动

稳定态（stage4 之后）：

```bash
# dsh 模式：先起 dsh，让 bridge 在链路里，再起后端
sudo systemctl start axeuh-dsh
sudo systemctl start axeuh-health
```

编排器会按 `kernel`、`moss_watcher`、`loom` 顺序启动；`loom` 只在 `ai_backend: loom` 时进入 ready，`ai_backend: dsh` 时它是 `blocked (disabled)`，属预期。`axeuh-loom` 与 `axeuh-moss-watch` 必须保持 `inactive`、`disabled`，不要手工启动。

按需恢复备份期间停掉的 MOSS 定时器：

```bash
sudo systemctl start axeuh-moss-alert.timer axeuh-moss-regression.timer
```

迁移前或回滚态：

```bash
sudo systemctl start axeuh-health
sudo systemctl start axeuh-moss-watch axeuh-loom
```

只有在 ExecStart 是 `launcher.py`、`AXEUH_ORCHESTRATOR=off` 的拓扑下才这样做。稳定态启动这两个单元会与 child 抢端口或双订阅。

## 6. 恢复后验证

### 6.1 服务与端口

```bash
systemctl is-active axeuh-health axeuh-dsh axeuh-moss
systemctl is-active axeuh-loom axeuh-moss-watch   # 稳定态应为 inactive/failed
ss -lntp | grep -E ':(8768|18765|3080|5100|8100)\b'
curl -kfsS https://127.0.0.1:8768/health
```

`18765`（bridge）与 `3080`（dsh Web）只在 `ai_backend: dsh` 时存在，监听者属于 `axeuh-dsh`；`5100` 只在 `ai_backend: loom` 时存在。MOSS watcher 没有端口，用 `/api/services` 的 `moss_watcher=ready` 判断。

`/api/services` 需要 user token：

```bash
api_get() {
  local path=$1
  printf 'header = "Authorization: Bearer %s"\n' "${AXEUH_API_TOKEN:?先 export AXEUH_API_TOKEN}" |
    curl -kfsS -K - "https://127.0.0.1:8768${path}"
}
api_get /api/services
```

稳定态期望 `orchestrator=on`，`kernel` 与 `moss_watcher` 为 `ready`；`loom` 在 `ai_backend: loom` 时应为 `ready`，在 `ai_backend: dsh` 时为 `blocked (disabled)`（预期，不是故障）。迁移前拓扑期望 `orchestrator=off`，`services=[]`。

### 6.2 AI 运行时会话

`ai_backend: dsh`（本机生产）：

```bash
curl -sk https://127.0.0.1:8768/health   # 期望 status=healthy、ai_backend=dsh、dsh.status=online
TOKEN=$(cat <DSH_HOME>/kinship/bridge-token)
printf 'header = "Authorization: Bearer %s"\n' "$TOKEN" |
  curl -fsS -K - http://127.0.0.1:18765/v1/health
```

期望 bridge 返回 `status=bound`，`session_id` 与恢复的 `kinship/binding.json` 及 `/health` 的 `dsh.session_id` 一致。`status=unbound` 表示绑定记录丢失；`409 bound_session_missing` / `bound_session_unavailable` 表示 dsh 里找不到或恢复不了该会话，按 [troubleshoot.md](troubleshoot.md) 的 dsh 症状处理。

`ai_backend: loom`：

```bash
printf 'header = "Authorization: Bearer %s"\n' "${LOOM_TOKEN:?先 export LOOM_TOKEN}" |
  curl -fsS -K - http://127.0.0.1:5100/sessions/main
```

期望返回单一主会话对象，`sessionID` 与恢复的 `main-session.json` 一致。返回 503 `main_session_unavailable` 表示 Loom 启动了但没有解析到主会话，检查 `main-session.json` 与 `server.mainSessionId` 配置。

### 6.3 数据完整性

```bash
TODAY=$(date +%F)
wc -l "$ROOT/ai/data/daily/$TODAY/perception.jsonl" 2>/dev/null || true
wc -l "$ROOT/ai/data/daily/$TODAY/audio_deepdive.jsonl" 2>/dev/null || true

rsync -aHn --itemize-changes "$SNAP/ai/data/" "$ROOT/ai/data/" | head
```

`rsync -n` 输出为空表示恢复后的数据与备份一致。再跑一次第 3.3 节的 JSON/JSONL 校验，目标改为 `$ROOT/ai/data` 与 `$ROOT/ai/.loom/session`。

### 6.4 凭据与权限

```bash
stat -c '%a %U:%G %n' \
  "$ROOT/backend/config/auth.json" \
  "$ROOT/ai/.loom/config.yaml" \
  "$ROOT/backend/config/.setup_token" 2>/dev/null || true

api_get /api/services
```

能用 user token 调通 `/api/services`，说明 `auth.json` 恢复正确。登录失败时不要反复重试，先核对 `auth.json` 的权限与备份时间。

### 6.5 进程唯一性

```bash
ps -eo pid,ppid,args | grep -E '[h]ot_server|[l]oom-harness/packages/server/dist/cli.js|[m]oss-shadow/watcher|[b]in/dsh ' || true
```

- 后端 1 个。
- dsh 1 个（`ai_backend: dsh` 时），父进程是 systemd `axeuh-dsh`（不是后端 `MainPID`）。
- Loom 1 个（仅 `ai_backend: loom`），父进程是后端 `MainPID`。
- MOSS watcher 1 个，父进程是后端 `MainPID`；不应同时存在 `axeuh-moss-watch` 单元进程。

出现两个 Loom、两个 watcher 或两个 dsh，按[故障处置](troubleshoot.md)处理，不要直接结束不确定归属的进程。

## 7. 恢复失败的回退

任何一项验证失败，按以下顺序回到恢复前状态：

```bash
sudo systemctl stop axeuh-health
sudo systemctl stop axeuh-dsh 2>/dev/null || true

mv "$ROOT/ai/data" "$ASIDE/ai-data-restored-failed"
mv "$ASIDE/ai-data" "$ROOT/ai/data"

if [ -d "$ASIDE/loom-session" ]; then
  mv "$ROOT/ai/.loom/session" "$ASIDE/loom-session-restored-failed"
  mv "$ASIDE/loom-session" "$ROOT/ai/.loom/session"
fi

for sub in kinship sessions; do
  if [ -n "${DSH_HOME:-}" ] && [ -d "$ASIDE/dsh-$sub" ]; then
    mv "$DSH_HOME/$sub" "$ASIDE/dsh-$sub-restored-failed" 2>/dev/null || true
    mv "$ASIDE/dsh-$sub" "$DSH_HOME/$sub"
  fi
done

[ -f "$ASIDE/config.yaml" ] && cp -a "$ASIDE/config.yaml" "$ROOT/config.yaml"

for f in auth.json .setup_token; do
  [ -f "$ASIDE/$f" ] && cp -a "$ASIDE/$f" "$ROOT/backend/config/$f"
done

sudo systemctl start axeuh-dsh 2>/dev/null || true
sudo systemctl start axeuh-health
curl -kfsS https://127.0.0.1:8768/health
```

回退后重新执行第 6 节验证。不要删除 `$ASIDE`，直到确认生产稳定并完成下一次备份。

## 8. 演练与保留

- 每季度做一次恢复演练。演练在 staging 根进行，设置 `AXEUH_PROJECT_ROOT` 指向隔离目录，不要在生产 `$ROOT` 上试。
- 每次迁移前、升级前各做一次完整停机备份，保留到迁移后观察期结束。
- 每次恢复演练记录：备份时间、恢复耗时、验证结果、发现的问题。目标 RTO 为 30 分钟内恢复后端与 Loom 主会话。
- 备份中如果包含 `config.yaml` 或凭据，离机副本必须加密。备份恢复后立即核对权限，避免凭据被其他用户读取。

## 9. 禁止恢复项

| 项目 | 原因 |
| --- | --- |
| `backend/data/kernel_state/kernel.pid` | 旧 pid 会触发 `stale_kernel_detected`；内核应由后端重新 spawn |
| `backend/data/loom*` 的运行时 pidfile | 进程归属会错乱 |
| `backend/config/*.py`、`backend/config/config_schema.py` | 会把代码回退到备份时的版本，与当前后端不匹配 |
| `frontend/mobile/dist/` | 构建产物，按当前代码重新构建 |
| `/opt/venvs/*`、`node_modules/`、`kernel/dist/` | 可再生，且体积大；按部署手册重建 |
| `ai/data/tmp/`、`*.part` | 临时文件，可能截断或不完整 |
| `*.log` 的在线副本 | 日志不是状态真源；需要时另行归档 |

`audio_deepdive.jsonl` 与 `perception.jsonl` 属于数据，不属于禁止项。恢复时保持原样，不要为了"对齐"而截断或重写。
