/**
 * flow_list / flow_get（只读）—— 主会话读回心流台账的模型工具。
 *
 * 边界纪律：
 *   - 只读：不写 store、不碰 FLOW_COMMIT_SLOT、不改变任何主体的 version/state；
 *   - 会话隔离：list 只看 ctx.sessionId；get 的 id 路径查到后必须复核 session_id，
 *     跨会话一律按 not-found 处理，不泄漏对方主体名；
 *   - 时间：全部经 formatFlowTime 渲染成本地时区 + 显式偏移，绝不输出 UTC「Z」；
 *   - 信封：模型可见文本严格控制在 FLOW_LIMITS.maxEnvelopeBytes，超限丢行/丢笔记并标注截断。
 */

import { Type } from "@earendil-works/pi-ai";
// 环纪律：深路径直引真源，不 import 自身 barrel。
import type { HarnessTool, ToolExecResult } from "../types.js";
import { parseGetArgs, parseListArgs } from "./read-args.js";
import {
  compareSubjects,
  countStates,
  filterSubjects,
  listSubjectDetails,
  resolveSubject,
  selectNotes,
} from "./read-query.js";
import {
  collapseWhitespace,
  enforceEnvelope,
  fitListText,
  fitsEnvelope,
  latestNoteOf,
  listHeader,
  renderGetText,
  subjectLine,
} from "./read-render.js";
import {
  FlowNotFoundError,
  FlowValidationError,
  type FlowStore,
} from "./store.js";

export const FLOW_LIST_TOOL_NAME = "flow_list" as const;
export const FLOW_GET_TOOL_NAME = "flow_get" as const;

export interface FlowReadToolOptions {
  readonly store: FlowStore;
}

const LIST_DESCRIPTION =
  "只读列出当前会话的心流主体（默认不含 closed）。state/focus/kind 可过滤；" +
  "排序为 focus（foreground > background > parked）、next_decision_at 升序（空值最后）、" +
  "updated_at 降序。limit 缺省 20、最大 32；offset 缺省 0。" +
  "closed 需 include_closed=true 或 state 显式包含 closed 才可见。";

const GET_DESCRIPTION =
  "只读读取当前会话的一个心流主体（缺省 subject_name=主线）。subject_id 优先于 subject_name，" +
  "两者同时给出且名称不匹配会被拒绝；跨会话 id 一律视为不存在。" +
  "include_notes 缺省 true；notes 从最新往前取 notes_limit 条（缺省 5、最大 10），" +
  "按时间正序返回并带 1-based 绝对序号。";

export function flowListParameters() {
  return Type.Object({
    state: Type.Optional(
      Type.Array(
        Type.Union([
          Type.Literal("active"),
          Type.Literal("waiting_user"),
          Type.Literal("waiting_event"),
          Type.Literal("closed"),
        ]),
      ),
    ),
    focus: Type.Optional(
      Type.Array(
        Type.Union([
          Type.Literal("foreground"),
          Type.Literal("background"),
          Type.Literal("parked"),
        ]),
      ),
    ),
    kind: Type.Optional(
      Type.Union([Type.Literal("thread"), Type.Literal("task")]),
    ),
    include_closed: Type.Optional(Type.Boolean()),
    limit: Type.Optional(Type.Integer({ minimum: 1 })),
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
  });
}

export function flowGetParameters() {
  return Type.Object({
    subject_id: Type.Optional(Type.String()),
    subject_name: Type.Optional(Type.String()),
    include_notes: Type.Optional(Type.Boolean()),
    notes_limit: Type.Optional(Type.Integer({ minimum: 1 })),
    notes_offset: Type.Optional(Type.Integer({ minimum: 0 })),
  });
}

type FlowReadError = FlowValidationError | FlowNotFoundError;

function isFlowReadError(error: unknown): error is FlowReadError {
  return (
    error instanceof FlowValidationError || error instanceof FlowNotFoundError
  );
}

function errorResult(tool: string, error: FlowReadError): ToolExecResult {
  return {
    content: [
      { type: "text", text: enforceEnvelope(`${tool} 失败：${error.message}`) },
    ],
    isError: true,
    details: { __flow: { error: error.name } },
  };
}

/** 只读列表：当前会话 → 过滤 → 排序 → 分页 → 信封裁剪。 */
export function FlowListTool(opts: FlowReadToolOptions): HarnessTool {
  const store = opts.store;
  return {
    name: FLOW_LIST_TOOL_NAME,
    label: "心流列表",
    description: LIST_DESCRIPTION,
    parameters: flowListParameters(),
    isReadOnly: true,
    isConcurrencySafe: () => true,
    async execute(args, ctx) {
      try {
        const query = parseListArgs(args);
        const all = await store.list(ctx.sessionId);
        const filtered = filterSubjects(all, query);
        const sorted = [...filtered].sort(compareSubjects);
        const total = sorted.length;
        const page = sorted.slice(query.offset, query.offset + query.limit);
        const rows = page.map((subject) => ({
          subject,
          latestNote: latestNoteOf(subject),
        }));
        const counts = countStates(filtered);
        const fitted = fitListText(
          listHeader(total, counts.active, counts.waiting),
          rows.map((row) => subjectLine(row.subject, row.latestNote)),
          total,
          query.offset,
        );
        const shownRows = rows.slice(0, fitted.shown);
        const hasMore =
          query.offset + fitted.shown < total || fitted.truncated;
        return {
          content: [{ type: "text", text: fitted.text }],
          details: {
            __flow: {
              total,
              shown: fitted.shown,
              offset: query.offset,
              has_more: hasMore,
              subjects: shownRows.map((row) =>
                listSubjectDetails(row.subject, row.latestNote),
              ),
            },
          },
        };
      } catch (error) {
        if (!isFlowReadError(error)) throw error;
        return errorResult(FLOW_LIST_TOOL_NAME, error);
      }
    },
  };
}

/** 只读单主体：解析引用 → 会话校验 → 笔记切片 → 信封裁剪。 */
export function FlowGetTool(opts: FlowReadToolOptions): HarnessTool {
  const store = opts.store;
  return {
    name: FLOW_GET_TOOL_NAME,
    label: "心流详情",
    description: GET_DESCRIPTION,
    parameters: flowGetParameters(),
    isReadOnly: true,
    isConcurrencySafe: () => true,
    async execute(args, ctx) {
      try {
        const query = parseGetArgs(args);
        const subject = await resolveSubject(store, ctx.sessionId, query);
        const notesTotal = subject.notes.length;
        const selection = selectNotes(subject.notes, query);
        const kept = [...selection.notes];
        let notesTruncated = selection.truncated;
        while (kept.length > 0) {
          const text = renderGetText(
            subject,
            kept,
            notesTotal,
            query.includeNotes,
            notesTruncated,
          );
          if (fitsEnvelope(text)) break;
          kept.shift();
          notesTruncated = true;
        }
        const rawText = renderGetText(
          subject,
          kept,
          notesTotal,
          query.includeNotes,
          notesTruncated,
        );
        const text = enforceEnvelope(rawText);
        const shownNotes = kept.map((note) => collapseWhitespace(note.text));
        return {
          content: [{ type: "text", text }],
          details: {
            __flow: {
              subject: {
                ...subject,
                notes: shownNotes,
              },
              notes: shownNotes,
              notes_total: notesTotal,
              notes_offset: query.notesOffset,
              notes_truncated: notesTruncated,
            },
          },
        };
      } catch (error) {
        if (!isFlowReadError(error)) throw error;
        return errorResult(FLOW_GET_TOOL_NAME, error);
      }
    },
  };
}

/** 主循环挂载面：flow_commit 之后固定追加 [flow_list, flow_get]。 */
export function createFlowReadTools(opts: FlowReadToolOptions): HarnessTool[] {
  return [FlowListTool(opts), FlowGetTool(opts)];
}
