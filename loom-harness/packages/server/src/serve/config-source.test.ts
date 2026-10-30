/**
 * W27 实例化 —— 配置/state 根解析真值表（纯函数 + mkdtemp 实例根，零真树）。
 *
 * Given/When/Then 逐格钉冻结口径：
 *   resolveConfigPath：--config 显式 > LOOM_CONFIG > $LOOM_INSTANCE/.loom/config.yaml >
 *   仓库 legacy 缺省；实例已指而配置缺失 = InstanceConfigMissingError 硬失败（绝不
 *   静默回落——回落 = 实例读写错根，隔离承诺当场破产）；legacy 回落打一行 warn。
 *   resolveStateRootFromEnv：LOOM_STATE > $LOOM_INSTANCE/.loom > 仓库缺省。
 *
 * 纪律：只碰 fs.mkdtemp 临时目录，绝不写仓库 state/ 或 fixture-workspace/。
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  DEFAULT_CONFIG_PATH,
  DEFAULT_STATE_ROOT,
  InstanceConfigMissingError,
  instanceConfigPath,
  instanceStateRoot,
  resolveConfigPath,
  resolveStateRootFromEnv,
} from "./config-source.js";

let work = "";
/** 配好的实例根（.loom/config.yaml 在场）。 */
let instReady = "";
/** 空实例根（.loom 下没有 config.yaml——迁移做一半的部署现场）。 */
let instMissing = "";

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "loom-w27-resolve-"));
  instReady = join(work, "inst-ready");
  instMissing = join(work, "inst-missing");
  mkdirSync(join(instReady, ".loom"), { recursive: true });
  writeFileSync(join(instReady, ".loom", "config.yaml"), "server:\n  port: 5097\n", "utf8");
  mkdirSync(join(instMissing, ".loom"), { recursive: true });
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

describe("W27 resolveConfigPath 真值表", () => {
  it("显式 --config 同时压过 LOOM_CONFIG 与实例路径", () => {
    const warns: string[] = [];
    const got = resolveConfigPath("/explicit/loom.yaml", { LOOM_CONFIG: "/env-path", LOOM_INSTANCE: instReady }, (m) => warns.push(m));
    expect(got).toBe("/explicit/loom.yaml");
    expect(warns).toHaveLength(0); // 命中显式路径不提 legacy（warn 只在真回落时说话）
  });

  it("LOOM_CONFIG 压过实例：显式指路时不回看实例（实例配置缺席也不炸——迁移过渡期合法）", () => {
    const got = resolveConfigPath(undefined, { LOOM_CONFIG: "/env-path", LOOM_INSTANCE: instMissing });
    expect(got).toBe("/env-path");
  });

  it("LOOM_INSTANCE 在场且 .loom/config.yaml 存在 → 命中实例路径，零 warn", () => {
    const warns: string[] = [];
    const got = resolveConfigPath(undefined, { LOOM_INSTANCE: instReady }, (m) => warns.push(m));
    expect(got).toBe(join(instReady, ".loom", "config.yaml"));
    expect(got).toBe(instanceConfigPath(instReady));
    expect(warns).toHaveLength(0);
  });

  it("LOOM_INSTANCE 已指而 .loom/config.yaml 缺失 → InstanceConfigMissingError 硬失败（中文口径可读）", () => {
    let caught: unknown = null;
    try {
      resolveConfigPath(undefined, { LOOM_INSTANCE: instMissing });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InstanceConfigMissingError);
    const msg = (caught as InstanceConfigMissingError).message;
    // 人话三件套：出了什么事（硬失败）+ 期望哪条路（可诊断）+ 怎么补救（撤 env 或补迁移）。
    expect(msg).toContain("serve 启动失败");
    expect(msg).toContain("实例配置不存在");
    expect(msg).toContain(join(instMissing, ".loom", "config.yaml"));
    expect(msg).toContain("LOOM_INSTANCE");
  });

  it("无任何 env → 仓库 legacy 缺省 + 一行 legacy warn（非实例模式说实话）", () => {
    const warns: string[] = [];
    const got = resolveConfigPath(undefined, {}, (m) => warns.push(m));
    expect(got).toBe(DEFAULT_CONFIG_PATH);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("legacy");
  });

  it("LOOM_INSTANCE 空串视为未设（回落 legacy，不是半途实例配置硬炸）", () => {
    const warns: string[] = [];
    const got = resolveConfigPath(undefined, { LOOM_INSTANCE: "" }, (m) => warns.push(m));
    expect(got).toBe(DEFAULT_CONFIG_PATH);
    expect(warns).toHaveLength(1);
  });

  it("回调缺席时 legacy 回落照常（warn 是观测面不是硬依赖）", () => {
    expect(resolveConfigPath(undefined, {})).toBe(DEFAULT_CONFIG_PATH);
  });
});

describe("W27 resolveStateRootFromEnv 真值表", () => {
  it("LOOM_STATE 显式压过实例（state 与 config 分居两处在部署口径里合法）", () => {
    expect(resolveStateRootFromEnv({ LOOM_STATE: "/state-explicit", LOOM_INSTANCE: instReady })).toBe("/state-explicit");
  });

  it("LOOM_INSTANCE → <instance>/.loom（六子目录同住其内，layout 自动派生）", () => {
    expect(resolveStateRootFromEnv({ LOOM_INSTANCE: instReady })).toBe(join(instReady, ".loom"));
    expect(resolveStateRootFromEnv({ LOOM_INSTANCE: instReady })).toBe(instanceStateRoot(instReady));
  });

  it("两者皆缺 → 仓库 legacy state 根（现口径一字不动，dev/测试零感知）", () => {
    expect(resolveStateRootFromEnv({})).toBe(DEFAULT_STATE_ROOT);
  });

  it("LOOM_STATE 空串视为未设 → 落到实例；实例也空 → legacy", () => {
    expect(resolveStateRootFromEnv({ LOOM_STATE: "", LOOM_INSTANCE: instReady })).toBe(join(instReady, ".loom"));
    expect(resolveStateRootFromEnv({ LOOM_STATE: "", LOOM_INSTANCE: "" })).toBe(DEFAULT_STATE_ROOT);
  });
});

describe("W27 实例根解析与装配链的接缝", () => {
  it("解析产物即真盘：实例配置命中后可直接被 existsSync 消费（无幽灵路径）", () => {
    const resolved = resolveConfigPath(undefined, { LOOM_INSTANCE: instReady });
    expect(existsSync(resolved)).toBe(true);
    // legacy 缺省路径本身允许不存在（gitignore 内的真凭据文件由部署落盘）——
    // 存在性硬闸在 loadServeConfig 的 ConfigFileMissingError，两闸各司其职不混。
    const stateRoot = resolveStateRootFromEnv({ LOOM_INSTANCE: instReady });
    expect(existsSync(stateRoot)).toBe(true);
  });
});
