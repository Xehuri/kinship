/**
 * manifest 预验（T14）—— 声明产物存在性 + 哈希比对。
 *
 * 验证对象 = 回执声明的产物清单（ManifestEntry[]）：每条声明一个路径，可选声明 sha256。
 * 探针由装配层注入（adapters 文件系统/哈希）；core 测试用 MemoryArtifactProbe。
 * verifyManifest 是**纯函数**，不做任何 IO。
 *
 * 判定（docs/02 §T14「missing manifest ⇒ verification FAIL populated」）：
 *   - 空清单           ⇒ skipped（无声明，不误判 pass）；
 *   - 任一条缺失        ⇒ fail（detail 列明缺失路径）；
 *   - 声明了哈希且不符  ⇒ fail（detail 给出声明值与实得值）；
 *   - 全部存在且哈希匹配 ⇒ pass。
 */

import type {
  ArtifactProbe,
  ArtifactProbeResult,
  ManifestEntry,
  VerificationCheck,
} from "./types.js";

const FILE_PREFIX = "file:" as const;

/**
 * 从 T12 pointers 派生产物声明：仅取 `file:` 前缀条目
 * （`git:` 等非文件指针不参与存在性预验）。空路径条目丢弃。
 */
export function manifestFromPointers(pointers: readonly string[]): ManifestEntry[] {
  const out: ManifestEntry[] = [];
  for (const p of pointers) {
    if (!p.startsWith(FILE_PREFIX)) continue;
    const path = p.slice(FILE_PREFIX.length);
    if (path.length > 0) out.push({ path });
  }
  return out;
}

/** 对声明清单跑存在性 + 哈希预验（纯函数）。 */
export function verifyManifest(
  entries: readonly ManifestEntry[],
  probe: ArtifactProbe,
): VerificationCheck {
  if (entries.length === 0) {
    return { verdict: "skipped", detail: "未声明产物清单，manifest 预验跳过" };
  }

  const problems: string[] = [];
  let hashed = false;
  for (const entry of entries) {
    const result: ArtifactProbeResult = probe.probe(entry.path);
    if (!result.exists) {
      problems.push(`${entry.path}：不存在`);
      continue;
    }
    if (entry.sha256 !== undefined) {
      hashed = true;
      if (result.sha256 === undefined) {
        problems.push(`${entry.path}：声明了哈希但探针未给出内容哈希`);
      } else if (result.sha256 !== entry.sha256) {
        problems.push(
          `${entry.path}：哈希不符（声明 ${entry.sha256}，实得 ${result.sha256}）`,
        );
      }
    }
  }

  if (problems.length > 0) {
    return { verdict: "fail", detail: `产物预验失败：${problems.join("；")}` };
  }
  return {
    verdict: "pass",
    detail: `${entries.length} 件产物全部存在${hashed ? "且哈希匹配" : ""}`,
  };
}

/**
 * 内存产物探针假件（core 测试 + server 装配前占位）。
 * set() 登记一件「存在」产物，可选内容哈希；remove() 撤销。
 */
export class MemoryArtifactProbe implements ArtifactProbe {
  private readonly _files = new Map<string, string | undefined>();

  /** 登记一个存在的产物；sha256 缺省表示「存在但无内容哈希」。 */
  set(path: string, sha256?: string): void {
    this._files.set(path, sha256);
  }

  /** 撤销登记（模拟产物缺失/被删）。 */
  remove(path: string): void {
    this._files.delete(path);
  }

  probe(path: string): ArtifactProbeResult {
    if (!this._files.has(path)) return { exists: false };
    const sha256 = this._files.get(path);
    return sha256 === undefined ? { exists: true } : { exists: true, sha256 };
  }
}
