/**
 * W23-A 发线面持久缓存 —— `state/session/wire/{sid}.json` 的读写层（每会话原子覆盖写）。
 *
 * 定位：core 内存单槽（`lastWireRequest`，重启即清）的**持久镜像**。写入口 =
 * AgentSessionOptions.onWireSnapshot（每次 LLM call 解析完成后恰好一次）；读出口 =
 * GET /sessions/:id/context/full 的三段回落（live 槽 → live loop 下缓存 → basis:"cache"
 * 纯缓存）。缓存与 registry 成员资格无关：侧/子会话（不在册）跑完后照旧可查发线面。
 *
 * 纪律：
 * - **写前脱敏，密钥不落盘**：snapshot.optionsText 是 core 记的原始摊平（apiKey/headers
 *   明文在场），落盘前过 redactSecrets（复用 session-api/wire-view.ts 唯一正则，禁第二
 *   口径）重序列化。凭据解析失败 = 整条拒写（fail-closed：宁可缓存缺席，不可明文上盘），
 *   响亮 warn。
 * - **原子覆盖**：tmp 写 + renameSync 覆盖（POSIX 同目录 rename 原子；NTFS 经 ntfs3 同
 *   语义）。每会话单文件，last-write-wins——与内存单槽同一纪律，不留历史版本。
 * - **fail-soft 读面**：文件缺失/JSON 坏/形状不合 = null + warn（坏缓存绝不 500，
 *   回落面照常走 404 纪律）。
 * - 文件名安全化：sid 先 `-`→`_`（与路由 normalizeSessionID 同口径）再夹掉非
 *   [a-zA-Z0-9_] 字符——读写两侧同一函数，天然对称且路径注入不可行。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { canonicalJson, type WireRequestSnapshot } from "@axeuh/loom-core";
import { redactSecrets } from "../session-api/wire-view.js";

/** 缓存文件 schema 版本（形状演进判别位；不合 = 拒读 fail-soft）。 */
export const WIRE_CACHE_VERSION = 1;

/** 读侧产物：脱敏快照 + provider 载荷（fake 通道如实 null）+ 落盘时刻。 */
export interface WireCacheRecord {
  readonly savedAt: number;
  readonly snapshot: WireRequestSnapshot;
  readonly providerPayload: string | null;
}

/** 缓存写读失败的上报通道（与 ServeLog 同形子集；缺省 = 静默）。 */
export type WireCacheWarn = (msg: string, fields: Record<string, unknown>) => void;

/** sid → 文件安全名（读写两侧唯一口径，见模块头"文件名安全化"）。 */
export function wireCacheFileName(sessionID: string): string {
  const normalized = sessionID.replace(/-/g, "_").replace(/[^a-zA-Z0-9_]/g, "_");
  return `${normalized}.json`;
}

/** optionsText（canonical JSON 对象文本）→ 脱敏后重序列化（键序仍 canonical）。 */
function redactOptionsText(optionsText: string): string {
  const parsed: unknown = JSON.parse(optionsText);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("wire-cache: optionsText 不是 JSON 对象（core canonical 不变式破坏）");
  }
  const redacted = redactSecrets(parsed);
  if (typeof redacted !== "object" || redacted === null || Array.isArray(redacted)) {
    throw new Error("wire-cache: params 脱敏后不是 JSON 对象");
  }
  return canonicalJson(redacted);
}

/** 落盘前快照拷贝：仅 optionsText 换脱敏产物，其余字段逐字保留（wire 面其余件无凭据位）。 */
function redactedSnapshotForDisk(snapshot: WireRequestSnapshot): WireRequestSnapshot {
  return { ...snapshot, optionsText: redactOptionsText(snapshot.optionsText) };
}

/* ── 读侧形状校验（corrupt = null，绝不把半截形状喂给 wire-view） ── */

function isString(x: unknown): x is string {
  return typeof x === "string";
}
function isNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}
function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** WireRequestSnapshot 全字段形状校验（core 契约面；任何不合 = 缓存不可信）。 */
function isWireSnapshot(x: unknown): x is WireRequestSnapshot {
  if (!isRecord(x)) return false;
  if (!isNumber(x["capturedAt"]) || !isNumber(x["turnIdx"]) || !isNumber(x["transientCount"])) return false;
  const model = x["model"];
  if (
    !isRecord(model) ||
    !isString(model["id"]) ||
    !isString(model["api"]) ||
    !isString(model["baseUrl"]) ||
    !isString(model["provider"])
  ) {
    return false;
  }
  if (!isString(x["systemPrompt"]) || !isString(x["messagesText"]) || !isString(x["optionsText"])) return false;
  const tools = x["tools"];
  if (!Array.isArray(tools)) return false;
  for (const t of tools) {
    if (!isRecord(t) || !isString(t["name"]) || !isString(t["description"]) || !isString(t["schemaText"])) {
      return false;
    }
  }
  // 脱敏不变式：optionsText 必须仍是可解析 JSON 对象（读侧只验形状，不再脱敏——
  // 明文早已在写侧闸掉；若盘上是手改的明文，wire-view 出口闸仍会兜住）。
  try {
    const parsed: unknown = JSON.parse(x["optionsText"]);
    if (!isRecord(parsed)) return false;
  } catch {
    return false;
  }
  return true;
}

/** 整条记录形状校验。 */
function isWireCacheRecord(x: unknown): x is WireCacheRecord {
  if (!isRecord(x)) return false;
  if (x["version"] !== WIRE_CACHE_VERSION) return false;
  if (!isNumber(x["savedAt"])) return false;
  const payload = x["providerPayload"];
  if (typeof payload !== "string" && payload !== null) return false;
  return isWireSnapshot(x["snapshot"]);
}

export interface WireCacheStoreOptions {
  /** 缓存目录（boot 传 `state/session/wire`；构造即 mkdir 递归，失败响亮抛——装配期炸）。 */
  readonly dir: string;
  /** 写读失败的 warn 通道（fail-soft 面的留痕口；缺省 = 静默吞，测试/离线用）。 */
  readonly warn?: WireCacheWarn;
  /** 时钟注入（测试确定性；缺省 Date.now）。 */
  readonly now?: () => number;
}

/** 每会话发线面缓存（单进程单写者由会话域天然保证；跨会话并发写不同文件，无冲突）。 */
export class WireCacheStore {
  readonly #dir: string;
  readonly #warn: WireCacheWarn | undefined;
  readonly #now: () => number;

  constructor(opts: WireCacheStoreOptions) {
    this.#dir = opts.dir;
    this.#warn = opts.warn;
    this.#now = opts.now ?? Date.now;
    mkdirSync(this.#dir, { recursive: true });
  }

  /**
   * 原子覆盖写（tmp+rename）。任何异常 = 跳过本条 + warn（发线回合绝不因持久面反噬——
   * core 回调处已有第二层 fail-soft，本层管住 IO 真相）。
   */
  save(sessionID: string, snapshot: WireRequestSnapshot, providerPayload: string | null): void {
    const path = join(this.#dir, wireCacheFileName(sessionID));
    try {
      const record = {
        version: WIRE_CACHE_VERSION,
        savedAt: this.#now(),
        snapshot: redactedSnapshotForDisk(snapshot),
        providerPayload,
      } satisfies WireCacheFileShape;
      const tmp = `${path}.${String(process.pid)}.tmp`;
      writeFileSync(tmp, JSON.stringify(record), "utf8");
      renameSync(tmp, path); // POSIX/ntfs3：rename 目标存在时原子替换（覆盖写语义）
    } catch (err) {
      this.#warn?.("wire-cache save skipped", {
        sessionID,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** 读缓存；缺失/坏 = null（fail-soft + warn）。同步读（单文件 KB 量级，路由现读可承受）。 */
  read(sessionID: string): WireCacheRecord | null {
    const path = join(this.#dir, wireCacheFileName(sessionID));
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      return null; // 文件不存在 = 缓存面缺席（常态，不 warn 刷屏）
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (!isWireCacheRecord(parsed)) {
        this.#warn?.("wire-cache record shape invalid", { sessionID, path });
        return null;
      }
      return parsed;
    } catch (err) {
      this.#warn?.("wire-cache parse failed", {
        sessionID,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }
}

/** 落盘文件顶层形状（version/savedAt/snapshot/providerPayload；与 WIRE_CACHE_VERSION 联动演进）。 */
interface WireCacheFileShape {
  readonly version: number;
  readonly savedAt: number;
  readonly snapshot: WireRequestSnapshot;
  readonly providerPayload: string | null;
}
