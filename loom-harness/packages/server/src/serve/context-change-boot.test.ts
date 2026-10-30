/**
 * W16/W20 上下文变更嗅探 —— boot 端到端（真树装配、假模型零凭据，tmp workspace）。
 *
 * 场景叙事（单 it 一条链，水位推进/不重发天然串测）：
 *   boot → 基线轮（零变更，无 notice）→ AGENTS.md 追加一行 → 变更轮
 *   （W20：notice = unified 差异块——'@@' 头 + '+' 新行 + 少量上下文行，绝不搬全文；
 *    notice 先于本轮用户消息进 Context.messages；systemPrompt 字节跨轮全等
 *    = W15-B 冻结前缀再钉 + 追加内容绝不进 systemPrompt）→ touch 轮（同字节回写
 *    = 内容逐字相等 ⇒ 零新 notice，W20 touch-无变零发）→ 无变更轮（水位已推进 ⇒
 *    不重发，历史里那一条 notice 是持久 prelude 非重注入）→
 *   删除 AGENTS.md（W33 清单收缩后唯一钉件；remove 通道在单件清单上照常成立）→ 删除轮
 *   （remove notice）→
 *   二次 boot（同 stateRoot）→ 新会话首轮（水位以现盘重播 ⇒ 旧 diff 绝不重发）。
 *
 * 加载纪律同 boot-assembly.test.ts：boot 图必须动态 import（SSR 环解析实测）。
 */

import { mkdtempSync, mkdirSync, appendFileSync, rmSync, writeFileSync } from "node:fs";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FakeAssistantResponse } from "@axeuh/loom-core/testing";

import { parseLoomConfig, type LoomConfig } from "../config/loom-config.js";
import { HotConfigStore, createFileAuditSink } from "../hotreload/index.js";
import type { LoomFrame } from "../events/index.js";
import type { LoomApp } from "./boot.js";

type CreateLoomApp = typeof import("./boot.js").createLoomApp;
let createLoomApp!: CreateLoomApp;

let work = "";
let ws = "";
let stateRoot = "";

const FAKE_YAML = [
  "server:",
  "  port: 5103",
  "  hostname: 127.0.0.1",
  "workspace: WS_ROOT",
  "models:",
  "  - id: fake-w16",
  "    provider: fake",
  "    contextWindow: 200000",
  "    maxOutput: 4096",
  "    timeout: 60000",
  "pricing:",
  "  fake:",
  "    input: 0",
  "    output: 0",
].join("\n");

/**
 * W20 钉死用 AGENTS.md 基线（W33 唯一清单件）：扩到 60+ 行（中段埋 W20-MIDDLE-OF-FILE-MARKER），
 * 一行追加的 diff notice 若还搬全文，中段标记必然现形——absence 断言的靶子；
 * 全文 >2× notice 的尺寸互证也靠这个体量差撑起。
 */
function agentsBytes(withMarkerLine: boolean): string {
  const fill = Array.from({ length: 60 }, (_, i) =>
    i === 30 ? "W20-MIDDLE-OF-FILE-MARKER" : `W20-FILL-${String(i).padStart(2, "0")}`,
  ).join("\n");
  const base = `# 一级记忆\nW16-FROZEN-PREFIX-MARKER\n${fill}\nW20-TAIL-MARKER\n`;
  return withMarkerLine ? `${base}W16-APPENDED-CHUNK\n` : base;
}

beforeAll(async () => {
  createLoomApp = (await import("./boot.js")).createLoomApp;
  work = mkdtempSync(join(tmpdir(), "loom-w16-"));
  ws = join(work, "ws");
  stateRoot = join(work, "state");
  mkdirSync(join(ws, "memory", "fact"), { recursive: true });
  mkdirSync(join(ws, "memory", "self"), { recursive: true });
  mkdirSync(join(ws, "memory", "profile"), { recursive: true });
  // W33 清单 = 仅 AGENTS.md（唯一嗅探靶）；退役四件仍写盘作诱饵：盘上存在但绝非注入源，
  // 后续 "W33 清单收缩零幻影通报" 用例消费这一在场性。
  writeFileSync(join(ws, "AGENTS.md"), agentsBytes(false));
  writeFileSync(join(ws, "memory", "README.md"), "W16-INDEX-记忆导航\n");
  writeFileSync(join(ws, "memory", "self", "必读.md"), "W16-SNAP-热快照\n");
  writeFileSync(join(ws, "memory", "profile", "core.md"), "W16-CORE-画像核心\n");
  writeFileSync(join(ws, "memory", "fact", "总目录.md"), "W16-FACTINDEX-月度指针\n");
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

function config(): LoomConfig {
  return parseLoomConfig(FAKE_YAML.replace("WS_ROOT", ws), "<test>", { env: {} });
}

async function makeApp(): Promise<{ app: LoomApp; fake: FakeHandle }> {
  const store = new HotConfigStore({ sink: createFileAuditSink(join(stateRoot, "config")), env: {} });
  const text = FAKE_YAML.replace("WS_ROOT", ws);
  const applied = store.apply(text, "<test>");
  if (!applied.ok) throw new Error(`配置 apply 失败：${applied.errors.join(";")}`);
  const app = await createLoomApp({
    config: config(),
    store,
    stateRoot,
    tokens: ["tok-w16-test"],
    version: "test",
    env: { LOOM_FAKE_MODEL: "1" },
  });
  const fake = app.model.model as unknown as FakeHandle;
  return { app, fake };
}

interface FakeHandle {
  push(...r: FakeAssistantResponse[]): void;
  getCalls(): readonly { systemPrompt?: string; messages: readonly MsgLike[] }[];
}

interface MsgLike {
  readonly role: string;
  readonly content: unknown;
}

/** user-role 字符串正文（notice 与本轮 prompt 都是 user-role string content）。 */
function userText(m: MsgLike): string | null {
  return m.role === "user" && typeof m.content === "string" ? m.content : null;
}

function isNotice(m: MsgLike): boolean {
  return (userText(m) ?? "").startsWith("<system-reminder>");
}

function mainConverge(text: string): FakeAssistantResponse {
  return {
    content: [
      { type: "text", text },
      { type: "toolCall", name: "converge", arguments: { status: "已完成", digest: text, body: "收口。" } },
    ],
  };
}

async function waitFor(predicate: () => boolean, budgetMs = 8000): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return predicate();
}

// ───────────────────────── W17-F hub 帧观测（events 测试同款 fakeSubscriber 惯用法） ─────────────────────────

/** 捕获型假订阅者：res.write 进环形字符串（订阅→解析 data: 帧），不触真网络。 */
function fakeSubscriber(): { res: ServerResponse; frames: () => LoomFrame[] } {
  const res = new ServerResponse(new IncomingMessage(new Socket()));
  const chunks: string[] = [];
  res.write = ((chunk: unknown): boolean => {
    chunks.push(String(chunk));
    return true;
  }) as typeof res.write;
  return {
    res,
    frames: () => {
      const out: LoomFrame[] = [];
      for (const piece of chunks.join("").split("\n\n")) {
        const trimmed = piece.trim();
        if (trimmed === "" || trimmed.startsWith(":") || !trimmed.startsWith("data:")) continue;
        out.push(JSON.parse(trimmed.slice("data:".length)) as LoomFrame);
      }
      return out;
    },
  };
}

/** 帧序列里 context.notice 帧的 notices 条目归一（非数组 = 空面；不 `as` 蒙混）。 */
function noticeEntriesOf(frame: LoomFrame): readonly Record<string, unknown>[] {
  const raw: unknown = frame.payload.properties["notices"];
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null);
}

/** 按类型筛帧（保流内下标，供时序断言）。 */
function framesOfType(frames: readonly LoomFrame[], type: string): LoomFrame[] {
  return frames.filter((f) => f.payload.type === type);
}

/** 发一轮并等收尾（假模型每轮恰好一次 converge LLM call）。 */
async function sendTurn(app: LoomApp, fake: FakeHandle, sessionID: string, prompt: string, reply: string): Promise<void> {
  fake.push(mainConverge(reply));
  const outcome = app.registry.send(sessionID, prompt);
  expect(outcome.accepted, `send "${prompt}" 应被受理`).toBe(true);
  expect(await waitFor(() => app.registry.get(sessionID)?.running === null), `轮 "${prompt}" 应收尾`).toBe(true);
}

describe("W16 上下文变更嗅探：boot 端到端（准入水位 → 持久 prelude → 冻结前缀零触碰）", () => {
  it("基线→改→变更轮(diff)→touch 轮(零发)→不重发→删→二次 boot，全程请求面钉死", async () => {
    // ── 第一次 boot ──
    const { app: app1, fake: fake1 } = await makeApp();
    try {
      const rec = app1.registry.create();
      const sid = rec.sessionID;

      // (1) 基线轮：清单件 AGENTS.md 盘上 = boot 种子（诱饵四件不在清单、永不进水位）⇒ 零 notice（逐字节旧调用面）。
      await sendTurn(app1, fake1, sid, "第一轮基线", "基线正文");
      const calls1 = fake1.getCalls();
      expect(calls1).toHaveLength(1);
      const sysBaseline = calls1[0]?.systemPrompt;
      if (sysBaseline === undefined) throw new Error("装配接线请求必须携 systemPrompt");
      expect(calls1[0]!.messages.filter(isNotice)).toHaveLength(0);

      // (2) AGENTS.md 变更（追加一行 = size 变，D16 水位两字段任一失配即判变）。
      appendFileSync(join(ws, "AGENTS.md"), "W16-APPENDED-CHUNK\n");

      // (3) 变更轮：notice 先于本轮用户消息；前缀字节冻结不动。
      await sendTurn(app1, fake1, sid, "第二轮变更", "变更正文");
      const calls2 = fake1.getCalls();
      expect(calls2).toHaveLength(2);
      const msgs2 = calls2[1]!.messages;
      const userIdx = msgs2.findIndex((m) => userText(m) === "第二轮变更");
      expect(userIdx, "本轮用户消息应在 messages 尾段").toBeGreaterThan(0);
      const pre = msgs2[userIdx - 1]!;
      expect(pre.role).toBe("user");
      expect(isNotice(pre)).toBe(true);
      const noticeText = userText(pre) ?? "";
      // W20 真 diff 三钉：'@@' 头存在、'+' 行只带新增内容与±3 上下文、中段远离改动行绝不入块。
      expect(noticeText).toContain("Updated instructions from: AGENTS.md");
      expect(noticeText).toContain("This file changed after it was loaded. Only the differences are shown below");
      expect(noticeText).toContain("@@ -");
      expect(noticeText).toContain("+W16-APPENDED-CHUNK");
      expect(noticeText).toContain("\n W20-TAIL-MARKER"); // 上下文行（' ' 前缀）
      expect(noticeText).not.toContain("W20-MIDDLE-OF-FILE-MARKER"); // 全文搬运的直接反证
      expect(noticeText).not.toContain("W16-FROZEN-PREFIX-MARKER");
      // 一行改动的 notice ≈ 数百字节量级，绝不 ≈ 全文尺寸（现盘全文 >2× notice）。
      expect(Buffer.byteLength(noticeText, "utf8") * 2).toBeLessThan(
        Buffer.byteLength(agentsBytes(true), "utf8"),
      );
      expect(noticeText.endsWith("</system-reminder>")).toBe(true);
      // 冻结前缀再钉（W15-B）：变更轮 systemPrompt 与基线轮逐字节全等，追加内容绝不进前缀。
      expect(calls2[1]!.systemPrompt).toBe(sysBaseline);
      expect(sysBaseline).not.toContain("W16-APPENDED-CHUNK");

      // (4) W20 touch-无变零发（live）：同字节回写（mtime 变、内容逐字相等）⇒ 本轮零新 notice。
      writeFileSync(join(ws, "AGENTS.md"), agentsBytes(true));
      await sendTurn(app1, fake1, sid, "第三轮touch", "touch 正文");
      const msgsT = fake1.getCalls()[2]!.messages;
      const userIdxT = msgsT.findIndex((m) => userText(m) === "第三轮touch");
      expect(userIdxT).toBeGreaterThan(0);
      expect(isNotice(msgsT[userIdxT - 1]!)).toBe(false); // 用户消息前没有新 notice
      expect(
        msgsT.filter((m) => isNotice(m) && (userText(m) ?? "").includes("Updated instructions from: AGENTS.md")),
      ).toHaveLength(1); // 仍是 (3) 落史那一条（持久 prelude）

      // (5) 无变更轮：水位已推进 ⇒ 变更恰发一次，不重发。
      await sendTurn(app1, fake1, sid, "第四轮不重发", "第四正文");
      const msgs3 = fake1.getCalls()[3]!.messages;
      const notices3 = msgs3.filter((m) => isNotice(m) && (userText(m) ?? "").includes("Updated instructions from: AGENTS.md"));
      expect(notices3).toHaveLength(1); // 仍是 (3) 落史那一条（持久 prelude），绝非重注入
      const userIdx3 = msgs3.findIndex((m) => userText(m) === "第四轮不重发");
      expect(userIdx3).toBeGreaterThan(0);
      expect(isNotice(msgs3[userIdx3 - 1]!)).toBe(false); // 本轮用户消息前没有新 notice

      // (6) 删除 AGENTS.md（W33 唯一钉件；remove 通道原样在单件清单上验证）⇒ remove notice。
      rmSync(join(ws, "AGENTS.md"));
      await sendTurn(app1, fake1, sid, "第五轮删除", "删除正文");
      const msgs4 = fake1.getCalls()[4]!.messages;
      const userIdx4 = msgs4.findIndex((m) => userText(m) === "第五轮删除");
      const pre4 = msgs4[userIdx4 - 1]!;
      expect(isNotice(pre4)).toBe(true);
      expect(userText(pre4)).toContain("Instructions removed: AGENTS.md");
      expect(userText(pre4)).toContain("no longer apply");
      // 前缀依旧冻结：六轮 systemPrompt 逐字节全等。
      expect(fake1.getCalls().every((c) => c.systemPrompt === sysBaseline)).toBe(true);
    } finally {
      app1.model.teardown();
    }

    // ── 第二次 boot（同 stateRoot / 现盘状态）──
    const { app: app2, fake: fake2 } = await makeApp();
    try {
      const rec2 = app2.registry.create();
      await sendTurn(app2, fake2, rec2.sessionID, "重水后首轮", "重水正文");
      const msgs = fake2.getCalls()[0]!.messages;
      // 水位以现盘重播（AGENTS.md 已删 ⇒ 缺位无种子；退役四件不在清单、永不进水位）⇒ 旧 diff 绝不重发。
      expect(msgs.filter(isNotice)).toHaveLength(0);
      expect(msgs.filter((m) => userText(m) !== null)).toHaveLength(1); // 只有本轮用户消息
    } finally {
      app2.model.teardown();
    }
  });

  it("W16-D per-session 水位：同一变更两个既有会话各恰收一次、互不吞；消费后新建会话零重放", async () => {
    // Given 自包含：AGENTS.md 重写为基线态（诱饵四件一并复位，保持盘上在场性），boot 后**先注册两个 sid 再改盘**（两者水位
    // 基线都=boot 现盘），fake 按调用序取证：call0=A首轮 / call1=B首轮 / call2=A二轮 / call3=C首轮。
    writeFileSync(join(ws, "AGENTS.md"), agentsBytes(false));
    writeFileSync(join(ws, "memory", "README.md"), "W16D-INDEX-导航\n");
    writeFileSync(join(ws, "memory", "self", "必读.md"), "W16D-SNAP-快照\n");
    writeFileSync(join(ws, "memory", "profile", "core.md"), "W16D-CORE-画像\n");
    writeFileSync(join(ws, "memory", "fact", "总目录.md"), "W16D-FACT-指针\n");
    const { app, fake } = await makeApp();
    try {
      const recA = app.registry.create();
      const recB = app.registry.create(); // 两 sid 都在变更发生**前**注册（均为"现有会话"）

      appendFileSync(join(ws, "AGENTS.md"), "W16D-TWIN-CHUNK\n");

      // When A 进轮 ⇒ A 收 replace 差异 notice（先于本轮用户消息）。
      await sendTurn(app, fake, recA.sessionID, "A 首轮", "A 正文");
      const msgsA1 = fake.getCalls()[0]!.messages;
      const userIdxA = msgsA1.findIndex((m) => userText(m) === "A 首轮");
      const noticeA = msgsA1[userIdxA - 1]!;
      expect(isNotice(noticeA)).toBe(true);
      expect(userText(noticeA)).toContain("Updated instructions from: AGENTS.md");
      expect(userText(noticeA)).toContain("@@ -"); // W20：差异块而非全文
      expect(userText(noticeA)).toContain("+W16D-TWIN-CHUNK");
      expect(userText(noticeA)).not.toContain("W20-MIDDLE-OF-FILE-MARKER");

      // When B（另一既有会话，水位互不共享）进轮 ⇒ 收**同一条** notice——A 的消费不吞 B。
      await sendTurn(app, fake, recB.sessionID, "B 首轮", "B 正文");
      const msgsB1 = fake.getCalls()[1]!.messages;
      expect(msgsB1).toHaveLength(2); // B 是全新转录：[notice, user] 恰两条
      const noticeB = msgsB1[0]!;
      expect(isNotice(noticeB)).toBe(true);
      expect(userText(noticeB)).toBe(userText(noticeA)); // 同一 notice 逐字节全等，各自恰一次
      expect(userText(msgsB1[1]!)).toBe("B 首轮");

      // Then A 二轮：A 自身水位已推进 ⇒ 不重发（历史里只有首轮那一条 AGENTS notice）。
      await sendTurn(app, fake, recA.sessionID, "A 二轮", "A 二轮正文");
      const msgsA2 = fake.getCalls()[2]!.messages;
      const agentsNotices = msgsA2.filter(
        (m) => isNotice(m) && (userText(m) ?? "").includes("Updated instructions from: AGENTS.md"),
      );
      expect(agentsNotices).toHaveLength(1); // A1 落史的那条，非 A2 重注入
      const userIdxA2 = msgsA2.findIndex((m) => userText(m) === "A 二轮");
      expect(isNotice(msgsA2[userIdxA2 - 1]!)).toBe(false);

      // Then 消费之后新建的会话 C：注册时拷到的是已推进模板 ⇒ 零 notice（W16-A §3 语义保持）。
      const recC = app.registry.create();
      await sendTurn(app, fake, recC.sessionID, "C 首轮", "C 正文");
      const msgsC1 = fake.getCalls()[3]!.messages;
      expect(msgsC1.filter(isNotice)).toHaveLength(0);
      expect(msgsC1.filter((m) => userText(m) !== null)).toHaveLength(1); // 仅本轮用户消息
      // 前缀冻结跨会话同样成立：A/B/C 三sid 的 systemPrompt 逐字节全等。
      const sys = fake.getCalls()[0]!.systemPrompt;
      expect(fake.getCalls().every((c) => c.systemPrompt === sys)).toBe(true);
    } finally {
      app.model.teardown();
    }
  });

  it("set 首见语义：boot 缺位的清单件后来出现 ⇒ Additional instructions（boot 未实载件不进水位；W33 单件清单靶 = AGENTS.md）", async () => {
    // Given 自包含：AGENTS.md 显式删掉（boot 必缺位 → MISSING 占位、水位无条目）。
    rmSync(join(ws, "AGENTS.md"), { force: true });
    const { app, fake } = await makeApp();
    try {
      const rec = app.registry.create();
      await sendTurn(app, fake, rec.sessionID, "set 基线", "set 基线正文");
      expect(fake.getCalls()[0]!.messages.filter(isNotice)).toHaveLength(0); // AGENTS.md 缺位无水位、无动作

      writeFileSync(join(ws, "AGENTS.md"), agentsBytes(false));
      await sendTurn(app, fake, rec.sessionID, "set 变更轮", "set 变更正文");
      const msgs = fake.getCalls()[1]!.messages;
      const userIdx = msgs.findIndex((m) => userText(m) === "set 变更轮");
      const pre = msgs[userIdx - 1]!;
      expect(isNotice(pre)).toBe(true);
      expect(userText(pre)).toContain("Additional instructions from: AGENTS.md");
      expect(userText(pre)).toContain("W16-FROZEN-PREFIX-MARKER");
    } finally {
      app.model.teardown();
    }
  });

  it("W33 清单收缩零幻影通报：退役四件盘上在场/变更/删除 ⇒ 全程零 notice 零帧；瘦前缀每轮全量在请求面", async () => {
    // Given 自包含：升级后盘态 = 旧五件全量在场（模拟真实 workspace：四件不删只退役），
    // boot 按 W33 新清单（仅 AGENTS.md）接线 ⇒ 水位模板天然不含四件。
    writeFileSync(join(ws, "AGENTS.md"), agentsBytes(false));
    writeFileSync(join(ws, "memory", "README.md"), "W33-INDEX-导航\n");
    writeFileSync(join(ws, "memory", "self", "必读.md"), "W33-SNAP-快照\n");
    writeFileSync(join(ws, "memory", "profile", "core.md"), "W33-CORE-画像\n");
    writeFileSync(join(ws, "memory", "fact", "总目录.md"), "W33-FACT-指针\n");
    const { app, fake } = await makeApp();
    try {
      const rec = app.registry.create();
      const sid = rec.sessionID;
      const hub = app.registry.hubOf(sid);
      if (hub === undefined) throw new Error("hubOf 必命中刚注册会话");
      const sub = fakeSubscriber();
      const unsubscribe = hub.subscribe(sub.res);
      try {
        // When 升级后首轮准入 ⇒ 零 notice（remove-storm 判别面：幻影通报必现形于此轮）。
        await sendTurn(app, fake, sid, "W33 首轮", "W33 首轮正文");
        const msgs1 = fake.getCalls()[0]!.messages;
        expect(msgs1.filter(isNotice)).toHaveLength(0);
        // Then 慢前缀新形态直证：systemPrompt = 瘦身后的单件前缀全文，每轮请求面携带
        // （W15-B 冻结前缀的跨 boot 位移 = prefixHash 漂移的合法出口，无需也绝无 diff 通道）。
        const sys1 = fake.getCalls()[0]!.systemPrompt;
        expect(sys1).toContain("### memory[0] AGENTS.md");
        expect(sys1).toContain("W16-FROZEN-PREFIX-MARKER");
        expect(sys1).not.toContain("### memory[1]");
        expect(sys1).not.toContain("W33-INDEX-导航");
        expect(sys1).not.toContain("W33-SNAP-快照");
        expect(sys1).not.toContain("W33-CORE-画像");
        expect(sys1).not.toContain("W33-FACT-指针");

        // When 退役件盘侧 churn：改两件、删一件 ⇒ 下一轮准入仍零观测源可报（清单外文件与嗅探无涉）。
        writeFileSync(join(ws, "memory", "README.md"), "W33-INDEX-改版\n");
        appendFileSync(join(ws, "memory", "fact", "总目录.md"), "W33-FACT-追加\n");
        rmSync(join(ws, "memory", "self", "必读.md"));
        await sendTurn(app, fake, sid, "W33 churn 轮", "W33 churn 正文");
        const msgs2 = fake.getCalls()[1]!.messages;
        expect(msgs2.filter(isNotice)).toHaveLength(0);
        // Then 帧面终局：两轮全程零 context.notice 帧（SSE 观测面同证，防"发了没注"的错位）。
        expect(framesOfType(sub.frames(), "context.notice")).toHaveLength(0);
      } finally {
        unsubscribe();
      }
    } finally {
      app.model.teardown();
    }
  });

  it("W17-F context.notice 帧：准入时刻发帧（paths+bytes 不携内容）→ 变更/touch/删除逐档形状钉死（W20 bytes=notice 文本字节）", async () => {
    // Given 自包含：AGENTS.md 重写为基线态 + 诱饵四件复位，boot 后订住该 sid 的 hub（fake 订阅者零真网络）。
    writeFileSync(join(ws, "AGENTS.md"), agentsBytes(false));
    writeFileSync(join(ws, "memory", "README.md"), "W17F-INDEX-导航\n");
    writeFileSync(join(ws, "memory", "self", "必读.md"), "W17F-SNAP-快照\n");
    writeFileSync(join(ws, "memory", "profile", "core.md"), "W17F-CORE-画像\n");
    writeFileSync(join(ws, "memory", "fact", "总目录.md"), "W17F-FACT-指针\n");
    const { app, fake } = await makeApp();
    try {
      const rec = app.registry.create();
      const sid = rec.sessionID;
      const hub = app.registry.hubOf(sid);
      if (hub === undefined) throw new Error("hubOf 必命中刚注册会话");
      const sub = fakeSubscriber();
      const unsubscribe = hub.subscribe(sub.res);
      try {
        // When 基线轮（零变更）⇒ 不发 context.notice 帧。
        await sendTurn(app, fake, sid, "W17F 基线", "W17F 基线正文");
        expect(framesOfType(sub.frames(), "context.notice")).toHaveLength(0);

        // When 改 AGENTS.md（追加一行）再发一轮 ⇒ 恰一帧，且发在准入时刻（该轮 busy 帧之前）。
        appendFileSync(join(ws, "AGENTS.md"), "W17F-CHUNK-增量\n");
        const fullNewBytes = Buffer.byteLength(agentsBytes(false) + "W17F-CHUNK-增量\n", "utf8");
        await sendTurn(app, fake, sid, "W17F 变更", "W17F 变更正文");
        const frames = sub.frames();
        const noticeFrames = framesOfType(frames, "context.notice");
        expect(noticeFrames).toHaveLength(1);
        const nf = noticeFrames[0]!;
        expect(nf.payload.properties["sessionID"]).toBe(sid);
        expect(nf.payload.properties["turnIdx"]).toBe(1);
        // W20 bytes 口径 = 该 notice 最终文本 UTF-8 字节：与转录里实际注入的差异通知互证
        // （两独立出口同数），且严格小于旧口径的现盘全文字节（全量搬运语义已退役）。
        const replaceNotice = fake.getCalls()[1]!.messages.filter(isNotice).at(-1)!;
        const replaceText = userText(replaceNotice) ?? "";
        expect(replaceText).toContain("@@ -");
        expect(replaceText).toContain("+W17F-CHUNK-增量");
        expect(Buffer.byteLength(replaceText, "utf8")).toBeLessThan(fullNewBytes);
        expect(noticeEntriesOf(nf)).toEqual([
          { action: "replace", relPath: "AGENTS.md", bytes: Buffer.byteLength(replaceText, "utf8") },
        ]);
        // 载荷纪律：帧只有 paths+bytes，正文绝不进 SSE（内容归转录/发线面）。
        expect(JSON.stringify(nf.payload)).not.toContain("W17F-CHUNK-增量");
        expect(JSON.stringify(nf.payload)).not.toContain("一级记忆");
        // 时序：context.notice 在首轮 busy 之后、变更轮 busy 之前（水位检出于 #start 之前）。
        const busyIdxs = frames.reduce<number[]>((acc, f, i) => {
          if (f.payload.type === "session.status") acc.push(i);
          return acc;
        }, []);
        const noticeIdx = frames.indexOf(nf);
        expect(busyIdxs.length).toBeGreaterThanOrEqual(2);
        expect(noticeIdx).toBeGreaterThan(busyIdxs[0]!);
        expect(noticeIdx).toBeLessThan(busyIdxs[1]!);

        // When W20 touch-无变零发（帧面）：同字节回写 ⇒ 不发新帧（历史仍只 (变更轮) 一条 notice）。
        writeFileSync(join(ws, "AGENTS.md"), agentsBytes(false) + "W17F-CHUNK-增量\n");
        await sendTurn(app, fake, sid, "W17F touch", "W17F touch 正文");
        expect(framesOfType(sub.frames(), "context.notice")).toHaveLength(1);
        const msgsTouch = fake.getCalls()[2]!.messages;
        expect(msgsTouch.filter(isNotice)).toHaveLength(1); // 变更轮落史那条，无新增

        // When 删除 AGENTS.md 再发一轮（W33 单件清单的 remove 档）⇒ bytes=其文案长度，W20 统一口径；turnIdx 续增。
        rmSync(join(ws, "AGENTS.md"));
        await sendTurn(app, fake, sid, "W17F 删除", "W17F 删除正文");
        const noticeFrames2 = framesOfType(sub.frames(), "context.notice");
        expect(noticeFrames2).toHaveLength(2);
        const nf2 = noticeFrames2[1]!;
        expect(nf2.payload.properties["turnIdx"]).toBe(3);
        const removeNotice = fake.getCalls()[3]!.messages.filter(isNotice).at(-1)!;
        const removeText = userText(removeNotice) ?? "";
        expect(removeText).toContain("Instructions removed: AGENTS.md");
        expect(noticeEntriesOf(nf2)).toEqual([
          { action: "remove", relPath: "AGENTS.md", bytes: Buffer.byteLength(removeText, "utf8") },
        ]);
      } finally {
        unsubscribe();
      }
    } finally {
      app.model.teardown();
    }
  });
});
