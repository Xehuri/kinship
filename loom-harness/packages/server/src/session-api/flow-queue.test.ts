/**
 * T10 flow 唤醒队列对账：plan+flow 共存、每 pending 主体一条、来源隔离、stale 清理与旧回调回落。
 *
 * Given flow 启用的 SessionRegistry（MemoryFlowStore 固定时钟）；When 模型提交多个
 * waiting_user 主体或收口；Then onWakeReconcileSource 只对账 flow 来源，plan 条目原样保留；
 * 无新回调时 onAutoWake 单槽行为不变。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MemoryFlowStore, MemorySessionStore } from "@axeuh/loom-core";
import { createFakeModel, type FakeAssistantResponse } from "@axeuh/loom-core/testing";

import { WakeQueue, type WakeQueueEntry } from "../serve/wake-queue.js";
import { SessionRegistry } from "./registry.js";
import type { WakeQueueEntryLike } from "./types.js";

const NOW = Date.UTC(2026, 9, 28, 8, 0, 0);

function flowTurn(args: Record<string, unknown>): FakeAssistantResponse {
  return { content: [{ type: "text", text: "记录心流" }, { type: "toolCall", name: "flow_commit", arguments: args }] };
}

async function waitRun(rec: { running: Promise<void> | null }): Promise<void> {
  while (rec.running !== null) await rec.running;
}

interface HarnessOptions {
  readonly script: readonly FakeAssistantResponse[];
  readonly onReconcile?: (sessionID: string, source: "flow", entries: readonly WakeQueueEntryLike[]) => void;
  readonly onAutoWake?: (sessionID: string, at: number | null) => void;
}

function makeHarness(options: HarnessOptions): { readonly registry: SessionRegistry; readonly model: ReturnType<typeof createFakeModel>; readonly store: MemoryFlowStore } {
  const model = createFakeModel([...options.script]);
  const store = new MemoryFlowStore({ now: () => NOW });
  const registry = new SessionRegistry({
    model,
    store: new MemorySessionStore(),
    stateRoot,
    now: () => NOW,
    flow: { store },
    converge: "disabled",
    ...(options.onReconcile === undefined ? {} : { onWakeReconcileSource: options.onReconcile }),
    ...(options.onAutoWake === undefined ? {} : { onAutoWake: options.onAutoWake }),
  });
  return { registry, model, store };
}

function entriesOf(
  entries: readonly WakeQueueEntry[],
  source: WakeQueueEntry["source"],
): WakeQueueEntry[] {
  return entries.filter((entry) => entry.source === source);
}

let stateRoot = "";

beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), "loom-flow-queue-"));
});

afterEach(() => {
  rmSync(stateRoot, { recursive: true, force: true });
});

describe("SessionRegistry flow 唤醒队列对账", () => {
  it("plan 与多个 flow 主体共存：每 pending 主体一条 flow 条目，plan 原样保留", async () => {
    let queueRef: WakeQueue | null = null;
    const h = makeHarness({
      script: [
        flowTurn({ subject_name: "甲", state: "waiting_user", next_decision_at: "10m" }),
        flowTurn({ subject_name: "乙", state: "waiting_user", next_decision_at: "20m" }),
      ],
      onReconcile: (_sessionID, source, entries) => {
        if (queueRef !== null) void queueRef.reconcileSource(source, entries);
      },
    });
    try {
      // Given：一个已有 plan 条目、flow 回调接管对账的队列
      const rec = h.registry.create();
      const queue = new WakeQueue({
        stateRoot,
        sessionID: rec.sessionID,
        now: () => NOW,
      });
      queueRef = queue;
      await queue.enqueue({
        id: "05-plan-wake",
        source: "plan",
        at: NOW + 300_000,
        payload: { title: "计划唤醒" },
      });

      // When：两轮分别提交一个 waiting_user 主体
      h.registry.send(rec.sessionID, "甲挂起");
      await waitRun(rec);
      h.registry.send(rec.sessionID, "乙挂起");
      await waitRun(rec);

      // Then：plan 条目不变，flow 恰两条例目且各自对应一个 pending 主体
      await vi.waitFor(async () => expect(entriesOf((await queue.snapshot()).entries, "flow")).toHaveLength(2));
      const snapshot = await queue.snapshot();
      const plan = entriesOf(snapshot.entries, "plan");
      const flow = entriesOf(snapshot.entries, "flow");
      const subjectA = await h.store.findByName(rec.sessionID, "甲");
      const subjectB = await h.store.findByName(rec.sessionID, "乙");
      if (subjectA === null || subjectB === null) throw new Error("主体未创建");

      expect(plan).toEqual([
        expect.objectContaining({
          id: "05-plan-wake",
          at: NOW + 300_000,
          payload: { title: "计划唤醒" },
        }),
      ]);
      expect(flow).toEqual([
        expect.objectContaining({
          id: expect.stringContaining(subjectA.subject_id),
          source: "flow",
          action: "flow.check",
          at: NOW + 600_000,
          payload: { subject_id: subjectA.subject_id, at: NOW + 600_000 },
          created_at: NOW,
          attempts: 0,
        }),
        expect.objectContaining({
          id: expect.stringContaining(subjectB.subject_id),
          source: "flow",
          action: "flow.check",
          at: NOW + 1_200_000,
          payload: { subject_id: subjectB.subject_id, at: NOW + 1_200_000 },
          created_at: NOW,
          attempts: 0,
        }),
      ]);
    } finally {
      h.model.teardown();
    }
  });

  it("closed 与 stale flow 只清 flow：plan 条目原样保留", async () => {
    let queueRef: WakeQueue | null = null;
    const h = makeHarness({
      script: [
        flowTurn({ subject_name: "主线", state: "waiting_user", next_decision_at: "10m" }),
      ],
      onReconcile: (_sessionID, source, entries) => {
        if (queueRef !== null) void queueRef.reconcileSource(source, entries);
      },
    });
    try {
      // Given：plan 条目 + 一个 waiting_user 主体
      const rec = h.registry.create();
      const queue = new WakeQueue({
        stateRoot,
        sessionID: rec.sessionID,
        now: () => NOW,
      });
      queueRef = queue;
      await queue.enqueue({
        id: "05-plan-wake",
        source: "plan",
        at: NOW + 300_000,
        payload: { title: "计划唤醒" },
      });
      h.registry.send(rec.sessionID, "先挂起");
      await waitRun(rec);
      await vi.waitFor(async () => expect(entriesOf((await queue.snapshot()).entries, "flow")).toHaveLength(1));

      // When：主体收口
      const subject = await h.store.findByName(rec.sessionID, "主线");
      if (subject === null) throw new Error("主体未创建");
      h.model.push(
        flowTurn({
          subject_id: subject.subject_id,
          expected_version: subject.version,
          state: "closed",
        }),
      );
      h.registry.send(rec.sessionID, "收口");
      await waitRun(rec);

      // Then：flow 被清空、plan 原样保留
      await vi.waitFor(async () => {
        const snapshot = await queue.snapshot();
        expect(entriesOf(snapshot.entries, "flow")).toHaveLength(0);
        expect(entriesOf(snapshot.entries, "plan")).toHaveLength(1);
      });

      // When：队列里残留一个已不在 FlowStore 的 stale flow 条目后 boot 对账
      await queue.enqueue({
        id: "flow.stale",
        source: "flow",
        action: "flow.check",
        at: NOW + 999_999,
        payload: { subject_id: "flow_stale", at: NOW + 999_999 },
        created_at: NOW,
        attempts: 0,
      });
      await h.registry.reconcileFlowWakes();

      // Then：stale flow 被取消，plan 仍原样保留
      const snapshot = await queue.snapshot();
      expect(entriesOf(snapshot.entries, "flow")).toHaveLength(0);
      expect(entriesOf(snapshot.entries, "plan")).toEqual([
        expect.objectContaining({ id: "05-plan-wake", at: NOW + 300_000 }),
      ]);
    } finally {
      h.model.teardown();
    }
  });

  it("reconcileFlowWakes 按 pending 主体重建 flow 条目（boot 多主体恢复）", async () => {
    let queueRef: WakeQueue | null = null;
    const h = makeHarness({
      script: [
        flowTurn({ subject_name: "甲", state: "waiting_user", next_decision_at: "10m" }),
        flowTurn({ subject_name: "乙", state: "waiting_user", next_decision_at: "20m" }),
      ],
      onReconcile: (_sessionID, source, entries) => {
        if (queueRef !== null) void queueRef.reconcileSource(source, entries);
      },
    });
    try {
      // Given：两个 pending 主体已对账进队列
      const rec = h.registry.create();
      const queue = new WakeQueue({
        stateRoot,
        sessionID: rec.sessionID,
        now: () => NOW,
      });
      queueRef = queue;
      h.registry.send(rec.sessionID, "甲挂起");
      await waitRun(rec);
      h.registry.send(rec.sessionID, "乙挂起");
      await waitRun(rec);
      await vi.waitFor(async () => expect(entriesOf((await queue.snapshot()).entries, "flow")).toHaveLength(2));

      // When：flow 条目被清空后执行 boot 对账
      await queue.reconcileSource("flow", []);
      expect(entriesOf((await queue.snapshot()).entries, "flow")).toHaveLength(0);
      await h.registry.reconcileFlowWakes();

      // Then：从 FlowStore 重建出每主体一条
      const subjectA = await h.store.findByName(rec.sessionID, "甲");
      const subjectB = await h.store.findByName(rec.sessionID, "乙");
      if (subjectA === null || subjectB === null) throw new Error("主体未创建");
      const snapshot = await queue.snapshot();
      const flow = entriesOf(snapshot.entries, "flow");
      expect(flow.map((entry) => entry.payload)).toEqual([
        { subject_id: subjectA.subject_id, at: NOW + 600_000 },
        { subject_id: subjectB.subject_id, at: NOW + 1_200_000 },
      ]);
    } finally {
      h.model.teardown();
    }
  });

  it("无新回调时保持 onAutoWake 单槽旧行为", async () => {
    const wakes: Array<{ readonly sessionID: string; readonly at: number | null }> = [];
    const h = makeHarness({
      script: [
        flowTurn({ subject_name: "甲", state: "waiting_user", next_decision_at: "10m" }),
        flowTurn({ subject_name: "乙", state: "waiting_user", next_decision_at: "20m" }),
      ],
      onAutoWake: (sessionID, at) => wakes.push({ sessionID, at }),
    });
    try {
      // Given：只有旧 onAutoWake 的 flow 会话
      const rec = h.registry.create();

      // When：先后提交两个 pending 主体
      h.registry.send(rec.sessionID, "甲挂起");
      await waitRun(rec);
      h.registry.send(rec.sessionID, "乙挂起");
      await waitRun(rec);

      // Then：仍在最早计划上单槽武装一次，主体反查面保持可用
      expect(wakes).toEqual([{ sessionID: rec.sessionID, at: NOW + 600_000 }]);
      expect(h.registry.flowWakeSubjectAt(rec.sessionID, NOW + 600_000)).toBe(NOW + 600_000);
    } finally {
      h.model.teardown();
    }
  });
});
