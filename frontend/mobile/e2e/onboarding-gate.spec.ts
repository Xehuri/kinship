import { test, expect, type Page, type Route } from '@playwright/test'

/**
 * 一次性引导密码门 E2E（无后端）。
 *
 * 与 e2e/fixtures.ts 不同，本规格不复用那条只返回 needs_setup=false 的
 * setup-status 路由：引导门是否出现还取决于 /api/system/onboarding/status
 * 的 steps/onboarding_complete，以及是否已登录。这里为每个用例显式提供
 * setup-status、onboarding status、preflight 与 verify-password，并让
 * 具体路由覆盖兜底路由（Playwright 中后注册的路由先匹配）。
 */

const TOKEN = 'e2e-onboarding-token'
const CORRECT_PASSWORD = 'correct-onboarding-password'
const WRONG_PASSWORD = 'wrong-onboarding-password'

const STEP_IDS = [
  'welcome',
  'account',
  'dependencies',
  'kernel',
  'kernel_models',
  'xiaomi',
  'qq',
  'moss',
  'loom',
  'clients',
  'finish',
] as const

const STEP_TITLES: Record<(typeof STEP_IDS)[number], string> = {
  welcome: '欢迎',
  account: '管理员账号',
  dependencies: '依赖检查',
  kernel: '音频内核',
  kernel_models: '内核模型',
  xiaomi: '小米健康云',
  qq: 'QQ 网关',
  moss: 'MOSS 深度音频',
  loom: 'AI 助手',
  clients: '客户端',
  finish: '完成',
}

type CurrentStep = 'welcome' | 'account'
type VerifyMode = 'success' | 'wrong_password' | 'rate_limited'

interface VerifyCapture {
  body: unknown
  headers: Record<string, string>
}

interface MockOptions {
  needsSetup: boolean
  currentStep: CurrentStep
  verifyMode?: VerifyMode
}

interface MockState {
  verifyRequests: VerifyCapture[]
}

async function fulfillJson(
  route: Route,
  status: number,
  body: unknown,
): Promise<void> {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
}

function readPassword(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const value = (body as Record<string, unknown>).password
  return typeof value === 'string' ? value : undefined
}

function buildOnboardingSteps(currentStep: CurrentStep) {
  const currentIndex = STEP_IDS.indexOf(currentStep)
  return STEP_IDS.map((id, index) => ({
    id,
    title: STEP_TITLES[id],
    description: '',
    required: true,
    skippable: false,
    state:
      index < currentIndex
        ? ('completed' as const)
        : index === currentIndex
          ? ('current' as const)
          : ('pending' as const),
    auth: 'none',
  }))
}

function buildOnboardingStatus(options: MockOptions) {
  const steps = buildOnboardingSteps(options.currentStep)
  return {
    state: {
      version: 3,
      completed_steps: steps
        .filter((step) => step.state === 'completed')
        .map((step) => step.id),
      skipped_steps: [],
      current_step: options.currentStep,
      completed: false,
      started_at: '2026-10-27T00:00:00Z',
      updated_at: '2026-10-27T00:00:00Z',
    },
    needs_setup: options.needsSetup,
    degraded: false,
    onboarding_complete: false,
    config_revision: 'e2e-config-revision',
    steps,
    bootstrap: false,
    state_version: 3,
    legacy_upgraded: false,
    degraded_reasons: [],
  }
}

const PREFLIGHT = {
  checks: [],
  can_proceed: true,
  blocking_failures: [],
  soft_failures: [],
  summary: { pass: 0, warn: 0, fail: 0 },
}

const CONFIG_SNAPSHOT = {
  revision: 'e2e-config-revision',
  path: '/tmp/e2e-config.yaml',
  provider: {
    kind: 'file',
    location: 'local',
    writable: true,
    detail: 'e2e',
  },
  config: { auth: { setup_require_token: false } },
  degraded: [],
  apply_failures: {},
  schema_version: '1',
}

const CONFIG_SCHEMA = {
  schema_version: '1',
  categories: [],
  fields: [],
}

/**
 * 登录态 + 无后端实时通道。
 * 已安装场景需要 token 才会让 App 自动打开未完成的引导向导；
 * 真实首启（needs_setup=true）保持未登录。
 */
async function installBrowserStubs(page: Page, needsSetup: boolean): Promise<void> {
  if (!needsSetup) {
    await page.addInitScript((token: string) => {
      try {
        localStorage.setItem('mobile_token', token)
      } catch {
        // localStorage 不可用时忽略：本用例运行在正常浏览器上下文
      }
    }, TOKEN)
  }

  await page.addInitScript(() => {
    class StubEventSource {
      static readonly CONNECTING = 0
      static readonly OPEN = 1
      static readonly CLOSED = 2
      readonly CONNECTING = 0
      readonly OPEN = 1
      readonly CLOSED = 2
      readonly url: string
      readyState = 1
      withCredentials = false
      onopen: ((event: Event) => void) | null = null
      onmessage: ((event: MessageEvent) => void) | null = null
      onerror: ((event: Event) => void) | null = null

      constructor(url: string | URL) {
        this.url = String(url)
      }

      close(): void {
        this.readyState = 2
      }

      addEventListener(): void {}
      removeEventListener(): void {}
      dispatchEvent(): boolean {
        return true
      }
    }

    class StubWebSocket {
      static readonly CONNECTING = 0
      static readonly OPEN = 1
      static readonly CLOSING = 2
      static readonly CLOSED = 3
      readonly CONNECTING = 0
      readonly OPEN = 1
      readonly CLOSING = 2
      readonly CLOSED = 3
      readonly url: string
      readyState = 1
      bufferedAmount = 0
      extensions = ''
      protocol = ''
      binaryType = 'blob'
      onopen: ((event: Event) => void) | null = null
      onmessage: ((event: MessageEvent) => void) | null = null
      onerror: ((event: Event) => void) | null = null
      onclose: ((event: CloseEvent) => void) | null = null

      constructor(url: string | URL) {
        this.url = String(url)
      }

      close(): void {
        this.readyState = 3
      }

      send(): void {}
      addEventListener(): void {}
      removeEventListener(): void {}
      dispatchEvent(): boolean {
        return true
      }
    }

    Object.defineProperty(window, 'EventSource', {
      configurable: true,
      writable: true,
      value: StubEventSource,
    })
    Object.defineProperty(window, 'WebSocket', {
      configurable: true,
      writable: true,
      value: StubWebSocket,
    })
  })
}

async function installOnboardingMocks(
  page: Page,
  options: MockOptions,
): Promise<MockState> {
  const state: MockState = { verifyRequests: [] }
  const verifyMode = options.verifyMode ?? 'wrong_password'

  await installBrowserStubs(page, options.needsSetup)

  // 兜底路由最先注册，因此最后匹配；下面所有具体路由都会覆盖它。
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    (route) => fulfillJson(route, 200, {}),
  )

  await page.route(
    (url) => url.pathname === '/api/system/config',
    (route) => fulfillJson(route, 200, CONFIG_SNAPSHOT),
  )

  await page.route(
    (url) => url.pathname === '/api/system/config/schema',
    (route) => fulfillJson(route, 200, CONFIG_SCHEMA),
  )

  await page.route(
    (url) => url.pathname === '/api/system/onboarding/preflight',
    (route) => fulfillJson(route, 200, PREFLIGHT),
  )

  await page.route(
    (url) => url.pathname === '/api/system/onboarding/status',
    (route) => fulfillJson(route, 200, buildOnboardingStatus(options)),
  )

  await page.route(
    (url) => url.pathname === '/auth/setup-status',
    (route) =>
      fulfillJson(route, 200, {
        needs_setup: options.needsSetup,
        require_token: false,
      }),
  )

  await page.route(
    (url) => url.pathname === '/auth/ws-ticket',
    (route) => fulfillJson(route, 200, { ticket: 'e2e-ticket', expires_in: 30 }),
  )

  await page.route(
    (url) => url.pathname === '/auth/verify-password',
    async (route) => {
      const request = route.request()
      let body: unknown = null
      try {
        body = request.postDataJSON()
      } catch {
        body = null
      }
      state.verifyRequests.push({ body, headers: request.headers() })

      if (verifyMode === 'success') {
        if (readPassword(body) === CORRECT_PASSWORD) {
          await fulfillJson(route, 200, { valid: true })
          return
        }
        await fulfillJson(route, 403, {
          code: 'password_invalid',
          message: '密码错误',
        })
        return
      }

      if (verifyMode === 'rate_limited') {
        await fulfillJson(route, 429, {
          code: 'rate_limited',
          message: '尝试次数过多，请 12 秒后再试',
          retry_after: 12,
        })
        return
      }

      await fulfillJson(route, 403, {
        code: 'password_invalid',
        message: '密码错误',
      })
    },
  )

  return state
}

async function openOnboarding(page: Page): Promise<void> {
  await page.goto('/mobile/#/chat')
  await expect(page.locator('[data-onboarding-wizard]')).toBeVisible({
    timeout: 15000,
  })
  await expect(page.locator('.splash-overlay')).toHaveCount(0)
}

async function unlockWith(page: Page, password: string): Promise<void> {
  const input = page.locator('[data-onboarding-password]')
  await expect(input).toBeVisible()
  await input.fill(password)
  await page.locator('[data-onboarding-unlock-submit]').click()
}

test('existing install without password shows gate instead of panel and footer', async ({
  page,
}) => {
  await installOnboardingMocks(page, {
    needsSetup: false,
    currentStep: 'welcome',
    verifyMode: 'success',
  })

  await openOnboarding(page)

  await expect(page.locator('[data-onboarding-gate]')).toBeVisible()
  await expect(page.locator('[data-onboarding-password]')).toBeVisible()
  await expect(page.locator('[data-onboarding-panel]')).toHaveCount(0)
  await expect(page.locator('.onboarding-footer')).toHaveCount(0)
  await expect(page.locator('[data-onboarding-next]')).toHaveCount(0)

  const rail = page.locator('[data-onboarding-step]')
  await expect(rail).toHaveCount(11)
  await expect(rail.first()).toBeVisible()
  await expect(
    page.locator(
      '[data-onboarding-step][data-step-id="welcome"][data-step-state="current"]',
    ),
  ).toBeVisible()
})

test('correct password calls verify once with body and Authorization, then reveals panel', async ({
  page,
}) => {
  const state = await installOnboardingMocks(page, {
    needsSetup: false,
    currentStep: 'welcome',
    verifyMode: 'success',
  })

  await openOnboarding(page)
  await unlockWith(page, CORRECT_PASSWORD)

  await expect(page.locator('[data-onboarding-gate]')).toHaveCount(0)
  await expect(page.locator('[data-onboarding-panel="welcome"]')).toBeVisible()
  await expect(page.locator('input[type="password"]')).toHaveCount(0)

  expect(state.verifyRequests).toHaveLength(1)
  expect(state.verifyRequests[0].body).toEqual({ password: CORRECT_PASSWORD })
  expect(state.verifyRequests[0].headers.authorization).toBe(`Bearer ${TOKEN}`)
})

test('wrong password keeps gate open and shows error', async ({ page }) => {
  await installOnboardingMocks(page, {
    needsSetup: false,
    currentStep: 'welcome',
    verifyMode: 'wrong_password',
  })

  await openOnboarding(page)
  await unlockWith(page, WRONG_PASSWORD)

  const error = page.locator('[data-onboarding-gate-error]')
  await expect(error).toBeVisible()
  await expect(error).toContainText('密码错误')
  await expect(page.locator('[data-onboarding-gate]')).toBeVisible()
  await expect(page.locator('[data-onboarding-panel]')).toHaveCount(0)
})

test('rate limited verify keeps gate open and mentions retry seconds', async ({
  page,
}) => {
  await installOnboardingMocks(page, {
    needsSetup: false,
    currentStep: 'welcome',
    verifyMode: 'rate_limited',
  })

  await openOnboarding(page)
  await unlockWith(page, WRONG_PASSWORD)

  const error = page.locator('[data-onboarding-gate-error]')
  await expect(error).toBeVisible()
  await expect(error).toContainText('12')
  await expect(error).toContainText('秒后再试')
  await expect(page.locator('[data-onboarding-gate]')).toBeVisible()
  await expect(page.locator('[data-onboarding-panel]')).toHaveCount(0)
})

test('needs_setup=true renders account panel without gate or verify call', async ({
  page,
}) => {
  const state = await installOnboardingMocks(page, {
    needsSetup: true,
    currentStep: 'account',
  })

  await openOnboarding(page)

  await expect(page.locator('[data-onboarding-gate]')).toHaveCount(0)
  await expect(page.locator('[data-onboarding-panel="account"]')).toBeVisible()
  await expect(page.locator('[data-onboarding-account-form]')).toBeVisible()
  expect(state.verifyRequests).toHaveLength(0)
})

test('reload after unlock brings the gate back for needs_setup=false', async ({
  page,
}) => {
  await installOnboardingMocks(page, {
    needsSetup: false,
    currentStep: 'welcome',
    verifyMode: 'success',
  })

  await openOnboarding(page)
  await unlockWith(page, CORRECT_PASSWORD)
  await expect(page.locator('[data-onboarding-gate]')).toHaveCount(0)

  await page.reload()
  await expect(page.locator('[data-onboarding-wizard]')).toBeVisible({
    timeout: 15000,
  })
  await expect(page.locator('[data-onboarding-gate]')).toBeVisible()
  await expect(page.locator('[data-onboarding-panel]')).toHaveCount(0)
})

test('unlock does not persist the password in localStorage or sessionStorage', async ({
  page,
}) => {
  await installOnboardingMocks(page, {
    needsSetup: false,
    currentStep: 'welcome',
    verifyMode: 'success',
  })

  await openOnboarding(page)
  await unlockWith(page, CORRECT_PASSWORD)
  await expect(page.locator('[data-onboarding-gate]')).toHaveCount(0)

  const storage = await page.evaluate(() => {
    const dump = (storageArea: Storage): Record<string, string> => {
      const entries: Record<string, string> = {}
      for (let index = 0; index < storageArea.length; index += 1) {
        const key = storageArea.key(index)
        if (key !== null) {
          entries[key] = storageArea.getItem(key) ?? ''
        }
      }
      return entries
    }
    return {
      local: dump(window.localStorage),
      session: dump(window.sessionStorage),
    }
  })

  expect(JSON.stringify(storage)).not.toContain(CORRECT_PASSWORD)
  expect(storage.local.mobile_token).toBe(TOKEN)

  const keyNames = [...Object.keys(storage.local), ...Object.keys(storage.session)]
  expect(
    keyNames.filter((key) => key.toLowerCase().includes('password')),
  ).toHaveLength(0)
})
