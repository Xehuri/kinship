/**
 * W17-B 发线面出口视图 —— GET /sessions/:id/context/full v2 的 `wire` 块构建层。
 *
 * 定位：core A1 装配口快照（WireRequestSnapshot，内存单槽）→ 面板冻结契约的 wire 形状。
 * 纯函数、零 IO；输入由路由层从 live loop 现读注入：
 *   - snapshot = `loop.session.lastWireRequest`（null = 尚无 LLM 调用 → wire:null，200 诚实面）；
 *   - providerPayload = `loop.session.lastProviderPayload`（fake 通道永不触发 onPayload →
 *     null + 逐字缺席理由，面板原样转呈）。
 *
 * 脱敏纪律（fail-closed 唯一出口闸）：optionsText 是 core 记的**原始**摊平（apiKey/headers
 * 明文在场，core 侧注释冻结"脱敏是 server 侧职责"）。params 出网前过 redactSecrets：
 * 键名命中 /key|token|secret/i（子串、大小写不敏感）一律换 "***"，深度递归含数组。
 * providerPayload 逐字节原样透传：pi-ai buildParams 的出向载荷不带凭据（auth 走 SDK
 * client options，不在 params），零命中钉测试以 seed-key 全响应 grep 证明 fail-closed。
 */

import { canonicalJson, type WireRequestSnapshot } from "@axeuh/loom-core";

/** 载荷缺席逐字理由（W17-C 面板按原样转呈，一字不可改）。 */
export const PROVIDER_PAYLOAD_ABSENT_REASON =
  "当前模型通道不触发 provider onPayload（如 fake api）";

/** wire.request.messages 一条（transient 尾标：末 transientCount 条 = true）。 */
export interface WireMessageView {
  readonly index: number;
  readonly role: string;
  /** text 的 UTF-8 字节数。 */
  readonly byteLength: number;
  /** 该消息的 canonical JSON 全文（重序列化 = 捕获原文逐字节切片，键序已定）。 */
  readonly text: string;
  readonly transient: boolean;
}

/** wire.request.tools 一项（A1 三字段原样）。 */
export interface WireToolView {
  readonly name: string;
  readonly description: string;
  readonly schemaText: string;
}

/** wire.request（post-pipe 发线请求面四件套）。 */
export interface WireRequestView {
  readonly systemPrompt: string;
  readonly messages: readonly WireMessageView[];
  readonly tools: readonly WireToolView[];
  /** resolveLlmOptions 摊平产物，已过 redactSecrets（凭据键一律 "***"）。 */
  readonly params: Record<string, unknown>;
}

/** W23-A wire 块数据来源（"live"=内存单槽；"cache"=wire/{sid}.json 回落）。 */
export type WireSource = "live" | "cache";

/** wire 块（Lane C 冻结契约形状；snapshot 缺席 = null）。 */
export interface WireView {
  /**
   * W23-A 加性来源标："live" = core 内存单槽现读；"cache" = wire/{sid}.json 持久缓存
   * 回落（写前已脱敏）。面板据此区分"本轮真发"与"重启后残影"。
   */
  readonly source: WireSource;
  readonly capturedAt: number;
  readonly turnIdx: number;
  readonly model: { readonly id: string; readonly api: string; readonly provider: string };
  readonly request: WireRequestView;
  readonly providerPayload: string | null;
  readonly providerPayloadAbsentReason: string | null;
}

/** 凭据键名判别（子串匹配，大小写不敏感；宁可多打不可漏放）。 */
const SECRET_KEY_RE = /key|token|secret/i;

/** 脱敏占位值（单点防口径漂移）。 */
const REDACTED = "***";

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 深脱敏（数组递归在内）：命中凭据键名的值整体替换 "***"（值类型不限——string/number/
 * 嵌套对象都可能承载凭据）；未命中键递归下钻，返回新结构不改入参。
 */
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item));
  if (isJsonObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      out[key] = SECRET_KEY_RE.test(key) ? REDACTED : redactSecrets(v);
    }
    return out;
  }
  return value;
}

/** A1 快照内 JSON.parse 窄化（core 同进程 canonical 产物；形状违约 = 不变式破坏，响亮抛）。 */
function parseCanonicalObject(text: string, what: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);
  if (!isJsonObject(parsed)) {
    throw new Error(`wire 快照不变式破坏：${what} 不是 JSON 对象`);
  }
  return parsed;
}

function parseCanonicalArray(text: string, what: string): readonly Record<string, unknown>[] {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) {
    throw new Error(`wire 快照不变式破坏：${what} 不是 JSON 数组`);
  }
  const out: Record<string, unknown>[] = [];
  const items: readonly unknown[] = parsed;
  for (const item of items) {
    if (!isJsonObject(item)) {
      throw new Error(`wire 快照不变式破坏：${what} 含非对象条目`);
    }
    out.push(item);
  }
  return out;
}

/**
 * messagesText（捕获原文）→ 逐条视图。text 用 canonicalJson(重解析条目) 重建：
 * canonical 定点性（序列化幂等）保证与原文切片逐字节相等；byteLength 即 UTF-8 宽。
 * transient 尾标：末 transientCount 条标 true（core 侧申明附件恒为连续尾段；
 * transientCount 超界时如实钳到全量——多标不多造，缺席面零伪造）。
 */
function buildMessageViews(
  messagesText: string,
  transientCount: number,
): WireMessageView[] {
  const entries = parseCanonicalArray(messagesText, "messagesText");
  const transientStart = Math.max(0, entries.length - Math.max(0, transientCount));
  return entries.map((entry, index) => {
    const text = canonicalJson(entry);
    const rawRole = entry["role"];
    return {
      index,
      role: typeof rawRole === "string" ? rawRole : "message",
      byteLength: Buffer.byteLength(text, "utf8"),
      text,
      transient: index >= transientStart,
    };
  });
}

/**
 * A1 快照 + A2 载荷 → wire 出口视图。snapshot null（loop 在但还没跑过任何 LLM call）
 * → 返回 null，路由层原样挂 wire:null（200 诚实面，面板显「尚无发线捕获」）。
 * source（W23-A）："live" 缺省；缓存回落面传 "cache"（盘上快照写侧已脱敏，本函数再
 * 过一遍同一 redactSecrets 闸 = 幂等，双保险不放宽）。
 */
export function buildWireView(
  snapshot: WireRequestSnapshot | null,
  providerPayload: string | null,
  source: WireSource = "live",
): WireView | null {
  if (snapshot === null) return null;
  const params = redactSecrets(parseCanonicalObject(snapshot.optionsText, "optionsText"));
  if (!isJsonObject(params)) {
    // redactSecrets 对对象输入仍返回对象；此闸防类型漂移，凭据出网零侥幸。
    throw new Error("wire 快照不变式破坏：params 脱敏后不是 JSON 对象");
  }
  return {
    source,
    capturedAt: snapshot.capturedAt,
    turnIdx: snapshot.turnIdx,
    model: {
      id: snapshot.model.id,
      api: snapshot.model.api,
      provider: snapshot.model.provider,
    },
    request: {
      systemPrompt: snapshot.systemPrompt,
      messages: buildMessageViews(snapshot.messagesText, snapshot.transientCount),
      tools: snapshot.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        schemaText: tool.schemaText,
      })),
      params,
    },
    providerPayload,
    providerPayloadAbsentReason: providerPayload === null ? PROVIDER_PAYLOAD_ABSENT_REASON : null,
  };
}
