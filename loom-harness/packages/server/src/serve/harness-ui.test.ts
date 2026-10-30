/**
 * 门面页路由端到端（T39+）：起真树走 HTTP，锁死两条硬边界——
 *   1) GET / 与 GET /ui 免 token 可达：200 + text/html + 单文件内嵌（无外部资源引用）；
 *   2) 鉴权边界不因静态面放宽：API 与未注册路径无 token 仍 401（Router 口径不动）。
 *
 * W11a2 追加：页面渲染逻辑的 DOM-less 单测（HARNESS_UI_LOGIC_JS 用 new Function
 * 加载后直接调）——事件分派表全事件名覆盖、工具卡 running 输出增量合并、task 输出
 * 反解子会话、子面板 history 轮询差分；以及页面契约/纪律字符串断言（轮询模式、
 * 2s 周期、innerHTML 单一入口、无 emoji、token 只进 sessionStorage）。
 *
 * W16-C 追加（五视图重构）：markdown 块/行内解析 + 假 DOM 构造（XSS 探针必须成
 * 惰性文本节点）、/context/full 字节布局（offset 累计 + 总量）、任务列表差分、
 * 事件摘要；契约断言更新到新标签 DOM id（tabChat/viewContext/ctxRaw/taskList/
 * eventList 等，原 W13 的 contextPanel/ctxTree/ctxRefresh 保留在上下文视图内，
 * 不是删除而是迁移——故旧断言不动、新断言补齐）。
 *
 * W17-F 追加：context.notice 事件名入两张覆盖表（编译期穷尽锁）；增量时间线纯函数
 * （loomNoticeTimelinePush 环形 ≤100 新在前 + loomNoticeActionMeta 中文词表）；
 * 自动刷新触发面扩至 idle/notice/run 终态（switch 分支串取证）；manifest kind
 * 主/子徽章（loomManifestGroup badge 位）；②b wire/清单每次刷新整面重绘钉。
 *
 * W18 重排（用户判词：上下文 tab 显示乱排版乱——树/徽章/抽屉过度渲染不如读文本；
 * 发线消息看不全思考/正文/工具结果；复制路径按钮全下线）：上下文 tab = 单一
 * 「完整上下文（按发送顺序）」纯文本板块（loomContextPlainView：系统提示词全文 →
 * 工具定义 → 逐条消息含【思考】/【正文】/【调用】/【结果】，解析失败逐字回退原文）
 * + 模块纯文本折叠块（loomCtxMemoryPlain 记忆逐文件 / loomCtxManifestPlain 清单行 /
 * loomCtxParamsPlain 参数 / provider 载荷惰性抽屉保留）。本文件中 W17-C/W17-F 的
 * 徽章·树·路径复制钉已按判词逐一更新（每处注明理由），纪律锁（innerHTML 恰 1、
 * 无 CDN、无 emoji、惰性抽屉）原样保留。
 *
 * W24 追加（面板批次：只消费 W23-B/W23-A/W23-C 已接线端点，零服务端改动）：
 * 会话列表三件套消费面（loomSessionRowView/loomVisibleSessions/请求规格三函数——
 * 页面与测试同源直发）、/tasks 历史合流消费面（loomTaskSourceBadge 内存/账本标 +
 * loomTasksNewestFirst 倒序 + loomTaskTranscriptPath 转录入口）、live/cache 真相芯片
 * （loomContextTruthBits 三态语义 + loomContextPlainView 缓存口径 note）。真树 e2e
 * 用面板同一批请求规格直打已接线端点（title/archive/unarchive/?archived=1/
 * context/full wire:null），把「面板假设」钉成「服务端实测」。既有纪律锁全部原样保留。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseLoomConfig, type LoomConfig } from "../config/loom-config.js";
import type { LoomEventName } from "../events/types.js";
import { HotConfigStore, createFileAuditSink } from "../hotreload/index.js";
import type { LoomApp } from "./boot.js";
import { HARNESS_UI_HANDLED_EVENTS, HARNESS_UI_HTML, HARNESS_UI_LOGIC_JS } from "./harness-ui.js";

// 加载纪律（同 boot-assembly/boot-tools）：boot 图必须动态 import，
// 避免 core 桶经 server 环先实例化（ConvergenceGate "is not a constructor"）。
type CreateLoomApp = typeof import("./boot.js").createLoomApp;
let createLoomApp!: CreateLoomApp;

let work = "";
let app: LoomApp;
let baseUrl = "";

const TOKEN = "tok-ui-test";
const FAKE_YAML = [
  "server:",
  "  port: 5101",
  "  hostname: 127.0.0.1",
  "  sessionList: true",
  "workspace: WS_ROOT",
  "models:",
  "  - id: fake-ui",
  "    provider: fake",
  "    contextWindow: 200000",
  "    maxOutput: 4096",
  "    timeout: 60000",
  "pricing:",
  "  fake:",
  "    input: 0",
  "    output: 0",
].join("\n");

beforeAll(async () => {
  createLoomApp = (await import("./boot.js")).createLoomApp;
  work = mkdtempSync(join(tmpdir(), "loom-ui-"));
  const ws = join(work, "ws");
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, "AGENTS.md"), "# UI 测试工作区\n");
  const stateRoot = join(work, "state");

  const store = new HotConfigStore({ sink: createFileAuditSink(join(stateRoot, "config")), env: {} });
  const text = FAKE_YAML.replace("WS_ROOT", ws);
  const applied = store.apply(text, "<test>");
  if (!applied.ok) throw new Error(`配置 apply 失败：${applied.errors.join(";")}`);
  const config: LoomConfig = parseLoomConfig(text, "<test>", { env: {} });
  app = await createLoomApp({
    config,
    store,
    stateRoot,
    tokens: [TOKEN],
    version: "test",
    env: { LOOM_FAKE_MODEL: "1" },
  });
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const addr = app.server.address();
  if (addr === null || typeof addr === "string") throw new Error("监听地址不可读");
  baseUrl = `http://127.0.0.1:${String(addr.port)}`;
});

afterAll(async () => {
  await app?.closeExtras();
  await new Promise<void>((resolve) => {
    app?.server.closeAllConnections();
    app?.server.close(() => resolve());
  });
  app?.model.teardown();
  rmSync(work, { recursive: true, force: true });
});

describe("门面页：静态面免 token，API 面照旧鉴权", () => {
  for (const path of ["/", "/ui"]) {
    it(`GET ${path} 无 token → 200 text/html 单文件页`, async () => {
      const res = await fetch(`${baseUrl}${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      const html = await res.text();
      expect(html.startsWith("<!doctype html>")).toBe(true);
      expect(html.trimEnd().endsWith("</html>")).toBe(true);
      // 离线闭环：无外部脚本/样式引用（内嵌 CSS/JS）
      expect(/(src|href)="https?:/.test(html)).toBe(false);
      expect(html).toContain("<style>");
      expect(html).toContain("<script>");
      // 页面按 API 契约消费：鉴权头、token 只进 sessionStorage、SSE 走 fetch-stream
      expect(html).toContain("X-Loom-Token");
      expect(html).toContain("sessionStorage");
      expect(html).toContain("/events/stream?sessionId=");
      expect(html).toContain("/sessions/");
    });
  }

  it("GET /ui/ （trailing slash）同样命中", async () => {
    const res = await fetch(`${baseUrl}/ui/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  it("鉴权不被放宽：POST /、GET /health、GET /sessions、未注册路径无 token 一律 401", async () => {
    const post = await fetch(`${baseUrl}/`, { method: "POST" });
    expect(post.status).toBe(401);
    for (const path of ["/health", "/sessions", "/no-such-route", "/ui2"]) {
      const res = await fetch(`${baseUrl}${path}`);
      expect(res.status, `无 token 访问 ${path} 必须 401`).toBe(401);
    }
  });

  it("带 token 的 API 面照常工作（health 200）", async () => {
    const res = await fetch(`${baseUrl}/health`, { headers: { "X-Loom-Token": TOKEN } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status?: string };
    expect(body.status).toBe("ok");
  });
});

// ───────────────────── W11a2：页面渲染逻辑（DOM-less 纯函数段） ─────────────────────

/**
 * 测试侧事件名覆盖表：Record<LoomEventName, true> 编译期强制穷尽——后端
 * events/types.ts 新增事件名时本测试编译失败（与 harness-ui.ts 的覆盖表双重锁）。
 */
const TEST_EVENT_COVERAGE: Readonly<Record<LoomEventName, true>> = {
  "message.part.delta": true,
  "message.part.updated": true,
  "message.updated": true,
  "session.idle": true,
  "session.status": true,
  "session.error": true,
  "session.children": true,
  "session.created": true,
  "session.compacted": true,
  "session.compaction.started": true,
  "session.compaction.chunk": true,
  "session.compaction.retry": true,
  "session.compaction.aborted": true,
  "session.compaction_failed": true,
  "file.edited": true,
  "server.connected": true,
  "server.heartbeat": true,
  "run.status": true,
  "delivery.notify": true,
  "watchdog.alarm": true,
  "todo.updated": true,
  "context.notice": true,
  "session.queue": true,
};

const EXPECTED_EVENTS: readonly string[] = Object.keys(TEST_EVENT_COVERAGE);

interface HarnessLogic {
  loomEventDispatchTable(): string[];
  loomToolStatusMeta(status: string): { label: string; tone: string };
  loomMergeToolOutput(prev: string, next: string): { text: string; mode: string; appended: number };
  loomExtractTaskSessions(text: string): Array<{
    sessionID: string;
    agentType: string;
    reason: string;
    turns: number;
    depth: number;
  }>;
  loomMessageFingerprint(message: unknown): string;
  loomHistoryDelta(
    prev: { count: number; last: string },
    messages: unknown[],
  ): { reset: boolean; appendFrom: number; replaceFrom: number; idle: boolean };
  loomFormatDuration(ms: number): string;
  loomNormalizeTodos(raw: unknown): Array<{ content: string; status: string; priority: string }>;
  loomTodoCounts(todos: unknown): { done: number; active: number; total: number };
  loomApplyReasoningDelta(prev: unknown, incoming: unknown, final: unknown): { text: string; mode: string };
  loomReasoningState(
    streaming: unknown,
    text: unknown,
  ): { label: string; hint: string; cursor: boolean; streaming: boolean; tone: string };
  loomFormatCount(n: unknown): string;
  loomContextTree(view: unknown): {
    ok: boolean;
    badge: string;
    basis: string;
    meta: string;
    note: string;
    pct: number | null;
    groups: Array<{ segment: string; label: string; rows: Array<Record<string, unknown>> }>;
    total: { bytes: number | null; lines: number | null; tokens: number | null };
  };
  loomSafeHref(raw: unknown): string | null;
  loomMarkdownBlocks(src: unknown): Array<Record<string, unknown>>;
  loomMarkdownInline(text: unknown, depth?: unknown): Array<Record<string, unknown>>;
  loomMarkdownRender(doc: unknown, src: unknown): any;
  loomContextFullView(view: unknown): {
    ok: boolean;
    live: boolean;
    rawText: string;
    prefixByteLength: number;
    messagesByteLength: number;
    totalPromptByteLength: number;
    estimateTokens: number | null;
    pct: number | null;
    source: string;
    wireSource: string;
    wireMessageCount: number;
    transcriptPrefixByteLength: number;
    transcriptMessagesByteLength: number;
    transcriptTotalPromptByteLength: number;
    transcriptEstimateTokens: number | null;
    transcriptPct: number | null;
    sourceNote: string;
    messageCount: number;
    segmentCount: number;
    pieces: Array<{ kind: string; label: string; offset: number; end: number; byteLength: number; text: string }>;
    groups: Array<{ key: string; label: string; bytes: number; pieces: unknown[] }>;
  };
  loomContextRequestTotals(view: unknown): {
    ok: boolean;
    wireSource: string;
    prefixByteLength: number;
    messagesByteLength: number;
    totalPromptByteLength: number;
    messageCount: number;
  };
  loomUtf8ByteLength(text: unknown): number;
  loomContextHeaderText(t: unknown, basisChip?: unknown): string;
  loomTaskStatusMeta(status: unknown): { label: string; tone: string };
  loomTaskMerge(
    prev: unknown,
    next: unknown,
  ): { count: number; added: string[]; updated: string[]; removed: string[]; changed: boolean };
  loomEventBrief(type: unknown, props: unknown): string;
  loomWireMessagesView(
    messages: unknown,
  ): Array<{ index: number; role: string; byteLength: number; text: string; transient: boolean }>;
  loomManifestGroup(manifest: unknown): {
    ok: boolean;
    groups: Array<{
      key: string;
      label: string;
      rows: Array<{
        label: string;
        source: string;
        bytes: number | null;
        degraded: string | null;
        mark: string | null;
        badge: { text: string; tone: string } | null;
        kind?: string | null;
        toolCount?: number;
      }>;
    }>;
    counts: { memoryFiles: number; skillFiles: number; mcpServers: number; agentRoleFiles: number };
    model: { id: string; api: string; baseUrl: string; apiKeyMasked: string } | null;
    configPath: string;
    workspaceRoot: string;
  };
  loomWirePayloadAbsentView(wire: unknown): {
    hasWire: boolean;
    present: boolean;
    text: string;
    bytes: number;
    reason: string;
    capturedAt: number;
  };
  loomCtxReadableBody(text: unknown): string;
  loomContextPlainView(view: unknown): { ok: boolean; fromWire: boolean; note: string; text: string };
  loomCtxMemoryPlain(view: unknown): string;
  loomCtxManifestPlain(manifest: unknown): string;
  loomCtxParamsPlain(params: unknown): string;
  loomNoticeTimelinePush(
    ring: unknown,
    frame: unknown,
  ): Array<{ at: number; action: string; relPath: string; bytes: number | null; turnIdx: number | null }>;
  loomNoticeActionMeta(action: unknown): { label: string; tone: string };
  loomSessionRowView(session: unknown): {
    id: string;
    status: string;
    title: string;
    hasTitle: boolean;
    archived: boolean;
    createdAt: number;
  };
  loomVisibleSessions(list: unknown, archivedOnly: unknown): Array<Record<string, unknown>>;
  loomListSlice(rows: unknown, shown: unknown): { rows: unknown[]; hidden: number };
  loomSessionListPath(archivedOnly: unknown): string;
  loomTitleRequest(sid: unknown, title: unknown): { path: string; method: string; body: string };
  loomArchiveRequest(sid: unknown, archived: unknown): { path: string; method: string; body: string };
  loomTaskSourceBadge(row: unknown): { live: boolean; label: string };
  loomTasksNewestFirst(list: unknown): Array<Record<string, unknown>>;
  loomTaskTranscriptPath(sessionID: unknown): string;
  loomContextTruthBits(view: unknown): {
    basis: string;
    basisChip: string;
    wireState: string;
    wireChip: string;
    cache: boolean;
    line: string;
  };
  loomCompactionInsertIndex(messages: unknown[], anchorTimestampMs: unknown): number;
  loomCompactionCardView(
    compaction: unknown,
  ): { coveredCount: number; topLabel: string; bottomLabel: string; summary: string } | null;
  loomCompactionEventView(event: unknown): HarnessCompactionEventView | null;
  loomCompactionEventKey(view: unknown): string;
  loomCompactionEventList(bodyOrEvents: unknown): HarnessCompactionEventView[];
  loomCompactionPlacement(
    messages: unknown[],
    events: unknown[],
  ): {
    top: HarnessCompactionEventView[];
    at: Record<number, HarnessCompactionEventView[]>;
    tail: HarnessCompactionEventView[];
  };
}

interface HarnessCompactionEventView {
  id: string;
  coveredCount: number;
  topLabel: string;
  bottomLabel: string;
  summary: string;
  key?: string;
  anchorTimestampMs?: number | null;
  anchorMessageId?: string | null;
  recordedAt?: number;
}

const LOGIC_EXPORTS = [
  "loomEventDispatchTable",
  "loomToolStatusMeta",
  "loomMergeToolOutput",
  "loomExtractTaskSessions",
  "loomMessageFingerprint",
  "loomHistoryDelta",
  "loomFormatDuration",
  "loomNormalizeTodos",
  "loomTodoCounts",
  "loomApplyReasoningDelta",
  "loomReasoningState",
  "loomFormatCount",
  "loomContextTree",
  "loomSafeHref",
  "loomMarkdownBlocks",
  "loomMarkdownInline",
  "loomMarkdownRender",
  "loomContextFullView",
  "loomContextRequestTotals",
  "loomUtf8ByteLength",
  "loomContextHeaderText",
  "loomTaskStatusMeta",
  "loomTaskMerge",
  "loomEventBrief",
  "loomWireMessagesView",
  "loomManifestGroup",
  "loomWirePayloadAbsentView",
  "loomNoticeTimelinePush",
  "loomNoticeActionMeta",
  "loomCtxReadableBody",
  "loomContextPlainView",
  "loomCtxMemoryPlain",
  "loomCtxManifestPlain",
  "loomCtxParamsPlain",
  "loomSessionRowView",
  "loomVisibleSessions",
  "loomListSlice",
  "loomSessionListPath",
  "loomTitleRequest",
  "loomArchiveRequest",
  "loomTaskSourceBadge",
  "loomTasksNewestFirst",
  "loomTaskTranscriptPath",
  "loomContextTruthBits",
  "loomCompactionInsertIndex",
  "loomCompactionCardView",
  "loomCompactionEventView",
  "loomCompactionEventKey",
  "loomCompactionEventList",
  "loomCompactionPlacement",
] as const;

/** 页面纯逻辑段与浏览器执行的是同一份字符串：new Function 直接加载（无需 DOM）。 */
function loadHarnessLogic(): HarnessLogic {
  const factory = new Function(`${HARNESS_UI_LOGIC_JS}\nreturn {${LOGIC_EXPORTS.join(", ")}};`);
  return factory() as HarnessLogic;
}

describe("W11a2：事件分派 / 工具卡增量 / 子智能体面板", () => {
  it("事件分派表覆盖全部事件名，页面 switch 逐名有 case", () => {
    const logic = loadHarnessLogic();
    expect(logic.loomEventDispatchTable()).toEqual(EXPECTED_EVENTS);
    expect([...HARNESS_UI_HANDLED_EVENTS]).toEqual(EXPECTED_EVENTS);
    expect(EXPECTED_EVENTS).toContain("session.children");
    expect(EXPECTED_EVENTS).toContain("delivery.notify");
    for (const name of EXPECTED_EVENTS) {
      expect(HARNESS_UI_HTML, `页面 handleFrame 缺 ${name} 分支`).toContain(`case '${name}':`);
    }
  });

  it("工具卡 running 输出增量：前缀一致走 append，截尾/回退走 replace，无变化不动 DOM", () => {
    const logic = loadHarnessLogic();
    const first = logic.loomMergeToolOutput("", "line-1\n");
    expect(first).toEqual({ text: "line-1\n", mode: "append", appended: 7 });
    const second = logic.loomMergeToolOutput("line-1\n", "line-1\nline-2\n");
    expect(second.mode).toBe("append");
    expect(second.appended).toBe("line-2\n".length);
    expect(second.text).toBe("line-1\nline-2\n");
    expect(logic.loomMergeToolOutput(second.text, second.text).mode).toBe("same");
    expect(logic.loomMergeToolOutput(second.text, second.text).appended).toBe(0);
    // running 帧只带 tail（16KB 截头）时前缀不一致 → 整段替换
    const tail = logic.loomMergeToolOutput("line-1\nline-2\n", "line-2\nline-3\n");
    expect(tail.mode).toBe("replace");
    expect(tail.text).toBe("line-2\nline-3\n");
    // 输出回退（非增量）→ replace，绝不丢内容
    expect(logic.loomMergeToolOutput("abcdef", "abc").mode).toBe("replace");
  });

  it("工具状态徽标三态映射（pending 灰 / running 琥珀 / completed 绿 / error 红）", () => {
    const logic = loadHarnessLogic();
    expect(logic.loomToolStatusMeta("pending")).toEqual({ label: "排队中", tone: "pending" });
    expect(logic.loomToolStatusMeta("running")).toEqual({ label: "运行中", tone: "running" });
    expect(logic.loomToolStatusMeta("completed")).toEqual({ label: "完成", tone: "completed" });
    expect(logic.loomToolStatusMeta("error")).toEqual({ label: "失败", tone: "error" });
    expect(logic.loomToolStatusMeta("aborted")).toEqual({ label: "已中止", tone: "aborted" });
    expect(logic.loomToolStatusMeta("weird").tone).toBe("pending"); // 未知状态兜底不破卡
  });

  it("task 工具输出反解 <task_metadata> → 子会话（连字符归一 + 脏输入丢弃）", () => {
    const logic = loadHarnessLogic();
    const output =
      "任务完成\n<task_metadata>\nagent_type: quick\nsession_id: ses_0a1b2c3d4e5f6789\nreason: done\nturns: 3\ndepth: 1\n</task_metadata>\n";
    expect(logic.loomExtractTaskSessions(output)).toEqual([
      {
        sessionID: "ses_0a1b2c3d4e5f6789",
        agentType: "quick",
        reason: "done",
        turns: 3,
        depth: 1,
      },
    ]);
    // 连字符归一（与帧 sanitizeId / history 路由 normalizeSessionID 同口径）
    const hyphen = "<task_metadata>\nsession_id: ses-abc-123\n</task_metadata>";
    expect(logic.loomExtractTaskSessions(hyphen)[0]?.sessionID).toBe("ses_abc_123");
    // 无块 / 脏 id（含空格等非法字符）→ 空数组，不进子面板
    expect(logic.loomExtractTaskSessions("没有元数据")).toEqual([]);
    expect(logic.loomExtractTaskSessions("<task_metadata>\nsession_id: bad id!\n</task_metadata>")).toEqual([]);
    expect(logic.loomExtractTaskSessions("")).toEqual([]);
    // 一段文本多个块（横向并发扇出多子会话）
    expect(logic.loomExtractTaskSessions(`${output}${output}`)).toHaveLength(2);
  });

  it("子会话 history 轮询差分：append / replace / reset / idle（2s 轮询的增量核）", () => {
    const logic = loadHarnessLogic();
    const m1 = { id: "m1", role: "user", content: "hi" };
    const m2 = { id: "m2", role: "assistant", content: [{ type: "text", text: "ok" }] };
    const last2 = logic.loomMessageFingerprint(m2);
    expect(logic.loomHistoryDelta({ count: 0, last: "" }, [m1]).appendFrom).toBe(0);
    expect(logic.loomHistoryDelta({ count: 1, last: logic.loomMessageFingerprint(m1) }, [m1, m2])).toEqual({
      reset: false,
      appendFrom: 1,
      replaceFrom: -1,
      idle: false,
    });
    expect(logic.loomHistoryDelta({ count: 2, last: last2 }, [m1, m2]).idle).toBe(true);
    expect(logic.loomHistoryDelta({ count: 2, last: "stale" }, [m1, m2]).replaceFrom).toBe(1);
    expect(logic.loomHistoryDelta({ count: 5, last: last2 }, [m1]).reset).toBe(true);
    expect(logic.loomHistoryDelta({ count: 0, last: "" }, []).idle).toBe(true);
    // 时长格式（run.status 轨迹行）
    expect(logic.loomFormatDuration(450)).toBe("450ms");
    expect(logic.loomFormatDuration(1500)).toBe("1.5s");
    expect(logic.loomFormatDuration(65000)).toBe("1m5s");
  });

  it("todo.updated 归一：三键保留/脏值退保守/空 content 丢项/非数组空表；计数徽标纯数据", () => {
    const logic = loadHarnessLogic();
    const plan = [
      { content: "A", status: "in_progress", priority: "high" },
      { content: "B", status: "pending", priority: "medium" },
      { content: "C", status: "completed", priority: "low" },
    ];
    expect(logic.loomNormalizeTodos(plan)).toEqual(plan);
    // 脏 status/priority 退保守值，多余键剥离（面板只认三键）
    expect(
      logic.loomNormalizeTodos([{ content: "x", status: "weird", priority: "urgent", extra: 1 }]),
    ).toEqual([{ content: "x", status: "pending", priority: "medium" }]);
    // 空 content / 非对象条目 / 非数组帧 → 空表（坏帧不烂面板）
    expect(logic.loomNormalizeTodos([{ content: "  ", status: "pending", priority: "low" }, null, 7])).toEqual([]);
    expect(logic.loomNormalizeTodos(undefined)).toEqual([]);
    expect(logic.loomNormalizeTodos("nope")).toEqual([]);
    expect(logic.loomTodoCounts(plan)).toEqual({ done: 1, active: 1, total: 3 });
    expect(logic.loomTodoCounts([])).toEqual({ done: 0, active: 0, total: 0 });
    expect(logic.loomTodoCounts(null)).toEqual({ done: 0, active: 0, total: 0 });
  });

  it("页面契约：轮询模式标注 / 2s 周期 / 子面板与工具输出渲染入口", () => {
    expect(HARNESS_UI_HTML).toContain("轮询模式");
    expect(HARNESS_UI_HTML).toContain("SUB_POLL_MS = 2000");
    expect(HARNESS_UI_HTML).toContain("setInterval(function () { pollSub(id); }, SUB_POLL_MS)");
    expect(HARNESS_UI_HTML).toContain("/history?limit=200");
    expect(HARNESS_UI_HTML).toContain("openChildPanel");
    expect(HARNESS_UI_HTML).toContain("renderChildList");
    // 工具卡：running 实时输出窗（loomMergeToolOutput 驱动）+ 三态徽标 + task 子会话链接
    expect(HARNESS_UI_HTML).toContain("loomMergeToolOutput(");
    expect(HARNESS_UI_HTML).toContain("applyToolOutput");
    expect(HARNESS_UI_HTML).toContain("实时输出");
    expect(HARNESS_UI_HTML).toContain("打开子会话");
    // file.edited 轻量文件行 / 心跳只做指示灯 / notify 入 toast
    expect(HARNESS_UI_HTML).toContain("addFileRow");
    expect(HARNESS_UI_HTML).toContain("pushToast");
    expect(HARNESS_UI_HTML).toContain("tickHeartbeat");
    // 子面板增量渲染入口
    expect(HARNESS_UI_HTML).toContain("applySubHistory");
    expect(HARNESS_UI_HTML).toContain("loomHistoryDelta(");
    // W11b todo 栏：右栏内挂载位（挨子智能体列表）+ 整表重绘入口 + 空表隐藏 + 会话切换复位
    expect(HARNESS_UI_HTML).toContain('id="todoPanel"');
    expect(HARNESS_UI_HTML).toContain('id="todoList"');
    expect(HARNESS_UI_HTML).toContain("function renderTodoPanel()");
    expect(HARNESS_UI_HTML).toContain("state.todos = loomNormalizeTodos(props.todos);");
    expect(HARNESS_UI_HTML).toContain("els.todoPanel.hidden = true;");
    expect(HARNESS_UI_HTML).toContain("state.todos = [];\n    renderTodoPanel();");
    // 状态色体系注释在 CSS（pending 灰 / in_progress 琥珀 / completed 绿打勾划线）+ priority 徽标
    expect(HARNESS_UI_HTML).toContain(".todo-item.st-progress");
    expect(HARNESS_UI_HTML).toContain(".todo-item.st-done");
    expect(HARNESS_UI_HTML).toContain(".todo-pr.p-high");
  });

  it("页面纪律：无 emoji、innerHTML 单一入口、动态文本 textContent、token 只进 sessionStorage", () => {
    expect(/\p{Extended_Pictographic}/u.test(HARNESS_UI_HTML)).toBe(false);
    const assigns = HARNESS_UI_HTML.match(/\.innerHTML\s*=/g) ?? [];
    expect(assigns).toHaveLength(1); // 唯一 setIcon（只写内置 SVG 常量）
    expect(HARNESS_UI_HTML).toContain("function setIcon");
    expect((HARNESS_UI_HTML.match(/textContent/g) ?? []).length).toBeGreaterThan(30);
    expect(HARNESS_UI_HTML).toContain("sessionStorage");
  });
});

// ───────────────────────── W13：思考流渲染 + 上下文树（追加段） ─────────────────────────

describe("W13：思考流渲染逻辑 / 上下文树渲染逻辑", () => {
  it("思考增量合并：增量按序追加；终态快照整段替换（绝无双倍累积）；脏输入兜底", () => {
    const logic = loadHarnessLogic();
    expect(logic.loomApplyReasoningDelta("", "先", false)).toEqual({ text: "先", mode: "append" });
    const second = logic.loomApplyReasoningDelta("先", "再", false);
    expect(second.text).toBe("先再");
    expect(logic.loomApplyReasoningDelta("先再", "", false)).toEqual({ text: "先再", mode: "same" });
    // llm-end 快照 = 全文替换，不 append（否则与已累积增量重复）
    expect(logic.loomApplyReasoningDelta("先再", "先再后", true)).toEqual({ text: "先再后", mode: "final" });
    expect(logic.loomApplyReasoningDelta(undefined, "x", false)).toEqual({ text: "x", mode: "append" });
    expect(logic.loomApplyReasoningDelta(7, 8, false)).toEqual({ text: "", mode: "same" });
    expect(logic.loomApplyReasoningDelta("abc", 9, true).text).toBe("abc");
    // 多块思考各自独立累积（part id 不同 → 调用方分槽；此处只钉单槽纯函数序）
    expect(["A", "B", "C"].reduce((acc, d) => logic.loomApplyReasoningDelta(acc, d, false).text, "")).toBe("ABC");
  });

  it("思考块显示态：流式=思考中+打字光标；终态=字数提示（默认折叠回看）", () => {
    const logic = loadHarnessLogic();
    expect(logic.loomReasoningState(true, "")).toEqual({
      label: "思考",
      hint: "思考中",
      cursor: true,
      streaming: true,
      tone: "streaming",
    });
    const done = logic.loomReasoningState(false, "abcd");
    expect(done.cursor).toBe(false);
    expect(done.streaming).toBe(false);
    expect(done.hint).toBe("4 字");
    expect(done.tone).toBe("done");
    expect(logic.loomReasoningState(false, "").hint).toBe("");
    expect(logic.loomReasoningState("yes", "x").cursor).toBe(false); // 非布尔 true 不误判流式
  });

  it("数量缩写：k/m 分档（上下文总量/行计数显示）", () => {
    const logic = loadHarnessLogic();
    expect(logic.loomFormatCount(0)).toBe("0");
    expect(logic.loomFormatCount(999)).toBe("999");
    expect(logic.loomFormatCount(1200)).toBe("1.2k");
    expect(logic.loomFormatCount(12000)).toBe("12k");
    expect(logic.loomFormatCount(1250000)).toBe("1.3m");
    expect(logic.loomFormatCount("bad")).toBe("0");
    expect(logic.loomFormatCount(null)).toBe("0");
  });

  it("上下文树：段序固定归组 / null 保留（trace 反推不伪造）/ 降级标注 / 占比与徽标", () => {
    const logic = loadHarnessLogic();
    const view = {
      basis: "assembly",
      rows: [
        { segment: "increment", label: "本轮消息", source: "user", lines: 1, bytes: 10, estimatedTokens: 3, degraded: null },
        { segment: "system", label: "系统提示（身份框）", source: "systemPrompt", lines: 4, bytes: 58, estimatedTokens: 17, degraded: null },
        { segment: "memory", label: "memory 注入", source: "AGENTS.md", lines: 3, bytes: 40, estimatedTokens: 11, degraded: "missing" },
        { segment: "weird", label: "x", source: "", lines: null, bytes: null, estimatedTokens: null, degraded: 7 },
      ],
      totalBytes: 108,
      totalLines: 8,
      estimatedTokens: 31,
      contextWindow: 200000,
      usageRatio: 0.000155,
      note: "token 为粗估（UTF-8 字节 / 3.5）",
    };
    const tree = logic.loomContextTree(view);
    expect(tree.ok).toBe(true);
    // 固定段序（与输入乱序无关）；未知段归增量槽
    expect(tree.groups.map((g) => g.segment)).toEqual(["system", "memory", "increment"]);
    expect(tree.groups[0]!.label).toBe("系统");
    expect(tree.groups[1]!.rows[0]!["source"]).toBe("AGENTS.md");
    expect(tree.groups[1]!.rows[0]!["degraded"]).toBe("missing");
    const weird = tree.groups[2]!.rows.find((r) => r["label"] === "x")!;
    expect(weird["lines"]).toBeNull();
    expect(weird["bytes"]).toBeNull();
    expect(weird["tokens"]).toBeNull();
    expect(weird["degraded"]).toBeNull(); // 非字符串降级值 → null，坏帧不烂面板
    expect(tree.badge).toBe("31 tok");
    expect(tree.pct).toBeCloseTo((31 / 200000) * 100, 10);
    expect(tree.meta).toContain("行");
    expect(tree.note).toContain("粗估");
    // 副会话 trace 反推：basis 标注 + 总量 null 不伪造
    const trace = logic.loomContextTree({ ...view, basis: "trace", totalBytes: null, estimatedTokens: null, contextWindow: null });
    expect(trace.basis).toBe("trace 反推");
    expect(trace.total.tokens).toBeNull();
    expect(trace.pct).toBeNull();
    // 空帧/坏帧不塌
    expect(logic.loomContextTree(null).ok).toBe(false);
    expect(logic.loomContextTree("bad").groups).toEqual([]);
  });

  it("页面契约（W13）：思考块与上下文面板接线字符串在页内", () => {
    expect(HARNESS_UI_HTML).toContain('id="contextPanel"');
    expect(HARNESS_UI_HTML).toContain('id="ctxTree"');
    expect(HARNESS_UI_HTML).toContain('id="ctxRefresh"');
    expect(HARNESS_UI_HTML).toContain("function paintContext(");
    expect(HARNESS_UI_HTML).toContain("function loadContext(");
    expect(HARNESS_UI_HTML).toContain("/context");
    expect(HARNESS_UI_HTML).toContain("loomContextTree(");
    expect(HARNESS_UI_HTML).toContain("loomApplyReasoningDelta(");
    expect(HARNESS_UI_HTML).toContain("loomReasoningState(");
    expect(HARNESS_UI_HTML).toContain("paintReasoningPart");
    expect(HARNESS_UI_HTML).toContain("loadContext(); // 每轮结束自动刷新");
    expect(HARNESS_UI_HTML).toContain("思考中");
    // W18 用户判词：路径复制按钮全下线——原 toContain("复制路径") 钉反转为零出现（regex 钉见 W18 段）
    expect(HARNESS_UI_HTML).not.toContain("复制路径");
    expect(HARNESS_UI_HTML).toContain("reason-body.streaming");
    expect(HARNESS_UI_HTML).toContain("ctxBarFill");
  });
});

// ───────────── W16-C：五视图重构（markdown / context-full / tasks / events） ─────────────

/** 记录型假 DOM：只实现 markdown 构造器用到的最小面（textContent getter/setter）。 */
function fakeDoc(): {
  createElement(tag: string): any;
  createTextNode(text: string): any;
  createDocumentFragment(): any;
} {
  const make = (tag: string): any => {
    const node: any = {
      tag,
      className: "",
      attrs: {},
      children: [],
      _text: "",
      appendChild(child: any) {
        node.children.push(child);
        return child;
      },
      setAttribute(key: string, value: string) {
        node.attrs[key] = value;
      },
      addEventListener() {
        /* 页面侧事件委托接线；测试只验结构，不触发点击 */
      },
    };
    Object.defineProperty(node, "textContent", {
      get() {
        return node._text;
      },
      set(v: unknown) {
        node._text = String(v);
        node.children = [];
      },
    });
    return node;
  };
  return {
    createElement: make,
    createTextNode(text: string): any {
      return { tag: "#text", text: String(text), attrs: {}, children: [] };
    },
    createDocumentFragment(): any {
      return make("#fragment");
    },
  };
}

function walkNodes(node: any, visit: (n: any) => void): void {
  if (!node || typeof node !== "object") return;
  visit(node);
  const kids = Array.isArray(node.children) ? node.children : [];
  for (const kid of kids) walkNodes(kid, visit);
}

function collectText(node: any): string {
  let out = "";
  walkNodes(node, (n) => {
    if (n.tag === "#text" && typeof n.text === "string") out += n.text;
    else if (typeof n._text === "string") out += n._text;
  });
  return out;
}

function findByTag(node: any, tag: string): any[] {
  const hits: any[] = [];
  walkNodes(node, (n) => {
    if (n.tag === tag) hits.push(n);
  });
  return hits;
}

describe("W16-C：markdown 解析（块/行内/链接白名单）", () => {
  it("块解析：标题 1-4 / 围栏代码（lang）/ 嵌套列表 / 有序列表 / 引用 / 表格", () => {
    const logic = loadHarnessLogic();
    const md = [
      "# 标题一",
      "## 标题二",
      "### 标题三",
      "#### 标题四",
      "",
      "段落文本",
      "",
      "- 项 A",
      "  - 嵌套 B",
      "- 项 C",
      "",
      "1. 第一",
      "2. 第二",
      "",
      "> 引用行",
      "",
      "| 列1 | 列2 |",
      "| --- | --- |",
      "| a | b |",
      "",
      "```ts",
      "const x = 1;",
      "```",
    ].join("\n");
    const blocks = logic.loomMarkdownBlocks(md);
    expect(blocks.map((b) => b["type"])).toEqual([
      "heading", "heading", "heading", "heading",
      "paragraph", "list", "list", "quote", "table", "code",
    ]);
    expect(blocks[0]).toEqual({ type: "heading", level: 1, text: "标题一" });
    expect(blocks[3]).toEqual({ type: "heading", level: 4, text: "标题四" });
    const list = blocks[5] as any;
    expect(list.ordered).toBe(false);
    expect(list.items).toHaveLength(2);
    expect(list.items[0].children[0].type).toBe("list");
    expect(list.items[0].children[0].items[0].text).toBe("嵌套 B");
    const ordered = blocks[6] as any;
    expect(ordered.ordered).toBe(true);
    expect(ordered.start).toBe(1);
    expect(ordered.items[1].text).toBe("第二");
    const quote = blocks[7] as any;
    expect(quote.blocks[0]).toEqual({ type: "paragraph", text: "引用行" });
    const table = blocks[8] as any;
    expect(table.head).toEqual(["列1", "列2"]);
    expect(table.rows).toEqual([["a", "b"]]);
    expect(table.align).toEqual([null, null]);
    const code = blocks[9] as any;
    expect(code.lang).toBe("ts");
    expect(code.text).toBe("const x = 1;");
  });

  it("原始 HTML 探针字符串原样留在文本块（不解析入结构）", () => {
    const logic = loadHarnessLogic();
    const blocks = logic.loomMarkdownBlocks("<img src=x onerror=alert(1)>\n\n<script>alert(2)</script>");
    expect(blocks).toEqual([
      { type: "paragraph", text: "<img src=x onerror=alert(1)>" },
      { type: "paragraph", text: "<script>alert(2)</script>" },
    ]);
  });

  it("行内：粗体/斜体/代码跨度/转义；词内下划线不强调（snake_case 保真）", () => {
    const logic = loadHarnessLogic();
    expect(logic.loomMarkdownInline("**粗**")).toEqual([
      { type: "strong", children: [{ type: "text", text: "粗" }] },
    ]);
    expect(logic.loomMarkdownInline("*斜*")).toEqual([
      { type: "em", children: [{ type: "text", text: "斜" }] },
    ]);
    expect(logic.loomMarkdownInline("`代码`")).toEqual([{ type: "code", text: "代码" }]);
    expect(logic.loomMarkdownInline("a \\*b\\*")).toEqual([{ type: "text", text: "a *b*" }]);
    expect(logic.loomMarkdownInline("snake_case_name")).toEqual([{ type: "text", text: "snake_case_name" }]);
  });

  it("链接白名单：http/https/mailto 通过；javascript:/data: 降级纯文本（零 href）", () => {
    const logic = loadHarnessLogic();
    expect(logic.loomSafeHref("https://example.com/a")).toBe("https://example.com/a");
    expect(logic.loomSafeHref("http://example.com")).toBe("http://example.com");
    expect(logic.loomSafeHref("mailto:a@b.c")).toBe("mailto:a@b.c");
    expect(logic.loomSafeHref("javascript:alert(1)")).toBeNull();
    expect(logic.loomSafeHref("data:text/html,x")).toBeNull();
    expect(logic.loomSafeHref("vbscript:x")).toBeNull();
    expect(logic.loomSafeHref("//evil.com")).toBeNull();
    expect(logic.loomSafeHref(undefined)).toBeNull();
    expect(logic.loomMarkdownInline("[站点](https://example.com/a)")).toEqual([
      { type: "link", href: "https://example.com/a", children: [{ type: "text", text: "站点" }] },
    ]);
    expect(logic.loomMarkdownInline("[点我](javascript:alert(1))")).toEqual([
      { type: "text", text: "[点我](javascript:alert(1))" },
    ]);
  });
});

describe("W16-C：markdown 假 DOM 构造（XSS 探针必须成惰性文本节点）", () => {
  it("img/script 探针：全树无 script/img 元素，内容只存在于文本节点", () => {
    const logic = loadHarnessLogic();
    const doc = fakeDoc();
    const root = logic.loomMarkdownRender(
      doc,
      "看图 <img src=x onerror=\"alert(1)\"> 结束\n\n<script>alert(2)</script>\n\n[劫持](javascript:alert(3))",
    );
    expect(findByTag(root, "script")).toHaveLength(0);
    expect(findByTag(root, "img")).toHaveLength(0);
    expect(findByTag(root, "a")).toHaveLength(0);
    expect(collectText(root)).toContain('<img src=x onerror="alert(1)">');
    expect(collectText(root)).toContain("<script>alert(2)</script>");
  });

  it("安全链接产出 a[href][rel=noopener]；代码块带复制按钮与全文", () => {
    const logic = loadHarnessLogic();
    const doc = fakeDoc();
    const root = logic.loomMarkdownRender(doc, "见 [文档](https://example.com/x)\n\n```js\nconst a = \"<script>\";\n```");
    const anchors = findByTag(root, "a");
    expect(anchors).toHaveLength(1);
    expect(anchors[0]["attrs"]["href"]).toBe("https://example.com/x");
    expect(anchors[0]["attrs"]["rel"]).toBe("noopener");
    const buttons = findByTag(root, "button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]["attrs"]["data-md-copy"]).toBe("code");
    expect(buttons[0]["_text"]).toBe("复制");
    expect(collectText(root)).toContain('const a = "<script>";');
    expect(findByTag(root, "script")).toHaveLength(0);
  });

  it("标题/嵌套列表/表格构造到对应元素", () => {
    const logic = loadHarnessLogic();
    const doc = fakeDoc();
    const root = logic.loomMarkdownRender(doc, "# 一\n\n- a\n  - b\n\n| x | y |\n| --- | --- |\n| 1 | 2 |");
    expect(findByTag(root, "h1")).toHaveLength(1);
    expect(findByTag(root, "ul")).toHaveLength(2);
    expect(findByTag(root, "table")).toHaveLength(1);
    expect(findByTag(root, "th")).toHaveLength(2);
    expect(findByTag(root, "td")).toHaveLength(2);
  });
});

describe("W16-C：/context/full 字节布局（offset 累计 + 总量 + 全文拼接）", () => {
  const view = {
    sessionID: "ses_ctx",
    capturedAt: 1234567890,
    basis: "live",
    prefixHash: "pfxhash",
    systemPromptSha256: "shahash",
    systemPrompt: "SYS",
    prefixByteLength: 3,
    segments: [{ index: 0, label: "identity", offset: 0, byteLength: 3, text: "SYS" }],
    messages: [
      { index: 0, role: "user", offset: 3, byteLength: 5, text: "hello" },
      { index: 1, role: "assistant", offset: 8, byteLength: 2, text: "ok" },
    ],
    messagesByteLength: 7,
    totalPromptByteLength: 10,
    contextWindow: 1000000,
    transientExcluded: "todo/nudge",
    note: "note",
  };

  it("offset/end/byteLength 逐段可见；总量与占比按契约值", () => {
    const logic = loadHarnessLogic();
    const t = logic.loomContextFullView(view);
    expect(t.ok).toBe(true);
    expect(t.live).toBe(true);
    expect(t.pieces.map((p) => [p.offset, p.end, p.byteLength])).toEqual([
      [0, 3, 3],
      [3, 8, 5],
      [8, 10, 2],
    ]);
    expect(t.prefixByteLength).toBe(3);
    expect(t.messagesByteLength).toBe(7);
    expect(t.totalPromptByteLength).toBe(10);
    expect(t.estimateTokens).toBe(Math.round(10 / 3.5));
    expect(t.pct).toBeCloseTo((Math.round(10 / 3.5) / 1000000) * 100, 10);
    expect(t.rawText).toBe("SYS" + "hello" + "ok");
    expect(t.groups.map((g) => g.key)).toEqual(["identity", "increment"]);
    expect(t.groups[1]!["pieces"]).toHaveLength(2);
  });

  it("offset 缺失用累计游标补齐；systemPrompt 兜底兜整段；坏帧不塌", () => {
    const logic = loadHarnessLogic();
    const noOffset = logic.loomContextFullView({
      segments: [{ label: "system", byteLength: 4, text: "AAAA" }],
      messages: [{ role: "user", byteLength: 2, text: "BB" }],
      totalPromptByteLength: 6,
      contextWindow: 1000000,
    });
    expect(noOffset.pieces.map((p) => p.offset)).toEqual([0, 4]);
    expect(noOffset.prefixByteLength).toBe(4);
    expect(noOffset.messagesByteLength).toBe(2);
    const fallback = logic.loomContextFullView({
      systemPrompt: "SYS-TEXT",
      prefixByteLength: 8,
      messages: [],
      totalPromptByteLength: 8,
    });
    expect(fallback.pieces[0]!["label"]).toBe("systemPrompt");
    expect(fallback.rawText).toBe("SYS-TEXT");
    expect(logic.loomContextFullView(null).ok).toBe(false);
    expect(logic.loomContextFullView("bad").ok).toBe(false);
  });
});

describe("上下文顶线：发线请求口径（wire request totals）", () => {
  // durable 转录 = v1 冻结面（压缩前历史/图片 base64 已落盘但未进最后一次请求），
  // 有效总量必须取 wire.request 真值，transcript* 留档作对照；注记逐字兜底。
  const TRANSCRIPT_TOTAL = 11040810;
  const transcriptView = {
    sessionID: "ses_wire",
    basis: "live",
    systemPrompt: "BLOATED-SYS",
    prefixByteLength: 40810,
    messages: [
      { index: 0, role: "user", offset: 40810, byteLength: 6000000, text: "a" },
      { index: 1, role: "assistant", offset: 6040810, byteLength: 5000000, text: "b" },
    ],
    messagesByteLength: 11000000,
    totalPromptByteLength: TRANSCRIPT_TOTAL,
    contextWindow: 1000000,
  };
  // wire：前缀 "WIRE-SYS" = 8B；消息 20+30 = 50B；分隔符 +1 → 总 59B。
  const wireRequest = {
    systemPrompt: "WIRE-SYS",
    messages: [
      { index: 0, role: "user", byteLength: 20, text: "hello" },
      { index: 1, role: "assistant", byteLength: 30, text: "world" },
    ],
  };

  it("wire 在场：有效总量取发线请求，transcript* 保留 v1 口径与回退注记", () => {
    const logic = loadHarnessLogic();
    const t = logic.loomContextFullView({ ...transcriptView, wire: { source: "live", request: wireRequest } });
    expect(t.source).toBe("wire");
    expect(t.wireSource).toBe("live");
    expect(t.wireMessageCount).toBe(2);
    expect(t.prefixByteLength).toBe(8);
    expect(t.messagesByteLength).toBe(50);
    expect(t.totalPromptByteLength).toBe(59);
    expect(t.transcriptPrefixByteLength).toBe(40810);
    expect(t.transcriptMessagesByteLength).toBe(11000000);
    expect(t.transcriptTotalPromptByteLength).toBe(TRANSCRIPT_TOTAL);
    expect(t.transcriptEstimateTokens).toBe(Math.round(TRANSCRIPT_TOTAL / 3.5));
    expect(t.transcriptPct).toBeCloseTo(Math.min(100, (Math.round(TRANSCRIPT_TOTAL / 3.5) / 1000000) * 100), 10);
    expect(t.estimateTokens).toBe(Math.round(59 / 3.5));
    expect(t.pct).toBeCloseTo((Math.round(59 / 3.5) / 1000000) * 100, 10);
    expect(t.sourceNote).toContain("durable 转录");
    expect(t.sourceNote).toContain("未进本次请求");
    // v1 渲染面语义不动：pieces/messageCount 仍按 durable 转录（systemPrompt 兜底件 + 2 消息）
    expect(t.pieces).toHaveLength(3);
    expect(t.messageCount).toBe(2);
  });

  it("wireSource：source=cache 时总量仍用 wire，来源如实转呈 cache", () => {
    const logic = loadHarnessLogic();
    const t = logic.loomContextFullView({ ...transcriptView, wire: { source: "cache", request: wireRequest } });
    expect(t.source).toBe("wire");
    expect(t.wireSource).toBe("cache");
    expect(t.totalPromptByteLength).toBe(59);
    expect(t.sourceNote).toContain("durable 转录");
  });

  it("wire null：回退 durable 转录口径，sourceNote 为空且各计数有限", () => {
    const logic = loadHarnessLogic();
    const t = logic.loomContextFullView({ ...transcriptView, wire: null });
    expect(t.source).toBe("transcript");
    expect(t.wireSource).toBe("");
    expect(t.wireMessageCount).toBe(0);
    expect(t.prefixByteLength).toBe(40810);
    expect(t.messagesByteLength).toBe(11000000);
    expect(t.totalPromptByteLength).toBe(TRANSCRIPT_TOTAL);
    expect(t.estimateTokens).toBe(Math.round(TRANSCRIPT_TOTAL / 3.5));
    expect(t.sourceNote).toBe("");
    for (const n of [t.prefixByteLength, t.messagesByteLength, t.totalPromptByteLength, t.estimateTokens, t.pct]) {
      expect(Number.isFinite(n)).toBe(true);
    }
  });

  it("wire 结构不完整：非对象 / {} / 缺 request / 缺 systemPrompt / messages 非数组 → 回退 + 回退注记", () => {
    const logic = loadHarnessLogic();
    const bads: unknown[] = [
      "bad",
      {},
      { request: null },
      { request: {} },
      { request: { systemPrompt: "SYS" } },
      { request: { systemPrompt: "SYS", messages: "nope" } },
      { request: { messages: [] } },
    ];
    for (const wire of bads) {
      const t = logic.loomContextFullView({ ...transcriptView, wire });
      expect(t.source).toBe("transcript");
      expect(t.totalPromptByteLength).toBe(TRANSCRIPT_TOTAL);
      expect(t.sourceNote).toBe("发线请求面不完整（缺 systemPrompt/messages），已回退 durable 转录口径");
      for (const n of [t.prefixByteLength, t.messagesByteLength, t.totalPromptByteLength, t.estimateTokens, t.pct]) {
        expect(Number.isFinite(n)).toBe(true);
      }
    }
  });

  it("脏 byteLength 条目逐条中和：string/负数/NaN/Infinity/缺 text/非对象 → 不抛且总量有限，wire 仍有效", () => {
    const logic = loadHarnessLogic();
    const t = logic.loomContextFullView({
      ...transcriptView,
      wire: {
        source: "live",
        request: {
          systemPrompt: "SYS",
          messages: [
            { byteLength: "12", text: "A" },
            { byteLength: -1, text: "BB" },
            { byteLength: NaN, text: "CCC" },
            { byteLength: Infinity, text: "汉字" },
            { byteLength: 4 },
            null,
            "junk",
          ],
        },
      },
    });
    expect(t.source).toBe("wire");
    expect(t.wireMessageCount).toBe(7);
    expect(t.messagesByteLength).toBe(16);
    expect(t.totalPromptByteLength).toBe(20);
    expect(t.estimateTokens).toBe(Math.round(20 / 3.5));
    for (const n of [t.prefixByteLength, t.messagesByteLength, t.totalPromptByteLength, t.estimateTokens, t.pct]) {
      expect(Number.isFinite(n)).toBe(true);
    }
  });

  it("UTF-8 字节：BMP 汉字 3B、代理对 4B、消息脏 byteLength 回退 text 真字节", () => {
    const logic = loadHarnessLogic();
    expect(logic.loomUtf8ByteLength("系统提示")).toBe(12);
    expect(logic.loomUtf8ByteLength("😀")).toBe(4);
    expect(logic.loomUtf8ByteLength("a")).toBe(1);
    expect(logic.loomUtf8ByteLength(null)).toBe(0);
    const t = logic.loomContextFullView({
      ...transcriptView,
      wire: { source: "live", request: { systemPrompt: "", messages: [{ byteLength: "dirty", text: "汉" }] } },
    });
    expect(t.source).toBe("wire");
    expect(t.prefixByteLength).toBe(0);
    expect(t.messagesByteLength).toBe(3);
    expect(t.totalPromptByteLength).toBe(4);
  });

  it("零消息：total = 前缀 + 0（不 +1），估算仍取整", () => {
    const logic = loadHarnessLogic();
    const t = logic.loomContextFullView({
      ...transcriptView,
      wire: { source: "live", request: { systemPrompt: "SYS", messages: [] } },
    });
    expect(t.source).toBe("wire");
    expect(t.wireMessageCount).toBe(0);
    expect(t.totalPromptByteLength).toBe(3);
    expect(t.estimateTokens).toBe(1);
  });

  it("总量相等：wire 与 durable 转录同值时 sourceNote 为空", () => {
    const logic = loadHarnessLogic();
    const t = logic.loomContextFullView({
      ...transcriptView,
      prefixByteLength: 8,
      messagesByteLength: 50,
      totalPromptByteLength: 59,
      wire: { source: "live", request: wireRequest },
    });
    expect(t.source).toBe("wire");
    expect(t.totalPromptByteLength).toBe(59);
    expect(t.sourceNote).toBe("");
  });

  it("loomContextRequestTotals：直接返回发线口径；invalid 仍转呈 wire.source", () => {
    const logic = loadHarnessLogic();
    expect(logic.loomContextRequestTotals({ wire: { source: "cache", request: wireRequest } })).toEqual({
      ok: true,
      wireSource: "cache",
      prefixByteLength: 8,
      messagesByteLength: 50,
      totalPromptByteLength: 59,
      messageCount: 2,
    });
    expect(logic.loomContextRequestTotals({ wire: { source: "cache" } })).toEqual({
      ok: false,
      wireSource: "cache",
      prefixByteLength: 0,
      messagesByteLength: 0,
      totalPromptByteLength: 0,
      messageCount: 0,
    });
    expect(logic.loomContextRequestTotals(null).ok).toBe(false);
  });

  it("loomContextHeaderText：发线/转录标签、空值破折号、绝不输出 NaN", () => {
    const logic = loadHarnessLogic();
    const wireT = {
      source: "wire",
      prefixByteLength: 1000,
      messagesByteLength: 2000,
      totalPromptByteLength: 3000,
      estimateTokens: 857,
      contextWindow: 200000,
    };
    expect(logic.loomContextHeaderText(wireT, "基底=实时")).toBe(
      "[基底=实时] 发线请求 · 前缀 1.0k B · 消息 2.0k B · 总 3.0k B · 估算 ~857 tok · 窗口 200k",
    );
    const txT = { ...wireT, source: "transcript" };
    expect(logic.loomContextHeaderText(txT, "")).toContain("转录快照");
    const emptyT = { ...wireT, estimateTokens: null, contextWindow: null };
    const empty = logic.loomContextHeaderText(emptyT, "");
    expect(empty).toContain("估算 ~— tok · 窗口 —");
    expect(empty).not.toContain("NaN");
    expect(logic.loomContextHeaderText(null, "")).not.toContain("NaN");
    expect(logic.loomContextHeaderText({ ...wireT, estimateTokens: NaN }, "")).not.toContain("NaN");
  });
});

describe("W16-C：任务差分 / 状态徽标 / 事件摘要", () => {
  it("任务列表差分：added/updated/removed/changed（3s 轮询的增量核）", () => {
    const logic = loadHarnessLogic();
    const t1 = { task_id: "t1", status: "running" };
    const t2 = { task_id: "t2", status: "queued" };
    expect(logic.loomTaskMerge([], [t1, t2])).toEqual({
      count: 2,
      added: ["t1", "t2"],
      updated: [],
      removed: [],
      changed: true,
    });
    const m2 = logic.loomTaskMerge([t1, t2], [{ ...t1, status: "done" }, t2]);
    expect(m2.updated).toEqual(["t1"]);
    expect(m2.added).toEqual([]);
    expect(m2.removed).toEqual([]);
    expect(m2.changed).toBe(true);
    const m3 = logic.loomTaskMerge([t1, t2], [t2]);
    expect(m3.removed).toEqual(["t1"]);
    expect(logic.loomTaskMerge([t2], [t2]).changed).toBe(false);
    expect(logic.loomTaskMerge("bad", null)).toEqual({
      count: 0,
      added: [],
      updated: [],
      removed: [],
      changed: false,
    });
  });

  it("任务状态徽标：RunState 词表 + 视图扩展词", () => {
    const logic = loadHarnessLogic();
    expect(logic.loomTaskStatusMeta("running")).toEqual({ label: "运行中", tone: "running" });
    expect(logic.loomTaskStatusMeta("queued").tone).toBe("pending");
    expect(logic.loomTaskStatusMeta("done").tone).toBe("completed");
    expect(logic.loomTaskStatusMeta("failed").tone).toBe("error");
    expect(logic.loomTaskStatusMeta("partial").tone).toBe("warn");
    expect(logic.loomTaskStatusMeta("dead-letter").tone).toBe("error");
    expect(logic.loomTaskStatusMeta(undefined)).toEqual({ label: "未知", tone: "pending" });
  });

  it("事件摘要：事件名有可读附注；未知类型空串", () => {
    const logic = loadHarnessLogic();
    expect(logic.loomEventBrief("message.part.delta", { field: "text", delta: "abc" })).toBe("增量 text +3");
    expect(logic.loomEventBrief("session.status", { status: { type: "busy" } })).toBe("busy");
    expect(logic.loomEventBrief("file.edited", { file: "/a/b.ts" })).toBe("/a/b.ts");
    expect(logic.loomEventBrief("session.children", { children: [1, 2] })).toBe("2 个子会话");
    expect(logic.loomEventBrief("watchdog.alarm", { event: "stall" })).toBe("stall");
    expect(logic.loomEventBrief("unknown.future.event", {})).toBe("");
  });
});

describe("W16-C：五视图契约字符串（DOM id 迁移说明见文件头）", () => {
  it("标签栏与五视图 DOM id 在场", () => {
    // W18：ctxFull/ctxRaw/ctxRawBody（分段树+原始字节抽屉）随纯文本重排下线，
    // 新面 = ctxPlain 板块 + 模块折叠块（ctxMod*），原树钉换文本面钉。
    const ids = [
      "tabbar", "tabChat", "tabContext", "tabChildren", "tabTasks", "tabEvents",
      "viewChat", "viewContext", "viewChildren", "viewTasks", "viewEvents",
      "childJump", "childRail", "tabChildrenBadge", "tabTasksBadge", "tabEventsBadge",
      "ctxPlain", "ctxPlainNote", "ctxModSystem", "ctxModMemory", "ctxModWorkflow",
      "ctxModParams", "ctxModManifest", "ctxCopyAll", "ctxNotice", "ctxSubMeta",
      "taskList", "taskNotice", "taskRefresh", "runList", "runCount",
      "eventList", "eventCount", "eventUnknown", "eventHideDelta", "eventClear",
    ];
    for (const id of ids) expect(HARNESS_UI_HTML, `缺 DOM id ${id}`).toContain(`id="${id}"`);
    // 退役面反向钉死（防回潮：树卡/原始抽屉/三区 wire 容器不得再出现在 HTML）
    for (const dead of ['id="ctxFull"', 'id="ctxRaw"', 'id="ctxRawBody"', 'id="ctxZoneWire"', 'id="ctxZoneManifest"', 'id="ctxManifestGroups"']) {
      expect(HARNESS_UI_HTML, `W18 退役容器复现：${dead}`).not.toContain(dead);
    }
  });

  it("上下文新面：/context/full 优先 + 无 live 环回诚实回退 + 按发送顺序纯文本板块", () => {
    // W18：renderRawDrawer/复制本段随分段树+原始抽屉下线；全文入口收敛为 ctxPlain 一块 + 复制全文
    expect(HARNESS_UI_HTML).toContain("/context/full");
    expect(HARNESS_UI_HTML).toContain("无 live 环回");
    expect(HARNESS_UI_HTML).toContain("loadLegacyContext");
    expect(HARNESS_UI_HTML).toContain("loomContextFullView(");
    expect(HARNESS_UI_HTML).toContain("loomContextPlainView(");
    expect(HARNESS_UI_HTML).toContain("复制全文");
    expect(HARNESS_UI_HTML).not.toContain("复制本段");
    // 板块一纯文本面 = 唯一 pre 容器，只走 textContent（XSS 纪律与全文不截断的载体钉）
    expect(HARNESS_UI_HTML).toContain('<pre class="ctx-plain" id="ctxPlain"');
    expect(HARNESS_UI_HTML).toContain("els.ctxPlain.textContent = plain.text;");
  });

  it("任务面：GET /tasks 轮询 / 详情 / cancel；/runs 只读；无运行派发", () => {
    expect(HARNESS_UI_HTML).toContain("request('/tasks')");
    expect(HARNESS_UI_HTML).toContain("/tasks/' + encodeURIComponent(taskId)");
    expect(HARNESS_UI_HTML).toContain("/cancel");
    expect(HARNESS_UI_HTML).toContain("TASK_POLL_MS = 3000");
    expect(HARNESS_UI_HTML).toContain("state.view !== 'tasks'");
    expect(HARNESS_UI_HTML).toContain("loomTaskMerge(");
    expect(HARNESS_UI_HTML).toContain("GET /runs");
    expect(HARNESS_UI_HTML).not.toContain("POST /runs ");
  });

  it("事件面：滚动缓冲 + 未知计数落点 + 默认折叠 delta", () => {
    expect(HARNESS_UI_HTML).toContain("recordEventFrame");
    expect(HARNESS_UI_HTML).toContain("loomEventBrief(");
    expect(HARNESS_UI_HTML).toContain("state.events.unshift");
    expect(HARNESS_UI_HTML).toContain("EVENT_CAP = 400");
    expect(HARNESS_UI_HTML).toContain("隐藏流式增量帧");
    expect(HARNESS_UI_HTML).toContain("eventUnknown");
  });

  it("markdown 单一路径：聊天正文与子转录同走 renderMarkdownInto；用户消息/工具输出保持纯文本", () => {
    expect(HARNESS_UI_HTML).toContain("loomMarkdownRender(document");
    expect(HARNESS_UI_HTML).toContain("renderMarkdownInto(slot.el, part.text)");
    expect(HARNESS_UI_HTML).toContain("renderMarkdownInto(text, String(block.text || ''))");
    expect(HARNESS_UI_HTML).toContain("bubble.textContent = text;");
    expect(HARNESS_UI_HTML).toContain("createTextNode(merged.text.slice(prevLen))");
  });
});

// ─────────── W17-C：上下文三区（发线面 wire / 引用清单 manifest / v1-only 降级） ───────────

/** 冻结 v2 契约样例（与 server 侧约定逐键一致；本测试即契约钉）。 */
const V2_WIRE = {
  capturedAt: 1727000000000,
  turnIdx: 3,
  model: { id: "claude-x", api: "anthropic", provider: "first-party" },
  request: {
    systemPrompt: "BASE-PROMPT\n\n## Available skills\n- foo: desc\n",
    messages: [
      { index: 0, role: "user", byteLength: 5, text: "hello", transient: false },
      { index: 1, role: "user", byteLength: 2, text: "## 提醒", transient: true },
      { index: 2, role: "assistant", byteLength: 2, text: "ok" },
    ],
    tools: [{ name: "bash", description: "run shell", schemaText: "{\"type\":\"object\"}" }],
    params: { temperature: 0.5, apiKey: "REDACTED" },
  },
  providerPayload: '{"model":"claude-x"}\n汉\n\uD83D\uDE00',
  providerPayloadAbsentReason: null,
};

const V2_MANIFEST = {
  memoryFiles: [
    { relPath: "AGENTS.md", bytes: 4096, bootHash: "abcdef1234567890", degrade: null },
    { relPath: "memory/notes.md", bytes: 12, bootHash: "", degrade: "missing" },
  ],
  skillFiles: [{ name: "foo", file: "skills/foo/SKILL.md", degraded: false }],
  mcpServers: [
    { name: "ctx7", cmd: "npx", args: ["-y", "mcp"], cwd: "/srv", ok: true, toolNames: ["a", "b"] },
    { name: "dead", cmd: "bin", args: [], cwd: "", ok: false, toolNames: [] },
  ],
  agentRoleFiles: [
    { name: "explore", file: "roles/explore.md", builtin: true, kind: "sub" },
    { name: "persona", file: ".loom/roles/persona.md", builtin: false, kind: "main" },
  ],
  model: { id: "claude-x", api: "anthropic", baseUrl: "https://api.example.com", apiKeyMasked: "sk-***abcd" },
  configPath: "/etc/kinship-loom/config.yaml",
  workspaceRoot: "/ws",
};

describe("W17-C：发线面纯数据（loomWireMessagesView / loomWirePayloadAbsentView）", () => {
  // W18 退役记录：loomWireSplitPrompt（skill 目录尾段切分）连同其测删除——用户判词
  // 「技能目录不必单独渲染」，systemPrompt 全文（含目录尾段）逐字进板块一，
  // 逐字保真钉由 loomContextPlainView 新测承接（见 W18 段「系统提示词逐字含目录尾段」）。

  it("loomWireMessagesView：五键归一；transient 仅布尔 true 亮徽章；脏帧安全默认值；非数组空表", () => {
    const logic = loadHarnessLogic();
    const rows = logic.loomWireMessagesView(V2_WIRE.request.messages);
    expect(rows).toHaveLength(3);
    expect(rows[1]).toEqual({ index: 1, role: "user", byteLength: 2, text: "## 提醒", transient: true });
    // transient 缺失 → false（不是瞬态，不亮徽章）
    expect(rows[2]!.transient).toBe(false);
    expect(rows[2]!.role).toBe("assistant");
    // byteLength 缺失回退 text.length；role/index 缺失给保守默认
    const dirty = logic.loomWireMessagesView([null, { text: "abc" }, 7]);
    expect(dirty[0]).toEqual({ index: 0, role: "message", byteLength: 0, text: "", transient: false });
    expect(dirty[1]!.byteLength).toBe(3);
    expect(dirty[2]!.role).toBe("message");
    expect(logic.loomWireMessagesView(undefined)).toEqual([]);
    expect(logic.loomWireMessagesView("bad")).toEqual([]);
    // transient 非布尔 true 不误亮（与 loomReasoningState 同纪律）
    expect(logic.loomWireMessagesView([{ transient: "yes" }])[0]!.transient).toBe(false);
  });

  it("loomWirePayloadAbsentView：string→present+UTF-8 字节数；null→absentReason 逐字；wire 缺失→双否", () => {
    const logic = loadHarnessLogic();
    const present = logic.loomWirePayloadAbsentView(V2_WIRE);
    expect(present.hasWire).toBe(true);
    expect(present.present).toBe(true);
    expect(present.text).toBe(V2_WIRE.providerPayload);
    // 逐字符 UTF-8 扫描：20 ASCII + \n = 21B，汉字 3B + \n 1B，代理对（\ud83d\ude00）4B → 合计 29B
    expect(present.bytes).toBe(29);
    expect(present.capturedAt).toBe(1727000000000);
    const absent = logic.loomWirePayloadAbsentView({
      capturedAt: 1,
      providerPayload: null,
      providerPayloadAbsentReason: "provider 未回传序列化体：流式分片",
    });
    expect(absent.present).toBe(false);
    expect(absent.reason).toBe("provider 未回传序列化体：流式分片");
    expect(logic.loomWirePayloadAbsentView(null).hasWire).toBe(false);
    expect(logic.loomWirePayloadAbsentView(undefined).present).toBe(false);
    // payload 与 reason 双 null → present false reason ''（渲染层诚实兜底）
    const both = logic.loomWirePayloadAbsentView({ providerPayload: null, providerPayloadAbsentReason: null });
    expect(both.present).toBe(false);
    expect(both.reason).toBe("");
  });
});

describe("W17-C：引用清单纯数据（loomManifestGroup）", () => {
  it("冻结 v2 manifest 键归一：五组固定序 / 降级与徽标 / 脱敏模型与两路径", () => {
    const logic = loadHarnessLogic();
    const g = logic.loomManifestGroup(V2_MANIFEST);
    expect(g.ok).toBe(true);
    expect(g.groups.map((x) => x.key)).toEqual([
      "memoryFiles",
      "skillFiles",
      "mcpServers",
      "agentRoleFiles",
      "runtime",
    ]);
    expect(g.counts).toEqual({ memoryFiles: 2, skillFiles: 1, mcpServers: 2, agentRoleFiles: 2 });
    const mem = g.groups[0]!.rows;
    // W18：detail 副行字段随树卡下线剥离（清单只剩纯文本行），行形状钉同步收缩
    expect(mem[0]).toEqual({
      label: "AGENTS.md",
      source: "AGENTS.md",
      bytes: 4096,
      degraded: null,
      mark: "boot abcdef123456",
      badge: null,
    });
    expect(mem[1]!.degraded).toBe("missing");
    const skills = g.groups[1]!.rows;
    expect(skills[0]!.label).toBe("foo");
    expect(skills[0]!.source).toBe("skills/foo/SKILL.md");
    expect(skills[0]!.degraded).toBeNull();
    const mcp = g.groups[2]!.rows;
    expect(mcp[0]!.badge).toEqual({ text: "在线", tone: "on" });
    expect(mcp[0]!.source).toBe("npx -y mcp");
    // W18：detail 副行下线 → 引用清单行口径 = name·cmd·ok·工具数（toolCount 供纯文本行）
    expect(mcp[0]!.toolCount).toBe(2);
    expect(mcp[1]!.badge).toEqual({ text: "未启动", tone: "off" });
    const roles = g.groups[3]!.rows;
    expect(roles[0]!.mark).toBe("内置");
    expect(roles[1]!.mark).toBe("自定义");
    // W18 用户判词：kind 主/子徽章 pill 下线 → 原值 kind 文本直出（badge 位仅 mcp 组保留为词源）
    expect(roles[0]!.kind).toBe("sub");
    expect(roles[1]!.kind).toBe("main");
    expect(roles[0]!.badge).toBeNull();
    expect(roles[1]!.badge).toBeNull();
    expect(g.model).toEqual({
      id: "claude-x",
      api: "anthropic",
      baseUrl: "https://api.example.com",
      apiKeyMasked: "sk-***abcd",
    });
    expect(g.configPath).toBe("/etc/kinship-loom/config.yaml");
    expect(g.workspaceRoot).toBe("/ws");
    const rt = g.groups[4]!.rows.map((r) => r.label);
    expect(rt).toEqual(["model", "configPath", "workspaceRoot"]);
    expect(g.groups[4]!.rows[0]!.source).toContain("sk-***abcd"); // 只呈现脱敏 key
  });

  it("分组如实缺席：缺键空组不伪造；manifest 缺失/坏形 ok=false；脏条目安全归一", () => {
    const logic = loadHarnessLogic();
    const partial = logic.loomManifestGroup({ memoryFiles: [{ relPath: "A.md" }] });
    expect(partial.ok).toBe(true);
    expect(partial.groups.map((x) => x.key)).toEqual([
      "memoryFiles",
      "skillFiles",
      "mcpServers",
      "agentRoleFiles",
      "runtime",
    ]);
    expect(partial.groups[1]!.rows).toEqual([]);
    expect(partial.groups[0]!.rows[0]!.bytes).toBeNull(); // 缺 bytes 不伪造
    expect(partial.groups[0]!.rows[0]!.mark).toBeNull(); // 缺 bootHash 不伪造
    expect(partial.model).toBeNull();
    expect(partial.configPath).toBe("");
    expect(logic.loomManifestGroup(null).ok).toBe(false);
    expect(logic.loomManifestGroup("bad").ok).toBe(false);
    const dirty = logic.loomManifestGroup({ memoryFiles: [null, 7], mcpServers: [{ name: "x", ok: "yes" }] });
    expect(dirty.groups[0]!.rows[0]!.label).toBe("memoryFiles[0]");
    expect(dirty.groups[2]!.rows[0]!.badge).toEqual({ text: "状态缺失", tone: "dim" });
  });
});

describe("W17-C：三区页面契约与降级钉（字符串锁，与既有 35 测同纪律）", () => {
  it("冻结 v2 键名逐字在场（wire/request/manifest 全链）", () => {
    for (const key of [
      "capturedAt", "turnIdx", "systemPrompt", "transient", "schemaText",
      "providerPayload", "providerPayloadAbsentReason",
      "memoryFiles", "skillFiles", "mcpServers", "agentRoleFiles",
      "relPath", "bootHash", "degrade", "toolNames", "builtin",
      "apiKeyMasked", "configPath", "workspaceRoot",
    ]) {
      expect(HARNESS_UI_HTML, `缺 v2 契约键 ${key}`).toContain(key);
    }
  });

  it("模块板块 DOM id 在场；wire:null 与 v1-only 降级文案逐字钉死（W18 重排）", () => {
    // W18：wire/manifest 三区容器（ctxZoneWire*/ctxZoneManifest*/ctxManifestGroups/Meta/Notice
    // 与 wire 徽章位）随树卡下线；provider 载荷惰性抽屉 ids 原样保留（仍 lazy-details）。
    for (const id of [
      "ctxPayload", "ctxPayloadHint", "ctxPayloadBody", "ctxPayloadCopy", "ctxPayloadAbsent",
      "ctxModParams", "ctxModManifest", "ctxV1Compat", "ctxModMemoryBody", "ctxModManifestBody",
    ]) {
      expect(HARNESS_UI_HTML, `缺 DOM id ${id}`).toContain(`id="${id}"`);
    }
    // wire:null → 诚实提示（重启即清，非错误；W18 并入单条 compat 纯文本）
    expect(HARNESS_UI_HTML).toContain("来源=装配快照非发线：尚无发线捕获（重启即清，首个 LLM 调用后可见）");
    // v1-only（旧服务端）→ 单条纯文本 compat 提示（原折叠长说明随结构展览下线）
    expect(HARNESS_UI_HTML).toContain("服务端未提供 wire/manifest 两键（v1-only）");
    expect(HARNESS_UI_HTML).toContain("'wire' in v");
    expect(HARNESS_UI_HTML).toContain("'manifest' in v");
    // transient 徽章 pill 下线 → 文本尾注逐字（板块一头行后缀）
    expect(HARNESS_UI_HTML).toContain("[瞬态附件]");
    expect(HARNESS_UI_HTML).not.toContain("瞬态附件·不入转录");
    // skill 目录不再切分高亮（loomWireSplitPrompt 退役）：全文逐字含尾段由 W18 数据钉承接
    expect(HARNESS_UI_HTML).not.toContain("wire-skillmark");
    // 板块一三头部逐字（发送顺序的排版契约）
    expect(HARNESS_UI_HTML).toContain("══ 系统提示词");
    expect(HARNESS_UI_HTML).toContain("══ 工具定义 ══");
    expect(HARNESS_UI_HTML).toContain("══ 对话消息（共");
  });

  it("载荷抽屉惰性：静态骨架体内零节点，仅首次 toggle 展开才注入全文", () => {
    // 初始 DOM 里抽屉体必须是空 div（未开即零节点，全文不进 DOM）
    expect(HARNESS_UI_HTML).toContain(`<div class="ctx-raw-body" id="ctxPayloadBody"></div>`);
    expect(HARNESS_UI_HTML).toContain("function lazyFillDetails");
    expect(HARNESS_UI_HTML).toContain("addEventListener('toggle'");
    expect(HARNESS_UI_HTML).toContain("card.dataset.filled");
    // 抽屉默认折叠（无 open 属性）+ 复制全文 + 字节数与捕获时刻
    expect(HARNESS_UI_HTML).toContain('id="ctxPayload" hidden');
    expect(HARNESS_UI_HTML).toContain("复制全文");
  });

  it("模块渲染接线：v2 入口挂 v1 之后；复位入 hide 路径（W18 纯文本面）", () => {
    expect(HARNESS_UI_HTML).toContain("function renderContextV2Zones(");
    expect(HARNESS_UI_HTML).toContain("renderContextV2Zones(view);");
    expect(HARNESS_UI_HTML).toContain("function hideContextZones(");
    expect(HARNESS_UI_HTML).toContain("function hideWireModules(");
    expect(HARNESS_UI_HTML).toContain("function renderSegmentModules(");
    // 原 renderWireZone/renderManifestZone/manifestRowEl/wire 树卡函数与 loomWireSplitPrompt、
    // renderRawDrawer 随用户判词下线（纯文本装配替代），反向钉防回潮：
    for (const gone of ["function renderWireZone(", "function renderManifestZone(",
      "function manifestRowEl(", "function wirePromptCard(", "function wireMessageCard(",
      "function contextPieceRow(", "function contextRowEl(", "function renderRawDrawer(",
      "loomWireSplitPrompt(", "复制本条", "复制 schema", "复制参数"]) {
      expect(HARNESS_UI_HTML, `W18 退役函数/按钮复现：${gone}`).not.toContain(gone);
    }
    expect(HARNESS_UI_HTML).toContain("loomWireMessagesView(");
    expect(HARNESS_UI_HTML).toContain("loomManifestGroup(");
    expect(HARNESS_UI_HTML).toContain("loomCtxMemoryPlain(");
    expect(HARNESS_UI_HTML).toContain("loomCtxManifestPlain(");
    expect(HARNESS_UI_HTML).toContain("loomCtxParamsPlain(");
    expect(HARNESS_UI_HTML).toContain("loomWirePayloadAbsentView(");
    // v1 装配面入口不动（用量顶线仍由 loomContextFullView 驱动）
    expect(HARNESS_UI_HTML).toContain("loomContextFullView(view)");
    expect(HARNESS_UI_HTML).toContain("loomContextPlainView(view)");
  });

  it("纪律锁复查：innerHTML 仍恰 1 处 / 无外链 / 无 emoji（三区新码全 createElement-textContent）", () => {
    const assigns = HARNESS_UI_HTML.match(/\.innerHTML\s*=/g) ?? [];
    expect(assigns).toHaveLength(1);
    expect(/(src|href)="https?:/.test(HARNESS_UI_HTML)).toBe(false);
    expect(/\p{Extended_Pictographic}/u.test(HARNESS_UI_HTML)).toBe(false);
  });
});

// ─────────────────── W17-F：context.notice 增量时间线 / 自动刷新 / kind 徽章 ───────────────────

/** 造一帧 context.notice（与 hub eventPayload 同信封形；seq 字段时间线不消费）。 */
function noticeFrame(
  notices: unknown,
  turnIdx?: number,
): { seq: number; payload: { type: string; properties: Record<string, unknown> } } {
  const properties: Record<string, unknown> = { sessionID: "ses_w17f", notices };
  if (turnIdx !== undefined) properties.turnIdx = turnIdx;
  return { seq: 1, payload: { type: "context.notice", properties } };
}

describe("W17-F：增量时间线纯函数（loomNoticeTimelinePush / loomNoticeActionMeta）", () => {
  it("帧→条目归一：多 notice 帧声明序在头部、同帧同 at；bytes/turnIdx 只收数字", () => {
    const logic = loadHarnessLogic();
    const ring = logic.loomNoticeTimelinePush(
      [],
      noticeFrame(
        [
          { action: "set", relPath: "memory/README.md", bytes: 12 },
          { action: "replace", relPath: "AGENTS.md", bytes: 19425 },
        ],
        7,
      ),
    );
    expect(ring).toHaveLength(2);
    expect(ring[0]!.action).toBe("set");
    expect(ring[0]!.relPath).toBe("memory/README.md");
    expect(ring[0]!.bytes).toBe(12);
    expect(ring[0]!.turnIdx).toBe(7);
    expect(ring[1]!.relPath).toBe("AGENTS.md");
    expect(ring[1]!.bytes).toBe(19425);
    expect(typeof ring[0]!.at).toBe("number");
    expect(ring[0]!.at).toBe(ring[1]!.at); // 同帧条目同一时刻
  });

  it("新帧在前（跨帧环形序）+ 上限 100 从尾溢出（丢最旧）", () => {
    const logic = loadHarnessLogic();
    let ring = logic.loomNoticeTimelinePush([], noticeFrame([{ action: "set", relPath: "a.md", bytes: 1 }]));
    ring = logic.loomNoticeTimelinePush(ring, noticeFrame([{ action: "remove", relPath: "b.md", bytes: 0 }]));
    expect(ring.map((r) => r.relPath)).toEqual(["b.md", "a.md"]);
    for (let i = 0; i < 150; i++) {
      ring = logic.loomNoticeTimelinePush(ring, noticeFrame([{ action: "replace", relPath: "r" + i, bytes: i }]));
    }
    expect(ring).toHaveLength(100);
    expect(ring[0]!.relPath).toBe("r149"); // 最新在前
    expect(ring[99]!.relPath).toBe("r50"); // 最旧 52 条（含 a/b）已按环形淘汰
  });

  it("脏输入安全归一：非本型帧/坏 notices 跳过不抛；缺键 null 不伪造；旧环不被 mutate", () => {
    const logic = loadHarnessLogic();
    expect(logic.loomNoticeTimelinePush([], undefined)).toEqual([]);
    expect(logic.loomNoticeTimelinePush([], null)).toEqual([]);
    expect(logic.loomNoticeTimelinePush([], { seq: 1, payload: { type: "session.idle", properties: {} } })).toEqual([]);
    expect(
      logic.loomNoticeTimelinePush([], { seq: 1, payload: { type: "context.notice", properties: { notices: "bad" } } }),
    ).toEqual([]);
    expect(logic.loomNoticeTimelinePush([], noticeFrame([null, 7, { action: "", relPath: "" }]))).toEqual([]);
    const partial = logic.loomNoticeTimelinePush([], noticeFrame([{ action: "set", relPath: "c.md" }]));
    expect(partial[0]!.bytes).toBeNull(); // 缺 bytes 不伪造
    expect(partial[0]!.turnIdx).toBeNull();
    const dirty = logic.loomNoticeTimelinePush([], {
      seq: 1,
      payload: {
        type: "context.notice",
        properties: { notices: [{ action: "set", relPath: "d.md", bytes: "12" }], turnIdx: "seven" },
      },
    });
    expect(dirty[0]!.bytes).toBeNull(); // 非数字 bytes/turnIdx = null（渲染层出破折号）
    expect(dirty[0]!.turnIdx).toBeNull();
    const first = logic.loomNoticeTimelinePush([], noticeFrame([{ action: "set", relPath: "x.md", bytes: 1 }]));
    const second = logic.loomNoticeTimelinePush(first, noticeFrame([{ action: "set", relPath: "y.md", bytes: 2 }]));
    expect(first).toHaveLength(1); // 纯函数：传入环拷贝，不 mutate
    expect(second).toHaveLength(2);
  });

  it("action→中文徽章词表（set 新增 / replace 更新 / remove 移除；未知原样呈现不塌）", () => {
    const logic = loadHarnessLogic();
    expect(logic.loomNoticeActionMeta("set")).toEqual({ label: "新增", tone: "on" });
    expect(logic.loomNoticeActionMeta("replace")).toEqual({ label: "更新", tone: "dim" });
    expect(logic.loomNoticeActionMeta("remove")).toEqual({ label: "移除", tone: "off" });
    expect(logic.loomNoticeActionMeta("weird")).toEqual({ label: "weird", tone: "dim" });
    expect(logic.loomNoticeActionMeta(undefined).label).toBe("");
  });
});

describe("W17-F：面板接线面（时间线 DOM / 自动刷新触发集 / 整面重绘 / kind pill）", () => {
  it("时间线 DOM 面在场：#ctxNoticeTimeline 静态零节点 + 区头/徽标 + 重绘函数", () => {
    for (const id of ["ctxNoticeTimeline", "ctxTimelineHead", "ctxTimelineBadge"]) {
      expect(HARNESS_UI_HTML, `缺 DOM id ${id}`).toContain(`id="${id}"`);
    }
    expect(HARNESS_UI_HTML).toContain('id="ctxNoticeTimeline" hidden');
    expect(HARNESS_UI_HTML).toContain("function renderContextTimeline(");
    expect(HARNESS_UI_HTML).toContain("ctx-tl-row");
    expect(HARNESS_UI_HTML).toContain("renderContextTimeline();");
  });

  it("自动刷新触发集：session.idle（既有）/ context.notice / run.status 终态分支都挂 loadContext", () => {
    const branchOf = (caseName: string): string => {
      const start = HARNESS_UI_HTML.indexOf(`case '${caseName}':`);
      expect(start, `缺 ${caseName} 分支`).toBeGreaterThanOrEqual(0);
      const end = HARNESS_UI_HTML.indexOf("break;", start);
      expect(end).toBeGreaterThan(start);
      return HARNESS_UI_HTML.slice(start, end);
    };
    expect(branchOf("session.idle")).toContain("loadContext();");
    const noticeBranch = branchOf("context.notice");
    expect(noticeBranch).toContain("loomNoticeTimelinePush(state.ctxNotices, frame)");
    expect(noticeBranch).toContain("renderContextTimeline();");
    expect(noticeBranch).toContain("loadContext();");
    const runBranch = branchOf("run.status");
    expect(runBranch).toContain("props.terminal === true");
    expect(runBranch).toContain("loadContext();");
  });

  it("②b 每次刷新整面重绘：state.contextFull 全量替换 + 板块/模块全量复位（wire/消息无残影）", () => {
    // W18：三区 replaceChildren → 板块一 textContent 全量覆写 + 模块先复位（hideWireModules）
    // 再按面填充；旧容器钉随容器退役同步换面。
    expect(HARNESS_UI_HTML).toContain("state.contextFull = view;");
    expect(HARNESS_UI_HTML).toContain("els.ctxTree.replaceChildren();");
    expect(HARNESS_UI_HTML).toContain("els.ctxPlain.textContent = plain.text;");
    expect(HARNESS_UI_HTML).toContain("els.ctxPlain.textContent = '';");
    expect(HARNESS_UI_HTML).toContain("hideWireModules();");
    expect(HARNESS_UI_HTML).toContain("els.ctxModManifestBody.textContent = mtext;");
  });

  it("kind 文本直出（pill 下线）+ 时间线纯文本一行 + 点击 = 刷新（不展开内容）", () => {
    expect(HARNESS_UI_HTML).toContain("loomWireStr(r.kind)");
    expect(HARNESS_UI_HTML).toContain("roleKind === 'main'");
    expect(HARNESS_UI_HTML).toContain("roleKind === 'sub'");
    // W18 用户判词：wire-pill 徽章面全下线（kind 清单行文本 + 时间线条目一行 textContent）
    expect(HARNESS_UI_HTML).not.toContain("wire-pill");
    expect(HARNESS_UI_HTML).not.toContain("wire-transient");
    expect(HARNESS_UI_HTML).toContain("'kind=' + r.kind");
    expect(HARNESS_UI_HTML).toContain("row.textContent = line;"); // 时间线条目 = 纯文本一行
    // 条目点击只触发刷新（帧无正文、无展开态）
    expect(HARNESS_UI_HTML).toContain("row.addEventListener('click', function () { loadContext(); });");
    // 会话切换清空本世时间线（帧归属当前订阅流，跨会话不残留）
    expect(HARNESS_UI_HTML).toContain("state.ctxNotices = [];");
  });

  it("纪律锁复查（时间线/徽章新码）：innerHTML 恰 1 / 无外链 / 无 emoji", () => {
    const assigns = HARNESS_UI_HTML.match(/\.innerHTML\s*=/g) ?? [];
    expect(assigns).toHaveLength(1);
    expect(/(src|href)="https?:/.test(HARNESS_UI_HTML)).toBe(false);
    expect(/\p{Extended_Pictographic}/u.test(HARNESS_UI_HTML)).toBe(false);
    expect(/\p{Extended_Pictographic}/u.test(HARNESS_UI_LOGIC_JS)).toBe(false);
  });
});

// ───────────────── W18：上下文纯文本重排（按发送顺序一块全文 + 模块纯文本） ─────────────────

/** pi-ai Message 的 canonical JSON 条目（键字典序；板块一可读渲染的输入面）。 */
const W18_ASSISTANT = JSON.stringify({
  content: [
    { type: "thinking", thinking: "先想想" },
    { type: "text", text: "正文在此" },
    { arguments: { cmd: "ls -al" }, id: "tc1", name: "bash", type: "toolCall" },
  ],
  role: "assistant",
  stopReason: "toolUse",
});
const W18_TOOL_RESULT = JSON.stringify({
  content: [{ text: "OUT-PUT", type: "text" }],
  isError: true,
  role: "toolResult",
  toolCallId: "tc1",
});
const W18_USER = JSON.stringify({ content: [{ text: "你好", type: "text" }], role: "user", timestamp: 1 });
const W18_VIEW = {
  sessionID: "ses_w18",
  capturedAt: 1727000001000,
  basis: "live",
  prefixHash: "ph",
  systemPromptSha256: "sh",
  systemPrompt: "V1-SYS",
  prefixByteLength: 6,
  segments: [
    { index: 0, label: "system", offset: 0, byteLength: 2, text: "SY" },
    { index: 1, label: "memory", offset: 3, byteLength: 40, text: "### memory[0] AGENTS.md\nAAA\n### memory[1] memory/notes.md\nBBB\n" },
    { index: 2, label: "workflow", offset: 44, byteLength: 2, text: "WF" },
  ],
  messages: [{ index: 0, role: "user", offset: 7, byteLength: 2, text: "hi" }],
  messagesByteLength: 2,
  totalPromptByteLength: 9,
  contextWindow: 200000,
  transientExcluded: true,
  note: "n",
  wire: {
    capturedAt: 1727000000000,
    turnIdx: 5,
    model: { id: "claude-x", api: "anthropic", provider: "first-party" },
    request: {
      systemPrompt: "WIRE-SYS\n\n## Available skills\n- foo: desc",
      messages: [
        { index: 0, role: "user", byteLength: 20, text: W18_USER, transient: false },
        { index: 1, role: "assistant", byteLength: 60, text: W18_ASSISTANT, transient: false },
        { index: 2, role: "toolResult", byteLength: 40, text: W18_TOOL_RESULT, transient: false },
        { index: 3, role: "user", byteLength: 2, text: "## 提醒（非JSON）", transient: true },
      ],
      tools: [{ name: "bash", description: "run shell", schemaText: "{\"type\":\"object\"}" }],
      params: { apiKey: "***", temperature: 0.5 },
    },
    providerPayload: null,
    providerPayloadAbsentReason: "当前模型通道不触发 provider onPayload（如 fake api）",
  },
  manifest: V2_MANIFEST,
};

describe("W18：板块一「完整上下文（按发送顺序）」纯文本装配（loomContextPlainView / loomCtxReadableBody）", () => {
  it("块顺序逐字：系统提示词（post-pipe 全文含 skill 目录尾段）→ 工具定义 → 对话消息", () => {
    const logic = loadHarnessLogic();
    const p = logic.loomContextPlainView(W18_VIEW);
    expect(p.ok).toBe(true);
    expect(p.fromWire).toBe(true);
    expect(p.note).toContain("turn #5");
    expect(p.note).toContain("claude-x");
    const iSys = p.text.indexOf("══ 系统提示词（post-pipe 全文） ══");
    const iTools = p.text.indexOf("══ 工具定义 ══");
    const iMsgs = p.text.indexOf("══ 对话消息（共4条） ══");
    expect(iSys).toBe(0);
    expect(iSys).toBeLessThan(iTools);
    expect(iTools).toBeLessThan(iMsgs);
    // systemPrompt 逐字（含目录尾段——不再切分高亮，一个字都不能少）
    expect(p.text).toContain("WIRE-SYS\n\n## Available skills\n- foo: desc");
    // 工具条目文本形：▸ name / 描述: / 参数:（schema 逐字）
    expect(p.text).toContain("▸ bash\n描述: run shell\n参数: {\"type\":\"object\"}");
  });

  it("消息可读体：thinking/text/toolCall/toolResult 全渲染；瞬态头行 [瞬态附件] 尾注；非瞬态无后缀", () => {
    const logic = loadHarnessLogic();
    const p = logic.loomContextPlainView(W18_VIEW);
    expect(p.text).toContain("[0] user · 20 B · —");
    expect(p.text).toContain("【正文】你好");
    expect(p.text).toContain("【思考】先想想");
    expect(p.text).toContain("【正文】正文在此");
    expect(p.text).toContain('【调用】bash({"cmd":"ls -al"})');
    expect(p.text).toContain("【结果·isError】OUT-PUT");
    expect(p.text).toContain("[3] user · 2 B · — [瞬态附件]");
    expect(p.text).not.toContain("[0] user · 20 B · — [瞬态附件]");
    // pill 徽章面下线后「瞬态附件·不入转录」字样全页绝迹
    expect(HARNESS_UI_HTML).not.toContain("瞬态附件·不入转录");
  });

  it("解析失败逐字回退原文（绝不吞字节）；正文串形/未知块兜底", () => {
    const logic = loadHarnessLogic();
    const broken = "{role:坏JSON~~";
    expect(logic.loomCtxReadableBody(broken)).toBe(broken);
    expect(logic.loomCtxReadableBody("[1,2]")).toBe("[1,2]"); // 数组非消息形 → 原文
    expect(logic.loomCtxReadableBody(42)).toBe(""); // 非字符串入参 → 空串（渲染层给 ""）
    const p = logic.loomContextPlainView(W18_VIEW);
    expect(p.text).toContain("[3] user"); // 瞬态条目 text 非 JSON → 逐字在板块一
    expect(p.text).toContain("## 提醒（非JSON）");
  });

  it("wire 缺席/null → v1 装配快照走同一装配器；note 明写 来源=装配快照非发线；v1 消息头带 offset", () => {
    const logic = loadHarnessLogic();
    const v1Only: Record<string, unknown> = { ...W18_VIEW };
    delete v1Only.wire;
    const p = logic.loomContextPlainView(v1Only);
    expect(p.ok).toBe(true);
    expect(p.fromWire).toBe(false);
    expect(p.note).toContain("来源=装配快照非发线");
    expect(p.text).toContain("══ 系统提示词（装配前缀全文） ══");
    expect(p.text).toContain("V1-SYS");
    expect(p.text).toContain("[0] user · 2 B · 7"); // v1 offset 在场
    expect(p.text).toContain("（未捕获：v1 装配快照无 wire 面）");
    const wireNull = logic.loomContextPlainView({ ...W18_VIEW, wire: null });
    expect(wireNull.fromWire).toBe(false);
    expect(wireNull.note).toContain("来源=装配快照非发线");
    expect(logic.loomContextPlainView(null).ok).toBe(false);
    expect(logic.loomContextPlainView({ systemPrompt: "", messages: [] }).ok).toBe(false); // 空面 ok=false 不硬编
  });
});

describe("W18：模块纯文本（记忆逐文件 / 引用清单行 / 参数）", () => {
  it("记忆模块：v1 memory 段按 ### memory[i] 拆小节，path+bytes+bootHash+降级关联 manifest.memoryFiles", () => {
    const logic = loadHarnessLogic();
    const mem = logic.loomCtxMemoryPlain(W18_VIEW);
    expect(mem).toContain("### memory[0] AGENTS.md · 4096 B · boot abcdef123456");
    expect(mem).toContain("### memory[1] memory/notes.md · 12 B · 降级:missing");
    expect(mem).toContain("AAA");
    expect(mem).toContain("BBB");
    // 清单缺席：小节照拆、只无字节标注（诚实，不伪造）
    const noManifest = logic.loomCtxMemoryPlain({ segments: W18_VIEW.segments });
    expect(noManifest).toContain("### memory[0] AGENTS.md\nAAA");
    expect(noManifest).not.toContain("4096 B");
    // 段缺席 → 空串（渲染层隐藏模块）
    expect(logic.loomCtxMemoryPlain({ segments: [] })).toBe("");
    // 无标题命中 → 段全文直通（一字不裁）
    expect(logic.loomCtxMemoryPlain({ segments: [{ label: "memory", text: "无标题正文" }] })).toBe("无标题正文");
  });

  it("引用清单：纯文本行五组固定序；memory(relPath·bytes·boot前缀·降级) / skill / mcp(name·cmd·ok·工具数) / agents kind=原值 / 运行(模型·api·baseUrl·两路径)", () => {
    const logic = loadHarnessLogic();
    const m = logic.loomCtxManifestPlain(W18_VIEW.manifest);
    const order = ["── 记忆文件", "── 技能文件", "── MCP 服务", "── 角色定义", "── 运行装配"];
    const idxs = order.map((x) => m.indexOf(x));
    idxs.forEach((v, k) => expect(v, `清单组序 ${order[k]}`).toBeGreaterThanOrEqual(0));
    for (let k = 1; k < idxs.length; k++) expect(idxs[k]!).toBeGreaterThan(idxs[k - 1]!);
    expect(m).toContain("AGENTS.md · 4096 B · boot abcdef123456");
    expect(m).toContain("memory/notes.md · 12 B · 降级:missing");
    expect(m).toContain("foo · skills/foo/SKILL.md");
    expect(m).toContain("ctx7 · npx -y mcp · 在线 · 工具 2 · cwd /srv");
    expect(m).toContain("dead · bin · 未启动 · 工具 0");
    expect(m).toContain("explore · roles/explore.md · kind=sub · 内置");
    expect(m).toContain("persona · .loom/roles/persona.md · kind=main · 自定义");
    expect(m).toContain("model · claude-x · anthropic · https://api.example.com · key=sk-***abcd · 脱敏");
    expect(m).toContain("configPath · /etc/kinship-loom/config.yaml");
    expect(m).toContain("workspaceRoot · /ws");
    expect(m).not.toContain("wire-pill");
    expect(logic.loomCtxManifestPlain(null)).toBe("");
  });

  it("参数模块：脱敏 JSON 美化；null/undefined → {}；不可序列化诚实标注不抛", () => {
    const logic = loadHarnessLogic();
    expect(logic.loomCtxParamsPlain({ temperature: 0.5 })).toBe('{\n  "temperature": 0.5\n}');
    expect(logic.loomCtxParamsPlain(null)).toBe("{}");
    const cyc: Record<string, unknown> = { a: 1 };
    cyc["self"] = cyc;
    expect(logic.loomCtxParamsPlain(cyc)).toContain("不可序列化");
  });
});

describe("W18：纯文本面纪律钉（复制路径零出现 / ctx-plain 只 textContent / innerHTML 恰 1 / 无 CDN / 无 emoji）", () => {
  it("复制路径按钮全下线：HTML 与页面 JS 两处字符串零出现（用户判词，逐字符钉）", () => {
    expect((HARNESS_UI_HTML.match(/复制路径/g) ?? []).length).toBe(0);
    expect((HARNESS_UI_LOGIC_JS.match(/复制路径/g) ?? []).length).toBe(0);
    // 路径复制的载体面（只读 input 全选）同步绝迹
    expect(HARNESS_UI_HTML).not.toContain("ctx-path");
    expect(HARNESS_UI_HTML).not.toContain("点击全选路径");
    // 复制全文（板块一/provider 载荷）仍合法在场 = 唯一保留的复制面
    expect(HARNESS_UI_HTML).toContain("复制全文");
    expect(HARNESS_UI_HTML).toContain("legacyCopyText");
  });

  it("ctx-plain 只用 textContent（无第二 innerHTML 站点）；徽章 pill / skill 高亮 / 树类名全绝迹", () => {
    expect(HARNESS_UI_HTML).not.toContain("ctxPlain.innerHTML");
    expect(HARNESS_UI_HTML.match(/\.innerHTML\s*=/g) ?? []).toHaveLength(1);
    expect(HARNESS_UI_HTML).not.toContain("ctx-row");
    expect(HARNESS_UI_HTML).not.toContain("wire-block");
    expect(HARNESS_UI_HTML).not.toContain("wire-skillmark");
    expect(HARNESS_UI_HTML).not.toContain("wire-pill");
    expect(HARNESS_UI_HTML).not.toContain("wire-transient");
  });

  it("离线闭环与无 emoji 复查（新纯文本面未引外链/字体/图标）", () => {
    expect(/(src|href)="https?:/.test(HARNESS_UI_HTML)).toBe(false);
    expect(/\p{Extended_Pictographic}/u.test(HARNESS_UI_HTML)).toBe(false);
    expect(/\p{Extended_Pictographic}/u.test(HARNESS_UI_LOGIC_JS)).toBe(false);
  });
});

// ───────────── W24：会话列表三件套 / /tasks 历史合流 / live-cache 真相（消费面） ─────────────

describe("W24：会话列表消费面（标题回落 / 归档过滤 / 切片 / 请求规格）", () => {
  it("loomSessionRowView：无题回落 sid；hasTitle 只认非空串；archived 严格 true；脏输入不塌", () => {
    const logic = loadHarnessLogic();
    expect(logic.loomSessionRowView({ sessionID: "ses_a", status: "idle", createdAt: 5, archived: false })).toEqual({
      id: "ses_a",
      status: "idle",
      title: "ses_a",
      hasTitle: false,
      archived: false,
      createdAt: 5,
    });
    const titled = logic.loomSessionRowView({ sessionID: "ses_a", title: "重构登录页", createdAt: 9, archived: true });
    expect(titled.title).toBe("重构登录页");
    expect(titled.hasTitle).toBe(true);
    expect(titled.archived).toBe(true);
    expect(logic.loomSessionRowView({ sessionID: "s", title: "   " }).hasTitle).toBe(false); // 全空格=无题（trim 真源在服务端）
    expect(logic.loomSessionRowView({ sessionID: "s", archived: "yes" }).archived).toBe(false); // 脏值不当归档（transient 同纪律）
    expect(logic.loomSessionRowView(null).id).toBe("");
    expect(logic.loomSessionRowView("bad").title).toBe("");
  });

  it("loomVisibleSessions：默认隐藏归档行；切换态只留归档行；绝不重排序（createdAt 倒序=服务端视图真源）", () => {
    const logic = loadHarnessLogic();
    const rows = [
      { sessionID: "c", createdAt: 300, archived: false },
      { sessionID: "a", createdAt: 200, archived: true },
      { sessionID: "b", createdAt: 100, archived: false },
    ];
    expect(logic.loomVisibleSessions(rows, false).map((r) => r["sessionID"])).toEqual(["c", "b"]);
    expect(logic.loomVisibleSessions(rows, true).map((r) => r["sessionID"])).toEqual(["a"]);
    // 过滤只删行不动序：输入乱序原样出（客户端重排=违规，W23-B 视图真源纪律）
    expect(
      logic
        .loomVisibleSessions(
          [
            { sessionID: "z", archived: false },
            { sessionID: "y", archived: false },
            { sessionID: "x", archived: false },
          ],
          false,
        )
        .map((r) => r["sessionID"]),
    ).toEqual(["z", "y", "x"]);
    expect(logic.loomVisibleSessions("bad", false)).toEqual([]);
    expect(logic.loomVisibleSessions([null, 7], false)).toEqual([]);
  });

  it("请求规格（页面 fetch 的 URL/method/body 同源）：title/archive/unarchive/列表查询路径", () => {
    const logic = loadHarnessLogic();
    expect(logic.loomSessionListPath(false)).toBe("/sessions");
    expect(logic.loomSessionListPath(true)).toBe("/sessions?archived=1");
    expect(logic.loomTitleRequest("ses_a", "新标题")).toEqual({
      path: "/sessions/ses_a/title",
      method: "POST",
      body: '{"title":"新标题"}',
    });
    expect(logic.loomTitleRequest("ses_a", "").body).toBe('{"title":""}'); // 空串=清除声明（服务端删键回落 sid）
    expect(logic.loomTitleRequest("ses/x", "新标题").path).toBe("/sessions/ses%2Fx/title"); // encodeURIComponent 走位
    expect(logic.loomArchiveRequest("ses_a", true)).toEqual({ path: "/sessions/ses_a/archive", method: "POST", body: "{}" });
    expect(logic.loomArchiveRequest("ses_a", false).path).toBe("/sessions/ses_a/unarchive");
  });

  it("loomListSlice：切片 + 剩余计数（「加载更多」的数据面；长列表不卡）", () => {
    const logic = loadHarnessLogic();
    const rows = [1, 2, 3, 4, 5];
    expect(logic.loomListSlice(rows, 3)).toEqual({ rows: [1, 2, 3], hidden: 2 });
    expect(logic.loomListSlice(rows, 10)).toEqual({ rows: [1, 2, 3, 4, 5], hidden: 0 });
    expect(logic.loomListSlice("bad", 3)).toEqual({ rows: [], hidden: 0 });
    expect(logic.loomListSlice(rows, 0)).toEqual({ rows: [1, 2, 3, 4, 5], hidden: 0 }); // shown<=0=不切片，绝不丢行
  });

  it("接线面：行内改名/归档走 pull-only 重拉；归档切换钮激活态；零新增 SSE 订阅面", () => {
    expect(HARNESS_UI_HTML).toContain('id="archivedToggle"');
    expect(HARNESS_UI_HTML).toContain("state.showArchived = !state.showArchived;");
    expect(HARNESS_UI_HTML).toContain("request(loomSessionListPath(state.showArchived))");
    expect(HARNESS_UI_HTML).toContain("function startSessionRename(");
    expect(HARNESS_UI_HTML).toContain("el('input', 'session-rename')");
    expect(HARNESS_UI_HTML).toContain("ev.stopPropagation(); // 点标题=改名，不触发整行打开会话");
    expect(HARNESS_UI_HTML).toContain("renameSession(rowView.id, next);");
    expect(HARNESS_UI_HTML).toContain("setSessionArchived(rowView.id, state.showArchived !== true);");
    // 改名/归档成功后必须重拉列表（pull-only：无变更不发写，变更不发事件）
    for (const fnName of ["function renameSession(", "function setSessionArchived("]) {
      const start = HARNESS_UI_HTML.indexOf(fnName);
      expect(start, `缺 ${fnName}`).toBeGreaterThanOrEqual(0);
      const end = HARNESS_UI_HTML.indexOf("\n  function ", start + 10);
      const bodyText = HARNESS_UI_HTML.slice(start, end < 0 ? start + 1200 : end);
      expect(bodyText, `${fnName} 成功后必须 loadSessions() 拉回（pull-only 纪律）`).toContain("return loadSessions();");
    }
    // 零新增 SSE：EventSource 禁入、订阅 URL 唯一（列表变化不订流）
    expect(HARNESS_UI_HTML).not.toContain("new EventSource(");
    expect((HARNESS_UI_HTML.match(/\/events\/stream\?sessionId=/g) ?? [])).toHaveLength(1);
    expect(HARNESS_UI_HTML).toContain("加载更多（剩 ' + hidden + '）");
  });
});

describe("W24：/tasks 历史合流消费面（来源标 / 倒序 / 转录入口）", () => {
  it("loomTaskSourceBadge：in_memory:true=内存在飞；账本-only 行缺键=账本历史；脏值不误标", () => {
    const logic = loadHarnessLogic();
    expect(logic.loomTaskSourceBadge({ task_id: "t", in_memory: true })).toEqual({ live: true, label: "内存在飞" });
    expect(logic.loomTaskSourceBadge({ task_id: "t", status: "done" })).toEqual({ live: false, label: "账本历史" });
    expect(logic.loomTaskSourceBadge({ task_id: "t", in_memory: false }).live).toBe(false); // 形状只认真 true
    expect(logic.loomTaskSourceBadge(null).live).toBe(false);
    expect(logic.loomTaskSourceBadge("bad").label).toBe("账本历史");
  });

  it("loomTasksNewestFirst：dispatched_at 倒序；同刻并列保持服务端合流序；拷贝不改入参", () => {
    const logic = loadHarnessLogic();
    const a = { task_id: "a", dispatched_at: 100 };
    const b = { task_id: "b", dispatched_at: 300 };
    const c = { task_id: "c", dispatched_at: 200 };
    const d = { task_id: "d" }; // 缺时间戳按 0 沉底，不伪造
    expect(logic.loomTasksNewestFirst([a, b, c, d]).map((r) => r["task_id"])).toEqual(["b", "c", "a", "d"]);
    const e1 = { task_id: "e1", dispatched_at: 300 };
    const e2 = { task_id: "e2", dispatched_at: 300 };
    expect(logic.loomTasksNewestFirst([e1, e2]).map((r) => r["task_id"])).toEqual(["e1", "e2"]); // 稳定排序：并列=内核在前
    expect(logic.loomTasksNewestFirst("bad")).toEqual([]);
    const src = [b];
    const out = logic.loomTasksNewestFirst(src);
    out.push({ task_id: "x" });
    expect(src).toHaveLength(1); // 纯函数：返回拷贝不 mutate
  });

  it("loomTaskTranscriptPath：转录入口 = 只读 GET /sessions/{sid}/context/full（W23-A 重启后 basis=cache 仍 200）", () => {
    const logic = loadHarnessLogic();
    expect(logic.loomTaskTranscriptPath("ses_child")).toBe("/sessions/ses_child/context/full");
    expect(logic.loomTaskTranscriptPath("ses/x")).toBe("/sessions/ses%2Fx/context/full");
    expect(logic.loomTaskTranscriptPath(null)).toBe("/sessions//context/full"); // 脏 sid 不抛，面板用 session_id 真值守卫
  });

  it("任务接线面：来源标芯片/倒序渲染/切片/转录惰性 GET + 真相芯片全在场", () => {
    expect(HARNESS_UI_HTML).toContain("loomTaskSourceBadge(row)");
    expect(HARNESS_UI_HTML).toContain("loomTasksNewestFirst(state.tasks)");
    expect(HARNESS_UI_HTML).toContain("loomListSlice(ordered, state.tasksShown)");
    expect(HARNESS_UI_HTML).toContain("request(loomTaskTranscriptPath(sid))");
    expect(HARNESS_UI_HTML).toContain("function toggleTaskTranscript(");
    expect(HARNESS_UI_HTML).toContain("function paintTaskTranscript(");
    expect(HARNESS_UI_HTML).toContain("loomContextTruthBits(view)");
    expect(HARNESS_UI_HTML).toContain("内存在飞");
    expect(HARNESS_UI_HTML).toContain("账本历史");
    expect(HARNESS_UI_HTML).toContain("转录真相 · ");
    // 账本缺口行如实呈现不藏 error（ledger gap 说明词原样进详情字段——既有面）
    expect(HARNESS_UI_HTML).toContain("if (row.error) fields.appendChild(taskField('error', String(row.error), 'err'));");
    // 转录正文只走 textContent 整块（无第二 innerHTML 站点）
    expect((HARNESS_UI_HTML.match(/\.innerHTML\s*=/g) ?? [])).toHaveLength(1);
  });
});

describe("W24：live/cache 真相（loomContextTruthBits 三态 + loomContextPlainView 缓存口径）", () => {
  it("truth bits：live+live / live+cache（重启残影双芯片）/ cache（segments 恒空）/ 未捕获 / v1-only 无 wire 键", () => {
    const logic = loadHarnessLogic();
    const live = logic.loomContextTruthBits({ basis: "live", wire: { source: "live" } });
    expect(live.line).toBe("基底=实时 · 发线=实时");
    expect(live.cache).toBe(false);
    const ghost = logic.loomContextTruthBits({ basis: "live", wire: { source: "cache" } });
    expect(ghost.line).toBe("基底=实时 · 发线=缓存(重启残影)"); // loop 活着、发线是残影——两芯片都得说
    const cache = logic.loomContextTruthBits({ basis: "cache", wire: { source: "cache" } });
    expect(cache.line).toBe("基底=缓存 · 发线=缓存(重启残影)");
    expect(cache.cache).toBe(true);
    expect(logic.loomContextTruthBits({ basis: "live", wire: null }).wireChip).toBe("发线=未捕获");
    const v1Only = logic.loomContextTruthBits({ basis: "live" }); // 'wire' 键缺席=v1-only 服务端，compat 提示负责，不发芯片
    expect(v1Only.wireChip).toBe("");
    expect(v1Only.line).toBe("基底=实时");
    expect(logic.loomContextTruthBits({ basis: "weird", wire: { source: "z3" } }).line).toBe("基底=weird · 发线=未标源");
    expect(logic.loomContextTruthBits(null).line).toBe("");
  });

  it("loomContextPlainView 诚实面：wire.source=cache → note 明标重启残影；无 wire+basis=cache → 缓存重建口径不谎称装配快照", () => {
    const logic = loadHarnessLogic();
    const cacheWireView = {
      basis: "cache",
      systemPrompt: "",
      segments: [], // 缓存基面 segments 恒空（装配对象不可恢复）
      messages: [],
      wire: {
        source: "cache",
        capturedAt: 1727000000000,
        turnIdx: 2,
        model: { id: "m1" },
        // canonical JSON 消息体（loomCtxReadableBody 的可解析形）：验证缓存面走同一消息装配器
        request: {
          systemPrompt: "CACHED-SYS",
          messages: [{ index: 0, role: "user", text: JSON.stringify({ content: [{ text: "hi", type: "text" }], role: "user", timestamp: 1 }) }],
          tools: [],
        },
      },
    };
    const p = logic.loomContextPlainView(cacheWireView);
    expect(p.ok).toBe(true);
    expect(p.fromWire).toBe(true);
    expect(p.note).toContain("turn #2");
    expect(p.note).toContain("发线=缓存(重启残影)");
    expect(p.text).toContain("CACHED-SYS");
    expect(p.text).toContain("【正文】hi");
    // 无 wire 的缓存重建（理论形态防御）：note 走缓存重建口径
    const noWire = { basis: "cache", systemPrompt: "REBUILT", segments: [], messages: [{ index: 0, role: "user", text: "hey" }] };
    const q = logic.loomContextPlainView(noWire);
    expect(q.ok).toBe(true);
    expect(q.note).toContain("来源=缓存重建");
    expect(q.note).not.toContain("装配快照");
    // 旧形态零扰动：W18 面（basis=live、无 source 键）note 逐字不变
    const plainLive = logic.loomContextPlainView(W18_VIEW);
    expect(plainLive.note).not.toContain("重启残影");
  });

  it("上下文接线面：芯片进 DOM 只走 textContent；硬编 '[live]' 前缀绝迹；回退面收起芯片", () => {
    expect(HARNESS_UI_HTML).toContain('id="ctxTruth"');
    expect(HARNESS_UI_HTML).toContain("var truth = loomContextTruthBits(view);");
    expect(HARNESS_UI_HTML).toContain("els.ctxTruth.textContent = truth.line;");
    expect(HARNESS_UI_HTML).toContain("els.ctxTruth.hidden = truth.line === '';");
    expect(HARNESS_UI_HTML).toContain("loomContextHeaderText(t, truth.basisChip)");
    expect(HARNESS_UI_HTML).not.toContain("'[live] 前缀 '"); // 真值芯片替代硬编（cache 基面不得谎称 live）
    // 顶线走共享格式化器（发线请求/转录快照），来源注记独立一行、可收起
    expect(HARNESS_UI_HTML).toContain('id="ctxSourceNote"');
    expect(HARNESS_UI_HTML).toContain("els.ctxMeta.textContent = loomContextHeaderText(t, truth.basisChip);");
    expect(HARNESS_UI_HTML).toContain("els.ctxSourceNote.hidden = t.sourceNote === '';");
    expect(HARNESS_UI_HTML).toContain("els.ctxSourceNote.textContent = t.sourceNote;");
    expect(HARNESS_UI_HTML).toContain("els.ctxSourceNote.title = t.sourceNote;");
    expect(HARNESS_UI_HTML).toContain("els.ctxTruth.hidden = true;"); // hideFullContext 收起（legacy 回退无 basis 语义）
    const hideAt = HARNESS_UI_HTML.indexOf("function hideFullContext()");
    expect(hideAt).toBeGreaterThan(-1);
    const hideEnd = HARNESS_UI_HTML.indexOf("\n  function ", hideAt + 10);
    const hideBody = HARNESS_UI_HTML.slice(hideAt, hideEnd < 0 ? HARNESS_UI_HTML.length : hideEnd);
    expect(hideBody).toContain("els.ctxSourceNote.hidden = true;");
    expect(hideBody).toContain("els.ctxSourceNote.textContent = '';");
    expect(hideBody).toContain("els.ctxSourceNote.title = '';");
    expect(HARNESS_UI_HTML).toContain("不假装存在。"); // 缓存基面如实提示行
  });

  it("W24 纪律锁复查：innerHTML 恰 1 / 无外链 / 无 emoji / 无复制路径回潮", () => {
    const assigns = HARNESS_UI_HTML.match(/\.innerHTML\s*=/g) ?? [];
    expect(assigns).toHaveLength(1);
    expect(/(src|href)="https?:/.test(HARNESS_UI_HTML)).toBe(false);
    expect(/\p{Extended_Pictographic}/u.test(HARNESS_UI_HTML)).toBe(false);
    expect(/\p{Extended_Pictographic}/u.test(HARNESS_UI_LOGIC_JS)).toBe(false);
    expect((HARNESS_UI_HTML.match(/复制路径/g) ?? []).length).toBe(0);
    expect((HARNESS_UI_LOGIC_JS.match(/复制路径/g) ?? []).length).toBe(0);
  });
});

// ─────────── W24：真树直打——面板请求规格命中已接线端点（服务端为所消费形状背书） ───────────

describe("W24：真树消费 e2e（title/archive/unarchive/?archived=1 与 GET /tasks、context/full 面）", () => {
  it("会话三件套全链路用面板同一批规格直打；列表 createdAt 倒序原样", async () => {
    const logic = loadHarnessLogic();
    const auth = { "X-Loom-Token": TOKEN };
    const jsonHeaders = { ...auth, "Content-Type": "application/json" };
    const made = await fetch(`${baseUrl}/sessions`, { method: "POST", headers: auth });
    expect(made.status).toBe(201);
    const created = (await made.json()) as { sessionID: string };
    const sid = created.sessionID;

    // ① 默认列表：行必带 createdAt/archived/status（title 可缺席）；createdAt 倒序（>= 并列容忍）
    const b1 = (await (await fetch(baseUrl + logic.loomSessionListPath(false), { headers: auth })).json()) as {
      sessions: Array<Record<string, unknown>>;
    };
    const item = b1.sessions.find((s) => s.sessionID === sid);
    expect(item, "新建会话应在默认列表").toBeTruthy();
    expect(typeof item!["createdAt"]).toBe("number");
    expect(item!["archived"]).toBe(false);
    expect(typeof item!["status"]).toBe("string");
    for (let i = 1; i < b1.sessions.length; i++) {
      expect(Number(b1.sessions[i - 1]!["createdAt"])).toBeGreaterThanOrEqual(Number(b1.sessions[i]!["createdAt"]));
    }

    // ② 改名：带空格直发（服务端 trim 真源），成功后拉回可见 title
    const renameSpec = logic.loomTitleRequest(sid, "  W24标题  ");
    const r2 = await fetch(baseUrl + renameSpec.path, { method: renameSpec.method, headers: jsonHeaders, body: renameSpec.body });
    expect(r2.status).toBe(200);
    expect(await r2.json()).toEqual({ ok: true });
    const b2 = (await (await fetch(baseUrl + logic.loomSessionListPath(false), { headers: auth })).json()) as {
      sessions: Array<Record<string, unknown>>;
    };
    expect(b2.sessions.find((s) => s.sessionID === sid)?.["title"]).toBe("W24标题");

    // ③ 归档：默认列表消失；?archived=1 在场且 archived=true
    const archSpec = logic.loomArchiveRequest(sid, true);
    const r3 = await fetch(baseUrl + archSpec.path, { method: archSpec.method, headers: jsonHeaders, body: archSpec.body });
    expect(r3.status).toBe(200);
    const b3 = (await (await fetch(baseUrl + logic.loomSessionListPath(false), { headers: auth })).json()) as {
      sessions: Array<Record<string, unknown>>;
    };
    expect(b3.sessions.some((s) => s.sessionID === sid)).toBe(false);
    const b4 = (await (await fetch(baseUrl + logic.loomSessionListPath(true), { headers: auth })).json()) as {
      sessions: Array<Record<string, unknown>>;
    };
    const archivedRow = b4.sessions.find((s) => s.sessionID === sid);
    expect(archivedRow).toBeTruthy();
    expect(archivedRow!["archived"]).toBe(true);

    // ④ 取消归档回默认列表（幂等面）
    const unSpec = logic.loomArchiveRequest(sid, false);
    expect((await fetch(baseUrl + unSpec.path, { method: unSpec.method, headers: jsonHeaders, body: unSpec.body })).status).toBe(200);
    const b5 = (await (await fetch(baseUrl + logic.loomSessionListPath(false), { headers: auth })).json()) as {
      sessions: Array<Record<string, unknown>>;
    };
    expect(b5.sessions.some((s) => s.sessionID === sid)).toBe(true);

    // ⑤ 空串=清除：服务端删键，列表行回落无 title（面板渲染 sid）
    const clr = logic.loomTitleRequest(sid, "");
    expect((await fetch(baseUrl + clr.path, { method: clr.method, headers: jsonHeaders, body: clr.body })).status).toBe(200);
    const b6 = (await (await fetch(baseUrl + logic.loomSessionListPath(false), { headers: auth })).json()) as {
      sessions: Array<Record<string, unknown>>;
    };
    expect("title" in (b6.sessions.find((s) => s.sessionID === sid) ?? {})).toBe(false);

    // ⑥ GET /tasks 合流面形状：面板只消费 body.tasks 数组（本装配无在飞/无 sub 账=空数组如实）
    const t = (await (await fetch(`${baseUrl}/tasks`, { headers: auth })).json()) as { tasks: unknown[] };
    expect(Array.isArray(t.tasks)).toBe(true);

    // ⑦ 新会话（loop 惰性建、无 LLM 调用、无缓存）context/full：200 诚实面 basis=live + wire:null
    // ——面板芯片应直出「基底=实时 · 发线=未捕获」，不假装发线在场。
    const cf = await fetch(baseUrl + logic.loomTaskTranscriptPath(sid), { headers: auth });
    expect(cf.status).toBe(200);
    const cfBody = (await cf.json()) as Record<string, unknown>;
    expect(cfBody.basis).toBe("live");
    expect(cfBody.wire).toBeNull();
    expect(logic.loomContextTruthBits(cfBody).line).toBe("基底=实时 · 发线=未捕获");
  });
});

// ─────────── W52：auto-compaction 分隔卡（live 快照 / 历史多事件 → 转录境界线） ───────────

describe("W52：auto-compaction 分隔卡", () => {
  const page = [
    { role: "user", content: "a", timestamp: 100 },
    { role: "assistant", content: "b", timestamp: 200 },
    { role: "user", content: "c", timestamp: 300 },
  ];

  it("插入位：anchor 早于整页 → 0；页内 → 命中下标；晚于整页 → -1；缺失 → 置顶；空页 → -1", () => {
    const logic = loadHarnessLogic();
    expect(logic.loomCompactionInsertIndex(page, 50)).toBe(0);
    expect(logic.loomCompactionInsertIndex(page, 200)).toBe(1);
    expect(logic.loomCompactionInsertIndex(page, 300)).toBe(2);
    expect(logic.loomCompactionInsertIndex(page, 301)).toBe(-1);
    expect(logic.loomCompactionInsertIndex(page, null)).toBe(0);
    expect(logic.loomCompactionInsertIndex([], 100)).toBe(-1);
    // 缺 timestamp 的条目跳过，不误判过界
    const sparse = [{ role: "user", content: "x" }, { role: "assistant", content: "y", timestamp: 500 }];
    expect(logic.loomCompactionInsertIndex(sparse, 400)).toBe(1);
  });

  it("active 快照 → opencode 同构视图（上下分隔线文案 + summaryText 原文）；none/坏帧 → null", () => {
    const logic = loadHarnessLogic();
    const view = logic.loomCompactionCardView({
      status: "active",
      coveredCount: 951,
      summaryText: "[auto-compacted summary of 951 earlier messages]\n<b>摘要</b>\n第二行",
      anchorMessageId: null,
      anchorTimestampMs: 200,
      tailCount: 2,
      totalMessages: 953,
    });
    expect(view).toEqual({
      coveredCount: 951,
      topLabel: "会话压缩已开始",
      bottomLabel: "会话已压缩 · 951 条消息",
      summary: "<b>摘要</b>\n第二行",
    });
    expect(logic.loomCompactionCardView({ status: "none", coveredCount: null, summaryText: null })).toBeNull();
    expect(logic.loomCompactionCardView(null)).toBeNull();
    expect(logic.loomCompactionCardView({ status: "active" })).toBeNull();
  });

  it("历史事件视图：只剥内核前缀；coveredCount 归一；坏帧 null", () => {
    const logic = loadHarnessLogic();
    const view = logic.loomCompactionEventView({
      id: "evt-1",
      kind: "boundary",
      coveredCount: 4.9,
      summaryText: "[auto-compacted summary of 951 earlier messages]\n## 摘要\n正文",
      anchorMessageId: "msg-1",
      anchorTimestampMs: 200,
      recordedAt: 300,
    });
    expect(view).toEqual({
      id: "evt-1",
      coveredCount: 4,
      topLabel: "会话压缩已开始",
      bottomLabel: "会话已压缩 · 4 条消息",
      summary: "## 摘要\n正文",
    });
    // 只剥行首内核标记；正文中段同形文本原样保留
    expect(
      logic.loomCompactionEventView({
        summaryText: "前言\n[auto-compacted summary of 2 earlier messages]\n正文",
      })?.summary,
    ).toBe("前言\n[auto-compacted summary of 2 earlier messages]\n正文");
    expect(logic.loomCompactionEventView({ summaryText: "x", coveredCount: -3 })?.coveredCount).toBe(0);
    expect(logic.loomCompactionEventView({ summaryText: "x", coveredCount: Number.NaN })?.coveredCount).toBe(0);
    expect(logic.loomCompactionEventView({ summaryText: "x", coveredCount: Number.POSITIVE_INFINITY })?.coveredCount).toBe(0);
    expect(logic.loomCompactionEventView({ summaryText: "x", coveredCount: "9" })?.coveredCount).toBe(0);
    expect(logic.loomCompactionEventView({ summaryText: 3 })).toBeNull();
    expect(logic.loomCompactionEventView(null)).toBeNull();
    expect(logic.loomCompactionEventView("x")).toBeNull();
  });

  it("事件列表：接受 {events}/裸数组，坏帧丢弃，按 id（缺 id 按摘要）去重，锚点升序", () => {
    const logic = loadHarnessLogic();
    const list = logic.loomCompactionEventList({
      events: [
        { id: "b", summaryText: "B", anchorTimestampMs: 300, recordedAt: 300 },
        { id: "a", summaryText: "A", anchorTimestampMs: 100, recordedAt: 900 },
        { id: "a", summaryText: "A-dup", anchorTimestampMs: 100, recordedAt: 950 },
        { id: "c", summaryText: "C", anchorTimestampMs: null, recordedAt: 50 },
        { id: "d", summaryText: "D", anchorTimestampMs: 200, recordedAt: 200 },
        { id: "d", summaryText: "D-dup", anchorTimestampMs: 200, recordedAt: 210 },
        { id: "e", summaryText: 1 },
        null,
      ],
    });
    expect(list.map((e) => e.id)).toEqual(["c", "a", "d", "b"]);
    expect(list[0]!.anchorTimestampMs).toBeNull();
    expect(list[0]!.recordedAt).toBe(50);
    expect(list[1]!.anchorTimestampMs).toBe(100);
    expect(list[1]!.summary).toBe("A");

    // 同锚点按 recordedAt 升序
    const tied = logic.loomCompactionEventList([
      { id: "late", summaryText: "late", anchorTimestampMs: 200, recordedAt: 500 },
      { id: "early", summaryText: "early", anchorTimestampMs: 200, recordedAt: 100 },
    ]);
    expect(tied.map((e) => e.id)).toEqual(["early", "late"]);

    // 裸数组同口径；坏容器空表
    expect(logic.loomCompactionEventList([{ id: "x", summaryText: "X" }]).map((e) => e.id)).toEqual(["x"]);
    expect(logic.loomCompactionEventList({ events: "no" })).toEqual([]);
    expect(logic.loomCompactionEventList(null)).toEqual([]);
    // 排布元数据不可枚举：视图对等比较仍是渲染契约五键
    expect(logic.loomCompactionEventList([{ id: "shape", summaryText: "S" }])).toEqual([
      {
        id: "shape",
        coveredCount: 0,
        topLabel: "会话压缩已开始",
        bottomLabel: "会话已压缩 · 0 条消息",
        summary: "S",
      },
    ]);

    // 缺 id：按摘要全文去重（不同摘要保留；同摘要不同 id 不丢，各自成卡）
    const noId = logic.loomCompactionEventList([
      { summaryText: "same" },
      { summaryText: "same" },
      { summaryText: "other" },
    ]);
    expect(noId.map((e) => e.summary)).toEqual(["same", "other"]);
    const sameText = logic.loomCompactionEventList([
      { id: "boundary-1", kind: "boundary", summaryText: "same", recordedAt: 1 },
      { id: "auto-1", kind: "auto", summaryText: "same", recordedAt: 2 },
    ]);
    expect(sameText.map((e) => e.id)).toEqual(["boundary-1", "auto-1"]);
  });

  it("排布：index 0 进顶部堆叠，页内按下标，晚于整页进尾部兜底", () => {
    const logic = loadHarnessLogic();
    const events = [
      { id: "before", anchorTimestampMs: 50 },
      { id: "null-anchor", anchorTimestampMs: null },
      { id: "in-1", anchorTimestampMs: 200 },
      { id: "in-2", anchorTimestampMs: 200 },
      { id: "in-3", anchorTimestampMs: 300 },
      { id: "after", anchorTimestampMs: 999 },
    ];
    const placement = logic.loomCompactionPlacement(page, events);
    expect(placement.top.map((e) => e.id)).toEqual(["before", "null-anchor"]);
    expect(placement.at[1]?.map((e) => e.id)).toEqual(["in-1", "in-2"]);
    expect(placement.at[2]?.map((e) => e.id)).toEqual(["in-3"]);
    expect(placement.tail.map((e) => e.id)).toEqual(["after"]);
    // 空页：所有事件进尾部可见面，不静默丢
    expect(logic.loomCompactionPlacement([], events).tail).toHaveLength(events.length);
  });

  it("接线：history 与 /compactions 并行；多卡按锚点插入；顶部堆叠；keyed 刷新不重复", () => {
    // loadHistory：两请求并行；/compactions 404 回退 /compaction，其它失败静默 []
    expect(HARNESS_UI_HTML).toContain("var compactionRequest = fetchCompactions(sessionID);");
    expect(HARNESS_UI_HTML).toContain("Promise.all([historyRequest, compactionRequest])");
    expect(HARNESS_UI_HTML).toContain("ingestHistory(messages, compactions);");
    expect(HARNESS_UI_HTML).toContain("'/compactions'");
    expect(HARNESS_UI_HTML).toContain("res.status === 404");
    expect(HARNESS_UI_HTML).toContain("return fetchCompaction(sessionID).then(function (snapshot) {");
    expect(HARNESS_UI_HTML).toContain("if (!res.ok) return [];");
    // fetch 只回原始 events[]；归一唯一入口在消费端（二次归一不得吞视图）
    expect(HARNESS_UI_HTML).toContain("Array.isArray(body.events) ? body.events : []");
    expect(HARNESS_UI_HTML).toContain("var list = loomCompactionEventList(raw);");

    // 归一 + 排布：事件列表、顶部堆叠、页内下标、尾部兜底
    expect(HARNESS_UI_HTML).toContain("var events = loomCompactionEventList(compactions);");
    expect(HARNESS_UI_HTML).toContain("var placement = loomCompactionPlacement(messages, events);");
    expect(HARNESS_UI_HTML).toContain("var stack = el('div', 'compaction-stack');");
    expect(HARNESS_UI_HTML).toContain("'更早的压缩摘要'");
    expect(HARNESS_UI_HTML).toContain("placement.at[i]");
    expect(HARNESS_UI_HTML).toContain("placement.tail");

    // keyed 状态：每事件一卡，绝不唯一卡覆盖
    expect(HARNESS_UI_HTML).toContain("state.compactionCards[key] = card;");
    expect(HARNESS_UI_HTML).toContain("state.compactionKeys.push(key);");
    expect(HARNESS_UI_HTML).toContain("function createCompactionCard(view)");
    expect(HARNESS_UI_HTML).toContain("data-compaction-id");
    expect(HARNESS_UI_HTML).toContain("function refreshCompactions()");
    expect(HARNESS_UI_HTML).toContain("refreshCompactions(); // 压缩历史可能在本轮推进");
    expect(HARNESS_UI_HTML).not.toContain("state.compactionEl");
    expect(HARNESS_UI_HTML).not.toContain("addCompactionDivider");

    // 渲染面：opencode 同构的上下分隔线 + 完整摘要 markdown（无 details 折叠/截高）
    expect(HARNESS_UI_HTML).toContain("card.setAttribute('data-component', 'session-compaction-message');");
    expect(HARNESS_UI_HTML).toContain("compaction-divider");
    expect(HARNESS_UI_HTML).toContain("compaction-line");
    expect(HARNESS_UI_HTML).toContain("compaction-label");
    expect(HARNESS_UI_HTML).toContain("data-compaction-label', 'top'");
    expect(HARNESS_UI_HTML).toContain("data-compaction-label', 'bottom'");
    expect(HARNESS_UI_HTML).toContain("var body = el('div', 'compaction-summary md');");
    expect(HARNESS_UI_HTML).toContain("renderMarkdownInto(body, view.summary);");
    expect(HARNESS_UI_HTML).not.toContain("details.compaction");
    expect(HARNESS_UI_HTML).not.toContain("card.open = false;");
    const summaryRule = HARNESS_UI_HTML.slice(
      HARNESS_UI_HTML.indexOf(".compaction-summary {"),
      HARNESS_UI_HTML.indexOf("}", HARNESS_UI_HTML.indexOf(".compaction-summary {")),
    );
    expect(summaryRule).not.toContain("max-height");
    expect(summaryRule).not.toContain("overflow");

    // 会话切换：clearMessages 重置 keyed 状态（replaceChildren 已清 DOM）
    expect(HARNESS_UI_HTML).toContain("state.compactionCards = {};");
    expect(HARNESS_UI_HTML).toContain("state.compactionKeys = [];");
    expect(HARNESS_UI_HTML).toContain("state.compactionStack = null;");
    expect(HARNESS_UI_HTML).toContain(".compaction-stack {");
    expect(HARNESS_UI_HTML).toContain(".compaction-stack-head");
  });
});

// ─────────── W53：Web 待发消息区（session.queue 快照 + GET /pending 对账） ───────────

describe("W53：Web 待发消息区", () => {
  function pageFunction(name: string): string {
    const start = HARNESS_UI_HTML.indexOf(`function ${name}(`);
    expect(start, `页面缺少 ${name} 函数`).toBeGreaterThan(-1);
    const end = HARNESS_UI_HTML.indexOf("\n  function ", start + 10);
    return HARNESS_UI_HTML.slice(start, end < 0 ? HARNESS_UI_HTML.length : end);
  }

  it("DOM 与样式：pending 容器位于 #thread 之后、composer 之前，四类样式齐备", () => {
    const threadAt = HARNESS_UI_HTML.indexOf('<div id="thread"></div>');
    const pendingAt = HARNESS_UI_HTML.indexOf('id="pending-area"');
    const composerAt = HARNESS_UI_HTML.indexOf('<footer id="composer-bar">');
    expect(threadAt).toBeGreaterThan(-1);
    expect(pendingAt).toBeGreaterThan(threadAt);
    expect(composerAt).toBeGreaterThan(pendingAt);

    expect(HARNESS_UI_HTML).toContain('<div id="pending-area"></div>');
    expect(HARNESS_UI_HTML).toContain("pendingArea: $('pending-area')");
    for (const cls of [".pending-area", ".pending-row", ".pending-bubble", ".pending-badge"]) {
      expect(HARNESS_UI_HTML, `缺少待发区样式 ${cls}`).toContain(cls);
    }
    expect(HARNESS_UI_HTML).toContain(".pending-area[hidden], .pending-area:empty { display: none; }");
  });

  it("渲染：空队列隐藏，有队列走独立容器；queued=排队中，running/drained=已发送", () => {
    const body = pageFunction("renderPending");
    expect(body).toContain("els.pendingArea.replaceChildren();");
    expect(body).toContain("els.pendingArea.hidden = true;");
    expect(body).toContain("els.pendingArea.hidden = false;");
    expect(body).toContain("'pending-row'");
    expect(body).toContain("'pending-bubble'");
    expect(body).toContain("'pending-badge'");
    expect(body).toContain("排队中");
    expect(body).toContain("已发送");
    // 待发行只进 pending 容器，绝不 append 到主转录
    expect(body).not.toContain("els.thread");
  });

  it("接线：GET /pending + loadPending 守卫 activeId，失败静默为空", () => {
    expect(HARNESS_UI_HTML).toContain("'/pending'");
    expect(HARNESS_UI_HTML).toContain("function loadPending(");
    expect(HARNESS_UI_HTML).toContain("function fetchPending(");

    const body = pageFunction("loadPending");
    expect(body).toContain("fetchPending(sessionID)");
    expect(body).toContain("if (state.activeId !== sessionID) return;");
    expect(body).toContain("setPending(items);");
    expect(body).toContain("renderPending();");
    expect(body).not.toContain("showStatus('error'");

    const fetchBody = pageFunction("fetchPending");
    expect(fetchBody).toContain("if (!res.ok) return [];");
    expect(fetchBody).toContain("catch(function () { return []; })");
  });

  it("session.queue：不再是空转占位；旧键消失触发 loadHistory，其余只重绘徽标", () => {
    const body = pageFunction("handleFrame");
    const at = body.indexOf("case 'session.queue':");
    expect(at).toBeGreaterThan(-1);
    const end = body.indexOf("default:", at);
    const block = body.slice(at, end < 0 ? at + 900 : end);

    expect(block).toContain("normalizePending(props.pending)");
    expect(block).toContain("setPending(nextPending);");
    expect(block).toContain("renderPending();");
    expect(block).toContain("pendingLost(prevPendingKeys, state.pendingKeys)");
    expect(block).toContain("loadHistory(state.activeId)");
    expect(block).not.toContain("仅占位");
    expect(block).not.toContain("break;\n        break;");
  });

  it("sendMessage：无乐观 addUserMessage；401/409/!ok/catch 都恢复输入，成功拉 pending", () => {
    const body = pageFunction("sendMessage");
    expect(body).not.toContain("addUserMessage");
    const postAt = body.indexOf("/messages'");
    expect(postAt).toBeGreaterThan(-1);
    expect(body.slice(0, postAt)).not.toContain("addUserMessage");

    expect(body).toContain("els.composer.value = text;");
    expect(body).toContain("autoGrow();");
    expect(body).toContain("res.status === 401");
    expect(body).toContain("res.status === 409");
    expect(body).toContain("if (!res.ok)");
    expect(body).toContain(".catch(function (err) {");
    expect(body).toContain("loadPending(state.activeId);");
    expect(body.indexOf("loadPending(state.activeId);")).toBeGreaterThan(body.indexOf("res.status === 409"));
  });

  it("loadHistory：history/compactions/pending 并行；ingest 后重绘 pending；clearMessages 全清", () => {
    const historyBody = pageFunction("loadHistory");
    expect(historyBody).toContain("var compactionRequest = fetchCompactions(sessionID);");
    expect(historyBody).toContain("var pendingRequest = fetchPending(sessionID);");
    expect(historyBody).toContain("Promise.all([historyRequest, compactionRequest])");
    expect(historyBody).toContain("ingestHistory(messages, compactions);");
    expect(historyBody).toContain("setPending(pending);");
    expect(historyBody).toContain("renderPending();");

    const clearBody = pageFunction("clearMessages");
    expect(clearBody).toContain("state.compactionCards = {};");
    expect(clearBody).toContain("state.compactionKeys = [];");
    expect(clearBody).toContain("state.compactionStack = null;");
    expect(clearBody).toContain("state.pending = [];");
    expect(clearBody).toContain("state.pendingKeys = [];");
    expect(clearBody).toContain("renderPending();");
  });

  it("SSE 重连：先按 store 重建转录，再消费 live 帧，避免旧 msg_/part 串到新回复", () => {
    const sub = pageFunction("subscribe");
    expect(sub).toContain("var wasOpened = state.streamWasOpened;");
    expect(sub).toContain("state.streamWasOpened = true;");
    expect(sub).toContain("if (wasOpened) {");
    expect(sub).toContain("return loadHistory(sessionID).then(function () {");
    expect(sub).toContain("if (ctl.signal.aborted || state.activeId !== sessionID) return;");
    expect(sub).toContain("return pump();");

    const open = pageFunction("openSession");
    expect(open).toContain("state.streamWasOpened = false;");
  });

  it("事件覆盖表仍包含 session.queue（编译期穷尽锁未破）", () => {
    expect(HARNESS_UI_HANDLED_EVENTS).toContain("session.queue");
    expect(EXPECTED_EVENTS).toContain("session.queue");
    expect(HARNESS_UI_HTML).toContain("case 'session.queue':");
  });

  it("页面内嵌脚本可解析（pending 新函数无语法错误）", () => {
    const open = HARNESS_UI_HTML.indexOf("<script>");
    const close = HARNESS_UI_HTML.indexOf("</script>", open);
    expect(open).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(open);
    const script = HARNESS_UI_HTML.slice(open + "<script>".length, close);
    expect(() => new Function(script)).not.toThrow();
  });
});
