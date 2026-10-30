/**
 * T14 回执 schema + harness 侧验证块 —— 类型契约层
 * （docs/02 §T14；决策 docs/01 D23/D5/D25）。
 *
 * 一句话职责：把 T09 收束回执（SideReceipt，camelCase、模型自述）与 T12 引擎终态
 * （RunRow / RunLaunchResult）**合并**成 harness 可信的持久化回执 HarnessReceipt：
 *   - run_id / workflow / attempt 以账本 RunRow 为**真源**（不是模型自述）；
 *   - verification 预验块由 harness 代跑（manifest 存在性+哈希、commit body 字段、coverage）；
 *   - digest 一行结论 / dispositions 待处置清单 / pointers 产物指针。
 *
 * 回执字面键名冻结（docs/02 Open Questions 3，小写蛇形）：
 *   `run_id / workflow / status / attempt / verification / digest / dispositions / pointers`；
 *   verification 子对象 `{manifest, commit_body, coverage}` 各取 `pass|fail|skipped`。
 *
 * v1 边界（MUST NOT）：
 *   - 不执行任何 git 操作 —— commit_body 校验做成**可注入断言函数**（CommitBodyAssertion），
 *     测试用桩，切换日装配层可换成真 git 探测；
 *   - 不搬运回执 —— 投递通道 = 注入端口 ReceiptDeliveryPort，搬运属装配层（见 delivery.ts）。
 *
 * 复用（只读 import，禁改其文件）：convergence/（SideStatus 词表）、run-engine/（RunRow/RunLaunchResult）。
 */

import type { SideStatus } from "../convergence/index.js";
import type { RunLaunchResult, RunRow } from "../run-engine/index.js";

/* ────────────── 验证判定 ────────────── */

/** 单项预验判定（docs/02 §T14 冻结词表）。 */
export type Verdict = "pass" | "fail" | "skipped";

/**
 * 单项预验结果：verdict + 人类可读 detail。
 * detail 在 fail 时**必须**说明原因（缺失清单/哈希不符/未达标），是「FAIL populated」的载体。
 */
export interface VerificationCheck {
  readonly verdict: Verdict;
  readonly detail: string;
}

/** verification 预验块（docs/02 Open Questions 3 冻结三键）。 */
export interface VerificationBlock {
  readonly manifest: VerificationCheck;
  readonly commit_body: VerificationCheck;
  readonly coverage: VerificationCheck;
}

/* ────────────── 持久化回执（D23 冻结字面键名） ────────────── */

/**
 * HarnessReceipt —— 副会话回执的持久化形状（T14 核心产物）。
 * 与 T09 SideReceipt 的差异：identity 字段 snake_case 且以账本为真源；带 verification 块；
 * blockers 在此更名为 dispositions（D23「待处置清单」的持久化词）。
 */
export interface HarnessReceipt {
  readonly run_id: string;
  readonly workflow: string;
  readonly status: SideStatus;
  readonly attempt: number;
  readonly verification: VerificationBlock;
  readonly digest: string;
  readonly dispositions: readonly string[];
  readonly pointers: readonly string[];
}

/* ────────────── manifest 声明 + 产物探针 ────────────── */

/**
 * 一条产物声明：path 必填；sha256 可选（缺省只验存在性）。
 * 「声明产物存在 / 哈希对」即本结构的两级预验对象。
 */
export interface ManifestEntry {
  readonly path: string;
  readonly sha256?: string;
}

/** 探针单次结果：不存在时 exists=false；存在时可选给出内容 sha256。 */
export interface ArtifactProbeResult {
  readonly exists: boolean;
  readonly sha256?: string;
}

/**
 * 产物探针端口（注入；core 不 import adapters）。
 * 真探针由装配层实现（文件系统/哈希）；core 测试用 MemoryArtifactProbe。
 */
export interface ArtifactProbe {
  probe(path: string): ArtifactProbeResult;
}

/* ────────────── commit body 断言（v1 不执行 git） ────────────── */

/** 断言结果：ok=false 时 missing 列出缺失字段名（供 detail 装配）。 */
export interface CommitBodyAssertionResult {
  readonly ok: boolean;
  readonly missing: readonly string[];
}

/**
 * commit body 断言函数契约（可注入）。
 * v1 默认实现只做字段齐全性检查；切换日可注入真 git 探测（例如校验 commit 存在/作者/签名）。
 */
export type CommitBodyAssertion = (body: string) => CommitBodyAssertionResult;

/* ────────────── coverage 声明 ────────────── */

/** check_coverage 类校验的通用形状：checked/total，覆盖率 = checked/total。 */
export interface CoverageDeclaration {
  readonly checked: number;
  readonly total: number;
}

/* ────────────── 验证输入 / 依赖 ────────────── */

/**
 * runVerification 的输入（全部来自引擎终态，不可信者已在引擎边界校验过）。
 * manifest 缺省时从 pointers 的 `file:` 条目派生（见 manifestFromPointers）。
 */
export interface VerificationInput {
  readonly pointers: readonly string[];
  readonly manifest?: readonly ManifestEntry[];
  readonly commitBody?: string | null;
  readonly coverage?: CoverageDeclaration | null;
  readonly coverageThreshold?: number;
}

/** 验证依赖（注入）：产物探针 + commit body 断言。 */
export interface VerificationDeps {
  readonly artifactProbe: ArtifactProbe;
  readonly commitBodyAssertion: CommitBodyAssertion;
}

/* ────────────── 回执组装输入 ────────────── */

/** buildReceipt 输入：账本行（identity 真源）+ 引擎终态（digest/pointers/dispositions）+ 预验块。 */
export interface ReceiptBuildInput {
  readonly row: RunRow;
  readonly result: RunLaunchResult;
  readonly verification: VerificationBlock;
}
