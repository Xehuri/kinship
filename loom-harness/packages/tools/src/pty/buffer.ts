/**
 * Character-based ring buffer for PTY output.
 *
 * Semantics ported from the reference PTY plugin: raw text is stored verbatim
 * (ANSI sequences included), lines split on "\n" only, and a trailing partial
 * line stays invisible until a newline arrives or flushPartial() is called.
 */
const DEFAULT_MAX_CHARS = 1_000_000;

export interface ReadResult {
  lines: string[];
  totalLines: number;
  offset: number;
  hasMore: boolean;
}

export interface SearchMatch {
  lineNumber: number;
  text: string;
}

export class RingBuffer {
  private text = "";
  private readonly maxChars: number;

  constructor(maxChars: number = DEFAULT_MAX_CHARS) {
    this.maxChars = maxChars;
  }

  append(chunk: string): void {
    if (chunk.length === 0) return;
    this.text += chunk;
    if (this.text.length > this.maxChars) {
      this.text = this.text.slice(this.text.length - this.maxChars);
    }
  }

  get size(): number {
    return this.text.length;
  }

  get length(): number {
    return this.completeLines().length;
  }

  read(offset = 0, limit = 500): ReadResult {
    const completeLines = this.completeLines();
    const totalLines = completeLines.length;
    if (limit <= 0) {
      return { lines: [], totalLines, offset, hasMore: false };
    }
    const lines = completeLines.slice(offset, offset + limit);
    return {
      lines,
      totalLines,
      offset,
      hasMore: offset + lines.length < totalLines,
    };
  }

  search(
    pattern: string,
    ignoreCase = false,
  ): { matches: SearchMatch[]; totalMatches: number } {
    const regex = new RegExp(pattern, ignoreCase ? "i" : "");
    const matches: SearchMatch[] = [];
    for (const [index, line] of this.completeLines().entries()) {
      if (regex.test(line)) {
        matches.push({ lineNumber: index + 1, text: line });
      }
    }
    return { matches, totalMatches: matches.length };
  }

  flushPartial(): void {
    if (this.text.length > 0 && !this.text.endsWith("\n")) {
      this.text += "\n";
    }
  }

  clear(): void {
    this.text = "";
  }

  snapshot(): string {
    return this.text;
  }

  private completeLines(): string[] {
    if (this.text.length === 0) return [];
    const lines = this.text.split("\n");
    // The last element is either the "" after the final "\n" or an incomplete
    // tail without a newline; neither counts as a complete line.
    lines.pop();
    return lines;
  }
}
