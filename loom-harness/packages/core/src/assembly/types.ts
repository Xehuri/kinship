/**
 * 上下文装配器类型契约（T18，docs/01 D6/D21「装配纪律：稳定前缀层 → 增量易变层」）。
 *
 * 缓存布局（prompt cache 命中结构）：
 *   段0 system   —— 系统提示 + 收束工具说明占位（稳定）
 *   段1 memory   —— AGENTS.md + memory 稳定文件，字节序恒定（稳定）
 *   段2 workflow —— 任务提示词模板，按 workflows 声明序注入（稳定）
 *   段3 increment—— 每轮变化：历史增量行 / nudge / reminder / 本轮消息（易变）
 * 前缀 = 段[0..2] 拼接，字节级恒定 ⇒ provider cache 公共前缀命中；段3 只在尾部
 * 增长，永远不动前缀。T19（压缩）/ T27 / T37 消费 Segment/prefixHash。
 *
 * 行数恒定契约（D20）：装配读历史走 `AssemblyReader.readHistoryIncrement`
 * （dir 索引增量语义，同 SessionShards.readAfter）。依赖方向 adapters → core，
 * core 不 import adapters，故 reader 为注入接口（`fs-reader.ts` 提供 duck-typed
 * SessionShards 接线），`openedShards` 是这条复杂度的可观测证明量。
 *
 * fail-soft 契约（D33）：任何注入源 IO 失败/缺失/损坏 ⇒ 该注入降级为声明占位 +
 * 类型化 `AssemblyDegrade` 记录，装配绝不 throw。
 */

/** 装配段名（固定四段，顺序即缓存布局）。 */
export type SegmentName = "system" | "memory" | "workflow" | "increment";

/** 一个装配段：utf-8 字节 + 稳定位标记。bytes 用 Uint8Array，hash 面向字节。 */
export interface Segment {
  readonly name: SegmentName;
  readonly bytes: Uint8Array;
  /** true = 前缀段（[0..2]，字节级恒定）；false = 增量段（每轮可变）。 */
  readonly stable: boolean;
}

/** 降级原因：missing=源不存在；unreadable=读失败（IO）；invalid=源内容损坏。 */
export type DegradeReason = "missing" | "unreadable" | "invalid";

/** 一条 fail-soft 降级事件（下游 T21 trace 直接落审计行）。 */
export interface AssemblyDegrade {
  /** 归属段名。 */
  readonly segment: SegmentName;
  /** 注入源标识（workspace 相对路径或声明名）。 */
  readonly source: string;
  readonly reason: DegradeReason;
  /** 原始错误信息（unreadable/invalid 时有值；缺失源为 null）。 */
  readonly detail: string | null;
}

/** 装配产物。segments 顺序即上送 prompt 的字节顺序。 */
export interface Assembly {
  readonly segments: readonly Segment[];
  /** 前缀（段0+段1+段2）字节 sha256，格式 `sha256:<hex>`（同 prefix-shape 惯例）。 */
  readonly prefixHash: string;
  /** 全量（段0..3）字节 sha256。 */
  readonly fullHash: string;
  /** fail-soft 降级记录（无降级为空数组，绝不为缺省）。 */
  readonly degrades: readonly AssemblyDegrade[];
  /** 段1 注入源条数（记忆注入可观测证明量；= plan.memorySources.length）。 */
  readonly memorySourceCount: number;
  /** 本次读历史的增量行数（O(增量) 证明量之一）。 */
  readonly incrementRows: number;
  /** 本次实际打开的分片文件数（O(增量) 证明量之二；无历史源为 0）。 */
  readonly openedShards: number;
}

/** `readHistoryIncrement` 返回：增量行 + 实际打开的分片数（同 ShardSlice 语义）。 */
export interface HistoryIncrement {
  readonly lines: readonly string[];
  readonly openedShards: number;
}

/**
 * 注入源读取接口（参数化注入；装配核心零 IO，fs 实现在 `fs-reader.ts`，
 * SessionShards 接线在 server 层用 duck-typed 适配器完成）。
 */
export interface AssemblyReader {
  /**
   * 读一个稳定注入文件（workspace 相对路径）。
   * 返回 null = 源缺失（fail-soft 占位）；抛错 = IO 失败（reason=unreadable）。
   */
  readText(path: string): string | null;
  /** 按游标增量读历史行（已序列化文本行；语义同 SessionShards.readAfter）。 */
  readHistoryIncrement(fromIndex: number): HistoryIncrement;
  /** 历史总行数（下一轮游标 = 本轮游标 + incrementRows，或直接取此值）。 */
  historyLength(): number;
}

/**
 * 一个稳定 memory 注入源（`resolveMemorySources` 在 IO 边界产出；
 * content 恒可渲染——真内容或声明占位，degrade 非 null = 该源已降级）。
 */
export interface MemorySource {
  readonly source: string;
  readonly content: string;
  readonly degrade: AssemblyDegrade | null;
}

/** 一个 workflow 提示词模板声明（按 workflows yaml 声明序给出，装配不重排）。 */
export interface WorkflowTemplate {
  readonly name: string;
  /** 模板正文；null = 源缺失（装配时降级占位 + degrade 记录）。 */
  readonly prompt: string | null;
}

/** 装配计划：稳定侧声明（跨轮不变 ⇒ 前缀可缓存）。 */
export interface AssemblyPlan {
  /** 段0 系统提示正文。 */
  readonly systemPrompt: string;
  /**
   * 收束工具说明：T09 convergence 并行开发中，先占位。
   * 未提供时用固定占位文本（文本恒定，不破坏前缀稳定）。
   */
  readonly convergenceToolNote?: string;
  /** 稳定 memory 注入源（用 resolveMemorySources 构造：声明层清单序、已读、已验）。 */
  readonly memorySources: readonly MemorySource[];
  /** 段2 任务提示词模板，按声明序。 */
  readonly workflows: readonly WorkflowTemplate[];
}

/** 单轮装配输入：增量纬线（每轮变化）。 */
export interface TurnInput {
  /** 上一轮装配后的历史游标（readHistoryIncrement 起点）。 */
  readonly historyCursor: number;
  /** 本轮 nudge（无则缺省）。 */
  readonly nudges?: readonly string[];
  /** 本轮 reminder（无则缺省）。 */
  readonly reminders?: readonly string[];
  /** 本轮用户消息（缺省/null = 无新消息，如收口轮）。 */
  readonly currentMessage?: string | null;
}
