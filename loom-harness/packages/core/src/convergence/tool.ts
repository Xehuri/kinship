/**
 * 收束工具（D25/D30）—— 会话终止的唯一合法通道。
 *
 * schema = 回执结构（main 三态 / side 批次回执）；TypeBox 挡「必填缺失 / 枚举越界」，
 * execute 里 parseReceiptArgs 再挡「语义空壳」（whitespace、非整数 attempt）。
 * 缺字段 / 重复调用在 execute 内拒绝（throw → 内核转为 isError toolResult 回灌模型）；
 * 与干活工具同轮混用是合法的——同批全部照常执行，收束照常受理。
 *
 * 工具本体不做任何终止决策：成功受理只写 convergence.accepted 槽（回执同时落进
 * toolResult details.__convergence），「本轮到此结束」由 ConvergenceGate 在 onTurnEnd
 * 穷尽判别后统一裁决。拒收时把离散原因 push 进 convergence.last-fail FIFO，
 * gate 在 onPostToolUse 按执行顺序消费（tool.execute 拿不到自己的 toolCallId，
 * 数组序 = 执行序 = PostToolUse 序，单线程语义保证对齐）。
 */

import { Type } from "@earendil-works/pi-ai";
// 环纪律：见 gate.ts 同款注释。深路径直引，不 import 自身 barrel。
import { defineSlot, type HookContext } from "../hook.js";
import type { HarnessTool } from "../types.js";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import {
  nextWakeAtOf,
  parseReceiptArgs,
  type NudgeReason,
  type Receipt,
  type SessionKind,
} from "./receipt.js";
import { formatWakeAt } from "./wake.js";

export const CONVERGE_TOOL_NAME = "converge" as const;

export const CONVERGE_ALIASES: readonly string[] = ["converge-main", "converge-side"];

export function isConvergeCallName(name: string): boolean {
  return name === CONVERGE_TOOL_NAME || CONVERGE_ALIASES.includes(name);
}

export interface AcceptedConvergence {
  readonly turnIdx: number;
  /**
   * W47 run 代际：onSessionStart 复位时递增（见 gate.ts resetRunState）。
   * 查重必须同代际才认——registry 的 loop/ctx.state 按 sid 长驻而内核 turnIdx 每个
   * run 从 0 重数，仅按 turnIdx 相等判重会让上一 run 残留槽假拒新 run 的合法首收敛。
   */
  readonly runGen: number;
  readonly receipt: Receipt;
}

export const ACCEPTED_SLOT = defineSlot<AcceptedConvergence | null>(
  "convergence.accepted",
  { owner: "convergence" },
);

/** W47 run 代际计数（与 ACCEPTED_SLOT 同一复位点递增；缺席=0 = 未挂任何 gate 钩子）。 */
export const RUN_GEN_SLOT = defineSlot<number>("convergence.run-gen", {
  owner: "convergence",
});

export interface ConvergeFailInfo {
  readonly turnIdx: number;
  readonly reason: NudgeReason;
  readonly detail: string;
}

export const FAIL_SLOT = defineSlot<ConvergeFailInfo[]>(
  "convergence.last-fail",
  { owner: "convergence" },
);

const WAKE_DESCRIPTION =
  "下次自动唤醒时间：倒计时（30s/10m/1h30m/2天）、带时区 ISO（2026-10-22T08:00:00+08:00）、" +
  "本地时间（2026-10-22 08:00）、HH:MM（下一次）或 none 清除；缺省=不改动。最长 30 天。";

export interface ConvergenceToolOptions {
  readonly autoWakeEnabled?: boolean;
  readonly now?: () => number;
}

function mainSchema(autoWakeEnabled: boolean) {
  return Type.Object({
    status: Type.Union([
      Type.Literal("已完成"),
      Type.Literal("待用户回应"),
      Type.Literal("需用户确认"),
    ]),
    pointers: Type.Optional(Type.Array(Type.String())),
    blockers: Type.Optional(Type.Array(Type.String())),
    ...(autoWakeEnabled
      ? { wake: Type.Optional(Type.String({ description: WAKE_DESCRIPTION })) }
      : {}),
  });
}

function sideSchema() {
  return Type.Object({
    status: Type.Union([
      Type.Literal("done"),
      Type.Literal("partial"),
      Type.Literal("failed"),
    ]),
    runId: Type.String({ minLength: 1 }),
    workflow: Type.String({ minLength: 1 }),
    attempt: Type.Integer({ minimum: 1 }),
    pointers: Type.Optional(Type.Array(Type.String())),
    blockers: Type.Optional(Type.Array(Type.String())),
  });
}

export function convergenceParameters(
  kind: SessionKind,
  opts?: { readonly autoWakeEnabled?: boolean },
) {
  const autoWakeEnabled = opts?.autoWakeEnabled !== false;
  return kind === "main" ? mainSchema(autoWakeEnabled) : sideSchema();
}

const DIGEST_MAX_CODE_POINTS = 120;

export function deriveDigest(assistant: AssistantMessage | null): string {
  if (assistant === null) return "（模型未提供摘要）";
  const parts: string[] = [];
  for (const block of assistant.content) {
    if (block.type === "text") parts.push(block.text);
  }
  const text = parts.join("\n").replace(/\s+/g, " ").trim();
  if (text === "") return "（模型未提供摘要）";
  const codePoints = Array.from(text);
  if (codePoints.length <= DIGEST_MAX_CODE_POINTS) return text;
  return `${codePoints.slice(0, DIGEST_MAX_CODE_POINTS).join("")}…`;
}

function lastAssistant(messages: ReadonlyArray<Message>): AssistantMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m !== undefined && m.role === "assistant") return m;
  }
  return null;
}

function reject(ctx: HookContext, reason: NudgeReason, detail: string): never {
  const prev = ctx.state.get(FAIL_SLOT) ?? [];
  ctx.state.set(FAIL_SLOT, [...prev, { turnIdx: ctx.turnIdx, reason, detail }]);
  throw new Error(`converge 拒收（${reason}）：${detail}`);
}

function wakeResultText(nextWakeAt: number | null | undefined): string {
  if (nextWakeAt === null) return "已清除下次自动唤醒。";
  if (nextWakeAt === undefined) return "";
  return `下次自动唤醒：${formatWakeAt(nextWakeAt)}（本地时间）。`;
}

function buildExecute(kind: SessionKind, opts: ConvergenceToolOptions) {
  return async (args: Record<string, unknown>, ctx: HookContext) => {
    const assistant = lastAssistant(ctx.messages);
    if (assistant === null) {
      throw new Error("converge: no assistant turn in context (internal misuse)");
    }

    const accepted = ctx.state.get(ACCEPTED_SLOT);
    const runGen = ctx.state.get(RUN_GEN_SLOT) ?? 0;
    if (
      accepted !== null &&
      accepted !== undefined &&
      accepted.runGen === runGen &&
      accepted.turnIdx === ctx.turnIdx
    ) {
      reject(ctx, "duplicate", "本轮已受理过一次收束，重复收束不计数、不生效。");
    }

    const parsed = parseReceiptArgs(kind, args, {
      derivedDigest: deriveDigest(assistant),
      now: (opts.now ?? Date.now)(),
      autoWakeEnabled: opts.autoWakeEnabled !== false,
    });
    if (!parsed.ok) {
      reject(ctx, "fields", `${parsed.missing.join("；")}。`);
    }

    const receipt = parsed.receipt;
    ctx.state.set(ACCEPTED_SLOT, { turnIdx: ctx.turnIdx, runGen, receipt });
    const text = `收束已受理，本轮到此结束。${wakeResultText(nextWakeAtOf(receipt))}`;
    return {
      content: [{ type: "text" as const, text }],
      details: {
        __convergence: {
          converged: true,
          receipt,
          outcome: { type: "converged" as const, status: receipt.status, receipt },
        },
      },
    };
  };
}

function mainDescription(autoWakeEnabled: boolean): string {
  const base =
    "结束会话的唯一合法通道。可以与其他工具在同一轮一起调用（同批全部照常执行）；" +
    "正文与 converge 调用必须出现在同一条回复（零额外往返）；只有必填字段缺失或同轮重复收束会被拒绝并催办，会话不会结束。" +
    "digest 由系统从本回合助手正文自动派生、无需提供，body 可省略。";
  if (!autoWakeEnabled) return base;
  return (
    base +
    "可选 wake（仅主会话支持）：" +
    WAKE_DESCRIPTION
  );
}

const SIDE_DESCRIPTION =
  "结束副会话的唯一合法通道。可以与其他工具在同一轮一起调用（同批全部照常执行）；" +
  "正文与 converge 调用必须出现在同一条回复（零额外往返）；只有必填字段缺失或同轮重复收束会被拒绝并催办，会话不会结束。" +
  "digest 由系统从本回合助手正文自动派生、无需提供。";

/**
 * 收束工具定义（工具 + schema 一体）：main/side 二选一构造。
 * 把返回的 HarnessTool 放进 AgentSession tools，再挂 ConvergenceGate.buildHooks()。
 */
export function ConvergenceTool(
  kind: SessionKind,
  opts: ConvergenceToolOptions = {},
): HarnessTool {
  const autoWakeEnabled = opts.autoWakeEnabled !== false;
  return {
    name: CONVERGE_TOOL_NAME,
    label: "收束",
    description: kind === "main" ? mainDescription(autoWakeEnabled) : SIDE_DESCRIPTION,
    parameters: convergenceParameters(kind, { autoWakeEnabled }),
    aliases: [...CONVERGE_ALIASES],
    isReadOnly: true,
    // 不变量：批内串行是重复收束查重的前提——并发的两个 converge 会同时读到未受理槽、
    // 双双通过查重，故此处必须 false（ToolExecutor 的 unsafe barrier 保证顺序执行）。
    isConcurrencySafe: () => false,
    execute: buildExecute(kind, opts),
  };
}
