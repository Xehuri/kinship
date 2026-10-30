/**
 * T28 验收：任务/运行域 API（dispatch / list / detail join ledger+trace / cancel / rerun / pause）。
 *
 * 逐条对 docs/02 §T28 验收标准 + 任务冻结项：
 *   - dispatch 开 run（202，响应含 run_id/attempt/trigger/status）；actor 落账（控制审计行）；
 *   - detail join ledger（D15 expected/actual）+ trace（T21 span）+ attempt 链；
 *   - cancel / rerun 工作（rerun 新 run：parent_run=源、attempt+1、trigger=manual）；
 *   - side→side 拒绝透传（403 + 审计留痕）；
 *   - pause 开关只读查询 + 暂停反映到 dispatch（409 paused，账本零痕迹 D31）；
 *   - 崩溃形状缺口如实暴露（expected 无 actual）。
 *
 * 端口纪律：listen(0) ephemeral + afterEach closeAllConnections（无泄漏）；
 * 真 Ledger（adapters，tmpdir 文件）+ 假执行端口；无网络无真定时器轮询上限 10s。
 */

import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Tracer } from "@axeuh/loom-core";
import {
  RunEngine,
  type RunSessionPort,
} from "@axeuh/loom-core/run-engine";
import { ControlPlane, MemoryControlAudit, type ControlAuditEntry } from "@axeuh/loom-core/control";
import type { SubTaskRecord } from "@axeuh/loom-core/kernel";
import {
  MemoryPauseAudit,
  PauseAdmission,
  PauseSwitchBoard,
} from "@axeuh/loom-core/pause";
import { Ledger } from "@axeuh/loom-adapters";

import { Router } from "../http/router.js";
import { mergeTaskViews } from "./ledger-sub-views.js";
import { registerTaskRoutes, type RunDetailView, type RunView } from "./index.js";
import type { TaskApiDeps, TaskSurfaceSource, TaskDetailView, TaskView } from "./types.js";

const GOOD_TOKEN = "tok-task-api";
const WAIT_MS = 10_000;

/** 执行端口：quick=秒完；slow=挂起到 abort；boom=崩溃形状（不写 actual）。 */
const port: RunSessionPort = {
  async run(ctx) {
    if (ctx.row.workflow === "boom") throw new Error("executor exploded");
    if (ctx.row.workflow === "slow") {
      await new Promise<void>((resolve) => {
        if (ctx.signal.aborted) {
          resolve();
        } else {
          ctx.signal.addEventListener("abort", () => resolve(), { once: true });
        }
      });
      return { status: "failed", digest: "cancelled by control", pointers: [], blockers: [] };
    }
    return { status: "done", digest: "quick done", pointers: ["art/a.txt"], blockers: [] };
  },
};

let server: Server | null = null;
let baseUrl = "";
let workDir = "";
let engine: RunEngine;
let plane: ControlPlane;
let controlAudit: MemoryControlAudit;
let pauseAudit: MemoryPauseAudit;
let board: PauseSwitchBoard;
let ledger: Ledger;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "loom-task-api-t28-"));
  ledger = new Ledger(join(workDir, "ledger.jsonl"));
  board = new PauseSwitchBoard();
  controlAudit = new MemoryControlAudit();
  pauseAudit = new MemoryPauseAudit();
  engine = new RunEngine({
    ledger,
    sessionPort: port,
    admission: new PauseAdmission({ switches: () => board.read(), audit: pauseAudit }),
  });
  plane = new ControlPlane({ engine, audit: controlAudit });
});

afterEach(async () => {
  const s = server;
  server = null;
  if (s !== null) {
    s.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      s.close((err) => (err ? reject(err) : resolve()));
    });
  }
  rmSync(workDir, { recursive: true, force: true });
});

async function listen(traceStateRoot?: string): Promise<void> {
  const router = new Router({ tokens: [GOOD_TOKEN] });
  registerTaskRoutes(router, {
    engine,
    plane,
    pauseSwitches: () => board.read(),
    ledgerRows: () => ledger.rows(),
    ...(traceStateRoot === undefined ? {} : { trace: { stateRoot: traceStateRoot } }),
  });
  server = createServer(router.toRequestHandler());
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
}

function auth(): Record<string, string> {
  return { Authorization: `Bearer ${GOOD_TOKEN}` };
}

async function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { ...auth(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function getJson(path: string, opts: { token?: boolean } = {}): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { headers: opts.token === false ? {} : auth() });
}

async function jsonOf<T>(res: Response): Promise<T> {
  expect(res.status).toBeLessThan(500);
  return (await res.json()) as T;
}

/** 轮询引擎登记表直到 run 达终态（10s 上限，确定性收束由假端口保证）。 */
async function waitForTerminal(runId: string): Promise<RunDetailView> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const res = await getJson(`/runs/${runId}`);
    expect(res.status).toBe(200);
    const detail = await jsonOf<RunDetailView>(res);
    if (detail.status === "done" || detail.status === "partial" || detail.status === "failed") {
      return detail;
    }
    if (Date.now() > deadline) throw new Error(`timeout waiting terminal for ${runId}, status=${detail.status}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

function auditFor(action: ControlAuditEntry["action"]): ControlAuditEntry {
  const hit = controlAudit.entries.filter((e) => e.action === action).at(-1);
  if (hit === undefined) throw new Error(`no ${action} audit entry; got ${JSON.stringify(controlAudit.entries)}`);
  return hit;
}

// ───────────────────────── 测试 ─────────────────────────

describe("T28 任务/运行域 API", () => {
  it("dispatch 开 run：202 四必含字段 + actor 落账 + detail join ledger/trace + 链", async () => {
    await listen(workDir);
    const runId = "run_deadbeefdeadbeef";
    // 先写该 run 的 trace 行（T21 Tracer 真落盘，日期键同日）
    const tracer = new Tracer({ stateRoot: workDir });
    const trk = tracer.startRun({ runId, workflow: "quick" });
    const spn = trk.openSpan("queued");
    trk.closeSpan(spn);
    trk.finishRun("ok");

    const created = await postJson("/runs", { workflow: "quick", prompt: "开工", runId });
    expect(created.status).toBe(202);
    const body = await jsonOf<RunView & { run_id: string }>(created);
    expect(body.run_id).toBe(runId);
    expect(body.attempt).toBe(1);
    expect(body.trigger).toBe("manual");
    expect(body.status).toBe("running");

    const entry = auditFor("spawn");
    expect(entry.actor).toBe("http");
    expect(entry.accepted).toBe(true);
    expect(entry.run_id).toBe(runId);

    const list = await jsonOf<{ runs: RunView[]; count: number }>(await getJson("/runs"));
    expect(list.count).toBe(1);
    expect(list.runs[0]?.run_id).toBe(runId);

    const detail = await waitForTerminal(runId);
    expect(detail.status).toBe("done");
    expect(detail.terminal?.digest).toBe("quick done");
    expect(detail.ledger.expected_at).toBeTypeOf("number");
    expect(detail.ledger.actual?.status).toBe("done");
    const spans = detail.trace as readonly { kind: string; runId: string }[];
    expect(spans.some((s) => s.kind === "span" && s.runId === runId)).toBe(true);
    expect(detail.chain.length).toBe(1);
  }, WAIT_MS + 5_000);

  it("side→side 拒绝透传：403 稳定码 + 拒绝审计留痕 + 账本零痕迹", async () => {
    await listen();
    const rejected = await postJson("/runs", { workflow: "quick", prompt: "自派生", actor: "side" });
    expect(rejected.status).toBe(403);
    const errBody = (await rejected.json()) as { error: { code: string; message: string } };
    expect(errBody.error.code).toBe("side_to_side_forbidden");

    const entry = auditFor("spawn");
    expect(entry.actor).toBe("side");
    expect(entry.accepted).toBe(false);
    expect(entry.reason).toContain("D22");

    expect(ledger.rows().length).toBe(0);
    expect(engine.listRuns().length).toBe(0);
  }, WAIT_MS);

  it("cancel：accepted=true + actor 落账 + 端口收 signal 后 failed 盖棺", async () => {
    await listen();
    const created = await postJson("/runs", { workflow: "slow", prompt: "长跑" });
    expect(created.status).toBe(202);
    const runId = (await jsonOf<RunView & { run_id: string }>(created)).run_id;

    const cancelled = await postJson(`/runs/${runId}/cancel`, { reason: "user stop" });
    expect(cancelled.status).toBe(200);
    const outcome = await jsonOf<{ accepted: boolean; actor: string; reason: string }>(cancelled);
    expect(outcome.accepted).toBe(true);
    expect(outcome.actor).toBe("http");
    expect(outcome.reason).toBe("user stop");

    const entry = auditFor("cancel");
    expect(entry.actor).toBe("http");
    expect(entry.accepted).toBe(true);

    const detail = await waitForTerminal(runId);
    expect(detail.status).toBe("failed");
    expect(detail.cancel_requested).toBe("user stop");
    expect(detail.ledger.actual?.status).toBe("failed");
  }, WAIT_MS + 5_000);

  it("rerun：新 run attempt+1 trigger=manual parent=源；详情 attempt 链旧→新", async () => {
    await listen();
    const first = await jsonOf<{ run_id: string }>(
      await postJson("/runs", { workflow: "quick", prompt: "第一轮" }),
    );
    await waitForTerminal(first.run_id);

    const again = await postJson(`/runs/${first.run_id}/rerun`, { prompt: "第二轮" });
    expect(again.status).toBe(202);
    const second = await jsonOf<RunView & { run_id: string; parent_run: string | null }>(again);
    expect(second.run_id).not.toBe(first.run_id);
    expect(second.attempt).toBe(2);
    expect(second.trigger).toBe("manual");
    expect(second.parent_run).toBe(first.run_id);

    const entry = auditFor("rerun");
    expect(entry.actor).toBe("http");
    expect(entry.parent_run).toBe(first.run_id);
    expect(entry.attempt).toBe(2);

    const detail = await waitForTerminal(second.run_id);
    expect(detail.chain.length).toBe(2);
    expect(detail.chain[0]?.run_id).toBe(first.run_id);
    expect(detail.chain[1]?.run_id).toBe(second.run_id);
    expect(detail.chain[0]?.attempt).toBe(1);
  }, WAIT_MS + 5_000);

  it("pause：只读查询 + 开关反映到 dispatch（409 paused、账本零痕迹、审计留痕）", async () => {
    await listen();
    const off = await jsonOf<{ global: boolean; per_workflow: Record<string, boolean> }>(await getJson("/pause"));
    expect(off.global).toBe(false);
    expect(off.per_workflow).toEqual({});

    board.setWorkflow("quick", true);
    const wf = await jsonOf<{ global: boolean; per_workflow: Record<string, boolean> }>(await getJson("/pause"));
    expect(wf.global).toBe(false);
    expect(wf.per_workflow["quick"]).toBe(true);

    const blocked = await postJson("/runs", { workflow: "quick", prompt: "暂停期" });
    expect(blocked.status).toBe(409);
    const blockedBody = await jsonOf<{ status: string; reason: string; run_id: string }>(blocked);
    expect(blockedBody.status).toBe("paused");
    expect(blockedBody.reason).toBe("paused");
    expect(ledger.rows().length).toBe(0);
    expect(pauseAudit.entries.length).toBe(1);
    expect(pauseAudit.entries[0]?.scope).toBe("workflow");

    board.setWorkflow("quick", false);
    board.setGlobal(true);
    const on = await jsonOf<{ global: boolean }>(await getJson("/pause"));
    expect(on.global).toBe(true);
    const blocked2 = await postJson("/runs", { workflow: "other", prompt: "全局暂停期" });
    expect(blocked2.status).toBe(409);

    board.setGlobal(false);
    const allowed = await postJson("/runs", { workflow: "other", prompt: "恢复后" });
    expect(allowed.status).toBe(202);
  }, WAIT_MS + 5_000);

  it("崩溃形状：boom 端口抛炸 → 详情如实暴露缺口（expected 无 actual）", async () => {
    await listen();
    const created = await postJson("/runs", { workflow: "boom", prompt: "炸" });
    const runId = (await jsonOf<{ run_id: string }>(created)).run_id;
    const detail = await waitForTerminal(runId);
    expect(detail.status).toBe("failed");
    expect(detail.crashed).toBe(true);
    expect(detail.ledger.expected_at).toBeTypeOf("number");
    expect(detail.ledger.actual).toBeNull();
    expect(ledger.gaps()).toContain(runId);
  }, WAIT_MS + 5_000);

  it("边界与鉴权：无 token 401、非法 runID 400、未知 run 404、坏 body 400", async () => {
    await listen();
    expect((await getJson("/runs", { token: false })).status).toBe(401);
    expect((await postJson("/runs", { workflow: "", prompt: "x" })).status).toBe(400);
    expect((await postJson("/runs", { workflow: "quick", prompt: "x", actor: "bogus" })).status).toBe(400);
    expect((await postJson("/runs", { workflow: "quick", prompt: "x", trigger: "bogus" })).status).toBe(400);
    const badId = await getJson("/runs/run-not-legal!");
    expect(badId.status).toBe(400);
    const missing = await getJson("/runs/run_aaaaaaaaaaaaaaaa");
    expect(missing.status).toBe(404);
    const cancelMissing = await postJson("/runs/run_bbbbbbbbbbbbbbbb/cancel", {});
    expect(cancelMissing.status).toBe(200);
    const cancelBody = await jsonOf<{ accepted: boolean; status: string }>(cancelMissing);
    expect(cancelBody.accepted).toBe(false);
    expect(cancelBody.status).toBe("unknown");
  }, WAIT_MS);
});

// ───────────────────────── W23-C /tasks 历史合流 ─────────────────────────

/** 造一条内核在飞册记录（SubTaskRecord 全形状；仅视图投影消费的字段给实值）。 */
function fakeSubRecord(over: {
  readonly taskId: string;
  readonly sessionId: string;
  readonly state: "running" | "done" | "failed";
  readonly dispatchedAt: number;
  readonly terminalAt: number | null;
  readonly title?: string; // W49.2：缺省=键整体缺席（旧形状），有值=在飞册直读投影
}): SubTaskRecord {
  const row = {
    run_id: over.taskId,
    workflow: "subagent.general",
    attempt: 1,
    trigger: "manual" as const,
    parent_run: null,
    session_id: over.sessionId,
  };
  return {
    kind: "sub",
    taskId: over.taskId,
    agentType: "general",
    parentSessionId: "main_sid_1",
    task: "合流测试正文",
    depth: 1,
    ...(over.title !== undefined ? { title: over.title } : {}),
    row,
    state: over.state,
    dispatchedAt: over.dispatchedAt,
    terminalAt: over.terminalAt,
    terminal: null,
    error: null,
    crashed: false,
    cancelRequested: null,
  };
}

/** 往真账本写一条 kind:"sub" 的 expected（+可选 actual），形状与 kernel.dispatchSubBackground 逐键同构。 */
function seedSubLedger(
  taskId: string,
  sessionId: string,
  opts: { at: number; actualAt?: number; actualStatus?: "done" | "failed"; title?: string },
): void {
  ledger.expected(taskId, opts.at, {
    run_id: taskId,
    workflow: "subagent.general",
    attempt: 1,
    trigger: "manual",
    parent_run: null,
    session_id: sessionId,
    kind: "sub",
    agent_type: "general",
    parent_session: "main_sid_1",
    ...(opts.title !== undefined ? { title: opts.title } : {}),
  });
  if (opts.actualAt !== undefined && opts.actualStatus !== undefined) {
    ledger.actual(taskId, opts.actualAt, opts.actualStatus, {
      at: opts.actualAt,
      status: opts.actualStatus,
      digest: "盖棺摘要",
      pointers: [],
      blockers: [],
    });
  }
}

function tasksFromKernel(records: readonly SubTaskRecord[]): TaskSurfaceSource {
  const byId = new Map(records.map((r) => [r.taskId, r]));
  return {
    list: () => records,
    get: (id) => byId.get(id),
    cancel: () => false,
  };
}

async function listenTasks(tasks: TaskSurfaceSource): Promise<void> {
  const router = new Router({ tokens: [GOOD_TOKEN] });
  const deps: TaskApiDeps = {
    engine,
    plane,
    pauseSwitches: () => board.read(),
    ledgerRows: () => ledger.rows(),
    tasks,
  };
  registerTaskRoutes(router, deps);
  server = createServer(router.toRequestHandler());
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
}

describe("W23-C /tasks 历史合流（内核在飞 ∪ 账本 sub）", () => {
  const LIVE_ID = "run_1111111111111111"; // 内核在册 + 账本也有（旧影）——live 优先格
  const HIST_ID = "run_2222222222222222"; // 账本-only 盖棺完成格
  const GAP_ID = "run_3333333333333333"; // 账本-only 缺口格（expected 无 actual）
  const HIST_SID = "ses_4444444444444444";

  it("list：run_id 并集 + live 优先 + in_memory 来源标 + 缺口如实（S-RESTART 视图格钉）", async () => {
    seedSubLedger(LIVE_ID, "ses_5555555555555555", { at: 100, actualAt: 150, actualStatus: "done" });
    seedSubLedger(HIST_ID, HIST_SID, { at: 200, actualAt: 260, actualStatus: "done" });
    seedSubLedger(GAP_ID, "ses_6666666666666666", { at: 300 });
    // S-RESTART 实况：重启后内核册=空数组；账本行仍在——历史不丢即由本格钉。
    await listenTasks(tasksFromKernel([]));
    const body = await jsonOf<{ tasks: TaskView[]; count: number }>(await getJson("/tasks"));
    expect(body.count).toBe(3);
    const byId = new Map(body.tasks.map((t) => [t.task_id, t]));
    const hist = byId.get(HIST_ID)!;
    expect(hist.status).toBe("done");
    expect(hist.agent_type).toBe("general");
    expect(hist.parent_session).toBe("main_sid_1");
    expect(hist.workflow).toBe("subagent.general");
    expect(hist.session_id).toBe(HIST_SID);
    expect(hist.dispatched_at).toBe(200);
    expect(hist.terminal_at).toBe(260);
    expect(hist.crashed).toBeNull(); // 不可导出 = null 诚实
    expect(hist.cancel_requested).toBeNull();
    expect(hist.error).toBeNull();
    expect("in_memory" in hist).toBe(false); // 账本-only：来源标键恒缺席
    const gap = byId.get(GAP_ID)!;
    expect(gap.status).toBe("running"); // /runs 账本回退先例同词（缺口不谎报终态）
    expect(gap.error).toBe("ledger gap: expected without actual");
    expect(gap.terminal_at).toBeNull();

    // live 优先：内核在飞行（state=running）盖过账本旧 done 影，且标 in_memory:true。
    // 换挂内核册需重开路由（同一 ledger 实例，账本行不动）。
    const s1 = server;
    if (s1 === null) throw new Error("listenTasks 未挂 server");
    s1.closeAllConnections();
    await new Promise<void>((resolve, reject) => s1.close((e) => (e ? reject(e) : resolve())));
    server = null;
    const liveRec = fakeSubRecord({ taskId: LIVE_ID, sessionId: "ses_5555555555555555", state: "running", dispatchedAt: 100, terminalAt: null });
    await listenTasks(tasksFromKernel([liveRec]));
    const merged = await jsonOf<{ tasks: TaskView[] }>(await getJson("/tasks"));
    const liveView = merged.tasks.find((t) => t.task_id === LIVE_ID)!;
    expect(merged.tasks.filter((t) => t.task_id === LIVE_ID)).toHaveLength(1); // 并集去重
    expect(liveView.status).toBe("running"); // 新鲜态胜出
    expect(liveView.in_memory).toBe(true);
    // 内核行排前、账本-only 按账本序追加（呈现序稳定）。
    expect(merged.tasks.map((t) => t.task_id)).toEqual([LIVE_ID, HIST_ID, GAP_ID]);
  }, WAIT_MS);

  it("detail：内核路径带 task/depth/in_memory；账本-only 回落 200（task/depth/terminal=null 如实）；未知 404；/runs 纯度不渗", async () => {
    seedSubLedger(HIST_ID, HIST_SID, { at: 200, actualAt: 260, actualStatus: "done" });
    const liveRec = fakeSubRecord({ taskId: LIVE_ID, sessionId: "ses_5555555555555555", state: "done", dispatchedAt: 100, terminalAt: 140 });
    await listenTasks(tasksFromKernel([liveRec]));

    const detail = await jsonOf<TaskDetailView>(await getJson(`/tasks/${LIVE_ID}`));
    expect(detail.task).toBe("合流测试正文");
    expect(detail.depth).toBe(1);
    expect(detail.in_memory).toBe(true);

    const histDetail = await jsonOf<TaskDetailView>(await getJson(`/tasks/${HIST_ID}`));
    expect(histDetail.status).toBe("done");
    expect(histDetail.task).toBeNull(); // 正文从未入账本 = null 诚实（不造空串）
    expect(histDetail.depth).toBeNull();
    expect(histDetail.terminal).toBeNull(); // 同 /runs 账本回退先例
    expect(histDetail.ledger.actual).not.toBeNull();
    expect(histDetail.ledger.expected_at).toBe(200);
    expect("in_memory" in histDetail).toBe(false);

    const missing = await getJson(`/tasks/run_ffffffffffffffff`);
    expect(missing.status).toBe(404);

    // 契约纯度：sub 行绝不渗入 /runs 列表/详情（w9s3 红线在合流后的账本面上重钉）。
    const runs = await jsonOf<{ runs: RunView[] }>(await getJson("/runs"));
    expect(runs.runs.map((r) => r.run_id)).not.toContain(HIST_ID);
    expect((await getJson(`/runs/${HIST_ID}`)).status).toBe(404);
  }, WAIT_MS);

  it("未接 tasks 面：GET /tasks 仍 404 not_wired（合流不给未装配面凭空开路，旧调用面零扰动）", async () => {
    await listen();
    expect((await getJson("/tasks")).status).toBe(404);
    expect((await getJson("/tasks/run_7777777777777777")).status).toBe(404);
  }, WAIT_MS);
});

// ───────────────────────── W49.2 /tasks title 投影 ─────────────────────────

describe("W49.2 /tasks title：live/ledger/legacy 三格 + fsync→重放 roundtrip", () => {
  const T_TITLE = "10-16 夜间 · 折扣审计";
  const LEDGER_TITLED = "run_aaaaaaaa00000001"; // 账本行带 title
  const LEDGER_LEGACY = "run_aaaaaaaa00000002"; // 旧行无 title 键 → null 诚实，不造假值
  const LIVE_TITLED = "run_aaaaaaaa00000003"; // 内核在飞行带 title
  const LIVE_PLAIN = "run_aaaaaaaa00000004"; // 内核在飞行无 title（旧调用面）

  it("list+detail：四格投影各如其源；live title 直读登记册、ledger title 取 expected payload、legacy=null", async () => {
    seedSubLedger(LEDGER_TITLED, "ses_bbbbbbbbbbbb0001", { at: 100, actualAt: 150, actualStatus: "done", title: T_TITLE });
    seedSubLedger(LEDGER_LEGACY, "ses_bbbbbbbbbbbb0002", { at: 200, actualAt: 260, actualStatus: "done" });
    const live = [
      fakeSubRecord({ taskId: LIVE_TITLED, sessionId: "ses_bbbbbbbbbbbb0003", state: "running", dispatchedAt: 300, terminalAt: null, title: "在飞标题" }),
      fakeSubRecord({ taskId: LIVE_PLAIN, sessionId: "ses_bbbbbbbbbbbb0004", state: "running", dispatchedAt: 400, terminalAt: null }),
    ];
    await listenTasks(tasksFromKernel(live));
    const body = await jsonOf<{ tasks: TaskView[] }>(await getJson("/tasks"));
    const byId = new Map(body.tasks.map((t) => [t.task_id, t]));
    expect(byId.get(LEDGER_TITLED)!.title).toBe(T_TITLE);
    expect(byId.get(LEDGER_LEGACY)!.title).toBeNull();
    expect(byId.get(LIVE_TITLED)!.title).toBe("在飞标题");
    expect(byId.get(LIVE_PLAIN)!.title).toBeNull();

    // 详情两面同键：live=taskDetailOf 直读、ledger-only=taskDetailFromLedger 走 base 展开。
    const dTitled = await jsonOf<TaskView>(await getJson(`/tasks/${LEDGER_TITLED}`));
    expect(dTitled.title).toBe(T_TITLE);
    const dLive = await jsonOf<TaskView>(await getJson(`/tasks/${LIVE_TITLED}`));
    expect(dLive.title).toBe("在飞标题");
  }, WAIT_MS);

  it("fsync→重放 roundtrip（boot-task-ledger 同构取证，单元口径不占端口）：新 Ledger 实例读同一盘，title 逐字节存活；旧行无键=null", () => {
    seedSubLedger("run_cccccccc00000001", "ses_dddddddddddd0001", { at: 1000, title: "盖棺前重启" });
    seedSubLedger("run_cccccccc00000002", "ses_dddddddddddd0002", { at: 1100 }); // 旧 9 键行形状（W49.2 前落盘）
    // 真 fsync 文件重开 = S-RESTART 观察面的最小同构（boot-task-ledger.test.ts 全树版的单元镜像）。
    const replayed = new Ledger(join(workDir, "ledger.jsonl"));
    const views = mergeTaskViews([], replayed.rows());
    const byId = new Map(views.map((v) => [v.task_id, v]));
    expect(byId.get("run_cccccccc00000001")!.title).toBe("盖棺前重启");
    expect(byId.get("run_cccccccc00000002")!.title).toBeNull();
  });
});
