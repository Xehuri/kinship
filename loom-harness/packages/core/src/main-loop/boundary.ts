/**
 * TurnBoundary（T10/D23）—— 主会话 turn 边界的两件事：deliver 收件箱消费 + T18 重装配。
 *
 * deliver 收件箱（D23 协作主干）：外部投递（副会话回执/死信等）经 `deliver()` 入队，
 * 只在 `onTurnStart`（turn 边界安全点）drain 注入——**绝不插进进行中的 turn**：kernel 在
 * 每个 turn 开始、下一次 LLM call 组 messages 之前 fire onTurnStart，进行中的 turn 的
 * context 已定型，边界后首个工作点恰好是下个 turn 的起点。drain 用同步 swap
 * （`drained = inbox; inbox = []`，读写之间无 await），边界期间新到的 deliver 落进新数组、
 * 下个边界再消费，不丢不重（对齐内核 steer inbox 的原子性论证）。
 *
 * 注入走 `ctx.appendMessage`（持久，进 session.messages、随 HWM 落盘、resume 可见）——
 * 回执是对话事实，不是 transient attachment。
 *
 * W12 提醒通道（`remind()`，与 deliver 同边界、不同纪律）：副会话 run 终态提醒等
 * "系统提醒"经此入队，turn 边界 drain 后经 hook 返回 `additionalContext` 注入——
 * 内核把 attachment 拼进**下一次 LLM call 的 messages view 尾部、不落 session.messages、
 * 不随 HWM 进转录**（session.ts `_pendingAttachments` 语义）。这正是"提醒不在历史中"的
 * 实现位：同文本喂进 T18 装配增量段（TurnInput.reminders → 段3，易变段天然不落转录），
 * 稳定前缀段[0..2]一字不动。多行按入队序全量注入并清空（滞留 = 内存队列，无 IO）。
 *
 * T18 重装配：每个 turn 边界跑一次纯函数 `assemble`（稳定前缀 + 增量尾，O(increment)），
 * 产物只记录给上层（T27/T37 消费）；装配读的是 L0 分片（reader 注入），与会话内存消息
 * 解耦——这正是 assembly/types.ts 声明的依赖方向（core 不 import adapters，reader 注入）。
 */

import { createUserMessage } from "../types.js";
import type { Hook, HookContext, HookResult } from "../hook.js";
import type { Message } from "@earendil-works/pi-ai"; // // 环纪律：深路径直引，不 import 自身 barrel（见 convergence/gate.ts 注释）
import {
  assemble,
  rebaseAssemblyPrefix,
  type Assembly,
  type AssemblyPlan,
  type AssemblyReader,
} from "../assembly/index.js";

export interface TurnBoundaryDeps {
  /** null = 未配置装配接线。 */
  readonly assembly: { readonly plan: AssemblyPlan; readonly reader: AssemblyReader | null } | null;
  onDelivered(turnIdx: number, count: number): void;
  onAssembly(turnIdx: number, assembly: Assembly): void;
  /** W12：提醒在本边界被注入（transient 通道消费通知面；未接 = 只注入不回报）。 */
  onRemindersDrained?(turnIdx: number, texts: readonly string[]): void;
}

export class TurnBoundary {
  private _inbox: Message[] = [];
  private _reminders: string[] = [];
  private _historyCursor = 0;
  private _pendingPrompt: string | null = null;
  /** 可变装配接线：plan 可被热重载，reader 构造期固定。null = 未配置装配。 */
  private _assembly: { readonly plan: AssemblyPlan; readonly reader: AssemblyReader | null } | null;
  /** plan 代号：每次 setAssemblyPlan 自增，用于判断缓存装配是否过期。 */
  private _planVersion = 0;
  private _lastAssembly: Assembly | null = null;
  private _lastAssemblyPlanVersion = -1;

  constructor(private readonly _deps: TurnBoundaryDeps) {
    this._assembly =
      _deps.assembly === null
        ? null
        : { plan: _deps.assembly.plan, reader: _deps.assembly.reader };
  }

  /** run 的初始 prompt（供首个 turn 边界的装配增量段消费；continue 无 prompt）。 */
  notePrompt(prompt: string): void {
    this._pendingPrompt = prompt;
  }

  get pendingCount(): number {
    return this._inbox.length;
  }

  /** W12 滞留可见性：待注入提醒深度（边界 drain 后归零；队列纯内存，无 IO）。 */
  get pendingReminders(): number {
    return this._reminders.length;
  }

  deliver(content: string | Message): void {
    const message = typeof content === "string" ? createUserMessage(content) : content;
    if (message.role !== "user") {
      throw new Error(
        `TurnBoundary.deliver: only user-role messages are deliverable, got "${message.role}" ` +
          "(assistant/toolResult would break conversation invariants)",
      );
    }
    this._inbox.push(message);
  }

  /** 提醒入队（W12）：非空白字符串；turn 边界全量 transient 注入后清空，绝不进转录。 */
  remind(text: string): void {
    if (typeof text !== "string" || text.trim() === "") {
      throw new Error("TurnBoundary.remind: reminder text must be a non-blank string");
    }
    this._reminders.push(text);
  }

  /** 热替换装配 plan（下个 turn 边界使用）；未配置装配时为 no-op。 */
  setAssemblyPlan(plan: AssemblyPlan): void {
    if (this._assembly === null) return;
    this._assembly = { plan, reader: this._assembly.reader };
    this._planVersion += 1;
  }

  /**
   * 当前 plan 对应的装配视图：尚未发生首次真实装配 → null（保持旧观测面）；
   * plan 未变 → 最近一次装配对象；plan 已变 → 重建稳定前缀并缓存（不读历史、不发事件）。
   */
  currentAssembly(): Assembly | null {
    if (this._assembly === null || this._lastAssembly === null) return null;
    if (this._lastAssemblyPlanVersion === this._planVersion) return this._lastAssembly;
    const rebased = rebaseAssemblyPrefix(this._lastAssembly, this._assembly.plan);
    this._lastAssembly = rebased;
    this._lastAssemblyPlanVersion = this._planVersion;
    return rebased;
  }

  buildHook(): Hook {
    const boundary = this;
    return {
      name: "main-loop.boundary",
      onTurnStart(input, ctx): HookResult | void {
        boundary._drainInbox(input.turnIdx, ctx);
        // W12：提醒 drain 走返回值（additionalContext = 内核 transient attachment，
        // 只进下一次 LLM call 的 messages view，不进 session.messages/转录）。
        const drained = boundary._drainReminders(input.turnIdx);
        boundary._reassemble(input.turnIdx, drained);
        if (drained.length === 0) return;
        return { additionalContext: drained.join("\n") };
      },
    };
  }

  private _drainInbox(turnIdx: number, ctx: HookContext): void {
    if (this._inbox.length === 0) return;
    const drained = this._inbox;
    this._inbox = [];
    for (const message of drained) {
      ctx.appendMessage(message);
    }
    this._deps.onDelivered(turnIdx, drained.length);
  }

  /** 同步 swap drain（同 _drainInbox 原子性论证：读写之间无 await，不丢不重）。 */
  private _drainReminders(turnIdx: number): string[] {
    if (this._reminders.length === 0) return [];
    const drained = this._reminders;
    this._reminders = [];
    this._deps.onRemindersDrained?.(turnIdx, drained);
    return drained;
  }

  private _reassemble(turnIdx: number, reminders: readonly string[] = []): void {
    const deps = this._assembly;
    if (deps === null) return;
    const currentMessage = this._pendingPrompt;
    this._pendingPrompt = null;
    const result = assemble(deps.plan, deps.reader, {
      historyCursor: this._historyCursor,
      ...(reminders.length > 0 ? { reminders } : {}),
      ...(currentMessage !== null ? { currentMessage } : {}),
    });
    this._historyCursor = deps.reader === null ? 0 : deps.reader.historyLength();
    this._lastAssembly = result;
    this._lastAssemblyPlanVersion = this._planVersion;
    this._deps.onAssembly(turnIdx, result);
  }
}
