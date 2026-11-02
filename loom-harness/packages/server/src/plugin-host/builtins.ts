/**
 * Feature Plugin P0 builtin manifests（W2a）。
 *
 * 只登记元数据：P0 不接管 feature 构造，boot.ts 仍按原逻辑创建 todo/pty/task/
 * plan/inbox，因此这里每个 setup 都返回空 contribution。P1 才把真实工具/路由
 * 搬进各 feature 的 plugin 实现，并从这里替换 setup。
 */

import {
  LOOM_PLUGIN_API_VERSION,
  definePlugin,
  type LoomFeaturePlugin,
  type LoomPluginManifest,
} from "@axeuh/loom-plugin-sdk";

/** todo 的 Manifest 真源：静态元数据插件与 P1 工具工厂共用同一份。 */
export const TODO_MANIFEST: LoomPluginManifest = {
  id: "todo",
  name: "Todo",
  version: "0.0.0",
  apiVersion: LOOM_PLUGIN_API_VERSION,
  permissions: ["tools:register", "storage:own", "config:own"],
  source: "builtin",
  trust: "builtin",
  critical: true,
};

/** P0 元数据面（空 setup）：boot 中会被 createTodoPlugin 工厂替换。 */
const todoPlugin = definePlugin({
  manifest: TODO_MANIFEST,
  setup: () => ({}),
});

/** pty 的 Manifest 真源：静态元数据插件与 P1 工具工厂共用同一份。 */
export const PTY_MANIFEST: LoomPluginManifest = {
  id: "pty",
  name: "PTY",
  version: "0.0.0",
  apiVersion: LOOM_PLUGIN_API_VERSION,
  permissions: ["tools:register", "config:own"],
  source: "builtin",
  trust: "builtin",
  critical: true,
};

/** P0 元数据面（空 setup）：boot 中会被 createPtyPlugin 工厂替换。 */
const ptyPlugin = definePlugin({
  manifest: PTY_MANIFEST,
  setup: () => ({}),
});

/** task 的 Manifest 真源：静态元数据插件与 P1 task_fetch 工具工厂共用同一份。 */
export const TASK_MANIFEST: LoomPluginManifest = {
  id: "task",
  name: "Task",
  version: "0.0.0",
  apiVersion: LOOM_PLUGIN_API_VERSION,
  permissions: ["tools:register", "routes:register", "config:own"],
  source: "builtin",
  trust: "builtin",
  critical: true,
};

/** P0 元数据面（空 setup）：boot 中会被 createTaskPlugin 工厂替换（仅 task_fetch，派发工具仍在 wiring）。 */
const taskPlugin = definePlugin({
  manifest: TASK_MANIFEST,
  setup: () => ({}),
});

const planPlugin = definePlugin({
  manifest: {
    id: "plan",
    name: "Plan",
    version: "0.0.0",
    apiVersion: LOOM_PLUGIN_API_VERSION,
    permissions: ["tools:register", "routes:register", "storage:own", "config:own"],
    source: "builtin",
    trust: "builtin",
    critical: true,
  },
  setup: () => ({}),
});

const inboxPlugin = definePlugin({
  manifest: {
    id: "inbox",
    name: "Inbox",
    version: "0.0.0",
    apiVersion: LOOM_PLUGIN_API_VERSION,
    permissions: [
      "tools:register",
      "routes:register",
      "storage:own",
      "config:own",
      "events:own",
    ],
    source: "builtin",
    trust: "builtin",
    critical: true,
  },
  setup: () => ({}),
});

/** 五个 P0 builtin feature plugin；顺序即 Host 的登记顺序。 */
export const BUILTIN_PLUGINS: readonly LoomFeaturePlugin[] = [
  todoPlugin,
  ptyPlugin,
  taskPlugin,
  planPlugin,
  inboxPlugin,
];
