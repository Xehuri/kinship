import { describe, expect, it } from "vitest";

import { ptyExitNotifyProps } from "./pty-notify.js";

const FULL = [
  "<pty_exited>",
  "ID: pty_a1b2c3d4",
  "Title: live probe",
  "Exit Code: 0",
  "Signal: 0",
  "Timed Out: no",
  "Output Lines: 1",
  "Last Line: PTY_LIVE_OK",
  "</pty_exited>",
].join("\n");

describe("ptyExitNotifyProps", () => {
  it("提取 ID / 退出码 / 最后一行，标题不再误标副会话终态", () => {
    const props = ptyExitNotifyProps(FULL);
    expect(props.title).toBe("PTY 退出通知");
    expect(props.variant).toBe("info");
    expect(props.message).toContain("pty_a1b2c3d4");
    expect(props.message).toContain("exit 0");
    expect(props.message).toContain("PTY_LIVE_OK");
    expect(props.title).not.toContain("副会话");
  });

  it("字段缺失时只拼接可用部分，不抛错", () => {
    const props = ptyExitNotifyProps("<pty_exited>\nID: pty_deadbeef\n</pty_exited>");
    expect(props.message).toBe("pty_deadbeef");
  });

  it("摘要上限 200 字符", () => {
    const long = `<pty_exited>\nID: pty_${"a".repeat(300)}\n</pty_exited>`;
    expect(ptyExitNotifyProps(long).message.length).toBe(200);
  });
});
