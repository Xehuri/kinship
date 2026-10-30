/**
 * 自动唤醒 registry 接线验收：converged 回执的 nextWakeAt → onAutoWake；
 * autoWakeEnabled=false 的拒收/继续；deliverWake 三参通知属性透传（两参仍走 PTY 缺省）。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MemorySessionStore, type Limits, type Message } from "@axeuh/loom-core";
import { createFakeModel, type FakeAssistantResponse } from "@axeuh/loom-core/testing";

import { ptyExitNotifyProps } from "./pty-notify.js";
import { SessionRegistry } from "./registry.js";

const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);

function convergeTurn(text: string, args: Record<string, unknown>): FakeAssistantResponse {
  return {
    content: [
      { type: "text", text },
      { type: "toolCall", name: "converge", arguments: args },
    ],
  };
}

function textTurn(text: string): FakeAssistantResponse {
  return { content: [{ type: "text", text }] };
}

function textOf(message: Message): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map((block) =>
      typeof block === "object" && block !== null && "text" in block
        ? String((block as { text: unknown }).text)
        : "",
    )
    .join("");
}

interface WakeCall {
  readonly sessionID: string;
  readonly at: number | null;
}

interface Harness {
  readonly registry: SessionRegistry;
  readonly model: ReturnType<typeof createFakeModel>;
  readonly wakes: WakeCall[];
  readonly teardown: () => void;
}

function makeRegistry(
  script: readonly FakeAssistantResponse[],
  opts: { autoWakeEnabled?: boolean; limits?: Limits } = {},
): Harness {
  const model = createFakeModel([...script]);
  const wakes: WakeCall[] = [];
  const registry = new SessionRegistry({
    model,
    store: new MemorySessionStore(),
    stateRoot,
    now: () => NOW,
    onAutoWake: (sessionID, at) => wakes.push({ sessionID, at }),
    ...(opts.autoWakeEnabled === undefined ? {} : { autoWakeEnabled: opts.autoWakeEnabled }),
    ...(opts.limits === undefined ? {} : { limits: opts.limits }),
  });
  return { registry, model, wakes, teardown: () => model.teardown() };
}

/** 等本轮及其接力队列全部收尾（finally 内 #drainQueue 可能起新轮）。 */
async function waitRun(rec: { running: Promise<void> | null }): Promise<void> {
  while (rec.running !== null) await rec.running;
}

let stateRoot = "";

beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), "loom-auto-wake-registry-"));
});

afterEach(() => {
  rmSync(stateRoot, { recursive: true, force: true });
});

describe("SessionRegistry 自动唤醒接线", () => {
  it("(a) converged 携带 wake=10m → onAutoWake 恰一次 (sid, now+600000)", async () => {
    const h = makeRegistry([convergeTurn("巡检收束", { status: "已完成", wake: "10m" })]);
    try {
      const rec = h.registry.create();
      h.registry.send(rec.sessionID, "十分钟后唤醒");
      await waitRun(rec);

      expect(h.wakes).toEqual([{ sessionID: rec.sessionID, at: NOW + 600_000 }]);
      expect(rec.status).toBe("idle");
    } finally {
      h.teardown();
    }
  });

  it("(b) converged 携带 wake=none → onAutoWake 收到显式清除 (sid, null)", async () => {
    const h = makeRegistry([convergeTurn("清除唤醒", { status: "已完成", wake: "none" })]);
    try {
      const rec = h.registry.create();
      h.registry.send(rec.sessionID, "清除自动唤醒");
      await waitRun(rec);

      expect(h.wakes).toEqual([{ sessionID: rec.sessionID, at: null }]);
    } finally {
      h.teardown();
    }
  });

  it("(c) converged 不带 wake → onAutoWake 不调用", async () => {
    const h = makeRegistry([convergeTurn("普通收束", { status: "已完成" })]);
    try {
      const rec = h.registry.create();
      h.registry.send(rec.sessionID, "普通收束");
      await waitRun(rec);

      expect(h.wakes).toEqual([]);
      expect(rec.status).toBe("idle");
    } finally {
      h.teardown();
    }
  });

  it("(d) 强制收束路（turnHardCap:1 纯文本）→ onAutoWake 不调用", async () => {
    const limits: Limits = {
      nudgeLimit: 5,
      escalateSameError: 3,
      turnHardCap: 1,
      autoContinuations: 0,
    };
    const h = makeRegistry([textTurn("只说不收束")], { limits });
    try {
      const rec = h.registry.create();
      h.registry.send(rec.sessionID, "只说不收束");
      await waitRun(rec);

      expect(h.model.getCalls()).toHaveLength(1);
      expect(h.wakes).toEqual([]);
    } finally {
      h.teardown();
    }
  });

  it("(e) autoWakeEnabled:false → 带 wake 被拒收并继续，后续无 wake 收束成功且不回调", async () => {
    const h = makeRegistry(
      [
        convergeTurn("第一次带唤醒", { status: "已完成", wake: "10m" }),
        convergeTurn("第二次不带唤醒", { status: "已完成" }),
      ],
      { autoWakeEnabled: false },
    );
    try {
      const rec = h.registry.create();
      h.registry.send(rec.sessionID, "禁用自动唤醒后收束");
      await waitRun(rec);

      const transcript = rec.loop.messages.map(textOf).join("\n");
      expect(transcript).toContain("自动唤醒已禁用");
      expect(h.model.getCalls()).toHaveLength(2);
      expect(rec.status).toBe("idle");
      expect(h.wakes).toEqual([]);
    } finally {
      h.teardown();
    }
  });

  it("(f) deliverWake 三参透传自定义通知属性；两参仍是 PTY 缺省属性", async () => {
    const h = makeRegistry([
      convergeTurn("第一次唤醒", { status: "已完成" }),
      convergeTurn("第二次唤醒", { status: "已完成" }),
    ]);
    try {
      const rec = h.registry.create();
      const publish = vi.spyOn(rec.hub, "publish");
      const customProps = { title: "自动唤醒", message: "设定时间已到", variant: "info" };
      const ptyLine = "ID: pty_registry\nExit Code: 0\nLast Line: done";

      h.registry.deliverWake(rec.sessionID, "自定义唤醒行", customProps);
      h.registry.deliverWake(rec.sessionID, ptyLine);

      const notifyCalls = publish.mock.calls.filter((call) => call[0] === "delivery.notify");
      expect(notifyCalls[0]).toEqual(["delivery.notify", rec.sessionID, customProps]);
      expect(notifyCalls[1]).toEqual(["delivery.notify", rec.sessionID, ptyExitNotifyProps(ptyLine)]);

      await waitRun(rec);
    } finally {
      h.teardown();
    }
  });
});
