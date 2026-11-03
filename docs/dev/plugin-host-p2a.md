# Loom Feature Plugin P2a：trusted 本地外部插件

状态：已实现
范围：从绝对本地路径加载 trusted 外部插件（P2a）
不包含：沙箱、npm/git 安装、lockfile、市场 API/UI、独立进程 runtime

## 1. 目标与边界

P2a 只解决一件事：让用户把**自己信任的本地 `.mjs` 模块**声明进 `loom.yaml`，由
Loom 在 boot 时进程内加载，并复用既有 PluginHost / PluginContext 契约。

明确不做：

- 不做沙箱、不做 capability RPC、不做独立进程。
- 不做 npm/git 安装、版本锁定、更新/回滚、签名/审核。
- 不做市场 API/UI。
- 不暴露原始 EventHub、WakeQueue、store、router、SessionRegistry、模型/provider 对象。

## 2. 安全警告（必读）

外部插件模块的**顶层代码**与 `setup()` 都在 Loom 进程内执行，拥有与 Loom 进程
**完全相同的权限**（文件系统、网络、子进程、环境变量等）。P2a 的权限检查只约束
`PluginContext` 暴露的注册/存储/事件接口，不是安全边界；信任代码可以直接绕过它。

`plugins.<id>.path` 等价于“允许这段本地代码在 Loom 进程里运行”。只安装你自己编写
或完全信任的模块，不要把不可信来源的代码写进该配置。

## 3. 配置

```yaml
plugins:
  todo:
    enabled: false
  ext-demo:
    path: /srv/loom/plugins/ext-demo.mjs
    trust: trusted      # 可选；声明 path 时缺省即 trusted
    enabled: true       # 可选；缺省 true
```

规则：

- `path` 必须是非空**绝对路径**；相对路径直接配置错误。
- `trust` 在 P2a 只接受 `"trusted"`；`trust` 不能脱离 `path` 单独出现。
- `trust: "sandboxed"` 在 P2a 直接拒绝，并提示属于 P2b。
- `plugins.<id>` 条目只允许 `enabled` / `path` / `trust`，未知键 fail-fast。
- builtin 插件条目可以只有 `enabled`；builtin id 不允许带 `path`，boot 会拒绝冲突。
- `enabled: false` 的外部插件**不会被 import**，因此也不会出现在 `/plugins/status`。

## 4. 模块形状

模块必须 default-export 一个对象，包含 `manifest`（对象）与 `setup`（函数）：

```js
const manifest = {
  id: "ext-demo",
  name: "Ext Demo",
  version: "1.0.0",
  apiVersion: 1,
  permissions: ["tools:register"],
};

const setup = (ctx) => {
  ctx.tools.register({
    name: "ext_echo",
    description: "echo from an external plugin",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      return { content: [{ type: "text", text: "ext" }] };
    },
  });
  return {};
};

export default { manifest, setup };
```

契约：

- 不支持 named export 兜底；`default` 缺失即 `invalid-manifest`。
- `manifest.id` 必须等于配置里的插件 id。
- `manifest.apiVersion` 必须等于当前 `LOOM_PLUGIN_API_VERSION`（P2a 为 1）。
- `manifest.source` 若声明必须是 `"external"`；声明 `"builtin"` 被拒绝。
- `manifest.trust` 若声明必须是 `"trusted"`；`"sandboxed"` 被拒绝（P2b only）。
- 加载器返回的 manifest 会被强制写成 `source: "external"`、`trust: "trusted"`。
- `critical` 缺省为 `true`：外部插件 setup/start 失败会让 boot 失败。模块可显式
  `critical: false` 退出该语义（失败只标记 failed，继续启动其他插件）。

加载器只接受已存在的普通文件；路径先经 `realpathSync` 归一，再动态 import。
boot 期间每个模块只 import 一次，不做 cache-busting query。

## 5. P2a 实际生效的权限

PluginContext 按 manifest 的 `permissions` 做运行时检查：

| 权限 | 约束的接口 |
| --- | --- |
| `tools:register` | `ctx.tools.register()` |
| `hooks:register` | `ctx.hooks.register()` |
| `routes:register` | `ctx.routes.register()` |
| `storage:own` | `ctx.storage.get/set/delete/list()` |
| `events:own` | `ctx.events.on()` / `ctx.events.emit()` |

未声明对应权限时抛 `PluginHostError("permission-denied")`。`ctx.config` 保持只读且
不设权限门。其余权限（`fs:*`、`net:outbound`、`exec`、`sessions:read`、
`wake:schedule` 等）在 P2a 只是 manifest 声明，没有沙箱执行器去强制。

## 6. Boot 行为

boot 在 builtin 插件注册之后、`pluginHost.start()` 之前处理外部插件：

1. 跳过没有 `path` 的条目（普通 builtin 开关）。
2. 跳过 `enabled: false` 的条目（不 import）。
3. 若 id 与 `BUILTIN_PLUGINS` 冲突，直接 boot 失败。
4. `loadExternalPlugin({ id, path, trust? })`，成功后
   `pluginHost.register(plugin, { enabled: true })`。

加载失败是致命的：P2a 的 path 是显式本地配置，不做静默跳过。外部插件加载成功后与
builtin 共用同一 PluginHost：依赖排序、工具/路由冲突校验、生命周期与
`/plugins/status` 状态面完全一致。

## 7. 已知限制

- 外部插件的 `ctx.config` 目前就是 `plugins.<id>` 条目本身，因此会看到 `path` /
  `trust` / `enabled` 这些宿主控制键；P2a 还没有独立的插件私有配置命名空间。
- 外部插件与 builtin 插件在同一进程、同一事件循环内运行。
- 没有热加载：每次加载只发生在 boot；改模块或配置都要重启 Loom。
- 权限检查只覆盖 PluginContext；模块顶层与 setup 的自由代码不受限制（见安全警告）。

## 8. 与 P2b 的界线

P2b 才引入 `trust: "sandboxed"`、独立进程 runtime、capability RPC、安装/版本/市场
机制。P2a 的 `"sandboxed"` 错误信息会明确指向 P2b，避免把“声明了 trust”误当成
已经隔离。

**当前状态（2026-11-03）**：P2b 设计完成并通过 Oracle 安全评审，但决定暂缓实现；
P2a 的 `trust: "trusted"` 仍是 Loom 唯一的外部插件入口。详见
[`plugin-host-p2b.md`](plugin-host-p2b.md)。
