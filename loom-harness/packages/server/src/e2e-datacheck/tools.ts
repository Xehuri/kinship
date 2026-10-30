/**
 * T34 金径场景工具装配（docs/02 §T34；决策 docs/01 D5/D7/D15/D16/D22/D23/D25/D26/D32）。
 *
 * 一句话职责：把「真件」接成副会话可用的工具集——
 *   - tools 七件套真件：createReadTool/createWriteTool（路径咽喉 resolveToolPath，工作区外一律拒）；
 *   - seam 真件：ToolExecutor（D7 单缝，default-deny 权限 + 沙箱断言 + 审计），bash 工具经
 *     asBashOperations 接线（render_commit_body 真跑 python3 走这里）；
 *   - script-host 真件：check_data 工具每次调用起真 ScriptHost 挂载 data_check.py，
 *     真 python3 子进程按 T16 协议发 fact 事件后干净退出（respawn:false 不重拉）。
 * 红线：所有写落点 = 会话工作区（sandbox fixture-workspace 副本）内。
 */

import { join } from "node:path";
import { realpathSync } from "node:fs";

import { Type, type HarnessTool, type ToolExecResult } from "@axeuh/loom-core";
import { createBashTool, createReadTool, createWriteTool } from "@axeuh/loom-tools";
import { ToolExecutor, type SandboxProfile, type SeamAuditEvent } from "@axeuh/loom-tools/seam";
import { ScriptHost, type HostLogEntry } from "@axeuh/loom-tools/script-host";

/* ────────────── seam：D7 单缝装配（default-deny） ────────────── */

/** 数据检查工作流沙箱档案：只允许 python3 起子进程，破坏性/外联命令一律拒。 */
export function makeSeamProfile(): SandboxProfile {
  return {
    fs: { read: [], write: [] }, // v1 不额外限缩 glob；工作区包含断言兜底（bash 调用 paths=[]）
    net: "deny",
    cmd_allow: ["python3"],
    deny: ["git", "rm", "curl", "wget", "ssh", "nc"],
  };
}

export interface SeamWiring {
  readonly executor: ToolExecutor;
  readonly audit: SeamAuditEvent[];
}

/** 装配真缝：workspaceRoot=会话工作区 realpath；审计入数组供断言。 */
export function makeSeamExecutor(workspaceRoot: string): SeamWiring {
  const audit: SeamAuditEvent[] = [];
  const executor = new ToolExecutor({
    workspaceRoot: realpathSync(workspaceRoot),
    profile: makeSeamProfile(),
    scope: { agent: "data-checker", workflow: "data-check" },
    rules: [
      {
        name: "bash-python3",
        match: "bash",
        decision: "allow",
        reason: "T34 金径：render_commit_body 走 python3（cmd_allow 再收一道）",
      },
    ],
    // fallback 缺省 deny（default-deny，无规则命中即拒）
    audit: (event) => {
      audit.push(event);
    },
  });
  return { executor, audit };
}

/* ────────────── script-host：check_data 工具（真 python3 挂载） ────────────── */

/** data_check.py 的 fact 事件负载（T34 场景契约，脚本 stdout 逐行 JSON 协议）。 */
export interface CheckFact {
  readonly checked: number;
  readonly total: number;
  readonly ok: boolean;
  readonly line_count: number;
  readonly facts_file: string;
  readonly report_file: string;
}

function asNumber(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error(`check fact 负载字段 ${what} 非数值: ${JSON.stringify(v)}`);
  }
  return v;
}

function asString(v: unknown, what: string): string {
  if (typeof v !== "string" || v.trim() === "") {
    throw new Error(`check fact 负载字段 ${what} 非字符串: ${JSON.stringify(v)}`);
  }
  return v;
}

function toCheckFact(payload: Readonly<Record<string, unknown>>): CheckFact {
  return {
    checked: asNumber(payload["checked"], "checked"),
    total: asNumber(payload["total"], "total"),
    ok: payload["ok"] === true,
    line_count: asNumber(payload["line_count"], "line_count"),
    facts_file: asString(payload["facts_file"], "facts_file"),
    report_file: asString(payload["report_file"], "report_file"),
  };
}

/**
 * 真跑一次挂载检查：起 ScriptHost（scriptsDir=workspace/scripts）→ 等 fact 事件 → 关宿主。
 * ScriptHost 的 respawn:false + 干净退出（code 0）保证不重拉；finally 里 stop() 杀组防孤儿。
 */
export async function runMountedCheck(
  workspaceRoot: string,
  date: string,
  window: string,
  logs: HostLogEntry[],
  timeoutMs = 45_000,
): Promise<CheckFact> {
  const host = new ScriptHost({
    scriptsDir: join(workspaceRoot, "scripts"),
    env: {
      LOOM_E2E_WORKSPACE: workspaceRoot,
      LOOM_E2E_DATE: date,
      LOOM_E2E_WINDOW: window,
    },
    logger: (entry) => {
      logs.push(entry);
    },
  });
  try {
    let settle: ((f: CheckFact) => void) | undefined;
    const fact = new Promise<CheckFact>((resolve) => {
      settle = resolve;
    });
    host.onEvent((e) => {
      if (e.event.type === "fact" && e.event.payload["key"] === "check_report") {
        settle?.(toCheckFact(e.event.payload));
      }
    });
    host.start();
    const winner = await Promise.race([
      fact,
      new Promise<"timeout">((resolve) => {
        setTimeout(() => resolve("timeout"), timeoutMs).unref();
      }),
    ]);
    if (winner === "timeout") {
      throw new Error(`等待 data_check 挂载脚本 fact 事件超时（${timeoutMs}ms）`);
    }
    return winner;
  } finally {
    host.stop();
  }
}

/** 副会话工具集：read/write（tools 真件咽喉）+ bash（seam 真缝）+ check_data（script-host 真件）。 */
export function makeSessionTools(
  workspaceRoot: string,
  seam: SeamWiring,
  checkLogs: HostLogEntry[],
  checkFacts: CheckFact[],
): HarnessTool[] {
  const readTool = createReadTool(workspaceRoot);
  const writeTool = createWriteTool(workspaceRoot);
  const bashTool = createBashTool(workspaceRoot, {
    operations: seam.executor.asBashOperations(),
    defaultTimeout: 60,
  });
  const checkTool: HarnessTool = {
    name: "check_data",
    label: "数据检查",
    description:
      "经 script-host 挂载运行 data_check.py（真 python3 子进程）：从 perception.jsonl 机械转录" +
      "事实文件并统计 20 分钟槽位覆盖，返回 fact 事件负载 JSON。",
    parameters: Type.Object({
      date: Type.String({ description: "数据日期 YYYY-MM-DD" }),
      window: Type.String({ description: "批次窗口 HH:MM~HH:MM" }),
    }),
    isReadOnly: false,
    isDestructive: false,
    isOpenWorld: false,
    isConcurrencySafe: () => false,
    async execute(args, _ctx, signal): Promise<ToolExecResult> {
      if (signal?.aborted) throw new Error("aborted");
      const date = typeof args["date"] === "string" ? args["date"] : "";
      const window = typeof args["window"] === "string" ? args["window"] : "";
      if (date === "" || window === "") throw new Error("check_data 需要 date/window 参数");
      const fact = await runMountedCheck(workspaceRoot, date, window, checkLogs);
      checkFacts.push(fact);
      return {
        content: [{ type: "text", text: JSON.stringify(fact) }],
      };
    },
  };
  return [readTool, writeTool, bashTool, checkTool];
}
