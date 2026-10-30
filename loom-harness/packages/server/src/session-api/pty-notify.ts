/**
 * PTY 退出通知的前端 toast 字段。
 *
 * 与副会话终态提醒（run-reminder 的 reminderNotifyProps）区分：PTY 是交互式终端
 * 会话退出，不是账本 run 终态，复用后者会误标成「副会话终态提醒」。这里只做
 * toast 摘要，完整 `<pty_exited>` 行仍由 deliverWake 作为 durable user 消息投递。
 */

// 用 type 而非 interface：hub.publish 要 Readonly<Record<string, unknown>>，interface
// 无隐式索引签名（同 reminderNotifyProps 的既有口径）。
export type PtyExitNotifyProps = {
  readonly title: string;
  readonly message: string;
  readonly variant: "info";
};

function firstGroup(text: string, re: RegExp): string {
  return re.exec(text)?.[1]?.trim() ?? "";
}

/** 从 `<pty_exited>` 文本提取 ID / 退出码 / 最后一行作为 toast 摘要。 */
export function ptyExitNotifyProps(line: string): PtyExitNotifyProps {
  const id = firstGroup(line, /^ID:\s*(.+)$/m);
  const exitCode = firstGroup(line, /^Exit Code:\s*(.+)$/m);
  const lastLine = firstGroup(line, /^Last Line:\s*(.+)$/m);
  const parts = [id, exitCode === "" ? "" : `exit ${exitCode}`, lastLine].filter(
    (part) => part !== "",
  );
  return {
    title: "PTY 退出通知",
    message: parts.join(" · ").slice(0, 200),
    variant: "info",
  };
}
