/**
 * T27 会话域 —— HTTP 路由注册（照 T26 http 骨架的 register* 模式）。
 *
 * 鉴权由 Router 前置（无未鉴权路径，见 ../http/router.ts）；本模块只把命令映射到
 * SessionRegistry，并做边界解析（body / query / path param）。
 *
 * 端点（会话域，docs/01 §10.1）：
 *   POST /sessions                      —— 新建会话（造无连字符 id）
 *   GET  /sessions                      —— 列出会话（local_sessions 语义的会话侧）
 *   POST /sessions/:sessionID/messages  —— 发送消息（202；事件走 EventHub）
 *   POST /sessions/:sessionID/voice     —— 语音「先中止再发送」，立接立回（W16-F2）
 *   POST /sessions/:sessionID/abort     —— 中止当前轮
 *   GET  /sessions/:sessionID/status    —— 会话状态（busy/idle/error + activeRuns）
 *   GET  /sessions/:sessionID/pending   —— 待发队列读模型（W55；queued/running/drained，空队列 200）
 *   GET  /sessions/:sessionID/history   —— 历史分页（游标 x-next-cursor）
 *   GET  /sessions/:sessionID/context        —— 上下文预览（W13；最近一次装配的分段构成，只读）
 *   GET  /sessions/:sessionID/context/full   —— 上下文全字节面（W16-B v1 面逐字节冻结 +
 *                                                W17-B v2 加性 wire/manifest 两键 +
 *                                                W23-A 三段回落（live 槽/live 下缓存/basis:cache
 *                                                纯缓存，侧/子会话重启后可查），只读）
 *   GET  /sessions/:sessionID/compaction     —— live 压缩境界只读面（W51；core compactionView
 *                                                快照 → active/none 两态硬合同；无 live loop 404）
 *   GET  /sessions/:sessionID/compactions    —— 历史压缩摘要只读面（C2；durable boundary +
 *                                                append-only auto 事件 + live/cache seed，
 *                                                摘要哈希去重、时间升序；未知 sid 404）
 *   POST /sessions/:sessionID/title          —— 设/清会话标题（W23-B；trim 限 120 码点，
 *                                                空串=清除；meta sidecar 持久；未知 sid 404）
 *   POST /sessions/:sessionID/archive        —— 归档（W23-B；默认列表排除，?archived=1 只列归档）
 *   POST /sessions/:sessionID/unarchive      —— 取消归档（W23-B；幂等）
 *   GET  /sessions 查询面（W23-B）：createdAt 视图倒序；?archived=1 反转过滤域
 *
 * 不做：SSE 订阅端点（T29 sseStreamHandler，T31 装配）。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { CompactionBusyError } from "@axeuh/loom-core";
import { HttpError, readJsonBody, sendJson } from "../http/index.js";
import type { Router } from "../http/router.js";
import type { HandlerCtx } from "../http/types.js";
import { decodeCursor, normalizeLimit } from "./history.js";
import { buildContextFullCacheV2, buildContextFullV2 } from "./context-full-v2.js";
import type { ContextManifest } from "./context-manifest.js";
import type { SendOutcome, SessionApiDeps, SessionCompactionResponse } from "./types.js";

/** session id 合法字符集：字母数字下划线（连字符永久禁用，docs/04 §3.2）。 */
const SESSION_ID_RE = /^[a-zA-Z0-9_]+$/;

/** 归一化路径 sessionID：连字符→下划线（前端硬口径）、非法字符 400。 */
function normalizeSessionID(raw: string): string {
  const normalized = raw.replace(/-/g, "_");
  if (!SESSION_ID_RE.test(normalized)) {
    throw new HttpError(400, "bad_session_id", `invalid sessionID: ${raw}`);
  }
  return normalized;
}

/** 从路径取 sessionID（路由保证存在，仍做防御）。 */
function paramSessionID(ctx: HandlerCtx): string {
  const raw = ctx.params["sessionID"];
  if (raw === undefined || raw.length === 0) {
    throw new HttpError(400, "bad_session_id", "missing sessionID in path");
  }
  return normalizeSessionID(raw);
}

function asRecord(body: unknown): Record<string, unknown> {
  if (typeof body === "object" && body !== null && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  throw new HttpError(400, "bad_request", "request body must be a JSON object");
}

/**
 * 宽松解析发送正文：接受 `{text}` / `{message}` / `{content:string}` /
 * `{parts:[{type:"text",text}]}`。空正文 400。
 */
function extractText(body: unknown): string {
  const rec = asRecord(body);
  const direct = rec["text"] ?? rec["message"];
  if (typeof direct === "string" && direct.trim().length > 0) return direct;
  const content = rec["content"];
  if (typeof content === "string" && content.trim().length > 0) return content;
  const parts = rec["parts"];
  if (Array.isArray(parts)) {
    const joined = parts
      .filter((p): p is Record<string, unknown> => typeof p === "object" && p !== null)
      .filter((p) => p["type"] === "text" && typeof p["text"] === "string")
      .map((p) => p["text"] as string)
      .join("");
    if (joined.trim().length > 0) return joined;
  }
  throw new HttpError(400, "bad_request", "message text is required");
}

/** 发送结果 → HTTP 响应（accepted→202，排队受理附 queued:true，W56 抢占附 interrupted:true；队列满回压→409，W42b 携背压读数）。 */
function respondSend(res: ServerResponse, outcome: SendOutcome): void {
  if (outcome.accepted) {
    sendJson(res, 202, {
      sessionID: outcome.sessionID,
      status: "busy",
      accepted: true,
      ...("queued" in outcome ? { queued: true } : {}),
      ...("interrupted" in outcome ? { interrupted: true } : {}),
    });
    return;
  }
  sendJson(res, 409, {
    error: { code: "session_busy", message: `session ${outcome.sessionID} send queue full` },
    sessionID: outcome.sessionID,
    status: "busy",
    queueCapacity: outcome.queueCapacity,
    queueLength: outcome.queueLength,
  });
}

/** 标题上限 120 **码点**（Array.from 数，emoji/CJK 不半字符截断）。 */
function truncatedTitle(trimmed: string): string {
  const cps = Array.from(trimmed);
  return cps.length <= 120 ? trimmed : cps.slice(0, 120).join("");
}

/** GET history 的带游标响应（header x-next-cursor；无更早游标时不写头）。 */
function sendHistoryPage(
  res: ServerResponse,
  sessionID: string,
  messages: readonly unknown[],
  nextCursor: string | null,
): void {
  const body = JSON.stringify({ sessionID, messages, nextCursor });
  const headers: Record<string, string | number> = {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  };
  if (nextCursor !== null) headers["x-next-cursor"] = nextCursor;
  res.writeHead(200, headers);
  res.end(body);
}

/**
 * W25：manifest 现读口——静态对象（boot 一次装配旧形态）与工厂（热重载后须即刻反映
 * 新 catalog 的 boot 现面）双形态归一；未接线 = null 诚实面不变。
 */
function resolveManifest(deps: SessionApiDeps): ContextManifest | null {
  return typeof deps.manifest === "function" ? deps.manifest() : deps.manifest ?? null;
}

/** 把会话域全部端点注册到 Router。 */
export function registerSessionRoutes(router: Router, deps: SessionApiDeps): void {
  const registry = deps.registry;

  router.add("POST", "/sessions", (_req, res) => {
    const rec = registry.create();
    sendJson(res, 201, { sessionID: rec.sessionID, status: rec.status });
  });

  router.add("GET", "/sessions", (_req, res, ctx) => {
    // T3：列表默认关闭（键缺席 = disabled，用户决策）；仅显式 true 开放，?archived=1 同受此门。
    if (deps.sessionList !== true) {
      throw new HttpError(404, "session_list_disabled", "session listing is disabled");
    }
    // W23-B：?archived=1 只列归档（其余取值=默认排除归档）；视图级 createdAt 倒序在 registry。
    const archivedOnly = ctx.url.searchParams.get("archived") === "1";
    const sessions = registry.list(archivedOnly ? { archived: "only" } : undefined);
    sendJson(res, 200, { sessions, count: sessions.length });
  });

  // T3 主会话单端点：恒可用（不吃 sessionList 门）；主会话已归档也照常返回。
  // sid = boot 注入的 mainSessionId > registry 缺省主会话；无从解析 = 503。
  // 未注册主会话就地 ensure（自愈），随后回 SessionView 单对象（无 sessions/count 包裹）。
  router.add("GET", "/sessions/main", (_req, res) => {
    const sid = deps.mainSessionId ?? registry.defaultMainSessionId();
    if (sid === undefined) {
      throw new HttpError(503, "main_session_unavailable", "no main session resolved");
    }
    let view = registry.viewOf(sid);
    if (view === undefined) {
      registry.ensure(sid);
      view = registry.viewOf(sid);
    }
    if (view === undefined) {
      throw new HttpError(503, "main_session_unavailable", "no main session resolved");
    }
    sendJson(res, 200, view);
  });

  // W23-B 标题：{title:string} trim 后限 120 码点；空串 = 清除声明（键删除，列表回落无 title）。
  // 未知 sid 404；成功恒 200 {ok:true}。无新事件名（面板改后自拉 list，见 w23.md 申明）。
  router.add("POST", "/sessions/:sessionID/title", async (req, res, ctx) => {
    const sessionID = paramSessionID(ctx);
    const body = asRecord(await readJsonBody(req));
    const raw = body["title"];
    if (typeof raw !== "string") {
      throw new HttpError(400, "bad_request", "title must be a string");
    }
    const trimmed = raw.trim();
    const title = trimmed.length === 0 ? null : truncatedTitle(trimmed);
    if (!registry.setTitle(sessionID, title)) {
      throw new HttpError(404, "session_not_found", `no session ${sessionID}`);
    }
    sendJson(res, 200, { ok: true });
  });

  // W23-B 归档/取消归档（幂等：重复归档仍 200；meta sidecar 落盘）。
  router.add("POST", "/sessions/:sessionID/archive", (_req, res, ctx) => {
    const sessionID = paramSessionID(ctx);
    if (!registry.setArchived(sessionID, true)) {
      throw new HttpError(404, "session_not_found", `no session ${sessionID}`);
    }
    sendJson(res, 200, { ok: true });
  });

  router.add("POST", "/sessions/:sessionID/unarchive", (_req, res, ctx) => {
    const sessionID = paramSessionID(ctx);
    if (!registry.setArchived(sessionID, false)) {
      throw new HttpError(404, "session_not_found", `no session ${sessionID}`);
    }
    sendJson(res, 200, { ok: true });
  });

  router.add("POST", "/sessions/:sessionID/messages", async (req, res, ctx) => {
    const sessionID = paramSessionID(ctx);
    const body = await readJsonBody(req);
    const text = extractText(body);
    respondSend(res, registry.send(sessionID, text));
  });

  router.add("POST", "/sessions/:sessionID/compact", async (_req, res, ctx) => {
    const sessionID = paramSessionID(ctx);
    if (!registry.isKnownSession(sessionID)) {
      throw new HttpError(404, "session_not_found", `no session ${sessionID}`);
    }
    if (registry.statusView(sessionID)?.status === "busy") {
      throw new HttpError(409, "session_busy", "session is running; compact after it becomes idle");
    }
    const rec = registry.get(sessionID) ?? registry.ensure(sessionID);
    // 与 GET /compaction 同一纪律：重启后 durable 转录先回放进内核内存，手动压缩
    // 才对非空快照取边界，而不是在空 _messages 上 no-op。
    await rec.loop.hydrate();
    try {
      const started = rec.loop.session.startCompaction("manual");
      // 成功/失败事件由 per-session CompactionStreamPublisher 统一发，路由不再重复 publish。
      void started.done.catch(() => {});
      sendJson(res, 202, {
        sessionID,
        status: "compacting",
        accepted: true,
        attemptId: started.attemptId,
      });
    } catch (err) {
      if (err instanceof CompactionBusyError) {
        throw new HttpError(409, "compaction_busy", "a compaction is already running");
      }
      throw new HttpError(
        501,
        "compaction_unavailable",
        err instanceof Error ? err.message : String(err),
      );
    }
  });

  router.add("POST", "/sessions/:sessionID/voice", async (req, res, ctx) => {
    const sessionID = paramSessionID(ctx);
    const body = await readJsonBody(req);
    const text = extractText(body);
    // W16-F2 立接立回：voiceSend 同步受理即返，abort→收尾→起轮在其后台链里跑。
    respondSend(res, registry.voiceSend(sessionID, text));
  });

  router.add("POST", "/sessions/:sessionID/abort", (_req, res, ctx) => {
    const sessionID = paramSessionID(ctx);
    if (!registry.has(sessionID)) {
      throw new HttpError(404, "session_not_found", `no session ${sessionID}`);
    }
    const aborted = registry.abort(sessionID, "abort requested");
    sendJson(res, 200, { sessionID, aborted, status: registry.statusView(sessionID)?.status ?? "idle" });
  });

  router.add("GET", "/sessions/:sessionID/status", (_req, res, ctx) => {
    const sessionID = paramSessionID(ctx);
    const view = registry.statusView(sessionID);
    if (view === undefined) {
      throw new HttpError(404, "session_not_found", `no session ${sessionID}`);
    }
    sendJson(res, 200, view);
  });

  // W55 待发队列只读面：与 /status 同参数与 404 纪律；未知 sid = 404，空队列 = 200 pending:[]。
  router.add("GET", "/sessions/:sessionID/pending", (_req, res, ctx) => {
    const sessionID = paramSessionID(ctx);
    const view = registry.pendingView(sessionID);
    if (view === undefined) {
      throw new HttpError(404, "session_not_found", `no session ${sessionID}`);
    }
    sendJson(res, 200, view);
  });

  router.add("GET", "/sessions/:sessionID/history", async (_req: IncomingMessage, res: ServerResponse, ctx) => {
    const sessionID = paramSessionID(ctx);
    const limit = normalizeLimit(Number(ctx.url.searchParams.get("limit") ?? ""));
    const rawBefore = ctx.url.searchParams.get("before");
    let before: string | undefined;
    if (rawBefore !== null) {
      const decoded = decodeCursor(rawBefore);
      if (decoded === null) throw new HttpError(400, "bad_cursor", "before cursor is not a valid cursor");
      before = decoded;
    }
    const page = await registry.history(sessionID, {
      limit,
      ...(before !== undefined ? { before } : {}),
    });
    sendHistoryPage(res, sessionID, page.messages, page.nextCursor);
  });

  // W13 上下文预览（只读）；缺省取数口 = registry 自身（内存快照 / trace 反推）。
  router.add("GET", "/sessions/:sessionID/context", async (_req, res, ctx) => {
    const sessionID = paramSessionID(ctx);
    const provider = deps.context ?? registry;
    const view = await provider.contextView(sessionID);
    if (view === undefined) {
      throw new HttpError(404, "context_not_found", `no assembly snapshot for session ${sessionID}`);
    }
    sendJson(res, 200, view);
  });

  // W16-B 上下文全字节面（只读）：live loop 内存现读（同 W13 内存纪律）；
  // W23-A 三段回落：live 槽 → loop 在而槽空取 wire/{sid}.json 缓存（basis "live" +
  // wire.source "cache"）→ 无 loop 但缓存在场 = basis "cache" 200（侧/子会话重启后可查，
  // v1 十四键 = 缓存+durable 转录如实重建）；皆无 = 404 原纪律。
  // 公开口三件：SessionRegistry.loopOf → loop.session.systemPrompt / loop.session.messages
  // → loop.assemblies() 尾项；缓存口 = deps.wireCache（未接线 = 逐字节旧行为）。
  // W17-B v2 加性面：wire = loop.session.lastWireRequest/lastProviderPayload 现读
  // （无捕获 = null 诚实 200）；manifest = deps.manifest（boot 一次装配）；
  // v1 十四键值逐字节冻结（context-full-v2.ts 组合纪律 + W16-B 测试原样绿）。
  router.add("GET", "/sessions/:sessionID/context/full", async (_req, res, ctx) => {
    const sessionID = paramSessionID(ctx);
    const loop = registry.loopOf(sessionID);
    if (loop === undefined) {
      // 无 live loop：W23-A 纯缓存面（200 basis:"cache"）或原 404 纪律。
      const rec = deps.wireCache?.read(sessionID) ?? null;
      if (rec === null) {
        throw new HttpError(404, "context_full_not_found", `no live loop for session ${sessionID}`);
      }
      sendJson(res, 200, buildContextFullCacheV2({
        sessionID,
        savedAt: rec.savedAt,
        snapshot: rec.snapshot,
        providerPayload: rec.providerPayload,
        messages: await registry.transcriptMessages(sessionID),
        contextWindow: deps.contextWindow ?? null,
        manifest: resolveManifest(deps),
      }));
      return;
    }
    const assemblies = loop.assemblies();
    const lastAssembly = assemblies.length > 0 ? assemblies[assemblies.length - 1]! : null;
    // 请求面 = live/reconciled 前缀视图（systemPrompt 重读后按新 plan 重建）；
    // assemblies()/trace 仍为历史事件面。
    const currentAssembly = loop.currentAssembly();
    const contextWindow =
      typeof loop.session.model.contextWindow === "number" ? loop.session.model.contextWindow : null;
    // W23-A 回落层：live 槽在场 = source "live"；槽空 + 缓存在场 = source "cache"
    //（basis 仍 "live"——loop 活着，只是发线面是重启残影）。
    const liveWire = loop.session.lastWireRequest;
    const cached = liveWire === null ? deps.wireCache?.read(sessionID) ?? null : null;
    sendJson(res, 200, buildContextFullV2({
      sessionID,
      capturedAt: Date.now(),
      systemPrompt: loop.session.systemPrompt,
      assembly: currentAssembly ?? lastAssembly,
      messages: loop.session.messages,
      contextWindow,
      wireSnapshot: liveWire ?? cached?.snapshot ?? null,
      providerPayload: liveWire !== null
        ? loop.session.lastProviderPayload
        : cached?.providerPayload ?? null,
      wireSource: liveWire !== null ? "live" : cached !== null ? "cache" : "live",
      manifest: resolveManifest(deps),
    }));
  });

  // W51 auto-compaction live 境界只读面（SessionCompactionResponse 硬合同，键名逐字节冻结）：
  // 读前先 `loop.hydrate()`（T7b，记忆化）：重启后 durable `compaction_boundary` 会被重放进
  // live view（restored=true、coveredCount=1），首次查询即得真境界并回写压缩缓存——
  // 而不是把旧缓存残影当成现状。内存现读 + live view 缺席时回落压缩缓存（W52 跨重启快照）。
  // 未知/无 live loop sid = 404 session_not_found（与 /status、/abort 同参数与 404 纪律）；
  // status:"none" 是合法诚实面非异常。
  router.add("GET", "/sessions/:sessionID/compaction", async (_req, res, ctx) => {
    const sessionID = paramSessionID(ctx);
    if (!registry.isKnownSession(sessionID)) {
      throw new HttpError(404, "session_not_found", `no session ${sessionID}`);
    }
    const loop = registry.loopOf(sessionID) ?? registry.ensure(sessionID).loop;
    await loop.hydrate();
    const view = loop.session.compactionView;
    if (view === null) {
      const cached = registry.compactionCacheOf(sessionID);
      if (cached !== null) {
        sendJson(res, 200, cached);
        return;
      }
      const totalMessages = loop.session.messages.length;
      const body: SessionCompactionResponse = {
        sessionID,
        status: "none",
        coveredCount: null,
        summaryText: null,
        anchorMessageId: null,
        anchorTimestampMs: null,
        tailCount: totalMessages,
        totalMessages,
      };
      sendJson(res, 200, body);
      return;
    }
    const body: SessionCompactionResponse = {
      sessionID,
      status: "active",
      coveredCount: view.coveredCount,
      summaryText: view.summaryText,
      anchorMessageId: view.anchorMessageId,
      anchorTimestampMs: view.anchorTimestampMs,
      tailCount: view.totalMessages - view.coveredCount,
      totalMessages: view.totalMessages,
    };
    registry.saveCompactionCache(sessionID, body);
    sendJson(res, 200, body);
  });

  // C2 历史压缩摘要只读面：与 /compaction 同一 404 纪律（isKnownSession），已知但无压缩史
  // = 200 {sessionID, events: []}。数据面 = registry.compactionsView（boundary + 事件日志 +
  // live/cache seed，见 compaction-history.ts）；本端点只做参数/404/序列化。
  router.add("GET", "/sessions/:sessionID/compactions", async (_req, res, ctx) => {
    const sessionID = paramSessionID(ctx);
    if (!registry.isKnownSession(sessionID)) {
      throw new HttpError(404, "session_not_found", `no session ${sessionID}`);
    }
    const view = await registry.compactionsView(sessionID);
    if (view === undefined) {
      throw new HttpError(404, "session_not_found", `no session ${sessionID}`);
    }
    sendJson(res, 200, view);
  });
}
