/**
 * W16/W20 上下文变更嗅探 —— 纯 diff/notice 模块（零 IO、确定性、可独立评测）。
 *
 * 背景（W15-B）：主会话装配前缀在 loop 创建时冻结（sha256(sent)===prefixHash 由测试钉死），
 * 而 MAIN_SESSION_GLOBS 注入源文件（W33 起 = AGENTS.md 单件；机制对任意清单数量成立）
 * 仍会演化。用户口径：既有会话**绝不改写已加载上下文**；
 * 源文件变了只把"变更增量"注入新轮次增量之首。本模块产那支增量：输入 = IO 层（registry 准入点）
 * stat/read 好的逐文件观测，输出 = notice 组 + 推进后的水位。
 *
 * W20 用户判词："上下文增量 diff 不是要全量发给 ai，而是只发送差异段。所以叫 diff"——
 * replace 通知从 dsh-verbatim 全文搬运改为**真 unified 行级差异块**，基线 = 本会话上次
 * 已被告知的内容（水位条目携带 last-delivered 全文文本；memory 成本 ≈ 单文件全文 × 会话数，
 * W14 五件 ≈55KB/会话 量级、W33 收缩为 AGENTS.md 单件后更低，决策已接受并在此留痕）。
 * set/remove 语义不变（set 的整文件本身
 * 就是它的 delta；首见 = boot 没吃过它）。
 *
 * 清单收缩安全（W33 立此存照）：观测面**只由现清单（seed.files）生成**，水位永不被
 * 迭代成观测——已退役文件的退役前水位若残存，只被 `next = new Map(watermark)` 原样
 * 携带，绝不产出 remove/replace（remove 唯一致病路径 = **清单内**文件的 present:false
 * 观测）。水位为纯内存面（重启即由新 boot 种子重建，无盘上残留），故五件→单件升级
 * 首轮零幻影通报——此不变量由 context-change.test.ts 的 W33 用例钉死。
 *
 * 水位口径 = docs/01 D16（NTFS/WSL2 inotify 不可靠是环境事实，禁接 fs.watch/hotreload）：
 * 轮询 mtime+size 双字段水位线，任一失配即判变（content 只作 diff 基线，不参与 stat 门）；
 * 水位无条目 ⇒ 首见（boot 缺位/降级文件后来出现走 set 而非 replace）。
 * **touch-无变零发**：判变后复读发现内容逐字相等（mtime 粒度碰撞/无改存盘）⇒ 不发 notice，
 * 只把 stat 对齐到现盘——既消噪音，又绝不定格"复读放大器"（见 detectContextChanges）。
 *
 * notice 模板（英文头，进模型字节不走人话翻译；包裹层 <system-reminder> 是模型侧稳定的
 * 增量信道标记）：内容里的字面 `</system-reminder>` 转义为 `<\/system-reminder>`，
 * 防文件内容伪造闭合标签越狱包裹层。预算：整组 notice 文本 UTF-8 ≤ budgetBytes（默认 64KB），
 * 超限从**最旧文件条目**（清单头部）起丢并尾部追加一行截断标记；被丢条目的水位照样推进
 * （一次嗅探=一次消费，绝不因截断在下轮重发）。W20 起 replace 载 diff 而非全文，天然极小
 * ——截断路径保留（极端场景：一次嗅探内多文件各数百行改动），现实难触发。
 *
 * 确定性：无时钟、无随机、不重排输入（动作序=观测序=声明序，memory-declaration 的
 * 前缀慢→快纪律贯穿到 notice 组）⇒ 同输入双跑字节全等（含 LCS 平局选择器）。
 *
 * fail-soft 归 IO 层（registry#collectContextNotices）：stat/read 失败一律折算成
 * present:false 观测进来；本模块信任观测形状，不做防御复检。
 */

/**
 * 单文件水位条目：D16 轮询两字段（mtime 粗到跟不动时 size 兜底，互备）+ W20 diff 基线。
 * content = 本会话**上次已交付**的文件全文（boot 种子=实载文本；每次发出变更推进到现盘）。
 * 内存口径：清单全文（W33 起单件 AGENTS.md；W14 五件时代 ≈55KB）× 会话数量级——
 * 决策已接受（会话数十，MB 级封顶，纯内存重启清空）。
 */
export interface ContextWatermarkEntry {
  readonly mtimeMs: number;
  readonly size: number;
  readonly content: string;
}

/** 每注册表一份的水位表：relPath → 上次确认已加载/已消费的观测值。无条目 = 从未加载。 */
export type ContextWatermark = ReadonlyMap<string, ContextWatermarkEntry>;

/**
 * boot 种子项（server 侧 boot 建：MemorySource 实载内容 → content/bootHash；
 * 同刻 stat → mtime+size）。bootHash/mtime/size 任一为 null = 该源 boot 未真正加载
 * （缺失/降级/stat 失败），不进水位——后续出现按"首见 set"处理。
 * content 可选（W16-D 旧形状直传兼容）：缺省按 "" 基线（实载件应始终给足，基线 "" 时
 * 首条 replace 的 diff = 全 '+' hunk，仍正确只是块偏大）。
 */
export interface ContextFileSeed {
  readonly relPath: string;
  readonly bootHash: string | null;
  readonly mtimeMs: number | null;
  readonly size: number | null;
  readonly content?: string;
}

/** 准入点单文件观测（IO 层产出）：present 仅在"判变"时携带 content（省 NTFS 读放大）。 */
export type ContextFileObservation =
  | {
      readonly relPath: string;
      readonly present: true;
      readonly mtimeMs: number;
      readonly size: number;
      readonly content: string;
    }
  | { readonly relPath: string; readonly present: false };

/**
 * 单文件变更动作（同文件多观测已合并，一文件至多一条）。
 * replace 载荷 = **差异块**（非现盘全文，W20）；set 载荷 = 全文（首见无基线可对，整文件即 delta）。
 */
export type ContextChangeAction =
  | { readonly kind: "set"; readonly relPath: string; readonly content: string }
  | { readonly kind: "replace"; readonly relPath: string; readonly diff: string }
  | { readonly kind: "remove"; readonly relPath: string };

/**
 * 嗅探结局：notice 组（进 prelude 的字符串，已包裹+已截断）+ 推进后的新水位。
 * noticeBytes 与 actions 逐位对齐 = 各动作**最终 notice 文本（含包裹+转义）的 UTF-8 字节**
 * ——W17-F context.notice 帧 bytes 的消费源；预算截断后仍覆盖全部检出动作（帧记
 * "变了什么"，非"注了几条"）。
 */
export interface ContextChangeOutcome {
  readonly actions: readonly ContextChangeAction[];
  readonly notices: readonly string[];
  readonly noticeBytes: readonly number[];
  readonly watermark: Map<string, ContextWatermarkEntry>;
}

/** notice 组整组 UTF-8 字节预算（dsh agent-instructions 同档：超限丢旧不丢新轮用户消息）。 */
export const CONTEXT_NOTICE_BUDGET_BYTES = 64 * 1024;

/**
 * W25 skills catalog 合成源的保留 relPath：技能热重载把"catalog 块文本"当**虚拟文件**
 * 进同一水位/diff 通路。盘上永不存在该路径——memory glob 的 explicit-file 声明要求末段
 * 带扩展名（"catalog" 无点、只会按目录前缀展开成 "skills/xxx"），二者不可能撞车。
 * 水位字段口径：mtimeMs 槽 = loader 重载代号（每成功 reload +1），size = catalog 块
 * UTF-8 字节，content = 上次已交付块文本（W20 同语义；正文绝不入任何面）。
 */
export const SKILLS_CATALOG_REL_PATH = "skills/catalog";

const SYSTEM_REMINDER_OPEN = "<system-reminder>";
const SYSTEM_REMINDER_CLOSE = "</system-reminder>";
/** 闭合标签的字面转义形态：反斜杠隔断 `<` 与 `/` 邻接，模型侧不再解析为闭合。 */
const SYSTEM_REMINDER_CLOSE_ESCAPED = "<\\/system-reminder>";

const encoder = new TextEncoder();

/** boot 种子 → 初始水位：只吃"boot 实载且 stat 在场"的文件（其余留空 = 首见 set 语义）。 */
export function seedContextWatermark(
  seeds: readonly ContextFileSeed[],
): Map<string, ContextWatermarkEntry> {
  const out = new Map<string, ContextWatermarkEntry>();
  for (const s of seeds) {
    if (s.bootHash === null || s.mtimeMs === null || s.size === null) continue;
    out.set(s.relPath, { mtimeMs: s.mtimeMs, size: s.size, content: s.content ?? "" });
  }
  return out;
}

/** D16 水位失配判定：无条目=变（首见）；mtime 或 size 任一不等=变。 */
export function isContextFileStale(
  watermark: ContextWatermark,
  relPath: string,
  mtimeMs: number,
  size: number,
): boolean {
  const prior = watermark.get(relPath);
  if (prior === undefined) return true;
  return prior.mtimeMs !== mtimeMs || prior.size !== size;
}

/**
 * 主入口：观测组 vs 水位 → 动作 + notice + 新水位（一次消费，变更恰发一次）。
 * 观测序即声明序（IO 层按 seed.files 清单序喂入）；同路径重复观测 latest-per-file
 * 合并：末次观测决定动作内容，首见位置保留（不重排 = 确定性）。
 * replace 的 diff 基线 = 本水位条目的 content（本会话上次已交付全文）。
 */
export function detectContextChanges(
  observations: readonly ContextFileObservation[],
  watermark: ContextWatermark,
  budgetBytes: number = CONTEXT_NOTICE_BUDGET_BYTES,
): ContextChangeOutcome {
  const next = new Map<string, ContextWatermarkEntry>(watermark);
  const merged = new Map<string, ContextFileObservation>();
  for (const o of observations) merged.set(o.relPath, o); // 同键复写保首位置，值取末次

  const actions: ContextChangeAction[] = [];
  for (const [relPath, obs] of merged) {
    const prior = next.get(relPath);
    if (obs.present === false) {
      if (prior === undefined) continue; // 从未加载的文件不存在 = 无事发生
      actions.push({ kind: "remove", relPath });
      next.delete(relPath);
      continue;
    }
    if (prior !== undefined && prior.mtimeMs === obs.mtimeMs && prior.size === obs.size) {
      continue; // 水位全等 = 未变
    }
    if (prior !== undefined && prior.content === obs.content) {
      // touch-无变零发（W20）：stat 动了而文本逐字相等（mtime 粒度碰撞/无改存盘）⇒ 不发 notice；
      // 只对齐 mtime+size（基线文本本就相同）——否则下轮准入又判变又复读，噪音变复读放大器。
      next.set(relPath, { mtimeMs: obs.mtimeMs, size: obs.size, content: prior.content });
      continue;
    }
    actions.push(
      prior === undefined
        ? { kind: "set", relPath, content: obs.content }
        : { kind: "replace", relPath, diff: unifiedLineDiff(prior.content, obs.content) },
    );
    // 水位随载：文本推进到现盘全文（= 本会话下一次 diff 的基线）。
    next.set(relPath, { mtimeMs: obs.mtimeMs, size: obs.size, content: obs.content });
  }

  const texts = actions.map((a) => wrapSystemReminder(escapeCloseTag(renderBlock(a))));
  const notices = renderNoticeSet(actions.map((a, i) => ({ relPath: a.relPath, text: texts[i]! })), budgetBytes);
  return { actions, notices, noticeBytes: texts.map(bytesOf), watermark: next };
}

/* ────────────── W20 行级 unified diff（纯函数，零依赖） ────────────── */

/** 上下文行数（git 缺省 3：模型够定位，notice 够短）。 */
const DIFF_CONTEXT_LINES = 3;
/** LCS 动态表格数上限：本模块面向 ≤25KB 记忆文件，常规编辑被公共前后缀剪枝后中段极小；
 *  整篇重写 ⇒ 中段仍大时降级为"整段删+插"（仍是合法 diff，确定性选择器），O(格) 不爆内存。 */
const DIFF_LCS_CELL_BUDGET = 4_000_000;

type DiffOp = { readonly kind: "eq" | "del" | "ins"; readonly line: string };

/**
 * 按 \n 切段、换行归属行尾："a\nb"⇒["a\n","b"]（末行无 \n = 文件无尾换行，hunk 出
 * `\ No newline at end of file` 如实标记）；"a\n"⇒["a\n"]；""⇒零行。
 * \r 是普通行内容（CRLF 逐字节保真，绝不做换行归一——记忆文件混用行尾时 diff 不撒谎）。
 */
function splitLines(text: string): readonly string[] {
  const out: string[] = [];
  let start = 0;
  for (;;) {
    const nl = text.indexOf("\n", start);
    if (nl === -1) {
      if (start < text.length) out.push(text.slice(start));
      return out;
    }
    out.push(text.slice(start, nl + 1));
    start = nl + 1;
  }
}

/** 公共前后缀剪枝 + 中段 LCS ⇒ 全文件 op 序列。相同行 O(n) 早退（大文件一行改动只留编辑窗）。 */
function editOps(oldLines: readonly string[], newLines: readonly string[]): DiffOp[] {
  let head = 0;
  while (
    head < oldLines.length &&
    head < newLines.length &&
    oldLines[head] === newLines[head]
  ) {
    head++;
  }
  let tail = 0;
  while (
    tail < oldLines.length - head &&
    tail < newLines.length - head &&
    oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]
  ) {
    tail++;
  }
  const ops: DiffOp[] = [];
  for (let i = 0; i < head; i++) ops.push({ kind: "eq", line: oldLines[i]! });
  ops.push(
    ...midOps(oldLines.slice(head, oldLines.length - tail), newLines.slice(head, newLines.length - tail)),
  );
  for (let i = oldLines.length - tail; i < oldLines.length; i++) ops.push({ kind: "eq", line: oldLines[i]! });
  return ops;
}

/** 中段编辑脚本：LCS 长度表（suffix 语义）回溯；平局先删后插 = 确定性字节序选择器。 */
function midOps(oldMid: readonly string[], newMid: readonly string[]): DiffOp[] {
  if (oldMid.length === 0) {
    return newMid.map((line) => ({ kind: "ins", line }) as const satisfies DiffOp);
  }
  if (newMid.length === 0) {
    return oldMid.map((line) => ({ kind: "del", line }) as const satisfies DiffOp);
  }
  const cols = newMid.length + 1;
  if ((oldMid.length + 1) * cols > DIFF_LCS_CELL_BUDGET) {
    // 灾难护栏：整段纯替换（先删旧段后插新段，确定性；行数上限不变，只是块更粗）。
    return [
      ...oldMid.map((line) => ({ kind: "del", line }) as const satisfies DiffOp),
      ...newMid.map((line) => ({ kind: "ins", line }) as const satisfies DiffOp),
    ];
  }
  const lcs = new Uint32Array((oldMid.length + 1) * cols);
  for (let i = oldMid.length - 1; i >= 0; i--) {
    for (let j = newMid.length - 1; j >= 0; j--) {
      lcs[i * cols + j] =
        oldMid[i] === newMid[j]
          ? lcs[(i + 1) * cols + j + 1]! + 1
          : Math.max(lcs[(i + 1) * cols + j]!, lcs[i * cols + j + 1]!);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < oldMid.length && j < newMid.length) {
    if (oldMid[i] === newMid[j]) {
      ops.push({ kind: "eq", line: oldMid[i]! });
      i++;
      j++;
    } else if (lcs[(i + 1) * cols + j]! >= lcs[i * cols + j + 1]!) {
      ops.push({ kind: "del", line: oldMid[i]! });
      i++;
    } else {
      ops.push({ kind: "ins", line: newMid[j]! });
      j++;
    }
  }
  while (i < oldMid.length) {
    ops.push({ kind: "del", line: oldMid[i]! });
    i++;
  }
  while (j < newMid.length) {
    ops.push({ kind: "ins", line: newMid[j]! });
    j++;
  }
  return ops;
}

/** 单 op 的物理行渲染：" "/"-"/"+" 前缀；无尾换行行如实跟 `\ No newline at end of file`。 */
function renderOpLines(op: DiffOp): string[] {
  const marker = op.kind === "eq" ? " " : op.kind === "del" ? "-" : "+";
  const withNewline = op.line.endsWith("\n");
  const body = withNewline ? op.line.slice(0, -1) : op.line;
  const out = [`${marker}${body}`];
  if (!withNewline) out.push("\\ No newline at end of file");
  return out;
}

/**
 * op 序列 → unified 差异块文本（hunk 头 + ±3 上下文，多 hunk 依序 "\n" 拼接，
 * 整体无尾换行）。零计数侧的起点 = 前行数（git 口径 `-0,0` / `+0,0`）。
 * 并块纪律：扩张窗**严格重叠**才并（相隔恰 2×context 等行 ⇒ 相邻两块，不吞边界）。
 */
function renderHunks(ops: readonly DiffOp[]): string {
  const runs: Array<{ start: number; end: number }> = [];
  let runStart = -1;
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    if (op.kind === "eq") {
      if (runStart !== -1) {
        runs.push({ start: runStart, end: i });
        runStart = -1;
      }
    } else if (runStart === -1) {
      runStart = i;
    }
  }
  if (runStart !== -1) runs.push({ start: runStart, end: ops.length });
  if (runs.length === 0) return "";

  // op→行号前缀计数：preOld/preNew[i] = ops[i] 之前已消费的旧/新行数。
  const preOld: number[] = new Array<number>(ops.length + 1);
  const preNew: number[] = new Array<number>(ops.length + 1);
  let oc = 0;
  let nc = 0;
  for (let i = 0; i < ops.length; i++) {
    preOld[i] = oc;
    preNew[i] = nc;
    const op = ops[i]!;
    if (op.kind !== "ins") oc++;
    if (op.kind !== "del") nc++;
  }
  preOld[ops.length] = oc;
  preNew[ops.length] = nc;

  const hunks: Array<{ s: number; e: number }> = [];
  for (const run of runs) {
    const s = Math.max(0, run.start - DIFF_CONTEXT_LINES);
    const e = Math.min(ops.length, run.end + DIFF_CONTEXT_LINES);
    const last = hunks[hunks.length - 1];
    if (last !== undefined && s < last.e) last.e = e; // 严格重叠才并块
    else hunks.push({ s, e });
  }

  const chunks: string[] = [];
  for (const h of hunks) {
    let bOld = 0;
    let bNew = 0;
    for (let i = h.s; i < h.e; i++) {
      const op = ops[i]!;
      if (op.kind !== "ins") bOld++;
      if (op.kind !== "del") bNew++;
    }
    const aOld = bOld > 0 ? preOld[h.s]! + 1 : preOld[h.s]!;
    const aNew = bNew > 0 ? preNew[h.s]! + 1 : preNew[h.s]!;
    const lines = [`@@ -${aOld},${bOld} +${aNew},${bNew} @@`];
    for (let i = h.s; i < h.e; i++) lines.push(...renderOpLines(ops[i]!));
    chunks.push(lines.join("\n"));
  }
  return chunks.join("\n");
}

/** 基线全文 vs 现盘全文 → unified 差异块（replace 通知载荷；空 diff 只可能内容相等，上游已拦）。 */
function unifiedLineDiff(oldText: string, newText: string): string {
  return renderHunks(editOps(splitLines(oldText), splitLines(newText)));
}

/* ────────────── notice 渲染（内部） ────────────── */

/** notice 模板（W20：replace=dsh 头+差异块直贴；set/remove 逐字不变）。 */
function renderBlock(action: ContextChangeAction): string {
  switch (action.kind) {
    case "set":
      return `Additional instructions from: ${action.relPath}\n\n${action.content}`;
    case "replace":
      return (
        `Updated instructions from: ${action.relPath}\n\n` +
        "This file changed after it was loaded. Only the differences are shown below; " +
        "everything else remains exactly as previously loaded.\n" +
        action.diff
      );
    case "remove":
      return (
        `Instructions removed: ${action.relPath}\n\n` +
        "The previously loaded instructions from this file no longer apply."
      );
  }
}

/** 内容伪造闭合标签的转义（split/join 全量替换；替换产物不再含原闭合字面量）。 */
function escapeCloseTag(text: string): string {
  return text.split(SYSTEM_REMINDER_CLOSE).join(SYSTEM_REMINDER_CLOSE_ESCAPED);
}

function wrapSystemReminder(block: string): string {
  return `${SYSTEM_REMINDER_OPEN}\n${block}\n${SYSTEM_REMINDER_CLOSE}`;
}

function bytesOf(text: string): number {
  return encoder.encode(text).length;
}

/** 截断标记行：如实列出被丢的最旧条目路径（丢的是"这次不发增量"，不是"变更作废"——
 *  水位照常推进，路径可寻）。 */
function markerText(droppedPaths: readonly string[]): string {
  return wrapSystemReminder(
    `Older context-change notices truncated: ${droppedPaths.join(", ")}`,
  );
}

/** 整组预算装配：头位（声明序最旧文件）起丢直至含标记入预算；标记行是预算下限（永不为空组）。 */
function renderNoticeSet(
  items: readonly { readonly relPath: string; readonly text: string }[],
  budgetBytes: number,
): string[] {
  const pool = [...items];
  const dropped: string[] = [];
  const used = (): number => {
    let total = 0;
    for (const i of pool) total += bytesOf(i.text);
    if (dropped.length > 0) total += bytesOf(markerText(dropped));
    return total;
  };
  while (pool.length > 0 && used() > budgetBytes) {
    const head = pool.shift();
    if (head !== undefined) dropped.push(head.relPath);
  }
  const out = pool.map((i) => i.text);
  if (dropped.length > 0) out.push(markerText(dropped));
  return out;
}
