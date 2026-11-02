/**
 * Feature Plugin 注册表与依赖排序。
 *
 * 注册按调用顺序保存（status 的稳定顺序）；start 前的拓扑排序以注册序号作为
 * 同层 tie-breaker，保证同一组输入永远得到同一启动顺序。
 */

import type { LoomFeaturePlugin } from "@axeuh/loom-plugin-sdk";

import { PluginHostError } from "./validate.js";

export interface PluginRegistration {
  readonly id: string;
  readonly plugin: LoomFeaturePlugin;
  readonly enabled: boolean;
  /** 注册序号；用于稳定排序。 */
  readonly order: number;
}

export interface PluginRegisterOptions {
  readonly enabled?: boolean;
}

/** 只做登记与重复 id 检测；manifest 的合法性由 Host 在 start() 校验。 */
export class PluginRegistry {
  private readonly registrations = new Map<string, PluginRegistration>();
  private nextOrder = 0;

  register(
    plugin: LoomFeaturePlugin,
    options: PluginRegisterOptions = {},
  ): PluginRegistration {
    const id = plugin.manifest.id;
    if (this.registrations.has(id)) {
      throw new PluginHostError(
        "duplicate-id",
        `duplicate plugin id "${id}"`,
        id,
      );
    }
    const registration: PluginRegistration = {
      id,
      plugin,
      enabled: options.enabled ?? true,
      order: this.nextOrder,
    };
    this.nextOrder += 1;
    this.registrations.set(id, registration);
    return registration;
  }

  get(id: string): PluginRegistration | undefined {
    return this.registrations.get(id);
  }

  has(id: string): boolean {
    return this.registrations.has(id);
  }

  list(): PluginRegistration[] {
    return [...this.registrations.values()];
  }

  get size(): number {
    return this.registrations.size;
  }
}

function getOrThrow<K, V>(map: ReadonlyMap<K, V>, key: K, message: string): V {
  const value = map.get(key);
  if (value === undefined) throw new Error(message);
  return value;
}

function insertByRegistrationOrder(
  queue: PluginRegistration[],
  item: PluginRegistration,
): void {
  let index = 0;
  while (index < queue.length && (queue[index]?.order ?? -1) <= item.order) {
    index += 1;
  }
  queue.splice(index, 0, item);
}

/**
 * 按 manifest.requires 做拓扑排序；同层节点按注册顺序排列。
 *
 * 缺失依赖或环都抛 PluginHostError（确定性、带插件 id）。调用方只传入
 * 已通过 manifest 校验且 enabled 的注册项。
 */
export function resolveStartOrder(
  registrations: readonly PluginRegistration[],
): PluginRegistration[] {
  const byId = new Map<string, PluginRegistration>();
  for (const registration of registrations) {
    byId.set(registration.id, registration);
  }

  const indegree = new Map<string, number>();
  const dependents = new Map<string, PluginRegistration[]>();
  for (const registration of registrations) {
    indegree.set(registration.id, 0);
    dependents.set(registration.id, []);
  }

  for (const registration of registrations) {
    const requires = registration.plugin.manifest.requires ?? [];
    for (const dependencyId of requires) {
      if (!byId.has(dependencyId)) {
        throw new PluginHostError(
          "missing-dependency",
          `missing dependency "${dependencyId}"`,
          registration.id,
        );
      }
      indegree.set(
        registration.id,
        getOrThrow(indegree, registration.id, "indegree invariant") + 1,
      );
      getOrThrow(dependents, dependencyId, "dependent invariant").push(registration);
    }
  }

  const ready = registrations
    .filter((registration) => indegree.get(registration.id) === 0)
    .sort((left, right) => left.order - right.order);
  const ordered: PluginRegistration[] = [];
  const visited = new Set<string>();

  while (ready.length > 0) {
    const current = ready.shift();
    if (current === undefined) break;
    ordered.push(current);
    visited.add(current.id);
    const children = [...getOrThrow(dependents, current.id, "dependent invariant")]
      .sort((left, right) => left.order - right.order);
    for (const child of children) {
      const remaining = getOrThrow(indegree, child.id, "indegree invariant") - 1;
      indegree.set(child.id, remaining);
      if (remaining === 0) insertByRegistrationOrder(ready, child);
    }
  }

  if (ordered.length !== registrations.length) {
    const cycleIds = registrations
      .filter((registration) => !visited.has(registration.id))
      .map((registration) => registration.id);
    throw new PluginHostError(
      "dependency-cycle",
      `plugin dependency cycle detected among: ${cycleIds.join(", ")}`,
    );
  }

  return ordered;
}
