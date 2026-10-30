// T32：离线守卫——把 globalThis.fetch 替换成「调用即炸」的桩。
// fake-model 全链路（脚本化 turn、golden-path T33-T38、CI）都不允许触网：
// 任何真实 provider SDK（openai SDK 在 Node18+ 走全局 fetch）一旦被调到，
// 立刻 throw 并记入 hits，让测试红——而不是静默打到外网或挂到超时。
//
// 用法：测试里成对使用 `const guard = installNoNetworkGuard()` / finally 里
// `guard.uninstall()`。请勿嵌套安装（内层 uninstall 会恢复成外层桩，链虽仍安全，
// 但语义混乱）。

/** installNoNetworkGuard 返回的句柄。 */
export interface NoNetworkGuard {
  /** 被拦截的调用目标列表（按发生顺序）。CI 断言应为空。 */
  readonly hits: readonly string[];
  /** 恢复安装前的 fetch。 */
  uninstall(): void;
}

/** 安装离线守卫：fetch 一旦被调用 → 计数 + 抛错。 */
export function installNoNetworkGuard(): NoNetworkGuard {
  const original = globalThis.fetch;
  const hits: string[] = [];
  const blocked = (async (input: string | URL | Request): Promise<Response> => {
    const target = String(input);
    hits.push(target);
    throw new Error(`离线守卫：检测到网络调用 ${target}（fake-model 链路禁止真实 provider 请求）`);
  }) as typeof globalThis.fetch;
  globalThis.fetch = blocked;
  return {
    hits,
    uninstall: () => {
      globalThis.fetch = original;
    },
  };
}
