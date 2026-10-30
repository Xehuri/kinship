/**
 * L6 registry flow 接线：flowEnded 作为非 error 终局 + idle 携 flow + 唤醒去重。
 *
 * Given flow 启用的 SessionRegistry（converge 已退役、MemoryFlowStore 固定时钟）；
 * When 模型 flow_commit waiting_user；Then idle 帧携 flow、onAutoWake 只武装最早计划，
 * 后续无提交 run（含排队 prompt）不重复武装同一 next_decision_at。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MemoryFlowStore, MemorySessionStore } from "@axeuh/loom-core";
import { createFakeModel, type FakeAssistantResponse } from "@axeuh/loom-core/testing";

import { SessionRegistry } from "./registry.js";

const NOW = Date.UTC(2026, 9, 23, 9, 0, 0);

function flowTurn(args: Record<string, unknown>): FakeAssistantResponse {
  return {
    content: [
      { type: "text", text: "记录心流" },
      { type: "toolCall", name: "flow_commit", arguments: args },
    ],
  };
}

function textTurn(text: string, delayMs?: number): FakeAssistantResponse {
  return {
    content: [{ type: "text", text }],
    ...(delayMs === undefined ? {} : { delayMs }),
  };
}

interface WakeCall {
  readonly sessionID: string;
  readonly at: number | null;
}

let stateRoot = "";

beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), "loom-flow-registry-"));
});

afterEach(() => {
  rmSync(stateRoot, { recursive: true, force: true });
});

async function waitRun(rec: { running: Promise<void> | null }): Promise<void> {
  while (rec.running !== null) await rec.running;
}

function makeHarness(script: readonly FakeAssistantResponse[]): {
  readonly registry: SessionRegistry;
  readonly store: MemoryFlowStore;
  readonly wakes: WakeCall[];
  readonly model: ReturnType<typeof createFakeModel>;
  readonly clock: { now: number };
} {
  const model = createFakeModel([...script]);
  const clock = { now: NOW };
  const store = new MemoryFlowStore({ now: () => clock.now });
  const wakes: WakeCall[] = [];
  const registry = new SessionRegistry({
    model,
    store: new MemorySessionStore(),
    stateRoot,
    now: () => clock.now,
    flow: { store },
    converge: "disabled",
    onAutoWake: (sessionID, at) => wakes.push({ sessionID, at }),
  });
  return { registry, store, wakes, model, clock };
}

describe("SessionRegistry flow 接线", () => {
  it("flowEnded 是非 error 终局：status=idle，session.idle 携 flow，最早计划只武装一次", async () => {
    const h = makeHarness([
      flowTurn({ subject_name: "主线", state: "waiting_user", next_decision_at: "10m" }),
    ]);
    try {
      const rec = h.registry.create();
      const publish = vi.spyOn(rec.hub, "publish");
      h.registry.send(rec.sessionID, "挂起等用户");
      await waitRun(rec);

      expect(rec.status).toBe("idle");
      expect(rec.lastError).toBeNull();
      expect(h.wakes).toEqual([{ sessionID: rec.sessionID, at: NOW + 600_000 }]);

      const idle = publish.mock.calls.find((call) => call[0] === "session.idle");
      expect(idle).toBeDefined();
      expect(idle?.[2]).toMatchObject({
        id: rec.sessionID,
        status: { type: "idle" },
        flow: {
          subject_name: "主线",
          state: "waiting_user",
          next_decision_at: NOW + 600_000,
        },
      });
      expect(publish.mock.calls.some((call) => call[0] === "session.error")).toBe(false);
    } finally {
      h.model.teardown();
    }
  });

  it("同一 next_decision_at 的后续 run（含排队 prompt）不重复武装，避免唤醒回环", async () => {
    const h = makeHarness([
      flowTurn({ subject_name: "主线", state: "waiting_user", next_decision_at: "10m" }),
      textTurn("唤醒后无新提交", 100),
      textTurn("排队 prompt 收尾"),
    ]);
    try {
      const rec = h.registry.create();
      h.registry.send(rec.sessionID, "挂起等用户");
      await waitRun(rec);
      expect(h.wakes).toHaveLength(1);

      h.registry.deliverWake(rec.sessionID, "【心流唤醒】到点主体：主线", {
        title: "自动唤醒",
        message: "到点",
        variant: "info",
      });
      h.registry.send(rec.sessionID, "排队消息");
      await waitRun(rec);

      expect(h.wakes, "同一 (sid, at) 只武装一次").toEqual([
        { sessionID: rec.sessionID, at: NOW + 600_000 },
      ]);
      expect(rec.status).toBe("idle");
    } finally {
      h.model.teardown();
    }
  });

  it("多主体：最早计划投递后推进到下一个更晚的 next_decision_at", async () => {
    const h = makeHarness([
      flowTurn({ subject_name: "甲", state: "waiting_user", next_decision_at: "10m" }),
      flowTurn({ subject_name: "乙", state: "waiting_user", next_decision_at: "20m" }),
      textTurn("甲到点后的唤醒轮"),
      textTurn("乙到点后的唤醒轮"),
    ]);
    try {
      const rec = h.registry.create();
      h.registry.send(rec.sessionID, "甲挂起");
      await waitRun(rec);
      h.registry.send(rec.sessionID, "乙挂起");
      await waitRun(rec);
      expect(h.wakes).toEqual([{ sessionID: rec.sessionID, at: NOW + 600_000 }]);

      h.clock.now = NOW + 600_000;
      h.registry.deliverWake(rec.sessionID, "【心流唤醒】到点主体：甲", {
        title: "自动唤醒",
        message: "到点",
        variant: "info",
      });
      await waitRun(rec);

      expect(h.wakes).toEqual([
        { sessionID: rec.sessionID, at: NOW + 600_000 },
        { sessionID: rec.sessionID, at: NOW + 1_200_000 },
      ]);

      h.clock.now = NOW + 1_200_000;
      h.registry.deliverWake(rec.sessionID, "【心流唤醒】到点主体：乙", {
        title: "自动唤醒",
        message: "到点",
        variant: "info",
      });
      await waitRun(rec);
      expect(h.wakes, "两个计划都投递后不回退武装 overdue 的 10m").toHaveLength(2);
    } finally {
      h.model.teardown();
    }
  });

  it("closed 后无 pending：onAutoWake(null) 清除旧计划", async () => {
    const h = makeHarness([
      flowTurn({ subject_name: "主线", state: "waiting_user", next_decision_at: "10m" }),
    ]);
    try {
      const rec = h.registry.create();
      h.registry.send(rec.sessionID, "先挂起");
      await waitRun(rec);
      expect(h.wakes).toEqual([{ sessionID: rec.sessionID, at: NOW + 600_000 }]);

      // 第二次提交用真实 subject_id/version（从 store 读现值，避免 CAS 失败）。
      const subject = await h.store.findByName(rec.sessionID, "主线");
      if (subject === null) throw new Error("subject 未创建");
      h.model.push(
        flowTurn({
          subject_id: subject.subject_id,
          expected_version: subject.version,
          state: "closed",
        }),
      );
      h.registry.send(rec.sessionID, "收口");
      await waitRun(rec);

      expect(h.wakes.at(-1)).toEqual({ sessionID: rec.sessionID, at: null });
      expect(rec.status).toBe("idle");
    } finally {
      h.model.teardown();
    }
  });
});
