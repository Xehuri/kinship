/**
 * W16-B 上下文全字节面 —— GET /sessions/:id/context/full 的纯逻辑层。
 *
 * 定位：W13 /context（分段构成清单）的**请求面**大哥——逐字节还原真实发给模型的
 * 上下文字节（用户硬口径：一字不漏）。真源全部取自 live loop 公开口：
 *   - systemPrompt = `loop.session.systemPrompt` —— W15-B 起主循环实际发给模型的
 *     前缀字符串（装配接线时 = renderAssemblyPrefix(plan) 产物，main-loop/loop.ts
 *     wireParts 的 promptBytes 经 KernelInit.systemPrompt 传入 AgentSession；
 *     session.ts 的 `readonly systemPrompt` public 字段）。
 *   - segments = `loop.currentAssembly()` 的段字节解码（live/reconciled：systemPrompt/
 *     memory 重读后按新 plan 重建前缀，避免 v1 请求面读到过期段；尚未真实装配 = null，
 *     此时回落 `loop.assemblies()` 尾项。assemblies()/trace 本身仍是历史事件面）。
 *   - messages = `loop.session.messages` —— 完整 durable 转录（AgentSession.messages
 *     getter；transient 提醒附件不进此数组，W12 语义，见 MainSessionLoop.remind 注释）。
 *
 * 规范请求面串（offset 的坐标系，机械可重构）：
 *   canonical = systemPrompt + "\n"（仅当 messages 非空）+ Σ message.text（依序、无额外分隔）
 *   - prefixByteLength = UTF-8(systemPrompt)
 *   - segments 的 offset 在前缀区内累加，段间 +1 字节分隔位（renderAssemblyPrefix
 *     段间 SEGMENT_SEP="\n"，assembler.ts:39/169；分隔字节不属任何段、不计入段 byteLength）；
 *     仅取 stable=true 段（system/memory/workflow = 请求面字节）。increment 段是
 *     簿记面产物**不发给模型**（W15-B 裁决"增量段3 不进 systemPrompt"），绝不给它
 *     编造请求面偏移——易变内容由 messages 本体承载。
 *   - messages[0].offset = prefixByteLength + (messages.length > 0 ? 1 : 0)，
 *     其后逐条累加 byteLength。
 *
 * 恒等式（W15-B 测试钉死，本模块复述为响应内不变量）：
 *   systemPromptSha256 === prefixHash —— 装配在场时 prefixHash 取 Assembly 声明值
 *   （sha256(发模型字节)=装配前缀哈希，assembler.ts:161 构造保证 + boot-assembly.test.ts
 *   W15-B describe ③ 请求面实证）；无装配快照时如实回退为发送字节自身 sha256（同一
 *   `sha256:<hex>` 形状，恒等式平凡成立，note 不谎称装配在场）。
 *
 * 序列化口径：message.text = 键字典序稳定 JSON（与 canonicalRow"杜绝属性序抖动
 * 进字节流"同纪律，fs-reader.ts:22-23；行式 `k=v` 形态不适用于消息体，故取 JSON 形）。
 * API 层零截断、零分页——收敛/折叠是 UI（Lane C）的职责。
 */

import { createHash } from "node:crypto";
import type { Message } from "@axeuh/loom-core";
import type { Assembly } from "@axeuh/loom-core/assembly";

/** 段间分隔符字节宽（renderAssemblyPrefix 的 SEGMENT_SEP = "\n"，单字节 UTF-8）。 */
const SEGMENT_SEP_BYTES = 1;

/** 前缀段一条（请求面偏移可寻址的字节段）。 */
export interface ContextFullSegment {
  /** 本视图内序号（0 起，依 Assembly 段序）。 */
  readonly index: number;
  /** 段名 = Assembly 段名原值（"system" | "memory" | "workflow"；机器口径，展示名由前端自定）。 */
  readonly label: string;
  /** 规范请求面串内的 UTF-8 起始字节偏移。 */
  readonly offset: number;
  /** 段体 UTF-8 字节数（不含段间分隔字节）。 */
  readonly byteLength: number;
  /** 段体全文（TextDecoder 解码，零截断）。 */
  readonly text: string;
}

/** 转录消息一条（完整 JSON 序列化 + 请求面偏移）。 */
export interface ContextFullMessage {
  /** 转录序号（0 起 = session.messages 下标）。 */
  readonly index: number;
  /** 消息角色原值（"user" | "assistant" | "toolResult"）。 */
  readonly role: string;
  /** 规范请求面串内的 UTF-8 起始字节偏移。 */
  readonly offset: number;
  /** text 的 UTF-8 字节数。 */
  readonly byteLength: number;
  /** 完整消息 JSON（键字典序稳定序列化，零截断）。 */
  readonly text: string;
}

/** GET /sessions/:id/context/full 响应体（Lane C 冻结契约，字段逐字对齐）。 */
export interface ContextFullView {
  readonly sessionID: string;
  /** 采集时刻（epoch ms，请求现场；basis:"cache" = 缓存落盘时刻 savedAt，W23-A）。 */
  readonly capturedAt: number;
  /**
   * 数据基面："live" = 内存 live loop 现读（W16-B 原语义）；"cache"（W23-A 加性）=
   * 无 live loop、纯 wire/{sid}.json 缓存重建（侧/子会话重启后可查面）。
   */
  readonly basis: "live" | "cache";
  /** 装配前缀哈希声明值 `sha256:<hex>`；无装配快照时 = systemPromptSha256（回退如实）。 */
  readonly prefixHash: string;
  /** sha256(实际发送前缀字节)，`sha256:<hex>` 形（与 prefixHash 同形可全等比较）。 */
  readonly systemPromptSha256: string;
  /** 发模型的 systemPrompt 逐字全文（W15-B renderAssemblyPrefix 产物）。 */
  readonly systemPrompt: string;
  /** systemPrompt 的 UTF-8 字节数。 */
  readonly prefixByteLength: number;
  /** 前缀分段（仅请求面 stable 段，偏移累加含段间分隔位）。 */
  readonly segments: readonly ContextFullSegment[];
  /** durable 转录全量序列化（依序、零截断）。 */
  readonly messages: readonly ContextFullMessage[];
  /** Σ messages[].byteLength。 */
  readonly messagesByteLength: number;
  /** 规范请求面串总字节 = prefixByteLength + 分隔位（有消息才计）+ messagesByteLength。 */
  readonly totalPromptByteLength: number;
  /** 模型上下文窗口（token）；模型未带时 null。 */
  readonly contextWindow: number | null;
  /** 恒 true：transient 提醒附件不在本视图（W12 通道只进下轮 messages view + 段3 簿记面）。 */
  readonly transientExcluded: true;
  readonly note: string;
}

/** v1 口径全文（W16-B 冻结文本；v2 note 以此为逐字前缀，见 context-full-v2.ts）。 */
export const CONTEXT_FULL_NOTE =
  "规范请求面串 = systemPrompt + '\\n'（仅当存在消息）+ 各消息序列化文本依序拼接；" +
  "offset/byteLength 为该串内 UTF-8 字节偏移（段间分隔字节不计入段体）。" +
  "消息 text = 键字典序 JSON（零截断，折叠归 UI）。" +
  "transient 提醒附件不进本视图（W12：只随注入进下一次调用与段3 簿记面，不在 session.messages、不落盘）；" +
  "increment 装配段为簿记面、非请求面字节，故 segments 只列 stable 段。" +
  "本面 = 内存 live loop 现读（同 W13 内存纪律，服务重启后无 loop 即 404）。";

/** 前缀字节哈希（`sha256:<hex>`，同 assembler.ts sha256Hex 的 prefix-shape 惯例）。 */
function sha256Prefixed(text: string): string {
  return `sha256:${createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex")}`;
}

/** 键字典序稳定 JSON（防属性序抖动进字节流；对偶 canonicalRow 的纪律，取 JSON 形态）。 */
function canonicalJson(value: unknown): string {
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

/** Assembly stable 段 → 前缀区分条（偏移累加含段间 1 字节分隔位；increment 簿记段不入）。 */
function buildSegments(assembly: Assembly | null): ContextFullSegment[] {
  if (assembly === null) return [];
  const decoder = new TextDecoder();
  const out: ContextFullSegment[] = [];
  let offset = 0;
  for (const segment of assembly.segments) {
    if (!segment.stable) continue;
    if (out.length > 0) offset += SEGMENT_SEP_BYTES; // 段间 SEGMENT_SEP（不属两侧段体）
    const text = decoder.decode(segment.bytes);
    out.push({ index: out.length, label: segment.name, offset, byteLength: segment.bytes.byteLength, text });
    offset += segment.bytes.byteLength;
  }
  return out;
}

/** durable 转录 → 逐条序列化 + 请求面偏移（自 startOffset 起依序累加，零截断）。 */
function buildMessages(messages: readonly Message[], startOffset: number): ContextFullMessage[] {
  const out: ContextFullMessage[] = [];
  let offset = startOffset;
  for (const message of messages) {
    const text = canonicalJson(message);
    const byteLength = Buffer.byteLength(text, "utf8");
    out.push({ index: out.length, role: message.role, offset, byteLength, text });
    offset += byteLength;
  }
  return out;
}

/**
 * Assembly + 转录 → 完整请求面视图（纯函数；输入由路由层从 live loop 现读注入）。
 * systemPrompt 以**发送面字符串为真源**（verbatim），segments 只做其内部分段拆解；
 * 两者不一致属于上游接线缺陷，本层不修补不掩饰（恒等式由 W15-B 在源头钉死）。
 */
export function buildContextFull(opts: {
  readonly sessionID: string;
  readonly capturedAt: number;
  readonly systemPrompt: string;
  /** live/reconciled 前缀视图（loop.currentAssembly()，缺省回落 assemblies() 尾项）；未接线 = null。 */
  readonly assembly: Assembly | null;
  readonly messages: readonly Message[];
  readonly contextWindow: number | null;
}): ContextFullView {
  const { sessionID, capturedAt, systemPrompt, assembly, messages, contextWindow } = opts;
  const systemPromptSha256 = sha256Prefixed(systemPrompt);
  const prefixByteLength = Buffer.byteLength(systemPrompt, "utf8");
  // 装配在场 → prefixHash 用 Assembly 声明值（与发送字节的等式由 assembler.ts:161
  // 构造保证 + W15-B 请求面测试钉死）；缺席 → 如实回退为发送字节自身哈希（形状一致，
  // 等式平凡成立，不伪造"装配在场"）。
  const prefixHash = assembly === null ? systemPromptSha256 : assembly.prefixHash;
  const segments = buildSegments(assembly);
  const sepByte = messages.length > 0 ? 1 : 0;
  const entries = buildMessages(messages, prefixByteLength + sepByte);
  const messagesByteLength = entries.reduce((n, m) => n + m.byteLength, 0);
  return {
    sessionID,
    capturedAt,
    basis: "live",
    prefixHash,
    systemPromptSha256,
    systemPrompt,
    prefixByteLength,
    segments,
    messages: entries,
    messagesByteLength,
    totalPromptByteLength: prefixByteLength + sepByte + messagesByteLength,
    contextWindow,
    transientExcluded: true,
    note: CONTEXT_FULL_NOTE,
  };
}
