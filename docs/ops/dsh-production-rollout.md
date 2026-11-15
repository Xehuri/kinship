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
| 插件包源码与构建 | `server/kinship/harness-plugins`（`packages/{kinship-bridge,kinship-ui,kinship-plan,kinship-task-compat}` + `presets/kinship.patch.yml`） |
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
journalctl -u axeuh-dsh -n 80 --no-pager        # 无 error；有 kinship-bridge listening 日志
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

## 8. E 段：回滚

- 回滚：把 `ai_backend` 改回 `loom`（热生效）——`apply_ai_surface` 会在同一次应用里按新期望态
  拉起 Loom（`orchestrator.start("loom")`，只碰 loom 单服务），**不需要重启后端**；核对
  `/health` 的 `loom.online` 与 `status=healthy`。切回 `dsh` 同样即时停 Loom。
  仅当编排器处于 `off` 模式（`AXEUH_ORCHESTRATOR=off`）时不会自动拉起，需要手动起 Loom 或
  恢复编排器模式。
- `dsh.*` 可保留（不影响 loom 路径）；dsh 侧的 bundle/preset 也可保留（bridge 空闲监听无害）。
- 彻底撤销 dsh 侧：从 profile `package.json` 的 `dsh.profile.bundles` 移除
  `kinship-harness-plugins`，删除 profile `node_modules/kinship-*`，重启 dsh；
  环境变量可保留（只对 bundle 有意义）。

## 9. 已知限制与注意

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
- **令牌来源**：当前用插件生成的文件，可在面板显示/轮换；若改成环境变量来源，面板会拒绝轮换
  （409 `token_env_managed`）。
- **面板保存语义**：从面板保存桥接配置会写 profile 的完整覆盖，bundle patch 里 env 驱动的字段
  会被固定成保存值；长期用 env 管理就不要点保存。
- **bridge 不出网**：不要把它挂到 Caddy/frps；公网只暴露 dsh UI。
- **插件组合**：Kinship 会话的插件面由 preset 决定；profile 里的 auto-memory/login/market 等
  根级插件不进入该会话的工具面，但它们自己的 prompt 注入是否影响要看各自实现（当前没有
  额外 AGENTS.md 类注入）。

## 10. 相关文件

- [harness-plugins/README.md](../../harness-plugins/README.md)：插件、面板 API、测试
- [docs/dev/ai-runtimes.md](../dev/ai-runtimes.md)：运行时定位与能力对比
- [docs/dev/adapter-contract.md](../dev/adapter-contract.md)：适配器契约与适配器 UI 约定
- [docs/ops/CONFIGURATION.md](CONFIGURATION.md)：`ai_backend` / `dsh.*` 配置键
- [docs/ops/system-config-hot-reload.md](system-config-hot-reload.md)：热更新策略矩阵
