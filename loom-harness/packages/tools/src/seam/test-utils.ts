/**
 * seam 测试共享夹具（非 *.test.ts，vitest 不直接收集）。
 * 工作区/外部目录在 os tmpdir 构造（NTFS 无关），含 symlink 逃逸向量。
 */
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect } from "vitest";
import { ToolExecutor } from "./executor.js";
import { SeamDeniedError } from "./types.js";
import type {
  AskResolver,
  AuditSink,
  ProcessRunner,
  SandboxProfile,
  ScopeKey,
  SeamPermissionRule,
} from "./types.js";

export const scope: ScopeKey = { agent: "main", workflow: "data-check" };

export const openProfile: SandboxProfile = {
  fs: { read: [], write: [] },
  net: "allow",
  cmd_allow: [],
  deny: [],
};

export const fakeRunner: ProcessRunner = async (command, cwd) => ({
  exitCode: 0,
  output: `${command}@${cwd}`,
});

export const allowBash: SeamPermissionRule[] = [
  { name: "bash-allow", match: "bash", decision: "allow" },
];

export interface SeamFixture {
  readonly workspace: string;
  readonly outside: string;
}

/** 建 workspace（含 inner/ok.txt 与指向 outside 的 symlink）与 outside（含 secret.txt）。 */
export function makeSeamFixture(): SeamFixture {
  const workspace = realpathSync(mkdtempSync(path.join(tmpdir(), "seam-ws-")));
  const outside = realpathSync(mkdtempSync(path.join(tmpdir(), "seam-out-")));
  mkdirSync(path.join(workspace, "inner"));
  writeFileSync(path.join(workspace, "inner", "ok.txt"), "inside");
  writeFileSync(path.join(outside, "secret.txt"), "outside");
  symlinkSync(outside, path.join(workspace, "link-out"), "dir");
  return { workspace, outside };
}

export interface ExecutorExtras {
  readonly profile?: SandboxProfile;
  /** true=审批放行，false=审批拒绝，函数=自定义 askResolver，缺省=无人值守。 */
  readonly ask?: boolean | AskResolver;
  readonly runner?: ProcessRunner;
  readonly audit?: AuditSink;
}

export function buildExecutor(
  workspace: string,
  rules: readonly SeamPermissionRule[],
  extra: ExecutorExtras = {},
): ToolExecutor {
  const askResolver: AskResolver | undefined =
    extra.ask === undefined
      ? undefined
      : typeof extra.ask === "boolean"
        ? () => extra.ask === true
        : extra.ask;
  return new ToolExecutor({
    workspaceRoot: workspace,
    profile: extra.profile ?? openProfile,
    rules,
    scope,
    runner: extra.runner ?? fakeRunner,
    ...(askResolver ? { askResolver } : {}),
    ...(extra.audit ? { audit: extra.audit } : {}),
  });
}

export async function expectDenied(
  promise: Promise<unknown>,
  kind: "permission" | "sandbox",
): Promise<SeamDeniedError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(SeamDeniedError);
    const denied = err as SeamDeniedError;
    expect(denied.kind).toBe(kind);
    return denied;
  }
  throw new Error("expected SeamDeniedError, call was allowed");
}
