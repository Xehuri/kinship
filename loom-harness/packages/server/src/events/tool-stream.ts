/**
 * W11a —— 工具执行期事件流（P0 输出实时流 + P1 状态跃迁 + P2 file.edited）。
 *
 * 帧形真源 = mybot-web/docs/EVENT_API_DOC.md（§Tool Event Examples / §Event Flow L412-414）：
 *   pending → running(time.start) → running(+state.output 增量, coalesce) → completed(既有 tool-end)。
 * part id / messageID 走 EventHub.publishToolPart（与投影层同一 messageSeq 坐标系），
 * 与终态帧同 id——前端按 part id splice，running 卡原位升级为 completed 卡。
 *
 * 归属链（不改内核主循环语义，全部用现成 hook 面）：
 *   registry 注入本模块 hook：onPreToolUse 发 pending、wrapToolExec 设 AsyncLocalStorage
 *   站点并开 slot 发 running；bash 工具咽喉 = tool-wiring 处 teeBashOperations 包过的
 *   BashOperations——exec 入口**同步**读 ALS 站点（ onData 回调是 child_process 事件，
 *   届时 ALS 上下文不可靠，故在此一次性捕获后闭包传递），chunk 增量喂 coalescer。
 *   子/副会话未装本 hook → 无站点 → tee 原样透传，零帧副作用。
 *
 * 节流决策：150ms coalesce（帧爆防线——逐 chunk 发帧时 50KB 输出可瞬出千帧）；
 * 面板 output 只带 tail（缺省 16KB 截尾），终态 completed 帧仍是全量口径不动。
 */

import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";

import type { Hook, ToolExecResult } from "@axeuh/loom-core";
import { isConvergeCallName } from "@axeuh/loom-core";
import type { BashOperations } from "@axeuh/loom-tools";

import type { EventHub } from "./hub.js";

/** 一次工具执行的现场（wrapToolExec 写入，tee/coalescer 消费）。 */
export interface ToolExecSite {
  readonly sessionId: string;
  readonly callID: string;
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly start: number;
}

/** 站点 store：wrapToolExec → tool.execute → ops.exec 同一 async 链。 */
const siteStore = new AsyncLocalStorage<ToolExecSite>();

/** 诊断/测试用：当前工具执行站点（不在 wrapToolExec 内 = undefined）。 */
export function currentToolExecSite(): ToolExecSite | undefined {
  return siteStore.getStore();
}

/** bash 输出 chunk 的上抛签名（tee → ToolOutputStream.onOutput）。 */
export type ToolOutputSink = (site: ToolExecSite, chunk: Buffer) => void;

/**
 * 包一层 BashOperations：onData 原样透传给 vendor 滚动缓冲，另 fork 一份给 sink。
 * sink 抛错一律吞（观测面绝不反噬执行路径）；无站点（子/副会话）不转发。
 */
export function teeBashOperations(ops: BashOperations, sink: ToolOutputSink): BashOperations {
  return {
    exec(command, cwd, options) {
      const site = siteStore.getStore(); // exec 入口同步捕获（事件回调里 ALS 不再可靠）
      const forward = site !== undefined && site.tool === "bash" ? sink : undefined;
      return ops.exec(command, cwd, {
        ...options,
        onData: (data: Buffer): void => {
          options.onData(data);
          if (forward !== undefined) {
            try {
              forward(site!, data);
            } catch {
              /* fail-soft：流面板坏了不能拖垮 bash 执行 */
            }
          }
        },
      });
    },
  };
}

/** file.edited 仅 write/edit 两工具（文档 §File Events；todo/其余工具不发）。 */
const FILE_EDIT_TOOLS = new Set(["write", "edit"]);

/** coalesce 缺省周期（任务冻结 ~150ms）。 */
export const TOOL_OUTPUT_THROTTLE_MS = 150;

/** running 帧 state.output 的截尾上限（字符；防长跑脚本把帧撑成巨型行）。 */
export const TOOL_OUTPUT_TAIL_CHARS = 16_384;

/** 活跃 slot 上限（防御性有界：onOutput 迟到而无执行体收尾时逐出最旧）。 */
const MAX_STREAM_SLOTS = 64;

export interface ToolOutputStreamOptions {
  /** sessionId → hub（非主会话/未知会话 = undefined → 静默不发帧）。 */
  readonly resolveHub: (sessionId: string) => EventHub | undefined;
  /** file.edited 的相对路径基准（= 工具面 workspace realpath；缺省 = 不补全）。 */
  readonly workspaceRoot?: string;
  readonly throttleMs?: number;
  readonly tailChars?: number;
  readonly now?: () => number;
  /** 尾帧定时器注入（测试用假调度器验节流语义）。返回取消函数。 */
  readonly schedule?: (fn: () => void, ms: number) => () => void;
}

export interface ToolOutputStream {
  /** 进 SessionRegistry.extraHooks（主会话专用；子/副会话**不得**挂此 hook）。 */
  readonly hook: Hook;
  /** tee 入口：bash 输出 chunk（tool-wiring onToolOutput 接线）。 */
  onOutput(site: ToolExecSite, chunk: Buffer): void;
  /** 活跃 slot 数（泄漏验收：run 收尾必须回落 0）。 */
  activeSlots(): number;
}

interface StreamSlot {
  readonly site: ToolExecSite;
  readonly decoder: InstanceType<typeof TextDecoder>;
  text: string;
  dirty: boolean;
  lastEmit: number;
  cancel: (() => void) | null;
}

const defaultSchedule = (fn: () => void, ms: number): (() => void) => {
  const t = setTimeout(fn, ms);
  // 尾帧定时器不吊住进程（slot 有界 + 执行收尾必清，双保险）。
  t.unref?.();
  return () => clearTimeout(t);
};

/** filePath → 绝对路径（vendor 工具面键名=path，兼容 opencode 形 filePath；缺 = null 不发帧）。 */
function editedFileOf(
  input: Readonly<Record<string, unknown>>,
  workspaceRoot: string | undefined,
): string | null {
  const fp = input["path"] ?? input["filePath"];
  if (typeof fp !== "string" || fp.length === 0) return null;
  return workspaceRoot !== undefined ? path.resolve(workspaceRoot, fp) : fp;
}

/**
 * 会话无关的共享实例：站点归属全在 ALS/入参里，一个实例服务全部主会话。
 */
export function createToolOutputStream(opts: ToolOutputStreamOptions): ToolOutputStream {
  const now = opts.now ?? Date.now;
  const throttleMs = opts.throttleMs ?? TOOL_OUTPUT_THROTTLE_MS;
  const tailChars = opts.tailChars ?? TOOL_OUTPUT_TAIL_CHARS;
  const schedule = opts.schedule ?? defaultSchedule;
  const slots = new Map<string, StreamSlot>();

  const slotKey = (site: ToolExecSite): string => `${site.sessionId}:${site.callID}`;

  function openSlot(site: ToolExecSite): void {
    if (slots.size >= MAX_STREAM_SLOTS) {
      const oldest = slots.keys().next();
      if (!oldest.done) slots.delete(oldest.value);
    }
    slots.set(slotKey(site), {
      site,
      decoder: new TextDecoder("utf-8"),
      text: "",
      dirty: false,
      lastEmit: site.start,
      cancel: null,
    });
  }

  function flush(slot: StreamSlot, at: number): void {
    slot.dirty = false;
    slot.lastEmit = at;
    const hub = opts.resolveHub(slot.site.sessionId);
    if (hub === undefined) return;
    hub.publishToolPart(slot.site.callID, slot.site.tool, {
      status: "running",
      input: slot.site.input,
      time: { start: slot.site.start },
      output: slot.text,
    });
  }

  function closeSlot(site: ToolExecSite): void {
    const key = slotKey(site);
    const slot = slots.get(key);
    if (slot === undefined) return;
    if (slot.cancel !== null) slot.cancel();
    slot.cancel = null;
    // 尾帧补齐：最后一批 chunk 常落在节流窗内，收尾不补则面板少一截（终态 completed
    // 虽全量，但「1s 一行」式脚本的收尾行要等 tool-end——补发让 running 序列自足）。
    if (slot.dirty) flush(slot, now());
    slots.delete(key);
  }

  function onOutput(site: ToolExecSite, chunk: Buffer): void {
    let slot = slots.get(slotKey(site));
    if (slot === undefined) {
      openSlot(site);
      slot = slots.get(slotKey(site))!;
    }
    const piece = slot.decoder.decode(chunk, { stream: true });
    if (piece.length === 0) return;
    slot.text += piece;
    if (slot.text.length > tailChars) slot.text = slot.text.slice(-tailChars);
    slot.dirty = true;
    const at = now();
    const elapsed = at - slot.lastEmit;
    if (elapsed >= throttleMs) {
      if (slot.cancel !== null) {
        slot.cancel();
        slot.cancel = null;
      }
      flush(slot, at);
      return;
    }
    if (slot.cancel === null) {
      const target = slot;
      slot.cancel = schedule(() => {
        target.cancel = null;
        if (target.dirty) flush(target, now());
      }, throttleMs - elapsed);
    }
  }

  const hook: Hook = {
    name: "loom-w11.tool-stream",
    onPreToolUse(input, ctx): void {
      if (isConvergeCallName(input.call.name)) return;
      const hub = opts.resolveHub(ctx.sessionId);
      if (hub === undefined) return;
      hub.publishToolPart(input.call.id, input.call.name, {
        status: "pending",
        input: input.call.arguments,
      });
    },
    async wrapToolExec(call, ctx, next): Promise<ToolExecResult> {
      if (isConvergeCallName(call.name)) return next();
      const hub = opts.resolveHub(ctx.sessionId);
      const start = now();
      const site: ToolExecSite = {
        sessionId: ctx.sessionId,
        callID: call.id,
        tool: call.name,
        input: call.arguments,
        start,
      };
      openSlot(site);
      if (hub !== undefined) {
        hub.publishToolPart(call.id, call.name, {
          status: "running",
          input: call.arguments,
          time: { start },
        });
      }
      try {
        const result = await siteStore.run(site, next);
        if (hub !== undefined && result.isError !== true && FILE_EDIT_TOOLS.has(call.name)) {
          const file = editedFileOf(call.arguments, opts.workspaceRoot);
          if (file !== null) hub.publish("file.edited", ctx.sessionId, { file });
        }
        return result;
      } finally {
        closeSlot(site);
      }
    },
  };

  return { hook, onOutput, activeSlots: () => slots.size };
}
