/**
 * L6 flow 唤醒渲染单测：due / stale / 多主体。
 *
 * Given MemoryFlowStore 的固定时钟；When refresh + render(at)；Then 只有仍 due 的主体
 * 出现在紧凑行里，无 due = null，多主体列出全部 due 并给出最早下次决策。
 */

import { describe, expect, it } from "vitest";

import { MemoryFlowStore, formatFlowTime } from "@axeuh/loom-core";

import { createFlowWakeRenderer, formatFlowWakeLine } from "./flow-wake.js";

const NOW = Date.UTC(2026, 9, 23, 8, 0, 0);

function makeStore(): MemoryFlowStore {
  return new MemoryFlowStore({ now: () => NOW });
}

async function waitSubject(
  store: MemoryFlowStore,
  name: string,
  next: string,
): Promise<void> {
  await store.commit(
    "sess_flow_wake",
    { subject_name: name, state: "waiting_user", next_decision_at: next },
    { turn_idx: 0, now: NOW },
  );
}

describe("flow wake renderer", () => {
  it("renders a due subject with its name/state/id and the earliest decision", async () => {
    const store = makeStore();
    await waitSubject(store, "主线", "10m");
    const renderer = createFlowWakeRenderer({ store });

    await renderer.refresh("sess_flow_wake");
    const line = renderer.render("sess_flow_wake", NOW + 600_000);

    expect(line).not.toBeNull();
    expect(line).toContain("【心流唤醒】");
    expect(line).toContain("主线");
    expect(line).toContain("waiting_user");
    expect(line).toMatch(/flow_[0-9a-f]{12}/);
    expect(line).toContain(formatFlowTime(NOW + 600_000));
  });

  it("returns null before the subject is due and when no subject is pending (stale)", async () => {
    const store = makeStore();
    await waitSubject(store, "主线", "10m");
    const renderer = createFlowWakeRenderer({ store });

    await renderer.refresh("sess_flow_wake");
    expect(renderer.render("sess_flow_wake", NOW + 599_999)).toBeNull();

    const empty = makeStore();
    const emptyRenderer = createFlowWakeRenderer({ store: empty });
    await emptyRenderer.refresh("sess_flow_wake");
    expect(emptyRenderer.render("sess_flow_wake", NOW + 600_000)).toBeNull();
  });

  it("lists every due subject and still reports the earliest next decision", async () => {
    const store = makeStore();
    await waitSubject(store, "甲", "10m");
    await waitSubject(store, "乙", "20m");
    const renderer = createFlowWakeRenderer({ store });

    await renderer.refresh("sess_flow_wake");
    const first = renderer.render("sess_flow_wake", NOW + 600_000);
    expect(first).toContain("甲");
    expect(first).not.toContain("乙");

    const both = renderer.render("sess_flow_wake", NOW + 1_200_000);
    expect(both).toContain("甲");
    expect(both).toContain("乙");
    expect(both).toContain(formatFlowTime(NOW + 600_000));
  });

  it("clear() drops the cached snapshot so render becomes null", async () => {
    const store = makeStore();
    await waitSubject(store, "主线", "10m");
    const renderer = createFlowWakeRenderer({ store });

    await renderer.refresh("sess_flow_wake");
    expect(renderer.render("sess_flow_wake", NOW + 600_000)).not.toBeNull();

    renderer.clear("sess_flow_wake");
    expect(renderer.render("sess_flow_wake", NOW + 600_000)).toBeNull();
  });

  it("formatFlowWakeLine ignores closed subjects even if they carry a stale decision time", () => {
    const closed = {
      schema: 1 as const,
      subject_id: "flow_000000000001",
      subject_name: "已收口",
      session_id: "sess_flow_wake",
      kind: "thread" as const,
      title: "",
      description: "",
      notes: [],
      notes_ref: null,
      state: "closed" as const,
      focus: "foreground" as const,
      version: 2,
      created_at: NOW,
      updated_at: NOW,
      next_decision_at: NOW,
      soft_deadline: null,
      due_at: null,
      timezone: null,
      schedule: null,
      parent_id: null,
      closed_at: NOW,
      close_reason: null,
      last_commit: { turn_idx: 1, at: NOW },
    };
    expect(formatFlowWakeLine([closed], NOW + 1)).toBeNull();
  });
});
