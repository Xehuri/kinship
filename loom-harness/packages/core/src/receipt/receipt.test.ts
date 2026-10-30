/**
 * T14 回执 + 验证块验收（docs/02 §T14 TDD：verification-block cases first）。
 *
 * 覆盖（冻结验收 + 计划补充形状）：
 *   1. manifest 预验——声明产物存在 / 哈希对 / 缺失 ⇒ FAIL populated / 空声明 ⇒ skipped；
 *   2. commit body 预验——缺必填字段 ⇒ FAIL；字段齐 ⇒ PASS；未声明 ⇒ skipped（断言可注入）；
 *   3. coverage 预验——达标/未达标/非法声明；
 *   4. runVerification 编排——三项合成一个 VerificationBlock；
 *   5. 降级映射表写死——done→partial、partial→failed、failed→failed、无 fail 原样；
 *   6. buildReceipt——回执 = 收束工具字段的持久化形状（identity 以账本 RunRow 为真源，
 *      dispositions 来自 T09 SideReceipt.blockers），字段名逐字对齐 D23 冻结键名；
 *   7. 投递钩子=注入函数——副会话回执经 ReceiptDeliveryPort 投主，格式带【副会话回执】。
 */

import { describe, expect, it } from "vitest";
import type { SideReceipt, SideStatus } from "../convergence/index.js";
import { parseReceiptArgs } from "../convergence/index.js";
import type { RunLaunchResult, RunRow } from "../run-engine/index.js";
import {
  buildReceipt,
  defaultCommitBodyAssertion,
  manifestFromPointers,
  MemoryArtifactProbe,
  MemoryReceiptDelivery,
  RECEIPT_MARK,
  receiptMessage,
  runVerification,
  verifyCommitBody,
  verifyCoverage,
  verifyManifest,
  applyVerificationDowngrade,
  verificationFailed,
  type CommitBodyAssertion,
  type HarnessReceipt,
  type ManifestEntry,
  type VerificationBlock,
  type VerificationDeps,
} from "./index.js";

/* ────────────── helpers ────────────── */

function nth<T>(items: ReadonlyArray<T>, i: number): T {
  const v = items[i];
  if (v === undefined) throw new Error(`no element at index ${i}`);
  return v;
}

const OK_ASSERT: CommitBodyAssertion = () => ({ ok: true, missing: [] });

function deps(over: Partial<VerificationDeps> = {}): VerificationDeps {
  return {
    artifactProbe: new MemoryArtifactProbe(),
    commitBodyAssertion: OK_ASSERT,
    ...over,
  };
}

const row: RunRow = {
  run_id: "run_0123456789abcdef",
  workflow: "nightly-audit",
  attempt: 2,
  trigger: "manual",
  parent_run: null,
  session_id: "ses_0123456789abcdef",
};

const okResult = (over: Partial<RunLaunchResult> = {}): RunLaunchResult => ({
  status: "done",
  digest: "done：3 件产物全部落盘",
  pointers: ["file:ai/data/out.json", "git:deadbeef"],
  blockers: [],
  ...over,
});

/* ────────────── 1. manifest 预验 ────────────── */

describe("manifest 预验（声明产物存在 / 哈希对）", () => {
  it("缺失产物 ⇒ verdict=fail 且 detail populated（列明缺失路径）", () => {
    const probe = new MemoryArtifactProbe();
    probe.set("ai/data/keep.json"); // 只登记一件，另一件缺
    const entries: ManifestEntry[] = [
      { path: "ai/data/keep.json" },
      { path: "ai/data/gone.json" },
    ];
    const check = verifyManifest(entries, probe);
    expect(check.verdict).toBe("fail");
    expect(check.detail).toContain("gone.json");
    expect(check.detail).toContain("不存在");
  });

  it("全部存在且声明哈希匹配 ⇒ pass", () => {
    const probe = new MemoryArtifactProbe();
    probe.set("a.json", "hash-a");
    probe.set("b.json", "hash-b");
    const check = verifyManifest(
      [
        { path: "a.json", sha256: "hash-a" },
        { path: "b.json", sha256: "hash-b" },
      ],
      probe,
    );
    expect(check.verdict).toBe("pass");
    expect(check.detail).toContain("哈希匹配");
  });

  it("哈希不符 ⇒ fail 且 detail 给出声明值与实得值", () => {
    const probe = new MemoryArtifactProbe();
    probe.set("a.json", "actual-hash");
    const check = verifyManifest([{ path: "a.json", sha256: "declared-hash" }], probe);
    expect(check.verdict).toBe("fail");
    expect(check.detail).toContain("declared-hash");
    expect(check.detail).toContain("actual-hash");
  });

  it("空清单 ⇒ skipped（无声明不误判 pass）", () => {
    const check = verifyManifest([], new MemoryArtifactProbe());
    expect(check.verdict).toBe("skipped");
  });

  it("manifestFromPointers：只取 file: 前缀、丢弃空路径与 git: 指针", () => {
    const entries = manifestFromPointers(["file:ai/x.json", "git:deadbeef", "file:", "file:ai/y.json"]);
    expect(entries).toEqual([{ path: "ai/x.json" }, { path: "ai/y.json" }]);
  });
});

/* ────────────── 2. commit body 预验（断言可注入，v1 无真 git） ────────────── */

describe("commit body 预验（注入断言函数；v1 不执行 git）", () => {
  it("默认断言：缺必填字段 ⇒ fail 且列出缺失字段", () => {
    const check = verifyCommitBody("task: T14\n只写了 task", defaultCommitBodyAssertion);
    expect(check.verdict).toBe("fail");
    expect(check.detail).toContain("verification");
    expect(check.detail).toContain("tests");
  });

  it("默认断言：字段齐 ⇒ pass", () => {
    const body = "task: T14\nverification: 全绿\ntests: vitest receipt";
    const check = verifyCommitBody(body, defaultCommitBodyAssertion);
    expect(check.verdict).toBe("pass");
  });

  it("未声明（null/空白）⇒ skipped，断言不被调用", () => {
    let called = 0;
    const spy: CommitBodyAssertion = () => {
      called += 1;
      return { ok: true, missing: [] };
    };
    expect(verifyCommitBody(null, spy).verdict).toBe("skipped");
    expect(verifyCommitBody("   ", spy).verdict).toBe("skipped");
    expect(called).toBe(0);
  });

  it("注入桩断言：ok=false 且 missing 空 ⇒ fail 仍带占位说明", () => {
    const stub: CommitBodyAssertion = () => ({ ok: false, missing: [] });
    const check = verifyCommitBody("whatever", stub);
    expect(check.verdict).toBe("fail");
    expect(check.detail).toContain("断言未给出字段名");
  });
});

/* ────────────── 3. coverage 预验 ────────────── */

describe("coverage 预验", () => {
  it("达标（checked=total）⇒ pass；未达标 ⇒ fail", () => {
    expect(verifyCoverage({ checked: 3, total: 3 }).verdict).toBe("pass");
    const bad = verifyCoverage({ checked: 2, total: 3 });
    expect(bad.verdict).toBe("fail");
    expect(bad.detail).toContain("2/3");
  });

  it("未声明 ⇒ skipped；total=0 ⇒ skipped", () => {
    expect(verifyCoverage(null).verdict).toBe("skipped");
    expect(verifyCoverage({ checked: 0, total: 0 }).verdict).toBe("skipped");
  });

  it("非法声明（checked>total）⇒ fail（不可信输入响亮拒）", () => {
    expect(verifyCoverage({ checked: 5, total: 3 }).verdict).toBe("fail");
  });
});

/* ────────────── 4. runVerification 编排 ────────────── */

describe("runVerification 编排（三项合成一块）", () => {
  it("manifest 缺省时从 file: pointers 派生；三项齐跑", () => {
    const probe = new MemoryArtifactProbe();
    probe.set("ai/data/out.json");
    const block = runVerification(
      { pointers: ["file:ai/data/out.json"], coverage: { checked: 1, total: 1 } },
      deps({ artifactProbe: probe }),
    );
    expect(block.manifest.verdict).toBe("pass");
    expect(block.commit_body.verdict).toBe("skipped");
    expect(block.coverage.verdict).toBe("pass");
    expect(verificationFailed(block)).toBe(false);
  });

  it("显式 manifest 覆盖 pointers 派生", () => {
    const probe = new MemoryArtifactProbe();
    probe.set("explicit.json");
    const block = runVerification(
      { pointers: ["file:ignored.json"], manifest: [{ path: "explicit.json" }] },
      deps({ artifactProbe: probe }),
    );
    expect(block.manifest.verdict).toBe("pass");
  });

  it("任一项 fail ⇒ verificationFailed=true", () => {
    const block = runVerification(
      { pointers: ["file:missing.json"] },
      deps(),
    );
    expect(verificationFailed(block)).toBe(true);
  });
});

/* ────────────── 5. 降级映射表（写死） ────────────── */

describe("验证不通过 ⇒ status 降级（映射表写死）", () => {
  const pass: VerificationBlock = {
    manifest: { verdict: "pass", detail: "" },
    commit_body: { verdict: "pass", detail: "" },
    coverage: { verdict: "pass", detail: "" },
  };
  const skipped: VerificationBlock = {
    manifest: { verdict: "skipped", detail: "" },
    commit_body: { verdict: "skipped", detail: "" },
    coverage: { verdict: "skipped", detail: "" },
  };
  const fail: VerificationBlock = {
    manifest: { verdict: "fail", detail: "缺失" },
    commit_body: { verdict: "pass", detail: "" },
    coverage: { verdict: "pass", detail: "" },
  };

  it.each([
    ["done", pass, "done"],
    ["partial", pass, "partial"],
    ["failed", pass, "failed"],
    ["done", skipped, "done"],
    ["done", fail, "partial"],
    ["partial", fail, "failed"],
    ["failed", fail, "failed"],
  ] as const)("status=%s + %s ⇒ %s", (status, block, expected) => {
    expect(applyVerificationDowngrade(status, block)).toBe(expected);
  });

  it("skipped 不算失败（无声明 ≠ 失败）", () => {
    expect(verificationFailed(skipped)).toBe(false);
    expect(applyVerificationDowngrade("done", skipped)).toBe("done");
  });
});

/* ────────────── 6. buildReceipt = 收束工具字段的持久化形状 ────────────── */

describe("buildReceipt（回执=收束工具字段的持久化形状，复用 convergence）", () => {
  it("T09 收束回执 → 持久化 HarnessReceipt：identity 以账本 RunRow 为真源，blockers→dispositions", () => {
    // 用真实收束边界解析造 SideReceipt（复用 convergence/receipt.ts），模拟模型自述
    const parsed = parseReceiptArgs("side", {
      status: "done",
      runId: "model-self-reported",
      workflow: "nightly-audit",
      attempt: 1,
      digest: "done：巡检完成",
      pointers: ["file:ai/data/out.json"],
      blockers: ["待确认磁盘项"],
    });
    if (!parsed.ok) throw new Error("fixture receipt should parse");
    const sideReceipt: SideReceipt = parsed.receipt as SideReceipt;

    const block: VerificationBlock = {
      manifest: { verdict: "pass", detail: "1 件产物存在" },
      commit_body: { verdict: "pass", detail: "字段齐" },
      coverage: { verdict: "pass", detail: "1/1" },
    };
    const receipt: HarnessReceipt = buildReceipt({
      row,
      result: okResult({
        status: sideReceipt.status,
        digest: sideReceipt.digest,
        pointers: sideReceipt.pointers,
        blockers: sideReceipt.blockers,
        receipt: sideReceipt,
      }),
      verification: block,
    });

    // identity 以账本为真源（不是模型自述的 model-self-reported / attempt=1）
    expect(receipt.run_id).toBe("run_0123456789abcdef");
    expect(receipt.attempt).toBe(2);
    expect(receipt.workflow).toBe("nightly-audit");
    expect(receipt.status).toBe("done");
    // blockers 持久化为 dispositions
    expect(receipt.dispositions).toEqual(["待确认磁盘项"]);
    expect(receipt.pointers).toEqual(["file:ai/data/out.json"]);
    // D23 冻结字面键名逐字对齐
    expect(Object.keys(receipt).sort()).toEqual(
      ["attempt", "digest", "dispositions", "pointers", "run_id", "status", "verification", "workflow"].sort(),
    );
    expect(Object.keys(receipt.verification).sort()).toEqual(
      ["commit_body", "coverage", "manifest"].sort(),
    );
  });

  it("验证 fail ⇒ buildReceipt 落定降级后的 status（done→partial）", () => {
    const receipt = buildReceipt({
      row,
      result: okResult(),
      verification: {
        manifest: { verdict: "fail", detail: "缺失 a.json" },
        commit_body: { verdict: "skipped", detail: "" },
        coverage: { verdict: "skipped", detail: "" },
      },
    });
    expect(receipt.status).toBe("partial");
  });
});

/* ────────────── 7. 投递钩子=注入函数（副会话回执经账本投主） ────────────── */

describe("回执投主（ReceiptDeliveryPort 注入端口）", () => {
  it("投递钩子是注入函数：回执经端口投主、格式带【副会话回执】", async () => {
    const delivery = new MemoryReceiptDelivery();
    const receipt: HarnessReceipt = {
      run_id: "run_0123456789abcdef",
      workflow: "nightly-audit",
      status: "partial",
      attempt: 2,
      verification: {
        manifest: { verdict: "fail", detail: "缺失" },
        commit_body: { verdict: "pass", detail: "" },
        coverage: { verdict: "skipped", detail: "" },
      },
      digest: "partial：2 项待处置",
      dispositions: ["需确认磁盘项"],
      pointers: ["file:ai/data/out.json"],
    };
    await delivery.deliver(receipt);
    expect(delivery.delivered).toHaveLength(1);
    expect(nth(delivery.delivered, 0).run_id).toBe("run_0123456789abcdef");

    const msg = receiptMessage(receipt);
    expect(msg).toContain(RECEIPT_MARK);
    expect(msg).toContain("manifest=fail");
    expect(msg).toContain("commit_body=pass");
    expect(msg).toContain("partial：2 项待处置");
  });
});

/* ────────────── 8. 端到端：missing manifest ⇒ verification FAIL populated ────────────── */

describe("端到端：验收「missing manifest ⇒ verification FAIL populated」", () => {
  it("声明了不存在产物 → 预验块 fail + 回执降级，且 detail 有可读原因", () => {
    const probe = new MemoryArtifactProbe();
    probe.set("ai/data/exists.json");
    const block = runVerification(
      {
        pointers: ["file:ai/data/exists.json"],
        manifest: [
          { path: "ai/data/exists.json" },
          { path: "ai/data/missing.json" },
        ],
      },
      deps({ artifactProbe: probe }),
    );
    expect(block.manifest.verdict).toBe("fail");
    expect(block.manifest.detail.length).toBeGreaterThan(0);

    const receipt = buildReceipt({ row, result: okResult({ status: "done" }), verification: block });
    expect(receipt.status).toBe("partial");
    expect(receipt.verification.manifest.verdict).toBe("fail");
  });

  it("valid：产物在、commit body 齐、coverage 达标 ⇒ PASS 且带 digest/pointers", () => {
    const probe = new MemoryArtifactProbe();
    probe.set("ai/data/out.json", "h1");
    const block = runVerification(
      {
        pointers: ["file:ai/data/out.json"],
        manifest: [{ path: "ai/data/out.json", sha256: "h1" }],
        commitBody: "task: T14\nverification: green\ntests: receipt",
        coverage: { checked: 3, total: 3 },
      },
      deps({ artifactProbe: probe, commitBodyAssertion: defaultCommitBodyAssertion }),
    );
    expect(block.manifest.verdict).toBe("pass");
    expect(block.commit_body.verdict).toBe("pass");
    expect(block.coverage.verdict).toBe("pass");

    const receipt = buildReceipt({ row, result: okResult({ status: "done" }), verification: block });
    expect(receipt.status).toBe("done");
    expect(receipt.digest).toBe("done：3 件产物全部落盘");
    expect(receipt.pointers).toEqual(["file:ai/data/out.json", "git:deadbeef"]);
  });
});

/* ────────────── 9. 词表一致性（SideStatus 复用 convergence） ────────────── */

describe("词表复用（禁另造枚举）", () => {
  it.each(["done", "partial", "failed"] as const)("SideStatus=%s 是合法回执 status", (s) => {
    const status: SideStatus = s;
    expect(["done", "partial", "failed"]).toContain(status);
  });
});
