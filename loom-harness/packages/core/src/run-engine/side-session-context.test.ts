/**
 * Side-session per-run context watcher.
 *
 * Given: a real temp workspace, a binding seeded from its memory sources, and a scripted model
 * When:  a side run mutates a watched source mid-run (or a degraded source appears for the first time)
 * Then:  the next LLM call carries exactly one durable <system-reminder> notice, the run-start call
 *        does not, and a static fallback (no binding) never installs a watcher.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Context, Message } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";

import { Type, type HarnessTool } from "../index.js";
import { createFakeModel, type FakeAssistantResponse } from "../testing.js";
import { createSideSessionPort, type SideRunBinding } from "./side-session-port.js";
import type { RunLaunchContext, RunRow } from "./types.js";

const REL = "AGENTS.md";
const V1 = "# AGENTS\nrule one\n";
const V2 = "# AGENTS\nrule one\nrule two changed\n";
const ROOT_PREFIX = "loom-side-ctx-";

const roots: string[] = [];

function workspace(initial: string | null): string {
  const root = mkdtempSync(join(tmpdir(), ROOT_PREFIX));
  roots.push(root);
  if (initial !== null) writeFileSync(join(root, REL), initial, "utf8");
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function ctx(sessionId: string): RunLaunchContext {
  const row: RunRow = {
    run_id: "run_sidectx00000001",
    workflow: "w",
    attempt: 1,
    trigger: "manual",
    parent_run: null,
    session_id: sessionId,
  };
  return { row, prompt: "任务正文", signal: new AbortController().signal };
}

function binding(systemPrompt: string, root: string, content: string): SideRunBinding {
  return {
    systemPrompt,
    memorySources: [{ source: REL, content, degrade: null }],
    workspaceRoot: root,
  };
}

function messageText(message: Message): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");
}

function userTexts(context: Context): string[] {
  return context.messages.filter((message) => message.role === "user").map(messageText);
}

function noticesOf(context: Context): string[] {
  return userTexts(context).filter((text) => text.includes("<system-reminder>"));
}

function mutateTool(root: string, text: string): HarnessTool {
  return {
    name: "mutate-agents",
    description: "rewrite AGENTS.md while the run is in flight",
    parameters: Type.Object({}),
    async execute() {
      writeFileSync(join(root, REL), text, "utf8");
      return { content: [{ type: "text" as const, text: "mutated" }] };
    },
  };
}

const convergeTurn: FakeAssistantResponse = {
  content: [
    { type: "text", text: "done" },
    {
      type: "toolCall",
      name: "converge",
      arguments: { status: "done", runId: "x", workflow: "w", attempt: 1, digest: "done" },
    },
  ],
};

const toolTurn = (name: string): FakeAssistantResponse => ({
  content: [{ type: "toolCall", name, arguments: {} }],
});

describe("createSideSessionPort per-run context watcher", () => {
  it("mid-run source change lands as a durable diff notice before the next LLM call", async () => {
    const root = workspace(V1);
    const model = createFakeModel([toolTurn("mutate-agents"), convergeTurn]);
    const port = createSideSessionPort({
      model,
      tools: [mutateTool(root, V2)],
      resolveBinding: () => Promise.resolve(binding("SIDE", root, V1)),
    });

    await port.run(ctx("ses_sidectx_diff0001"));

    const calls = model.getCalls();
    expect(calls).toHaveLength(2);
    expect(noticesOf(calls[0]!)).toEqual([]);
    const notices = noticesOf(calls[1]!);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("<system-reminder>");
    expect(notices[0]).toContain("Updated instructions from: AGENTS.md");
    expect(notices[0]).toContain("@@ -");
    expect(notices[0]).toContain("+rule two changed");
  });

  it("seeds the exact loaded content: an unchanged source produces no notice", async () => {
    const root = workspace(V1);
    const model = createFakeModel([convergeTurn]);
    const port = createSideSessionPort({
      model,
      resolveBinding: () => Promise.resolve(binding("SIDE", root, V1)),
    });

    await port.run(ctx("ses_sidectx_same0001"));

    const calls = model.getCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBeDefined();
    expect(noticesOf(calls[0]!)).toEqual([]);
  });

  it("static fallback (no binding) keeps the old path: no watcher, no notices", async () => {
    const model = createFakeModel([convergeTurn]);
    const port = createSideSessionPort({ model, systemPrompt: "STATIC" });

    await port.run(ctx("ses_sidectx_static1"));

    const calls = model.getCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.systemPrompt).toBe("STATIC");
    expect(noticesOf(calls[0]!)).toEqual([]);
  });

  it("degraded source first appearance becomes an Additional-instructions notice", async () => {
    const root = workspace(null);
    const model = createFakeModel([toolTurn("mutate-agents"), convergeTurn]);
    const port = createSideSessionPort({
      model,
      tools: [mutateTool(root, V1)],
      resolveBinding: () =>
        Promise.resolve({
          systemPrompt: "SIDE",
          memorySources: [
            {
              source: REL,
              content: "PLACEHOLDER",
              degrade: { segment: "memory", source: REL, reason: "missing", detail: null },
            },
          ],
          workspaceRoot: root,
        }),
    });

    await port.run(ctx("ses_sidectx_degrade1"));

    const calls = model.getCalls();
    expect(calls).toHaveLength(2);
    expect(noticesOf(calls[0]!)).toEqual([]);
    const notices = noticesOf(calls[1]!);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("Additional instructions from: AGENTS.md");
    expect(notices[0]).toContain("rule one");
  });

  it("builds a fresh watcher per run: no replay of run one's diff, no inherited watermark", async () => {
    const root = workspace(V1);
    let bindingText = V1;
    const model = createFakeModel([toolTurn("mutate-agents"), convergeTurn]);
    const port = createSideSessionPort({
      model,
      tools: [mutateTool(root, V2)],
      resolveBinding: () => Promise.resolve(binding("SIDE", root, bindingText)),
    });

    await port.run(ctx("ses_sidectx_fresh001"));
    bindingText = V2;
    model.push(convergeTurn);
    await port.run(ctx("ses_sidectx_fresh002"));
    bindingText = V1;
    model.push(convergeTurn);
    await port.run(ctx("ses_sidectx_fresh003"));

    const calls = model.getCalls();
    expect(calls).toHaveLength(4);
    expect(noticesOf(calls[1]!)).toHaveLength(1);
    expect(noticesOf(calls[2]!)).toEqual([]);
    const freshNotice = noticesOf(calls[3]!);
    expect(freshNotice).toHaveLength(1);
    expect(freshNotice[0]).toContain("Updated instructions from: AGENTS.md");
  });
});
