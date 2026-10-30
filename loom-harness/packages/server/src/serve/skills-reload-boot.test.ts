/**
 * W25 skills 热重载 —— boot 端到端（真树装配、fake 模型零凭据、tmp workspace/skills 目录）。
 *
 * 场景叙事（每 it 自包含重写 fixture，水位/代号互不串台）：
 *   1. 自动嗅探链（触发=准入，与 W16-A 记忆嗅探同缝）：基线轮零 notice → 改 description
 *      → 下一轮恰一 notice（skills/catalog 的 unified 差异块，单行描述改动 <500B，正文哨兵
 *      绝不在场）+ 当轮 system prompt 已携新 catalog（hook 每轮现读）→ 无变更轮不重发 →
 *      只改正文轮零新 notice（touch-无变纪律的 catalog 面）；
 *   2. POST /skills/reload 端点：成功 ok:true / 增删即刻反映到 /context/full 的
 *      manifest.skillFiles（观测面 truthfulness："一个字都不准遗漏"口径）/ 全删目录
 *      fail-soft 200 ok:false + 旧 catalog 照服务（绝不 500/绝不空化）；
 *   3. 帧面复用（零新事件名）：context.notice 帧 relPath="skills/catalog"、bytes<500、
 *      正文绝不进帧；正文-only 改动零帧。
 *
 * 加载纪律同 context-change-boot：boot 图必须动态 import（SSR 环解析实测）。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FakeAssistantResponse } from "@axeuh/loom-core/testing";

import type { LoomFrame } from "../events/index.js";
import type { LoomApp } from "./boot.js";

type CreateLoomApp = typeof import("./boot.js").createLoomApp;
let createLoomApp!: CreateLoomApp;

let work = "";
let ws = "";
let skillsRoot = "";
let stateRoot = "";
const TOKEN = "tok-w25-reload";

const FAKE_YAML = [
  "server:",
  "  port: 5104",
  "  hostname: 127.0.0.1",
  "workspace: WS_ROOT",
  "models:",
  "  - id: fake-w25",
  "    provider: fake",
  "    contextWindow: 200000",
  "    maxOutput: 4096",
  "    timeout: 60000",
  "pricing:",
  "  fake:",
  "    input: 0",
  "    output: 0",
  "skills:",
  "  allowlist:",
  "    - SKILLS_ROOT",
].join("\n");

/** skill 文本（描述短小 = <500B notice 断言的体量前提；正文带哨兵 = 反嗅探靶）。 */
function skillMd(name: string, description: string, bodyTag: string): string {
  return [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    "---",
    `W25-BODY-SENTINEL::${bodyTag}`,
  ].join("\n");
}

/** 基线 fixtures：记忆件最小体量（W33 起注入仅 AGENTS.md，余四件为盘上诱饵）+ alpha/beta 两 skill。 */
function resetFixtures(): void {
  rmSync(ws, { recursive: true, force: true });
  rmSync(skillsRoot, { recursive: true, force: true });
  mkdirSync(join(ws, "memory", "fact"), { recursive: true });
  mkdirSync(join(ws, "memory", "self"), { recursive: true });
  mkdirSync(join(ws, "memory", "profile"), { recursive: true });
  writeFileSync(join(ws, "AGENTS.md"), "W25-AGENTS\n");
  writeFileSync(join(ws, "memory", "README.md"), "W25-INDEX\n");
  writeFileSync(join(ws, "memory", "self", "必读.md"), "W25-SNAP\n");
  writeFileSync(join(ws, "memory", "profile", "core.md"), "W25-CORE\n");
  writeFileSync(join(ws, "memory", "fact", "总目录.md"), "W25-FACT\n");
  mkdirSync(skillsRoot, { recursive: true });
  writeFileSync(join(skillsRoot, "alpha.md"), skillMd("alpha", "ALPHA-DESC-ONE", "A1"));
  writeFileSync(join(skillsRoot, "beta.md"), skillMd("beta", "BETA-DESC", "B"));
}

interface FakeHandle {
  push(...r: FakeAssistantResponse[]): void;
  getCalls(): readonly { systemPrompt?: string; messages: readonly MsgLike[] }[];
}

interface MsgLike {
  readonly role: string;
  readonly content: unknown;
}

function userText(m: MsgLike): string | null {
  return m.role === "user" && typeof m.content === "string" ? m.content : null;
}

function isNotice(m: MsgLike): boolean {
  return (userText(m) ?? "").startsWith("<system-reminder>");
}

function isCatalogNotice(m: MsgLike): boolean {
  const t = userText(m) ?? "";
  return isNotice(m) && t.includes("skills/catalog");
}

async function waitFor(predicate: () => boolean, budgetMs = 8000): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return predicate();
}

async function makeApp(): Promise<{ app: LoomApp; fake: FakeHandle }> {
  const { parseLoomConfig } = await import("../config/loom-config.js");
  const { HotConfigStore, createFileAuditSink } = await import("../hotreload/index.js");
  const text = FAKE_YAML.replace("WS_ROOT", ws).replace("SKILLS_ROOT", skillsRoot);
  const store = new HotConfigStore({ sink: createFileAuditSink(join(stateRoot, "config")), env: {} });
  const applied = store.apply(text, "<test>");
  if (!applied.ok) throw new Error(`配置 apply 失败：${applied.errors.join(";")}`);
  const app = await createLoomApp({
    config: parseLoomConfig(text, "<test>", { env: {} }),
    store,
    stateRoot,
    tokens: [TOKEN],
    version: "test",
    env: { LOOM_FAKE_MODEL: "1" },
    log: () => {},
  });
  const fake = app.model.model as unknown as FakeHandle;
  return { app, fake };
}

/** 起监听并给 fetch 口（POST /skills/reload 与 GET /context/full 走真 HTTP 面）。 */
async function serveHttp(app: LoomApp): Promise<{
  api: (path: string, init?: RequestInit) => Promise<{ status: number; json: Record<string, unknown> }>;
  close: () => Promise<void>;
}> {
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const addr = app.server.address();
  if (addr === null || typeof addr === "string") throw new Error("监听地址不可读");
  const baseUrl = `http://127.0.0.1:${String(addr.port)}`;
  const api = async (path: string, init?: RequestInit) => {
    const res = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${TOKEN}`, ...(init?.headers ?? {}) },
    });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
    } catch {
      json = { raw: text };
    }
    return { status: res.status, json };
  };
  const close = async (): Promise<void> => {
    app.server.closeAllConnections();
    await new Promise<void>((resolve) => app.server.close(() => resolve()));
  };
  return { api, close };
}

async function sendTurn(app: LoomApp, fake: FakeHandle, sessionID: string, prompt: string, reply: string): Promise<void> {
  fake.push({ content: [{ type: "text", text: reply }], stopReason: "stop" });
  const outcome = app.registry.send(sessionID, prompt);
  expect(outcome.accepted, `send "${prompt}" 应被受理`).toBe(true);
  expect(await waitFor(() => app.registry.get(sessionID)?.running === null), `轮 "${prompt}" 应收尾`).toBe(true);
}

/** 发一轮并返回当轮请求面。 */
async function turnMessages(app: LoomApp, fake: FakeHandle, sid: string, prompt: string): Promise<readonly MsgLike[]> {
  await sendTurn(app, fake, sid, prompt, `${prompt}-reply`);
  return fake.getCalls().at(-1)!.messages;
}

/** manifest.skillFiles 的谨慎窄化（不 as 蒙混：形状不对 = 测试红，绝不静默跳过）。 */
function skillFilesOf(json: Record<string, unknown>): { name: string; file: string; degraded: boolean }[] {
  const manifest: unknown = json["manifest"];
  if (manifest === null || typeof manifest !== "object") throw new Error("manifest 缺席：/context/full v2 必挂 manifest 对象");
  const raw: unknown = (manifest as Record<string, unknown>)["skillFiles"];
  if (!Array.isArray(raw)) throw new Error("skillFiles 非数组");
  return raw.map((x) => {
    if (typeof x !== "object" || x === null) throw new Error("skillFiles 条目非对象");
    const r = x as Record<string, unknown>;
    if (typeof r["name"] !== "string" || typeof r["file"] !== "string" || typeof r["degraded"] !== "boolean") {
      throw new Error("skillFiles 条目形状不如预期");
    }
    return { name: r["name"], file: r["file"], degraded: r["degraded"] };
  });
}

/** 捕获型假订阅者（context-change-boot 同款惯用法，零真网络）。 */
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

function framesOfType(frames: readonly LoomFrame[], type: string): LoomFrame[] {
  return frames.filter((f) => f.payload.type === type);
}

function noticeEntriesOf(frame: LoomFrame): readonly Record<string, unknown>[] {
  const raw: unknown = frame.payload.properties["notices"];
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null);
}

beforeAll(async () => {
  createLoomApp = (await import("./boot.js")).createLoomApp;
  work = mkdtempSync(join(tmpdir(), "loom-w25-"));
  ws = join(work, "ws");
  skillsRoot = join(work, "skills");
  stateRoot = join(work, "state");
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

describe("W25 自动嗅探：准入重扫 + catalog 层 diff notice（正文不嗅探）", () => {
  it("改 description → 下一轮恰一 notice（diff 块 <500B、正文哨兵绝不在场）+ 当轮 system prompt 已新；无变更不重发；正文-only 零发", async () => {
    resetFixtures();
    const { app, fake } = await makeApp();
    try {
      const rec = app.registry.create();
      const sid = rec.sessionID;

      // (1) 基线轮：boot 种子=盘上态 ⇒ 零 notice；catalog 已在 system prompt（W5 旧面保持）。
      const msgs1 = await turnMessages(app, fake, sid, "W25 基线");
      expect(msgs1.filter(isNotice)).toHaveLength(0);
      const sys1 = fake.getCalls().at(-1)!.systemPrompt ?? "";
      expect(sys1).toContain("- alpha: ALPHA-DESC-ONE");
      expect(sys1).not.toContain("W25-BODY-SENTINEL");

      // (2) 只改 alpha 的 description（同长度换词，size 可能不动——代号门兜住）。
      writeFileSync(join(skillsRoot, "alpha.md"), skillMd("alpha", "ALPHA-DESC-TWO", "A1"));

      // (3) 变更轮：准入自动重扫换入 → 恰一条 skills/catalog 的 replace notice；
      //     当轮 systemPrompt 已携新 catalog（hook 每轮现读，reload 后下一请求即新）。
      const msgs2 = await turnMessages(app, fake, sid, "W25 改描述");
      const catalogNotices = msgs2.filter(isCatalogNotice);
      expect(catalogNotices).toHaveLength(1);
      const noticeText = userText(catalogNotices[0]!) ?? "";
      expect(noticeText).toContain("Updated instructions from: skills/catalog");
      expect(noticeText).toContain("@@ -");
      expect(noticeText).toContain("-- alpha: ALPHA-DESC-ONE");
      expect(noticeText).toContain("+- alpha: ALPHA-DESC-TWO");
      // 防炸上下文钉：单行描述改动 = 差异块极小（<500B），全文块/正文绝不被搬运。
      expect(Buffer.byteLength(noticeText, "utf8")).toBeLessThan(500);
      expect(noticeText).not.toContain("W25-BODY-SENTINEL");
      const sys2 = fake.getCalls().at(-1)!.systemPrompt ?? "";
      expect(sys2).toContain("- alpha: ALPHA-DESC-TWO");
      expect(sys2).not.toContain("ALPHA-DESC-ONE");
      // notice 先于本轮用户消息（W16 增量之首纪律复用）。
      const userIdx2 = msgs2.findIndex((m) => userText(m) === "W25 改描述");
      expect(userIdx2).toBeGreaterThan(0);

      // (4) 无变更轮：水位已推进 ⇒ 不重发。
      const msgs3 = await turnMessages(app, fake, sid, "W25 不重发");
      expect(msgs3.filter(isCatalogNotice)).toHaveLength(1); // 历史落盘那一条，非重注入

      // (5) 正文-only 改动（描述逐字不动）→ 准入重扫成功但 catalog 块字节全等 ⇒ 零新 notice。
      writeFileSync(join(skillsRoot, "alpha.md"), skillMd("alpha", "ALPHA-DESC-TWO", "A1-BODY-REWRITTEN"));
      const msgs4 = await turnMessages(app, fake, sid, "W25 改正文");
      expect(msgs4.filter(isCatalogNotice)).toHaveLength(1); // 仍是 (3) 那条
      // 正文懒读照常换新（嗅探不管正文，invoke 通路管——两轨正交）。
      expect(await app.skillsWiring!.loader.invoke("alpha")).toContain("A1-BODY-REWRITTEN");
    } finally {
      app.model.teardown();
    }
  });
});

describe("W25 手动端点：POST /skills/reload（fail-soft + manifest 现算）", () => {
  it("增删 skill → ok:true + /context/full 的 skillFiles 即刻反映；全坏/不可读 → 200 ok:false 且旧 catalog 照服务", async () => {
    resetFixtures();
    const { app, fake } = await makeApp();
    let closeHttp: (() => Promise<void>) | undefined;
    try {
      const http = await serveHttp(app);
      closeHttp = http.close;
      const sid = app.registry.create().sessionID;

      // 基线 manifest：alpha+beta 健康件。
      const base = await http.api(`/sessions/${sid}/context/full`);
      expect(base.status).toBe(200);
      expect(skillFilesOf(base.json).map((f) => f.name)).toEqual(["alpha", "beta"]);

      // (1) 盘上加 gamma + broken（坏 frontmatter）→ POST 重载 → ok:true 计数如实。
      writeFileSync(join(skillsRoot, "gamma.md"), skillMd("gamma", "GAMMA-DESC", "G"));
      writeFileSync(join(skillsRoot, "broken.md"), "# 没有 frontmatter 的文件\n正文。\n");
      const reload1 = await http.api("/skills/reload", { method: "POST" });
      expect(reload1.status).toBe(200);
      expect(reload1.json["ok"]).toBe(true);
      expect(reload1.json["generation"]).toBe(1);
      expect(reload1.json["entries"]).toBe(3);
      expect(reload1.json["degraded"]).toBe(1);

      // (2) /context/full 的 manifest 现算：健康件含 gamma，坏件 degraded:true 如实入列（观测面不撒谎）。
      const after = await http.api(`/sessions/${sid}/context/full`);
      const files = skillFilesOf(after.json);
      expect(files.filter((f) => !f.degraded).map((f) => f.name)).toEqual(["alpha", "beta", "gamma"]);
      const brokenRow = files.find((f) => f.degraded);
      expect(brokenRow?.name).toBe("broken");

      // 下一请求的 system prompt 携新 catalog（端点路径不换准入也生效——hook 现读面）。
      const msgs = await turnMessages(app, fake, sid, "W25 端点后首轮");
      expect(msgs.filter(isCatalogNotice)).toHaveLength(1); // 手动 reload 的变更，准入时照常 diff notice
      expect(fake.getCalls().at(-1)!.systemPrompt ?? "").toContain("- gamma: GAMMA-DESC");

      // (3) fail-soft：allowlist 目录整删 → 重载 200 ok:false（绝不 500），旧 catalog 照服务。
      rmSync(skillsRoot, { recursive: true, force: true });
      const reload2 = await http.api("/skills/reload", { method: "POST" });
      expect(reload2.status).toBe(200);
      expect(reload2.json["ok"]).toBe(false);
      expect(String(reload2.json["reason"])).toContain("unreadable");
      const still = await http.api(`/sessions/${sid}/context/full`);
      const stillFiles = skillFilesOf(still.json);
      expect(stillFiles.filter((f) => !f.degraded).map((f) => f.name)).toEqual(["alpha", "beta", "gamma"]);
      expect(stillFiles.find((f) => f.degraded)?.name).toBe("broken"); // fail-soft：旧视图整面在场（含 degrade 审计行）
      const msgsDisaster = await turnMessages(app, fake, sid, "W25 灾后续跑");
      const sysFail = fake.getCalls().at(-1)!.systemPrompt ?? "";
      expect(sysFail).toContain("- gamma: GAMMA-DESC"); // 绝不空化
      expect(msgsDisaster.filter(isCatalogNotice)).toHaveLength(1); // 仍是 step(2) 落史那条：重载失败零新发
    } finally {
      if (closeHttp !== undefined) await closeHttp();
      app.model.teardown();
    }
  });
});

describe("W25 帧面：零新事件名，复用 context.notice（W17-F）", () => {
  it("catalog 变更帧 relPath=skills/catalog、bytes<500、正文绝不进帧；正文-only 零帧", async () => {
    resetFixtures();
    const { app, fake } = await makeApp();
    try {
      const rec = app.registry.create();
      const sid = rec.sessionID;
      const hub = app.registry.hubOf(sid);
      if (hub === undefined) throw new Error("hubOf 必命中刚注册会话");
      const sub = fakeSubscriber();
      const unsubscribe = hub.subscribe(sub.res);
      try {
        // 基线轮零 notice 帧。
        await turnMessages(app, fake, sid, "W25 帧基线");
        expect(framesOfType(sub.frames(), "context.notice")).toHaveLength(0);

        // 改描述 → 恰一 context.notice 帧，条目 = replace/skills/catalog，bytes = notice 文本字节。
        writeFileSync(join(skillsRoot, "alpha.md"), skillMd("alpha", "ALPHA-DESC-TWO", "A1"));
        await turnMessages(app, fake, sid, "W25 帧变更");
        const noticeFrames = framesOfType(sub.frames(), "context.notice");
        expect(noticeFrames).toHaveLength(1);
        const entries = noticeEntriesOf(noticeFrames[0]!);
        expect(entries).toHaveLength(1);
        const e0 = entries[0]!;
        expect(e0["action"]).toBe("replace");
        expect(e0["relPath"]).toBe("skills/catalog");
        expect(typeof e0["bytes"]).toBe("number");
        const frameBytes = Number(e0["bytes"]);
        expect(frameBytes).toBeLessThan(500);
        expect(frameBytes).toBeGreaterThan(0);
        // 帧载荷纪律：paths+bytes 而已，正文哨兵与 catalog 旧行文本都不进帧。
        expect(JSON.stringify(noticeFrames[0]!.payload)).not.toContain("W25-BODY-SENTINEL");
        // 零新事件名钉死：流内不存在任何带 skill 字样的事件类型。
        const types = new Set(sub.frames().map((f) => f.payload.type));
        for (const t of types) expect(t).not.toContain("skill");

        // 正文-only 改动：零新帧（catalog 块字节全等 = touch-无变在 catalog 源上的应用）。
        writeFileSync(join(skillsRoot, "alpha.md"), skillMd("alpha", "ALPHA-DESC-TWO", "A1-NEW-BODY"));
        await turnMessages(app, fake, sid, "W25 帧改正文");
        expect(framesOfType(sub.frames(), "context.notice")).toHaveLength(1);
      } finally {
        unsubscribe();
      }
    } finally {
      app.model.teardown();
    }
  });
});
