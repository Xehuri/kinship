/**
 * Exit notification text for PTY sessions.
 *
 * Plain text (XML-ish envelope) consumed by the model, so formatting is fixed
 * and ANSI sequences are intentionally preserved in the last output line.
 */
import type { PtySession } from "./types.js";

const TITLE_TRUNCATE = 80;
const LAST_LINE_TRUNCATE = 200;

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

function lastNonEmptyLine(session: PtySession): string {
  const { lines } = session.buffer.read(0, session.buffer.length);
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index];
    if (line !== undefined && line.trim() !== "") {
      return truncate(line, LAST_LINE_TRUNCATE);
    }
  }
  return "(none)";
}

export function buildExitNotification(session: PtySession): string {
  const displayTitle = session.description.length > 0 ? session.description : session.title;
  const hint = session.timedOut
    ? "Process reached its PTY timeout and was stopped automatically. Use pty_read to inspect the final output."
    : (session.exitCode ?? 0) === 0
      ? "Use pty_read to check the full output."
      : "Process failed. Use pty_read with the pattern parameter to search for errors in the output.";

  return [
    "<pty_exited>",
    `ID: ${session.id}`,
    `Title: ${truncate(displayTitle, TITLE_TRUNCATE)}`,
    `Exit Code: ${session.exitCode ?? 0}`,
    `Signal: ${session.exitSignal ?? "none"}`,
    `Timed Out: ${session.timedOut ? "yes" : "no"}`,
    `Output Lines: ${session.buffer.length}`,
    `Last Line: ${lastNonEmptyLine(session)}`,
    "</pty_exited>",
    "",
    hint,
  ].join("\n");
}
