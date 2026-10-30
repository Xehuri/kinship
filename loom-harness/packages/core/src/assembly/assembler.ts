/**
 * 上下文装配器（T18，docs/01 D6/D21、docs/02 §T18）。
 *
 * 分层装配 = prompt cache 命中结构：前缀段（system → memory → workflow）字节级
 * 恒定，增量段（increment）只在尾部增长。装配核心是**纯函数**：所有 IO 已由
 * reader 在边界完成（缺失→null→占位，异常→降级记录），核心零 throw、零时钟、
 * 零随机、无属性序抖动——同输入双跑前缀字节全等由构造保证，测试钉住不变量。
 *
 * 字节序稳定三防线：
 *  1. memory 源按声明层前缀纪律清单序注入（memory-declaration 唯一口径：声明序
 *     分组 + 组内字典序；文件遍历序不流入字节流，IO 边界去重保序不再排序）；
 *  2. 每段头部是恒定模板文本，源内容原样嵌入，不加时间戳/序号以外的可变量；
 *  3. 历史行经 canonicalRow（键字典序）序列化（fs-reader.ts）。
 *
 * 收束工具说明（T09 convergence 并行开发中）：`convergenceToolNote` 未提供时用
 * 固定占位文本入段0；占位文本恒定 ⇒ 前缀稳定不受影响。
 */

import { createHash } from "node:crypto";
import type {
  Assembly,
  AssemblyDegrade,
  AssemblyPlan,
  AssemblyReader,
  MemorySource,
  Segment,
  TurnInput,
  WorkflowTemplate,
} from "./types.js";

/** 缺源声明占位（不含任何每轮可变内容，进前缀不破坏 cache）。 */
export const MISSING_PLACEHOLDER = "[assembly: source missing, degraded]";
/** 坏源/读失败声明占位。 */
export const UNREADABLE_PLACEHOLDER = "[assembly: source unreadable, degraded]";
/** 收束工具说明占位（T09 落地前恒用此文本）。 */
export const DEFAULT_CONVERGENCE_NOTE = "[convergence tools: not configured]";

/** 段间分隔符：显式、恒定，保证「前缀字节是全量字节的前缀」逐段可验。 */
const SEGMENT_SEP = "\n";

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function sha256Hex(parts: readonly Uint8Array[]): string {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return `sha256:${h.digest("hex")}`;
}

/**
 * memory 源字节契约（fail-soft 守门校验）：
 *  - 无 NUL 字节（非文本/损坏）；
 *  - 不含"每轮易变"签名：日期后紧跟时分（`2026-09-13 08:00` / `T08:00`）——
 *    此类内容进前缀会让 cache 每轮 miss，判 invalid 降级。
 *    （AGENTS.md 的「最后更新: 2026-09-13」只有日期无时分，属稳定元数据，放行。）
 */
export function memorySourceContract(text: string): boolean {
  if (text.includes("\u0000")) return false;
  return !/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(text);
}

/**
 * W35 "off" 模式的放宽面（`server.sourceContract: off`，用户 2026-10-14 决策）：
 * 只保留 NUL/二进制闸，豁免"每轮易变时间戳"条款——业务记忆件（纠错/任务/身份）
 * 里的 `2026-09-13 08:00` 式时间戳让 strict 面整件降级 36B 占位，实例级开关放行。
 * **两面必须同居本文件**：resolveMemorySources 的 validate 缺省参只引用这里的
 * 谓词，strict 面 memorySourceContract 与其正则逐字节不动、本函数不引用之——
 * 单真源纪律，禁在任何下游第二定义校验谓词。NUL 闸两模式恒在（二进制噪声进
 * 前缀=损坏件，与开关语义无关，绝不放宽）。
 */
export function memorySourceContractRelaxed(text: string): boolean {
  return !text.includes("\u0000");
}

/**
 * 稳定 memory 注入清单（IO 边界）：按声明层清单序逐一经 reader 读入（去重保序、
 * **绝不重排**——排序口径唯一真源在 memory-declaration，本边界再排序=第二口径，
 * 禁），校验 `memorySourceContract`（可传 validate 覆盖）。任何失败归一化为
 * 占位内容 + 类型化 degrade，绝不 throw——装配核心只消费清单。
 */
export function resolveMemorySources(
  reader: AssemblyReader,
  paths: readonly string[],
  validate: (text: string) => boolean = memorySourceContract,
): { readonly sources: readonly MemorySource[]; readonly degrades: readonly AssemblyDegrade[] } {
  const degrades: AssemblyDegrade[] = [];
  const sources: MemorySource[] = [];
  for (const path of new Set(paths)) {
    let text: string | null;
    let ioError: string | null = null;
    try {
      text = reader.readText(path);
    } catch (err) {
      text = null;
      ioError = String(err);
    }
    let content: string;
    let degrade: AssemblyDegrade | null;
    if (ioError !== null) {
      degrade = { segment: "memory", source: path, reason: "unreadable", detail: ioError };
      content = UNREADABLE_PLACEHOLDER;
    } else if (text === null) {
      degrade = { segment: "memory", source: path, reason: "missing", detail: null };
      content = MISSING_PLACEHOLDER;
    } else if (!validate(text)) {
      degrade = { segment: "memory", source: path, reason: "invalid", detail: "fails memorySourceContract" };
      content = MISSING_PLACEHOLDER;
    } else {
      degrade = null;
      content = text;
    }
    if (degrade !== null) degrades.push(degrade);
    sources.push({ source: path, content, degrade });
  }
  return { sources, degrades };
}

/** 段0：系统提示 + 收束工具说明（T09 占位）。 */
function systemBytes(plan: AssemblyPlan): Uint8Array {
  const note = plan.convergenceToolNote ?? DEFAULT_CONVERGENCE_NOTE;
  return encode(`## system\n${plan.systemPrompt}\n${note}\n`);
}

/**
 * 段1 渲染（memory 注入字节块的唯一真源）：每源带路径标题；
 * 清单序=声明层前缀纪律序（memory-declaration 唯一真源，本链不重排）⇒ 字节序固定。
 * 装配段1 与副会话 systemPrompt 前缀共用本函数——"任何角色的注入集"渲染形状只此一份。
 */
export function renderMemorySegment(sources: readonly MemorySource[]): string {
  return sources.map((s, i) => `### memory[${String(i)}] ${s.source}\n${s.content}\n`).join("");
}

/** 段1：稳定 memory 注入（经 renderMemorySegment 唯一渲染路径）。 */
function memoryBytes(sources: readonly MemorySource[]): Uint8Array {
  return encode(renderMemorySegment(sources));
}

/** 段2：任务提示词模板（workflows 声明序注入，不重排；null 模板 → 占位+degrade）。 */
function workflowBytes(
  workflows: readonly WorkflowTemplate[],
): { readonly bytes: Uint8Array; readonly degrades: readonly AssemblyDegrade[] } {
  const degrades: AssemblyDegrade[] = [];
  const parts: string[] = [];
  for (const wf of workflows) {
    if (wf.prompt === null) {
      degrades.push({ segment: "workflow", source: wf.name, reason: "missing", detail: null });
      parts.push(`## workflow ${wf.name}\n${MISSING_PLACEHOLDER}\n`);
    } else {
      parts.push(`## workflow ${wf.name}\n${wf.prompt}\n`);
    }
  }
  return { bytes: encode(parts.join("")), degrades };
}

/**
 * Uint8Array 串接（前缀段字节流拼接；与 assemble 的 hash 输入序一致）。
 */
function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/**
 * 装配稳定前缀的文本渲染（段0 system + 段1 memory + 段2 workflow，段间 SEGMENT_SEP）——
 * 主会话请求面 systemPrompt 的唯一真源（Unit B 接线）：与 assemble() 的前三段
 * **同一批字节生产者**（systemBytes/memoryBytes/workflowBytes），故
 * `sha256(renderAssemblyPrefix(plan)) === assemble(...).prefixHash` 恒成立——
 * 发给模型的字节 = trace 声明的前缀，不养第二渲染路径。plan 是跨轮静态声明 ⇒
 * 输出字节跨轮恒定（W14/D21 前缀纪律）；增量段（段3）**不含**：每轮易变内容由
 * 对话 messages 本体承载，天然挂在稳定前缀之后、只尾增。
 */
export function renderAssemblyPrefix(plan: AssemblyPlan): string {
  const wf = workflowBytes(plan.workflows);
  return new TextDecoder().decode(
    concatBytes([systemBytes(plan), encode(SEGMENT_SEP), memoryBytes(plan.memorySources), encode(SEGMENT_SEP), wf.bytes]),
  );
}

/**
 * 用新 plan 重建稳定前缀（段0..2），**原样保留上一份装配的增量段**。
 *
 * 用途：turn 边界重装配已发生过、但 plan 之后才变（system prompt 热重载 / 压缩后刷新）时，
 * 不重新读历史、不合成空增量——只换前缀字节并重算 hash。字节生产者与 {@link assemble}
 * 同一批（systemBytes/memoryBytes/workflowBytes + SEGMENT_SEP 布局），故
 * `rebaseAssemblyPrefix(prev, plan).prefixHash === assemble(plan, ...).prefixHash`。
 *
 * degrades 口径：新 plan 的 memory/workflow 降级 + 上一份装配的 increment 降级
 * （increment 从未被重读，其降级记录仍是事实）。
 */
export function rebaseAssemblyPrefix(previous: Assembly, plan: AssemblyPlan): Assembly {
  const sysB = systemBytes(plan);
  const memB = memoryBytes(plan.memorySources);
  const wf = workflowBytes(plan.workflows);
  const previousIncrement = previous.segments.find((s) => s.name === "increment");
  if (previousIncrement === undefined) {
    throw new Error("rebaseAssemblyPrefix: previous assembly has no increment segment");
  }
  const incB = previousIncrement.bytes;

  const sepB = encode(SEGMENT_SEP);
  const segments: Segment[] = [
    { name: "system", bytes: sysB, stable: true },
    { name: "memory", bytes: memB, stable: true },
    { name: "workflow", bytes: wf.bytes, stable: true },
    { name: "increment", bytes: incB, stable: false },
  ];

  const degrades: AssemblyDegrade[] = [];
  for (const s of plan.memorySources) {
    if (s.degrade !== null) degrades.push(s.degrade);
  }
  degrades.push(...wf.degrades);
  for (const d of previous.degrades) {
    if (d.segment === "increment") degrades.push(d);
  }

  return {
    segments,
    prefixHash: sha256Hex([sysB, sepB, memB, sepB, wf.bytes]),
    fullHash: sha256Hex([sysB, sepB, memB, sepB, wf.bytes, sepB, incB]),
    degrades,
    memorySourceCount: plan.memorySources.length,
    incrementRows: previous.incrementRows,
    openedShards: previous.openedShards,
  };
}

/** 增量读历史（IO 边界 fail-soft：reader 抛错 → 占位行 + degrade，不炸装配）。 */
function readHistory(
  reader: AssemblyReader | null,
  cursor: number,
): { readonly lines: readonly string[]; readonly openedShards: number; readonly degrade: AssemblyDegrade | null } {
  if (reader === null) return { lines: [], openedShards: 0, degrade: null };
  try {
    const inc = reader.readHistoryIncrement(cursor);
    return { lines: inc.lines, openedShards: inc.openedShards, degrade: null };
  } catch (err) {
    return {
      lines: [UNREADABLE_PLACEHOLDER],
      openedShards: 0,
      degrade: { segment: "increment", source: "history", reason: "unreadable", detail: String(err) },
    };
  }
}

/**
 * 一轮装配：plan（稳定声明）+ reader（历史增量注入，可 null=无会话历史）+ turn 输入。
 * 纯函数（IO 已被 reader 边界化）；任何注入失败 → 类型化 degrade 记录，绝不 throw。
 * 输出段序 [system, memory, workflow, increment]；prefixHash 覆盖前三段（cache 前缀），
 * fullHash 覆盖全部四段。
 */
export function assemble(
  plan: AssemblyPlan,
  reader: AssemblyReader | null,
  input: TurnInput,
): Assembly {
  const sysB = systemBytes(plan);
  const memB = memoryBytes(plan.memorySources);
  const wf = workflowBytes(plan.workflows);
  const hist = readHistory(reader, input.historyCursor);

  const incParts: string[] = [];
  for (const line of hist.lines) incParts.push(`history+ ${line}\n`);
  for (const n of input.nudges ?? []) incParts.push(`nudge: ${n}\n`);
  for (const r of input.reminders ?? []) incParts.push(`reminder: ${r}\n`);
  if (input.currentMessage !== undefined && input.currentMessage !== null) {
    incParts.push(`user: ${input.currentMessage}\n`);
  }
  const incB = encode(incParts.length === 0 ? "" : `## increment\n${incParts.join("")}`);

  const sepB = encode(SEGMENT_SEP);
  const segments: Segment[] = [
    { name: "system", bytes: sysB, stable: true },
    { name: "memory", bytes: memB, stable: true },
    { name: "workflow", bytes: wf.bytes, stable: true },
    { name: "increment", bytes: incB, stable: false },
  ];

  const degrades: AssemblyDegrade[] = [];
  for (const s of plan.memorySources) {
    if (s.degrade !== null) degrades.push(s.degrade);
  }
  degrades.push(...wf.degrades);
  if (hist.degrade !== null) degrades.push(hist.degrade);

  return {
    segments,
    // 前缀 = 段[0..2] 及其分隔符的拼接字节，是全量字节序列的严格前缀。
    prefixHash: sha256Hex([sysB, sepB, memB, sepB, wf.bytes]),
    fullHash: sha256Hex([sysB, sepB, memB, sepB, wf.bytes, sepB, incB]),
    degrades,
    memorySourceCount: plan.memorySources.length,
    incrementRows: hist.lines.length,
    openedShards: hist.openedShards,
  };
}
