/**
 * T34 黄金路径「数据检查批」端到端（docs/02 §T34；决策 docs/01 D5/D16/D19/D22/D23/D25/D26/D32）。
 *
 * 一条链跑穿全部真件：workflow yaml（本目录 fixtures/，不动 fixture-workspace/）
 *   → parseTriggerDefinition + TriggerScheduler 假时钟 tick 命中 12:00（不真等 cron）
 *   → RunEngine.dispatch → createSideSessionPort（全新副会话）+ 假模型（server fake-model）
 *   → 工具轮：check_data（script-host 挂载真跑 python3）→ read 事实 → write 批次理解
 *     → bash（seam ToolExecutor 真跑 render_commit_body.py）
 *   → 收束轮：正文+converge 同轮（D26）→ done 盖棺
 *   → 真 Ledger expected/actual 齐 → core/receipt 三项验证 PASS → 投主【副会话回执】
 *   → 第二批 manual 触发：全新会话零残留（D19）
 *   → Reconciler 重启语义重放：零缺口
 *   → 红线：axeuh-health-monitor/** 与仓库 fixture-workspace/ 前后 mtime 快照对比
 *     零漂移（hm 只允许活体服务既有写入面白名单内漂移）+ 产物名探测 + 沙箱包含性
 *   → seam 咽喉负例：越界写/被禁命令 → SeamDeniedError + 审计 deny。
 */

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { DEFAULT_LIMITS, type HarnessTool } from "@axeuh/loom-core";
import {
  buildReceipt,
  manifestFromPointers,
  MemoryReceiptDelivery,
  RECEIPT_MARK,
  receiptMessage,
  runVerification,
  verificationFailed,
  type ManifestEntry,
} from "@axeuh/loom-core/receipt";
import {
  createSideSessionPort,
  RunEngine,
  type ArtifactSnapshot,
  type DeadLetterPayload,
  type DispatchInput,
  type DispatchResult,
  type RunRecord,
  type RunRow,
} from "@axeuh/loom-core/run-engine";
import { MapCatchupPolicy, Reconciler } from "@axeuh/loom-core/recovery";
import { parseTriggerDefinition, TriggerScheduler } from "@axeuh/loom-core/trigger";
import { Ledger, StateLayout, stateDateKey } from "@axeuh/loom-adapters";
import { SeamDeniedError } from "@axeuh/loom-tools/seam";
import type { HostLogEntry } from "@axeuh/loom-tools/script-host";
import type { FakeModel } from "@axeuh/loom-core/testing";

import {
  blueprintCommitBodyAssertion,
  BATCH_CONTENT,
  BATCH_REL,
  buildRun1Model,
  buildRun2Model,
  COMMIT_REL,
  FACTS_REL,
  FsArtifactProbe,
  HEALTH_MONITOR_ROOT,
  makeSandbox,
  REPO_FIXTURE_WS,
  REPORT_REL,
  RUN1_ID,
  RUN1_MARKER,
  RUN2_ID,
  RUN2_MARKER,
  SCENE_BATCH,
  SCENE_DATE,
  SCENE_WORKFLOW,
  SCENE_WINDOW,
  SES1_ID,
  SES2_ID,
  TEMPLATE_WORKFLOW_YAML,
  type Sandbox,
} from "./scene.js";
import {
  makeSeamExecutor,
  makeSessionTools,
  type CheckFact,
  type SeamWiring,
} from "./tools.js";
import {
  findFileNames,
  isLiveServiceDrift,
  listFilesRecursive,
  snapshotDrift,
  snapshotMtrees,
} from "./redline.js";

/* ────────────── 常量 ────────────── */

const SCAN_MS = 240_000;
const RUN_MS = 240_000;
/** 固定起点（UTC 日分片键 = 2026-10-08）；引擎时钟从此起单调步进。 */
const START_MS = Date.UTC(2026, 9, 8, 4, 0, 0);
/** cron 命中时刻：本地 12:00（matchesCron 只读本地字段，与 TZ 无关）。 */
const TICK_AT = new Date(2026, 9, 8, 12, 0, 0, 0);

function nth<T>(items: ReadonlyArray<T>, i: number): T {
  const v = items[i];
  if (v === undefined) throw new Error(`no element at index ${i}`);
  return v;
}

function launchedOf(res: DispatchResult): Extract<DispatchResult, { kind: "launched" }> {
  if (res.kind !== "launched") throw new Error(`expected launched, got ${res.kind}`);
  return res;
}

function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/* ────────────── 场景共享态（用例顺序即链路顺序） ────────────── */

interface Bag {
  sandbox: Sandbox;
  seam: SeamWiring;
  checkLogs: HostLogEntry[];
  checkFacts: CheckFact[];
  published: ArtifactSnapshot[];
  deadLetters: DeadLetterPayload[];
  ledgerPath: string;
  models: FakeModel[];
  rec1?: RunRecord;
  row1?: RunRow;
  rec2?: RunRecord;
  row2?: RunRow;
  hmBefore?: Map<string, string>;
  fwBefore?: Map<string, string>;
}

const bag = {} as Bag;

afterAll(() => {
  for (const m of bag.models ?? []) m.teardown();
  bag.sandbox?.cleanup();
});

describe("T34 黄金路径：数据检查批（trigger→run-engine→收束→账本→receipt→recovery→红线→seam）", () => {
  beforeAll(() => {
    bag.sandbox = makeSandbox();
    bag.seam = makeSeamExecutor(bag.sandbox.workspace);
    bag.checkLogs = [];
    bag.checkFacts = [];
    bag.published = [];
    bag.deadLetters = [];
    bag.models = [];
    const layout = new StateLayout({ root: bag.sandbox.stateRoot });
    bag.ledgerPath = layout.dayPath("ledger", stateDateKey(START_MS));
    // 红线基线：生产树 + 仓库 fixture-workspace（跑测试前先照一张全树 mtime 相）
    bag.hmBefore = snapshotMtrees(HEALTH_MONITOR_ROOT, SCAN_MS, ["loom-harness"]);
    bag.fwBefore = snapshotMtrees(REPO_FIXTURE_WS, SCAN_MS);
  }, SCAN_MS * 2);

  /* ── 1. 黄金批主链路 ── */

  it(
    "cron假时钟→全新副会话→script-host真跑→收束done→账本齐→receipt三项PASS→投主",
    async () => {
      const { sandbox, seam } = bag;
      const ledger = new Ledger(bag.ledgerPath);
      const model1 = buildRun1Model(SCENE_WORKFLOW);
      bag.models.push(model1);
      let clockStep = 0;
      const tools: HarnessTool[] = makeSessionTools(
        sandbox.workspace,
        seam,
        bag.checkLogs,
        bag.checkFacts,
      );
      const engine = new RunEngine({
        ledger,
        sessionPort: createSideSessionPort({ model: model1, tools }),
        artifactSink: { publish: (s) => void bag.published.push(s) },
        deadLetterSink: { emit: (p) => void bag.deadLetters.push(p) },
        now: () => START_MS + (clockStep += 1) * 1000,
      });

      // 触发段：真 yaml 声明 → 真 parseTriggerDefinition → 假时钟 tick（不真等 cron）
      const def = parseTriggerDefinition(
        parseYaml(readFileSync(TEMPLATE_WORKFLOW_YAML, "utf8")),
        "data-check.yaml",
      );
      expect(def.enabled).toBe(true);
      expect(def.catchup).toBe("latest");
      expect(def.cron).toBe("0 12 * * *");
      expect(def.prompt).toContain(RUN1_MARKER);

      let launchedRes: DispatchResult | undefined;
      const scheduler = new TriggerScheduler({
        definitions: [def],
        onSubmit: async (spec) => {
          const input: DispatchInput = {
            workflow: spec.workflow,
            prompt: spec.prompt,
            trigger: spec.trigger,
            runId: RUN1_ID,
            sessionId: SES1_ID,
          };
          launchedRes = await engine.dispatch(input);
        },
      });
      // 提前 1 分钟不命中；12:00 命中一次；同分钟再 tick 幂等（表驱动，无真定时器）
      expect(await scheduler.tick(new Date(2026, 9, 8, 11, 59, 0))).toHaveLength(0);
      const submitted = await scheduler.tick(TICK_AT);
      expect(submitted).toHaveLength(1);
      expect(nth(submitted, 0).trigger).toBe("cron");
      expect(await scheduler.tick(TICK_AT)).toHaveLength(0); // 同分钟幂等
      if (launchedRes === undefined) throw new Error("onSubmit 未触发");
      const launched = launchedOf(launchedRes);
      const rec1 = await launched.completion;
      bag.rec1 = rec1;
      bag.row1 = launched.row;

      // —— 引擎/账本：全新副会话 + done 盖棺 + 零死信 ——
      expect(rec1.state).toBe("done");
      expect(rec1.crashed).toBe(false);
      expect(rec1.row.run_id).toBe(RUN1_ID);
      expect(rec1.row.session_id).toBe(SES1_ID);
      expect(rec1.row.trigger).toBe("cron");
      expect(rec1.row.workflow).toBe(SCENE_WORKFLOW);
      expect(rec1.row.attempt).toBe(1);
      expect(bag.deadLetters).toHaveLength(0);
      const terminal = rec1.terminal;
      if (terminal === null) throw new Error("done 必有 TerminalSnapshot");
      expect(terminal.status).toBe("done");
      expect(terminal.forceReason).toBeUndefined();
      // D26 正文+收束同轮：恰好两个 LLM 回合（一工具轮 + 一收束轮），零额外往返
      expect(model1.getCalls()).toHaveLength(2);
      // 收束轮入参含全部干活结果（读到的事实、check 的 fact、commit-body 落盘行）
      const convergeCall = JSON.stringify(nth(model1.getCalls(), 1));
      expect(convergeCall).toContain("data_check.py 机械转录");
      expect(convergeCall).toContain("check-report.json");
      expect(convergeCall).toContain("commit-body 已落盘");
      // script-host 真跑：fact 事件 6/6 全过、无 warn/error、无孤儿 pid
      const fact = nth(bag.checkFacts, 0);
      expect(fact).toMatchObject({ checked: 6, total: 6, ok: true });
      expect(bag.checkLogs.some((l) => l.level === "warn" || l.level === "error")).toBe(false);
      // 产物内容：批次文件逐字 = 模型正文；fact 报告的 line_count 与磁盘行数一致
      expect(readFileSync(join(sandbox.workspace, BATCH_REL), "utf8")).toBe(BATCH_CONTENT);
      const factsDisk = readFileSync(join(sandbox.workspace, FACTS_REL), "utf8");
      expect(factsDisk.split("\n").filter((l) => l !== "").length).toBeGreaterThanOrEqual(fact.line_count - 1);
      expect(factsDisk).toContain("13:45");
      const commitBody = readFileSync(join(sandbox.workspace, COMMIT_REL), "utf8");
      expect(commitBody.startsWith("## 任务概要")).toBe(true);
      expect(commitBody).toContain("## 工作过程评价");

      // 产物快照 sink = pointers 全量
      expect(nth(bag.published, 0).run_id).toBe(RUN1_ID);
      expect(nth(bag.published, 0).artifacts).toEqual(terminal.pointers);

      // —— receipt 验证（core/receipt 真件，harness 代跑三项预验）——
      const manifest: ManifestEntry[] = [
        { path: BATCH_REL, sha256: sha256Text(BATCH_CONTENT) },
        { path: COMMIT_REL },
        { path: REPORT_REL },
      ];
      const probe = new FsArtifactProbe(sandbox.workspace);
      const block = runVerification(
        {
          pointers: terminal.pointers,
          manifest,
          commitBody,
          coverage: { checked: fact.checked, total: fact.total },
        },
        { artifactProbe: probe, commitBodyAssertion: blueprintCommitBodyAssertion },
      );
      expect(verificationFailed(block)).toBe(false);
      expect([block.manifest.verdict, block.commit_body.verdict, block.coverage.verdict]).toEqual([
        "pass",
        "pass",
        "pass",
      ]);
      const harnessReceipt = buildReceipt({ row: launched.row, result: terminal, verification: block });
      // identity 以账本 RunRow 为真源（模型自述的 run_deadbeef… 被忽略）
      expect(harnessReceipt.run_id).toBe(RUN1_ID);
      expect(harnessReceipt.workflow).toBe(SCENE_WORKFLOW);
      expect(harnessReceipt.status).toBe("done"); // 全 pass ⇒ 不降级
      expect(harnessReceipt.attempt).toBe(1);
      expect(harnessReceipt.pointers).toEqual(terminal.pointers);

      // 投主（D23）：【副会话回执】+ 三 verdict + digest 一行
      const delivery = new MemoryReceiptDelivery();
      delivery.deliver(harnessReceipt);
      expect(delivery.delivered).toHaveLength(1);
      const msg = receiptMessage(harnessReceipt);
      expect(msg.startsWith(RECEIPT_MARK)).toBe(true);
      expect(msg).toContain(`run=${RUN1_ID}`);
      expect(msg).toContain("status=done");
      expect(msg).toContain("[manifest=pass commit_body=pass coverage=pass]");

      // 账本盘上真相：expected+actual 成对、零缺口（D15）
      const rows = new Ledger(bag.ledgerPath).rows();
      expect(rows.map((r) => r.t)).toEqual(["expected", "actual"]);
      expect(new Ledger(bag.ledgerPath).gaps()).toEqual([]);
      const actualRow = nth(
        rows.filter((r) => r.t === "actual"),
        0,
      );
      if (actualRow.t !== "actual") throw new Error("unreachable");
      expect(actualRow.status).toBe("done");
      const actualPayload = actualRow.payload as { digest: string; pointers: readonly string[] };
      expect(actualPayload.digest).toContain(`批次${SCENE_BATCH}`);
      expect(actualPayload.pointers.length).toBeGreaterThan(0);
      // manifestFromPointers：git: 前缀指针不进文件清单
      expect(manifestFromPointers(terminal.pointers).map((e) => e.path)).toEqual([
        BATCH_REL,
        COMMIT_REL,
        REPORT_REL,
      ]);
      // 窗口参数在链路里流动（fact 事件与窗口一致）
      expect(SCENE_WINDOW).toBe("12:00~13:59");
    },
    RUN_MS,
  );

  /* ── 2. 第二批：全新副会话零残留（D19） ── */

  it(
    "manual触发第二批：全新副会话，上下文零残留第一批痕迹；账本双批次成对",
    async () => {
      const { sandbox, seam } = bag;
      const ledger = new Ledger(bag.ledgerPath);
      const model2 = buildRun2Model(SCENE_WORKFLOW);
      bag.models.push(model2);
      let clockStep = 0;
      const engine2 = new RunEngine({
        ledger,
        sessionPort: createSideSessionPort({
          model: model2,
          tools: makeSessionTools(sandbox.workspace, seam, bag.checkLogs, bag.checkFacts),
        }),
        artifactSink: { publish: (s) => void bag.published.push(s) },
        now: () => START_MS + 1000 * 1000 + (clockStep += 1) * 1000,
      });
      const launched2 = launchedOf(
        await engine2.dispatch({
          workflow: SCENE_WORKFLOW,
          prompt: `【手动派发】批次14 空窗口补跑 ${RUN2_MARKER}`,
          trigger: "manual",
          runId: RUN2_ID,
          sessionId: SES2_ID,
        }),
      );
      const rec2 = await launched2.completion;
      bag.rec2 = rec2;
      bag.row2 = launched2.row;
      expect(rec2.state).toBe("done");
      expect(rec2.row.trigger).toBe("manual");
      // 全新会话：第二批首个 LLM 上下文的 messages = 只有第二批 prompt，无第一批任何痕迹
      // （只序列化 messages：tools 定义数组里本就含 check_data 描述，不属于残留面）
      const firstCall = JSON.stringify(nth(model2.getCalls(), 0).messages);
      expect(firstCall).toContain(RUN2_MARKER);
      expect(firstCall).not.toContain(RUN1_MARKER);
      expect(firstCall).not.toContain("data_check.py");
      // 账本双批次 2×(expected+actual)，仍零缺口；第二批 session/run 与第一批不同
      const rows = new Ledger(bag.ledgerPath).rows();
      expect(rows.map((r) => r.t)).toEqual(["expected", "actual", "expected", "actual"]);
      expect(new Ledger(bag.ledgerPath).gaps()).toEqual([]);
      expect(rec2.row.session_id).not.toBe(bag.row1?.session_id);
      expect(rec2.row.parent_run).toBeNull();
      // 产物只多了一个批次14 文件，且仍在工作区内
      const dayFiles = listFilesRecursive(join(sandbox.workspace, "data", "daily", SCENE_DATE));
      expect(dayFiles).toContain(`理解-${SCENE_DATE}-批次-14.md`);
    },
    RUN_MS,
  );

  /* ── 3. recovery（T13）重启语义：账本齐 → 对账零动作 ── */

  it("recovery重启重放：expected/actual 全配对，无缺口，catchup 计划为空", async () => {
    const reopened = new Ledger(bag.ledgerPath); // 新实例 = 进程重启语义（真相只在账本文件）
    const reconciler = new Reconciler({
      ledger: reopened,
      policy: new MapCatchupPolicy(new Map([[SCENE_WORKFLOW, "latest"]]), "none"),
      limits: DEFAULT_LIMITS,
    });
    const plan = reconciler.replay();
    expect(plan.scanned).toBe(4);
    expect(plan.gapRunIds).toEqual([]);
    expect(plan.actions).toEqual([]);
    const applied = await reconciler.apply(plan);
    expect(applied).toEqual({ resumed: 0, dispatched: 0, deadLettered: 0, skipped: 0 });
  });

  /* ── 4. 验证不掺水：产物缺失/越界指针 ⇒ fail ⇒ 降级 partial ── */

  it("manifest缺失与越界指针 ⇒ fail populated ⇒ done降级partial（不静默假完成）", () => {
    const { sandbox } = bag;
    const terminal = bag.rec1?.terminal;
    const row1 = bag.row1;
    if (terminal === null || terminal === undefined || row1 === undefined) throw new Error("主链路未跑");
    const probe = new FsArtifactProbe(sandbox.workspace);
    // 声明一个不存在的产物 ⇒ fail 且 detail 点名
    const block = runVerification(
      {
        pointers: [...terminal.pointers, `file:data/daily/${SCENE_DATE}/理解-不存在.md`],
        commitBody: readFileSync(join(sandbox.workspace, COMMIT_REL), "utf8"),
        coverage: { checked: 6, total: 6 },
      },
      { artifactProbe: probe, commitBodyAssertion: blueprintCommitBodyAssertion },
    );
    expect(block.manifest.verdict).toBe("fail");
    expect(block.manifest.detail).toContain("不存在");
    expect(verificationFailed(block)).toBe(true);
    const downgraded = buildReceipt({
      row: row1,
      result: { status: "done", digest: terminal.digest, pointers: terminal.pointers, blockers: [] },
      verification: block,
    });
    expect(downgraded.status).toBe("partial"); // done+fail ⇒ partial（映射表写死）
    // 探针自带越界防线：绝对路径越出沙箱 ⇒ 直接判不存在（红线双保险）
    expect(probe.probe(join(REPO_FIXTURE_WS, "AGENTS.md")).exists).toBe(false);
    expect(probe.probe("../../../axeuh-health-monitor/backend/config.py").exists).toBe(false);
  });

  /* ── 5. 只读红线：hm 白名单外全等 + 仓库 fixture-workspace 全等 + 产物名探测 ── */

  it(
    "只读红线：axeuh-health-monitor/** 前后mtime快照全等（活体服务白名单外零漂移）+ fixture-workspace/** 全等",
    () => {
      if (bag.hmBefore === undefined || bag.fwBefore === undefined) throw new Error("基线未拍");
      // 生产树：白名单（ai/data/、backend/、.git/ = 活体服务既有写入面）之外必须全等
      const hmAfter = snapshotMtrees(HEALTH_MONITOR_ROOT, SCAN_MS, ["loom-harness"]);
      const hmDrift = snapshotDrift(bag.hmBefore, hmAfter, HEALTH_MONITOR_ROOT);
      const violations = hmDrift.filter((p) => !isLiveServiceDrift(p));
      expect(violations).toEqual([]);
      // 仓库 fixture-workspace：本测试独占静区，直接全等
      const fwAfter = snapshotMtrees(REPO_FIXTURE_WS, SCAN_MS);
      expect(snapshotDrift(bag.fwBefore, fwAfter, REPO_FIXTURE_WS)).toEqual([]);
      // 产物名探测：场景工件名绝不出现在 hm（哪怕 mtime 白名单也藏不住新文件名）
      expect(
        findFileNames(
          HEALTH_MONITOR_ROOT,
          [
            `理解-${SCENE_DATE}-批次-${SCENE_BATCH}.md`,
            `commit-body-${SCENE_DATE}-批次-${SCENE_BATCH}.txt`,
            `事实-${SCENE_DATE}-全天.md`,
          ],
          SCAN_MS,
          ["loom-harness"],
        ),
      ).toEqual([]);
      // 沙箱包含性：本场景写出的每一个文件都在沙箱内（fixture-workspace/ 或 state/）
      const all = listFilesRecursive(bag.sandbox.root);
      expect(all.length).toBeGreaterThan(6);
      for (const rel of all) {
        expect(rel.startsWith("fixture-workspace/") || rel.startsWith("state/")).toBe(true);
      }
      // 日目录文件集精确可枚举：无游离临时文件残留
      expect(new Set(listFilesRecursive(join(bag.sandbox.workspace, "data", "daily", SCENE_DATE)))).toEqual(
        new Set([
          "perception.jsonl",
          `事实-${SCENE_DATE}-全天.md`,
          "check-report.json",
          `理解-${SCENE_DATE}-批次-${SCENE_BATCH}.md`,
          `commit-body-${SCENE_DATE}-批次-${SCENE_BATCH}.txt`,
          `理解-${SCENE_DATE}-批次-14.md`,
        ]),
      );
    },
    SCAN_MS * 3,
  );

  /* ── 6. seam 咽喉负例：越界与禁命令 → 拒绝 + 审计 ── */

  it("seam咽喉：越界cwd/被禁命令/越界路径声明 ⇒ SeamDeniedError + 审计deny（不落一发）", async () => {
    const { seam, sandbox } = bag;
    // 被禁命令（deny 前缀）：permission 允许 bash，但 assertCommand 拒
    await expect(
      seam.executor.exec("git push origin main", sandbox.workspace, undefined, 10),
    ).rejects.toBeInstanceOf(SeamDeniedError);
    await expect(
      seam.executor.exec("rm -rf data", sandbox.workspace, undefined, 10),
    ).rejects.toBeInstanceOf(SeamDeniedError);
    // cwd 逃逸：/tmp 不在工作区 realpath 内
    await expect(
      seam.executor.exec("python3 -c 'print(1)'", "/tmp", undefined, 10),
    ).rejects.toBeInstanceOf(SeamDeniedError);
    // 声明路径越界：合法 cwd 但 paths 指到工作区外
    await expect(
      seam.executor.exec("python3 -c 'print(1)'", sandbox.workspace, undefined, 10, [
        { path: join(REPO_FIXTURE_WS, "AGENTS.md"), mode: "write" },
      ]),
    ).rejects.toBeInstanceOf(SeamDeniedError);
    // 白名单外命令（echo 不在 cmd_allow）：default-deny 语义
    await expect(
      seam.executor.exec("echo pwned", sandbox.workspace, undefined, 10),
    ).rejects.toBeInstanceOf(SeamDeniedError);
    const denies = seam.audit.filter((e) => e.verdict === "deny");
    expect(denies.length).toBeGreaterThanOrEqual(5);
    // 拒绝路径绝不允许留下副作用文件
    expect(listFilesRecursive(join(sandbox.root))).toEqual(
      expect.arrayContaining([]),
    );
    expect(findFileNames(sandbox.root, ["whatever", "pwned"], 10_000)).toEqual([]);
  });
});
