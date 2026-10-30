const DATE_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

export function formatDateTime(value: string | undefined): string {
  if (!value) return '未知'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return DATE_FORMATTER.format(date)
}

export function formatLatency(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '未知'
  return `${Math.max(0, Math.round(value))} ms`
}

export function formatCount(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '0'
  return String(Math.max(0, Math.round(value)))
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url.trim()
  }
}

export function platformLabel(platform: string): string {
  if (platform === 'win32') return 'Windows'
  if (platform === 'darwin') return 'macOS'
  if (platform === 'linux') return 'Linux'
  return platform || '未知'
}

export function chromiumVersion(): string {
  if (typeof navigator === 'undefined') return '未知'
  const match = /Chrome\/([\d.]+)/.exec(navigator.userAgent)
  return match?.[1] ?? '未知'
}
