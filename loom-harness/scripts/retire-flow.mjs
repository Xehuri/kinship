#!/usr/bin/env node
/**
 * Flow Phase A 退休 CLI 包装。
 *
 * 用法：
 *   node scripts/retire-flow.mjs --state-root <path> [--dry-run | --apply | --verify] [--config <path>]
 *
 * 行为：
 *   --dry-run  只读报告（JSON 或可读摘要）。
 *   --apply    复制 flow 数据到归档目录 + 取消 flow 唤醒条目 + 写 manifest；拒绝存活实例锁。
 *   --verify   校验退休完成；失败非零退出。
 * 退出码：成功 0；拒绝/失败 非 0。
 *
 * 实现：用仓库内 esbuild 将 TS 源编译为内存 ESM 再 import，避免依赖 dist 构建产物。
 */

import { build } from "esbuild";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

function parseArgs(argv) {
  const out = { stateRoot: null, mode: null, config: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--state-root") {
      out.stateRoot = argv[i + 1];
      i += 1;
    } else if (a === "--dry-run") {
      out.mode = "dry-run";
    } else if (a === "--apply") {
      out.mode = "apply";
    } else if (a === "--verify") {
      out.mode = "verify";
    } else if (a === "--config") {
      out.config = argv[i + 1];
      i += 1;
    } else if (a === "-h" || a === "--help") {
      out.mode = "help";
    }
  }
  return out;
}

const HELP = `usage:
  node scripts/retire-flow.mjs --state-root <path> [--dry-run | --apply | --verify] [--config <path>]

  --dry-run   只读报告，绝不写
  --apply     复制 flow 数据到归档目录 + 取消 flow 唤醒条目 + 写 manifest
  --verify    校验退休完成（失败非零退出）
  --config    配置文件路径（verify 时检查 flow.enabled 是否仍为 true）
`;

async function loadModule() {
  const here = new URL(".", import.meta.url).pathname;
  const src = join(here, "..", "packages", "server", "src", "maintenance", "flow-retire.ts");
  const dir = mkdtempSync(join(tmpdir(), "retire-flow-"));
  const outFile = join(dir, "flow-retire.mjs");
  await build({
    entryPoints: [src],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    outfile: outFile,
    logLevel: "silent",
  });
  const mod = await import(pathToFileURL(outFile).href);
  return { mod, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function readableDryRun(report) {
  const lines = [];
  lines.push(`Flow 退休 dry-run @ ${report.timestamp}`);
  lines.push(`stateRoot: ${report.stateRoot}`);
  lines.push(`目标归档: ${report.targetArchivePath}`);
  lines.push(`flow 会话数: ${String(report.totalFlowDirs)}`);
  for (const s of report.sessions) {
    lines.push(
      `  - session ${s.sessionId}: subjects=${String(s.subjectCount)} items=${String(
        s.itemCount,
      )} nonClosed=${String(s.nonClosedCount)} flowWake=${String(s.flowWakeCount)}`,
    );
  }
  lines.push(`flow 唤醒条目总数: ${String(report.flowWakeEntries.length)}`);
  for (const e of report.flowWakeEntries) {
    lines.push(
      `  - wake ${e.sessionId}/${e.id}: source=${e.source} action=${String(e.action ?? "-")}`,
    );
  }
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === "help" || args.stateRoot === null || args.mode === null) {
    process.stdout.write(HELP + "\n");
    process.exit(args.mode === "help" ? 0 : 2);
  }
  if (args.mode !== "dry-run" && args.mode !== "apply" && args.mode !== "verify") {
    process.stderr.write("必须指定 --dry-run / --apply / --verify 之一\n");
    process.exit(2);
  }

  const { mod, cleanup } = await loadModule();
  try {
    const opts = { stateRoot: args.stateRoot, ...(args.config ? { configPath: args.config } : {}) };
    if (args.mode === "dry-run") {
      const report = mod.dryRun(opts);
      process.stdout.write(`${readableDryRun(report)}\n`);
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      process.exit(0);
    }
    if (args.mode === "apply") {
      const manifest = mod.apply(opts);
      process.stdout.write(`Flow 退休 apply 完成\n`);
      process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
      process.exit(0);
    }
    // verify
    const result = mod.verify(opts);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) {
      process.stderr.write(`verify 失败:\n  ${result.errors.join("\n  ")}\n`);
      process.exit(1);
    }
    process.stdout.write("verify 通过\n");
    process.exit(0);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    process.stderr.write(`retire-flow 错误: ${msg}\n`);
    process.exit(1);
  } finally {
    cleanup();
  }
}

main().catch((error) => {
  process.stderr.write(`fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
