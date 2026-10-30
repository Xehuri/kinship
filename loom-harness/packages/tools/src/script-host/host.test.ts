// T16 挂载脚本宿主集成测试（验收标准逐条对应）：
//   1. fixture python 脚本逐事件（fact/deliver/dispatch/heartbeat）被解析；
//   2. 非零退出脚本被 respawn，退避序列 1s,2s,4s…（测试注入短 base + 假 sleep）；
//   3. `exec` 保留事件被拒绝并记录，绝不执行（哨兵文件不出现）；
//   4. 附加：enabled:false 不拉起、干净退出(0)不重拉、非法 frontmatter 拒挂、
//      rescan 热加载、stop() 杀进程组无孤儿 pid。
//
// 隔离：每个用例把所需 fixture 拷到独立 mkdtemp 目录再挂载，
// 避免 fixtures/ 全量目录被每个用例整体 spawn 而互相干扰。

import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { ScriptHost, type HostEvent, type HostLogEntry, type ScriptHostOptions } from "./host.js";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) {
      throw new Error(`等待超时: ${what}`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

function waitMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

class Harness {
  readonly events: HostEvent[] = [];
  readonly logs: HostLogEntry[] = [];
  readonly pids: number[] = [];
  host: ScriptHost | undefined;

  constructor(dir: string, opts: Partial<ScriptHostOptions> = {}) {
    this.host = new ScriptHost({
      scriptsDir: dir,
      logger: (entry) => this.logs.push(entry),
      onChildLaunch: (pid) => this.pids.push(pid),
      ...opts,
    });
    this.host.onEvent((e) => this.events.push(e));
  }

  start(): void {
    this.host?.start();
  }

  stop(): void {
    this.host?.stop();
  }

  eventTypes(): string[] {
    return this.events.map((e) => e.event.type);
  }

  findLog(sub: string): HostLogEntry | undefined {
    return this.logs.find((l) => l.message.includes(sub));
  }

  async stopAndReap(): Promise<void> {
    this.stop();
    const pids = [...this.pids];
    await waitFor(
      () => pids.every((p) => !pidAlive(p)),
      3000,
      "所有子进程退出（无孤儿）",
    );
  }
}

function mountFixture(dir: string, name: string): string {
  const dest = join(dir, `${name}.py`);
  cpSync(join(FIXTURES_DIR, `${name}.py`), dest);
  return dest;
}

describe("ScriptHost - 子进程事件协议（真实 python3）", () => {
  let dir: string;
  let harness: Harness | undefined;

  afterEach(async () => {
    harness?.stop();
    if (harness !== undefined) {
      const pids = [...harness.pids];
      await waitFor(() => pids.every((p) => !pidAlive(p)), 3000, "清理子进程").catch(() => undefined);
    }
    rmSync(dir, { recursive: true, force: true });
    harness = undefined;
  });

  function freshDir(): string {
    dir = mkdtempSync(join(tmpdir(), "loom-script-host-"));
    return dir;
  }

  it("fixture python 脚本逐事件 fact/deliver/dispatch/heartbeat 解析", async () => {
    const d = freshDir();
    mountFixture(d, "emitter");
    harness = new Harness(d);
    harness.start();
    await waitFor(() => harness !== undefined && harness.events.length >= 4, 8000, "4 条事件");
    const types = harness.eventTypes();
    expect(types).toEqual(["fact", "deliver", "dispatch", "heartbeat"]);
    // payload 原样透传（含业务字段），供 T28 消费
    const fact = harness.events.find((e) => e.event.type === "fact");
    expect(fact?.event.payload["key"]).toBe("cpu");
    expect(fact?.event.payload["value"]).toBe(0.42);
    await harness.stopAndReap();
  });

  it("非零退出 respawn：退避 1s,2s,4s…（假 sleep 注入、base 可配）", async () => {
    const d = freshDir();
    const marker = join(d, "launches.log");
    mountFixture(d, "crasher");
    const delays: number[] = [];
    harness = new Harness(d, {
      baseBackoffMs: 1000,
      capBackoffMs: 8000,
      env: { CRASH_MARKER: marker },
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    harness.start();
    await waitFor(() => harness !== undefined && harness.pids.length >= 4, 10000, "4 次拉起");
    await harness.stopAndReap();
    // 退出码 3 -> 重拉；退避严格按 1000,2000,4000（下一档封顶 8000）
    expect(delays.slice(0, 3)).toEqual([1000, 2000, 4000]);
    expect(existsSync(marker)).toBe(true);
    expect(harness.findLog("计划退避重拉")).toBeDefined();
  });

  it("退避封顶：capBackoffMs 生效", async () => {
    const d = freshDir();
    mountFixture(d, "crasher");
    const delays: number[] = [];
    harness = new Harness(d, {
      env: { CRASH_MARKER: join(d, "m.log") },
      sleep: async (ms) => {
        delays.push(ms);
      },
      baseBackoffMs: 1000,
      capBackoffMs: 2500,
    });
    harness.start();
    // 等第 4 次退避完成（4 次崩溃后 delays=[1000,2000,2500,2500]），再停止。
    await waitFor(() => delays.length >= 4, 10000, "4 次退避");
    await harness.stopAndReap();
    expect(delays.slice(0, 4)).toEqual([1000, 2000, 2500, 2500]);
  });

  it("exec 保留事件：拒绝并记录，绝不执行（哨兵文件不出现）", async () => {
    const d = freshDir();
    const sentinel = join(d, "executed.sentinel");
    mountFixture(d, "execabuser");
    harness = new Harness(d, { env: { EXEC_SENTINEL: sentinel } });
    harness.start();
    // exec 之后的 heartbeat 仍被解析：拒绝保留事件不掐断事件流
    await waitFor(
      () => harness !== undefined && harness.eventTypes().includes("heartbeat"),
      8000,
      "heartbeat 事件",
    );
    await waitMs(300); // 若宿主有任何执行路径，此刻哨兵早已出现
    expect(existsSync(sentinel)).toBe(false);
    const rejected = harness.findLog("拒绝保留事件");
    expect(rejected).toBeDefined();
    expect(rejected?.level).toBe("error");
    expect(rejected?.fields["reservedType"]).toBe("exec");
    await harness.stopAndReap();
  });

  it("enabled:false 脚本绝不拉起", async () => {
    const d = freshDir();
    const marker = join(d, "spawned.log");
    mountFixture(d, "disabled");
    mountFixture(d, "emitter"); // 参照物：说明扫描确实执行了
    harness = new Harness(d, { env: { DISABLED_MARKER: marker } });
    harness.start();
    await waitFor(() => harness !== undefined && harness.events.length >= 4, 8000, "emitter 事件");
    await waitMs(300);
    expect(existsSync(marker)).toBe(false);
    expect(harness.pids.length).toBe(1); // 只有 emitter
    await harness.stopAndReap();
  });

  it("干净退出（code 0）不重拉，即便 respawn:true", async () => {
    const d = freshDir();
    mountFixture(d, "cleanexit");
    let respawnScheduled = false;
    harness = new Harness(d, {
      sleep: async () => {
        respawnScheduled = true; // 若错误重拉，退避 sleep 会被调用
      },
    });
    harness.start();
    await waitFor(() => harness !== undefined && harness.events.length >= 1, 8000, "heartbeat");
    await waitMs(400);
    expect(respawnScheduled).toBe(false);
    expect(harness.pids.length).toBe(1);
    expect(harness.findLog("干净退出")).toBeDefined();
    harness.stop();
  });

  it("非法 frontmatter：拒绝挂载并记录，不 spawn", async () => {
    const d = freshDir();
    mountFixture(d, "emitter");
    writeFileSync(join(d, "bad.py"), "#---\n#owner: bob\n#---\nprint(1)\n", "utf8");
    harness = new Harness(d);
    harness.start();
    await waitFor(() => harness !== undefined && harness.events.length >= 4, 8000, "emitter 事件");
    await waitMs(200);
    expect(harness.pids.length).toBe(1); // bad.py 未被拉起
    const log = harness.findLog("拒绝挂载");
    expect(log).toBeDefined();
    expect(log?.level).toBe("error");
    expect(String(log?.fields["reason"])).toContain("未知 frontmatter 键");
    await harness.stopAndReap();
  });

  it("rescan 热加载：新增脚本被挂载，事件到达", async () => {
    const d = freshDir();
    mountFixture(d, "emitter");
    harness = new Harness(d);
    harness.start();
    await waitFor(() => harness !== undefined && harness.events.length >= 4, 8000, "emitter 事件");
    mountFixture(d, "cleanexit");
    harness.host?.rescan();
    await waitFor(
      () => harness !== undefined && harness.events.some((e) => e.script === "cleanexit"),
      8000,
      "cleanexit 热加载事件",
    );
    await harness.stopAndReap();
  });

  it("stop() 杀掉常驻子进程组（无孤儿 pid）", async () => {
    const d = freshDir();
    mountFixture(d, "emitter");
    harness = new Harness(d);
    harness.start();
    await waitFor(() => harness !== undefined && harness.pids.length >= 1, 8000, "子进程启动");
    const pid = harness.pids[0];
    expect(pid).toBeDefined();
    expect(pidAlive(pid ?? -1)).toBe(true);
    await harness.stopAndReap();
    expect(pidAlive(pid ?? -1)).toBe(false);
  });
});
