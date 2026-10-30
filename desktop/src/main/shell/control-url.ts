export type ControlRoute = 'setup' | 'settings' | 'error'

const BUNDLE_ENTRY = 'axeuh://bundle/index.html'

export function buildControlUrl(
  route: ControlRoute,
  query?: Readonly<Record<string, string>>,
  rendererUrl?: string,
): string {
  const devBase = rendererUrl?.trim() ?? ''
  const base =
    devBase.length > 0
      ? `${devBase.replace(/\/+$/, '')}/#/${route}`
      : `${BUNDLE_ENTRY}#/${route}`

  if (query === undefined) return base

  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    params.set(key, value)
  }
  const search = params.toString()
  return search.length > 0 ? `${base}?${search}` : base
}
