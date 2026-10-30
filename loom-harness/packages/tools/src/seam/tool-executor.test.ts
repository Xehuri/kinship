/**
 * T22 验收（docs/02）：路径逃逸拒绝 + default-deny + allow/ask/deny
 * 按 {agent, workflow} 作用域 + 审计。任务点名六案全覆盖：
 * ../ 逃逸拒 / 绝对路径逃逸拒 / 无规则拒 / allow 放行 / deny 优先 / symlink 逃逸拒。
 */
import { realpathSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ToolExecutor } from "./executor.js";
import type { SeamAuditEvent, SeamPermissionRule } from "./types.js";
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

describe("ToolExecutor.exec — 沙箱路径断言", () => {
  it("rejects ../ escape declared in paths (and audits deny)", async () => {
    const events: SeamAuditEvent[] = [];
    const ex = buildExecutor(ws, allowBash, { audit: (e) => events.push(e) });
    const denied = await expectDenied(
      ex.exec("echo hi", ws, undefined, 5, [{ path: "../../etc/passwd", mode: "read" }]),
      "sandbox",
    );
    expect(denied.reason).toContain("escapes workspace");
    expect(events.at(-1)?.verdict).toBe("deny");
  });

  it("rejects absolute path outside workspace", async () => {
    const ex = buildExecutor(ws, allowBash);
    await expectDenied(
      ex.exec("echo hi", ws, undefined, 5, [{ path: "/etc/passwd", mode: "read" }]),
      "sandbox",
    );
  });

  it("rejects symlink escape into outside dir", async () => {
    const ex = buildExecutor(ws, allowBash);
    await expectDenied(
      ex.exec("cat x", ws, undefined, 5, [{ path: "link-out/secret.txt", mode: "read" }]),
      "sandbox",
    );
  });

  it("rejects symlink escape for not-yet-existing target under the link", async () => {
    const ex = buildExecutor(ws, allowBash);
    await expectDenied(
      ex.exec("echo hi", ws, undefined, 5, [{ path: "link-out/new/deep.txt", mode: "write" }]),
      "sandbox",
    );
  });

  it("rejects cwd escaping workspace via ../", async () => {
    const ex = buildExecutor(ws, allowBash);
    const denied = await expectDenied(ex.exec("echo hi", path.join(ws, ".."), undefined, 5), "sandbox");
    expect(denied.reason).toContain("cwd escapes workspace");
  });

  it("allows in-workspace paths and chdirs to realpath", async () => {
    const seen: string[] = [];
    const ex = buildExecutor(ws, allowBash, {
      runner: async (_c, cwd) => {
        seen.push(cwd);
        return { exitCode: 0, output: "" };
      },
    });
    const result = await ex.exec("cat ok.txt", path.join(ws, "inner"), undefined, 5, [
      { path: "ok.txt", mode: "read" },
    ]);
    expect(result.exitCode).toBe(0);
    expect(seen[0]).toBe(realpathSync(path.join(ws, "inner")));
  });

  it("honors profile fs.write allowlist", async () => {
    const profile = { ...openProfile, fs: { read: [], write: ["inner"] } };
    const ex = buildExecutor(ws, allowBash, { profile });
    await expectDenied(ex.exec("echo hi", ws, undefined, 5, [{ path: "top.txt", mode: "write" }]), "sandbox");
    const ok = await ex.exec("echo hi", ws, undefined, 5, [{ path: "inner/top.txt", mode: "write" }]);
    expect(ok.exitCode).toBe(0);
  });

  it("profile deny prefix beats cmd_allow; cmd_allow default-deny; net:deny blocks egress", async () => {
    const profile = { ...openProfile, net: "deny" as const, cmd_allow: ["echo"], deny: ["echo rm"] };
    const ex = buildExecutor(ws, allowBash, { profile });
    await expectDenied(ex.exec("echo rm -rf /", ws, undefined, 5), "sandbox");
    await expectDenied(ex.exec("ls -la", ws, undefined, 5), "sandbox");
    await expectDenied(ex.exec("curl http://x", ws, undefined, 5), "sandbox");
    expect((await ex.exec("echo hi", ws, undefined, 5)).exitCode).toBe(0);
  });
});

describe("权限模型 — default-deny / allow / ask / deny / 作用域", () => {
  it("no rules: destructive bash → default-ask, unattended denies; read → fallback deny", async () => {
    const events: SeamAuditEvent[] = [];
    const ex = buildExecutor(ws, [], { audit: (e) => events.push(e) });
    const denied = await expectDenied(ex.exec("echo hi", ws, undefined, 5), "permission");
    expect(denied.reason).toContain("default ask");
    expect(events.at(-1)?.verdict).toBe("deny");

    const denied2 = await expectDenied(
      ex.exec("x", ws, undefined, 5, [], { tool: "read", isDestructive: false }),
      "permission",
    );
    expect(denied2.reason).toContain("default-deny");
  });

  it("allow rule lets matching scope through", async () => {
    expect((await buildExecutor(ws, allowBash).exec("echo hi", ws, undefined, 5)).exitCode).toBe(0);
  });

  it("ask rule: unattended denies; approved allows; refused denies", async () => {
    const rules: SeamPermissionRule[] = [{ name: "bash-ask", match: "bash", decision: "ask" }];
    await expectDenied(buildExecutor(ws, rules).exec("echo hi", ws, undefined, 5), "permission");
    expect((await buildExecutor(ws, rules, { ask: true }).exec("echo hi", ws, undefined, 5)).exitCode).toBe(0);
    const denied = await expectDenied(
      buildExecutor(ws, rules, { ask: false }).exec("echo hi", ws, undefined, 5),
      "permission",
    );
    expect(denied.reason).toContain("approval denied");
  });

  it("deny decision beats allow (deny 优先)", async () => {
    const rules: SeamPermissionRule[] = [
      { name: "allow-all", match: "bash", decision: "allow" },
      { name: "block-bash", match: "bash", decision: "deny", reason: "blocked for this agent" },
    ];
    const denied = await expectDenied(buildExecutor(ws, rules).exec("echo hi", ws, undefined, 5), "permission");
    expect(denied.reason).toBe("blocked for this agent");
  });

  it("generic deny not overridden by more specific allow (deny 优先跨层)", async () => {
    const rules: SeamPermissionRule[] = [
      { name: "lockdown", match: () => true, decision: "deny", reason: "lockdown" },
      { name: "specific-allow", match: "bash", decision: "allow", scope: { agent: "main", workflow: "data-check" } },
    ];
    const denied = await expectDenied(buildExecutor(ws, rules).exec("echo hi", ws, undefined, 5), "permission");
    expect(denied.reason).toBe("lockdown");
  });

  it("scope {agent, workflow}: exact allow only covers its scope", async () => {
    const rules: SeamPermissionRule[] = [
      { name: "main-allow", match: "bash", decision: "allow", scope: { agent: "main", workflow: "data-check" } },
    ];
    const ex = buildExecutor(ws, rules);
    expect((await ex.exec("echo hi", ws, undefined, 5)).exitCode).toBe(0);
    await expectDenied(
      ex.exec("echo hi", ws, undefined, 5, [], { scope: { agent: "side", workflow: "data-check" } }),
      "permission",
    );
    await expectDenied(
      ex.exec("echo hi", ws, undefined, 5, [], { scope: { agent: "main", workflow: "other" } }),
      "permission",
    );
  });

  it("wildcard scope dimension covers any workflow / any agent", async () => {
    const rules: SeamPermissionRule[] = [
      { name: "agent-only", match: "bash", decision: "allow", scope: { agent: "main", workflow: "*" } },
    ];
    const ex = buildExecutor(ws, rules);
    expect((await ex.exec("echo hi", ws, undefined, 5, [], { scope: { agent: "main", workflow: "x" } })).exitCode).toBe(0);
    await expectDenied(
      ex.exec("echo hi", ws, undefined, 5, [], { scope: { agent: "side", workflow: "x" } }),
      "permission",
    );
  });

  it("destructive-with-no-rule routes through askResolver (审批放行)", async () => {
    const asked: string[] = [];
    const ex = new ToolExecutor({
      workspaceRoot: ws,
      profile: openProfile,
      rules: [],
      scope,
      runner: fakeRunner,
      askResolver: (c) => {
        asked.push(c.tool);
        return true;
      },
    });
    expect((await ex.exec("echo hi", ws, undefined, 5)).exitCode).toBe(0);
    expect(asked).toEqual(["bash"]);
  });
});

describe("缝接线", () => {
  it("asBashOperations pipes bash tool through the seam", async () => {
    const chunks: Buffer[] = [];
    const result = await buildExecutor(ws, allowBash)
      .asBashOperations()
      .exec("echo seam-wired", ws, { onData: (d) => chunks.push(d) });
    expect(result.exitCode).toBe(0);
  });

  it("default runner spawns for real via seam-process (进程组 kill 复用)", async () => {
    const ex = new ToolExecutor({ workspaceRoot: ws, profile: openProfile, rules: allowBash, scope });
    const result = await ex.exec("echo seam-real && pwd", ws, undefined, 20);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("seam-real");
    const printed = result.output.trim().split("\n").at(-1) ?? "";
    expect(realpathSync(printed)).toBe(ws);
  });
});

// W4 bash.shell：shell 程序指定（loom.yaml bash.shell 的缝侧消费面）。
describe("W4 bash.shell 接线", () => {
  it("POSIX 缺省分支升 /bin/bash：bashism 直调成功（/bin/sh 下 [[ 语法会挂）", async () => {
    if (process.platform === "win32") return; // win32 缺省语义由 bashSpawnPlan 分支单测钉死
    const ex = new ToolExecutor({ workspaceRoot: ws, profile: openProfile, rules: allowBash, scope });
    const r = await ex.exec('[[ -n "$BASH_VERSION" ]] && echo BASH-SHELL-OK || echo NOT-BASH', ws, undefined, 20);
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("BASH-SHELL-OK");
  });

  it("显式 bashShell 全量拼装实跑（program=/bin/bash, args=[-c]）", async () => {
    if (process.platform === "win32") return;
    const ex = new ToolExecutor({
      workspaceRoot: ws,
      profile: openProfile,
      rules: allowBash,
      scope,
      bashShell: { program: "/bin/bash", args: ["-c"] },
    });
    const r = await ex.exec('echo "v=$BASH_VERSION" && true', ws, undefined, 20);
    expect(r.exitCode).toBe(0);
    expect(r.output).toMatch(/v=\d/); // v= 后有版本号 = 真 bash
  });

  it("显式 program 不存在 → spawn error 上抛（不静默回落默认 shell）", async () => {
    const ex = new ToolExecutor({
      workspaceRoot: ws,
      profile: openProfile,
      rules: allowBash,
      scope,
      bashShell: { program: "axeuh-no-such-shell-w4", args: ["-c"] },
    });
    await expect(ex.exec("echo hi", ws, undefined, 10)).rejects.toThrow();
  });

  it("runner 注入优先于 bashShell（fake runner 接管，不起真进程）", async () => {
    const seen: Array<{ cmd: string }> = [];
    const ex = new ToolExecutor({
      workspaceRoot: ws,
      profile: openProfile,
      rules: allowBash,
      scope,
      runner: async (command) => {
        seen.push({ cmd: command });
        return { exitCode: 0, output: "fake" };
      },
      bashShell: { program: "/bin/bash", args: ["-c"] },
    });
    const r = await ex.exec("echo hi", ws, undefined, 10);
    expect(r.output).toBe("fake");
    expect(seen).toEqual([{ cmd: "echo hi" }]);
  });
});
