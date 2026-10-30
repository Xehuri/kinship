// T07 验收测试：loom.yaml schema 校验 + 凭据 env-ref 处理。
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  LoomConfigError,
  loadLoomConfig,
  MIN_PORT,
  parseLoomConfig,
} from "./loom-config.js";
import { checkPty } from "./section-checks.js";

const VALID_YAML = `
server:
  port: 5097
  hostname: 127.0.0.1
workspace: /srv/loom/fixture-workspace
models:
  - id: qwen3.8-flash
    provider: eflowcode
    contextWindow: 262144
    maxOutput: 32768
    vision: true
    timeout: 120000
pricing:
  eflowcode:
    input: 0.5
    output: 2.5
credentials:
  eflowcode: \${LOOM_KEY_EFLOWCODE}
exits:
  default:
    kind: ai-mcp
    enabled: true
`;

const ENV_OK = { LOOM_KEY_EFLOWCODE: "sk-secret-value-123" };

function errorsOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (e: unknown) {
    if (e instanceof LoomConfigError) {
      return [...e.errors];
    }
    throw e;
  }
  return [];
}

describe("parseLoomConfig / 合法配置", () => {
  it("接受 env-ref 形式并用注入 env 解析凭据", () => {
    const cfg = parseLoomConfig(VALID_YAML, "<test>", { env: ENV_OK });
    expect(cfg.server).toEqual({ port: 5097, hostname: "127.0.0.1" });
    expect(cfg.workspace).toBe("/srv/loom/fixture-workspace");
    expect(cfg.models).toHaveLength(1);
    expect(cfg.models[0]).toMatchObject({
      id: "qwen3.8-flash",
      provider: "eflowcode",
      contextWindow: 262144,
      maxOutput: 32768,
      vision: true,
      timeout: 120000,
    });
    expect(cfg.pricing["eflowcode"]).toMatchObject({ input: 0.5, output: 2.5 });
    expect(cfg.credentials["eflowcode"]).toEqual({
      envRef: "LOOM_KEY_EFLOWCODE",
      value: "sk-secret-value-123",
    });
  });

  it("exits 段作为 D33 stub 原样透传", () => {
    const cfg = parseLoomConfig(VALID_YAML, "<test>", { env: ENV_OK });
    expect(cfg.exits).toEqual({
      stub: true,
      declaration: { default: { kind: "ai-mcp", enabled: true } },
    });
  });

  it("缺省可选段：无 pricing / 无 credentials / 无 exits 时为空值", () => {
    const minimal = `
server:
  port: 5100
  hostname: 0.0.0.0
workspace: /tmp/ws
models:
  - id: m1
    provider: p1
    contextWindow: 1000
    maxOutput: 100
    timeout: 5000
`;
    const cfg = parseLoomConfig(minimal, "<test>");
    expect(cfg.pricing).toEqual({});
    expect(cfg.credentials).toEqual({});
    expect(cfg.exits).toBeUndefined();
    expect(cfg.models[0]?.vision).toBe(false);
  });
});

describe("parseLoomConfig / server 段", () => {
  it(`拒绝 port < ${MIN_PORT}（D32 禁碰现网端口）`, () => {
    const bad = VALID_YAML.replace("port: 5097", "port: 5096");
    const errs = errorsOf(() => parseLoomConfig(bad, "<t>", { env: ENV_OK }));
    expect(errs.some((e) => e.includes("server.port"))).toBe(true);
  });

  it("拒绝非整数 port 与缺失 hostname", () => {
    const errs = errorsOf(() =>
      parseLoomConfig("server:\n  port: 5097.5\nworkspace: /w\n", "<t>"),
    );
    expect(errs.some((e) => e.includes("server.port"))).toBe(true);
    expect(errs.some((e) => e.includes("server.hostname"))).toBe(true);
  });

  // W26 主会话收束强制开关：键缺席 = 不物化（"缺省⇒true" 的收敛在 core 层，
  // 上面 "合法配置" 用例的 toEqual({port,hostname}) 已钉死缺席形态）。
  it("convergenceEnforced: false 逐值透传（键物化为 false）", () => {
    const yaml = VALID_YAML.replace("  hostname: 127.0.0.1\n", "  hostname: 127.0.0.1\n  convergenceEnforced: false\n");
    const cfg = parseLoomConfig(yaml, "<t>", { env: ENV_OK });
    expect(cfg.server).toEqual({ port: 5097, hostname: "127.0.0.1", convergenceEnforced: false });
  });

  it("convergenceEnforced: true 逐值透传（显式 true ≡ 现状语义，物化为 true 供接线直读）", () => {
    const yaml = VALID_YAML.replace("  hostname: 127.0.0.1\n", "  hostname: 127.0.0.1\n  convergenceEnforced: true\n");
    const cfg = parseLoomConfig(yaml, "<t>", { env: ENV_OK });
    expect(cfg.server.convergenceEnforced).toBe(true);
  });

  it("convergenceEnforced 非布尔 → schema 错误（文案与邻居 boolDefault 同构）", () => {
    for (const bad of ["0", "\"no\"", "[false]", "{v: false}"]) {
      const yaml = VALID_YAML.replace(
        "  hostname: 127.0.0.1\n",
        `  hostname: 127.0.0.1\n  convergenceEnforced: ${bad}\n`,
      );
      const errs = errorsOf(() => parseLoomConfig(yaml, "<t>", { env: ENV_OK }));
      expect(
        errs.some((e) => e.includes("server.convergenceEnforced") && e.includes("需要布尔值")),
        `应拒 ${bad}`,
      ).toBe(true);
    }
  });

  // W35 memory 源字节契约开关：键缺席 = 不物化（undefined）——"缺省 ⇒ strict"的收敛在
  // boot 日志面单点材料化，schema 面不造假值（上方"合法配置"用例的 toEqual({port,hostname})
  // 已钉缺席形态，此处补显式 undefined 断言与逐值透传/非法值三案，镜像 W26 族样式）。
  it("sourceContract 键缺席 = undefined 不物化（server 段不含该键，严格 toEqual 钉死形状）", () => {
    const cfg = parseLoomConfig(VALID_YAML, "<t>", { env: ENV_OK });
    expect(cfg.server).toEqual({ port: 5097, hostname: "127.0.0.1" });
    expect(cfg.server.sourceContract).toBeUndefined();
  });

  it('sourceContract: "off" 逐值透传（键物化为 "off"；YAML 1.2 下 off 是字符串非布尔）', () => {
    const yaml = VALID_YAML.replace("  hostname: 127.0.0.1\n", "  hostname: 127.0.0.1\n  sourceContract: off\n");
    const cfg = parseLoomConfig(yaml, "<t>", { env: ENV_OK });
    expect(cfg.server).toEqual({ port: 5097, hostname: "127.0.0.1", sourceContract: "off" });
  });

  it('sourceContract: "strict" 逐值透传（显式 strict ≡ 缺席语义，物化为 "strict" 供日志面直读）', () => {
    const yaml = VALID_YAML.replace("  hostname: 127.0.0.1\n", "  hostname: 127.0.0.1\n  sourceContract: strict\n");
    const cfg = parseLoomConfig(yaml, "<t>", { env: ENV_OK });
    expect(cfg.server.sourceContract).toBe("strict");
  });

  it("sourceContract 非法值 → schema 错误（fail-fast 同邻居；枚举外字符串/布尔/数组/映射全拒）", () => {
    for (const bad of ["offf", "true", "0", "[off]", "{v: off}"]) {
      const yaml = VALID_YAML.replace(
        "  hostname: 127.0.0.1\n",
        `  hostname: 127.0.0.1\n  sourceContract: ${bad}\n`,
      );
      const errs = errorsOf(() => parseLoomConfig(yaml, "<t>", { env: ENV_OK }));
      expect(
        errs.some((e) => e.includes("server.sourceContract") && e.includes("需要")),
        `应拒 ${bad}`,
      ).toBe(true);
    }
  });

  // W56 忙时发送抢占开关：键缺席 = undefined 不物化（缺省 OFF 的收敛在 boot/registry），
  // 显式 true/false 逐值物化供接线直读；非布尔 fail-fast 同 optionalBool 邻居口径。
  it("interruptOnSend 键缺席 = undefined 不物化（server 段不含该键，严格 toEqual 钉死形状）", () => {
    const cfg = parseLoomConfig(VALID_YAML, "<t>", { env: ENV_OK });
    expect(cfg.server).toEqual({ port: 5097, hostname: "127.0.0.1" });
    expect(cfg.server.interruptOnSend).toBeUndefined();
  });

  it("interruptOnSend: true 逐值透传（键物化为 true）", () => {
    const yaml = VALID_YAML.replace("  hostname: 127.0.0.1\n", "  hostname: 127.0.0.1\n  interruptOnSend: true\n");
    const cfg = parseLoomConfig(yaml, "<t>", { env: ENV_OK });
    expect(cfg.server).toEqual({ port: 5097, hostname: "127.0.0.1", interruptOnSend: true });
  });

  it("interruptOnSend: false 逐值透传（键物化为 false，显式旧语义）", () => {
    const yaml = VALID_YAML.replace("  hostname: 127.0.0.1\n", "  hostname: 127.0.0.1\n  interruptOnSend: false\n");
    const cfg = parseLoomConfig(yaml, "<t>", { env: ENV_OK });
    expect(cfg.server).toEqual({ port: 5097, hostname: "127.0.0.1", interruptOnSend: false });
  });

  it("interruptOnSend 非布尔 → schema 错误（文案与邻居 optionalBool 同构）", () => {
    for (const bad of ['"yes"', "1", "[]"]) {
      const yaml = VALID_YAML.replace(
        "  hostname: 127.0.0.1\n",
        `  hostname: 127.0.0.1\n  interruptOnSend: ${bad}\n`,
      );
      const errs = errorsOf(() => parseLoomConfig(yaml, "<t>", { env: ENV_OK }));
      expect(
        errs.some((e) => e.includes("server.interruptOnSend") && e.includes("需要布尔值")),
        `应拒 ${bad}`,
      ).toBe(true);
    }
  });

  // 自动唤醒开关：键缺席 = undefined 不物化（缺省启用的收敛在 boot/registry），
  // 显式 true/false 逐值物化供接线直读；非布尔 fail-fast 同 optionalBool 邻居口径。
  it("autoWakeEnabled 键缺席 = undefined 不物化（server 段不含该键，严格 toEqual 钉死形状）", () => {
    const cfg = parseLoomConfig(VALID_YAML, "<t>", { env: ENV_OK });
    expect(cfg.server).toEqual({ port: 5097, hostname: "127.0.0.1" });
    expect(cfg.server.autoWakeEnabled).toBeUndefined();
  });

  it("autoWakeEnabled: true 逐值透传（键物化为 true）", () => {
    const yaml = VALID_YAML.replace("  hostname: 127.0.0.1\n", "  hostname: 127.0.0.1\n  autoWakeEnabled: true\n");
    const cfg = parseLoomConfig(yaml, "<t>", { env: ENV_OK });
    expect(cfg.server).toEqual({ port: 5097, hostname: "127.0.0.1", autoWakeEnabled: true });
  });

  it("autoWakeEnabled: false 逐值透传（键物化为 false，显式关闭）", () => {
    const yaml = VALID_YAML.replace("  hostname: 127.0.0.1\n", "  hostname: 127.0.0.1\n  autoWakeEnabled: false\n");
    const cfg = parseLoomConfig(yaml, "<t>", { env: ENV_OK });
    expect(cfg.server).toEqual({ port: 5097, hostname: "127.0.0.1", autoWakeEnabled: false });
  });

  it("autoWakeEnabled 非布尔 → schema 错误（文案与邻居 optionalBool 同构）", () => {
    for (const bad of ['"yes"', "1", "[]"]) {
      const yaml = VALID_YAML.replace(
        "  hostname: 127.0.0.1\n",
        `  hostname: 127.0.0.1\n  autoWakeEnabled: ${bad}\n`,
      );
      const errs = errorsOf(() => parseLoomConfig(yaml, "<t>", { env: ENV_OK }));
      expect(
        errs.some((e) => e.includes("server.autoWakeEnabled") && e.includes("需要布尔值")),
        `应拒 ${bad}`,
      ).toBe(true);
    }
  });
});

// 会话列表开关与主会话 id：两者键缺席 = undefined 不物化（消费层按关闭收敛，
// schema 不物化 false）；mainSessionId 字符集 = 字母数字/下划线（连字符不在
// Loom 会话 id 字符集内），非法/空值 fail-fast 点名 server.mainSessionId。
describe("parseLoomConfig / server 段 sessionList 与 mainSessionId", () => {
  it("sessionList 键缺席 = undefined 不物化（严格 toEqual 钉死形状）", () => {
    const cfg = parseLoomConfig(VALID_YAML, "<t>", { env: ENV_OK });
    expect(cfg.server).toEqual({ port: 5097, hostname: "127.0.0.1" });
    expect("sessionList" in cfg.server).toBe(false);
  });

  it("sessionList: true/false 逐值透传（物化为布尔，不补缺省）", () => {
    for (const value of ["true", "false"]) {
      const yaml = VALID_YAML.replace(
        "  hostname: 127.0.0.1\n",
        `  hostname: 127.0.0.1\n  sessionList: ${value}\n`,
      );
      const cfg = parseLoomConfig(yaml, "<t>", { env: ENV_OK });
      expect(cfg.server).toEqual({
        port: 5097,
        hostname: "127.0.0.1",
        sessionList: value === "true",
      });
    }
  });

  it("sessionList 非布尔 → schema 错误（文案与邻居 optionalBool 同构）", () => {
    for (const bad of ['"yes"', "1", "[]"]) {
      const yaml = VALID_YAML.replace(
        "  hostname: 127.0.0.1\n",
        `  hostname: 127.0.0.1\n  sessionList: ${bad}\n`,
      );
      const errs = errorsOf(() => parseLoomConfig(yaml, "<t>", { env: ENV_OK }));
      expect(
        errs.some((e) => e.includes("server.sessionList") && e.includes("需要布尔值")),
        `应拒 ${bad}`,
      ).toBe(true);
    }
  });

  it("mainSessionId 键缺席 = undefined 不物化（严格 toEqual 钉死形状）", () => {
    const cfg = parseLoomConfig(VALID_YAML, "<t>", { env: ENV_OK });
    expect(cfg.server).toEqual({ port: 5097, hostname: "127.0.0.1" });
    expect("mainSessionId" in cfg.server).toBe(false);
  });

  it("mainSessionId 合法值逐值透传（字母数字/下划线）", () => {
    for (const value of ["main_session_01", "ABC123", "ses_abc_def"]) {
      const yaml = VALID_YAML.replace(
        "  hostname: 127.0.0.1\n",
        `  hostname: 127.0.0.1\n  mainSessionId: ${value}\n`,
      );
      const cfg = parseLoomConfig(yaml, "<t>", { env: ENV_OK });
      expect(cfg.server.mainSessionId).toBe(value);
    }
  });

  it("mainSessionId 非法值 fail-fast 点名 server.mainSessionId（空串/连字符/空格/非字符串/数组）", () => {
    for (const bad of ['""', "ses-abc", '"ses abc"', "123", "[ses_a]"]) {
      const yaml = VALID_YAML.replace(
        "  hostname: 127.0.0.1\n",
        `  hostname: 127.0.0.1\n  mainSessionId: ${bad}\n`,
      );
      const errs = errorsOf(() => parseLoomConfig(yaml, "<t>", { env: ENV_OK }));
      expect(
        errs.some((e) => e.includes("server.mainSessionId")),
        `应拒 ${bad}`,
      ).toBe(true);
    }
  });
});

// W36 工具面沙箱配置化：顶层 sandbox 段（containment/net/deny）。
// 用户 2026-10-14 决策：realpath 围栏需 config 可配置，拒绝引擎默认不拦截，配置好才拦截。
// 三键皆可选，键缺席 = undefined 不物化（W35 sourceContract 同款纪律，收敛在消费/日志面）。
describe("parseLoomConfig / sandbox 段（W36 沙箱配置驱动）", () => {
  it("sandbox 键缺席 = undefined 不物化（LoomConfig 不含该键，undefined-honest）", () => {
    const cfg = parseLoomConfig(VALID_YAML, "<t>", { env: ENV_OK });
    expect(cfg.sandbox).toBeUndefined();
  });

  it("sandbox 全键逐值透传（containment/net/deny 三键）", () => {
    const yaml =
      VALID_YAML + '\nsandbox:\n  containment: off\n  net: deny\n  deny: [sudo, "git push"]\n';
    const cfg = parseLoomConfig(yaml, "<t>", { env: ENV_OK });
    expect(cfg.sandbox).toEqual({ containment: "off", net: "deny", deny: ["sudo", "git push"] });
  });

  it("sandbox 空段 = 空对象（各键仍缺席语义，下游按缺省收敛）", () => {
    const yaml = VALID_YAML + "\nsandbox: {}\n";
    const cfg = parseLoomConfig(yaml, "<t>", { env: ENV_OK });
    expect(cfg.sandbox).toEqual({});
  });

  it("sandbox 非法值 → schema 错误（fail-fast 中文报错同邻居）", () => {
    const cases: readonly [string, string][] = [
      ["containment: lenient", "sandbox.containment"],
      ["net: blocked", "sandbox.net"],
      ["deny: sudo", "sandbox.deny"],
      ['deny: [""]', "sandbox.deny[0]"],
    ];
    for (const [line, field] of cases) {
      const yaml = VALID_YAML + `\nsandbox:\n  ${line}\n`;
      const errs = errorsOf(() => parseLoomConfig(yaml, "<t>", { env: ENV_OK }));
      expect(
        errs.some((e) => e.includes(field) && e.includes("需要")),
        `应拒 ${line}`,
      ).toBe(true);
    }
  });
});

// W40 后台子智能体 deadline 配置化：顶层 subagent 段（backgroundDeadlineSeconds）。
// 用户 2026-10-14 现网实况：core 缺省 15min 硬 deadline 杀掉数据核验批次的后台任务，
// 实例需 config 抬闸（lead 将设 3600）。键缺席 = undefined 不物化（W35/W36 同款纪律，
// "缺省 ⇒ core DEFAULT_BACKGROUND_DEADLINE_MS=15min" 的收敛在 task-tool 派发时刻现读，
// schema 面不造假值；生效=改配置+重启，无热重载通道）。
describe("parseLoomConfig / subagent 段（W40 后台 deadline 配置化）", () => {
  it("subagent 键缺席 = undefined 不物化（LoomConfig 不含该键，undefined-honest）", () => {
    const cfg = parseLoomConfig(VALID_YAML, "<t>", { env: ENV_OK });
    expect(cfg.subagent).toBeUndefined();
  });

  it("subagent 显式声明逐值透传（backgroundDeadlineSeconds: 3600）", () => {
    const yaml = VALID_YAML + "\nsubagent:\n  backgroundDeadlineSeconds: 3600\n";
    const cfg = parseLoomConfig(yaml, "<t>", { env: ENV_OK });
    expect(cfg.subagent).toEqual({ backgroundDeadlineSeconds: 3600 });
  });

  it("subagent 空段 = 空对象（键仍缺席语义，下游走 core 派发时现读缺省）", () => {
    const yaml = VALID_YAML + "\nsubagent: {}\n";
    const cfg = parseLoomConfig(yaml, "<t>", { env: ENV_OK });
    expect(cfg.subagent).toEqual({});
  });

  it("subagent 非法值 → schema 错误（0/-1/\"x\"/1.5 各自 fail-fast 中文报错同邻居）", () => {
    const cases: readonly string[] = ["0", "-1", '"x"', "1.5"];
    for (const bad of cases) {
      const yaml = VALID_YAML + `\nsubagent:\n  backgroundDeadlineSeconds: ${bad}\n`;
      const errs = errorsOf(() => parseLoomConfig(yaml, "<t>", { env: ENV_OK }));
      expect(
        errs.some((e) => e.includes("subagent.backgroundDeadlineSeconds") && e.includes("需要")),
        `应拒 ${bad}`,
      ).toBe(true);
    }
  });

  it("subagent 非映射 → schema 错误（需要映射，同 sandbox 段口径）", () => {
    const yaml = VALID_YAML + "\nsubagent: 3600\n";
    const errs = errorsOf(() => parseLoomConfig(yaml, "<t>", { env: ENV_OK }));
    expect(errs.some((e) => e.includes("subagent") && e.includes("需要映射"))).toBe(true);
  });
});

// W42c 派发闸三键开成配置键（横/纵/总量）：maxFanout/maxDepth/maxInflightTotal——键全可选、
// 缺席不物化（"缺省 ⇒ core 冻结值 8/2/现读兜 16"的收敛在派发时刻，schema 不造假值，W40
// backgroundDeadlineSeconds 同款四态纪律）。数值零改动承诺：开键只修可调性。
describe("parseLoomConfig / subagent 段扩展键（W42c 派发闸三键）", () => {
  it("三键显式声明逐值透传（与 deadline 共存一个段）", () => {
    const yaml =
      VALID_YAML +
      "\nsubagent:\n  backgroundDeadlineSeconds: 3600\n  maxFanout: 5\n  maxDepth: 3\n  maxInflightTotal: 32\n";
    const cfg = parseLoomConfig(yaml, "<t>", { env: ENV_OK });
    expect(cfg.subagent).toEqual({
      backgroundDeadlineSeconds: 3600,
      maxFanout: 5,
      maxDepth: 3,
      maxInflightTotal: 32,
    });
  });

  it("三键缺席不物化（段在场仅 deadline → 对象只含 deadline 键，undefined-honest）", () => {
    const yaml = VALID_YAML + "\nsubagent:\n  backgroundDeadlineSeconds: 3600\n";
    const cfg = parseLoomConfig(yaml, "<t>", { env: ENV_OK });
    expect(cfg.subagent).toEqual({ backgroundDeadlineSeconds: 3600 });
    expect("maxFanout" in (cfg.subagent ?? {})).toBe(false);
    expect("maxDepth" in (cfg.subagent ?? {})).toBe(false);
    expect("maxInflightTotal" in (cfg.subagent ?? {})).toBe(false);
    expect("maxTurns" in (cfg.subagent ?? {})).toBe(false);
  });

  it("三键非法值 fail-fast 点名键名（0/-1/\"x\"/1.5 × 每键各自报错，同 optionalIntRange 邻居口径）", () => {
    for (const key of ["maxFanout", "maxDepth", "maxInflightTotal"]) {
      for (const bad of ["0", "-1", '"x"', "1.5"]) {
        const yaml = VALID_YAML + `\nsubagent:\n  ${key}: ${bad}\n`;
        const errs = errorsOf(() => parseLoomConfig(yaml, "<t>", { env: ENV_OK }));
        expect(
          errs.some((e) => e.includes(`subagent.${key}`) && e.includes("需要")),
          `应拒 ${key}: ${bad}`,
        ).toBe(true);
      }
    }
  });
});

// subagent.maxTurns：子会话回合上限（键缺席 = serve 装配时刻现读 SERVE_SUB_MAX_TURNS=50，
// schema 面不造假值；非法值同 optionalIntRange 邻居口径点名键名）。
describe("parseLoomConfig / subagent 段 maxTurns（子会话回合上限）", () => {
  it("maxTurns 显式声明逐值透传（与 deadline 共存一个段）", () => {
    const yaml = VALID_YAML + "\nsubagent:\n  backgroundDeadlineSeconds: 3600\n  maxTurns: 150\n";
    const cfg = parseLoomConfig(yaml, "<t>", { env: ENV_OK });
    expect(cfg.subagent).toEqual({ backgroundDeadlineSeconds: 3600, maxTurns: 150 });
  });

  it("maxTurns 缺席不物化（段在场仅 deadline → 对象不含该键，undefined-honest）", () => {
    const yaml = VALID_YAML + "\nsubagent:\n  backgroundDeadlineSeconds: 3600\n";
    const cfg = parseLoomConfig(yaml, "<t>", { env: ENV_OK });
    expect(cfg.subagent).toEqual({ backgroundDeadlineSeconds: 3600 });
    expect("maxTurns" in (cfg.subagent ?? {})).toBe(false);
  });

  it("maxTurns 非法值 fail-fast 点名键名（0/-1/\"x\"/1.5，同 optionalIntRange 邻居口径）", () => {
    for (const bad of ["0", "-1", '"x"', "1.5"]) {
      const yaml = VALID_YAML + `\nsubagent:\n  maxTurns: ${bad}\n`;
      const errs = errorsOf(() => parseLoomConfig(yaml, "<t>", { env: ENV_OK }));
      expect(
        errs.some((e) => e.includes("subagent.maxTurns") && e.includes("需要")),
        `应拒 ${bad}`,
      ).toBe(true);
    }
  });

  it("空段不物化 maxTurns（subagent: {} 保持空对象）", () => {
    const yaml = VALID_YAML + "\nsubagent: {}\n";
    const cfg = parseLoomConfig(yaml, "<t>", { env: ENV_OK });
    expect(cfg.subagent).toEqual({});
    expect("maxTurns" in (cfg.subagent ?? {})).toBe(false);
  });
});

// W42c 收束闸四值开成实例配置键：新顶层 convergence 段。缺省语义 = core DEFAULT_LIMITS
// 冻结值 5/3/60/2（键缺席=不物化，收敛在 loop/gate 构造时刻 ?? 兜常量，两既有注入缝
// registry.limits / sidePort.limits 吃到声明值）；autoContinuations ≥0（0=不自动续跑，
// core assertValidLimits 同界）。W26 语义铁律：本段只改数值不改主/side/sub 强制分支。
describe("parseLoomConfig / convergence 段（W42c 收束闸四值配置化）", () => {
  it("convergence 键缺席 = undefined 不物化（LoomConfig 不含该键）", () => {
    const cfg = parseLoomConfig(VALID_YAML, "<t>", { env: ENV_OK });
    expect(cfg.convergence).toBeUndefined();
  });

  it("四值显式声明逐值透传（autoContinuations: 0 合法=不自动续跑）", () => {
    const yaml =
      VALID_YAML +
      "\nconvergence:\n  nudgeLimit: 8\n  escalateSameError: 4\n  turnHardCap: 150\n  autoContinuations: 0\n";
    const cfg = parseLoomConfig(yaml, "<t>", { env: ENV_OK });
    expect(cfg.convergence).toEqual({
      nudgeLimit: 8,
      escalateSameError: 4,
      turnHardCap: 150,
      autoContinuations: 0,
    });
  });

  it("单键声明其余缺席不物化（生产路 turnHardCap: 150 实况）", () => {
    const yaml = VALID_YAML + "\nconvergence:\n  turnHardCap: 150\n";
    const cfg = parseLoomConfig(yaml, "<t>", { env: ENV_OK });
    expect(cfg.convergence).toEqual({ turnHardCap: 150 });
  });

  it("非法值 fail-fast 点名键名（nudgeLimit/escalateSameError/turnHardCap 0 越界、autoContinuations -1 越界、浮点/字符串类型炸）", () => {
    const cases: readonly [string, string][] = [
      ["nudgeLimit", "0"],
      ["nudgeLimit", "-1"],
      ["nudgeLimit", '"x"'],
      ["escalateSameError", "1.5"],
      ["turnHardCap", "0"],
      ["autoContinuations", "-1"],
    ];
    for (const [key, bad] of cases) {
      const yaml = VALID_YAML + `\nconvergence:\n  ${key}: ${bad}\n`;
      const errs = errorsOf(() => parseLoomConfig(yaml, "<t>", { env: ENV_OK }));
      expect(
        errs.some((e) => e.includes(`convergence.${key}`) && e.includes("需要")),
        `应拒 ${key}: ${bad}`,
      ).toBe(true);
    }
  });

  it("convergence 非映射 / 空段形状（\"x\"拒→需要映射；{} 合法→空对象全键缺席）", () => {
    const errs = errorsOf(() =>
      parseLoomConfig(VALID_YAML + "\nconvergence: \"x\"\n", "<t>", { env: ENV_OK }),
    );
    expect(errs.some((e) => e.includes("convergence") && e.includes("需要映射"))).toBe(true);
    const cfg = parseLoomConfig(VALID_YAML + "\nconvergence: {}\n", "<t>", { env: ENV_OK });
    expect(cfg.convergence).toEqual({});
  });
});

// W42c 把 W42a llmErrorRetries 开成实例配置键：新顶层 llm 段（单键 errorRetries ≥0，
// 0=禁用重试）。缺省 = AgentSession 构造时刻 ?? DEFAULT_LLM_ERROR_RETRIES（2）；
// 缝位=主会话（boot→registry.limits 同款既有 MainSessionLoop 透传面），键缺席=旧行为。
describe("parseLoomConfig / llm 段（W42c errorRetries 配置化）", () => {
  it("llm 键缺席 = undefined 不物化（LoomConfig 不含该键，core 缺省 2 现读面逐字节）", () => {
    const cfg = parseLoomConfig(VALID_YAML, "<t>", { env: ENV_OK });
    expect(cfg.llm).toBeUndefined();
  });

  it("显式声明透传（errorRetries: 2 声明路；0 合法=禁用 W42a 重试）", () => {
    const two = parseLoomConfig(VALID_YAML + "\nllm:\n  errorRetries: 2\n", "<t>", { env: ENV_OK });
    expect(two.llm).toEqual({ errorRetries: 2 });
    const zero = parseLoomConfig(VALID_YAML + "\nllm:\n  errorRetries: 0\n", "<t>", { env: ENV_OK });
    expect(zero.llm).toEqual({ errorRetries: 0 });
  });

  it("errorRetries 非法值 fail-fast 点名键名（-1/\"x\"/1.5 各自中文报错，同邻居口径）", () => {
    for (const bad of ["-1", '"x"', "1.5"]) {
      const yaml = VALID_YAML + `\nllm:\n  errorRetries: ${bad}\n`;
      const errs = errorsOf(() => parseLoomConfig(yaml, "<t>", { env: ENV_OK }));
      expect(
        errs.some((e) => e.includes("llm.errorRetries") && e.includes("需要")),
        `应拒 ${bad}`,
      ).toBe(true);
    }
  });

  it("T4 新键逐值透传（errorRetryBackoffMs / failedTurnReplayRetries / failedTurnReplayBackoffMs，0 合法）", () => {
    const yaml = VALID_YAML + [
      "\nllm:",
      "  errorRetries: 6",
      "  errorRetryBackoffMs: 2000",
      "  failedTurnReplayRetries: 3",
      "  failedTurnReplayBackoffMs: 30000",
      "",
    ].join("\n");
    const cfg = parseLoomConfig(yaml, "<t>", { env: ENV_OK });
    expect(cfg.llm).toEqual({
      errorRetries: 6,
      errorRetryBackoffMs: 2000,
      failedTurnReplayRetries: 3,
      failedTurnReplayBackoffMs: 30000,
    });
    const zero = parseLoomConfig(
      VALID_YAML + "\nllm:\n  errorRetryBackoffMs: 0\n  failedTurnReplayRetries: 0\n  failedTurnReplayBackoffMs: 0\n",
      "<t>",
      { env: ENV_OK },
    );
    expect(zero.llm).toEqual({
      errorRetryBackoffMs: 0,
      failedTurnReplayRetries: 0,
      failedTurnReplayBackoffMs: 0,
    });
  });

  it("T4 新键缺席不物化（只声明 errorRetries 时不得补出其余三键）", () => {
    const cfg = parseLoomConfig(VALID_YAML + "\nllm:\n  errorRetries: 1\n", "<t>", { env: ENV_OK });
    expect(cfg.llm).toEqual({ errorRetries: 1 });
  });

  it("T4 新键非法值 fail-fast 点名键名（-1/\"x\"/1.5 各自中文报错）", () => {
    for (const key of [
      "errorRetryBackoffMs",
      "failedTurnReplayRetries",
      "failedTurnReplayBackoffMs",
    ]) {
      for (const bad of ["-1", '"x"', "1.5"]) {
        const yaml = VALID_YAML + `\nllm:\n  ${key}: ${bad}\n`;
        const errs = errorsOf(() => parseLoomConfig(yaml, "<t>", { env: ENV_OK }));
        expect(
          errs.some((e) => e.includes(`llm.${key}`) && e.includes("需要")),
          `应拒 llm.${key}: ${bad}`,
        ).toBe(true);
      }
    }
  });

  it("llm 非映射 → schema 错误（需要映射，同 subagent 段口径）", () => {
    const errs = errorsOf(() => parseLoomConfig(VALID_YAML + "\nllm: 2\n", "<t>", { env: ENV_OK }));
    expect(errs.some((e) => e.includes("llm") && e.includes("需要映射"))).toBe(true);
  });
});

describe("parseLoomConfig / models 段", () => {
  it("拒绝空 models 与缺字段的条目", () => {
    const empty = errorsOf(() => parseLoomConfig("models: []\n", "<t>"));
    expect(empty.some((e) => e.includes("models"))).toBe(true);

    const partial = VALID_YAML.replace("    provider: eflowcode\n", "");
    const errs = errorsOf(() => parseLoomConfig(partial, "<t>", { env: ENV_OK }));
    expect(errs.some((e) => e.includes("models[0].provider"))).toBe(true);
  });

  it("拒绝重复模型 id", () => {
    const dup = VALID_YAML.replace(
      "    timeout: 120000\n",
      "    timeout: 120000\n  - id: qwen3.8-flash\n    provider: other\n    contextWindow: 100\n    maxOutput: 10\n    timeout: 1000\n",
    );
    const errs = errorsOf(() => parseLoomConfig(dup, "<t>", { env: ENV_OK }));
    expect(errs.some((e) => e.includes("重复"))).toBe(true);
  });

  it("reasoningEffort: max 逐值透传（models[0] 物化该键）", () => {
    const yaml = VALID_YAML.replace("    timeout: 120000\n", "    timeout: 120000\n    reasoningEffort: max\n");
    const cfg = parseLoomConfig(yaml, "<t>", { env: ENV_OK });
    expect(cfg.models[0]?.reasoningEffort).toBe("max");
  });

  it("reasoningEffort 非法值 → fail-fast 且错误点名 models[0].reasoningEffort", () => {
    const yaml = VALID_YAML.replace("    timeout: 120000\n", "    timeout: 120000\n    reasoningEffort: turbo\n");
    const errs = errorsOf(() => parseLoomConfig(yaml, "<t>", { env: ENV_OK }));
    expect(errs.some((e) => e.includes("models[0].reasoningEffort"))).toBe(true);
  });

  it("T4 reasoningContentReplay: true/false 逐值透传，缺席不物化", () => {
    for (const value of ["true", "false"]) {
      const yaml = VALID_YAML.replace(
        "    timeout: 120000\n",
        `    timeout: 120000\n    reasoningContentReplay: ${value}\n`,
      );
      const cfg = parseLoomConfig(yaml, "<t>", { env: ENV_OK });
      expect(cfg.models[0]?.reasoningContentReplay).toBe(value === "true");
    }
    const absent = parseLoomConfig(VALID_YAML, "<t>", { env: ENV_OK });
    expect(absent.models[0]).not.toHaveProperty("reasoningContentReplay");
  });

  it("T4 reasoningContentReplay 非法值 → fail-fast 且错误点名 models[0].reasoningContentReplay", () => {
    const yaml = VALID_YAML.replace(
      "    timeout: 120000\n",
      '    timeout: 120000\n    reasoningContentReplay: "yes"\n',
    );
    const errs = errorsOf(() => parseLoomConfig(yaml, "<t>", { env: ENV_OK }));
    expect(errs.some((e) => e.includes("models[0].reasoningContentReplay"))).toBe(true);
  });
});

describe("parseLoomConfig / credentials 凭据铁律", () => {
  it("拒绝疑似内联密钥字面量（长度>12 且非 ${} 包裹），且错误信息不回显密钥", () => {
    const bad = VALID_YAML.replace(
      "credentials:\n  eflowcode: ${LOOM_KEY_EFLOWCODE}",
      "credentials:\n  eflowcode: sk-abcdefghijklmnopqrstuvwxyz",
    );
    const secret = "sk-abcdefghijklmnopqrstuvwxyz";
    const errs = errorsOf(() => parseLoomConfig(bad, "<t>", { env: ENV_OK }));
    expect(errs.some((e) => e.includes("credentials.eflowcode") && e.includes("疑似内联密钥"))).toBe(true);
    // 密钥值绝不出现在任何错误文本中（防泄入日志/context）。
    expect(errs.join("\n")).not.toContain(secret);
  });

  it("拒绝未解析的 ${VAR}（env 中无值 → fail-fast）", () => {
    const errs = errorsOf(() =>
      parseLoomConfig(VALID_YAML, "<t>", { env: {} }),
    );
    expect(errs.some((e) => e.includes("LOOM_KEY_EFLOWCODE") && e.includes("无值"))).toBe(true);
  });

  it("拒绝空字符串的 env 值（等同未解析）", () => {
    const errs = errorsOf(() =>
      parseLoomConfig(VALID_YAML, "<t>", { env: { LOOM_KEY_EFLOWCODE: "" } }),
    );
    expect(errs.some((e) => e.includes("无值"))).toBe(true);
  });

  it("拒绝非 ${} 形式的短值（此段不存在合法字面量）", () => {
    const bad = VALID_YAML.replace(
      "credentials:\n  eflowcode: ${LOOM_KEY_EFLOWCODE}",
      "credentials:\n  eflowcode: plaintext",
    );
    const errs = errorsOf(() => parseLoomConfig(bad, "<t>", { env: ENV_OK }));
    expect(errs.some((e) => e.includes("credentials.eflowcode") && e.includes("不是"))).toBe(true);
  });

  it("拒绝部分包裹形式（前后有杂字）", () => {
    const bad = VALID_YAML.replace(
      "credentials:\n  eflowcode: ${LOOM_KEY_EFLOWCODE}",
      "credentials:\n  eflowcode: bearer ${LOOM_KEY_EFLOWCODE}",
    );
    const errs = errorsOf(() => parseLoomConfig(bad, "<t>", { env: ENV_OK }));
    expect(errs.some((e) => e.includes("credentials.eflowcode"))).toBe(true);
  });
});

describe("parseLoomConfig / 汇总与结构错误", () => {
  it("一次收集全部错误而非首个即停", () => {
    const bad = "server:\n  port: 1\nworkspace: ''\ncredentials:\n  a: sk-this-is-a-literal-secret\n";
    const errs = errorsOf(() => parseLoomConfig(bad, "<t>"));
    expect(errs.length).toBeGreaterThanOrEqual(3);
  });

  it("拒绝非法 YAML 与非映射顶层", () => {
    expect(errorsOf(() => parseLoomConfig("a: [1,\n", "<t>"))[0]).toContain("YAML 解析失败");
    expect(errorsOf(() => parseLoomConfig("- 1\n- 2\n", "<t>"))[0]).toContain("顶层需要映射");
  });
});

describe("loadLoomConfig / 文件入口", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "loom-cfg-"));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("从文件加载合法配置", () => {
    const path = join(dir, "loom.yaml");
    writeFileSync(path, VALID_YAML, "utf8");
    const cfg = loadLoomConfig(path, ENV_OK);
    expect(cfg.credentials["eflowcode"]?.envRef).toBe("LOOM_KEY_EFLOWCODE");
  });

  it("文件不存在时报读取错误", () => {
    const errs = errorsOf(() => loadLoomConfig(join(dir, "missing.yaml"), ENV_OK));
    expect(errs[0]).toContain("无法读取配置文件");
  });

  it("默认 env 走 process.env", () => {
    process.env["LOOM_KEY_TEST_DEFAULT_ENV"] = "resolved-from-process";
    try {
      const yaml = "server:\n  port: 5097\n  hostname: h\nworkspace: /w\nmodels:\n  - id: a\n    provider: b\n    contextWindow: 10\n    maxOutput: 5\n    timeout: 1\ncredentials:\n  k: ${LOOM_KEY_TEST_DEFAULT_ENV}\n";
      const cfg = parseLoomConfig(yaml, "<t>");
      expect(cfg.credentials["k"]?.value).toBe("resolved-from-process");
    } finally {
      delete process.env["LOOM_KEY_TEST_DEFAULT_ENV"];
    }
  });
});

describe("parseLoomConfig / providers 端点段 + models[].baseUrl（T39 前置接线）", () => {
  it("providers 段缺省 → 空表；models[].baseUrl 缺省 → undefined", () => {
    const cfg = parseLoomConfig(VALID_YAML, "<test>", { env: ENV_OK });
    expect(cfg.providers).toEqual({});
    expect(cfg.models[0]?.baseUrl).toBeUndefined();
  });

  it("providers[] 解析为 provider→端点查表（apiKey 缺省不物化）", () => {
    const yaml = VALID_YAML.replace(
      "models:",
      'providers:\n  - provider: eflowcode\n    baseUrl: https://e-flowcode.cc/v1\n\nmodels:',
    );
    const cfg = parseLoomConfig(yaml, "<test>", { env: ENV_OK });
    expect(cfg.providers["eflowcode"]).toEqual({
      provider: "eflowcode",
      baseUrl: "https://e-flowcode.cc/v1",
    });
  });

  it("providers[].apiKey 在场 → 原样解析进该 provider 端点", () => {
    const inline = "sk-inline-provider-canary-4f7a";
    const yaml = VALID_YAML.replace(
      "models:",
      "providers:\n  - provider: eflowcode\n    baseUrl: https://e-flowcode.cc/v1\n" +
        `    apiKey: ${inline}\n\nmodels:`,
    );
    const cfg = parseLoomConfig(yaml, "<test>", { env: ENV_OK });
    expect(cfg.providers["eflowcode"]).toEqual({
      provider: "eflowcode",
      baseUrl: "https://e-flowcode.cc/v1",
      apiKey: inline,
    });
  });

  it("providers[].apiKey 非字符串 → 校验错误点名字段且不回显值", () => {
    const canary = "98765432109876543210";
    const yaml = VALID_YAML.replace(
      "models:",
      `providers:\n  - provider: eflowcode\n    baseUrl: https://e-flowcode.cc/v1\n    apiKey: ${canary}\n\nmodels:`,
    );
    const errs = errorsOf(() => parseLoomConfig(yaml, "<test>", { env: ENV_OK }));
    expect(errs.some((e) => e.includes("providers[0].apiKey") && e.includes("字符串"))).toBe(true);
    expect(errs.join("\n")).not.toContain(canary);
  });

  it("providers[].apiKey 空串/纯空白 → 校验错误（省略该键才是回退）", () => {
    for (const raw of ['""', '"   "']) {
      const yaml = VALID_YAML.replace(
        "models:",
        "providers:\n  - provider: eflowcode\n    baseUrl: https://e-flowcode.cc/v1\n" +
          `    apiKey: ${raw}\n\nmodels:`,
      );
      const errs = errorsOf(() => parseLoomConfig(yaml, "<test>", { env: ENV_OK }));
      expect(errs.some((e) => e.includes("providers[0].apiKey") && e.includes("不能为空")))
        .toBe(true);
    }
  });

  it("models[].baseUrl 显式给定（model 级覆盖值可读取）", () => {
    const yaml = VALID_YAML.replace(
      "    timeout: 120000\n",
      "    timeout: 120000\n    baseUrl: https://alt.example/v1\n",
    );
    const cfg = parseLoomConfig(yaml, "<test>", { env: ENV_OK });
    expect(cfg.models[0]?.baseUrl).toBe("https://alt.example/v1");
  });

  it("providers 条目缺 baseUrl → 校验错误；provider 重复 → 校验错误", () => {
    const base = [
      "server:",
      "  port: 5097",
      "  hostname: h",
      "workspace: /w",
      "models:",
      "  - id: a",
      "    provider: eflowcode",
      "    contextWindow: 10",
      "    maxOutput: 5",
      "    timeout: 1",
      "pricing:",
      "  eflowcode:",
      "    input: 0",
      "    output: 0",
      "credentials:",
      "  eflowcode: ${LOOM_KEY_EFLOWCODE}",
    ].join("\n");
    const noUrl = `${base}\nproviders:\n  - provider: eflowcode\n`;
    expect(errorsOf(() => parseLoomConfig(noUrl, "<t>", { env: ENV_OK }))
      .some((e) => e.includes("providers[0].baseUrl"))).toBe(true);
    const dup = `${base}\nproviders:\n  - provider: eflowcode\n    baseUrl: https://a/v1\n  - provider: eflowcode\n    baseUrl: https://b/v1\n`;
    const dupErrs = errorsOf(() => parseLoomConfig(dup, "<t>", { env: ENV_OK }));
    expect(dupErrs.some((e) => e.includes("providers[1].provider") && e.includes("重复"))).toBe(true);
  });
});

// W4 bash.shell 节（指定 shell 程序，含完整路径——win32 git bash 用法族）。
describe("parseLoomConfig / bash 段", () => {
  const base = [
    "server:",
    "  port: 5097",
    "  hostname: h",
    "workspace: /w",
    "models:",
    "  - id: a",
    "    provider: eflowcode",
    "    contextWindow: 10",
    "    maxOutput: 5",
    "    timeout: 1",
    "credentials:",
    "  eflowcode: ${LOOM_KEY_EFLOWCODE}",
  ].join("\n");

  it("合法：program+args 直取（win32 git bash 形状）；缺省段=undefined；bash:{} 合法；shell 缺 program 拒", () => {
    const gb = `${base}\nbash:\n  shell:\n    program: "C:\\\\Program Files\\\\Git\\\\bin\\\\bash.exe"\n    args: ["--login", "-c"]\n`;
    const cfg = parseLoomConfig(gb, "<t>", { env: ENV_OK });
    expect(cfg.bash).toEqual({
      shell: { program: "C:\\Program Files\\Git\\bin\\bash.exe", args: ["--login", "-c"] },
    });

    expect(parseLoomConfig(base, "<t>", { env: ENV_OK }).bash).toBeUndefined();
    expect(parseLoomConfig(`${base}\nbash: {}\n`, "<t>", { env: ENV_OK }).bash).toEqual({});

    const noProg = `${base}\nbash:\n  shell:\n    args: ["-c"]\n`;
    expect(errorsOf(() => parseLoomConfig(noProg, "<t>", { env: ENV_OK }))
      .some((e) => e.includes("bash.shell.program"))).toBe(true);
  });

  it("坏形状全拒：bash 非映射 / shell 非映射 / args 非数组 / args 混入非字符串 / program 空串", () => {
    const cases = [
      [`${base}\nbash: "x"\n`, "bash: 需要映射"],
      [`${base}\nbash:\n  shell: "x"\n`, "bash.shell: 需要映射"],
      [`${base}\nbash:\n  shell:\n    program: /bin/bash\n    args: "-c"\n`, "bash.shell.args: 需要字符串数组"],
      [`${base}\nbash:\n  shell:\n    program: /bin/bash\n    args: [1]\n`, "bash.shell.args[0]"],
      [`${base}\nbash:\n  shell:\n    program: ""\n`, "bash.shell.program"],
    ] as const;
    for (const [yaml, want] of cases) {
      expect(errorsOf(() => parseLoomConfig(yaml, "<t>", { env: ENV_OK }))
        .some((e) => e.includes(want)), `应报 ${want}`).toBe(true);
    }
  });

  it("args 空串是合法 argv（校验从宽、拼装如实）", () => {
    const yaml = `${base}\nbash:\n  shell:\n    program: /bin/bash\n    args: ["-c", ""]\n`;
    const cfg = parseLoomConfig(yaml, "<t>", { env: ENV_OK });
    expect(cfg.bash?.shell?.args).toEqual(["-c", ""]);
  });
});

// W49-C 上下文压缩接线的第一片：新顶层 compaction 段（undefined-honest 四态：
// 缺席/在场禁用/在场最小/在场全量）。enabled 段在场时必填布尔；其余键全可选、
// 键缺席=不物化——缺省收敛在 core 插件构造时刻 ??（triggerRatio 0.8 / keepRecent 6 /
// resummarizeEvery=keepRecent / summaryTimeoutMs 60000 日志面重述）与 wiring 层
// （缺席段=零 hook 注册，G6 逐字节对照面）。W42c 四件套复刻：checkCompaction+条件展开+
// 示例块+boot 日志面。值域按 W49.7 memo Q1(i)：maxContextTokens ≥1000（显式预算破
// T2 的 1M 窗不可达）、triggerRatio ∈ (0,1]、keepRecent/resummarizeEvery ≥1、
// summaryTimeoutMs ≥1000（T1：pipe 缺省 500ms 会静默杀 summarize）。
describe("parseLoomConfig / compaction 段（W49-C 压缩配置四态）", () => {
  it("compaction 键缺席 = undefined 不物化（LoomConfig 不含该键 = 零 hook 注册面）", () => {
    const cfg = parseLoomConfig(VALID_YAML, "<t>", { env: ENV_OK });
    expect(cfg.compaction).toBeUndefined();
    expect(Object.hasOwn(cfg, "compaction")).toBe(false);
  });

  it("生产全量声明逐值透传（W49.7 memo Q1(i) 形状）", () => {
    const yaml = VALID_YAML + [
      "",
      "compaction:",
      "  enabled: true",
      "  maxContextTokens: 250000",
      "  triggerRatio: 0.8",
      "  keepRecent: 8",
      "  resummarizeEvery: 16",
      "  summaryTimeoutMs: 60000",
      "  boundary: false",
      "  microcompact:",
      "    enabled: true",
      "    triggerTokens: 150000",
      "    targetTokens: 60000",
      "    keepRecent: 5",
      "    compactableTools: [read, grep, bash]",
      "",
    ].join("\n");
    const cfg = parseLoomConfig(yaml, "<t>", { env: ENV_OK });
    expect(cfg.compaction).toEqual({
      enabled: true,
      maxContextTokens: 250000,
      triggerRatio: 0.8,
      keepRecent: 8,
      resummarizeEvery: 16,
      summaryTimeoutMs: 60000,
      boundary: false,
      microcompact: {
        enabled: true,
        triggerTokens: 150000,
        targetTokens: 60000,
        keepRecent: 5,
        compactableTools: ["read", "grep", "bash"],
      },
    });
  });

  it("compaction.stream 节流参数逐值透传", () => {
    const yaml = VALID_YAML + [
      "",
      "compaction:",
      "  enabled: true",
      "  stream:",
      "    flushIntervalMs: 25",
      "    flushMaxBytes: 2048",
      "",
    ].join("\n");
    const cfg = parseLoomConfig(yaml, "<t>", { env: ENV_OK });
    expect(cfg.compaction?.stream).toEqual({ flushIntervalMs: 25, flushMaxBytes: 2048 });
  });

  it("在场最小 enabled:true，其余键缺席不物化（core 插件 ?? 兜缺省面）", () => {
    const cfg = parseLoomConfig(VALID_YAML + "\ncompaction:\n  enabled: true\n", "<t>", { env: ENV_OK });
    expect(cfg.compaction).toEqual({ enabled: true });
  });

  it("在场禁用 enabled:false 合法（wiring 层零注册，日志面 source=declared）", () => {
    const cfg = parseLoomConfig(VALID_YAML + "\ncompaction:\n  enabled: false\n", "<t>", { env: ENV_OK });
    expect(cfg.compaction).toEqual({ enabled: false });
  });

  it("enabled 缺失/非布尔 fail-fast 点名 compaction.enabled（段在场必填，布尔判别与他键不同族）", () => {
    const noKey = errorsOf(() => parseLoomConfig(VALID_YAML + "\ncompaction:\n  keepRecent: 8\n", "<t>", { env: ENV_OK }));
    expect(noKey.some((e) => e.includes("compaction.enabled") && e.includes("布尔"))).toBe(true);
    const emptySeg = errorsOf(() => parseLoomConfig(VALID_YAML + "\ncompaction: {}\n", "<t>", { env: ENV_OK }));
    expect(emptySeg.some((e) => e.includes("compaction.enabled"))).toBe(true);
    for (const bad of ['"yes"', "1"]) {
      const errs = errorsOf(() => parseLoomConfig(VALID_YAML + `\ncompaction:\n  enabled: ${bad}\n`, "<t>", { env: ENV_OK }));
      expect(errs.some((e) => e.includes("compaction.enabled") && e.includes("布尔")), `应拒 enabled: ${bad}`).toBe(true);
    }
  });

  it("summaryChunkTokens 合法值透传（W52 分块摘要块大小）", () => {
    const cfg = parseLoomConfig(
      VALID_YAML + "\ncompaction:\n  enabled: true\n  summaryChunkTokens: 120000\n",
      "<t>",
      { env: ENV_OK },
    );
    expect(cfg.compaction).toEqual({ enabled: true, summaryChunkTokens: 120000 });
  });

  it("keepRecentTokens 合法值透传（recent tail token 预算，15000 = server 接线缺省）", () => {
    const cfg = parseLoomConfig(
      VALID_YAML + "\ncompaction:\n  enabled: true\n  keepRecentTokens: 15000\n",
      "<t>",
      { env: ENV_OK },
    );
    expect(cfg.compaction).toEqual({ enabled: true, keepRecentTokens: 15000 });
  });

  it("fallbackTokens/requestTimeoutMs/retryCount 合法值透传（W57 worker 接线）", () => {
    const cfg = parseLoomConfig(
      VALID_YAML +
        "\ncompaction:\n  enabled: true\n  fallbackTokens: 750000\n  requestTimeoutMs: 300000\n  retryCount: 10\n",
      "<t>",
      { env: ENV_OK },
    );
    expect(cfg.compaction).toEqual({
      enabled: true,
      fallbackTokens: 750000,
      requestTimeoutMs: 300000,
      retryCount: 10,
    });
  });

  it("fallbackTokens/requestTimeoutMs/retryCount 越界 fail-fast 点名键名", () => {
    const cases: readonly [string, string][] = [
      ["fallbackTokens", "999"],
      ["requestTimeoutMs", "999"],
      ["retryCount", "-1"],
    ];
    for (const [key, bad] of cases) {
      const errs = errorsOf(() =>
        parseLoomConfig(
          VALID_YAML + `\ncompaction:\n  enabled: true\n  ${key}: ${bad}\n`,
          "<t>",
          { env: ENV_OK },
        ),
      );
      expect(
        errs.some((e) => e.includes(`compaction.${key}`) && e.includes("需要")),
        `应拒 ${key}: ${bad}`,
      ).toBe(true);
    }
  });

  it("watermark.levels 合法值透传（W57 P3 水位档位）", () => {
    const cfg = parseLoomConfig(
      VALID_YAML +
        "\ncompaction:\n  enabled: true\n  fallbackTokens: 750000\n  watermark:\n    levels: [300000, 500000, 600000]\n",
      "<t>",
      { env: ENV_OK },
    );
    expect(cfg.compaction).toEqual({
      enabled: true,
      fallbackTokens: 750000,
      watermark: { levels: [300000, 500000, 600000] },
    });
  });

  it("watermark 无 fallbackTokens fail-fast 点名两键", () => {
    const errs = errorsOf(() =>
      parseLoomConfig(
        VALID_YAML + "\ncompaction:\n  enabled: true\n  watermark:\n    levels: [300000]\n",
        "<t>",
        { env: ENV_OK },
      ),
    );
    expect(
      errs.some((e) => e.includes("compaction.watermark") && e.includes("fallbackTokens")),
    ).toBe(true);
  });

  it("watermark.levels 非递增/超兜底/低于下界/非数组 fail-fast 点名键名", () => {
    const cases: ReadonlyArray<{ levels: string; needle: string }> = [
      { levels: "[300000, 300000]", needle: "严格递增" },
      { levels: "[800000]", needle: "小于" },
      { levels: "[999]", needle: "1000" },
      { levels: '"x"', needle: "整数数组" },
      { levels: "[]", needle: "非空" },
    ];
    for (const { levels, needle } of cases) {
      const errs = errorsOf(() =>
        parseLoomConfig(
          VALID_YAML +
            `\ncompaction:\n  enabled: true\n  fallbackTokens: 750000\n  watermark:\n    levels: ${levels}\n`,
          "<t>",
          { env: ENV_OK },
        ),
      );
      expect(
        errs.some((e) => e.includes("compaction.watermark.levels") && e.includes(needle)),
        `应拒 levels: ${levels}`,
      ).toBe(true);
    }
  });

  it("watermark.levels 合法值透传（必须与 fallbackTokens 同时声明）", () => {
    const cfg = parseLoomConfig(
      VALID_YAML +
        "\ncompaction:\n  enabled: true\n  fallbackTokens: 750000\n  watermark:\n    levels: [300000, 500000, 600000]\n",
      "<t>",
      { env: ENV_OK },
    );
    expect(cfg.compaction).toEqual({
      enabled: true,
      fallbackTokens: 750000,
      watermark: { levels: [300000, 500000, 600000] },
    });
  });

  it("watermark.levels 缺 fallback / 非递增 / 越界 fail-fast 点名 compaction.watermark", () => {
    const cases: readonly string[] = [
      "\ncompaction:\n  enabled: true\n  watermark:\n    levels: [300000]\n",
      "\ncompaction:\n  enabled: true\n  fallbackTokens: 750000\n  watermark:\n    levels: [500000, 300000]\n",
      "\ncompaction:\n  enabled: true\n  fallbackTokens: 750000\n  watermark:\n    levels: [750000]\n",
    ];
    for (const block of cases) {
      const errs = errorsOf(() =>
        parseLoomConfig(VALID_YAML + block, "<t>", { env: ENV_OK }),
      );
      expect(
        errs.some((e) => e.includes("compaction.watermark")),
        `应拒 watermark block: ${block}`,
      ).toBe(true);
    }
  });

  it("keepRecentTokens 越界/类型炸 fail-fast 点名 compaction.keepRecentTokens（-1 与非数字）", () => {
    for (const bad of ["-1", '"x"']) {
      const errs = errorsOf(() =>
        parseLoomConfig(
          VALID_YAML + `\ncompaction:\n  enabled: true\n  keepRecentTokens: ${bad}\n`,
          "<t>",
          { env: ENV_OK },
        ),
      );
      expect(
        errs.some((e) => e.includes("compaction.keepRecentTokens") && e.includes("需要")),
        `应拒 keepRecentTokens: ${bad}`,
      ).toBe(true);
    }
  });

  it("越界/类型炸 fail-fast 点名键名（maxContextTokens 999、triggerRatio 0/1.5、keepRecent 0、resummarizeEvery 0、summaryTimeoutMs 999、boundary 非布尔）", () => {
    const cases: readonly [string, string][] = [
      ["maxContextTokens", "999"],
      ["maxContextTokens", '"x"'],
      ["triggerRatio", "0"],
      ["triggerRatio", "1.5"],
      ["keepRecent", "0"],
      ["resummarizeEvery", "0"],
      ["summaryTimeoutMs", "999"],
      ["summaryChunkTokens", "999"],
      ["summaryChunkTokens", '"x"'],
      ["boundary", '"yes"'],
    ];
    for (const [key, bad] of cases) {
      const yaml = VALID_YAML + `\ncompaction:\n  enabled: true\n  ${key}: ${bad}\n`;
      const errs = errorsOf(() => parseLoomConfig(yaml, "<t>", { env: ENV_OK }));
      expect(
        errs.some((e) => e.includes(`compaction.${key}`) && e.includes("需要")),
        `应拒 ${key}: ${bad}`,
      ).toBe(true);
    }
  });

  it("边界合法值收口（triggerRatio 1=上闭区间合法、maxContextTokens 1000、summaryTimeoutMs 1000）", () => {
    const cfg = parseLoomConfig(
      VALID_YAML + "\ncompaction:\n  enabled: true\n  triggerRatio: 1\n  maxContextTokens: 1000\n  summaryTimeoutMs: 1000\n",
      "<t>",
      { env: ENV_OK },
    );
    expect(cfg.compaction).toEqual({ enabled: true, triggerRatio: 1, maxContextTokens: 1000, summaryTimeoutMs: 1000 });
  });

  it("microcompact 子对象在场且未显式禁用时 triggerTokens 必填（≥1 整数，无诚实缺省可兜）", () => {
    const errs = errorsOf(() =>
      parseLoomConfig(VALID_YAML + "\ncompaction:\n  enabled: true\n  microcompact:\n    targetTokens: 300\n", "<t>", { env: ENV_OK }),
    );
    expect(
      errs.some((e) => e.includes("compaction.microcompact.triggerTokens") && e.includes("需要")),
    ).toBe(true);
    // 显式禁用则 triggerTokens 缺席合法（零注册意图不造假阈值）
    const cfg = parseLoomConfig(
      VALID_YAML + "\ncompaction:\n  enabled: true\n  microcompact:\n    enabled: false\n",
      "<t>",
      { env: ENV_OK },
    );
    expect(cfg.compaction).toEqual({ enabled: true, microcompact: { enabled: false } });
  });

  it("microcompact 子对象越界/形状炸点名（triggerTokens 0、targetTokens>triggerTokens、compactableTools 混入非字符串）", () => {
    const t0 = errorsOf(() =>
      parseLoomConfig(VALID_YAML + "\ncompaction:\n  enabled: true\n  microcompact:\n    triggerTokens: 0\n", "<t>", { env: ENV_OK }),
    );
    expect(t0.some((e) => e.includes("compaction.microcompact.triggerTokens"))).toBe(true);
    const over = errorsOf(() =>
      parseLoomConfig(
        VALID_YAML + "\ncompaction:\n  enabled: true\n  microcompact:\n    triggerTokens: 100\n    targetTokens: 101\n",
        "<t>",
        { env: ENV_OK },
      ),
    );
    expect(
      over.some((e) => e.includes("compaction.microcompact.targetTokens") && e.includes("triggerTokens")),
    ).toBe(true);
    const mixed = errorsOf(() =>
      parseLoomConfig(
        VALID_YAML + "\ncompaction:\n  enabled: true\n  microcompact:\n    triggerTokens: 100\n    compactableTools: [read, 2]\n",
        "<t>",
        { env: ENV_OK },
      ),
    );
    expect(mixed.some((e) => e.includes("compaction.microcompact.compactableTools[1]"))).toBe(true);
  });

  it("compaction 非映射拒（需要映射）；microcompact 非映射拒（compaction.microcompact: 需要映射）", () => {
    const errs = errorsOf(() => parseLoomConfig(VALID_YAML + '\ncompaction: "x"\n', "<t>", { env: ENV_OK }));
    expect(errs.some((e) => e.includes("compaction") && e.includes("需要映射"))).toBe(true);
    const sub = errorsOf(() =>
      parseLoomConfig(VALID_YAML + "\ncompaction:\n  enabled: true\n  microcompact: 7\n", "<t>", { env: ENV_OK }),
    );
    expect(sub.some((e) => e.includes("compaction.microcompact") && e.includes("需要映射"))).toBe(true);
  });

  it("boundary:true 显式物化（C.2 flag 默认缺席=OFF，声明才真）", () => {
    const cfg = parseLoomConfig(VALID_YAML + "\ncompaction:\n  enabled: true\n  boundary: true\n", "<t>", { env: ENV_OK });
    expect(cfg.compaction).toEqual({ enabled: true, boundary: true });
  });

  it("sim tiny 形状全量合法（W49.7 memo Q1(ii)：maxContextTokens 1000+micro 全键）", () => {
    const yaml = VALID_YAML + [
      "",
      "compaction:",
      "  enabled: true",
      "  maxContextTokens: 1000",
      "  triggerRatio: 0.8",
      "  keepRecent: 4",
      "  resummarizeEvery: 4",
      "  summaryTimeoutMs: 10000",
      "  microcompact:",
      "    enabled: true",
      "    triggerTokens: 600",
      "    targetTokens: 300",
      "    keepRecent: 2",
      "    compactableTools: [read]",
      "",
    ].join("\n");
    const cfg = parseLoomConfig(yaml, "<t>", { env: ENV_OK });
    expect(cfg.compaction?.microcompact?.compactableTools).toEqual(["read"]);
    expect(cfg.compaction?.resummarizeEvery).toBe(4);
  });

  it("summaryMode/summaryReasoningEffort/singleCallBudgetTokens 合法值逐值透传（单次调用摘要接线）", () => {
    const cfg = parseLoomConfig(
      VALID_YAML + [
        "",
        "compaction:",
        "  enabled: true",
        "  summaryMode: single",
        "  summaryReasoningEffort: high",
        "  singleCallBudgetTokens: 500000",
        "",
      ].join("\n"),
      "<t>",
      { env: ENV_OK },
    );
    expect(cfg.compaction).toEqual({
      enabled: true,
      summaryMode: "single",
      summaryReasoningEffort: "high",
      singleCallBudgetTokens: 500000,
    });
    for (const mode of ["auto", "single", "chunked"] as const) {
      const each = parseLoomConfig(
        VALID_YAML + `\ncompaction:\n  enabled: true\n  summaryMode: ${mode}\n`,
        "<t>",
        { env: ENV_OK },
      );
      expect(each.compaction?.summaryMode).toBe(mode);
    }
  });

  it("summaryMode/summaryReasoningEffort/singleCallBudgetTokens 非法值 fail-fast 点名键名", () => {
    const cases: readonly [string, string][] = [
      ["summaryMode", "full"],
      ["summaryMode", "2"],
      ["summaryReasoningEffort", "ultra"],
      ["summaryReasoningEffort", "1"],
      ["singleCallBudgetTokens", "999"],
      ["singleCallBudgetTokens", '"x"'],
    ];
    for (const [key, bad] of cases) {
      const errs = errorsOf(() =>
        parseLoomConfig(
          VALID_YAML + `\ncompaction:\n  enabled: true\n  ${key}: ${bad}\n`,
          "<t>",
          { env: ENV_OK },
        ),
      );
      expect(
        errs.some((e) => e.includes(`compaction.${key}`) && e.includes("需要")),
        `应拒 ${key}: ${bad}`,
      ).toBe(true);
    }
  });

  it("summary 三键缺席保持不物化（undefined-honest，不造假缺省）", () => {
    const cfg = parseLoomConfig(
      VALID_YAML + "\ncompaction:\n  enabled: true\n",
      "<t>",
      { env: ENV_OK },
    );
    expect(cfg.compaction).toEqual({ enabled: true });
    for (const key of ["summaryMode", "summaryReasoningEffort", "singleCallBudgetTokens"]) {
      expect(Object.hasOwn(cfg.compaction as object, key), key).toBe(false);
    }
  });

  it("summaryPerspectives 合法值透传（ops 基线 + chat 视角，顺序不敏感）", () => {
    const cases = [["ops"], ["ops", "chat"], ["chat", "ops"]] as const;
    for (const perspectives of cases) {
      const cfg = parseLoomConfig(
        VALID_YAML +
          `\ncompaction:\n  enabled: true\n  fallbackTokens: 750000\n  summaryPerspectives: [${perspectives.join(", ")}]\n`,
        "<t>",
        { env: ENV_OK },
      );
      expect(cfg.compaction?.summaryPerspectives, perspectives.join(",")).toEqual(perspectives);
    }
  });

  it("summaryPerspectives 非法形态 fail-fast 点名键（空/重复/未知/缺 ops/非数组）", () => {
    const cases: ReadonlyArray<{ value: string; needle: string }> = [
      { value: "[]", needle: "非空" },
      { value: "[ops, ops]", needle: "重复" },
      { value: "[ops, bogus]", needle: '"ops" 或 "chat"' },
      { value: "[chat]", needle: '包含 "ops"' },
      { value: '"ops"', needle: "数组" },
    ];
    for (const { value, needle } of cases) {
      const errs = errorsOf(() =>
        parseLoomConfig(
          VALID_YAML +
            `\ncompaction:\n  enabled: true\n  fallbackTokens: 750000\n  summaryPerspectives: ${value}\n`,
          "<t>",
          { env: ENV_OK },
        ),
      );
      expect(
        errs.some((e) => e.includes("compaction.summaryPerspectives") && e.includes(needle)),
        `应拒 summaryPerspectives: ${value}`,
      ).toBe(true);
    }
  });

  it("summaryPerspectives 无 fallbackTokens fail-fast 点名两键（legacy 单摘要路径不读此键）", () => {
    const errs = errorsOf(() =>
      parseLoomConfig(
        VALID_YAML + "\ncompaction:\n  enabled: true\n  summaryPerspectives: [ops, chat]\n",
        "<t>",
        { env: ENV_OK },
      ),
    );
    expect(
      errs.some(
        (e) =>
          e.includes("compaction.summaryPerspectives") &&
          e.includes("compaction.fallbackTokens"),
      ),
    ).toBe(true);
  });

  it("summaryPerspectives 缺席不物化（缺省在 wiring 层收敛，schema 不造假值）", () => {
    const cfg = parseLoomConfig(
      VALID_YAML + "\ncompaction:\n  enabled: true\n  fallbackTokens: 750000\n",
      "<t>",
      { env: ENV_OK },
    );
    expect(Object.hasOwn(cfg.compaction as object, "summaryPerspectives")).toBe(false);
  });
});

// pty 段：三键全可选，缺席不物化；上限为整数 ≥1 的运维闸。
describe("parseLoomConfig / pty 段（交互式终端工具配置）", () => {
  it("pty 键缺席 = undefined 不物化（undefined-honest）", () => {
    const cfg = parseLoomConfig(VALID_YAML, "<t>", { env: ENV_OK });
    expect(cfg.pty).toBeUndefined();
    expect("pty" in cfg).toBe(false);
  });

  it("pty 显式声明逐值透传（enabled/maxSessionsPerLoomSession/maxSessionsTotal）", () => {
    const yaml = VALID_YAML +
      "\npty:\n  enabled: false\n  maxSessionsPerLoomSession: 4\n  maxSessionsTotal: 8\n";
    const cfg = parseLoomConfig(yaml, "<t>", { env: ENV_OK });
    expect(cfg.pty).toEqual({
      enabled: false,
      maxSessionsPerLoomSession: 4,
      maxSessionsTotal: 8,
    });
  });

  it("pty 空段 = 空对象（不造假缺省值）", () => {
    const cfg = parseLoomConfig(VALID_YAML + "\npty: {}\n", "<t>", { env: ENV_OK });
    expect(cfg.pty).toEqual({});
  });

  it("pty 非映射 → schema 错误（需要映射）", () => {
    const errs = errorsOf(() => parseLoomConfig(VALID_YAML + "\npty: 8\n", "<t>", { env: ENV_OK }));
    expect(errs.some((e) => e.includes("pty") && e.includes("需要映射"))).toBe(true);
  });

  it("pty.enabled 非布尔 → 聚合报错且键不物化（undefined-honest）", () => {
    const errs = errorsOf(() =>
      parseLoomConfig(VALID_YAML + '\npty:\n  enabled: "yes"\n', "<t>", { env: ENV_OK }),
    );
    expect(errs.some((e) => e.includes("pty.enabled") && e.includes("需要布尔值"))).toBe(true);
    const checkErrors: string[] = [];
    const checked = checkPty({ enabled: "yes" }, checkErrors);
    expect(checked).toEqual({});
    expect(checkErrors).toHaveLength(1);
  });

  it("pty 两上限为零/负数/非整数 → 各自点名报错且键不物化", () => {
    for (const field of ["maxSessionsPerLoomSession", "maxSessionsTotal"]) {
      for (const bad of ["0", "-1", "1.5", '"4"']) {
        const errs = errorsOf(() =>
          parseLoomConfig(VALID_YAML + `\npty:\n  ${field}: ${bad}\n`, "<t>", { env: ENV_OK }),
        );
        expect(errs.some((e) => e.includes(`pty.${field}`) && e.includes("需要"))).toBe(true);
      }
    }
    const checkErrors: string[] = [];
    const checked = checkPty({ maxSessionsPerLoomSession: 0, maxSessionsTotal: -1 }, checkErrors);
    expect(checked).toEqual({});
    expect(checkErrors).toHaveLength(2);
  });

  it("pty 未知键被忽略（与既有 loader 口径一致）", () => {
    const cfg = parseLoomConfig(VALID_YAML + "\npty:\n  unknownKey: 1\n", "<t>", { env: ENV_OK });
    expect(cfg.pty).toEqual({});
  });
});
