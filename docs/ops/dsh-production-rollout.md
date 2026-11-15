# 将 Kinship 的 AI 切到生产 dsh：接入手册

> 适用：本机同机部署（Kinship 后端与 dsh 在同一台机器）。跨机场景不适用——适配器契约要求
> bridge 只监听 loopback，公网 URL 只是给人用的 Web UI。
>
> 目标实例：systemd `axeuh-dsh`，profile `web`，`DSH_HOME=/mnt/d/Users/Axeuh/Desktop/Axeuh-server/dsh-home`，
> UI `127.0.0.1:3080`，公网 `https://dsh.xehuri.top/`（IPv4 443）与 `https://dsh.xehuri.top:8443/`（IPv6 直连）。
>
> 状态（2026-11-15 20:24）：A–D 已完成并验证，生产 `ai_backend` 已是 `dsh`、`/health.dsh=online`，
> Loom 已被编排器判 blocked 并停用；E 为回滚预案（现在回滚 Loom 需要重启一次后端或手动启动）。详见第 3.1 节。

## 1. 结论先行

- Kinship 后端不访问 `https://dsh.xehuri.top:8443/`。它只访问 `kinship-bridge` 的 loopback
  地址（本部署 `http://127.0.0.1:18765`，Bearer token）。
- 公网 UI 的用途是：打开 dsh、创建 Kinship 会话、在左侧栏 **Kinship** 面板看状态/取 token/改桥接配置。
- 切换是**后端热切换**（`ai_backend` 与 `dsh.*` 都是 hot 策略），不需要重启 Kinship 后端；
  但 dsh 侧新增 bundle 与环境变量需要**重启一次 `axeuh-dsh`**，且 dsh 重启后 Kinship 会话是冷会话，
  需要在 UI 里打开一次。
- Loom 编排器的 gate 要求 `ai_backend == loom`，切到 dsh 后 Loom 会变成 blocked/停用（已接受）；
  回滚时它会按 gate 重新拉起。

## 2. 组件与路径

| 项 | 位置 |
|---|---|
| 插件包源码与构建 | `server/kinship/harness-plugins`（`packages/{kinship-bridge,kinship-ui,kinship-plan,kinship-plan-scheduler,kinship-compact,kinship-task-compat}` + `presets/kinship.patch.yml`） |
| 同步脚本 | `harness-plugins/scripts/sync-profile.sh`（构建产物 → 目标 profile 的 `node_modules/`） |
| dsh profile | `dsh-home/profiles/web/`（`package.json` 的 `dsh.profile.bundles` 含 `kinship-harness-plugins`） |
| dsh 环境变量 | `/etc/axeuh-dsh/env`（systemd `EnvironmentFile`） |
| bridge 令牌 | 插件自动生成 `dsh-home/kinship/bridge-token`（0600） |
| bridge 绑定记录 | `dsh-home/kinship/binding.json` |
| Kinship 后端配置 | `kinship-data/config.yaml`（`ai_backend`、`dsh.*`） |
| 执行环境 | dsh 与后端都以 `xehuri` 运行；dsh 的 `User=xehuri`，后端同用户 |

## 3. A 段：准备（已完成 2026-11-15 20:10）

1. 备份（均带 `bak-kinship-20261115-201011` 后缀）：profile `package.json`、profile
   `cordis.patch.yml`、`kinship-data/config.yaml`、`/etc/axeuh-dsh/env`。
2. 构建与自检：`cd harness-plugins && npm run verify`（typecheck + build + 82 tests）。
3. `/etc/axeuh-dsh/env` 追加（不含 token 变量，让插件生成 0600 文件，后端用 `dsh.token_file` 引用）：

   ```
   KINSHIP_AI_ROOT=/mnt/d/Users/Axeuh/Desktop/Axeuh-server/kinship-data/ai
   KINSHIP_PLAN_ROOT=/mnt/d/Users/Axeuh/Desktop/Axeuh-server/kinship-data/ai/data
   KINSHIP_BRIDGE_PORT=18765
   KINSHIP_BRIDGE_POLICY=first
   KINSHIP_BRIDGE_REBIND_ON_MISSING=1
   ```

4. profile `package.json`：`dsh.profile.bundles` 追加 `kinship-harness-plugins`（保持在末尾）。
5. 安装包：`DSH_HOME=<dsh-home> bash harness-plugins/scripts/sync-profile.sh web`。
6. 组合校验（无需重启）：

   ```bash
   cd /mnt/d/Users/Axeuh/Desktop/Axeuh-server/server
   DSH_HOME=<dsh-home> KINSHIP_AI_ROOT=.../kinship-data/ai KINSHIP_PLAN_ROOT=.../kinship-data/ai/data \
     dsh --profile web --dump-config | grep -E 'id: (kinship-bridge|kinship-ui|preset-kinship|agent-instructions)' -A2
   ```

   预期：`kinship-bridge`（config 为 `!!js process.env.*`）、`kinship-ui`、`preset-kinship`
   （persona 已展开）都在；根 `agent-instructions` 行带 `disabled: true`。

## 3.1 实际执行记录（2026-11-15）

| 时间 | 阶段 | 结果 |
|---|---|---|
| 20:08 | 停测试栈 | `kinship-test` 的 backend/dsh 停止，8775/3099/18766 释放 |
| 20:10 | A | 备份（`bak-kinship-20261115-201011`）；`npm run verify` 83 tests；`scripts/sync-profile.sh` 安装四包 + bundle；`/etc/axeuh-dsh/env` 加 5 个 `KINSHIP_*`；profile `bundles += kinship-harness-plugins`；`--dump-config` exit 0 且三行齐全、persona 已展开 |
| 20:15 | B | `axeuh-dsh` 重启（新 PID，20:15:08）；`127.0.0.1:18765` 监听；`dsh-home/kinship/bridge-token` 生成（0600）|
| 20:17 | C | 绑定 `session-2f8b68aa-5dec-4509-bf87-39f36d743303`（preset kinship），cwd=`kinship-data/ai`；`/v1/health` `status:"bound"` |
| 20:20 | D | 改 `kinship-data/config.yaml`（`ai_backend: dsh` + `dsh` 段，备份 `config.yaml.bak-kinship-switch-20261115-202012`）；ConfigStore 轮询约 1 秒内热应用，`/health` 变 `ai_backend=dsh`，后端进程未重启（uptime 不变） |
| 20:22 | 验证 | 隔离：会话日志（zstd 解压）21 条事件、0 处 `agent-instructions`。DshClient 只读自检：`health_check=online`、`get_main_session` 返回绑定会话、`get_session_status=idle`、模型目录 1 个 provider、上下文窗口 1M（`xehuri-api/deepseek-flash`）|
| 20:24 | 收尾重启 | `systemctl restart axeuh-health`（新 PID 2209503，启动约 4s）：`[DshHealth] 健康探针已启动` → `/health.dsh=online`；`[Orchestrator] loom -> blocked (disabled)`，Loom 子进程消失、`/health.loom=offline`；重启后 DshClient 只读自检仍 online/bound/idle/1M |
| 20:29 | 修 W30 | 发现 `kinship-data/ai/data/cache/web_backend.json` 仍是 10 月遗留的 `loom`：Web 对话管线（`routers/session.py`、`model_config.py` 走 `acquire_web_client()`）按它选 Loom，而 SSE 按全局 `ai_backend` 选 dsh → 前端表现为"没绑定"、发送报 5100。备份 `web_backend.json.bak-kinship-20261115-202919` 后原子写 `dsh`；`get_web_backend()=dsh`、`acquire_web_client()=DshClient`、旧 id `ses_6320…` 的历史请求被归一到绑定会话 |
| 20:36 | 修会话面 | 仅改 W30 状态文件还不够：`/session/list` 没有 dsh 腿、且把带 `loom:main-task` 绑定的旧会话标 `backend:"loom"`，前端于是把 `backend=loom` 显式塞进发送请求 → 直调已停用的 Loom（日志 `[LOOM-CLIENT] session=ses_6320…` + 5100）。代码修复（W52）：`/session/list` 增 dsh 聚合腿（bridge 绑定会话）、`current_session` 取该 id、dsh 模式下本地条目一律归 dsh、全局 dsh 时忽略显式 loom/opencode、Loom 腿不探活；4 条新测试先红后绿（stash 实现验证），相关 105 条全绿；重启后端（PID 2218881）后实测 `current_session=session-2f8b68aa…`、`partial=[]`、dsh 行首位 |
| 21:02 | 冷会话 E2E | 测试栈：起 dsh 建会话 A → 按 PID 停 → `KEEP_BINDING=1` 重启（**不打开任何 dsh UI 会话**）→ `/v1/health` 直接 `status:"bound"`（session A）、`/v1/session` 与 `/v1/session/messages` 均 200；同启动的 probe 新会话 B 未被改绑；主仓后端连测试栈发消息收到回复（`只回复一个字：好` → `好`） |
| 21:05 | W53 热切换实测 | 测试栈（主仓后端）：`PUT /api/system/config` 切 `loom` → `applied` 含 `ai_surface`、Loom 探针启动、dsh 探针停（unknown）；切回 `dsh` → 反向成立，`/session/list` `current_session` 仍为绑定会话、`partial=[]` |
| 21:06 | 部署 W53+W54 | 生产 profile 插件备份 `/mnt/d/tmp-opencode/dsh-web-plugins-bak/web-plugins-20261115-210605.tgz` → `sync-profile.sh web` 同步 resume 版 bridge；后端热重启（新 PID 2258115）：`[AiSurface] ai_backend=dsh：健康探针已按生效通道对齐`、`[WebBackend] 旧状态文件已归档 …（legacy=dsh, effective=dsh）`、`[Config] 热应用器已注册: ai, ai_surface, audio, …`；`/health` dsh online / loom `unknown`、`/api/screen/backend` 返回 3 个选项、POST 410；21:06 起 LoomHealth WARN 计数 0。dsh 进程需重启才加载 resume 版 bridge（本页第 4 节） |

## 4. B 段：重启 dsh（已完成 20:15）

> 这一步会中断 dsh UI 及其宿主的所有会话，**包括发起操作的对话**。重启后会话是耐久的，
> 重新打开对应会话即可继续。

```bash
sudo systemctl restart axeuh-dsh
```

验证：

```bash
journalctl -u axeuh-dsh -n 80 --no-pager        # 无 error（插件的 ctx.logger 不进 journal，属正常）
ss -lnt | grep 18765                            # bridge 已监听
ls -l <dsh-home>/kinship/bridge-token           # 令牌文件已生成（0600）
TOKEN=$(cat <dsh-home>/kinship/bridge-token)
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:18765/v1/health   # ok=true, status=unbound
```

UI 检查：左侧栏出现 **Kinship**；设置里的预设列表出现 **Kinship** 卡片；面板可打开（此时未绑定）。

## 5. 会话隔离：Kinship 会话不继承 AGENTS.md

隔离在组合层完成，已用生产 profile 的 `--dump-config` 验证：

- `dsh-web-app` 把 `dsh-base` 的根级 `agent-instructions` 行置为 `disabled: true`；
- 每个 Web preset 自己挂 `@deepseek-ai/dsh-agent-instructions`；
- `kinship` preset **不挂**这一行 → Kinship 会话不会读到 `$DSH_HOME/AGENTS.md`、
  `<agents-home>/AGENTS.md`，也不会读工作区项目链的 `AGENTS.md`；指令面只有
  `ai/agents/main.md`（persona prefix，`complete:false`）。
- `dsh-plugin-global-prompt` 只是编辑 `$DSH_HOME/AGENTS.md` 里的标记块，注入仍由同一个
  instruction loader 完成，所以同样被隔离。
- 回归测试：`harness-plugins/tests/unit/preset.test.ts` 断言 preset 与 bundle patch 都不含
  `id: agent-instructions`。

若要修改 Kinship 会话的指令，只改 `ai/agents/main.md`（或 preset 的 persona 行）；改
`dsh-home/AGENTS.md` 不会影响它。

## 6. C 段：建立并绑定会话（已完成 20:17）

1. 打开 dsh UI（`https://dsh.xehuri.top:8443/` 或 `:3080` 本机）。
2. 新建/复用工作区，路径 `kinship-data/ai`（标题建议 `kinship`）。
3. 新会话选择预设 **Kinship**，模型沿用默认（`xehuri-api / deepseek-flash / max`）。
4. 打开左侧栏 **Kinship** 面板，确认：绑定状态「已绑定」、会话标题正确、cwd 为 AI 根。
5. 点「显示令牌」并「复制」；点片段区「复制」拿到 `config.yaml` 片段。**不要**把 token 写进
   任何日志或聊天记录。

运行规则：**dsh 每次重启后，先在 UI 里打开一次该会话**（让它变 live），bridge 才能继续服务；
否则面板显示「绑定会话已丢失」，后端 `/health` 的 `dsh` 会 degraded。

## 7. D 段：切换生产后端（已完成 20:20，热切换）

先 dry-run（需要现有管理员 Bearer 或密码，按当前 auth 配置）：

```bash
PUT /api/system/config
{
  "changes": {
    "ai_backend": "dsh",
    "dsh.url": "http://127.0.0.1:18765",
    "dsh.token_file": "/mnt/d/Users/Axeuh/Desktop/Axeuh-server/dsh-home/kinship/bridge-token",
    "dsh.timeout_seconds": 30
  },
  "dry_run": true
}
```

确认 `errors` 为空后去掉 `dry_run` 正式保存，检查响应 `applied` 含 `ai`、`failed` 为空。
`apply_ai` 会重置 DshClient 单例并重建 dsh 事件 hub；loom/opencode 两槽在飞的 SSE 流会收到
收尾哨兵并由前端重连。

验收：

- `GET /health`：`ai_backend=dsh`、`dsh.status=online`、`dsh.session_id` 与面板一致。
- Kinship Web UI：发一条消息看流式渲染；历史分页；手动压缩；手动触发一个定时任务确认
  调度链路走 DshClient。

### 7.1 后端选择已收敛为单一真源（W53，2026-11-15 21:06 部署）

W30 曾给 Web 对话管线单开一个状态文件 `web_backend.json`，于是同一部署有**两层**判据（全局 `ai_backend` 与状态文件），20:29/20:36 两次事故都是它们不同步造成的。W53 起只有一层：

| 层 | 选择来源 | 影响 |
|---|---|---|
| 全部 | `config.yaml` 顶层 `ai_backend` | 聊天端点、SSE hub、健康探针、编排器 Loom 期望态、`/health`、`/api/screen/backend` |

- `get_web_backend()` 恒等于 `get_ai_backend()`；切换入口只有配置（设置页 / `PUT /api/system/config`，写操作需密码二次校验）。
- 旧状态文件不再参与判定：启动时归档为 `web_backend.json.deprecated-<stamp>`（生产已归档 `...-20261115-210626`）。
- `POST /api/screen/backend` 返回 410（避免绕过配置写入的密码校验）；`GET` 保留为只读回显。
- 切换即时生效：`ai_backend` 是 hot 策略——`apply_ai` 重建客户端/事件 hub，`apply_ai_surface` 起停健康探针并对齐编排器的 Loom 期望态（切入 loom 会拉起 Loom，切走会停 Loom）。**不需要重启后端**。

验证：

```bash
curl -sk https://127.0.0.1:8768/health | jq '{ai_backend, loom: .loom.status, dsh: .dsh.status}'
curl -sk -H "Authorization: Bearer <token>" https://127.0.0.1:8768/api/screen/backend
# => {"ok":true,"backend":"dsh","options":["opencode","loom","dsh"]}
```

- **会话面（W52，2026-11-15 20:36 起）**：`/session/list` 有 dsh 聚合腿——`current_session`
  取 bridge 绑定会话，`sessions` 首位是该会话（`backend:"dsh"`），本地历史条目在 dsh 模式下
  一律归 dsh；前端对 `dsh` 标签不发送显式 backend，于是落回 Web 通道。
  另外全局 `ai_backend=dsh` 时，后端会忽略请求里的显式 `backend: "loom"|"opencode"`
  （日志 `[Session] 全局后端为 dsh，忽略显式通道请求`），并对 Loom 腿不探活、不计 partial。
  因此不再需要前端清缓存或删旧会话。
- `usersessions.json` 里旧的 `ses_…` 主会话 id 不用清理：`DshClient` 一律把调用方传入的
  session id 归一到 bridge 绑定会话（历史/发送/状态同语义）。
- **冷会话（W54，2026-11-15 21:06 代码部署）**：dsh 重启后 bridge 启动预热 + 请求期懒恢复
  （`ensureBoundSession` → `sessionController.resolveAgent`，与 UI 打开会话同一条路径），
  不需要人工打开 Kinship 会话；测试栈实测见 3.1 表 21:02 行。

## 8. 计划调度器上线（kinship-plan-scheduler，2026-11-15）

这一段只装一个新的 Host 行，不改后端配置、不改 `ai_backend`、不动 bridge：
`kinship-plan-scheduler` 把 Loom 的计划调度器搬进 dsh，读生产已经在用的
`plan/master.json` 与当日 `plan-{date}.overlay.json`，按锚点对账，把唤醒写成
绑定会话里的普通用户消息。设计与全部差异见
[harness-plugins/packages/kinship-plan-scheduler/docs/DETAIL.md](../../harness-plugins/packages/kinship-plan-scheduler/docs/DETAIL.md)。

### 8.1 步骤

1. 构建（Node 24）：`cd harness-plugins && npm run verify`（typecheck + build +
   316 个用例 / 28 个文件）。
2. 同步进 profile（`sync-profile.sh` 现在拷六个包 + bundle patch）：

   ```bash
   DSH_HOME=/mnt/d/Users/Axeuh/Desktop/Axeuh-server/dsh-home \
     bash harness-plugins/scripts/sync-profile.sh web
   # 期望输出 6 行 [sync] <package> 加 [sync] kinship-harness-plugins / [sync] profile: …
   ```

3. bundle 行：`cordis.patch.yml` 已新增 `id: kinship-plan-scheduler`（带
   `KINSHIP_PLAN_*` 驱动的 config）。只要 profile 的 `dsh.profile.bundles` 里有
   `kinship-harness-plugins`，**重启后这一行自动出现**，不需要手改 profile。
4. 可选环境变量（写 `/etc/axeuh-dsh/env`；都有默认值，不配也能跑）：

   | 变量 | 默认 | 用途 |
   |---|---|---|
   | `KINSHIP_PLAN_MODE` | `live` | `live` / `shadow` / `off` |
   | `KINSHIP_PLAN_STATE_DIR` | `$DSH_HOME/kinship/state` | 队列与影子文件根 |
   | `KINSHIP_PLAN_TIMEZONE` | `Asia/Shanghai` | 母版时区缺省 |
   | `KINSHIP_PLAN_ANCHORS` | `05:00,07:30` | 每日对账锚点，逗号分隔 |
   | `KINSHIP_PLAN_WATCHDOG_MS` | `60000` | 看门狗间隔，`0` 关闭 |
   | `KINSHIP_PLAN_HORIZON_HOURS` | `48` | 向前排多久 |
   | `KINSHIP_PLAN_CATCHUP_MAX_AGE_HOURS` | `8` | 迟到但仍按原时刻投递的窗口 |
   | `KINSHIP_PLAN_DEBT_AFTER_HOURS` | `24` | 超过即记为 debt 跳过 |
   | `KINSHIP_PLAN_ROOT` | `KINSHIP_AI_ROOT/data` | 计划根；生产 §3 A 段已配 |

5. 重启 dsh（**由你执行**）：`sudo systemctl restart axeuh-dsh`。同步脚本只写
   profile 的 `node_modules`，新行要等 dsh 进程重启（或 HMR 重载该 profile）才加载。
6. 默认 `KINSHIP_PLAN_MODE` 不配就是 `live`：重启后引擎立即开始对账与投递。想先
   观察就显式配 `shadow`（只写影子文件、不投递），确认无误再改回 `live`。

   **首次 `live` 启动会补做当天已过时的档位**（这是 Loom 的 catchup 语义，不是故障）：
   重启时刻落在当天 12:00 之后时，`plan.build`/`plan.review`/`daily-review`/`weather`/
   `long_term` 等已过时且仍在 `debtAfterHours`（24h）内的条目会各投一条迟到唤醒，
   7 个 coverage 检查点里超过 8h 的会合并成一条「补覆盖」唤醒，其余按原时刻立即投递；
   最坏情况下重启后 1 分钟内会有 ~8-10 条 `【计划唤醒…】` 进入绑定会话。
   **实际以当天 overlay 的完成状态为准**：`update … status: done` 的条目是终态、不会补投。
   2026-11-15 23:05 生产首次 `live` 重启实测：当天 overlay（v20）已把
   `daily-review/compactor/plan-build/weather/plan-review/cov-00/06/08/12/16/20/biweekly/lt_soak_7d`
   全部标 done，只有最后一个检查点 `cov-22` 仍是 planned → **只补投了 1 条**
   `【计划唤醒·coverage.run】22:00 · 覆盖检查点 cov-22`（23:05:35 进会话），
   随后 48h 视界内排好 27 条待投（次日 00:00 起）。想进一步降低噪声的三个选项：
   （a）先 `KINSHIP_PLAN_MODE=shadow` 重启一次观察、再切 `live`；
   （b）选一个当天档位基本跑完的时刻（例如 23:00 之后或 00:35 之前）重启，噪声最小；
   （c）临时把 `KINSHIP_PLAN_CATCHUP_MAX_AGE_HOURS=0`、`KINSHIP_PLAN_DEBT_AFTER_HOURS=1`
   一起配上重启（只投最近 1 小时内的档位），稳定后再去掉这两个变量重启一次。
   次日 00:40 之后是所有档位重新开始的时刻，所以任何重启都会在当天自然收敛。

### 8.2 验证

```bash
# 1) profile 组合里已有该行（重启前就能验）
dsh --profile web --dump-config | grep -c 'id: kinship-plan-scheduler'   # => 1
# 2) 引擎在跑：绑定会话后队列文件出现，内容是 schema 2 的 pending/delivered
ls -l <dsh-home>/kinship/state/session/wake-queue/
python3 -c "import json,glob; [print(p, 'pending', len(json.load(open(p))['entries']), 'delivered', len(json.load(open(p))['delivered'])) for p in glob.glob('<dsh-home>/kinship/state/session/wake-queue/*.json')]"
```

判据是**面板与队列文件**，不是 journal：这个 dsh 构建不把插件的 `ctx.logger` 写进
stdout/journal（`journalctl -u axeuh-dsh` 里只有每行的 `dsh web:`），所以看不到
`kinship-plan-scheduler: engine ready` 属于正常现象，不代表引擎没起来。

- 面板：左侧栏 **Kinship** → 页面底部「计划排班」卡片，应显示 mode=live、
  planRoot=`…/kinship-data/ai/data`、stateDir=`<dsh-home>/kinship/state`、时区、
  锚点 `05:00` / `07:30`、主排班表（18 条）与下次唤醒；点「立即对账」应返回
  新增/更新/取消计数。
- 隔离环境的同款断言脚本在 kinship-test：`scripts/ui/plan-panel.mjs`（见该仓
  README），它证明路由可读、写盘版本递增、禁用条目从 `next` 消失、且 2 分钟后的
  唤醒真的进了绑定会话。
- 回滚演练（2026-11-15 在隔离栈实测）：`KINSHIP_PLAN_MODE=off` 起 dsh 后，
  `GET /api/kinship/ui/plan` 仍 200 且 `scheduler.mode=off`，四个写/对账路由一律
  409 `scheduler_disabled`，不产生队列文件。
- 生产首次上线实测（2026-11-15 23:05 重启）：bridge `/v1/health` 立刻 `bound`；
  队列文件 `session-2f8b68aa-….json` 生成（delivered 1 / pending 27）；
  会话消息与后端 chatlog 都出现该唤醒——`GET /api/screen/session/chatlog`
  返回 `backend=dsh, source=dsh_bridge`，其中 23:05:35 的 user 消息就是
  `【计划唤醒·coverage.run】22:00 · 覆盖检查点 cov-22`。`plan/master.json` 未被改动
  （version 仍 1、updated_at 仍是 2026-10-27）。
- 文案修复时差：2026-11-15 23:05 这次重启加载的是 22:48 同步的构建，coverage 唤醒里
  仍带旧的「完成后 plan done。」一句；`7aa542f` 先修掉与尾部提示重复的那句，W58
  （路径推送）又按生产实测把尾行改成**不指派回写工具**（`plan note` 在 v1 账 closed /
  版本冲突时同样失败）。两笔修复都已重新同步进 profile。W59 起 overlay 写回落地，
  尾行恢复 Loom 的 `完成后执行 plan done（date=…, id=…）`，见 §8.6。
- 出问题时看**面板**的降级提示（`scheduler.degraded` / `lastError`）与
  `{planRoot}/daily/{date}/plan-ledger.jsonl` 里 `source: scheduler` 的行
  （`deferred_no_session`、`master_error`、`overlay_error`、queue_error 等）；
  journal 里没有这些行是正常的（见上）。

### 8.3 对生产计划文件的影响

- 生产 `plan/master.json` 现在是 schema 1 / version 1 / **18 条**（10 `fixed`、
  7 `anchor`、1 `long_term`，mtime 2026-10-28）。本次上线**不修改**它，也不改
  `master.md`、`master.last-good.json` 和任何 `daily/{date}/plan-{date}.json`
  或 overlay。
- 引擎只读计划文件。唯一的写入口是面板编辑：保存时写 `master.json`（版本 +1）
  并派生 `master.md` / `master.last-good.json`。
- 对账的异常事实（deferred、master 回退、overlay 错误、debt 跳过、队列错误）会
  追加到 `kinship-data/ai/data/daily/{date}/plan-ledger.jsonl`，行内
  `source: "scheduler"`。
- 运行状态（唤醒队列、影子文件）落在 `<dsh-home>/kinship/state`，不进
  `kinship-data/`。

### 8.4 回滚

- 软关（推荐）：`/etc/axeuh-dsh/env` 加 `KINSHIP_PLAN_MODE=off`（或 `shadow`），
  `sudo systemctl restart axeuh-dsh`。`off` 不建引擎、不排队、不投递；面板仍可读，
  写路由返回 409 `scheduler_disabled`。
- 硬撤：从 profile `package.json` 的 `dsh.profile.bundles` 移除
  `kinship-harness-plugins` 并删除 profile `node_modules/kinship-*`，重启 dsh；
  或只删 `cordis.patch.yml` 里的 `kinship-plan-scheduler` 行后重新
  `sync-profile.sh web` 再重启。bridge 与面板不受影响（面板的计划卡片会提示
  调度器未安装）。
- 回滚不碰计划文件：移植引擎是加法件，不改 `master.json`（只有面板编辑才写），
  不写日计划与 overlay。`<dsh-home>/kinship/state` 下的队列与影子文件可以留着，
  再次启用且会话 id 相同时会继续用同一队列文件。

### 8.5 路径同步（2026-11-15 晚，W58）

计划根不再需要在 dsh 侧显式配置：Kinship 后端把自己的 `data.ai_root` /
`data.dir` 经 bridge 推过来。

- 链路：后端 `services/dsh_paths.py` → `POST {DSH_URL}/v1/kinship/paths`
  （Bearer 同 bridge token）→ bridge 原子写 `<dsh-home>/kinship/paths.json`（0600）
  → 发 `kinship/paths` 事件 → 调度器启动读文件、事件到达重新解析。
- 触发点：后端启动（`boot`）、`data_paths` 配置应用（`data_paths`）、
  切到 `ai_backend=dsh`（`ai_surface`）、dsh 健康探针 `offline→online`（`health`，
  覆盖 dsh 重启）。同一秒内的多次触发合并成一次推送；失败只记 warning，不影响启动。
- 优先级：推送的 `plan_root` > 行配置 > `KINSHIP_PLAN_ROOT` > `KINSHIP_AI_ROOT/data`。
  因此上线后 `/etc/axeuh-dsh/env` 里的 `KINSHIP_PLAN_ROOT` 可以从“必配”降级为
  “兜底”（先保留，等面板来源显示为「kinship 后端推送」后再决定是否删除）；
  `KINSHIP_AI_ROOT` 仍保留（persona 在会话装配时读它）。
- 上线顺序：先重启 dsh（加载 bridge 路由 + 新调度器 + 面板），再重启后端
  （加载推送钩子）。后端重启后首探即 `online`，会立刻推一次；
  若先重启后端，旧 bridge 没有该路由，只会多一条 warning，随后 dsh 重启后下一次
  探针上线会再推一次，最终一致。
- 验证：`cat <dsh-home>/kinship/paths.json` 应含 `data_dir`/`plan_root`；
  面板「计划排班」的计划根来源显示 `kinship 后端推送（时间）`；后端日志出现
  `[DshPaths] pushed plan_root=… reason=health`（或 `boot`）。
- 回滚：删 `<dsh-home>/kinship/paths.json` 并重启 dsh，即回到 env/默认回落；
  后端推送钩子是加法件，不推送也不影响既有路径解析。

### 8.6 W59（2026-11-16）：覆盖层写回 + `compact_context` + QQ 入站修复

这一段动 dsh 侧的插件包与数据侧脚本，另有一处后端改动（ScriptRunner 的
per-script 触发频率覆盖，见第 2 步）；后端配置与 `ai_backend` 不变。

1. 构建与同步：`cd harness-plugins && npm run verify`（typecheck + build + 316 个用例
   / 28 个文件）→ `DSH_HOME=<dsh-home> bash harness-plugins/scripts/sync-profile.sh web`
   （现在拷六个包，新增 `kinship-compact`）。
2. 重启 dsh：`sudo systemctl restart axeuh-dsh`。`/etc/axeuh-dsh/env` 不用改；
   `presets/kinship.patch.yml` 的 compaction 组里新行 `compact-context` 随 profile
   patch 生效，`--dump-config` 的 preset 展开里能看到它。
   `backend/services/script_runner.py` 的 per-script `trigger_rate_per_min` 是后端
   进程内代码，需要**再重启一次后端**（`sudo systemctl restart axeuh-health`）才生效；
   2026-11-16 00:52 已重启，QQ 中继的两连发探针验证通过（两条都出现在
   `触发任务: target=main-task`，无速率限制告警）。之后中继脚本（数据侧）改动只走
   5 秒热加载，不再需要重启后端。
3. 验证 A（计划写回）：在绑定会话里对母版条目执行 `plan done` 与 `plan note`。
   `plan done` / `plan note` 在当日 v1 账缺失或 closed 时可省略 `expected_version`；
   若当日有未关闭的 v1 账，先 `plan_read` 拿它的当前版本再传（缺参数或版本不匹配
   会返回带当前版本的校验错误，不会悄悄写覆盖层）。判据：
   - `daily/{date}/plan-{date}.overlay.json` 出现/递增：`base_version` 等于
     `plan/master.json` 的 `version`，`coverage.profile` 为 `merged_7`、
     `coverage.checkpoints` 是母版 anchor id，`ops` 里是目标 id 的
     `update` patch（`status` / `evidence` / `done_at`）；
   - `daily/{date}/plan-ledger.jsonl` 多出 `source: "plan"` 的两行（`event: "done"`
     带 `entry_id`/`status`/`version`，`event: "note"` 带 `reason`/`version`）；
   - `plan_overlay_read` 返回 `source: "overlay"` 与新版本号、条目状态为 `done`。
   2026-11-16 隔离栈（真实模型）实测：`plan done` 建出当天 overlay **v2**
   （`update` op + evidence + `done_at`），`plan note` 升到 **v3** 并追加 note，
   ledger 两行齐全。
4. 验证 B（压缩）：主会话调用 `compact_context` 应返回
   `Compaction scheduled: it runs when this turn ends.`；回合结束后
   `GET /v1/session/compaction` 变 `status: "active"`、`covered_count=50`、
   摘要文本非空（隔离栈实测）。
5. 验证 C（QQ 入站，同一时间修复）：私聊中继 `ai/data/tasks/qq_private_relay.py`
   改为走**脚本正规通道** `context.trigger_task`（后端 ScriptRunner 按 `ai_backend`
   路由到主会话，中继不再自己打 dsh bridge / Loom HTTP）；中继 frontmatter 加
   `trigger_rate_per_min: 20`，`backend/services/script_runner.py` 支持 per-script
   覆盖（默认仍 1 次/分钟）。仓库根 `qq` wrapper 改用 `QQ_CLI_PYTHON`（缺省用已安装
   venv），不再 exec 已不存在的 `/opt/kinship/.venv-health/bin/python`。判据：中继
   热加载日志出现 `投递通道: 脚本 trigger_task`；后端日志出现
   `触发任务: target=main-task`；主会话收到 `【脚本任务】QQ私聊转发` 消息；模型回复
   经 `qq send` 发出。已实测：中继热加载后探针脚本触发成功；随后同一分钟内两次
   trigger 均被接受（旧代码的 1 次/分钟限制已解除）。
6. 提交：`5ed8ec8`（overlay 写回 + 唤醒尾行恢复）、`88f6460`（`compact_context`）、
   `f925741`（`plan done` 可省版本）、`c9e88ff`（`qq` wrapper）、`699f763`（W59 文档）、
   `4ce84e5`（QQ 中继改 trigger_task + per-script 触发频率）。
   中继脚本属于数据侧，不入公开仓。
7. 回滚：从 `presets/kinship.patch.yml` 去掉 `compact-context` 行并重新
   `sync-profile.sh web` + 重启 dsh，即回到"只有自动压缩与 `/compact`"；覆盖层只是
   note/done 的回退目的地，v1 真源不动，回滚也不会改已写出的 overlay 文件。
   整体软关排班仍是 `KINSHIP_PLAN_MODE=off`（§8.4）。

## 9. E 段：回滚

- 回滚：把 `ai_backend` 改回 `loom`（热生效）——`apply_ai_surface` 会在同一次应用里按新期望态
  拉起 Loom（`orchestrator.start("loom")`，只碰 loom 单服务），**不需要重启后端**；核对
  `/health` 的 `loom.online` 与 `status=healthy`。切回 `dsh` 同样即时停 Loom。
  仅当编排器处于 `off` 模式（`AXEUH_ORCHESTRATOR=off`）时不会自动拉起，需要手动起 Loom 或
  恢复编排器模式。
- `dsh.*` 可保留（不影响 loom 路径）；dsh 侧的 bundle/preset 也可保留（bridge 空闲监听无害）。
- 彻底撤销 dsh 侧：从 profile `package.json` 的 `dsh.profile.bundles` 移除
  `kinship-harness-plugins`，删除 profile `node_modules/kinship-*`，重启 dsh；
  环境变量可保留（只对 bundle 有意义）。

## 10. 已知限制与注意

- **探针生命周期跟随后端（W53 起）**：`apply_ai_surface` 在启动与热切换共用一份实现——dsh 探针
  只在 `ai_backend=dsh` 时跑、Loom 探针只在 `loom` 时跑，非当前通道保持 `unknown`（不再刷
  假离线告警）；停止探针时缓存归 unknown，不把停止观测前的最后一帧当结论。
- **Loom gate 仍只在服务启动时判定**，但热切换已由 applier 主动对齐（只 `stop/start loom`，
  不重启 kernel/moss/qq）；编排器 `off` 模式下不动作。
- **两层选择器已不存在**：`web_backend.json` 退役归档、`POST /api/screen/backend` 410；
  唯一的切换入口是配置（写操作需密码），详见第 7.1 节。
- **冷会话已自动恢复（W54）**：bridge 启动预热 + 请求期懒恢复；只有运行时明确回答
  `session/not-found` 才回落到 `bound_session_missing`，其它恢复失败是 409
  `bound_session_unavailable`（需要人/配置介入，不是瞬时重试）。没有 web 组合
  （headless profile，无 `sessionController`）时 bridge 不预热，行为与改动前一致。
- **启动期 Loom 噪声已消除**：20:24:43 那条来自仍直连 Loom 的启动路径；dsh 模式下 Loom 探针
  现在不启动，21:06 之后 LoomHealth WARN 为 0。
- **chatlog 的单会话语义（W55，2026-11-15 21:2x 修正）**：`query_chatlog.py` 经
  `/api/screen/session/chatlog` 走全局 `ai_backend`。dsh 分支现在强制目标是 bridge
  绑定会话：省略 `session_id` 即可查；显式传入不一致的旧 id 返回 409 并在文案里给出
  绑定 id（不再静默替换、不再把内容错记到旧会话）；`include_children` 在 dsh 下标
  `children_unsupported: true` 并跳过，绝不用父会话内容冒充子会话历史。响应新增
  `requested_session_id` / `resolved_by` / `children_unsupported` 三个只增字段。
- **chatlog 可选通道（W56，2026-11-15 21:4x）**：`GET /api/screen/session/chatlog` 新增
  可选 `backend=opencode|loom|dsh`，`query_chatlog.py` 对应新增 `--backend`。缺省仍跟随
  `ai_backend`。`loom` 腿**离线**读 Loom 追加式主会话日志
  `<AI_ROOT>/.loom/session/loom-main.jsonl`（不要求 Loom 进程在线；反向分块扫描，
  两小时窗约 0.05s、整月约 1.4s/2 万轮次，超过 4000 条只回最近 N 条并标 `truncated`）；
  它只覆盖主会话、不扫 `.bak-*` 轮转备份，`include_children` 标不支持。响应再增
  `backend` / `source`（`dsh_bridge` / `loom_jsonl` / `engine`）两个只增字段。
- **令牌来源**：当前用插件生成的文件，可在面板显示/轮换；若改成环境变量来源，面板会拒绝轮换
  （409 `token_env_managed`）。
- **面板保存语义**：从面板保存桥接配置会写 profile 的完整覆盖，bundle patch 里 env 驱动的字段
  会被固定成保存值；长期用 env 管理就不要点保存。
- **bridge 不出网**：不要把它挂到 Caddy/frps；公网只暴露 dsh UI。
- **插件组合**：Kinship 会话的插件面由 preset 决定；profile 里的 auto-memory/login/market 等
  根级插件不进入该会话的工具面，但它们自己的 prompt 注入是否影响要看各自实现（当前没有
  额外 AGENTS.md 类注入）。

## 11. 相关文件

- [harness-plugins/README.md](../../harness-plugins/README.md)：插件、面板 API、测试
- [harness-plugins/packages/kinship-plan-scheduler/docs/DETAIL.md](../../harness-plugins/packages/kinship-plan-scheduler/docs/DETAIL.md)：计划调度器设计、配置表与移植差异
- [harness-plugins/packages/kinship-plan/docs/DETAIL.md](../../harness-plugins/packages/kinship-plan/docs/DETAIL.md)：日计划工具与覆盖层写回（`plan_note` / `plan_done` / `plan_overlay_read`）
- [harness-plugins/packages/kinship-compact/docs/DETAIL.md](../../harness-plugins/packages/kinship-compact/docs/DETAIL.md)：`compact_context` 工具、延迟触发与配置
- [docs/dev/ai-runtimes.md](../dev/ai-runtimes.md)：运行时定位与能力对比
- [docs/dev/adapter-contract.md](../dev/adapter-contract.md)：适配器契约与适配器 UI 约定
- [docs/ops/CONFIGURATION.md](CONFIGURATION.md)：`ai_backend` / `dsh.*` 配置键
- [docs/ops/system-config-hot-reload.md](system-config-hot-reload.md)：热更新策略矩阵
