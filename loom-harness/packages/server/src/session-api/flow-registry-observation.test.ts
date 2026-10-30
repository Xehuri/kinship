/**
 * L9 观察窗 registry 集成：临时 stateRoot 的 flow run 产出 armed/flowEnded/idle/unset。
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MemorySessionStore } from "@axeuh/loom-core";
import { createFakeModel, type FakeAssistantResponse } from "@axeuh/loom-core/testing";

import {
  createFlowObservationSink,
  FLOW_OBSERVATION_EVENTS_FILE,
} from "../flow/index.js";
import { JsonFlowStore } from "../flow/json-flow-store.js";
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

function textTurn(text: string): FakeAssistantResponse {
  return { content: [{ type: "text", text }] };
}

async function waitRun(rec: { running: Promise<void> | null }): Promise<void> {
  while (rec.running !== null) await rec.running;
}

function readEvents(root: string): Array<Record<string, unknown>> {
  const file = join(root, "flow-observation", FLOW_OBSERVATION_EVENTS_FILE);
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "loom-flow-registry-observation-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function makeHarness(script: readonly FakeAssistantResponse[]): Promise<{
  readonly registry: SessionRegistry;
  readonly model: ReturnType<typeof createFakeModel>;
}> {
  const sink = createFlowObservationSink({ stateRoot: root, now: () => NOW });
  const store = new JsonFlowStore({
    stateRoot: root,
    now: () => NOW,
    onUnset: (record) => {
      sink.observe({
        type: "flow.unset",
        session_id: record.session_id,
        reason: record.reason,
        turn_idx: record.turn_idx,
      });
    },
  });
  const model = createFakeModel([...script]);
  const registry = new SessionRegistry({
    model,
    store: new MemorySessionStore(),
    stateRoot: root,
    now: () => NOW,
    flow: { store },
    flowObservation: sink,
    converge: "disabled",
    onAutoWake: () => {},
  });
  return { registry, model };
}

describe("SessionRegistry flow observation", () => {
  it("emits wake.armed, flow.ended and session.idle with flow", async () => {
    const h = await makeHarness([
      flowTurn({ subject_name: "主线", state: "waiting_user", next_decision_at: "10m" }),
    ]);
    try {
      const rec = h.registry.create();
      h.registry.send(rec.sessionID, "挂起等用户");
      await waitRun(rec);

      const events = readEvents(root);
      const armed = events.find((event) => event.type === "wake.armed");
      expect(armed).toMatchObject({
        session_id: rec.sessionID,
        subject_at: NOW + 600_000,
        scheduled_at: NOW + 600_000,
      });

      const ended = events.find((event) => event.type === "flow.ended");
      expect(ended).toMatchObject({
        session_id: rec.sessionID,
        state: "waiting_user",
        next_decision_at: NOW + 600_000,
      });
      expect(typeof ended?.["subject_id"]).toBe("string");

      const idle = events.find((event) => event.type === "session.idle");
      expect(idle).toMatchObject({ session_id: rec.sessionID, has_flow: true });
      expect(idle?.["flow"]).toMatchObject({ state: "waiting_user" });

      const flowEndedAt = ended?.["ts"];
      const idleAt = idle?.["ts"];
      expect(typeof flowEndedAt).toBe("number");
      expect(typeof idleAt).toBe("number");
      expect(idleAt as number).toBeGreaterThanOrEqual(flowEndedAt as number);
    } finally {
      h.model.teardown();
    }
  });

  it("emits session.idle without flow and flow.unset on a text-only run", async () => {
    const h = await makeHarness([textTurn("普通回答")]);
    try {
      const rec = h.registry.create();
      h.registry.send(rec.sessionID, "普通提问");
      await waitRun(rec);

      const events = readEvents(root);
      const idle = events.find((event) => event.type === "session.idle");
      expect(idle).toMatchObject({ session_id: rec.sessionID, has_flow: false, flow: null });

      const unset = events.find((event) => event.type === "flow.unset");
      expect(unset).toMatchObject({
        session_id: rec.sessionID,
        reason: "run_end_no_commit",
      });
      expect(typeof unset?.["turn_idx"]).toBe("number");
    } finally {
      h.model.teardown();
    }
  });
});
