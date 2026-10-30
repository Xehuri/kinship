import { WebContentsView } from 'electron'
import { logger } from '../lib/logger'
import { applyControlWindowPolicies } from '../shell/navigation'

export interface SettingsViewOptions {
  readonly preloadPath: string
  readonly partition: string
}

function allowedPrefixes(): string[] {
  const prefixes = ['axeuh://bundle/']
  const rendererUrl = process.env.AXEUH_RENDERER_URL?.trim() ?? ''
  if (rendererUrl.length > 0) prefixes.push(rendererUrl.replace(/\/+$/, ''))
  return prefixes
}

/**
 * 本地设置渲染器作为单窗口的覆盖层视图：唯一带 preload 的 webContents，
 * 承载 setup / settings / error 三个路由。
 */
export function createSettingsView(options: SettingsViewOptions): WebContentsView {
  const view = new WebContentsView({
    webPreferences: {
      preload: options.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: options.partition,
    },
  })

  view.setBackgroundColor('#070d18')
  applyControlWindowPolicies(view, allowedPrefixes(), (message, fields) =>
    logger.warn(message, fields),
  )

  return view
}
