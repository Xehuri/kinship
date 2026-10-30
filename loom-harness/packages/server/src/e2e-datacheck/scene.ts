/**
 * T34 金径场景装配（docs/02 §T34；决策 docs/01 D5/D15/D16/D19/D23/D25/D26/D32）。
 *
 * 一句话职责：把「沙箱 fixture-workspace + 真 Ledger + 假模型脚本 + 真探针」备好，
 * 供 golden-batch.test.ts 走完整链路：
 *   cron（假时钟 TriggerScheduler，不真等）→ RunEngine.dispatch → 全新副会话
 *   （一轮工具轮 [check_data→read→write→bash] + 收束轮 正文+converge 同轮 D26）
 *   → 真账本 expected/actual → core/receipt runVerification/buildReceipt（PASS）→ 投主。
 *
 * 红线（本任务版）：
 *   - 仓库根 `fixture-workspace/` 与 `axeuh-health-monitor/**` **零写入**（沙箱=mkdtemp 模板副本）；
 *   - 工具写路径由 resolveToolPath（cwd 包含）+ seam（workspaceRoot realpath 包含）双重锁死。
 */

import { cpSync, existsSync, readFileSync, realpathSync, rmSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { FakeAssistantResponse, FakeModel } from "@axeuh/loom-core/testing";
import type { ArtifactProbe, ArtifactProbeResult, CommitBodyAssertion, CommitBodyAssertionResult } from "@axeuh/loom-core/receipt";
import { createFakeModelFromConfig } from "../fake-model/fake-provider.js";
import type { ModelConfig } from "../config/section-checks.js";
import { parseLoomConfig } from "../config/loom-config.js";

/** 场景常量（与 fixtures/ 内文件一致；改一处全链路联动）。 */
export const SCENE_DATE = "2026-10-08";
export const SCENE_BATCH = "12";
export const SCENE_WINDOW = "12:00~13:59";
export const SCENE_WORKFLOW = "data-check";

const HERE = dirname(fileURLToPath(import.meta.url));
/** 模板 fixture（只读源）。 */
export const TEMPLATE_WS = join(HERE, "fixtures", "fixture-workspace");
export const TEMPLATE_WORKFLOW_YAML = join(HERE, "fixtures", "workflows", "data-check.yaml");
/** 仓库根 fixture-workspace 与生产健康监控树（红线守护对象，绝不写）。 */
export const REPO_FIXTURE_WS = resolve(HERE, "../../../../fixture-workspace");
export const HEALTH_MONITOR_ROOT = resolve(HERE, "../../../../..");

export const FACTS_REL = `data/daily/${SCENE_DATE}/事实-${SCENE_DATE}-全天.md`;
export const REPORT_REL = `data/daily/${SCENE_DATE}/check-report.json`;
export const BATCH_REL = `data/daily/${SCENE_DATE}/理解-${SCENE_DATE}-批次-${SCENE_BATCH}.md`;
export const COMMIT_REL = `data/daily/${SCENE_DATE}/commit-body-${SCENE_DATE}-批次-${SCENE_BATCH}.txt`;
/** 第二批（全新副会话零残留证明用）。 */
export const BATCH14_REL = `data/daily/${SCENE_DATE}/理解-${SCENE_DATE}-批次-14.md`;
export const RUN1_MARKER = "BATCH12-ONLY";
export const RUN2_MARKER = "BATCH14-R2-ONLY";
/** 固定 run/session id（测试自证 identity 真源=账本行，非模型自述；须符合 id 形状契约）。 */
export const RUN1_ID = "run_a100000000000012";
export const SES1_ID = "ses_a100000000000012";
export const RUN2_ID = "run_b200000000001400";
export const SES2_ID = "ses_b200000000001400";

/** 批次理解文件正文（假模型 write 调用逐字携带，模拟蓝本语义产出）。 */
export const BATCH_CONTENT = `# 理解-${SCENE_DATE}-批次-${SCENE_BATCH}（${SCENE_WINDOW}）

## 12:00~13:00
【原始数据摘要】
- 位置: <lat>,<lon>（示例地点，双样本一致）
- 生理: HR 66→71（12:05/12:25/12:45，平稳）
- 活动线索: 12:25 App=bilibili；12:45 语音（他人，sim=0.22）
【关键观察】 12:45 语音 sim 0.22，判环境/他人声音，未归因用户。
【综合判断】 用户在室内，碎片化看视频/休息。置信度: 中
【关联链接】
- 前日理解: [[理解-2026-10-07]]

## 13:00~13:59
【原始数据摘要】
- 位置: 13:05 同坐标 | 生理: HR 74→61 下行 | 13:25 手机锁屏
- 语音: 13:45 “下午的课提前十分钟出发”（sim=0.91，归用户）
【关键观察】 高 sim 语音+屏锁+HR 下行，与出门上课一致。
【综合判断】 13:40 前后收拾出门去下午的课。置信度: 高
【关联链接】
- 当日摘要: [[当日摘要-${SCENE_DATE}.md|当日进度摘要]]

## 相关链接

#### 中心层（memory，本批涉及的记忆）
- 相关记忆: 无新增

#### 基础信息层（daily）
- 前日理解: [[理解-2026-10-07|前一日]]

## 任务概要
- 覆盖: ${SCENE_DATE} ${SCENE_WINDOW}，check 缺口 0s 通过（6/6 槽）
- 理解: 批次${SCENE_BATCH}文件 2 时段，末尾13:59
- 任务: 无
- 通知: 跳过（金径离线，不真发通知）
- 关键: 13:45 出门上课高置信
- 发现: 12:45 环境语音未误归因

## 事件时间线
- 12:05 室内休息（HR 66）
- 12:25 手机看视频（bilibili）
- 12:45 室内环境人声（他人，低 sim）
- 13:05 位置保持示例地点
- 13:25 手机锁屏
- 13:45 语音：提前十分钟出发（用户，sim 0.91）

## 工作过程评价
- 阻碍: 无
- 改进: 语音归因阈值可在摘要更醒目
- 质量优化: HR 下行与行为链交叉可再加 app 佐证
- 成本优化: 事实文件只读头部窗口，未全文扫描
`;

/** 第二批正文（仅证明全新会话可独立产工件；结构从简）。 */
export const BATCH14_CONTENT = `# 理解-${SCENE_DATE}-批次-14（14:00~16:00）

## 14:00~16:00
【原始数据摘要】
- 位置: 12:00 前坐标保持 | 生理: 本窗口无数据
【综合判断】 数据不足（金径场景只造到 13:59 的感知数据）。置信度: 数据不足

## 任务概要
- 覆盖: ${SCENE_DATE} 14:00~16:00，无感知数据
- 理解: 批次14文件 1 时段
- 任务: 无
- 通知: 跳过
- 关键: 数据不足如实标注
- 发现: 无

## 事件时间线
- 14:00 无数据（如实记录）

## 工作过程评价
- 阻碍: 数据不足
- 改进: 无
- 质量优化: 无
- 成本优化: 空批快判
`;

/* ────────────── 沙箱 ────────────── */

export interface Sandbox {
  /** mkdtemp 根（测毕删除）。 */
  readonly root: string;
  /** 会话工作区 = 根下的 fixture-workspace 模板副本（所有产物唯一合法落点）。 */
  readonly workspace: string;
  readonly stateRoot: string;
  cleanup(): void;
}

/** 建一次性沙箱：模板整树拷入 tmp（ext4，NTFS 无关），state 独立目录。 */
export function makeSandbox(): Sandbox {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "loom-e2e-datacheck-")));
  const workspace = join(root, "fixture-workspace");
  cpSync(TEMPLATE_WS, workspace, { recursive: true });
  const stateRoot = join(root, "state");
  mkdirSync(stateRoot, { recursive: true });
  return {
    root,
    workspace,
    stateRoot,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** 读取工作区内文件（utf8），不存在即抛（装配层真相读取，不走内存镜像）。 */
export function readWorkspaceFile(workspace: string, rel: string): string {
  const abs = resolve(workspace, rel);
  if (!abs.startsWith(realpathSync(workspace) + "/")) {
    throw new Error(`越界读取拒绝: ${rel}`);
  }
  return readFileSync(abs, "utf8");
}

/* ────────────── 真件探针 / 断言（core/receipt 的注入端口实现） ────────────── */

/** 文件系统真探针：realpath 包含断言 + 存在性 + sha256。 */
export class FsArtifactProbe implements ArtifactProbe {
  constructor(private readonly _wsRoot: string) {}

  probe(path: string): ArtifactProbeResult {
    const rootReal = realpathSync(this._wsRoot);
    const abs = resolve(rootReal, path);
    if (abs !== rootReal && !abs.startsWith(rootReal + "/")) {
      // 声明的产物指针越出工作区 = 红线违背，按“不存在”处理（验证必失败、响亮降级）。
      return { exists: false };
    }
    if (!existsSync(abs)) return { exists: false };
    const buf = readFileSync(abs);
    return { exists: true, sha256: createHash("sha256").update(buf).digest("hex") };
  }
}

/** 蓝本 commit body 六字段 + 两区块断言（注入 core/receipt；v1 不跑真 git）。 */
export const COMMIT_BODY_REQUIRED = [
  "## 任务概要",
  "## 事件时间线",
  "## 工作过程评价",
  "- 覆盖:",
  "- 理解:",
  "- 任务:",
  "- 通知:",
  "- 关键:",
  "- 发现:",
  "- 阻碍:",
  "- 改进:",
  "- 质量优化:",
  "- 成本优化:",
] as const;

export const blueprintCommitBodyAssertion: CommitBodyAssertion = (body: string): CommitBodyAssertionResult => {
  const missing = COMMIT_BODY_REQUIRED.filter((field) => !body.includes(field));
  return { ok: missing.length === 0, missing };
};

/* ────────────── 假模型脚本（真件：server fake-model → loom-core/testing） ────────────── */

/** 经 T07 边界解析器产出 ModelConfig（brand 类型不手写 cast，同 cli.test 口径）。 */
function fakeModelConfig(): ModelConfig {
  const cfg = parseLoomConfig(
    [
      "server:",
      "  port: 5097",
      "  hostname: 127.0.0.1",
      "workspace: .",
      "models:",
      "  - id: t34-data-check-fake",
      "    provider: fake",
      "    contextWindow: 200000",
      "    maxOutput: 4096",
      "    timeout: 60000",
    ].join("\n"),
    "scene:fakeModelConfig",
    { env: {} },
  );
  const spec = cfg.models[0];
  if (spec === undefined) throw new Error("fakeModelConfig: schema 保证非空却取空");
  return spec;
}

/**
 * run1 剧本（黄金批）：一轮工具轮 [check_data→read→write→bash]（全 unsafe，kernel 按声明
 * 顺序串行；check_data 屏障先行生成事实文件，read 才读得到）+ 一轮收束轮（D26 正文+converge
 * 同轮）。模型自述 runId 故意与账本行不同：HarnessReceipt identity 以账本为真源（T14 契约）。
 */
export function buildRun1Model(workflow: string): FakeModel {
  return createFakeModelFromConfig(fakeModelConfig(), [
    {
      content: [
        { type: "text", text: `【${RUN1_MARKER}】先跑数据检查脚本生成事实与覆盖报告，再转录批次。` },
        { type: "toolCall", id: "t34-check", name: "check_data", arguments: { date: SCENE_DATE, window: SCENE_WINDOW } },
        { type: "toolCall", id: "t34-read", name: "read", arguments: { path: FACTS_REL, offset: 1, limit: 12 } },
        { type: "toolCall", id: "t34-write", name: "write", arguments: { path: BATCH_REL, content: BATCH_CONTENT } },
        {
          type: "toolCall",
          id: "t34-bash",
          name: "bash",
          arguments: { command: `python3 tools/render_commit_body.py ${SCENE_DATE} ${SCENE_BATCH}`, timeout: 60 },
        },
      ],
    },
    {
      content: [
        {
          type: "text",
          text: `批次${SCENE_BATCH}完成：6/6 槽位覆盖，事实/批次/commit-body 三产物落盘，13:45 出门上课高置信。`,
        },
        {
          type: "toolCall",
          id: "t34-converge",
          name: "converge",
          arguments: {
            status: "done",
            runId: "run_deadbeefdeadbeef",
            workflow,
            attempt: 1,
            digest: `done：${SCENE_DATE} ${SCENE_WINDOW} 批次${SCENE_BATCH} 检查通过（6/6 槽，缺口 0s）`,
            pointers: [`file:${BATCH_REL}`, `file:${COMMIT_REL}`, `file:${REPORT_REL}`, "git:batch12-transcribed"],
            blockers: [],
          },
        },
      ],
    },
  ]);
}

/** run2 剧本（全新副会话零残留证明 D19）：write 批次14 → 正文+converge。 */
export function buildRun2Model(workflow: string): FakeModel {
  return createFakeModelFromConfig(fakeModelConfig(), [
    {
      content: [
        { type: "text", text: `【${RUN2_MARKER}】手动补跑批次14：窗口无感知数据，按蓝本如实标注“数据不足”。` },
        { type: "toolCall", id: "t34b-write", name: "write", arguments: { path: BATCH14_REL, content: BATCH14_CONTENT } },
      ],
    },
    {
      content: [
        { type: "text", text: "批次14完成：数据不足如实记录，产物落盘。" },
        {
          type: "toolCall",
          id: "t34b-converge",
          name: "converge",
          arguments: {
            status: "done",
            runId: RUN2_ID,
            workflow,
            attempt: 1,
            digest: `done：${SCENE_DATE} 14:00~16:00 批次14 数据不足如实记录`,
            pointers: [`file:${BATCH14_REL}`],
            blockers: [],
          },
        },
      ],
    },
  ]);
}
