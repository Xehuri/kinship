const DEFAULT_PAYLOAD_LIMIT = 300;
const NESTED_PAYLOAD_LIMIT = 80;

export function plainInline(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(/\s+/g, " ").trim();
}

export function plainBlock(value: string): string {
  const lines = value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""));
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]?.trim() === "") start += 1;
  while (end > start && lines[end - 1]?.trim() === "") end -= 1;
  return lines.slice(start, end).join("\n");
}

export function formatPayload(value: unknown, limit = DEFAULT_PAYLOAD_LIMIT): string {
  return clipText(formatPayloadValue(value), limit);
}

function formatPayloadValue(value: unknown): string {
  if (value === undefined || value === null) return "none";
  if (typeof value === "string") return plainInline(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value.map((item) => formatPayload(item, NESTED_PAYLOAD_LIMIT)).join(", ");
  }
  if (typeof value === "object") {
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) {
      return Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => `${key}=${formatPayload(entry, NESTED_PAYLOAD_LIMIT)}`)
        .join(", ");
    }
  }
  return String(value);
}

export function formatCoverage(coverage: {
  readonly profile: string;
  readonly checkpoints: readonly string[];
  readonly debt: readonly string[];
}): string {
  const checkpoints =
    coverage.checkpoints.length > 0 ? coverage.checkpoints.join(",") : "none";
  const debt = coverage.debt.length > 0 ? coverage.debt.join(";") : "none";
  return `profile=${coverage.profile} checkpoints=${checkpoints} debt=${debt}`;
}

export function formatIso(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toISOString();
}

export function clipText(value: string, limit: number): string {
  if (limit <= 0) return "";
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}…(+${value.length - limit})`;
}

export function countBy<T>(items: readonly T[], key: (item: T) => string): string {
  const counts = new Map<string, number>();
  for (const item of items) {
    const name = key(item);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  if (counts.size === 0) return "none";
  return [...counts.entries()]
    .sort(
      ([leftKey, leftCount], [rightKey, rightCount]) =>
        rightCount - leftCount ||
        (leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0),
    )
    .map(([name, count]) => `${name} ${count}`)
    .join(", ");
}
