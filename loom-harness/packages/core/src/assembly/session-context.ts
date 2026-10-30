/**
 * Per-session context watcher: the session-owned snapshot of its injected memory sources.
 *
 * The watcher polls stat (D16: no fs.watch), reads only files whose stat drifted, and turns the
 * drift into W20 unified-diff notices via the shared diff engine in context-change.ts. It owns
 * only per-session state; an optional ContextBaselineTemplate is shared across sessions so a
 * change consumed by one session is not replayed to sessions registered afterwards.
 *
 * Everything here is synchronous and deterministic. Node fs is touched only through the default
 * stat/read seams; there are no timers, no writes, and no persistence.
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  CONTEXT_NOTICE_BUDGET_BYTES,
  detectContextChanges,
  isContextFileStale,
  seedContextWatermark,
  type ContextChangeAction,
  type ContextChangeOutcome,
  type ContextFileObservation,
  type ContextFileSeed,
  type ContextWatermark,
  type ContextWatermarkEntry,
} from "./context-change.js";

/** One injected source as loaded for this session. content null = declared but not loaded. */
export interface SessionContextSource {
  readonly relPath: string;
  readonly content: string | null;
  readonly mtimeMs?: number;
  readonly size?: number;
}

/** Synthetic source (e.g. skills catalog) whose "stat" is a reload revision + UTF-8 byte count. */
export interface SessionContextDynamicSource {
  readonly relPath: string;
  readonly rescan?: () => void;
  readonly snapshot: () => { readonly text: string; readonly revision: number } | null;
}

/** Non-mutating detection snapshot; generation invalidation is decided by consume(). */
export interface SessionContextPreview {
  readonly actions: readonly ContextChangeAction[];
  readonly notices: readonly string[];
  readonly noticeBytes: readonly number[];
  readonly observations: readonly ContextFileObservation[];
  readonly generation: number;
}

export interface SessionContextWatcherOptions {
  readonly workspaceRoot: string;
  readonly sources: readonly SessionContextSource[];
  readonly dynamicSources?: readonly SessionContextDynamicSource[];
  readonly template?: ContextBaselineTemplate;
  readonly budgetBytes?: number;
  readonly statFile?: (absPath: string) => { readonly mtimeMs: number; readonly size: number } | null;
  readonly readTextFile?: (absPath: string) => string | null;
  readonly onOutcome?: (outcome: ContextChangeOutcome) => void;
}

export type ContextBaseline = readonly SessionContextSource[];

/** Non-null marker value: seedContextWatermark treats it as "was loaded". */
const SEEDED_BOOT_HASH = "session-context";

/** Baseline entry for a source, using -1/byteLength when the caller has no stat hint. */
function baselineEntry(source: SessionContextSource): ContextWatermarkEntry | null {
  if (source.content === null) return null;
  return {
    mtimeMs: source.mtimeMs ?? -1,
    size: source.size ?? Buffer.byteLength(source.content, "utf8"),
    content: source.content,
  };
}

/**
 * Shared W16-D template: the latest consumed state across all sessions. New sessions snapshot it
 * as their baseline so already-delivered diffs are never replayed; live sessions keep their own
 * copy and only push their consumed observations here.
 */
export class ContextBaselineTemplate {
  readonly #entries: Map<string, ContextWatermarkEntry>;

  constructor(seed?: ContextWatermark) {
    this.#entries = new Map<string, ContextWatermarkEntry>();
    if (seed !== undefined) {
      for (const [relPath, entry] of seed) this.#entries.set(relPath, entry);
    }
  }

  snapshot(): ContextWatermark {
    return new Map(this.#entries);
  }

  advance(observations: readonly ContextFileObservation[]): void {
    for (const observation of observations) {
      if (observation.present === false) {
        this.#entries.delete(observation.relPath);
        continue;
      }
      this.#entries.set(observation.relPath, {
        mtimeMs: observation.mtimeMs,
        size: observation.size,
        content: observation.content,
      });
    }
  }

  advanceBaseline(baseline: ContextBaseline): void {
    for (const source of baseline) {
      const entry = baselineEntry(source);
      if (entry !== null) this.#entries.set(source.relPath, entry);
    }
  }

  remove(relPaths: readonly string[]): void {
    for (const relPath of relPaths) this.#entries.delete(relPath);
  }
}

export class SessionContextWatcher {
  readonly #workspaceRoot: string;
  readonly #sources: readonly SessionContextSource[];
  readonly #dynamicSources: readonly SessionContextDynamicSource[];
  readonly #template: ContextBaselineTemplate | undefined;
  readonly #budgetBytes: number;
  readonly #statFile: (
    absPath: string,
  ) => { readonly mtimeMs: number; readonly size: number } | null;
  readonly #readTextFile: (absPath: string) => string | null;
  readonly #onOutcome: ((outcome: ContextChangeOutcome) => void) | undefined;
  #watermark: Map<string, ContextWatermarkEntry>;
  #generation = 0;

  constructor(opts: SessionContextWatcherOptions) {
    this.#workspaceRoot = opts.workspaceRoot;
    this.#sources = [...opts.sources];
    this.#dynamicSources = [...(opts.dynamicSources ?? [])];
    this.#template = opts.template;
    this.#budgetBytes = opts.budgetBytes ?? CONTEXT_NOTICE_BUDGET_BYTES;
    this.#statFile = opts.statFile ?? defaultStatFile;
    this.#readTextFile = opts.readTextFile ?? defaultReadTextFile;
    this.#onOutcome = opts.onOutcome;

    // Seed order: shared template -> static sources it does not cover -> dynamic snapshots it
    // does not cover. A new session therefore starts at the newest already-consumed state.
    const watermark = new Map<string, ContextWatermarkEntry>();
    if (opts.template !== undefined) {
      for (const [relPath, entry] of opts.template.snapshot()) watermark.set(relPath, entry);
    }
    const seeds: ContextFileSeed[] = opts.sources.map((source) =>
      source.content === null
        ? { relPath: source.relPath, bootHash: null, mtimeMs: null, size: null }
        : {
            relPath: source.relPath,
            bootHash: SEEDED_BOOT_HASH,
            mtimeMs: source.mtimeMs ?? -1,
            size: source.size ?? Buffer.byteLength(source.content, "utf8"),
            content: source.content,
          },
    );
    for (const [relPath, entry] of seedContextWatermark(seeds)) {
      if (!watermark.has(relPath)) watermark.set(relPath, entry);
    }
    for (const dynamic of this.#dynamicSources) {
      if (watermark.has(dynamic.relPath)) continue;
      const snapshot = dynamic.snapshot();
      if (snapshot === null) continue;
      watermark.set(dynamic.relPath, {
        mtimeMs: snapshot.revision,
        size: Buffer.byteLength(snapshot.text, "utf8"),
        content: snapshot.text,
      });
    }
    this.#watermark = watermark;
  }

  get generation(): number {
    return this.#generation;
  }

  get watermark(): ContextWatermark {
    return this.#watermark;
  }

  /** Detect without advancing; null only when no source stat drifted. */
  peek(): SessionContextPreview | null {
    const observations = this.#collect();
    if (observations.length === 0) return null;
    const detected = detectContextChanges(observations, this.#watermark, this.#budgetBytes);
    return {
      actions: detected.actions,
      notices: detected.notices,
      noticeBytes: detected.noticeBytes,
      observations,
      generation: this.#generation,
    };
  }

  /**
   * Commit exactly the previewed observations. A preview from an older generation is stale and
   * falls back to a fresh check; its notices are surfaced so the admission frame stays truthful.
   * The caller (registry) already published the admission frame, so no onOutcome here.
   */
  consume(preview: SessionContextPreview): {
    readonly outcome: ContextChangeOutcome | null;
    readonly stalePreviewNotices: readonly string[];
  } {
    if (preview.generation !== this.#generation) {
      return { outcome: this.check(), stalePreviewNotices: preview.notices };
    }
    const outcome = detectContextChanges(
      preview.observations,
      this.#watermark,
      this.#budgetBytes,
    );
    this.#watermark = outcome.watermark;
    this.#template?.advance(preview.observations);
    return { outcome, stalePreviewNotices: [] };
  }

  /** Fresh collect + detect + watermark/template advance, publishing non-empty outcomes. */
  check(): ContextChangeOutcome | null {
    const observations = this.#collect();
    if (observations.length === 0) return null;
    const outcome = detectContextChanges(observations, this.#watermark, this.#budgetBytes);
    this.#watermark = outcome.watermark;
    this.#template?.advance(observations);
    if (outcome.actions.length > 0) this.#onOutcome?.(outcome);
    return outcome;
  }

  /** Rebase the per-session baseline (session start / compaction resync); invalidates previews. */
  reseed(baseline: ContextBaseline): void {
    const staticPaths = new Set<string>();
    for (const source of this.#sources) staticPaths.add(source.relPath);
    const baselinePaths = new Set<string>();
    for (const source of baseline) {
      if (source.content !== null) baselinePaths.add(source.relPath);
    }

    const next = new Map<string, ContextWatermarkEntry>(this.#watermark);
    for (const relPath of staticPaths) {
      if (!baselinePaths.has(relPath)) next.delete(relPath);
    }
    for (const source of baseline) {
      const entry = baselineEntry(source);
      if (entry !== null) next.set(source.relPath, entry);
    }
    this.#watermark = next;
    this.#generation += 1;

    this.#template?.advanceBaseline(baseline);
    this.#template?.remove(
      [...staticPaths].filter((relPath) => !baselinePaths.has(relPath)),
    );
  }

  #collect(): ContextFileObservation[] {
    const observations: ContextFileObservation[] = [];
    for (const source of this.#sources) {
      const absPath = join(this.#workspaceRoot, source.relPath);
      const stat = this.#statFile(absPath);
      if (stat === null) {
        if (this.#watermark.has(source.relPath)) {
          observations.push({ relPath: source.relPath, present: false });
        }
        continue;
      }
      if (!isContextFileStale(this.#watermark, source.relPath, stat.mtimeMs, stat.size)) continue;
      const content = this.#readTextFile(absPath);
      if (content === null) {
        if (this.#watermark.has(source.relPath)) {
          observations.push({ relPath: source.relPath, present: false });
        }
        continue;
      }
      observations.push({
        relPath: source.relPath,
        present: true,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        content,
      });
    }

    for (const dynamic of this.#dynamicSources) {
      try {
        dynamic.rescan?.();
      } catch {
        continue;
      }
      const snapshot = dynamic.snapshot();
      if (snapshot === null) continue;
      const size = Buffer.byteLength(snapshot.text, "utf8");
      const prior = this.#watermark.get(dynamic.relPath);
      if (
        prior !== undefined &&
        prior.mtimeMs === snapshot.revision &&
        prior.size === size &&
        prior.content === snapshot.text
      ) {
        continue;
      }
      observations.push({
        relPath: dynamic.relPath,
        present: true,
        mtimeMs: snapshot.revision,
        size,
        content: snapshot.text,
      });
    }
    return observations;
  }
}

function defaultStatFile(
  absPath: string,
): { readonly mtimeMs: number; readonly size: number } | null {
  try {
    const stat = statSync(absPath);
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return null;
  }
}

function defaultReadTextFile(absPath: string): string | null {
  try {
    return readFileSync(absPath, "utf8");
  } catch {
    return null;
  }
}
