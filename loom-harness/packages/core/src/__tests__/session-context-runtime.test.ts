/**
 * Per-session context watcher runtime integration (AgentSession).
 *
 * Given: in-memory stat/read seams and a scripted fake model
 * When:  runs start, tools mutate the watched source, previews/reseeds arrive, compaction commits
 * Then:  durable user-role notices land immediately before the prompt (run start) or at the
 *        pre-LLM check point (per turn), deduped per run/turn, and never surface when disabled.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type, type Context, type Message } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";

import {
  ContextBaselineTemplate,
  SessionContextWatcher,
} from "../assembly/index.js";
import { CompactionStateStore } from "../compaction/index.js";
import { AgentSession, type AgentSessionOptions } from "../session.js";
import { MemorySessionStore } from "../session-store.js";
import { createFakeModel, type FakeAssistantResponse } from "../testing.js";
import { createUserMessage, type HarnessTool } from "../types.js";

const ROOT = "/fake-session-context";
const REL = "AGENTS.md";
const V1 = "# AGENTS\nrule one\nrule two\n";
const V2 = "# AGENTS\nrule one\nrule two changed\n";
const V3 = "# AGENTS\nrule one\nrule three\n";

const encoder = new TextEncoder();
const byteLength = (text: string): number => encoder.encode(text).length;

interface FakeFile {
  readonly mtimeMs: number;
  readonly size: number;
  readonly text: string;
}

class FakeWorkspace {
  readonly files = new Map<string, FakeFile>();
  reads = 0;

  readonly statFile = (
    absPath: string,
  ): { readonly mtimeMs: number; readonly size: number } | null => {
    const file = this.files.get(absPath);
    return file === undefined ? null : { mtimeMs: file.mtimeMs, size: file.size };
  };

  readonly readTextFile = (absPath: string): string | null => {
    const file = this.files.get(absPath);
    if (file === undefined) return null;
    this.reads += 1;
    return file.text;
  };

  set(relPath: string, text: string, mtimeMs: number): void {
    this.files.set(join(ROOT, relPath), {
      mtimeMs,
      size: byteLength(text),
      text,
    });
  }

  text(relPath: string): string {
    return this.files.get(join(ROOT, relPath))?.text ?? "";
  }
}

function watcherFor(
  workspace: FakeWorkspace,
  template?: ContextBaselineTemplate,
): SessionContextWatcher {
  return new SessionContextWatcher({
    workspaceRoot: ROOT,
    sources: [{ relPath: REL, content: workspace.text(REL) }],
    ...(template === undefined ? {} : { template }),
    statFile: workspace.statFile,
    readTextFile: workspace.readTextFile,
  });
}

function messageText(message: Message): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");
}

function userTexts(context: Context): string[] {
  return context.messages
    .filter((message) => message.role === "user")
    .map(messageText);
}

function noticeTexts(contexts: readonly Context[]): string[] {
  return contexts.flatMap((context) =>
    userTexts(context).filter((text) => text.includes("<system-reminder>")),
  );
}

function mutateTool(workspace: FakeWorkspace, text: string, mtimeMs: number): HarnessTool {
  return {
    name: "mutate-source",
    description: "把被侦听的源文件改成新内容（模拟运行中的外部编辑）",
    parameters: Type.Object({}),
    async execute() {
      workspace.set(REL, text, mtimeMs);
      return { content: [{ type: "text", text: "mutated" }] };
    },
  };
}

const textTurn = (text: string): FakeAssistantResponse => ({
  content: [{ type: "text", text }],
});

const toolTurn = (name: string): FakeAssistantResponse => ({
  content: [{ type: "toolCall", id: `${name}-1`, name, arguments: {} }],
});

const sessionId = (suffix: string): string => `ses_ctx_runtime_${suffix}`;

const cleanupRoots: string[] = [];

afterEach(() => {
  for (const root of cleanupRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("AgentSession context watcher notices", () => {
  it("injects the run-start notice immediately before the prompt and persists both", async () => {
    const workspace = new FakeWorkspace();
    workspace.set(REL, V1, 1);
    const watcher = watcherFor(workspace);
    const store = new MemorySessionStore();
    const model = createFakeModel([textTurn("ok")]);
    const session = new AgentSession({
      sessionId: sessionId("run_start"),
      model,
      tools: [],
      systemPrompt: "SYS",
      store,
      contextWatcher: watcher,
    });

    workspace.set(REL, V2, 2);
    const summary = await session.run("hello");

    expect(summary.reason).toBe("done");
    const firstCall = model.getCalls()[0]!;
    const messages = firstCall.messages;
    expect(messages).toHaveLength(2);
    expect(messageText(messages[0]!)).toContain("+rule two changed");
    expect(messageText(messages[0]!)).toContain("<system-reminder>");
    expect(messageText(messages[1]!)).toBe("hello");

    const stored = await store.getPathToLeaf(session.id);
    const storedMessages = stored
      .filter((entry) => entry.entry.kind === "message")
      .map((entry) => (entry.entry.kind === "message" ? entry.entry.message : null))
      .filter((message): message is Message => message !== null);
    const storedUserTexts = storedMessages
      .filter((message) => message.role === "user")
      .map(messageText);
    expect(storedUserTexts).toHaveLength(2);
    expect(storedUserTexts[0]).toContain("+rule two changed");
    expect(storedUserTexts[1]).toBe("hello");
    model.teardown();
  });

  it("checks every turn by default and injects a notice after a tool mutates the source", async () => {
    const workspace = new FakeWorkspace();
    workspace.set(REL, V1, 1);
    const watcher = watcherFor(workspace);
    const model = createFakeModel([toolTurn("mutate-source"), textTurn("done")]);
    const session = new AgentSession({
      sessionId: sessionId("per_turn"),
      model,
      tools: [mutateTool(workspace, V2, 2)],
      contextWatcher: watcher,
    });

    const summary = await session.run("go");

    expect(summary.reason).toBe("done");
    const calls = model.getCalls();
    expect(calls).toHaveLength(2);
    expect(noticeTexts([calls[0]!])).toHaveLength(0);
    const turnTwoUsers = userTexts(calls[1]!);
    expect(turnTwoUsers.at(-1)).toContain("+rule two changed");
    model.teardown();
  });

  it("dedupes the run-start turn so a later turn-0 mutation is not checked twice", async () => {
    const workspace = new FakeWorkspace();
    workspace.set(REL, V1, 1);
    const watcher = watcherFor(workspace);
    let mutated = false;
    const model = createFakeModel([textTurn("done")]);
    const session = new AgentSession({
      sessionId: sessionId("dedupe"),
      model,
      tools: [],
      contextWatcher: watcher,
      hooks: [
        {
          name: "mutate-on-turn-start",
          onTurnStart(): void {
            if (mutated) return;
            mutated = true;
            workspace.set(REL, V2, 2);
          },
        },
      ],
    });

    await session.run("hello");

    expect(noticeTexts(model.getCalls())).toHaveLength(0);
    model.teardown();
  });

  it("consumes an explicit preview exactly once and honours a null preview", async () => {
    const previewWorkspace = new FakeWorkspace();
    previewWorkspace.set(REL, V1, 1);
    const previewWatcher = watcherFor(previewWorkspace);
    previewWorkspace.set(REL, V2, 2);
    const preview = previewWatcher.peek();
    if (preview === null) throw new Error("expected a preview after the source changed");

    const previewModel = createFakeModel([textTurn("ok")]);
    const previewSession = new AgentSession({
      sessionId: sessionId("preview"),
      model: previewModel,
      tools: [],
      contextWatcher: previewWatcher,
    });
    await previewSession.run("hello", { contextPreview: preview });

    const previewCall = previewModel.getCalls()[0]!;
    expect(userTexts(previewCall)[0]).toBe(preview.notices[0]);
    expect(userTexts(previewCall)[1]).toBe("hello");
    previewModel.teardown();

    const nullWorkspace = new FakeWorkspace();
    nullWorkspace.set(REL, V1, 1);
    const nullWatcher = watcherFor(nullWorkspace);
    nullWorkspace.set(REL, V2, 2);
    const nullModel = createFakeModel([textTurn("ok")]);
    const nullSession = new AgentSession({
      sessionId: sessionId("preview_null"),
      model: nullModel,
      tools: [],
      contextWatcher: nullWatcher,
    });
    await nullSession.run("hello", { contextPreview: null });

    expect(nullWorkspace.reads).toBe(0);
    expect(userTexts(nullModel.getCalls()[0]!)).toEqual(["hello"]);
    nullModel.teardown();
  });

  it("reseeds from a prompt-refresh result even when the prompt is unchanged", async () => {
    const workspace = new FakeWorkspace();
    workspace.set(REL, V1, 1);
    const watcher = watcherFor(workspace);
    const model = createFakeModel([textTurn("one"), textTurn("two")]);
    let refreshes = 0;
    const session = new AgentSession({
      sessionId: sessionId("reseed"),
      model,
      tools: [],
      systemPrompt: "BASE",
      contextWatcher: watcher,
      refreshSystemPrompt: (reason) => {
        refreshes += 1;
        expect(reason).toBe("session-start");
        return {
          prompt: null,
          contextBaseline: [{ relPath: REL, content: workspace.text(REL) }],
        };
      },
    });

    workspace.set(REL, V2, 2);
    await session.run("first");

    expect(refreshes).toBe(1);
    expect(session.systemPrompt).toBe("BASE");
    expect(noticeTexts([model.getCalls()[0]!])).toHaveLength(0);

    workspace.set(REL, V3, 3);
    await session.run("second");

    const secondCall = model.getCalls()[1]!;
    const secondUsers = userTexts(secondCall);
    expect(secondUsers.at(-2)).toContain("-rule two changed");
    expect(secondUsers.at(-2)).toContain("+rule three");
    expect(secondUsers.at(-1)).toBe("second");
    model.teardown();
  });

  it("does not check mid-run when contextCheckEachTurn is false (main mode)", async () => {
    const workspace = new FakeWorkspace();
    workspace.set(REL, V1, 1);
    const watcher = watcherFor(workspace);
    const model = createFakeModel([toolTurn("mutate-source"), textTurn("done")]);
    const session = new AgentSession({
      sessionId: sessionId("admission_only"),
      model,
      tools: [mutateTool(workspace, V2, 2)],
      contextWatcher: watcher,
      contextCheckEachTurn: false,
    });

    const summary = await session.run("go");

    expect(summary.reason).toBe("done");
    expect(noticeTexts(model.getCalls())).toHaveLength(0);
    model.teardown();
  });

  it("checks at the first LLM call of continue()", async () => {
    const workspace = new FakeWorkspace();
    workspace.set(REL, V1, 1);
    const watcher = watcherFor(workspace);
    const model = createFakeModel([textTurn("first"), textTurn("second")]);
    const session = new AgentSession({
      sessionId: sessionId("continue"),
      model,
      tools: [],
      contextWatcher: watcher,
    });

    await session.run("first");
    workspace.set(REL, V2, 2);
    const summary = await session.continue();

    expect(summary.reason).toBe("done");
    const continueCall = model.getCalls()[1]!;
    expect(userTexts(continueCall).at(-1)).toContain("+rule two changed");
    model.teardown();
  });

  it("absorbs a source change made during summarize via the compaction baseline rebase", async () => {
    const workspace = new FakeWorkspace();
    workspace.set(REL, V2, 2);
    const watcher = watcherFor(workspace);
    const stateRoot = mkdtempSync(join(tmpdir(), "loom-ctx-compaction-"));
    cleanupRoots.push(stateRoot);
    const stateStore = new CompactionStateStore({ stateRoot });
    const model = createFakeModel([textTurn("ok")]);
    const refreshReasons: string[] = [];
    const session = new AgentSession({
      sessionId: sessionId("compaction"),
      model,
      tools: [],
      store: new MemorySessionStore(),
      systemPrompt: "BASE",
      initialMessages: [
        createUserMessage("u0"),
        createUserMessage("u1"),
        createUserMessage("u2"),
      ],
      contextWatcher: watcher,
      refreshSystemPrompt: (reason) => {
        refreshReasons.push(reason);
        if (reason === "session-start") return null;
        return {
          prompt: "POST-COMPACT",
          contextBaseline: [{ relPath: REL, content: workspace.text(REL) }],
        };
      },
      compaction: {
        stateStore,
        summarize: () => {
          workspace.set(REL, V3, 3);
          return "summary-text";
        },
        wrapSummary: (text, coveredCount) => `[compacted ${String(coveredCount)}]\n${text}`,
        fallbackTokens: 1,
        keepRecent: 1,
        summaryChunkTokens: 1_000,
        retryCount: 0,
      } satisfies NonNullable<AgentSessionOptions["compaction"]>,
    });

    const summary = await session.run("go");

    expect(summary.reason).toBe("done");
    expect(refreshReasons).toEqual(["session-start", "compaction"]);
    expect(session.compactionView).not.toBeNull();
    expect(session.systemPrompt).toBe("POST-COMPACT");
    const call = model.getCalls()[0]!;
    expect(call.systemPrompt).toBe("POST-COMPACT");
    expect(noticeTexts([call])).toHaveLength(0);
    model.teardown();
  });
});
