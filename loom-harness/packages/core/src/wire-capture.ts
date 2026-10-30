/**
 * W17-A 发线面捕获内核 —— AgentSession 的内存态真·wire 请求快照（A1 通道序列化口）。
 *
 * 定位：GET /sessions/:id/context/full v2 的 `wire` 块的 core 侧唯一数据源。
 * v1 用 `session.systemPrompt + durable messages` **重建猜测**请求面；v2 用本模块
 * 的捕获**逐字节真值**替换猜测：
 *   - A1（本模块）：装配口快照 —— 所有变换（pipe sysPrompt / pipe messages / pipe tools /
 *     strip harness-only 字段 / resolveLlmOptions 摊平）之后、stream() 调用之前，
 *     **捕获时刻同步序列化**（pi-ai provider 可能事后改对象，引用留存储不可靠）。
 *   - A2（session.ts 内联 onPayload 闭包）：provider 发线口逐 attempt last-write。
 *
 * 序列化口径：canonicalJson —— 与 server 侧 context-full.ts 的 canonicalJson **同一
 * 实现镜像**（依赖方向 server→core，core 不可 import server，故各自持有一份；行为必须
 * 逐字节一致）。键字典序防属性序抖动进字节流（fs-reader.ts canonicalRow "杜绝属性序
 * 抖动"同纪律，行式 `k=v` 不适用消息体故取 JSON 形）。数组顺序**原样保留**——工具序 /
 * 消息序都是真发线字节的一部分，与 prefix-shape.ts canonicalize（为 hash 稳定性额外排
 * required/enum）不同：那是簿记面归一，这里是发线面逐字记录。
 */

import type { Api, Context, Model, ProviderStreamOptions, Tool } from "@earendil-works/pi-ai";

/** 键字典序稳定 JSON（undefined 字段省略；数组顺序保留；对偶 canonicalRow 的纪律，取 JSON 形态）。 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const rec = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(rec).sort()) {
      const v = rec[key];
      if (v !== undefined) parts.push(`${JSON.stringify(key)}:${canonicalJson(v)}`);
    }
    return `{${parts.join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  return encoded === undefined ? "null" : encoded;
}

/** 发线 tools 一条（pi-ai Tool 的三字段逐字捕获；schemaText 为 parameters 的 canonical JSON）。 */
export interface WireToolSnapshot {
  readonly name: string;
  readonly description: string;
  /** parameters 的 canonical JSON 文本（捕获时刻同步序列化）。 */
  readonly schemaText: string;
}

/**
 * A1 装配口快照 —— 一次 LLM call 实际交给 pi-ai `stream()` 的**全部**内容，逐字。
 * 纯只读记录，绝不回写 context/options（W15-B 前缀字节零扰动）。
 */
export interface WireRequestSnapshot {
  /** 捕获时刻（epoch ms；每次 LLM call 覆盖单槽）。 */
  readonly capturedAt: number;
  /** 捕获时刻的轮次序号（取自 _ctx.turnIdx，_runTurnsUntilStop 已在本轮 onTurnStart 前设好）。 */
  readonly turnIdx: number;
  /**
   * 模型标识四元组（Model 上本无 apiKey 字段；key 在 options，见 optionsText 注释）。
   * W17-B 加 provider：pi-ai Model.provider 是 KnownProvider|string 逻辑名，
   * v2 出口 wire.model.{id,api,provider} 冻结契约的唯一数据源。
   */
  readonly model: {
    readonly id: string;
    readonly api: Api;
    readonly baseUrl: string;
    readonly provider: string;
  };
  /**
   * post-pipe 实际随发的 systemPrompt（firePipeSystemPrompt 产物，含 skills catalog 等
   * 管道内追加）；context 未带 systemPrompt 时如实记 ""。
   */
  readonly systemPrompt: string;
  /** context.messages（已过 pipe + stripHarnessOnlyFields）的 canonical JSON 文本。 */
  readonly messagesText: string;
  /** post-pipe 的 piTools 逐项捕获。 */
  readonly tools: ReadonlyArray<WireToolSnapshot>;
  /**
   * {...resolveLlmOptions(this._llmOptions)} 的 canonical JSON（**不含** kernel 注入的
   * signal）。原始未脱敏：apiKey / headers 等敏感值明文在场，**脱敏是 server 侧后续任务
   * （W17-B v2 出口）的职责**，core 只记逐字节真值。
   */
  readonly optionsText: string;
  /**
   * W17-B transient 尾标：捕获时刻本轮随发的瞬态附件条数（= 投影 baseMessages 组装时
   * `_pendingAttachments` 的长度，在清空之前记录）。附件**恒为投影数组的连续尾段**
   * （session.ts:1413-1422 的 `[...messages, ...pending]` 拼接形状），故 B 侧
   * `/context/full` v2 把末 transientCount 条标 transient:true 即可复原面板徽章。
   * 诚实申明（compaction 边界条件）：firePipeMessages 的管道若改写数组尾段（现装
   * compact-summarize 只替换**头部**为 summary、auto-compaction 边界投影同样保留
   * pending 尾部），尾段计数会失真——本计数只保证"注入时点"的真相，不承诺管道后位置。
   */
  readonly transientCount: number;
}

/** snapshotWireRequest 的入参：装配完成、stream() 将发未发的同一批对象引用。 */
export interface WireRequestSnapshotInput {
  readonly turnIdx: number;
  readonly model: Model<Api>;
  /** 即将传给 stream() 的 Context（post-pipe、post-strip）。 */
  readonly context: Context;
  /** resolveLlmOptions 的摊平产物（kernel 注入 signal 之前的原样）。 */
  readonly options: ProviderStreamOptions;
  /** 本轮瞬态附件条数（W17-B 尾标；调用方须在 _pendingAttachments 清空前取数）。 */
  readonly transientCount: number;
}

/**
 * 在**捕获时刻同步**把装配口对象序列化成不可变快照文本。
 * 同步是硬要求：pi-ai provider 可能事后 mutate 这些对象，留引用 = 留谎。
 */
export function snapshotWireRequest(input: WireRequestSnapshotInput): WireRequestSnapshot {
  const { turnIdx, model, context, options, transientCount } = input;
  const tools: WireToolSnapshot[] = (context.tools ?? []).map(
    (tool: Tool) => ({
      name: tool.name,
      description: tool.description,
      schemaText: canonicalJson(tool.parameters),
    }),
  );
  return {
    capturedAt: Date.now(),
    turnIdx,
    model: { id: model.id, api: model.api, baseUrl: model.baseUrl, provider: model.provider },
    systemPrompt: context.systemPrompt ?? "",
    messagesText: canonicalJson(context.messages),
    tools,
    optionsText: canonicalJson(options),
    transientCount,
  };
}
