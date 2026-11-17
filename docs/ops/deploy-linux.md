# Linux / systemd 部署手册

> 状态：现行（2026-10-29，进程编排器迁移后）。
> 适用：Ubuntu 22.04 及以上，systemd，单机部署。
> 相关手册：[启动与初始化](STARTUP.md)、编排器迁移（公开树不包含）、[故障处置](troubleshoot.md)、[备份与恢复](backup-restore.md)。
> 本文只描述目标拓扑；从旧拓扑切换的四阶段步骤见迁移手册，不要按本文直接重启生产来"完成迁移"。
> 公开模板的开发启动见 [STARTUP.md](STARTUP.md)，生产部署从 [deploy/kinship.service.example](../../deploy/kinship.service.example) 开始。本文其余章节记录作者生产环境的 `axeuh-*` 单元、`/opt/kinship` 路径和私有端口，属于参考实现，不是通用要求。

## 1. 运行模型

### 1.1 单端口后端

后端只有一个 HTTP 监听入口：`server.port`，生产为 `8768`。`ssl.enabled` 为真且证书、私钥都存在时，同一个端口以 HTTPS 提供服务；否则同一端口降级为 HTTP。历史上拆分过的 `http_port` 8769 已退役，不再监听，也不应作为回退入口。

对外链路：

```text
Android App / PC Sensor
  -> https://<domain>:8768          frpc 8768 -> 本机 8768，后端 TLS
浏览器
  -> https://<domain>               frpc 443 -> 本机 Caddy 443
  -> https://<domain>:8443          本机 IPv6 直连 Caddy 8443
Caddy 443/8443
  -> https://127.0.0.1:8768         跳过上游证书校验
```

### 1.2 编排器模型

`axeuh-health` 是唯一的监督进程。systemd 直接运行 `core.hot_server`，后端在同一个进程树里管理子服务。`ai_backend: loom` 与 `ai_backend: dsh` 是两种不同拓扑：Loom 由编排器托管，dsh 是独立 systemd 单元、不归编排器。

```text
axeuh-health.service (systemd)
  └─ python -m core.hot_server                     后端 API，8768
       ├─ python -m axeuh_kernel --port 0          音频内核，127.0.0.1 动态端口，pidfile 归属
       ├─ python -m services.orchestrator.child_entry
       │    └─ python tools/moss-shadow/watcher.py --loop --data-root <DATA_DIR>
       │       MOSS watcher，纯 CPU 旁路（moss.enabled=true 时）
       └─ python -m services.orchestrator.child_entry
            └─ node packages/server/dist/cli.js serve
               Loom，127.0.0.1:5100（仅 ai_backend=loom 时）

axeuh-dsh.service (systemd)                        ai_backend=dsh 时（本机生产）
  └─ node <node>/bin/dsh --profile <profile>
       └─ kinship-bridge 127.0.0.1:18765 + dsh Web 127.0.0.1:3080
```

外部仍有独立的 GPU 推理单元 `axeuh-moss.service`（vLLM，`127.0.0.1:8100`）和边缘入口 `caddy`、`frpc`。Loom 与 MOSS watcher 的 systemd 单元（`axeuh-loom`、`axeuh-moss-watch`）只保留给迁移前状态和回滚，稳定态必须处于 `inactive` 且 `disabled`。`axeuh-moss-watch` 不再参与稳定态：watcher 是后端子进程。

子服务由编排器按固定顺序注册：`kernel`、`moss_watcher`、`loom`。关停时按注册逆序停止，即 `loom`、`moss_watcher`、`kernel`，总预算 15 秒，内核保留至少 3 秒 SIGTERM 窗口；watcher 的停止语义是 SIGTERM 后最多等 30 秒，再按精确 PID SIGKILL。

### 1.3 稳定态与迁移态

| 项目 | 迁移前 / 回滚态 | 稳定态（stage4 之后） |
| --- | --- | --- |
| `axeuh-health` ExecStart | `launcher.py`（已退役，仅迁移回滚） | `python -m core.hot_server` |
| `AXEUH_ORCHESTRATOR` | 未设置或 `off` | `on` |
| `AXEUH_LOOM_MODE` | 未设置（systemd 托管） | `child` |
| `axeuh-loom` | `active`、`enabled` | `inactive`、`disabled` |
| `axeuh-moss-watch` | `active`、`enabled` | `inactive`、`disabled` |
| 内核 | 后端首次请求时懒启动 | 编排器在 `start_all()` 中拉起 |
| Loom 父进程 | systemd | `core.hot_server`（仅 `ai_backend: loom`） |
| MOSS watcher 父进程 | systemd | `core.hot_server` |
| dsh bridge 父进程 | —— | systemd `axeuh-dsh`（`ai_backend: dsh`，不归编排器） |

本机生产（2026-11-17）是 `ai_backend: dsh`：`axeuh-loom` 为 `failed`/`disabled`、`5100` 无监听、编排器 `loom=blocked (disabled)`；`axeuh-dsh` active，`18765`/`3080` 可用。表中 Loom 行描述 `ai_backend: loom` 的拓扑，不要按它去启动 `axeuh-loom`。

## 2. systemd 单元

### 2.1 `axeuh-health`

作者生产环境的单元不在公开树中；公开示例是 `deploy/kinship.service.example`。下面是 2026-11 迁移后的生产关键字段形状（公开示例仍用 `/opt/kinship` + `.venv` 占位，按本节改）：

```ini
[Service]
Type=simple
User=<service-user>
WorkingDirectory=<project>/backend
EnvironmentFile=/etc/kinship-loom/credentials.conf
Environment=AXEUH_KERNEL_PYTHON=/opt/venvs/axeuh-kernel/bin/python
Environment=AXEUH_LOOM_MODE=child
Environment=AXEUH_ORCHESTRATOR=on
ExecStart=/opt/venvs/axeuh-health/bin/python -m core.hot_server
Restart=always
RestartSec=5
```

`CONFIG_PATH`、`AXEUH_CONFIG_PATH`、`AXEUH_PROJECT_ROOT`、`AXEUH_DATA_ROOT`、`AXEUH_MODELS_DIR`、`AXEUH_AUTH_STATE_DIR`、`AXEUH_KERNEL_STATE_DIR` 通常由主机级 drop-in（如 `20-kinship-data.conf`）注入，不要写进公开示例。

安装：

```bash
cd /opt/kinship
sudo install -m 0644 deploy/kinship.service.example /etc/systemd/system/kinship.service
sudo systemctl daemon-reload
systemd-analyze verify /etc/systemd/system/kinship.service
```

注意：unit 的 `WorkingDirectory` 固定指向主检出。即从 worktree 安装 unit，运行的仍是主检出里的代码。部署新代码必须按迁移手册把代码放进主检出，不能只改 worktree。

公开示例 `deploy/kinship.service.example` 里的 `/opt/kinship`、`.venv-health` / `.venv-kernel`、`User=kinship` 都是新装占位。2026-11 迁移后的本机生产实例已改为 `/opt/venvs/axeuh-health/bin/python -m core.hot_server`、`AXEUH_KERNEL_PYTHON=/opt/venvs/axeuh-kernel/bin/python`、`/opt/venvs/axeuh-moss`，服务用户为 `xehuri`，`CONFIG_PATH` / `AXEUH_DATA_ROOT` / `AXEUH_CONFIG_PATH` 等由主机级 drop-in 注入；`EnvironmentFile=/etc/axeuh-loom/credentials.conf` 在 `ai_backend: dsh` 时仍保留（文件缺失会让单元启动失败，因为 `EnvironmentFile=` 没有前导 `-`）。示例文件本身尚未同步这些差异，按实际路径改，不要直接拷。

主机级 drop-in `/etc/systemd/system/axeuh-health.service.d/10-p2p.conf` 属于实验 P2P，当前不可用；不要部署或启用。

### 2.2 `axeuh-loom`（仅迁移期与回滚）

`ai_backend: loom` 时稳定态由后端以 child 模式托管，systemd 单元只用于迁移前和回滚；`ai_backend: dsh` 时 Loom 不运行（本机生产即此），单元保持 `disabled`、非 active：

- 监听 `127.0.0.1:5100`。
- `TimeoutStopSec=15`，Loom 自身排水约 5 秒。
- `Restart=always`。
- 凭据来自 `/etc/kinship-loom/credentials.conf`，权限 `root:kinship 0640`。

迁移 stage3.0 重启后端后，编排器尝试启动 Loom child，此时 systemd Loom 仍占用 5100，child 必须失败在 `port_in_use`。这是正向证据，不是故障。stage3.3 先 `disable --now axeuh-loom`，再 `resume loom`。

稳定态如果发现 `axeuh-loom` 仍为 `active`，按双实例风险处理，见[故障处置](troubleshoot.md)的 Loom 条目。不要直接 `systemctl start axeuh-loom` 来"修"child 启动失败；`ai_backend: dsh` 下也不需要它。

### 2.3 `axeuh-moss` 与 `axeuh-moss-watch`

| 单元 | 职责 | 稳定态 | 说明 |
| --- | --- | --- | --- |
| `axeuh-moss` | vLLM MOSS serve，`:8100` | `active` | GPU 卡 2，fp8，`--max-num-seqs 1` 串行化；MOSS 必须独占整张卡；不归编排器 |
| `axeuh-moss-watch` | 旧拓扑的文件订阅 watcher | `inactive`、`disabled` | 迁移 stage2 停用；stage3 起 watcher 由编排器 `moss_watcher` spec 作为后端子进程 spawn，**不要再启用本单元** |

`axeuh-moss` 不读写 `ai/data`，不参与主链。watcher（无论由谁托管）只旁路追加 `ai/data/daily/{date}/audio_deepdive.jsonl`，不改 `perception.jsonl`。watcher 的启动条件：

- 有效配置 `moss.enabled=true`。默认是 `false`，生产 `config.yaml` 可能没有该键。
- `moss.python` 可执行；生产为 `/opt/venvs/axeuh-moss/bin/python`。为空时代码兜底探测 `/opt/kinship/.venv-moss/bin/python`、`<repo>/.venv-moss/bin/python`（新装占位，生产不要依赖）。
- 编排器 spawn 的参数是 `watcher.py --loop --data-root <cfg.MOSS_DATA_ROOT 或 DATA_DIR>`；`moss.state_dir` 非空时追加 `--state-root`。仓库参考件在 `tools/moss-shadow/systemd/`；旧装机件可能不同，以 `systemctl show -p Environment axeuh-moss` 为准。

仓库参考 unit 带 `AXEUH_MOSS_HOST=127.0.0.1`，但 2026-10-22 实测生产曾监听 `0.0.0.0:8100`。每次部署后用 `ss -lntp` 核对；`8100` 无鉴权，不能裸露到公网。

### 2.4 依赖关系

| 单元 | 启动依赖 | 运行依赖 | 验证 |
| --- | --- | --- | --- |
| `axeuh-health` | `network-online.target` | `config.yaml`、`backend/config/auth.json`、`/etc/kinship-loom/credentials.conf`、`/opt/venvs/axeuh-health` | `/health` 200 |
| 内核 child | 后端服务面启动 | `AXEUH_KERNEL_PYTHON` 指向 `/opt/venvs/axeuh-kernel/bin/python`，内核模型按三级链可解析 | pidfile 的端口 `/v1/health` 200 |
| Loom child | 内核与 MOSS 注册之后 | `node` 在 PATH、`loom-harness/packages/server/dist/cli.js`、`ai/.loom/config.yaml`、`LOOM_TOKEN`、`loom.url` 为回环 | `/health` 200，父进程是 `core.hot_server`（仅 `ai_backend: loom`） |
| dsh bridge（`ai_backend: dsh`） | `axeuh-dsh` 单元启动 | profile 已装 `kinship-harness-plugins` 且为 `link:` 依赖、`<DSH_HOME>/kinship/bridge-token` 可读、`KINSHIP_BRIDGE_PORT=18765` | `ss` 18765 监听、`/v1/health` 为 `bound`、后端 `/health.dsh=online` |
| MOSS watcher child | `moss.enabled=true` | `/opt/venvs/axeuh-moss`、`axeuh-moss` 的 `:8100` 可达 | `/api/services` 中 `moss_watcher=ready` |
| `axeuh-moss` | `network-online.target` | 卡 2 空闲、vLLM 权重、`/etc/kinship-moss/credentials.conf`（可选） | `/v1/models` 200 |
| `caddy` / `frpc` | 网络 | 证书、DNS、`config.yaml` 的 SSL 证书路径 | 公网 `/health` 与 `/mobile/` |

## 3. 首次部署

### 3.1 系统前置

```bash
id kinship
command -v python3 node npm rsync systemctl
df -h / /mnt/d
```

Python 环境（2026-11 起的生产布局）：

```bash
sudo python3 -m venv /opt/venvs/axeuh-health
sudo /opt/venvs/axeuh-health/bin/pip install -r backend/requirements.txt
sudo python3 -m venv /opt/venvs/axeuh-kernel
sudo python3 -m venv /opt/venvs/axeuh-moss
```

首次引导的 `kernel` 步会在 `<repo>/.venv-kernel` 建内核 venv（代码既有行为）；生产实例把 `AXEUH_KERNEL_PYTHON` / `kernel.python` 指向 `/opt/venvs/axeuh-kernel/bin/python`、`moss.python` 指向 `/opt/venvs/axeuh-moss/bin/python`，所以实际不再使用 `<repo>/.venv-kernel`。旧 `/opt/kinship/.venv-*` 布局已不存在，不要按它写 unit。

内核依赖由首次引导的第 4 步 `kernel` 自动构建。手动安装时必须先装 torch，再 `pip install -e kernel/`，顺序不可反；否则 funasr 会先把 CPU torch 拉一遍。磁盘守卫要求 CPU 路径至少 8 GiB、CUDA 路径至少 12 GiB。MOSS 的 vLLM 与 watcher 依赖按 `docs/moss-8g-deploy/README.md` 安装。首次引导的 `kernel_models` 步只写 `models.dir`，不搬运模型。

前端：

```bash
cd frontend/mobile
npm ci
npm run build:atomic
npm run verify:dist
```

`dist/` 不入 git。没有 `frontend/mobile/dist/index.html` 时 `/mobile/` 会 404，但 API 仍可用。

Android 客户端，必须在仓库根执行，`app/` 内没有 `gradlew`：

```bash
./gradlew :app:assembleDebug
# 输出 app/build/outputs/apk/debug/app-debug.apk
```

要求 JDK 17、Android SDK 36，构建机可访问 JitPack。App 的 `network_security_config.xml` 只信任系统证书，生产必须使用 CA 证书；自签证书不能靠浏览器接受一次解决。

PC 采集器运行在 Windows，后端仍在 Ubuntu：

```bat
cd desktop\pc-sensor
pip install -r requirements.txt
pip install pyinstaller
build.bat
```

产物 `desktop/pc-sensor/dist/Kinship-PCSensor.exe` 不入 git。后端用 `pc_sensor.exe_path` 指向它，设置页通过一次性票据下载 `/api/pc-sensor/download`。首次运行在 exe 同目录生成 `config.json` / `pc_sensor_config.json`，`server_url` 填 `https://<domain>:8768`，`backend_token` 用 `backend/config/auth.json` 里 `kind: service` 的长期 token。本地 API 默认 `127.0.0.1:18888`，不要改成 `0.0.0.0`。

### 3.2 配置与凭据

生产只读项目根 `config.yaml`。不存在多文件合并或覆盖层，改完按配置策略生效或重启后端。

最小核对项：

| 键 | 要求 |
| --- | --- |
| `server.host` / `server.port` | `0.0.0.0` / `8768` |
| `ssl.enabled` / `ssl.cert` / `ssl.key` | 生产为 `true`，两个文件都存在且域名匹配；`ssl.*` 属 deployment 策略，改后重启 `axeuh-health` 才生效 |
| `ai_backend` | 公开模板默认 `loom`；选 `dsh` 时还要配 `dsh.url` / `dsh.token_file`，并让 `axeuh-dsh` 在线 |
| `loom.url` | `http://127.0.0.1:5100` 或 `http://localhost:5100`，child 模式只允许回环（仅 `ai_backend: loom`） |
| `loom.token` / `loom.token_file` | 至少一个可用；`LOOM_TOKEN` 环境变量是回退（仅 `ai_backend: loom`） |
| `dsh.url` / `dsh.token_file` | `dsh.url` 默认 `http://127.0.0.1:18765`；token 文件指向 `<DSH_HOME>/kinship/bridge-token`，与 bridge 侧同一个 Bearer（仅 `ai_backend: dsh`） |
| `data.dir` / `data.ai_root` | 默认 `ai/data` / `ai` |
| `moss.enabled` | 需要 watcher 时为 `true` |
| `kernel.python` | 为空时用 `AXEUH_KERNEL_PYTHON` |

凭据文件：

```bash
sudo install -d -m 0750 -o root -g kinship /etc/kinship-loom
sudo test -s /etc/kinship-loom/credentials.conf || \
  sudo install -m 0640 -o root -g kinship /dev/null /etc/kinship-loom/credentials.conf
sudoedit /etc/kinship-loom/credentials.conf
# 写入 LOOM_TOKEN=<真实 token>，不要提交 git，不要打印到日志
```

`EnvironmentFile=` 没有前导 `-`，文件不存在时 `axeuh-health` 启动失败。

### 3.3 首次启动

公开模板的生产起点：

```bash
sudo cp deploy/kinship.service.example /etc/systemd/system/kinship.service
sudoedit /etc/systemd/system/kinship.service   # 修改用户、WorkingDirectory、venv 与配置路径
sudo systemctl daemon-reload
sudo systemctl enable --now kinship
systemctl is-active kinship
curl -kfsS https://127.0.0.1:8768/health
```

示例里的 `/opt/kinship`、`kinship` 用户、`.venv` 与凭据路径都是占位符。开发脚本与首次初始化见 [STARTUP.md](STARTUP.md)。

以下命令沿用作者生产环境的 `axeuh-health` 单元名；按公开示例部署时，把 `axeuh-health` 换成 `kinship`。

```bash
cd /opt/kinship
sudo install -m 0644 deploy/kinship.service.example /etc/systemd/system/kinship.service
sudo systemctl daemon-reload
sudo systemctl enable --now kinship
systemctl is-active kinship
curl -kfsS https://127.0.0.1:8768/health
```

首次打开 `https://<domain>/mobile/` 进入 11 步引导：`welcome`、`account`、`dependencies`、`kernel`、`kernel_models`、`xiaomi`、`qq`、`moss`、`loom`、`clients`、`finish`。`finish` 在进程内激活服务面，不需要重启后端。引导未完成时，业务路径返回 503 `onboarding_required`；`/health`、`/auth`、`/api/system/onboarding/*`、`/api/system/config/*`、`/api/ota/*`、`/api/clients/*`、`/mobile` 与静态资源放行。

不要手动执行 `python -m axeuh_kernel`。pidfile 由**后端**在 spawn 握手成功后写入（`{state_dir}/kernel.pid`，含 port/pid/api_version/token/nonce/created_at），内核自身不写 pidfile；手工进程会与后端形成双实例/端口冲突，后端对存活但非自己拉起的 pid 拒绝复用（`stale_kernel_detected`）。内核只由后端 spawn。

### 3.4 公网入口

浏览器走 Caddy，App 和 PC 采集器走 frpc 的 8768 透传。Caddy 站点文件放 `/etc/caddy/conf.d/<name>.caddy`：

```caddyfile
<name>.example.com, https://<name>.example.com:8443 {
    reverse_proxy https://127.0.0.1:8768 {
        transport http {
            tls_insecure_skip_verify
        }
    }
}
```

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

`validate` 通过再 `reload`，不要直接 restart Caddy。

- frpc 配置在 `/opt/frpc/frpc.toml`，80/443 透传到本机 Caddy，8768 透传到后端。日志看 `journalctl -u frpc -n 100 --no-pager`。
- 域名必须同时有 A（阿里云 ECS/frps）和 AAAA（家宽 IPv6）。只加 AAAA 会让 IPv4 入口和证书续期断掉；泛解析 A 不覆盖已有 AAAA 的子域名。
- IPv6 防火墙默认 INPUT DROP，只放行 22/80/443/8443、ICMPv6、DHCPv6。新增 IPv6 服务必须同时改 `/etc/ip6tables.rules` 并持久化。
- 不要使用 Windows 时代的 certbot、nginx 或宝塔路径；公网证书由 Caddy 管理，反代由 Caddy 完成。

## 4. 健康检查

### 4.1 单元与服务状态

```bash
systemctl is-active axeuh-health axeuh-moss
systemctl is-enabled axeuh-loom axeuh-moss-watch   # 稳定态应为 disabled
ss -lntp | grep -E ':(8768|5100|8100)\b'
```

`/api/services` 需要 **user** Bearer。service/device token 会被 403。下面的 helper 把 token 从 stdin 交给 curl，不进入 argv：

```bash
api_get() {
  local path=$1
  printf 'header = "Authorization: Bearer %s"\n' "${AXEUH_API_TOKEN:?先 export AXEUH_API_TOKEN}" |
    curl -kfsS -K - "https://127.0.0.1:8768${path}"
}
api_get /api/services
```

稳定态响应（`ai_backend: dsh`，本机生产）：

```json
{"orchestrator":"on","services":[
  {"id":"kernel","state":"ready"},
  {"id":"moss_watcher","state":"ready"},
  {"id":"loom","state":"blocked","reason_code":"disabled"}
]}
```

`loom` 为 `blocked/disabled` 是因为 `ai_backend: dsh`，属预期；`ai_backend: loom` 时应为 `ready`。迁移完成前或回滚后，`orchestrator` 为 `off`，`services` 为空数组。

### 4.2 各服务探针

| 对象 | 命令 | 期望 |
| --- | --- | --- |
| 后端 | `curl -kfsS https://127.0.0.1:8768/health` | 200，`status=healthy`；`ai_backend=dsh` 时 `dsh.status=online`、`loom.status=unknown` |
| 内核 | 读 pidfile 的 `port`，`curl -fsS http://127.0.0.1:<port>/v1/health` | 200 `{"status":"ok"}` |
| dsh bridge | `curl -s -H "Authorization: Bearer <bridge-token>" http://127.0.0.1:18765/v1/health` | 200，`status=bound`（仅 `ai_backend: dsh`） |
| Loom | 带 `LOOM_TOKEN` 请求 `http://127.0.0.1:5100/health` | 200，`status=ok`，版本符合预期（仅 `ai_backend: loom`） |
| MOSS serve | `curl -fsS http://127.0.0.1:8100/v1/models` | 200，包含 `moss-audio-4b` |
| MOSS watcher | `api_get /api/services` | `moss_watcher=ready`，deepdive 有新行 |
| 编排器子进程归属 | `ps -o pid,ppid,args -p <loom_pid>` / `<watcher_pid>` | `ppid` 等于 `systemctl show -p MainPID --value axeuh-health` |

内核探针：

```bash
KPF=backend/data/kernel_state/kernel.pid
python3 - "$KPF" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
print("pid=%s port=%s" % (d["pid"], d["port"]))
PY
KPORT=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["port"])' "$KPF")
curl -fsS "http://127.0.0.1:${KPORT}/v1/health"
```

Loom 探针：

```bash
printf 'header = "Authorization: Bearer %s"\n' "${LOOM_TOKEN:?先 export LOOM_TOKEN}" |
  curl -fsS -K - http://127.0.0.1:5100/health
```

### 4.3 数据侧检查

```bash
TODAY=$(date +%F)
wc -l "ai/data/daily/$TODAY/perception.jsonl" 2>/dev/null || true
tail -n 1 "ai/data/daily/$TODAY/perception.jsonl" 2>/dev/null || true
wc -l "ai/data/daily/$TODAY/audio_deepdive.jsonl" 2>/dev/null || true
```

迁移与回滚的硬断言是 `perception.jsonl` 行数单调不减。`audio_deepdive.jsonl` 是旁路，停多久都不影响主链。

## 5. 日常启停、重启与升级

### 5.1 启停

```bash
sudo systemctl start axeuh-health
sudo systemctl stop axeuh-health
sudo systemctl restart axeuh-health
```

`stop` 会通过后端关停钩子先停止脚本任务、调度器与编排器子服务，再由 systemd 清理 cgroup。正常关停在 15 秒预算内完成。

### 5.2 重启判据

只有满足以下任一条件才重启后端：

1. `/health` 连续 3 次（间隔 30 秒）非 200，且 `systemctl is-active axeuh-health` 仍为 `active`。
2. 部署了后端代码或必须重启才生效的配置，并且已经确认没有其他阶段正在执行。
3. 迁移脚本明确要求重启，且当前阶段与回滚路径已确认。

单次超时、单条 502、单个客户端断线都不是重启判据。先按[故障处置](troubleshoot.md)定位。

`POST /api/screen/restart` 需要 Bearer。Linux 上该端点停止脚本任务后直接退出，由 systemd `Restart=always` 拉起；语义等同 `systemctl restart axeuh-health`，不要用它绕过重启判据。

### 5.3 子服务单独重启

稳定态下，子服务由编排器管理。重启单个服务用运维闸门，不要直接对 systemd 单元操作：

```bash
# 运维闸门：POST /api/services/{id}/pause 与 /api/services/{id}/resume（Bearer user token）
curl -kfsS -X POST -K - "https://127.0.0.1:8768/api/services/loom/pause"  <<< "header = \"Authorization: Bearer ${AXEUH_API_TOKEN}\""
curl -kfsS -X POST -K - "https://127.0.0.1:8768/api/services/loom/resume" <<< "header = \"Authorization: Bearer ${AXEUH_API_TOKEN}\""
```

`pause` 会停止进程并锁定在 `blocked/manually_paused`；`resume` 解除锁定并重新判定。只调用 `resume` 不会重启已经在 `ready` 的进程。Loom 构建产物更新后，必须 `pause` 再 `resume` 才会换新进程。

dsh 不归编排器管：bridge 与 dsh Web 的启停/升级走 `sudo systemctl restart axeuh-dsh`（`ai_backend: dsh` 时）。bridge 掉线后先按[故障处置](troubleshoot.md)的 dsh 症状核对 profile 依赖，不要用后端 `pause/resume` 去修 dsh。

### 5.4 代码与前端升级

- 后端代码：按编排器迁移手册的四阶段部署。新代码不能先手工重启，否则会以默认 `AXEUH_ORCHESTRATOR=on` 提前接管服务。
- 前端：`npm run build:atomic`、`npm run verify:dist`、原子替换 `frontend/mobile/dist/`。仅前端变更不需要重启后端。
- Loom：在 `loom-harness` 里构建 dist，然后 `pause loom`、`resume loom`。不要 `systemctl start axeuh-loom`。
- dsh：在 `harness-plugins` 里 `npm run build` 后重启 `axeuh-dsh`（`link:` 依赖指向仓库，不需要再拷包）；`ai_backend` 本身是 hot 键，切换不需要重启后端。
- MOSS watcher：改 `moss.enabled` / `moss.python` / `moss.data_root` / `moss.state_dir` 后由配置应用器重拉子进程，或 `pause/resume moss_watcher`。

### 5.5 回退到 launcher（仅迁移期历史路径）

`launcher.py` 已退役，仅迁移回滚脚本仍引用它；新部署不要使用。完整顺序见迁移手册的回滚矩阵。要点：

```bash
bash scripts/migrate-orchestrator/rollback-stage4.sh --yes
bash scripts/migrate-orchestrator/rollback-stage3.sh --yes
bash scripts/migrate-orchestrator/rollback-stage2.sh --yes
AXEUH_ALLOW_CODE_ROLLBACK=1 bash scripts/migrate-orchestrator/rollback-stage1.sh --yes
```

`rollback-stage4` 只回到 stage3 状态（launcher + `AXEUH_ORCHESTRATOR=on`），不会重新启用 Loom/MOSS 单元。要回到迁移前拓扑，必须继续执行 `rollback-stage3`。

## 6. 端口、凭据与日志速查

| 端口 | 绑定 | 用途 |
| --- | --- | --- |
| 80 / 443 | Caddy | 证书挑战、浏览器 HTTPS 主入口 |
| 8443 | Caddy | IPv6 直连入口 |
| 8768 | 0.0.0.0 | 后端 HTTP/HTTPS 同端口（本机生产 HTTPS） |
| 18765 | 127.0.0.1 | dsh kinship-bridge（`ai_backend: dsh`，属 `axeuh-dsh`） |
| 3080 | 127.0.0.1 | dsh Web（`ai_backend: dsh`，属 `axeuh-dsh`） |
| 5100 | 127.0.0.1 | Loom（仅 `ai_backend: loom`；本机当前未运行） |
| 8100 | 127.0.0.1（部署后核对） | MOSS vLLM serve（不归编排器；watcher 无端口） |
| 18888 | 127.0.0.1 | PC 感知采集器本地 API（Windows 端，不在 Ubuntu 主机） |
| 8770 | 127.0.0.1 | QQ 网关（后端进程内） |
| 8787 | 127.0.0.1 | P2P 信令（实验，当前不可用，不应部署） |
| 8000 | 127.0.0.1 | 本地 27B LLM（可选，本机当前未运行） |
| 5173 | 127.0.0.1 | Vite 开发服务器（仅前端开发） |
| 动态 | 127.0.0.1 | 音频内核，端口在 pidfile |

| 凭据 | 位置 | 权限 |
| --- | --- | --- |
| 管理员账号 | `backend/config/auth.json` | 0600 |
| 首次引导令牌 | `backend/config/.setup_token` | 0600，创建管理员后删除 |
| Loom token | `/etc/kinship-loom/credentials.conf` | `root:kinship 0640`；`ai_backend: dsh` 时 `axeuh-health` 仍用 `EnvironmentFile=` 读它，不要删 |
| dsh bridge token | `<DSH_HOME>/kinship/bridge-token` | 0600；与 `dsh.token_file` 指向同一文件 |
| QQ 网关 MCP token | `/etc/kinship-qq-gateway/mcp.token` | 0600 |
| MOSS 凭据 | `/etc/kinship-moss/credentials.conf` | 0600 |
| TLS 私钥 | `config.yaml` 的 `ssl.key` 指向文件 | 按证书规范 |

| 日志 | 位置 |
| --- | --- |
| 后端文件日志 | `backend/logs/backend.log`，按日轮转，保留 30 天 |
| 后端 systemd | `journalctl -u axeuh-health -n 200 --no-pager` |
| Loom child | `backend/data/logs/loom-child.log`（仅 loom 模式） |
| dsh | `journalctl -u axeuh-dsh -n 200 --no-pager`（插件的 `ctx.logger` 不写 journal，属正常） |
| 内核 stderr | `backend/data/kernel_state/kernel.stderr.log` |
| MOSS serve | `journalctl -u axeuh-moss -n 100 --no-pager` |
| MOSS watcher（稳定态） | `journalctl -u axeuh-health -n 200 --no-pager` 中的 watcher 输出 |
| MOSS watcher（迁移期/回滚态） | `journalctl -u axeuh-moss-watch -n 100 --no-pager` |
| Caddy / frpc | `journalctl -u caddy -n 100 --no-pager`、`journalctl -u frpc -n 100 --no-pager` |

## 7. 上线验收清单

- [ ] `systemctl is-active axeuh-health frpc caddy` 全为 `active`。
- [ ] `curl -kfsS https://127.0.0.1:8768/health` 返回 200。
- [ ] `curl -kfsS https://<domain>:8768/health` 证书有效，域名匹配。
- [ ] `/api/services` 返回 `orchestrator=on`：`kernel`、`moss_watcher` 为 `ready`；`loom` 在 `ai_backend: loom` 时 `ready`，在 `ai_backend: dsh` 时 `blocked/disabled`（预期）。
- [ ] `ai_backend: dsh`：`systemctl is-active axeuh-dsh` active、`/health.dsh=online`、`ss` 见 18765/3080。
- [ ] Loom 的 `ppid` 等于 `axeuh-health` 的 `MainPID`（仅 loom 模式）。
- [ ] `axeuh-loom` 与 `axeuh-moss-watch` 为 `inactive`/`failed` 且 `disabled`。
- [ ] 内核 pidfile 有 `pid`/`port`，`/v1/health` 可达，stderr 无持续报错。
- [ ] `https://<domain>/mobile/` 可打开，管理员登录正常。
- [ ] `ss` 确认 8100 未裸露公网、8770 仅回环，8768 的监听者是 `core.hot_server`，18765/3080 归属 `axeuh-dsh`，5100 仅在 loom 模式下出现。
- [ ] 当日 `perception.jsonl` 有新增行，`audio_deepdive.jsonl` 可选有新行。
- [ ] `df -h / /mnt/d` 有足够余量；`journalctl` 无连续 5xx 或 OOM。
