# Loom Feature Plugin P0 设计

状态：已完成（P0）；P1/P2a 已实现，P2b 设计完成但暂缓
范围：PluginHost + Manifest + SDK 契约 + 内置插件元数据
不包含：外部插件加载、沙箱、安装器、插件市场 UI

后续文档：
- [P2a trusted 本地外部插件](plugin-host-p2a.md)（已实现）
- [P2b 沙箱化外部插件设计](plugin-host-p2b.md)（设计完成，2026-11-03 暂缓实现）

## 1. 目标

把 Loom 的特色工具/子系统从 `boot.ts` 的静态装配中解耦，同时保持 P0 行为零变化，并为未来的插件市场预留统一契约。

P0 完成后应满足：

- 有一套公开的插件契约（Manifest / Plugin / Contribution / Context）。
- 有一个 PluginHost，负责注册、依赖排序、冲突检测、生命周期和状态。
- 现有 feature（todo/pty/task/plan/inbox）以 builtin 插件元数据形式注册。
- `boot.ts` 仍按现有方式构造 feature，行为不变；P1 才把构造迁入插件。
- 不引入第二个 WakeQueue、第二个工具 dispatcher、第二个 Hook 总线。
- 后端 task 调度器完全不动。

## 2. 两层插件模型

### 2.1 Hook plugin（已有）

`packages/core/src/plugins/` 里的第一方 Hook 工厂：compaction、token-budget、cost-tracker、turnEndGuard、permissionGate、metrics 等。

这一层继续走 `Hook`，不纳入 Feature PluginHost。

### 2.2 Feature plugin（P0 新增）

提供工具、路由、生命周期、状态的插件。P0 的内置 feature plugin 只提供元数据；P1 开始接管实际构造。

## 3. 包与目录

新增 workspace 包：

```
packages/plugin-sdk/
  package.json        # @axeuh/loom-plugin-sdk
  tsconfig.json
  src/
    index.ts
    manifest.ts
    plugin.ts
    context.ts
    permissions.ts
    status.ts
```

服务端新增：

```
packages/server/src/plugin-host/
  index.ts
  host.ts
  registry.ts
  validate.ts
  builtins.ts
  context.ts
  status.ts
```

内置 feature 插件（P1 起使用）：

```
packages/server/src/features/
  todo/plugin.ts
  pty/plugin.ts
  task/plugin.ts
  plan/plugin.ts
  inbox/plugin.ts
```

命名说明：`packages/core/src/plugins/` 继续表示 Hook 工厂；新层统一叫 **Feature Plugin**，避免歧义。

## 4. SDK 契约

### 4.1 Manifest

```ts
export const LOOM_PLUGIN_API_VERSION = 1;

export type PluginSource = "builtin" | "external";
export type PluginTrust = "builtin" | "trusted" | "sandboxed";

export interface LoomPluginManifest {
  id: string;                 // [a-z0-9][a-z0-9._-]*
  name: string;
  version: string;            // semver
  apiVersion: number;         // 必须等于 LOOM_PLUGIN_API_VERSION
  entry?: string;             // external 必填；builtin 可省略
  minLoomVersion?: string;
  description?: string;
  author?: string;
  license?: string;
  permissions: PluginPermission[];
  configSchema?: string | Record<string, unknown>;
  source?: PluginSource;      // Host 填充/校验
  trust?: PluginTrust;        // Host 填充/校验
}
```

### 4.2 Permissions

```ts
export type PluginPermission =
  | "tools:register"
  | "hooks:register"
  | "routes:register"
  | "storage:own"
  | "config:own"
  | "events:own"
  | "fs:read"
  | "fs:write"
  | "net:outbound"
  | "exec"
  | "sessions:read"
  | "wake:schedule";
```

P0 只校验声明，不做运行时隔离。内置插件声明自己需要的能力；外部插件在 P2 才真正受限。

市场默认策略（P2 实现）：

- 允许：`tools:register`、`routes:register`、`storage:own`、`config:own`、`events:own`
- 默认拒绝：`hooks:register`、`fs:*`、`net:outbound`、`exec`、`sessions:read`、`wake:schedule`

### 4.3 Plugin

```ts
export interface LoomFeaturePlugin {
  manifest: LoomPluginManifest;
  setup(ctx: PluginContext): PluginContribution | Promise<PluginContribution>;
}

export function definePlugin(plugin: LoomFeaturePlugin): LoomFeaturePlugin {
  return plugin;
}
```

### 4.4 Contribution

```ts
export interface PluginContribution {
  tools?: HarnessTool[];
  hooks?: Hook[] | ((session: PluginSessionContext) => Hook[]);
  routes?: PluginRoute[];
  sessionLifecycle?: PluginSessionLifecycle;
  start?(): Promise<void> | void;
  stop?(): Promise<void> | void;
  status?(): PluginRuntimeStatus;
}

export interface PluginRoute {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;               // 必须位于 /plugins/<id>/
  auth?: "required" | "admin" | "none"; // 默认 required
  handler: PluginRouteHandler;
}
```

### 4.5 Context

```ts
export interface PluginContext {
  readonly plugin: {
    id: string;
    version: string;
    dataDir: string;
  };
  readonly config: Readonly<Record<string, unknown>>;
  readonly logger: PluginLogger;
  readonly tools: PluginToolRegistry;     // register only
  readonly hooks: PluginHookRegistry;     // register only
  readonly routes: PluginRouteRegistry;   // register only
  readonly storage: PluginStorage;        // namespaced
  readonly events: PluginEventBus;        // namespaced
}
```

明确不暴露：

- 原始 `EventHub`
- `WakeQueue`
- `InboxJournalStore` / 其他 store
- HTTP router 实例
- `SessionRegistry` 内部
- 模型/provider 对象
- 进程环境变量

### 4.6 Status

```ts
export type PluginState =
  | "registered"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "failed"
  | "disabled";

export interface PluginRuntimeStatus {
  id: string;
  version: string;
  source: PluginSource;
  trust: PluginTrust;
  enabled: boolean;
  state: PluginState;
  error?: string;
  startedAt?: string;
  stoppedAt?: string;
}
```

## 5. PluginHost

```ts
export interface PluginHost {
  register(plugin: LoomFeaturePlugin, options?: { enabled?: boolean }): void;
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): PluginRuntimeStatus[];
  contributions(): {
    tools: HarnessTool[];
    hooks: Hook[];
    routes: PluginRoute[];
  };
}
```

### 5.1 生命周期

1. `register`：记录插件、manifest、enabled。
2. `start`：
   - 校验 API 版本、id、权限、依赖。
   - 依赖拓扑排序；环 -> 失败。
   - 按顺序 `setup`，收集 contribution。
   - 校验工具名、路由前缀、Hook 名冲突。
   - 按顺序 `start()`。
3. `stop`：逆序调用每个插件的 `stop()`，清理贡献。
4. `status`：返回每个插件的状态和错误。

### 5.2 失败策略

- `critical: true`（manifest 增加可选字段）失败 -> boot 失败。
- `critical: false` -> 标记 `failed`，继续启动其他插件。
- 工具/路由冲突 -> 该插件失败；critical 则 boot 失败。
- 依赖缺失/环 -> 该插件失败；critical 则 boot 失败。

### 5.3 依赖

Manifest 增加：

```ts
requires?: string[];
```

依赖只表达“启动顺序/存在性”，不传递能力。插件之间不能直接 import；协作走 host 提供的命名空间事件或 storage。

## 6. 内置插件（P0 元数据）

P0 注册以下 builtin manifest，但 `setup` 返回空 contribution：

```ts
const builtinPlugins: LoomFeaturePlugin[] = [
  { manifest: todoManifest, setup: () => ({}) },
  { manifest: ptyManifest, setup: () => ({}) },
  { manifest: taskManifest, setup: () => ({}) },
  { manifest: planManifest, setup: () => ({}) },
  { manifest: inboxManifest, setup: () => ({}) },
];
```

P0 不改变现有构造；`boot.ts` 仍按原逻辑创建这些 feature。Host 只负责登记和状态。

P1 再把 `setup` 替换为真实 contribution，并从 `boot.ts` / `tool-wiring.ts` 删除对应 inline 构造。

### 6.1 建议依赖

- `todo`：无
- `pty`：无（依赖 core tool executor，由 host 注入）
- `task`：无（依赖 core run engine）
- `plan`：依赖 `wake`（core，不是插件）
- `inbox`：依赖 `wake`（core，不是插件）

不要把 WakeQueue 做成插件；它必须是 core 单例。

## 7. Boot 集成（P0）

`createLoomApp()` 中：

1. 构造 core 服务。
2. 创建 `PluginHost`。
3. 注册 builtin plugins。
4. `await host.start()`。
5. 现有 feature 构造保持不变。
6. `closeExtras` 中 `await host.stop()`。

P0 的 `tool-wiring.ts` 不变；P1 才把 `host.contributions().tools` 合并进 `extraTools`。

新增可选配置：

```yaml
plugins:
  todo:  { enabled: true }
  pty:   { enabled: true }
  task:  { enabled: true }
  plan:  { enabled: true }
  inbox: { enabled: true }
```

P0 中 `plugins` 只影响 host 状态，不影响现有 feature 是否启用；P1 才让它成为真正的开关。若未配置，则全部 builtin 默认 enabled。

## 8. 状态接口

新增：

```http
GET /plugins/status
```

返回：

```json
{
  "apiVersion": 1,
  "plugins": [
    {
      "id": "inbox",
      "version": "1.6.0",
      "source": "builtin",
      "trust": "builtin",
      "enabled": true,
      "state": "running"
    }
  ]
}
```

权限：管理员/本机认证；不返回插件内部配置或消息正文。

## 9. 测试计划

### 9.1 单元

- SDK 类型编译。
- Manifest 校验：id、version、apiVersion、permissions。
- 依赖排序、环检测、缺失依赖。
- 工具名冲突、路由前缀冲突、重复 plugin id。
- critical / non-critical 失败。
- start 顺序、stop 逆序。
- status 转换。
- 禁用插件不启动。

### 9.2 Boot parity

- 有 host 与无 host 启动后的工具名集合一致。
- Hook 数量/名称一致。
- 路由集合一致。
- 配置不变时行为一致。
- `closeExtras` 后无残留 timer/route。

### 9.3 真实面 QA

```bash
# 启动带 plugins 配置的 Loom，检查状态
curl -s http://127.0.0.1:<port>/plugins/status

# 对比工具面
curl -s .../config | jq '.tools'

# 关闭进程，确认无残留
```

### 9.4 约束测试

- Host 不创建 `setInterval`/`setTimeout` 调度器。
- Host 不 import `features/*` 之外的 feature 代码（P0 只 import manifests）。
- Core 不 import `plugin-host` 或 `features/*`。

## 10. 任务图

### Wave 0：SDK

| Task | 内容 | 文件 | 验证 |
|---|---|---|---|
| T01 | 新建 `@axeuh/loom-plugin-sdk` 包、tsconfig、index | `packages/plugin-sdk/*` | `npm run typecheck` |
| T02 | Manifest/permissions/status/context/plugin 类型与 `definePlugin` | `packages/plugin-sdk/src/*` | 类型测试 |

### Wave 1：Host

| Task | 内容 | 文件 | 依赖 |
|---|---|---|---|
| T03 | registry + 依赖排序 + 冲突校验 | `plugin-host/registry.ts`, `validate.ts` | T02 |
| T04 | host 生命周期 start/stop/status/contributions | `plugin-host/host.ts` | T03 |
| T05 | 受控 PluginContext 实现（register-only） | `plugin-host/context.ts` | T02 |
| T06 | Host 单元测试 | `plugin-host/*.test.ts` | T03-T05 |

### Wave 2：Builtin 与 Boot

| Task | 内容 | 文件 | 依赖 |
|---|---|---|---|
| T07 | todo/pty/task/plan/inbox manifests + 空 setup | `plugin-host/builtins.ts`, `features/*/manifest.ts` | T02 |
| T08 | 配置 schema `plugins` | `config/section-checks.ts` | T07 |
| T09 | boot 集成 + closeExtras | `serve/boot.ts` | T04, T07 |
| T10 | `GET /plugins/status` | `plugin-host/status.ts`, `boot.ts` | T04 |

### Wave 3：验证与文档

| Task | 内容 | 文件 | 依赖 |
|---|---|---|---|
| T11 | Boot parity 测试 | `serve/boot-plugin.test.ts` | T09 |
| T12 | 全量 typecheck/build/test | — | T01-T11 |
| T13 | 设计文档与插件作者指南 | `docs/dev/plugin-host-p0.md` | 全部 |

并行：T01/T02 后，T03/T05 可并行；T07/T08 可并行；T11/T13 可并行。

## 11. 验收标准

- P0 启动后工具面、Hook、路由与改造前一致。
- `GET /plugins/status` 返回五个 builtin 插件状态。
- `plugins` 配置未知 key 报错。
- 依赖环、重复 id、工具冲突、路由冲突均有测试。
- 关闭 Loom 后无插件残留 timer/route/process。
- 没有第二个 WakeQueue / 工具 dispatcher / Hook 总线。
- 后端 task 调度器零改动。
- 全量 typecheck/build/test 通过。

## 12. P1 与 P2

### P1：抽离叶子工具

1. `todo`：把工具构造移入 `features/todo/plugin.ts`。
2. `pty`：工具 + start/stop 生命周期。
3. `taskFetch`：只抽工具，不动 task 调度器。
4. 每次抽离后删除 `tool-wiring.ts` 对应 inline 代码，跑 boot parity。
5. `plugins` 配置开始真正控制启用。

### P2：外部插件与市场

- 外部本地插件 loader（trusted）。
- 独立进程 runtime + capability RPC + 沙箱。
- npm/git 安装、lockfile、更新/回滚。
- 静态索引、搜索、市场 API/UI。
- 签名/审核/权限升级同意。

## 13. 已确认（实现记录）

1. SDK 包名采用 `@axeuh/loom-plugin-sdk`。
2. P0 只注册五个 builtin（todo/pty/task/plan/inbox）；skills/mcp 暂不纳入元数据。
3. 状态接口采用 `GET /plugins/status`。

## 14. 后续状态

- P0：已完成并提交（`4541f86`）。
- P1：todo/pty/taskFetch 已抽离并提交（`54e75e1`、`b78db51`、`30152ba`）。
- P2a：trusted 本地外部插件 loader 已实现并提交（`e7ea644`）。
- P2b：沙箱化设计 + Oracle 安全评审完成，但 2026-11-03 决定暂缓实现；
  当前外部插件入口只有 P2a trusted。详见 `plugin-host-p2b.md`。
