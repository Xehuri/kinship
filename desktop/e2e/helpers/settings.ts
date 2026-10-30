import { writeFileSync } from 'node:fs'
import type { ElectronApplication } from 'playwright'
import type { DesktopHandle } from './electron.ts'

const POLL_INTERVAL_MS = 100
const DEFAULT_TIMEOUT_MS = 20_000

export interface SettingsPage {
  readonly evaluate: (script: string) => Promise<unknown>
  readonly url: () => Promise<string>
  readonly text: () => Promise<string>
  readonly waitForSelector: (selector: string, timeoutMs?: number) => Promise<void>
  readonly waitForText: (text: string, timeoutMs?: number) => Promise<void>
  readonly click: (selector: string) => Promise<void>
  readonly fill: (selector: string, value: string) => Promise<void>
  readonly select: (selector: string, value: string) => Promise<void>
  readonly check: (selector: string) => Promise<void>
  readonly screenshot: (path: string) => Promise<void>
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

async function waitForLiveSettings(app: ElectronApplication, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const live = await app.evaluate(() => {
      const qa = globalThis.__AXEUH_QA__
      if (qa === undefined) return false
      const settings = qa.controller.getSettingsWebContents()
      return settings !== null && !settings.isDestroyed() && settings.getURL().length > 0
    })
    if (live) return
    await sleep(POLL_INTERVAL_MS)
  }
  throw new Error(`等待设置页 webContents 超时（${timeoutMs}ms）`)
}

async function evaluateScript(app: ElectronApplication, script: string): Promise<unknown> {
  return app.evaluate(async (_electron, source: string) => {
    const qa = globalThis.__AXEUH_QA__
    const settings = qa?.controller.getSettingsWebContents() ?? null
    if (settings === null || settings.isDestroyed()) {
      throw new Error('设置页 webContents 不存在')
    }
    return await settings.executeJavaScript(source, true)
  }, script)
}

async function poll(
  check: () => Promise<boolean>,
  timeoutMs: number,
  message: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown = null
  while (Date.now() < deadline) {
    try {
      if (await check()) return
      lastError = null
    } catch (error) {
      lastError = error
    }
    await sleep(POLL_INTERVAL_MS)
  }
  const suffix = lastError instanceof Error ? `：${lastError.message}` : ''
  throw new Error(`${message}（${timeoutMs}ms）${suffix}`)
}

async function readUrl(app: ElectronApplication): Promise<string> {
  return app.evaluate(() => {
    const qa = globalThis.__AXEUH_QA__
    const settings = qa?.controller.getSettingsWebContents() ?? null
    if (settings === null || settings.isDestroyed()) {
      throw new Error('设置页 webContents 不存在')
    }
    return settings.getURL()
  })
}

async function readText(app: ElectronApplication): Promise<string> {
  const result = await evaluateScript(app, 'document.body === null ? "" : document.body.innerText')
  return typeof result === 'string' ? result : ''
}

async function waitForSelector(
  app: ElectronApplication,
  selector: string,
  timeoutMs: number,
): Promise<void> {
  const script = `document.querySelector(${JSON.stringify(selector)}) !== null`
  await poll(
    async () => (await evaluateScript(app, script)) === true,
    timeoutMs,
    `等待选择器超时：${selector}`,
  )
}

async function waitForText(
  app: ElectronApplication,
  text: string,
  timeoutMs: number,
): Promise<void> {
  const script = `document.body !== null && document.body.innerText.includes(${JSON.stringify(text)})`
  await poll(
    async () => (await evaluateScript(app, script)) === true,
    timeoutMs,
    `等待文本超时：${text}`,
  )
}

async function click(app: ElectronApplication, selector: string): Promise<void> {
  const script = `(() => {
    const element = document.querySelector(${JSON.stringify(selector)})
    if (element === null) return false
    element.click()
    return true
  })()`
  const clicked = await evaluateScript(app, script)
  if (clicked !== true) throw new Error(`设置页找不到可点击元素：${selector}`)
}

async function fill(app: ElectronApplication, selector: string, value: string): Promise<void> {
  const script = `(() => {
    const element = document.querySelector(${JSON.stringify(selector)})
    if (element === null) return false
    const prototype = element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
    if (setter === undefined) return false
    setter.call(element, ${JSON.stringify(value)})
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })()`
  const filled = await evaluateScript(app, script)
  if (filled !== true) throw new Error(`设置页找不到可填写元素：${selector}`)
}

async function select(app: ElectronApplication, selector: string, value: string): Promise<void> {
  const script = `(() => {
    const element = document.querySelector(${JSON.stringify(selector)})
    if (!(element instanceof HTMLSelectElement)) return false
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
    if (setter === undefined) return false
    setter.call(element, ${JSON.stringify(value)})
    element.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })()`
  const selected = await evaluateScript(app, script)
  if (selected !== true) throw new Error(`设置页找不到可选项：${selector}`)
}

async function check(app: ElectronApplication, selector: string): Promise<void> {
  const script = `(() => {
    const element = document.querySelector(${JSON.stringify(selector)})
    if (!(element instanceof HTMLInputElement)) return false
    if (!element.checked) element.click()
    return element.checked
  })()`
  const checked = await evaluateScript(app, script)
  if (checked !== true) throw new Error(`设置页找不到可勾选元素：${selector}`)
}

async function screenshot(app: ElectronApplication, path: string): Promise<void> {
  const base64 = await app.evaluate(async () => {
    const qa = globalThis.__AXEUH_QA__
    const settings = qa?.controller.getSettingsWebContents() ?? null
    if (settings === null || settings.isDestroyed()) {
      throw new Error('设置页 webContents 不存在')
    }
    const image = await settings.capturePage()
    return image.toPNG().toString('base64')
  })
  writeFileSync(path, Buffer.from(base64, 'base64'))
}

export async function getSettingsPage(desktop: DesktopHandle): Promise<SettingsPage> {
  const app = desktop.app
  await waitForLiveSettings(app, DEFAULT_TIMEOUT_MS)
  return {
    evaluate: (script: string) => evaluateScript(app, script),
    url: () => readUrl(app),
    text: () => readText(app),
    waitForSelector: (selector: string, timeoutMs = DEFAULT_TIMEOUT_MS) =>
      waitForSelector(app, selector, timeoutMs),
    waitForText: (text: string, timeoutMs = DEFAULT_TIMEOUT_MS) =>
      waitForText(app, text, timeoutMs),
    click: (selector: string) => click(app, selector),
    fill: (selector: string, value: string) => fill(app, selector, value),
    select: (selector: string, value: string) => select(app, selector, value),
    check: (selector: string) => check(app, selector),
    screenshot: (path: string) => screenshot(app, path),
  }
}
