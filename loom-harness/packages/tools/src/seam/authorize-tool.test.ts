/**
 * authorizeTool：特殊执行面（PTY）的“只授权不执行”入口。与 exec 共用
 * 权限求值 → 命令/cwd/路径断言 → 审计的预检路径，但不启动进程。
 */
import { realpathSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ToolExecutor } from "./executor.js";
import type { SeamAuditEvent } from "./types.js";
import {
  allowBash,
  buildExecutor,
  expectDenied,
  fakeRunner,
  makeSeamFixture,
  openProfile,
  scope,
} from "./test-utils.js";

const fx = makeSeamFixture();
const ws = fx.workspace;

describe("ToolExecutor.authorizeTool", () => {
  it("explicit allow resolves with cwd realpath, audits one allow, runs no process", async () => {
    const events: SeamAuditEvent[] = [];
    const seen: string[] = [];
    const ex = buildExecutor(ws, allowBash, {
      audit: (e) => events.push(e),
      runner: async (_cmd, cwd) => {
        seen.push(cwd);
        return { exitCode: 0, output: "" };
      },
    });

    const cwdReal = await ex.authorizeTool("bash", "echo hi", path.join(ws, "inner"));

    expect(cwdReal).toBe(realpathSync(path.join(ws, "inner")));
    expect(seen).toEqual([]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ tool: "bash", verdict: "allow", cwd: cwdReal });
  });

  it("no rule (destructive default-ask, unattended) denies with kind permission and audits", async () => {
    const events: SeamAuditEvent[] = [];
    const ex = buildExecutor(ws, [], { audit: (e) => events.push(e) });

    const denied = await expectDenied(ex.authorizeTool("bash", "echo hi", ws), "permission");

    expect(denied.reason).toContain("default ask");
    expect(events.at(-1)?.verdict).toBe("deny");
    expect(events.at(-1)?.reason).toBe(denied.reason);
  });

  it("allow rule still rejects a profile deny-prefixed command with kind sandbox", async () => {
    const events: SeamAuditEvent[] = [];
    const profile = { ...openProfile, deny: ["sudo"] };
    const ex = buildExecutor(ws, allowBash, { profile, audit: (e) => events.push(e) });

    const denied = await expectDenied(ex.authorizeTool("bash", "sudo ls", ws), "sandbox");

    expect(denied.reason).toContain("command denied by profile");
    expect(events.at(-1)?.verdict).toBe("deny");
  });

  it("net:deny profile rejects curl with kind sandbox", async () => {
    const profile = { ...openProfile, net: "deny" as const };
    const ex = buildExecutor(ws, allowBash, { profile });

    const denied = await expectDenied(ex.authorizeTool("bash", "curl http://x", ws), "sandbox");

    expect(denied.reason).toContain("network egress denied");
  });

  it("rejects a cwd outside the workspace with kind sandbox", async () => {
    const ex = buildExecutor(ws, allowBash);

    const denied = await expectDenied(ex.authorizeTool("bash", "echo hi", fx.outside), "sandbox");

    expect(denied.reason).toContain("cwd escapes workspace");
  });
});

describe("ToolExecutor.exec 回归（authorizeTool 重构后）", () => {
  it("allowed exec still returns the runner result and audits allow with cwdReal", async () => {
    const events: SeamAuditEvent[] = [];
    const ex = buildExecutor(ws, allowBash, { audit: (e) => events.push(e) });

    const result = await ex.exec("echo hi", ws, undefined, 5);

    expect(result).toEqual({ exitCode: 0, output: `echo hi@${realpathSync(ws)}` });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ tool: "bash", verdict: "allow", cwd: realpathSync(ws) });
  });

  it("denied exec still throws permission and audits deny with the raw cwd", async () => {
    const events: SeamAuditEvent[] = [];
    const ex = buildExecutor(ws, [], { audit: (e) => events.push(e) });

    const denied = await expectDenied(ex.exec("echo hi", ws, undefined, 5), "permission");

    expect(denied.reason).toContain("default ask");
    expect(events.at(-1)).toMatchObject({ tool: "bash", verdict: "deny", cwd: ws });
  });

  it("sandbox-denied exec still audits deny with the raw cwd (not cwdReal)", async () => {
    const events: SeamAuditEvent[] = [];
    const profile = { ...openProfile, deny: ["sudo"] };
    const ex = new ToolExecutor({
      workspaceRoot: ws,
      profile,
      rules: allowBash,
      scope,
      runner: fakeRunner,
      audit: (e) => events.push(e),
    });

    const denied = await expectDenied(ex.exec("sudo ls", "inner", undefined, 5), "sandbox");

    expect(denied.reason).toContain("command denied by profile");
    expect(events.at(-1)).toMatchObject({ verdict: "deny", cwd: "inner" });
  });
});
