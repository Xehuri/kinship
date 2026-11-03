# Loom Feature Plugin P2b：沙箱化外部插件运行时

状态：设计完成；2026-11-03 决定暂缓实现  
范围：`trust: "sandboxed"` 外部插件的独立进程 runtime、capability RPC、Linux 沙箱  
不包含：npm/git 安装、lockfile、市场索引/API/UI（P2c）、Windows/macOS 沙箱实现

## 0. 当前决策（2026-11-03）

**P2b 暂缓实现。** Loom 当前外部插件入口只有 P2a 的 `trust: "trusted"`（进程内、
可信本地代码）；`trust: "sandboxed"` 不开放。

原因：

1. 当前目标是内部功能解耦，P0/P1 已完成；这部分不需要沙箱。
2. 主流 harness 默认不沙箱第三方插件：Claude Code/Codex/Pi/OpenCode 沙箱的是
   agent 自己的 shell/命令，插件/hooks/MCP 仍以用户权限运行；MCP 是进程边界不是
   安全沙箱；VS Code 扩展宿主独立进程但有完整权限，靠市场信任/扫描；真正隔离
   第三方代码的是 OpenHands/Gemini/Devin 这类容器或 VM 方案。
3. 本机 bwrap 被 Ubuntu AppArmor 的 unprivileged-userns 限制挡住；systemd user
   不能做 mount/net namespace；Docker 可用但 daemon 是宿主级信任边界，且 Oracle
   评审没有覆盖 Docker 后端。
4. 公开、陌生人可发布的市场尚未成为当前需求。没有这个需求时，P2b 的成本
   （5–8 人日 + 部署前置 + 能力裁剪）高于收益。

**重新打开条件**：确定要做公开/不受信第三方插件市场，或必须执行不受信插件代码。
重开时：

- 先选后端：Docker（本机可用，需单独安全评审）或 bwrap + AppArmor profile/开启
  userns；不得把 systemd 用户服务或普通 Node 子进程当沙箱。
- 按 §15 的 7 条阻断项实现，并用完整功能探针作为 release gate。
- 默认只开放 tools/routes/storage/config/events；hooks/fs/net/exec/sessions/wake
  继续拒绝。

## 1. 目标

让不可信外部插件在**独立进程 + OS 沙箱**中运行，Host 只通过能力 broker 暴露受控接口。插件崩溃、死循环、越权访问不能拖垮 Loom 主进程。

P2a 的 `trust: "trusted"` 保持原样：进程内、完整进程权限、仅受 PluginContext 接口约束。

## 2. 非目标

- 不做 hooks 沙箱化（v1 直接拒绝 `hooks:register`）。
- 不提供直接文件系统、网络、`exec`、session 读取、wake 调度能力。
- 不做插件市场安装器/签名/审核（P2c）。
- 不做 Windows AppContainer / macOS sandbox-exec 的完整实现（P2b v1 仅 Linux）。
- 不做多插件共享 worker pool（一插件一进程）。

## 3. 威胁模型

沙箱插件被视为**不可信代码**，必须假设它会：

- 尝试读取 workspace、state、配置文件、环境变量、其他插件数据；
- 尝试连接网络、执行子进程、加载原生模块；
- 尝试伪造 plugin id、注册越权工具/路由、读写别人的 storage key；
- 返回超大 payload、无限循环、OOM、崩溃、fork 炸弹；
- 尝试通过 route/tool 参数做路径穿越或命令注入。

Host 的安全边界是：**OS 沙箱 + 独立进程 + Host 侧 capability broker**。PluginContext 的权限检查只是第二道一致性检查，不是边界。

## 4. 进程模型

一插件一 worker 进程：

```
Loom host process
  └── PluginHost
        └── SandboxedPluginRuntime (per plugin)
              └── bwrap
                    └── node plugin-worker.mjs
                          └── import(plugin entry)
```

- Worker 由 Loom 提供的可信 runner `plugin-worker.mjs` 启动；插件代码只在该 runner 内被 import。
- Host 通过 stdio 与 worker 通信；stdout 只允许 RPC 帧，stderr 只作日志。
- Worker 不接触 Loom 的 EventHub、WakeQueue、store、router、SessionRegistry、模型对象。
- Host 为每个 worker 分配 plugin id；worker 发来的任何 id 字段一律忽略/校验，不能自报身份。
- Worker 崩溃/退出不影响 Host；Host 标记 `degraded`/`failed` 并按策略重启。

## 5. 包与 manifest

沙箱插件必须是目录包：

```
ext-plugin/
  loom.plugin.json
  dist/index.mjs
  package.json          # 可选；若存在需 "type": "module"
```

`loom.plugin.json` 是**启动前**由 Host 读取的权威清单，不执行任何插件代码：

```json
{
  "id": "ext-demo",
  "name": "Ext Demo",
  "version": "1.0.0",
  "apiVersion": 1,
  "entry": "./dist/index.mjs",
  "permissions": ["tools:register", "routes:register", "storage:own"],
  "critical": false,
  "configSchema": "./loom.schema.json",
  "minLoomVersion": ">=1.6.0"
}
```

规则：

- `path` 在 `trust: "sandboxed"` 时指向**目录**；`trust: "trusted"` 时仍指向 P2a 的模块文件。
- `entry` 必须是包内相对路径；realpath 后必须仍在包目录内，禁止 `..`/绝对路径/符号链接逃逸。
- `manifest.id` 必须等于配置 id。
- `apiVersion` 必须等于 `LOOM_PLUGIN_API_VERSION`。
- `permissions` 必须在允许集合内；未知权限直接拒绝。
- `critical` 缺省 `false`（沙箱插件失败不阻断 boot；显式 true 才阻断）。
- Host 读取 manifest 后立即做权限/路径校验，再决定是否 spawn。

## 6. RPC 协议

JSON-RPC 2.0，一行一帧（NDJSON），stdout 只走协议，stderr 只走日志。

### 6.1 Host → Worker

- `initialize`：`{protocolVersion, pluginId, config, permissions}`
- `tool.execute`：`{callId, name, args, context:{sessionID, callId}}`
- `tool.cancel`：`{callId}`
- `route.handle`：`{requestId, method, path, headers, bodyBase64}`
- `shutdown`：`{}`
- `ping`：`{}`

### 6.2 Worker → Host

- `register.tool`：`{descriptor}`（name/description/parameters JSON Schema）
- `register.route`：`{method, path, auth}`
- `storage.get/set/delete/list`
- `log.write`：`{level, message, fields}`
- `events.emit`（仅插件本地事件总线；不跨插件）
- `tool.update`：`{callId, content, details}`（可选流式）
- `ready`：`{tools, routes}`
- `error`：`{code, message}`

### 6.3 帧限制

- 单帧上限 1 MB；超出直接断开。
- 工具/路由返回值上限 1 MB；超出截断并标记 `truncated`。
- 每个 RPC 有超时（tool 默认 30s，route 默认 15s，initialize 10s，shutdown 5s）。
- Host 对并发 tool/route 调用设上限（每插件 4 个），超出排队。

## 7. 能力 broker

所有 Worker → Host 的 RPC 都经过 Host 侧 broker；broker 绑定插件 id，逐项检查 manifest 权限。

### 7.1 v1 允许的权限

| 权限 | 接口 |
|---|---|
| `tools:register` | `register.tool` → Host 工具代理 |
| `routes:register` | `register.route` → Host 路由代理 |
| `storage:own` | `storage.*` → 每插件独立 KV |
| `config:own` | `initialize.config`（只读） |
| `events:own` | `events.emit`（仅插件本地总线） |

### 7.2 v1 明确拒绝

- `hooks:register`：高频、可观察/修改 prompt 与 tool call，RPC 延迟和安全风险都高，P2b 不开放。
- `fs:read` / `fs:write`：v1 不提供直接文件系统；需要文件能力的插件应改用 storage 或等待 P2b.1 的 host-mediated file API。
- `net:outbound`：沙箱默认无网络；P2b 不提供 host 代理。
- `exec`：不提供子进程。
- `sessions:read`：不暴露会话历史/转录。
- `wake:schedule`：WakeQueue 仍只归 core。

如果 manifest 请求被拒绝的权限，Host 在 spawn 前直接拒绝整个插件（不静默降级）。

### 7.3 工具代理

- Host 把 `register.tool` 的 descriptor 包装成 `HarnessTool`。
- `execute` 通过 `tool.execute` RPC 转发；参数来自模型，Host 只做 schema 大小/名称检查，不做业务校验。
- 工具上下文只传 `sessionID` 与 `callId`；不传 workspace、历史、模型、其他会话。
- 工具名去重、保留字、长度和字符集校验与 in-process 插件一致。
- Worker 返回 `content`/`details`/`isError`；Host 做大小截断和错误映射。

### 7.4 路由代理

- 路由路径必须位于 `/plugins/<pluginId>/`。
- Host 注册真实 HTTP handler；请求体/响应体大小受限；默认 JSON，不支持 SSE/流式。
- 鉴权继承 Router（默认 required）；插件不能注册未鉴权 catch-all。
- 插件返回状态码/headers/body；Host 过滤 hop-by-hop headers、限制 header 数量与大小。

### 7.5 Storage

- Host 使用现有 `FilePluginStorage`，命名空间由 Host 固定为插件 id。
- Worker 不能直接访问 storage.json；所有读写走 RPC。
- Key 长度/字符集、value JSON 大小、写入频率有限制。
- 插件卸载默认保留 data 目录；显式 `--purge` 才删除。

### 7.6 Config

- `plugins.<id>.config` 是插件私有配置对象；Host 在 `initialize` 时只传这个对象。
- `path`/`trust`/`enabled` 等 Host 控制键不进入插件配置。
- 配置 schema 在 P2c 安装时校验；P2b 只做 JSON 可序列化与大小限制。

## 8. Linux 沙箱（bwrap）

v1 只支持 Linux + bubblewrap。若 `bwrap` 不可用，`trust:"sandboxed"` 插件拒绝加载并给出明确错误；不会回退到无沙箱。

参考 profile：

```text
prlimit --nproc=64 --nofile=256 --core=0 -- \
bwrap
  --die-with-parent
  --new-session
  --unshare-all
  --disable-userns
  --cap-drop ALL
  --ro-bind <nodeRealPath> <nodeRealPath>
  --ro-bind /lib /lib
  --ro-bind /lib64 /lib64
  --ro-bind /usr/lib/x86_64-linux-gnu /usr/lib/x86_64-linux-gnu
  --ro-bind /etc/ld.so.cache /etc/ld.so.cache
  --ro-bind <runnerPath> /runner/plugin-worker.mjs
  --ro-bind <pluginDir> /plugin
  --proc /proc
  --dev /dev
  --size 64M
  --tmpfs /tmp
  --chdir /tmp
  --clearenv
  --setenv PATH <nodeDir>:/usr/bin:/bin
  --setenv HOME /tmp
  --setenv TMPDIR /tmp
  -- <nodeRealPath> --max-old-space-size=<limit> /runner/plugin-worker.mjs
```

要点（Oracle 2026-11-03 修正）：

- 删除 `--no-new-privs`：bwrap 0.9.0 没有该参数，NNP 由 bwrap 自身设置；必须用 probe 断言 `/proc/self/status` 的 `NoNewPrivs=1`。
- 加 `--disable-userns`，禁止插件在沙箱内继续创建 user namespace。
- `--tmpfs` 前必须 `--size 64M`（或配置上限），否则默认可能吃满宿主内存。
- 必须只读 bind 可信 runner（`/runner/plugin-worker.mjs`）和 `realpath(process.execPath)`；不要整绑 `/usr`，避免 shell/python 可用。
- 外层 `prlimit --nproc=64 --nofile=256 --core=0`；spawn 后把 `oom_score_adj` 设为 1000（让 worker 先被 OOM 选中）。
- 功能探针必须用完整 profile 实测（bwrap 存在 ≠ 可用）：读 `/etc/passwd` 必须失败、网络必须失败、`NoNewPrivs=1`、`CapEff=0`、tmpfs 可写；失败只禁用 sandboxed 插件并显示原因，`critical:true` 才 boot 失败，绝不回退 trusted。
- AppArmor/Ubuntu 24.04：`kernel.apparmor_restrict_unprivileged_userns=1` 会让 bwrap 失败；部署需为 `/usr/bin/bwrap` 配置 `flags=(unconfined) { userns, }` 的 AppArmor profile，或显式关 sysctl（降低主机安全基线）。
- 插件目录只读；workspace、state、config、证书、`ai/` 均不 bind；不 bind data 目录，storage 只走 RPC；临时文件只落 tmpfs。
- `NODE_OPTIONS`、`LD_PRELOAD`、`BASH_ENV` 等不继承；环境变量白名单。
- `--max-old-space-size` 只限 V8 old space，不保证 RSS；cgroup/CPU 硬限与 seccomp 留 P2b.2，P2b.1 用 prlimit + oom_score_adj + wall-clock/并发/输出上限兜底。
- v1 不加自定义 seccomp profile。

Windows/macOS：

- P2b v1 不支持 `trust:"sandboxed"`；配置校验直接拒绝并提示使用 `trust:"trusted"` 或等待平台实现。
- 不把 `taskkill`/Job Object 的半成品当沙箱。

## 9. 生命周期与健康

状态：`starting → running → degraded → failed/stopped`。

- `setup`：Host 读 manifest → spawn bwrap → initialize → 等待 `ready` → 校验注册的 tools/routes → 进入 running。
- `start` 失败：`critical:false` → failed，boot 继续；`critical:true` → boot 失败。
- Worker 崩溃：标记 degraded，按 1s/2s/4s/8s/16s（上限 30s）重启；最多 5 次，之后 failed。
- 工具/路由调用在 degraded 期间返回明确错误（不挂起）。
- 健康检查：每 30s `ping`；连续 3 次超时 → 重启。
- `stop`：`shutdown` → 等待 5s → SIGTERM → 2s → SIGKILL 进程组；确保 bwrap/子进程一起退出。
- `/plugins/status` 增加：`transport: "process"`、`sandbox: "bwrap"`、`pid`、`restarts`、`lastError`、`lastHeartbeatAt`。不返回插件配置/正文。

## 10. 配置

```yaml
plugins:
  ext-demo:
    path: /srv/loom/plugins/ext-demo
    trust: sandboxed
    enabled: true
    config:
      endpoint: "https://example.invalid"
```

- `trust` 现在允许 `trusted | sandboxed`；P2a 的 trusted 路径/语义不变。
- `path` 在 sandboxed 下必须是目录；trusted 下仍是模块文件。
- `config` 只对沙箱插件定义为插件私有配置；P2a trusted 插件后续也迁移到 `config`（P2b 实现时统一）。
- `enabled:false` 不 spawn、不读 manifest、不出现在 status。
- builtin id 仍禁止带 path/trust。

## 11. 测试

### 11.1 单元

- manifest 读取/路径逃逸/entry 越界/apiVersion/权限白名单。
- broker 权限矩阵：每个 RPC 在允许/拒绝权限下的行为。
- RPC 帧拆分、超限、超时、取消、并发上限。
- tool/route 代理的参数/返回值截断、错误映射。
- storage 命名空间隔离、key/value 限制。
- 生命周期：启动失败、崩溃重启、最大重启、stop 幂等。
- 路径穿越/route 前缀/工具名冲突。

### 11.2 沙箱集成（Linux，需要 bwrap）

- fixture 插件尝试：
  - 读 `/etc/passwd`、workspace、state、`../../`；
  - `process.env` 读取敏感变量；
  - `fetch`/`net.connect`；
  - `child_process.exec`；
  - 写 `/tmp` 外的路径。
  - 全部必须失败。
- 正常路径：注册 tool → 模型调用 → 返回；注册 route → HTTP 调用；storage 读写；插件崩溃后 status degraded；重启后恢复。
- 如果 CI 没有 bwrap，沙箱集成测试 skip，但 release gate 必须在有 bwrap 的机器跑。

### 11.3 真实面

- `GET /plugins/status` 显示 process/bwrap/pid/restarts。
- 工具调用经真实 HTTP/registry；route 经真实 HTTP。
- 杀掉 worker 后 Loom 不崩；工具返回明确错误。
- 关闭 Loom 后无 bwrap/node 残留进程。

## 12. 验收门槛

- 沙箱插件无法访问宿主文件系统、网络、子进程、其他插件 storage。
- 工具/路由/storage 正常；hooks/fs/net/exec/sessions/wake 在 manifest 阶段拒绝。
- worker 崩溃/死循环/OOM 不影响 Host；状态可见、可重启。
- 关闭后无残留进程。
- build/typecheck/全量测试通过；沙箱逃逸测试全部通过。

## 13. 分阶段

- **P2b.1**：Linux bwrap + JSON-RPC + tools/routes/storage/config/events；hooks 拒绝；无安装器。
- **P2b.2**：崩溃重启/健康检查/配额/状态面完善；seccomp 评估。
- **P2b.3**：Windows/macOS 策略（AppContainer/sandbox-exec 或明确只支持 trusted）。
- **P2c**：npm/git 安装、lockfile、签名/审核、市场索引/API/UI。

## 14. 本机环境预检（2026-11-03）

在本机（Ubuntu，内核 7.0.0，bwrap 0.9.0）实测：

- `bwrap` 已安装，但 `kernel.apparmor_restrict_unprivileged_userns=1`：
  - `bwrap: setting up uid map: Permission denied`
  - `--unshare-all` 时 `loopback: Failed RTM_NEWADDR: Operation not permitted`
- `systemd-run --user --pipe` 可运行、stdio 可用，`PrivateNetwork=yes` 在日志中只是
  “kernel does not support ... proceeding without”；`ProtectSystem` / `InaccessiblePaths`
  之类 mount namespace 设置返回 `status=226/NAMESPACE`。
- 因此 **systemd user 服务只能做进程隔离，不是本设计要求的文件系统/网络沙箱**。
- Docker 29.1.3 可用（当前用户在 docker 组），`node:20-alpine` 已拉取；实测：
  - `--network none` → 连接 `ENETUNREACH`
  - 宿主路径未挂载 → `ENOENT`
  - `--read-only` + `--tmpfs /tmp` → 只有 /tmp 可写
  - `--user 1000:1000 --cap-drop ALL --security-opt no-new-privileges --pids-limit 64 --memory 128m --cpus 0.5` 可运行
  - `docker run -i` 的 stdin/stdout 可用于 JSON-RPC
- Docker daemon 是宿主级信任边界；插件容器不挂 docker.sock，但 Loom 进程本身有 docker 组权限。

结论：本机当前可用的真实沙箱后端是 **Docker**；bwrap 需要开启非特权 userns 或特权 helper。实现前必须选择：

1. P2b.1 先用 Docker 后端（本机可立即验收；部署要求 Docker + 预拉取 Node 镜像）；
2. 允许非特权 user namespace（修改 `kernel.apparmor_restrict_unprivileged_userns`，
   需要 root，且会降低主机安全基线），继续 bwrap；
3. 使用特权 sandbox helper（setuid/root 服务）或 AppArmor 专用 profile；
4. 接受 P2b 暂缓，只保留 P2a trusted；
5. 只在 CI/生产提供满足 userns 条件的 Linux 环境实现并验收，本机跳过沙箱集成测试
   （不得把无沙箱运行当成 sandboxed）。

在选定前，不应把 `trust:"sandboxed"` 指向 systemd 用户服务、普通 Node 子进程或未隔离的 Docker 容器。

## 15. Oracle 安全评审（2026-11-03）

裁决原文：**“结论：approve-with-changes。”** 核心架构（bwrap + 一插件一 worker + 窄能力 broker）方向正确，但当前设计直接实现会同时遇到“跑不起来”和“越权面”两类问题。

实现前必须修的 7 条阻断项：

1. **bwrap profile 重写**：删 `--no-new-privs`；加 `--disable-userns`；`--tmpfs /tmp` 前加 `--size 64M`；只读 bind 可信 runner 与 `realpath(process.execPath)`；不要整绑 `/usr`；外层 `prlimit --nproc/--nofile/--core` + `oom_score_adj=1000`。
2. **功能探针**：不能用 `command -v bwrap`；必须用完整 profile 跑冒烟（读 `/etc/passwd` 失败、无网络、`NoNewPrivs=1`、`CapEff=0`、tmpfs 可写）；失败只禁用 sandboxed 插件，`critical:true` 才 boot 失败，绝不回退 trusted。
3. **路由 broker 重做**：`route.handle` 不得透传 `authorization`/`x-loom-token`/`cookie`，只给安全头白名单；禁止 `auth:"none"`/`admin`，全部要求鉴权；当前代码根本没有挂载插件路由，必须补；请求/响应体与 header 都要限长。
4. **工具结果面收紧**：禁止 worker 返回 `newMessages`、图片 content、`aliases`、`isReadOnly/isDestructive/isOpenWorld`；工具名由 Host 强制命名空间化（如 `plugin_<id>_<name>`），与 builtin 冲突必须失败而非静默 skip；schema/description/args/result 全部限长。
5. **manifest 读取硬化**：`loom.plugin.json` 用 `O_NOFOLLOW`、必须是普通文件、限长后再 parse；`entry` 用 `lstat` + `realpath` + `path.relative` 做包含判断，拒绝符号链接；P2b 不读 `configSchema`。
6. **config/storage 修正**：`initialize.config` 只能是 `plugins.<id>.config`，绝不能带 `path/trust/enabled`（当前 `resolvePluginConfig` 会把整个 enable 条目传进去）；storage 用 null-prototype 容器，拒绝 `__proto__/constructor/prototype`，加 key/value/总量/文件大小上限。
7. **生命周期补洞**：`PluginHost.stop()` 当前只停 `running`，degraded/starting 的 worker 会泄漏；boot 中途 critical 失败要 cleanup 已启动 worker；重启后按 generation 丢弃旧响应；禁止对非 detached 子进程做进程组 kill。

P2b.1 拆分（Oracle 建议）：

1. SDK + manifest reader
2. probe + argv builder
3. worker runner + RPC codec
4. runtime 状态机 + broker
5. 路由代理（独立提交）
6. 生命周期收口
7. 测试与发布门

Defer 到 P2b.2/P2c：seccomp/landlock、cgroup CPU/内存硬限、`tool.update` 流式、hooks、签名/锁文件/安装器、`configSchema` 校验、热重载、Windows/macOS 沙箱、路由 SSE/`auth:none`、`events.emit` RPC。

**Docker 说明**：Oracle 评审基于 bwrap，**没有评审 Docker 作为沙箱后端**。Docker 在本机实测可用（网络隔离、宿主路径不可见、只读根、tmpfs、rlimits），但 Docker daemon 是宿主级信任边界；若选 Docker 后端，必须单独做一次安全评审（seccomp、镜像信任、daemon 权限、容器逃逸面），不能把 bwrap 的评审结论直接套用。

## 16. 设计决策（已锁定，暂缓实现）

1. 沙箱 v1 只支持 Linux；Windows/macOS 的 `trust:"sandboxed"` 直接拒绝，不静默降级。
2. 沙箱插件 v1 拒绝 `hooks:register`；只开放 tools/routes/storage/config/events。
3. 采用“一插件一进程 + JSON-RPC over stdio”。
4. 沙箱插件必须提供独立 `loom.plugin.json`，Host 先读 manifest 再 spawn。
5. `plugins.<id>.config` 作为插件私有配置块，与 `path`/`trust`/`enabled` 分离。

以上决策保留；因 P2b 暂缓，尚未进入实现。
