/**
 * buildExitNotification 验收：固定信封格式、提示行选择、末行挑选与截断。
 */
import { describe, expect, it } from "vitest";
import { RingBuffer } from "./buffer.js";
import { buildExitNotification } from "./notifications.js";
import type { PtyProcessHandle, PtySession, PtyStatus } from "./types.js";

const noopProcess: PtyProcessHandle = {
  pid: 1,
  write: () => {},
  kill: () => {},
  onData: () => ({ dispose: () => {} }),
  onExit: () => ({ dispose: () => {} }),
};

interface SessionOverrides {
  id?: string;
  title?: string;
  description?: string;
  status?: PtyStatus;
  timedOut?: boolean;
  exitCode?: number;
  exitSignal?: number | string;
  output?: string;
}

function makeSession(overrides: SessionOverrides = {}): PtySession {
  const buffer = new RingBuffer();
  if (overrides.output !== undefined) buffer.append(overrides.output);
  return {
    id: overrides.id ?? "pty_0000abcd",
    title: overrides.title ?? "title",
    description: overrides.description ?? "description",
    command: "bash",
    args: [],
    workdir: "/tmp",
    ownerSessionId: "owner-1",
    status: overrides.status ?? "exited",
    pid: 1,
    createdAt: 0,
    notifyOnExit: false,
    timedOut: overrides.timedOut ?? false,
    notified: false,
    buffer,
    process: noopProcess,
    ...(overrides.exitCode !== undefined ? { exitCode: overrides.exitCode } : {}),
    ...(overrides.exitSignal !== undefined
      ? { exitSignal: overrides.exitSignal }
      : {}),
  };
}

describe("buildExitNotification", () => {
  it("emits the exact envelope and success hint for exit code 0", () => {
    const line = buildExitNotification(
      makeSession({ id: "pty_abc12345", title: "t", description: "d", exitCode: 0, output: "ok\n" }),
    );

    expect(line).toBe(
      [
        "<pty_exited>",
        "ID: pty_abc12345",
        "Title: d",
        "Exit Code: 0",
        "Signal: none",
        "Timed Out: no",
        "Output Lines: 1",
        "Last Line: ok",
        "</pty_exited>",
        "",
        "Use pty_read to check the full output.",
      ].join("\n"),
    );
  });

  it("uses the failure hint for a non-zero exit code", () => {
    const line = buildExitNotification(makeSession({ exitCode: 2, output: "boom\n" }));

    expect(line).toContain("Exit Code: 2");
    expect(line.endsWith(
      "Process failed. Use pty_read with the pattern parameter to search for errors in the output.",
    )).toBe(true);
  });

  it("prefers the timeout hint even when the exit code is zero", () => {
    const line = buildExitNotification(
      makeSession({ timedOut: true, exitCode: 0, output: "partial\n" }),
    );

    expect(line).toContain("Timed Out: yes");
    expect(line.endsWith(
      "Process reached its PTY timeout and was stopped automatically. Use pty_read to inspect the final output.",
    )).toBe(true);
  });

  it("picks the last non-empty complete line", () => {
    const line = buildExitNotification(
      makeSession({ output: "first\n\n   \nlast\n\n  \n" }),
    );

    expect(line).toContain("Output Lines: 6");
    expect(line).toContain("Last Line: last");
  });

  it("falls back to the title when description is empty", () => {
    const line = buildExitNotification(
      makeSession({ description: "", title: "fallback title" }),
    );

    expect(line).toContain("Title: fallback title");
  });

  it("truncates a long title at 80 characters", () => {
    const longTitle = "t".repeat(85);
    const line = buildExitNotification(makeSession({ description: longTitle }));

    expect(line).toContain(`Title: ${"t".repeat(80)}...`);
    expect(line).not.toContain("t".repeat(81));
  });

  it("keeps a title at exactly 80 characters untouched", () => {
    const exactTitle = "u".repeat(80);
    const line = buildExitNotification(makeSession({ description: exactTitle }));

    expect(line).toContain(`Title: ${exactTitle}`);
    expect(line).not.toContain(`${exactTitle}...`);
  });

  it("truncates the last line at 200 characters", () => {
    const longLine = "y".repeat(250);
    const line = buildExitNotification(makeSession({ output: `${longLine}\n` }));

    expect(line).toContain(`Last Line: ${"y".repeat(200)}...`);
    expect(line).not.toContain("y".repeat(201));
  });

  it("reports (none) when there is no output", () => {
    const line = buildExitNotification(makeSession());

    expect(line).toContain("Output Lines: 0");
    expect(line).toContain("Last Line: (none)");
  });

  it("preserves ANSI escapes in the last line", () => {
    const line = buildExitNotification(
      makeSession({ output: "\u001b[31mred\u001b[0m\n" }),
    );

    expect(line).toContain("Last Line: \u001b[31mred\u001b[0m");
  });

  it("renders signal names and numeric signals", () => {
    expect(
      buildExitNotification(makeSession({ exitCode: 143, exitSignal: "SIGTERM" })),
    ).toContain("Signal: SIGTERM");
    expect(buildExitNotification(makeSession({ exitSignal: 15 }))).toContain(
      "Signal: 15",
    );
  });
});
