/**
 * T29 事件域 —— kernel 事件 → loom 帧草案的投影器（事件名映射表见 mapping.ts）。
 *
 * 关键不变量（前端硬契约，docs/02；每条都有对应测试断言）：
 *   1. 每条草案必带 `sessionID`（经 sanitizeId 归一，绝无连字符）；
 *   2. `message.part.delta` 必带 `field==='text'` + `partID`（前端二者缺一即丢）；
 *   3. `message.part.updated` / `message.updated` 的 `part.id` / `info.id` 必存在；
 *   4. `session.idle` 除 sessionID 外再镜像一份 `id`（UI 挂 120s 的历史坑）；
 *   5. `info.tokens.*` 六字段形状固定。
 *
 * 幂等与跨订阅者一致性：同一条 kernel 事件对象会被多个订阅者的独立 pump 各自投一次。
 * msg_/part_ 序号来自**会话级共享**的 ProjectionState，逐次重投会自增、导致两个
 * 订阅者拿到不同 id。故用 WeakMap 按事件对象**记忆化**一次投影：所有订阅者共享
 * 同一份草案、序号只推进一次。事件对象是内核每次新建的字面量，键的生命周期 =
 * 事件本身，无泄漏。live/recorded 两条轨在此统一为一个穷尽 switch（track 与
 * event 类型的对应由 pump 的构造保证，投影不依赖 track 字段）。
 */

import type {
  AssistantMessage,
  LiveEvent,
  SessionEvent,
  ToolExecResult,
} from "@axeuh/loom-core";
import type { TransportEnvelope } from "@axeuh/loom-adapters";
import { isConvergeCallName } from "@axeuh/loom-core";
import {
  REASONING_STREAM_EVENTS,
  childrenFromText,
  loomNameOf,
  readConvergence,
  readFlow,
  tokensFromUsage,
} from "./mapping.js";
import type { ConvergenceDraft, FlowDraft } from "./mapping.js";
import { sanitizeId } from "./types.js";
import type { LoomEventName } from "./types.js";

/** 一帧草案：投递前由 hub 补 seq 并包成 `{seq, payload:{type,properties}}`。 */
export interface FrameDraft {
  readonly type: string;
  readonly sessionID: string;
  readonly properties: Readonly<Record<string, unknown>>;
}

/** 会话级投影状态：消息/part 序号在此生成（跨订阅者共享 → 同一事件投出相同 id）。 */
export interface ProjectionState {
  /**
   * 会话级（hub 内存生命周期）**单调**消息序号：每个 assistant LLM call 的
   * live `message_start` 处 +1（内核一次 call 恰发一次 start）；该 call 的 delta、
   * tool part、终态快照共享同一序号。
   *
   * W32（生产事故修复）：不再对齐 run-local turnIdx——serve 路径根本不转发
   * turn-start（recorded 轨只镜像 llm-end/tool-end，见 registry #ensure 注释），
   * 且 turnIdx 每个受理回合从 0 重启；两种旧对齐都导致**跨回合 id 复用**。前端按
   * (messageID, part.id) 键控并原位替换，复用即"下一轮思考/正文覆盖上一轮气泡"。
   * opencode 每条 assistant 消息 id 唯一，loom 以单调计数对齐该身份纪律。
   *
   * 唯一性边界：计数随 hub 存亡；loom 重启后前端重连走历史 resync（分页回放，
   * 旧气泡整体重建），重启作用域内唯一即满足契约——此为有意取舍，勿再加持久计数。
   */
  messageSeq: number;
  /** 当前回合已受理的收束回执（随 session.idle 带出三态字段）。 */
  convergence: ConvergenceDraft | null;
  /** 当前回合最近一次已受理 flow_commit（随 session.idle 带出 flow 字段）。 */
  flow: FlowDraft | null;
  /**
   * W13 reasoning 流：已发过注册帧（part.updated 定型 type='reasoning'）的 part id 集。
   * 一块只注册一次；llm-end 快照投影后清空——W32 后该清空只是内存卫生（part id 含
   * 单调 msg_ 序号，跨消息天然无碰撞），旧时代"serve messageSeq 恒 0、下回合首块
   * 靠清空重注册"的复用 workaround 已退役。
   * 不变量恒定：**每个新 reasoning part 的增量帧之前必先到注册帧**（前端丢弃
   * 未知 part 的增量），由"新消息必是新 part id"自动成立，测试逐消息钉死。
   */
  readonly reasoningParts: Set<string>;
  /** 事件对象 → 草案（记忆化：多订阅者同 id、序号只推进一次）。 */
  readonly memo: WeakMap<object, readonly FrameDraft[]>;
}

export function newProjectionState(): ProjectionState {
  return {
    // 缺省 0 = "尚未见任何 message_start"；首个被投影的 start 即推进到 1（恒正、
    // 永不与推进后的序号回绕复用，无连字符——满足 LOOM_ID_RE）。
    messageSeq: 0,
    convergence: null,
    flow: null,
    reasoningParts: new Set<string>(),
    memo: new WeakMap<object, readonly FrameDraft[]>(),
  };
}

/**
 * pump 信封 → 草案（生产投影入口）。**WeakMap 记忆化**（键 = kernel 事件对象）：同一
 * 事件被 N 个订阅者的 pump 各投一次时只计算一次，所有订阅者拿到同一份草案（id 一致、
 * messageSeq 只推进一次）。直接调 projectEvent（如测试）不记忆化。
 *
 * 单帧映射投影（projectEvent，一事件一名）之外，本层再展开**多帧通道**：
 *   - reasoning 流（thinking_delta）：首块注册帧（part.updated 定型 type='reasoning'）
 *     + 逐增量帧（part.delta field='text'）。带会话级注册状态（reasoningParts）且一事件
 *     多帧，与单表语义不同，故不入 VENDOR_TO_LOOM_EVENT（先例：tool 的 pending/running
 *     帧走 hub.publishToolPart 域通道，同样不占投影单表）。
 */
export function projectEnvelope(state: ProjectionState, env: TransportEnvelope): readonly FrameDraft[] {
  const event = env.event as object;
  const cached = state.memo.get(event);
  if (cached !== undefined) return cached;
  const drafts = [
    ...projectEvent(state, env.sessionId, env.event),
    ...projectReasoningStream(state, env.sessionId, env.event),
  ];
  state.memo.set(event, drafts);
  return drafts;
}

/**
 * 一条 kernel 事件 → 草案序列（live/recorded 统一穷尽判别）。
 * `default` 分支 = unknown-event tolerance：内核新增事件 arm 而未接投影时静默不发，
 * 绝不拖垮扇出（与前端"只读它认识的"对称）。
 */
export function projectEvent(
  state: ProjectionState,
  sessionId: string,
  event: LiveEvent | SessionEvent,
): FrameDraft[] {
  const sessionID = sanitizeId(sessionId);
  switch (event.type) {
    case "text_delta": {
      const messageID = `msg_${state.messageSeq}`;
      return [
        {
          type: needsName("text_delta", "message.part.delta"),
          sessionID,
          properties: {
            sessionID,
            messageID,
            partID: `part_${state.messageSeq}_${event.contentIndex}`,
            field: "text", // 前端硬约束：field 不恰为 'text' 就整条丢弃
            delta: event.delta,
          },
        },
      ];
    }
    case "session-start":
      state.flow = null;
      return [
        {
          type: needsName("session-start", "session.status"),
          sessionID,
          properties: { sessionID, status: { type: "busy" } },
        },
      ];
    case "turn-start":
      // W32：此处**不再**对齐 messageSeq（旧方案取 run-local turnIdx：serve 路径
      // 不转发本事件、且 turnIdx 每受理回合归零 ⇒ 跨回合 id 复用 = 前端覆盖事故）。
      // 身份推进改由 live `message_start` 单调 tick；本事件只保留 busy 状态帧（形状不变）。
      return [
        {
          type: needsName("turn-start", "session.status"),
          sessionID,
          properties: { sessionID, status: { type: "busy" } },
        },
      ];
    case "llm-end": {
      const drafts = projectAssistantSnapshot(state.messageSeq, sessionID, event.msg);
      // W13：回合快照落地即清空 reasoning 注册表（内存卫生——W32 后 part id 含
      // 单调 msg_ 序号，跨消息天然无碰撞，重注册由新序号自动成立）。
      state.reasoningParts.clear();
      return drafts;
    }
    case "tool-end":
      return projectToolEnd(
        state,
        sessionID,
        event.call.name,
        event.call.id,
        event.call.arguments,
        event.result,
      );
    case "session-end": {
      const conv = state.convergence;
      return [
        {
          type: needsName("session-end", "session.idle"),
          sessionID,
          properties: {
            sessionID,
            // 「idle 必须带 id」：sessionID 之外再镜像一份 id，前端任取其一都不会挂 120s。
            id: sessionID,
            status: { type: "idle" },
            ...(conv !== null ? { convergence: { status: conv.status, converged: conv.converged } } : {}),
            ...(state.flow !== null ? { flow: state.flow } : {}),
          },
        },
      ];
    }
    case "error":
      return [
        {
          type: needsName("error", "session.error"),
          sessionID,
          properties: { sessionID, error: { message: event.message } },
        },
      ];
    case "message_start":
      // W32 身份 tick：内核每个 assistant LLM call 恰发一次 live message_start
      //（session.ts LLM 相 stream() 之前 _emitLive；runStreaming 与 serve 的 loop
      // 驱动共用该相）。会话级 messageSeq 单调 +1 → 该 call 的 delta/tool/快照
      // 全部落新 id，跨 call/跨受理回合永不复用。本事件自身仍不发帧（映射表 null）；
      // WeakMap 记忆化保证多订阅者只推进一次。
      state.messageSeq += 1;
      return [];
    case "thinking_delta": // W13 reasoning 流双帧通道在 projectEnvelope 层展开，单表不发（mapping 保持 null）
    case "toolcall_delta":
    case "message_update":
    case "message_end":
    case "turn-end":
    case "continuation-check":
      return []; // 本版有意不发：见 mapping.VENDOR_TO_LOOM_EVENT 的 TODO(T38) 缺口清单
    default:
      return []; // 未知事件类型：容忍丢弃
  }
}

/**
 * W13 reasoning 流展开（projectEnvelope 层调用）：thinking_delta → 双帧序列。
 *   1. 首见该 part id：注册帧 part.updated `{part:{id, sessionID, messageID, type:"reasoning"}}`
 *      （形状逐字对齐 EVENT_API_DOC §3 reasoning 样例：无 text）；
 *   2. 每增量一条：part.delta `{messageID, partID, field:"text", delta}`（文档
 *      "Streaming text content (reasoning or output)"）。
 * part id = `part_${messageSeq}_reasoning_${contentIndex}`（与 text/tool part 同坐标系；
 * 终态快照在 projectAssistantSnapshot 用块下标生成同 id，前端原位替换不重影）。
 */
export function projectReasoningStream(
  state: ProjectionState,
  sessionId: string,
  event: LiveEvent | SessionEvent,
): FrameDraft[] {
  if (event.type !== "thinking_delta") return [];
  const sessionID = sanitizeId(sessionId);
  const messageID = `msg_${state.messageSeq}`;
  const partID = `part_${state.messageSeq}_reasoning_${event.contentIndex}`;
  const drafts: FrameDraft[] = [];
  if (!state.reasoningParts.has(partID)) {
    state.reasoningParts.add(partID);
    drafts.push({
      type: REASONING_STREAM_EVENTS.register,
      sessionID,
      properties: {
        sessionID,
        messageID,
        part: { id: partID, sessionID, messageID, type: "reasoning" },
      },
    });
  }
  drafts.push({
    type: REASONING_STREAM_EVENTS.delta,
    sessionID,
    properties: { sessionID, messageID, partID, field: "text", delta: event.delta },
  });
  return drafts;
}

// ───────────────────────── 内部投影细节 ─────────────────────────

/** 工具结束 → part.updated（收束调用本身不发 part）+ 含 task_metadata 时补 children 帧。 */
function projectToolEnd(
  state: ProjectionState,
  sessionID: string,
  toolName: string,
  callId: string,
  args: Record<string, unknown>,
  result: ToolExecResult,
): FrameDraft[] {
  const convergence = readConvergence(result.details);
  if (convergence !== null) state.convergence = convergence;
  const flow = readFlow(result.details);
  if (flow !== null) state.flow = flow;

  const output = textOf(result);
  const children = childrenFromText(output);
  const drafts: FrameDraft[] = [];
  if (!isConvergeCallName(toolName)) {
    const messageID = `msg_${state.messageSeq}`;
    drafts.push({
      type: needsName("tool-end", "message.part.updated"),
      sessionID,
      properties: {
        sessionID,
        messageID,
        part: {
          id: `part_${state.messageSeq}_tool_${sanitizeId(callId)}`,
          type: "tool",
          tool: toolName,
          messageID,
          state: { status: result.isError === true ? "error" : "completed", input: args, output },
        },
      },
    });
  }
  if (children !== null) {
    // 子智能体面板契约：工具结果含 <task_metadata> → 额外发一条 children[].id 帧。
    // 事件名枢纽自定（非 kernel 源事件，不查映射表；定名与保留与否 TODO(T38)）。
    drafts.push({
      type: "session.children",
      sessionID,
      properties: { sessionID, children },
    });
  }
  return drafts;
}

/**
 * 助手消息终态 → 一条 message.updated（token 面）+ 每个可渲染块一条 message.part.updated。
 * part id 用块在 content 里的**实际下标**（与 live text_delta 的 contentIndex 同一坐标系，
 * 于是流式期 delta 落的占位 part 与终态快照 part id 一致，前端 splice 原位替换不重影）。
 */
function projectAssistantSnapshot(
  seq: number,
  sessionID: string,
  message: AssistantMessage,
): FrameDraft[] {
  const messageID = `msg_${seq}`;
  const drafts: FrameDraft[] = [
    {
      type: needsName("llm-end", "message.updated"),
      sessionID,
      properties: {
        sessionID,
        messageID,
        info: {
          id: messageID,
          role: "assistant",
          model: message.model,
          provider: message.provider,
          stopReason: message.stopReason,
          tokens: tokensFromUsage(message.usage),
        },
      },
    },
  ];
  for (let blockIdx = 0; blockIdx < message.content.length; blockIdx++) {
    const block = message.content[blockIdx]!;
    if (block.type === "text") {
      drafts.push(partFrame(sessionID, `part_${seq}_${blockIdx}`, "text", messageID, { text: block.text }));
    } else if (block.type === "toolCall") {
      if (isConvergeCallName(block.name)) continue; // 收束调用不是 UI part
      drafts.push(
        partFrame(sessionID, `part_${seq}_tool_${sanitizeId(block.id)}`, "tool", messageID, {
          tool: block.name,
          state: { status: "running", input: block.arguments, output: "" },
        }),
      );
    } else if (block.type === "thinking") {
      // W13 终态快照：全量思考文本（含增量通道关闭后的回看兜底）；id 与 delta 注册同坐标系
      //（contentIndex=块下标），前端按 part id 原位合并。
      drafts.push(
        partFrame(sessionID, `part_${seq}_reasoning_${blockIdx}`, "reasoning", messageID, {
          text: block.thinking,
        }),
      );
    }
  }
  return drafts;
}

function partFrame(
  sessionID: string,
  partId: string,
  partType: string,
  messageID: string,
  extra: Readonly<Record<string, unknown>>,
): FrameDraft {
  return {
    type: needsName("message_end", "message.part.updated"),
    sessionID,
    properties: { sessionID, messageID, part: { id: partId, type: partType, messageID, ...extra } },
  };
}

function textOf(result: ToolExecResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

/**
 * 映射表取名；取到 null = 映射表与投影分支漂移（本版该事件不发，投影却发了），
 * 开发期即抛、不留哑帧。expect 参数只出现在漂移错误信息里（不参与取名）。
 */
function needsName(kernelName: string, expect: LoomEventName): string {
  const name = loomNameOf(kernelName);
  if (name === null) {
    throw new Error(`mapping/projection drift: ${kernelName} -> ${expect} but mapping says null`);
  }
  return name;
}
