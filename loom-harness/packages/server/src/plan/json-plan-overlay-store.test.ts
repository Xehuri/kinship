/**
 * JsonPlanOverlayStore 验收：草稿落盘与有效视图头、CAS 冲突、锁竞争、
 * 损坏 typed error、v1 只读回退、base_version 过期与 closed 不可变。
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { afterEach, describe, expect, it } from "vitest";

import { FileLockTimeoutError, withFileLock } from "./file-lock.js";
import {
  JsonPlanOverlayStore,
  type JsonPlanOverlayStoreOptions,
  type MasterPlanReader,
} from "./json-plan-overlay-store.js";
import type { MasterEntry, MasterPlanDocument } from "./master-plan.js";
import {
  OverlayBaseStaleError,
  PlanOverlayClosedError,
  PlanOverlayConflictError,
  PlanOverlayCorruptError,
  PlanOverlayNotFoundError,
  PlanOverlayValidationError,
  type PlanOverlayItem,
  type PlanOverlayOp,
  type PlanOverlayWriteInput,
} from "./plan-overlay.js";
import type { PlanCoverage, PlanDocument } from "./plan-store.js";

const NOW = Date.UTC(2026, 9, 28, 4, 0, 0);
const DAY = "2026-10-28";
const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "plan-overlay-store-"));
  roots.push(root);
  return root;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function entry(overrides: Partial<MasterEntry> = {}): MasterEntry {
  return {
    id: "morning-review",
    kind: "fixed",
    title: "晨间复盘",
    enabled: true,
    action: "review.daily",
    schedule: { kind: "daily", at: "06:10" },
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function master(version = 1, entries: readonly MasterEntry[] = [entry()]): MasterPlanDocument {
  return {
    schema: 1,
    kind: "master-plan",
    timezone: "Asia/Shanghai",
    version,
    created_at: NOW,
    updated_at: NOW,
    entries,
  };
}

function reader(get: () => MasterPlanDocument): MasterPlanReader {
  return { read: async () => get() };
}

const COVERAGE: PlanCoverage = {
  profile: "merged_7",
  checkpoints: ["cov-06"],
  debt: [],
};

function writeInput(overrides: Partial<PlanOverlayWriteInput> = {}): PlanOverlayWriteInput {
  return {
    date: DAY,
    base_version: 1,
    ops: [{ op: "update", id: "morning-review", patch: { at: "06:30" } }],
    coverage: COVERAGE,
    ...overrides,
  };
}

function careAdd(overrides: Partial<PlanOverlayItem> = {}): PlanOverlayOp {
  return {
    op: "add",
    item: {
      id: "care-message",
      kind: "care",
      intent: "发一条非事务消息",
      status: "planned",
      ...overrides,
    },
  };
}

function handwrittenOverlay(ops: readonly PlanOverlayOp[]): Record<string, unknown> {
  return {
    schema: 1,
    kind: "plan-overlay",
    date: DAY,
    base_version: 1,
    version: 1,
    status: "draft",
    created_at: NOW,
    updated_at: NOW,
    ops,
    notes: [],
    coverage: COVERAGE,
  };
}

function seedOverlay(store: JsonPlanOverlayStore, ops: readonly PlanOverlayOp[]): void {
  const paths = store.paths(DAY);
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(paths.overlay, `${JSON.stringify(handwrittenOverlay(ops))}\n`, "utf8");
}

function storeAt(
  root: string,
  getMaster: () => MasterPlanDocument,
  options: Omit<JsonPlanOverlayStoreOptions, "planRoot" | "master"> = {},
): JsonPlanOverlayStore {
  return new JsonPlanOverlayStore({
    planRoot: root,
    master: reader(getMaster),
    now: () => NOW,
    ...options,
  });
}

function legacyPlan(): PlanDocument {
  return {
    schema: 1,
    date: DAY,
    status: "draft",
    version: 4,
    created_at: NOW,
    updated_at: NOW,
    review_at: "07:30",
    items: [
      { id: "legacy-item", kind: "care", intent: "旧计划条目", status: "planned" },
    ],
    coverage: COVERAGE,
    notes: ["旧计划备注"],
  };
}

describe("草稿与有效视图", () => {
  it("write 落盘 overlay 真源并渲染带「母版 + 当日 diff」头的 Markdown", async () => {
    const root = tempRoot();
    const store = storeAt(root, () => master());
    const created = await store.write(writeInput());

    expect(created.status).toBe("draft");
    expect(created.version).toBe(1);
    expect(created.base_version).toBe(1);
    expect(await store.read(DAY)).toEqual(created);

    const paths = store.paths(DAY);
    expect(existsSync(paths.overlay)).toBe(true);
    expect(existsSync(paths.markdown)).toBe(true);
    expect(existsSync(paths.legacy)).toBe(false);
    expect(readFileSync(paths.markdown, "utf8")).toContain("母版 + 当日 diff");
    expect(readFileSync(paths.markdown, "utf8")).toContain("06:30");
  });

  it("read 缺文件抛 not-found，损坏 JSON 抛 corrupt", async () => {
    const root = tempRoot();
    const store = storeAt(root, () => master());
    const paths = store.paths(DAY);
    await expect(store.read(DAY)).rejects.toBeInstanceOf(PlanOverlayNotFoundError);

    await store.write(writeInput());
    writeFileSync(paths.overlay, "{not-json", "utf8");
    await expect(store.read(DAY)).rejects.toBeInstanceOf(PlanOverlayCorruptError);
  });
});

describe("CAS 与锁", () => {
  it("revise/commit 对 overlay.version 做 CAS，冲突不落盘", async () => {
    const root = tempRoot();
    const store = storeAt(root, () => master());
    await store.write(writeInput());

    await expect(
      store.revise(DAY, 2, { ops: [{ op: "remove", id: "morning-review" }] }),
    ).rejects.toBeInstanceOf(PlanOverlayConflictError);
    await expect(store.commit(DAY, 2)).rejects.toBeInstanceOf(PlanOverlayConflictError);

    const revised = await store.revise(DAY, 1, { notes_append: ["补一条"] });
    expect(revised.version).toBe(2);
    expect(revised.notes).toEqual(["补一条"]);

    const committed = await store.commit(DAY, 2);
    expect(committed.overlay.status).toBe("committed");
    expect(committed.overlay.version).toBe(3);
    expect(committed.effective.entries[0]?.at).toBe("06:30");
    expect(readFileSync(store.paths(DAY).markdown, "utf8")).toContain("状态: committed");
  });

  it("其他持有者占锁时 write/commit 超时抛 FileLockTimeoutError", async () => {
    const root = tempRoot();
    const store = storeAt(root, () => master(), { lockTimeoutMs: 80 });
    await store.write(writeInput());

    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked = false;
    const holder = withFileLock(store.paths(DAY).lock, () => {
      locked = true;
      return gate;
    });
    while (!locked) await sleep(2);

    await expect(store.commit(DAY, 1)).rejects.toBeInstanceOf(FileLockTimeoutError);
    release();
    await holder;
    expect((await store.read(DAY)).status).toBe("draft");
  });
});

describe("base_version 与回退", () => {
  it("commit 时母版已推进则抛 OverlayBaseStaleError；revise 不做 base 检查", async () => {
    const root = tempRoot();
    const clock = { version: 2 };
    const store = storeAt(root, () => master(clock.version));
    await store.write(writeInput({ base_version: 1 }));

    await expect(store.commit(DAY, 1)).rejects.toBeInstanceOf(OverlayBaseStaleError);
    const revised = await store.revise(DAY, 1, { notes_append: ["母版已漂移，先改差量"] });
    expect(revised.version).toBe(2);
    await expect(store.commit(DAY, 2)).rejects.toBeInstanceOf(OverlayBaseStaleError);
    expect((await store.read(DAY)).status).toBe("draft");
  });

  it("无覆盖层时 readEffective 回退 v1 plan-{date}.json，且旧文件逐字节不变", async () => {
    const root = tempRoot();
    const store = storeAt(root, () => master());
    const paths = store.paths(DAY);
    const legacy = legacyPlan();
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.legacy, `${JSON.stringify(legacy)}\n`, "utf8");
    const before = sha256(paths.legacy);

    const effective = await store.readEffective(DAY);
    expect(effective.origin).toBe("legacy");
    expect(effective.overlay_version).toBe(4);
    expect(effective.entries.map((row) => row.id)).toEqual(["legacy-item"]);
    expect(effective.warnings).toEqual(["legacy_fallback"]);
    expect(sha256(paths.legacy)).toBe(before);
    expect(existsSync(paths.overlay)).toBe(false);
    expect(await store.readLegacy(DAY)).toEqual(legacy);
  });

  it("closed 后 revise/commit/close 一律拒绝", async () => {
    const root = tempRoot();
    const store = storeAt(root, () => master());
    await store.write(writeInput());
    const closed = await store.close(DAY, 1);
    expect(closed.status).toBe("closed");
    expect(closed.version).toBe(2);

    await expect(store.revise(DAY, 2, { notes_append: ["x"] })).rejects.toBeInstanceOf(
      PlanOverlayClosedError,
    );
    await expect(store.commit(DAY, 2)).rejects.toBeInstanceOf(PlanOverlayClosedError);
    await expect(store.close(DAY, 2)).rejects.toBeInstanceOf(PlanOverlayClosedError);
  });
});

describe("user_intent 持久化", () => {
  it("write 持久化 user_intent，read 与 Markdown 均可见", async () => {
    const root = tempRoot();
    const store = storeAt(root, () => master());
    const created = await store.write(writeInput({ user_intent: "今天先稳住状态" }));

    expect(created.user_intent).toBe("今天先稳住状态");
    expect((await store.read(DAY)).user_intent).toBe("今天先稳住状态");

    const paths = store.paths(DAY);
    const raw = JSON.parse(readFileSync(paths.overlay, "utf8")) as Record<string, unknown>;
    expect(raw["user_intent"]).toBe("今天先稳住状态");
    expect(readFileSync(paths.markdown, "utf8")).toContain("用户意图");
  });

  it("write 未提供 user_intent 时 JSON 不含该键，兼容旧形状", async () => {
    const root = tempRoot();
    const store = storeAt(root, () => master());
    await store.write(writeInput());

    const paths = store.paths(DAY);
    const raw = JSON.parse(readFileSync(paths.overlay, "utf8")) as Record<string, unknown>;
    expect("user_intent" in raw).toBe(false);
    expect((await store.read(DAY)).user_intent).toBeUndefined();
    expect(readFileSync(paths.markdown, "utf8")).not.toContain("用户意图");
  });

  it("revise 替换 user_intent，未提供时保留当前值并存活 commit/read", async () => {
    const root = tempRoot();
    const store = storeAt(root, () => master());
    await store.write(writeInput({ user_intent: "上午先处理邮件" }));

    const replaced = await store.revise(DAY, 1, { user_intent: "改成下午处理" });
    expect(replaced.user_intent).toBe("改成下午处理");
    expect((await store.read(DAY)).user_intent).toBe("改成下午处理");

    const preserved = await store.revise(DAY, 2, { notes_append: ["保留意图"] });
    expect(preserved.user_intent).toBe("改成下午处理");
    expect((await store.read(DAY)).user_intent).toBe("改成下午处理");

    const committed = await store.commit(DAY, 3);
    expect(committed.overlay.user_intent).toBe("改成下午处理");
    expect(committed.effective.user_intent).toBe("改成下午处理");
    expect((await store.read(DAY)).user_intent).toBe("改成下午处理");
  });
});

describe("care done_when 写路径校验", () => {
  it("write 拒绝无可核验 done_when 的 care add 且不落盘", async () => {
    const root = tempRoot();
    const store = storeAt(root, () => master());
    const paths = store.paths(DAY);

    await expect(store.write(writeInput({ ops: [careAdd()] }))).rejects.toBeInstanceOf(
      PlanOverlayValidationError,
    );
    expect(existsSync(paths.overlay)).toBe(false);
    expect(existsSync(paths.markdown)).toBe(false);
  });

  it("write 接受含时钟 done_when 或 window 的 care add", async () => {
    const clockStore = storeAt(tempRoot(), () => master());
    await expect(
      clockStore.write(
        writeInput({ ops: [careAdd({ done_when: "08:00 前已发过一条非事务消息" })] }),
      ),
    ).resolves.toBeDefined();

    const windowStore = storeAt(tempRoot(), () => master());
    await expect(
      windowStore.write(writeInput({ ops: [careAdd({ done_when: "已经发过消息", window: "08:00~09:00" })] })),
    ).resolves.toBeDefined();
  });

  it("手写 legacy 覆盖层无 user_intent 可 read 并经 CAS revise", async () => {
    const root = tempRoot();
    const store = storeAt(root, () => master());
    seedOverlay(store, [careAdd({ done_when: "记得发消息" })]);

    const loaded = await store.read(DAY);
    expect(loaded.version).toBe(1);
    expect("user_intent" in loaded).toBe(false);

    const revised = await store.revise(DAY, 1, { notes_append: ["legacy 可修订"] });
    expect(revised.version).toBe(2);
    expect(revised.notes).toEqual(["legacy 可修订"]);
    expect((await store.read(DAY)).version).toBe(2);
  });

  it("revise 仅改 status 的 legacy soft care add 因 priorOps 放行", async () => {
    const root = tempRoot();
    const store = storeAt(root, () => master());
    seedOverlay(store, [careAdd({ done_when: "记得发消息" })]);

    const revised = await store.revise(DAY, 1, {
      ops: [careAdd({ done_when: "记得发消息", status: "done" })],
    });
    expect(revised.version).toBe(2);
    expect(revised.ops[0]).toEqual({
      op: "add",
      item: {
        id: "care-message",
        kind: "care",
        intent: "发一条非事务消息",
        status: "done",
        done_when: "记得发消息",
      },
    });
  });

  it("revise 把 legacy soft care 的 done_when 改成另一非法值时报错且 bytes 不变", async () => {
    const root = tempRoot();
    const store = storeAt(root, () => master());
    seedOverlay(store, [careAdd({ done_when: "记得发消息" })]);
    const paths = store.paths(DAY);
    const before = sha256(paths.overlay);

    await expect(
      store.revise(DAY, 1, { ops: [careAdd({ done_when: "记得发消息啊" })] }),
    ).rejects.toBeInstanceOf(PlanOverlayValidationError);
    expect(sha256(paths.overlay)).toBe(before);
    expect((await store.read(DAY)).version).toBe(1);
  });
});
