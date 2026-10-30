/**
 * W23-B 会话元数据 sidecar —— `state/session/meta.json`（每 sid 一条：标题/归档/置顶）。
 *
 * 定位：会话列表"域三件套"的持久面——registry #records 是内存册（重启清空），
 * title/archived/pinned 属**用户声明**，必须跨重启存活 ⇒ 独立小 JSON sidecar。
 * 转录/wire 缓存等大数据面各归各位，本文件只管这份"列表意图"薄数据。
 *
 * 纪律：
 * - **原子覆盖写**（tmp+renameSync，与 wire-cache 同法）；每次变更全量重写（KB 量级，
 *   变更频度=人手动点标题/归档，无写放大顾虑）；
 * - **load-on-boot fail-soft**：构造即读盘；文件缺失/JSON 坏/形状不合 = 空表 + warn
 *   （坏 meta 绝不拖垮 boot，也绝不把半截形状喂进视图）；
 * - 空条目的条目自动删除（patch 后 title/archived/pinned 全无 ⇒ 键整体移除，文件不积垃圾）；
 * - 写侧失败 = warn fail-soft（内存态照常生效，下一次成功写会带上；重启丢最后一次变更
 *   可接受——与全部观测面同纪律）。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** 每 sid 的元数据条目（三字段全可选；缺省语义由消费方定：无 title=未命名，无 archived=未归档）。 */
export interface SessionMetaEntry {
  readonly title?: string;
  readonly archived?: boolean;
  readonly pinned?: boolean;
}

/** meta.json 顶层形状：sid → 条目。 */
export type SessionMetaFile = Readonly<Record<string, SessionMetaEntry>>;

/**
 * mutate 补丁形状（与 SessionMetaEntry 的差别 = **显式允许 undefined 值**：
 * exactOptionalPropertyTypes 下 Partial 不含 undefined，而"键在、值 undefined=删除声明"
 * 正是本 API 的清除语义，必须类型化到补丁面上）。
 */
export interface SessionMetaPatch {
  title?: string | undefined;
  archived?: boolean | undefined;
  pinned?: boolean | undefined;
}

export type SessionMetaWarn = (msg: string, fields: Record<string, unknown>) => void;

export interface SessionMetaStoreOptions {
  /** sidecar 文件绝对/相对路径（boot 传 `state/session/meta.json`；父目录构造时确保）。 */
  readonly file: string;
  /** 读坏/写炸的留痕口（fail-soft 面的观测出口；缺省 = 静默）。 */
  readonly warn?: SessionMetaWarn;
}

function isEntryShape(x: unknown): x is SessionMetaEntry {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return false;
  const e = x as Record<string, unknown>;
  if ("title" in e && typeof e["title"] !== "string") return false;
  if ("archived" in e && typeof e["archived"] !== "boolean") return false;
  if ("pinned" in e && typeof e["pinned"] !== "boolean") return false;
  return true;
}

/**
 * 内存表 + 落盘面的唯一持有者。registry 结构消费本 store（读视图/写变更都经它），
 * 路由端点经 registry 命令面转入——**不经此 store 改盘没有第二条路**（单一写者由
 * 进程内 registry 串行调用保证；跨进程并发不在现网形态内）。
 */
export class SessionMetaStore {
  readonly #file: string;
  readonly #warn: SessionMetaWarn | undefined;
  readonly #entries = new Map<string, SessionMetaEntry>();

  constructor(opts: SessionMetaStoreOptions) {
    this.#file = opts.file;
    this.#warn = opts.warn;
    mkdirSync(dirname(this.#file), { recursive: true });
    this.#load();
  }

  #load(): void {
    let text: string;
    try {
      text = readFileSync(this.#file, "utf8");
    } catch {
      return; // 文件不存在 = 首次启动常态
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("顶层不是 JSON 对象");
      }
      for (const [sid, entry] of Object.entries(parsed as Record<string, unknown>)) {
        if (!isEntryShape(entry)) {
          throw new Error(`条目 ${sid} 形状不合`);
        }
        this.#entries.set(sid, entry);
      }
    } catch (err) {
      // 坏 meta 整表弃（fail-soft corrupt={}）：半表生效比空表更不可解释。
      this.#entries.clear();
      this.#warn?.("session-meta load failed (empty table)", {
        file: this.#file,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  get(sessionID: string): SessionMetaEntry | undefined {
    return this.#entries.get(sessionID);
  }

  has(sessionID: string): boolean {
    return this.#entries.has(sessionID);
  }

  /** 全部已知条目（sid → entry）；视图组装用（sid 集合小，全表遍历可承受）。 */
  entries(): ReadonlyMap<string, SessionMetaEntry> {
    return this.#entries;
  }

  /**
   * 合并补丁并落盘。patch 值为 **undefined 的键删除**（=清除声明）；patch 后条目
   * 全空 ⇒ 键整体移除。返回补丁后的条目（null = 条目已不存在）。
   */
  mutate(sessionID: string, patch: SessionMetaPatch): SessionMetaEntry | null {
    const prev = this.#entries.get(sessionID) ?? {};
    const next: Record<string, string | boolean> = { ...prev };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete next[key];
      else next[key] = value;
    }
    if (Object.keys(next).length === 0) this.#entries.delete(sessionID);
    else this.#entries.set(sessionID, next);
    this.#save();
    return Object.keys(next).length === 0 ? null : next;
  }

  #save(): void {
    const obj: Record<string, SessionMetaEntry> = {};
    for (const [sid, entry] of this.#entries) obj[sid] = entry;
    const tmp = `${this.#file}.${String(process.pid)}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(obj), "utf8");
      renameSync(tmp, this.#file);
    } catch (err) {
      this.#warn?.("session-meta save failed (memory state kept)", {
        file: this.#file,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
