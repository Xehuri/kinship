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
} from "@axeuh/loom-plugin-sdk";

const todoPlugin = definePlugin({
  manifest: {
    id: "todo",
    name: "Todo",
    version: "0.0.0",
    apiVersion: LOOM_PLUGIN_API_VERSION,
    permissions: ["tools:register", "storage:own", "config:own"],
    source: "builtin",
    trust: "builtin",
    critical: true,
  },
  setup: () => ({}),
});

const ptyPlugin = definePlugin({
  manifest: {
    id: "pty",
    name: "PTY",
    version: "0.0.0",
    apiVersion: LOOM_PLUGIN_API_VERSION,
    permissions: ["tools:register", "config:own"],
    source: "builtin",
    trust: "builtin",
    critical: true,
  },
  setup: () => ({}),
});

const taskPlugin = definePlugin({
  manifest: {
    id: "task",
    name: "Task",
    version: "0.0.0",
    apiVersion: LOOM_PLUGIN_API_VERSION,
    permissions: ["tools:register", "routes:register", "config:own"],
    source: "builtin",
    trust: "builtin",
    critical: true,
  },
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
