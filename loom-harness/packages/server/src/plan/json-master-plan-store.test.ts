/**
 * JsonMasterPlanStore 验收：CAS、锁竞争、损坏回落 last-good、not-found
 * 不创建文件、master.md 渲染与 edit 版本推进。全部使用 mkdtemp。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { afterEach, describe, expect, it } from "vitest";

import { FileLockTimeoutError, withFileLock } from "./file-lock.js";
import { JsonMasterPlanStore } from "./json-master-plan-store.js";
import {
  MasterPlanConflictError,
  MasterPlanCorruptError,
  MasterPlanNotFoundError,
  type MasterEntry,
  type MasterPlanDocument,
} from "./master-plan.js";

const NOW = Date.UTC(2026, 9, 27, 4, 0, 0);
const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "master-plan-store-"));
  roots.push(root);
  return root;
}

function entry(overrides: Partial<MasterEntry> = {}): MasterEntry {
  return {
    id: "daily-review",
    kind: "fixed",
    title: "今日复盘",
    enabled: true,
    action: "review.daily",
    schedule: { kind: "daily", at: "00:40" },
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function doc(entries: readonly MasterEntry[] = [entry()]): MasterPlanDocument {
  return {
    schema: 1,
    kind: "master-plan",
    timezone: "Asia/Shanghai",
    version: 1,
    created_at: NOW,
    updated_at: NOW,
    entries,
  };
}

function storeAt(root: string, clock = { now: NOW }, lockTimeoutMs = 2_000): JsonMasterPlanStore {
  return new JsonMasterPlanStore({
    planRoot: root,
    now: () => clock.now,
    lockTimeoutMs,
  });
}

describe("读写与 CAS", () => {
  it("write(null) 创建 version 1，三份文件落盘且 JSON 可回读", async () => {
    const root = tempRoot();
    const store = storeAt(root);
    const created = await store.write(doc(), null);

    expect(created.version).toBe(1);
    expect(existsSync(join(root, "plan", "master.json"))).toBe(true);
    expect(existsSync(join(root, "plan", "master.md"))).toBe(true);
    expect(existsSync(join(root, "plan", "master.last-good.json"))).toBe(true);
    expect(await store.read()).toEqual(created);
    expect(readFileSync(join(root, "plan", "master.md"), "utf8")).toContain(
      "### daily-review [fixed] 今日复盘",
    );
  });

  it("expectedVersion 匹配时推进版本，过期版本抛冲突且不落盘", async () => {
    const clock = { now: NOW };
    const root = tempRoot();
    const store = storeAt(root, clock);
    await store.write(doc(), null);

    clock.now = NOW + 1_000;
    const updated = await store.write(doc([entry({ title: "改名" })]), 1);
    expect(updated.version).toBe(2);
    expect(updated.updated_at).toBe(NOW + 1_000);
    expect(updated.created_at).toBe(NOW);

    await expect(store.write(doc(), 1)).rejects.toBeInstanceOf(MasterPlanConflictError);
    expect((await store.read()).version).toBe(2);
    await expect(store.write(doc(), null)).rejects.toBeInstanceOf(MasterPlanConflictError);
  });

  it("并发同版本写入只有一个成功，另一个冲突", async () => {
    const root = tempRoot();
    const store = storeAt(root);
    await store.write(doc(), null);

    const results = await Promise.allSettled([
      store.write(doc([entry({ title: "A" })]), 1),
      store.write(doc([entry({ title: "B" })]), 1),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ reason: expect.any(MasterPlanConflictError) });
    expect((await store.read()).version).toBe(2);
  });
});

describe("锁与损坏", () => {
  it("其他持有者占锁时 write 超时并抛 FileLockTimeoutError", async () => {
    const root = tempRoot();
    const store = storeAt(root, { now: NOW }, 80);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked = false;
    const holder = withFileLock(store.paths().lock, () => {
      locked = true;
      return gate;
    });
    while (!locked) await sleep(2);

    await expect(store.write(doc(), null)).rejects.toBeInstanceOf(FileLockTimeoutError);
    release();
    await holder;
    expect(existsSync(join(root, "plan", "master.json"))).toBe(false);
  });

  it("主文件损坏时 read 抛 typed corrupt，readLastGood 回落备份", async () => {
    const root = tempRoot();
    const store = storeAt(root);
    const created = await store.write(doc(), null);
    writeFileSync(join(root, "plan", "master.json"), "{not-json", "utf8");

    await expect(store.read()).rejects.toBeInstanceOf(MasterPlanCorruptError);
    expect(await store.readLastGood()).toEqual(created);
    expect(await store.lastGood()).toEqual(created);
  });

  it("read 不创建目录或文件；not-found 是 typed error", async () => {
    const root = tempRoot();
    const store = storeAt(root);
    await expect(store.read()).rejects.toBeInstanceOf(MasterPlanNotFoundError);
    expect(existsSync(join(root, "plan"))).toBe(false);
  });

  it("主文件缺失时 readLastGood 不臆造回落到备份", async () => {
    const root = tempRoot();
    const store = storeAt(root);
    await store.write(doc(), null);
    rmSync(join(root, "plan", "master.json"));
    await expect(store.readLastGood()).rejects.toBeInstanceOf(MasterPlanNotFoundError);
  });
});

describe("edit", () => {
  it("按 expectedVersion 应用 op 并推进文档/条目时间", async () => {
    const clock = { now: NOW };
    const root = tempRoot();
    const store = storeAt(root, clock);
    await store.write(doc(), null);

    clock.now = NOW + 5_000;
    const edited = await store.edit(
      [{ op: "set_enabled", id: "daily-review", enabled: false }],
      1,
      "pause review",
    );
    expect(edited.version).toBe(2);
    expect(edited.updated_at).toBe(NOW + 5_000);
    expect(edited.entries[0]?.enabled).toBe(false);
    expect(edited.entries[0]?.updated_at).toBe(NOW + 5_000);

    await expect(
      store.edit([{ op: "set_enabled", id: "daily-review", enabled: true }], 1, "stale"),
    ).rejects.toBeInstanceOf(MasterPlanConflictError);
  });

  it("edit 不存在的 master 抛 not-found", async () => {
    const root = tempRoot();
    const store = storeAt(root);
    await expect(
      store.edit([{ op: "remove_entry", id: "daily-review" }], 1, "none"),
    ).rejects.toBeInstanceOf(MasterPlanNotFoundError);
  });
});
