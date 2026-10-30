/**
 * W17-B GET /sessions/:id/context/full **v2** 组装层。
 *
 * 纪律（任务冻结）：
 *   - v1 面（W16-B ContextFullView 十四键）**键集与取值逐字节不动** —— 本层只组合
 *     `buildContextFull` 的原产物，绝不重建/改写其任何字段（transientExcluded:true 等
 *     v1 语义原样在场）；
 *   - 加性两键：`wire`（发线面单槽快照出口视图，无捕获 = null 诚实面）与
 *     `manifest`（boot 一次装配引用清单，未接线 = null）；
 *   - note 更新为 v2 口径：v1 全文**逐字前缀**保留（W16-B 钉含 `toContain("transient")`
 *     与语义文本冻结），尾句追加 wire/manifest 两面的采集口径。
 *
 * W23-A 加性面（本层第二段组合）：
 *   - `wire.source`："live"（内存单槽）| "cache"（wire/{sid}.json 回落）；
 *   - 三段回落口径（路由层判定，本层只管组装）：live loop + live 槽 = basis "live" +
 *     source "live"；live loop + 槽空 + 缓存在场 = basis "live" + source "cache"；
 *     无 live loop + 缓存在场 = basis "cache"（buildContextFullCacheV2 重建面，
 *     v1 十四键仍在场但值 = 缓存/durable 转录推导，segments 恒空——装配对象无从恢复）。
 *
 * 面板（Lane C）探测 `'wire' in v / 'manifest' in v` 键存在性 ⇒ v2 响应恒带两键。
 */

import type { Message, WireRequestSnapshot } from "@axeuh/loom-core";
import type { Assembly } from "@axeuh/loom-core/assembly";
import {
  buildContextFull,
  CONTEXT_FULL_NOTE,
  type ContextFullView,
} from "./context-full.js";
import type { ContextManifest } from "./context-manifest.js";
import { buildWireView, type WireSource, type WireView } from "./wire-view.js";

/** v2 note = v1 逐字前缀 + 发线面/清单面口径尾句。 */
export const CONTEXT_FULL_V2_NOTE: string = `${CONTEXT_FULL_NOTE}` +
  "v2 加性面：wire = 最近一次 LLM call 装配口逐字节捕获（内存单槽、重启即清；" +
  "params 出网前凭据键脱敏为 ***；provider 载荷缺席时逐字说明理由）；" +
  "transient 尾标 = 本轮瞬态附件条数映射（末 N 条 transient:true，附件不入 durable 转录）；" +
  "manifest = boot 一次装配只读引用清单（memory 注入清单/skill/mcp∪config/角色/脱敏模型；W33 起 memory 清单 = AGENTS.md 单件）。" +
  "W23-A：wire.source=live 内存槽/cache 持久缓存（wire/{sid}.json，写前脱敏）；" +
  "无 live loop 但缓存在场时 basis=cache——systemPrompt/发线面取自缓存快照，" +
  "messages=durable 转录原样序列化（含压缩边界重放），segments 恒空（装配对象不可恢复），" +
  "capturedAt=缓存落盘时刻。";

/** v1 十四键 + note 的缓存基面覆盖文本（basis/capturedAt/segments 之外的值全等 v1 组合）。 */
export const CONTEXT_FULL_CACHE_NOTE_SUFFIX =
  "本响应 basis=cache：数据 = wire/{sid}.json 持久缓存 + durable 转录重建（非本轮内存现读）。";

/** v2 响应体（v1 全部键值原样 + wire + manifest；note 为唯一 v2 口径更新位）。 */
export interface ContextFullV2View extends Omit<ContextFullView, "note"> {
  readonly note: string;
  readonly wire: WireView | null;
  readonly manifest: ContextManifest | null;
}

/** v2 组装入参：v1 全部输入（形状与 buildContextFull 逐字段一致）+ wire/manifest 现读值。 */
export interface ContextFullV2Input {
  readonly sessionID: string;
  readonly capturedAt: number;
  readonly systemPrompt: string;
  readonly assembly: Assembly | null;
  readonly messages: readonly Message[];
  readonly contextWindow: number | null;
  /** loop.session.lastWireRequest（null = 尚无 LLM 调用 → wire:null）。 */
  readonly wireSnapshot: WireRequestSnapshot | null;
  /** loop.session.lastProviderPayload（null + snapshot 在场 → 逐字缺席理由）。 */
  readonly providerPayload: string | null;
  /** boot 装配 manifest（未接线 = null，面板诚实留空面）。 */
  readonly manifest: ContextManifest | null;
  /** W23-A：wireSnapshot 的来源面（缺省 "live"；loop 槽空回落缓存时路由传 "cache"）。 */
  readonly wireSource?: WireSource;
}

/**
 * v1 逐字节 + 加性 wire/manifest（纯函数；输入由路由层从 live loop 现读注入）。
 * 组合实现 = 原样调 buildContextFull 后仅换 note、挂两新键 —— v1 值等值性由
 * context-full-v2.test.ts 与 buildContextFull 直出比对钉死。
 */
export function buildContextFullV2(input: ContextFullV2Input): ContextFullV2View {
  const { wireSnapshot, providerPayload, manifest, wireSource, ...v1Input } = input;
  const v1 = buildContextFull(v1Input);
  return {
    ...v1,
    note: CONTEXT_FULL_V2_NOTE,
    wire: buildWireView(wireSnapshot, providerPayload, wireSource ?? "live"),
    manifest,
  };
}

/** 缓存基面重建入参（无 live loop；路由从 wire-cache + durable 转录现读注入）。 */
export interface ContextFullCacheInput {
  readonly sessionID: string;
  /** 缓存落盘时刻（= 响应 capturedAt，诚实申明非请求时刻）。 */
  readonly savedAt: number;
  /** wire/{sid}.json 的脱敏快照（写前已脱敏，buildWireView 再过一遍同一闸）。 */
  readonly snapshot: WireRequestSnapshot;
  /** 缓存的 provider 载荷（fake 通道 = null + 逐字缺席理由）。 */
  readonly providerPayload: string | null;
  /** durable 转录（store 重放，含压缩边界语义；口径见 registry.transcriptMessages）。 */
  readonly messages: readonly Message[];
  /** 模型上下文窗口（boot 模型句柄现值；模型未带 = null）。 */
  readonly contextWindow: number | null;
  /** boot 装配 manifest（与 loop 基面同源）。 */
  readonly manifest: ContextManifest | null;
}

/**
 * 纯缓存基面 v2 视图（basis:"cache"）：v1 十四键**键集全在场**，值 = 缓存/durable 推导——
 * systemPrompt = 缓存快照 post-pipe 值（assembly 缺席 ⇒ prefixHash 走如实回退等式）；
 * segments = []（装配对象不可恢复，绝不编造偏移）；messages 序列化与 v1 同口径
 * （canonical JSON、偏移自前缀累加）。实现 = buildContextFull 原组合 + 三处如实覆盖
 * （basis/capturedAt/note），其余十四键零改写。
 */
export function buildContextFullCacheV2(input: ContextFullCacheInput): ContextFullV2View {
  const v1 = buildContextFull({
    sessionID: input.sessionID,
    capturedAt: input.savedAt,
    systemPrompt: input.snapshot.systemPrompt,
    assembly: null,
    messages: input.messages,
    contextWindow: input.contextWindow,
  });
  return {
    ...v1,
    basis: "cache",
    note: `${CONTEXT_FULL_V2_NOTE}${CONTEXT_FULL_CACHE_NOTE_SUFFIX}`,
    wire: buildWireView(input.snapshot, input.providerPayload, "cache"),
    manifest: input.manifest,
  };
}
