# 将 Kinship 的 AI 切到生产 dsh：接入手册

> 适用：本机同机部署（Kinship 后端与 dsh 在同一台机器）。跨机场景不适用——适配器契约要求
> bridge 只监听 loopback，公网 URL 只是给人用的 Web UI。
>
> 目标实例：systemd `axeuh-dsh`，profile `web`，`DSH_HOME=/mnt/d/Users/Axeuh/Desktop/Axeuh-server/dsh-home`，
> UI `127.0.0.1:3080`，公网 `https://dsh.xehuri.top/`（IPv4 443）与 `https://dsh.xehuri.top:8443/`（IPv6 直连）。
>
> 状态（2026-11-15 20:20）：A–D 已完成并验证，生产 `ai_backend` 已是 `dsh`；E 为回滚预案。
> 两个待收尾项：`/health` 的 `dsh` 探针要等一次后端重启才会出现；Loom 仍是运行中（编排器只在启动时判定 gate），
> 事实见第 3.1 节与第 9 节。

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

## 8. E 段：回滚

- 热回滚：`PUT /api/system/config {"changes":{"ai_backend":"loom"}}`。编排器 gate 恢复后会
  重新拉起 Loom（新起需要几秒）；核对 `/health` 的 `loom.online`。
- `dsh.*` 可保留（不影响 loom 路径）；dsh 侧的 bundle/preset 也可保留（bridge 空闲监听无害）。
- 彻底撤销 dsh 侧：从 profile `package.json` 的 `dsh.profile.bundles` 移除
  `kinship-harness-plugins`，删除 profile `node_modules/kinship-*`，重启 dsh；
  环境变量可保留（只对 bundle 有意义）。

## 9. 已知限制与注意

- **`/health` 的 dsh 探针**只在后端启动时按 `ai_backend` 启动；热切换后 `dsh` 字段为 `null`
  （`apply_ai` 不管理探针生命周期）。重启一次后端（或等下一次自然重启/重启机器）即恢复
  `dsh.status=online`。AI 路径本身不受影响。
- **Loom 编排 gate**只在服务启动时判定：热切到 dsh 后 Loom 进程仍在运行（对回滚是好事），
  同时旧 Loom 客户端的后台循环会继续每分钟打印会话绑定日志。后端重启后编排器才会把它
  判 blocked 并停用。
- **热回滚到 loom** 现在可用（Loom 仍在跑）；若后端已在 dsh 模式下重启过，Loom 已停，
  热回滚后需要用现有 Loom 启动端点或再重启一次后端让编排器拉起。

- **冷会话**：bridge 只认 live agent；dsh 重启后需要打开一次 Kinship 会话（见第 6 节）。
- **令牌来源**：当前用插件生成的文件，可在面板显示/轮换；若改成环境变量来源，面板会拒绝轮换
  （409 `token_env_managed`）。
- **面板保存语义**：从面板保存桥接配置会写 profile 的完整覆盖，bundle patch 里 env 驱动的字段
  会被固定成保存值；长期用 env 管理就不要点保存。
- **bridge 不出网**：不要把它挂到 Caddy/frps；公网只暴露 dsh UI。
- **Loom 停用**：切到 dsh 后 Loom gate 变 blocked（已接受），回滚需要重新拉起。
- **插件组合**：Kinship 会话的插件面由 preset 决定；profile 里的 auto-memory/login/market 等
  根级插件不进入该会话的工具面，但它们自己的 prompt 注入是否影响要看各自实现（当前没有
  额外 AGENTS.md 类注入）。

## 10. 相关文件

- [harness-plugins/README.md](../../harness-plugins/README.md)：插件、面板 API、测试
- [docs/dev/ai-runtimes.md](../dev/ai-runtimes.md)：运行时定位与能力对比
- [docs/dev/adapter-contract.md](../dev/adapter-contract.md)：适配器契约与适配器 UI 约定
- [docs/ops/CONFIGURATION.md](CONFIGURATION.md)：`ai_backend` / `dsh.*` 配置键
- [docs/ops/system-config-hot-reload.md](system-config-hot-reload.md)：热更新策略矩阵
