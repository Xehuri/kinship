/**
 * T31 验收：loom CLI（参数解析 + 桩命令 + 真 serve 冒烟）。
 *
 * 逐条对 docs/02 §T31 验收标准 + 任务冻结项：
 *   - spawn `node dist/cli.js serve --port 5098 --config <临时配置>`：
 *     轮询 15s 内 /health（带 token）200；SSE /events/stream?sessionId= 可订阅
 *     （200 + text/event-stream 头）；SIGTERM → 进程 exit 0。
 *   - 端口只用 ≥5097（此处 5098；5097 归 scripts/smoke-serve.sh 一次性冒烟）。
 *   - 假模型离线（provider: fake + 临时 state 根），全程无真凭据、无外网。
 *
 * spawn 需要 dist/cli.js：beforeAll 增量 `tsc -b packages/server`（增量秒级，
 * 全量首建给足 NTFS 余量）。临时目录 mkdtemp + afterEach 兜底 kill PID。
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { fileURLToPath } from "node:url";

import { parseLoomConfig } from "./config/loom-config.js";
import { MIN_PORT } from "./config/section-checks.js";
import {
  UsageError,
  parseArgs,
  resolveServeTokens,
  resolveConfigPath,
  pickFakeModelConfig,
  wantsFakeModel,
} from "./serve/index.js";

const HERE = fileURLToPath(new URL(".", import.meta.url)); // packages/server/src/
const REPO = join(HERE, "..", "..", ".."); // axeuh-harness/
const CLI_DIST = join(REPO, "packages", "server", "dist", "cli.js");

const TEST_TOKEN = "tok-cli-test";
/** E2E 冒烟端口（D32：≥5097；5097 留给 smoke-serve.sh，测试用 5098）。 */
const SMOKE_PORT = 5098;
const READINESS_BUDGET_MS = 15_000;
const LONG = 240_000; // NTFS 全量首建余量

// ───────────────────────── 纯函数段（parseArgs / 令牌 / fake 判别） ─────────────────────────

describe("loom CLI parseArgs (T31)", () => {
  it("serve 缺省：无旗标 → 全 null（回落配置口径）", () => {
    expect(parseArgs(["serve"])).toEqual({ kind: "serve", port: null, hostname: null, config: null });
  });

  it("serve --port 5098 --hostname/--config 原样透传", () => {
    const parsed = parseArgs(["serve", "--port", "5098", "--hostname", "0.0.0.0", "--config", "/x/loom.yaml"]);
    expect(parsed).toEqual({ kind: "serve", port: 5098, hostname: "0.0.0.0", config: "/x/loom.yaml" });
  });

  it(`--port ${MIN_PORT - 1}（=5096 现网端口）→ UsageError（D32）`, () => {
    expect(() => parseArgs(["serve", "--port", "5096"])).toThrow(UsageError);
    expect(() => parseArgs(["serve", "--port", String(MIN_PORT - 1)])).toThrow(/5097/);
  });

  it("--port 非整数 / 缺值 / 重复 → UsageError", () => {
    expect(() => parseArgs(["serve", "--port", "abc"])).toThrow(UsageError);
    expect(() => parseArgs(["serve", "--port"])).toThrow(UsageError);
    expect(() => parseArgs(["serve", "--port", "5098", "--port", "5099"])).toThrow(UsageError);
  });

  it("未知选项 / 未知命令 / 空参数 → UsageError", () => {
    expect(() => parseArgs(["serve", "--wat"])).toThrow(/未知选项/);
    expect(() => parseArgs(["bogus"])).toThrow(/未知命令/);
    expect(() => parseArgs([])).toThrow(/缺少子命令/);
  });

  it("runs|trace|doctor 桩命令注册（docs/02 §T31 至少注册）", () => {
    for (const name of ["runs", "trace", "doctor"] as const) {
      expect(parseArgs([name, "--whatever"])).toEqual({ kind: "stub", name });
    }
  });
});

describe("loom CLI env 口径 (T31)", () => {
  it("resolveServeTokens：LOOM_TOKEN/LOOM_TEST_TOKEN 逗号多值去重；全空抛", () => {
    expect(resolveServeTokens({ LOOM_TOKEN: "a,b, a" })).toEqual(["a", "b"]);
    expect(resolveServeTokens({ LOOM_TEST_TOKEN: "t" })).toEqual(["t"]);
    expect(() => resolveServeTokens({})).toThrow(/令牌/);
  });

  it("resolveConfigPath：--config > LOOM_CONFIG > 缺省", () => {
    expect(resolveConfigPath("/explicit", { LOOM_CONFIG: "/env-path" })).toBe("/explicit");
    expect(resolveConfigPath(undefined, { LOOM_CONFIG: "/env-path" })).toBe("/env-path");
    expect(resolveConfigPath(undefined, {})).toMatch(/config\/loom\.yaml$/);
  });

  it("LOOM_FAKE_MODEL=1 强制走 fake 通道（改 provider 数据面，原样保留窗口参数）", () => {
    const cfg = fakeConfig();
    expect(wantsFakeModel(cfg, { LOOM_FAKE_MODEL: "1" })).toBe(true);
    const picked = pickFakeModelConfig(cfg, { LOOM_FAKE_MODEL: "1" });
    expect(picked?.provider).toBe("fake");
    expect(picked?.contextWindow).toBe(200000);
  });
});

// ───────────────────────── 真 serve E2E（spawn + SIGTERM） ─────────────────────────

/** serve 用的假配置文本（provider: fake + pricing.fake 满足引用校验；无凭据段）。 */
const FAKE_YAML = [
  "server:",
  `  port: ${SMOKE_PORT}`,
  "  hostname: 127.0.0.1",
  `workspace: ${join(REPO, "fixture-workspace")}`,
  "models:",
  "  - id: fake-cli",
  "    provider: fake",
  "    contextWindow: 200000",
  "    maxOutput: 4096",
  "    timeout: 60000",
  "pricing:",
  "  fake:",
  "    input: 0",
  "    output: 0",
].join("\n");

/** 判别函数的输入 = 真解析器产出的 LoomConfig（不手写 cast：brand 类型与形状由 T07 校验器给）。 */
function fakeConfig() {
  return parseLoomConfig(FAKE_YAML, "test:FAKE_YAML", { env: {} });
}

let workDir = "";
let child: ReturnType<typeof spawn> | null = null;
let childExited: Promise<number | null> | null = null;

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "loom-cli-t31-"));
  if (!existsSync(CLI_DIST)) throw new Error(`缺少 ${CLI_DIST}：先 npm run build`);
  const build = spawnSync("npx", ["tsc", "-b", "packages/server"], {
    cwd: REPO,
    encoding: "utf8",
    timeout: LONG,
  });
  if (build.status !== 0) {
    throw new Error(`增量构建失败：\n${build.stdout}\n${build.stderr}`);
  }
}, LONG);

afterAll(async () => {
  if (child !== null && childExited !== null) {
    const code = await Promise.race([childExited, new Promise<null>((r) => setTimeout(() => r(null), 8_000))]);
    if (code === null && child.exitCode === null) child.kill("SIGKILL"); // 兜底：只杀自己起的 PID
  }
  rmSync(workDir, { recursive: true, force: true });
}, LONG);

async function waitForHealth(base: string, budgetMs: number): Promise<void> {
  const deadline = Date.now() + budgetMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/health`, { headers: { "X-Loom-Token": TEST_TOKEN } });
      if (res.ok) return;
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`serve 在 ${budgetMs}ms 内未就绪（最后错误：${lastError}）`);
}

describe("loom serve E2E (T31)", () => {
  it(
    "spawn serve --port 5098 → health 200 → SSE 可订阅 → SIGTERM exit 0",
    async () => {
      const configPath = join(workDir, "loom.yaml");
      writeFileSync(configPath, FAKE_YAML, "utf8");
      const stateRoot = join(workDir, "state");

      child = spawn(
        process.execPath,
        [CLI_DIST, "serve", "--port", String(SMOKE_PORT), "--config", configPath],
        {
          cwd: REPO,
          env: { ...process.env, LOOM_TEST_TOKEN: TEST_TOKEN, LOOM_STATE: stateRoot },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const stderrChunks: string[] = [];
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (c: string) => stderrChunks.push(c));
      childExited = new Promise<number | null>((resolve) => {
        child!.once("exit", (code) => resolve(code));
      });

      const base = `http://127.0.0.1:${SMOKE_PORT}`;
      await waitForHealth(base, READINESS_BUDGET_MS);

      // 鉴权口径：不带 token 的 health 必须 401（无未鉴权路径）。
      const anon = await fetch(`${base}/health`);
      expect(anon.status).toBe(401);

      // SSE 可订阅（冒烟两断言之一）：先建会话拿 sessionID，再订阅事件流。
      const created = await fetch(`${base}/sessions`, {
        method: "POST",
        headers: { "X-Loom-Token": TEST_TOKEN },
      });
      expect(created.status).toBe(201);
      const session = (await created.json()) as { sessionID: string };
      expect(session.sessionID).toMatch(/^[a-zA-Z0-9_]+$/);

      const sse = await fetch(`${base}/events/stream?sessionId=${session.sessionID}`, {
        headers: { "X-Loom-Token": TEST_TOKEN },
      });
      expect(sse.status).toBe(200);
      expect(sse.headers.get("content-type")).toBe("text/event-stream");
      await sse.body?.cancel().catch(() => undefined);

      // SIGTERM → 优雅停机 → 进程 exit 0（验收核心）。
      child.kill("SIGTERM");
      const code = await Promise.race([
        childExited,
        new Promise<null>((r) => setTimeout(() => r(null), 12_000)),
      ]);
      expect(
        code,
        `SIGTERM 后 12s 未退出（stderr: ${stderrChunks.join("")}）`,
      ).toBe(0);

      // 端口已释放：新连接应拒绝（ECONNREFUSED）。
      let released = false;
      try {
        await fetch(`${base}/health`, { headers: { "X-Loom-Token": TEST_TOKEN } });
      } catch {
        released = true;
      }
      expect(released).toBe(true);
    },
    LONG,
  );
});
