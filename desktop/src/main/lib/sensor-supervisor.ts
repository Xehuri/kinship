import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import type { Readable } from 'node:stream'
import {
  DEFAULT_SENSOR_PORT,
  SENSOR_PORT_SCAN_RANGE,
  SENSOR_SHUTDOWN_TIMEOUT_MS,
  SENSOR_START_TIMEOUT_MS,
} from '../../shared/constants'
import type {
  SensorConfigPatch,
  SensorConfigView,
  SensorLoginTestResult,
  SensorState,
  SensorStatus,
  TransportConfig,
} from '../../shared/types'
import { isRecord, resolveTransportServerUrl } from '../../shared/validation'
import { FileMissingError, JsonParseError } from './atomic-json'
import { MAX_RESTART_ATTEMPTS, backoffDelayMs, shouldRestart } from './backoff'
import { isPortFree, selectSensorPort } from './port-pool'
import {
  buildAuthorizationHeader,
  buildAuthTokenUrl,
  buildConfigUrl,
  buildPanelUrl,
  buildSensorArgs,
  buildSensorSpawnOptions,
  buildShutdownUrl,
  buildTestLoginUrl,
} from './sensor-command'
import {
  DEFAULT_AGENT_CONFIG,
  DEFAULT_COLLECTION_CONFIG,
  buildSensorCollectionConfig,
  buildSensorConfigView,
  buildSensorNetworkConfig,
  buildSensorStatus,
  ensureAgentConfig,
  readAgentConfig,
  readCollectionConfig,
  writeCollectionConfig,
} from './sensor-config'
import type {
  SensorAgentConfig,
  SensorCollectionConfig,
  SensorStatusLocalState,
  SensorTlsPolicy,
} from './sensor-config'
import { isRuntimePresent } from './sensor-paths'
import type { SensorPaths } from './sensor-paths'
import { probeHealth, probeStatus } from './sensor-probe'
import type { SensorHealthBody, SensorHealthResult, SensorStatusResult } from './sensor-probe'

export type SensorLogFields = Readonly<Record<string, string | number | boolean>>

export interface SensorSupervisorLogger {
  info(message: string, fields?: SensorLogFields): void
  warn(message: string, fields?: SensorLogFields): void
  error(message: string, fields?: SensorLogFields): void
}

export interface SensorAuthToken {
  readonly token: string
  readonly expiresIn: number | null
}

export interface SensorSupervisorOptions {
  readonly paths: SensorPaths
  readonly parentPid: number
  readonly preferredPort?: number
  readonly maxPort?: number
  readonly spawnFn?: typeof spawn
  readonly fetchFn?: typeof fetch
  readonly logger?: SensorSupervisorLogger
  readonly onStatus?: (status: SensorStatus) => void
  readonly fakeSensorUrl?: string
  readonly fakeSensorToken?: string
  readonly fakeSensorInstanceId?: string
  readonly now?: () => number
  readonly getServerUrl?: () => string
  readonly getTransport?: () => TransportConfig
  readonly getTlsPolicy?: () => SensorTlsPolicy
}

export class SensorRuntimeMissingError extends Error {
  readonly code = 'RUNTIME_MISSING' as const

  constructor(message: string) {
    super(message)
    this.name = 'SensorRuntimeMissingError'
  }
}

type PortProbeKind = 'sensor' | 'foreign' | 'free'

const POLL_INTERVAL_MS = 5000
const START_POLL_INTERVAL_MS = 250
const HEALTH_PROBE_TIMEOUT_MS = 1500
const STATUS_PROBE_TIMEOUT_MS = 2500
const CONFIG_POST_TIMEOUT_MS = 20000
const SHUTDOWN_PROBE_TIMEOUT_MS = 750
const AUTH_TOKEN_TIMEOUT_MS = 5000
const TEST_LOGIN_TIMEOUT_MS = 25000

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '未知错误'
}

function redact(text: string, secret: string): string {
  if (secret.length === 0) return text
  return text.split(secret).join('******')
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

function normalizePort(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isInteger(value) || value < 1 || value > 65535) {
    return fallback
  }
  return value
}

function normalizeOrigin(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length === 0) return ''
  try {
    return new URL(trimmed).origin
  } catch (error) {
    if (error instanceof TypeError) return trimmed
    throw error
  }
}

function isMissingOrCorrupt(error: unknown): boolean {
  return error instanceof FileMissingError || error instanceof JsonParseError
}

function attachLineLogger(stream: Readable | null | undefined, sink: (line: string) => void): void {
  if (stream === null || stream === undefined) return
  let buffer = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk: string) => {
    buffer += chunk
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (line.trim().length > 0) sink(line)
    }
  })
  stream.on('end', () => {
    if (buffer.trim().length > 0) sink(buffer)
  })
}

export class SensorSupervisor {
  private readonly options: SensorSupervisorOptions
  private readonly paths: SensorPaths
  private readonly spawnFn: typeof spawn
  private readonly fetchFn: typeof fetch
  private readonly log: SensorSupervisorLogger
  private readonly now: () => number
  private readonly preferredPort: number
  private readonly maxPort: number

  private state: SensorState = 'stopped'
  private port: number
  private baseUrl: string
  private token = ''
  private instanceId: string | undefined
  private enabled = false
  private adopted = false
  private child: ChildProcess | null = null
  private lastHealth: SensorHealthBody | null = null
  private lastRemoteStatus: Record<string, unknown> | null = null
  private lastError: string | undefined
  private statusTimer: ReturnType<typeof setTimeout> | null = null
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private startPromise: Promise<void> | null = null
  private restartAttempts = 0
  private childGeneration = 0
  private stopping = false
  private disposed = false

  constructor(options: SensorSupervisorOptions) {
    this.options = options
    this.paths = options.paths
    this.spawnFn = options.spawnFn ?? spawn
    this.fetchFn = options.fetchFn ?? fetch
    this.now = options.now ?? Date.now
    this.log = options.logger ?? {
      info: (): void => undefined,
      warn: (): void => undefined,
      error: (): void => undefined,
    }
    this.preferredPort = normalizePort(options.preferredPort, DEFAULT_SENSOR_PORT)
    this.maxPort = Math.max(
      options.maxPort ?? SENSOR_PORT_SCAN_RANGE.end,
      this.preferredPort,
    )
    this.port = this.preferredPort
    this.baseUrl = `http://127.0.0.1:${String(this.port)}`
  }

  getBaseUrl(): string {
    return this.baseUrl
  }

  getToken(): string {
    return this.token
  }

  async getAuthToken(): Promise<SensorAuthToken | null> {
    if (this.state !== 'running' && this.state !== 'external') return null
    if (this.token.length === 0) return null

    try {
      const response = await this.fetchFn(buildAuthTokenUrl(this.baseUrl), {
        method: 'GET',
        headers: { Authorization: buildAuthorizationHeader(this.token) },
        signal: AbortSignal.timeout(AUTH_TOKEN_TIMEOUT_MS),
      })
      if (!response.ok) {
        this.log.warn('读取采集端后端 Token 失败', { status: response.status })
        return null
      }
      const body: unknown = await response.json()
      if (!isRecord(body)) return null
      const token = body['token']
      if (typeof token !== 'string' || token.length === 0) return null
      const rawExpiresIn = body['expires_in']
      const expiresIn =
        typeof rawExpiresIn === 'number' && Number.isFinite(rawExpiresIn)
          ? rawExpiresIn
          : null
      return { token, expiresIn }
    } catch (error) {
      this.log.warn('读取采集端后端 Token 失败', { error: errorMessage(error) })
      return null
    }
  }

  isAdopted(): boolean {
    return this.adopted
  }

  async testLogin(): Promise<SensorLoginTestResult> {
    if (this.state !== 'running' && this.state !== 'external') {
      return {
        success: false,
        loggedIn: false,
        message:
          this.state === 'runtime-missing'
            ? (this.lastError ?? '缺少内置 PC 采集端运行时')
            : 'PC 采集端未运行，无法测试登录',
        status: await this.getStatus(),
      }
    }
    if (this.token.length === 0) {
      return {
        success: false,
        loggedIn: false,
        message: '缺少采集端认证 Token，无法测试登录',
        status: await this.getStatus(),
      }
    }

    try {
      const response = await this.fetchFn(buildTestLoginUrl(this.baseUrl), {
        method: 'POST',
        headers: { Authorization: buildAuthorizationHeader(this.token) },
        signal: AbortSignal.timeout(TEST_LOGIN_TIMEOUT_MS),
      })
      if (response.status === 401) {
        return await this.testLoginFailure('采集端认证失败，请重启采集端')
      }
      if (!response.ok) {
        return await this.testLoginFailure(`测试登录失败：HTTP ${String(response.status)}`)
      }

      const body: unknown = await response.json()
      if (!isRecord(body)) {
        return await this.testLoginFailure('测试登录返回异常')
      }

      const success = body['success'] === true
      const loggedIn = body['logged_in'] === true
      const rawMessage = typeof body['message'] === 'string' ? body['message'] : ''
      const message =
        rawMessage.length > 0
          ? redact(rawMessage, this.token)
          : success
            ? '登录成功'
            : '测试登录失败'
      const rawAuthError = typeof body['auth_error'] === 'string' ? body['auth_error'] : ''
      const status = await this.getStatus()
      if (rawAuthError.length === 0) {
        return { success, loggedIn, message, status }
      }
      return {
        success,
        loggedIn,
        message,
        authError: redact(rawAuthError, this.token),
        status,
      }
    } catch (error) {
      this.log.warn('测试采集端登录失败', { error: errorMessage(error) })
      return await this.testLoginFailure(`测试登录失败：${errorMessage(error)}`)
    }
  }

  private async testLoginFailure(message: string): Promise<SensorLoginTestResult> {
    return {
      success: false,
      loggedIn: false,
      message: redact(message, this.token),
      status: await this.getStatus(),
    }
  }

  start(): Promise<void> {
    this.disposed = false
    return this.runStart(true)
  }

  private runStart(resetAttempts: boolean): Promise<void> {
    if (this.startPromise !== null) return this.startPromise
    if (this.child !== null) return Promise.resolve()
    if (this.state === 'running' || this.state === 'external') return Promise.resolve()
    if (resetAttempts) this.restartAttempts = 0

    this.startPromise = this.beginStart().finally(() => {
      this.startPromise = null
    })
    return this.startPromise
  }

  private async beginStart(): Promise<void> {
    this.stopping = false
    this.adopted = false
    this.lastError = undefined
    this.lastHealth = null
    this.lastRemoteStatus = null
    this.port = this.preferredPort
    this.baseUrl = `http://127.0.0.1:${String(this.port)}`

    try {
      await this.startFlow()
    } catch (error) {
      this.lastError = `采集端启动失败：${errorMessage(error)}`
      this.state = 'crashed'
      this.log.error('采集端启动失败', { error: errorMessage(error) })
      this.emitStatus()
      this.scheduleRestart()
    }
  }

  private async startFlow(): Promise<void> {
    const fakeUrl = this.options.fakeSensorUrl?.trim() ?? ''
    if (fakeUrl.length === 0 && !isRuntimePresent(this.paths)) {
      this.state = 'runtime-missing'
      this.lastError = this.runtimeMissingMessage()
      this.log.error('缺少 PC 采集端运行时', {
        pythonExe: this.paths.pythonExe,
        appScript: this.paths.appScript,
        candidateRoots: this.paths.candidateRoots.join('；'),
      })
      this.emitStatus()
      return
    }

    mkdirSync(this.paths.dataDir, { recursive: true })

    const previousAgent = this.tryReadAgent()
    const agent = ensureAgentConfig(this.paths.agentConfigPath, {
      preferredPort: this.preferredPort,
    })
    this.token = agent.agent_token
    this.instanceId = agent.instance_id
    this.enabled = this.readEnabledSafely()

    if (fakeUrl.length > 0) {
      await this.adoptFakeSensor(fakeUrl)
      return
    }

    const probeCache = new Map<number, PortProbeKind>()
    const probe = async (port: number): Promise<PortProbeKind> => {
      const cached = probeCache.get(port)
      if (cached !== undefined) return cached
      const result = await this.probePort(port)
      probeCache.set(port, result)
      return result
    }

    const candidatePorts: number[] = []
    const configuredPort = previousAgent?.server_port
    if (configuredPort !== undefined && configuredPort !== this.preferredPort) {
      candidatePorts.push(configuredPort)
    }
    candidatePorts.push(this.preferredPort)

    for (const port of candidatePorts) {
      const kind = await probe(port)
      if (kind === 'sensor' && (await this.tryAdoptSensor(port))) return
    }

    const preferredKind = await probe(this.preferredPort)
    if (preferredKind === 'sensor') {
      await this.tryAdoptSensor(this.preferredPort)
      return
    }

    let spawnPort = this.preferredPort
    if (preferredKind === 'foreign') {
      const selection = await selectSensorPort({
        preferred: this.preferredPort,
        maxPort: this.maxPort,
        isPortFree,
        probe,
      })
      if (selection.kind !== 'fallback') {
        this.state = 'conflict'
        this.lastError =
          selection.kind === 'conflict'
            ? `端口 ${String(this.preferredPort)} 已被 PC 采集端占用`
            : `端口 ${String(this.preferredPort)} 被其他服务占用，且 ${String(this.maxPort)} 之前没有可用端口`
        this.log.error('无法为 PC 采集端选择端口', { port: this.preferredPort })
        this.emitStatus()
        return
      }
      spawnPort = selection.port
    }

    const finalAgent = ensureAgentConfig(this.paths.agentConfigPath, {
      preferredPort: spawnPort,
    })
    this.token = finalAgent.agent_token
    this.instanceId = finalAgent.instance_id
    this.port = spawnPort
    this.baseUrl = `http://127.0.0.1:${String(spawnPort)}`
    this.startChild()
    await this.waitForReady()
  }

  private runtimeMissingMessage(): string {
    const roots = this.paths.candidateRoots.join('；')
    return `缺少内置 PC 采集端运行时：${this.paths.pythonExe} 或 ${this.paths.appScript} 不存在。便携版自解压到 %TEMP% 时可能被杀毒软件拦截或解压不完整；建议改用安装版，或将 zip 解压到本地目录并把应用目录加入杀毒白名单。已检查：${roots}`
  }

  private async adoptFakeSensor(fakeUrl: string): Promise<void> {
    this.baseUrl = fakeUrl.replace(/\/+$/, '')
    this.token = this.options.fakeSensorToken?.trim() ?? ''
    const configuredInstance = this.options.fakeSensorInstanceId?.trim() ?? ''
    this.instanceId = configuredInstance
    this.adopted = true

    const health = await probeHealth(this.baseUrl, HEALTH_PROBE_TIMEOUT_MS, this.fetchFn)
    if (!health.ok) {
      this.state = 'crashed'
      this.lastError = `外部采集端不可用：${health.error}`
      this.emitStatus()
      return
    }
    this.lastHealth = health.body

    const status = await this.probeStatusWithRefresh()
    if (!status.ok) {
      this.state = status.unauthorized ? 'conflict' : 'crashed'
      this.lastError = status.error
      this.emitStatus()
      return
    }

    const remoteInstance = status.status['instance_id']
    if (
      configuredInstance.length > 0 &&
      (typeof remoteInstance !== 'string' || remoteInstance !== configuredInstance)
    ) {
      this.enterConflict(this.parsePort(this.baseUrl), '实例标识不匹配', remoteInstance)
      return
    }

    this.port = this.parsePort(this.baseUrl)
    if (typeof remoteInstance === 'string' && remoteInstance.length > 0) {
      this.instanceId = remoteInstance
    }
    this.lastRemoteStatus = status.status
    this.state = 'external'
    this.lastError = undefined
    this.log.info('已接管外部 PC 采集端', { port: this.port })
    this.emitStatus()
    this.startStatusPoll()
  }

  private async probePort(port: number): Promise<PortProbeKind> {
    const baseUrl = `http://127.0.0.1:${String(port)}`
    const health = await probeHealth(baseUrl, HEALTH_PROBE_TIMEOUT_MS, this.fetchFn)
    if (health.ok) {
      this.lastHealth = health.body
      return 'sensor'
    }
    return (await isPortFree(port)) ? 'free' : 'foreign'
  }

  private async tryAdoptSensor(port: number): Promise<boolean> {
    this.port = port
    this.baseUrl = `http://127.0.0.1:${String(port)}`
    const status = await this.probeStatusWithRefresh()
    if (!status.ok) {
      this.enterConflict(port, status.error)
      return true
    }

    const remoteInstance = status.status['instance_id']
    if (!this.matchesInstance(remoteInstance)) {
      this.enterConflict(port, '实例标识不匹配', remoteInstance)
      return true
    }

    ensureAgentConfig(this.paths.agentConfigPath, { preferredPort: port })
    this.lastRemoteStatus = status.status
    this.state = 'external'
    this.adopted = true
    this.lastError = undefined
    this.enabled = this.readEnabledSafely()
    this.log.info('已接管现有 PC 采集端', { port })
    this.emitStatus()
    this.startStatusPoll()
    return true
  }

  private matchesInstance(value: unknown): boolean {
    return (
      typeof value === 'string' &&
      value.length > 0 &&
      this.instanceId !== undefined &&
      value === this.instanceId
    )
  }

  private enterConflict(port: number, reason: string, remoteInstance?: unknown): void {
    const health = this.lastHealth
    const details: string[] = []
    if (health !== null) {
      if (health.agent_id.length > 0) details.push(`agent_id=${health.agent_id}`)
      if (health.agent_name.length > 0) details.push(`agent_name=${health.agent_name}`)
    }
    if (typeof remoteInstance === 'string' && remoteInstance.length > 0) {
      details.push(`instance_id=${remoteInstance}`)
    }
    const suffix = details.length > 0 ? `（${details.join('，')}）` : ''
    this.state = 'conflict'
    this.adopted = false
    this.lastError = `端口 ${String(port)} 已被另一个 PC 采集端占用：${reason}${suffix}`
    this.log.error('PC 采集端端口冲突', { port })
    this.emitStatus()
  }

  private startChild(): void {
    const child = this.spawnFn(
      this.paths.pythonExe,
      buildSensorArgs({
        appScript: this.paths.appScript,
        dataDir: this.paths.dataDir,
        parentPid: this.options.parentPid,
      }),
      buildSensorSpawnOptions(this.paths.appDir),
    )

    this.child = child
    this.childGeneration += 1
    const generation = this.childGeneration
    this.adopted = false
    this.state = 'starting'
    this.lastError = undefined

    attachLineLogger(child.stdout, (line) => this.log.info(`[pc-sensor] ${line}`))
    attachLineLogger(child.stderr, (line) => this.log.warn(`[pc-sensor] ${line}`))

    child.once('error', (error) => {
      if (this.child === child) this.child = null
      if (generation !== this.childGeneration) return
      this.handleCrash(`采集端进程错误：${error.message}`)
    })
    child.once('exit', (code, signal) => {
      if (this.child === child) this.child = null
      if (generation !== this.childGeneration) return
      if (this.stopping || this.disposed) return
      this.handleCrash(
        `采集端进程退出（code=${code === null ? 'null' : String(code)}，signal=${signal ?? 'null'}）`,
      )
    })

    this.emitStatus()
  }

  private async waitForReady(): Promise<void> {
    const deadline = this.now() + SENSOR_START_TIMEOUT_MS
    while (this.now() < deadline) {
      if (this.child === null || this.state !== 'starting' || this.stopping || this.disposed) {
        return
      }
      const health = await probeHealth(this.baseUrl, HEALTH_PROBE_TIMEOUT_MS, this.fetchFn)
      if (health.ok) {
        this.lastHealth = health.body
        this.state = 'running'
        this.lastError = undefined
        this.restartAttempts = 0
        this.enabled = this.readEnabledSafely()
        this.log.info('PC 采集端已就绪', { port: this.port })
        this.emitStatus()
        await this.refreshStatus()
        this.startStatusPoll()
        return
      }
      await delay(START_POLL_INTERVAL_MS)
    }

    if (this.child === null || this.state !== 'starting') return
    this.lastError = `采集端在 ${String(SENSOR_START_TIMEOUT_MS / 1000)} 秒内未就绪`
    this.state = 'crashed'
    this.log.error('PC 采集端启动超时', { port: this.port })
    this.emitStatus()
    this.killChild()
    this.scheduleRestart()
  }

  private startStatusPoll(): void {
    this.clearStatusTimer()
    this.statusTimer = setInterval(() => {
      void this.refreshStatus()
    }, POLL_INTERVAL_MS)
    this.statusTimer.unref?.()
  }

  private async refreshStatus(): Promise<void> {
    if (this.disposed || (this.state !== 'running' && this.state !== 'external')) return
    try {
      const health = await probeHealth(this.baseUrl, HEALTH_PROBE_TIMEOUT_MS, this.fetchFn)
      const status = await this.probeStatusWithRefresh()
      if (!health.ok || !status.ok) {
        this.handleProbeFailure(health, status)
        return
      }
      this.lastHealth = health.body
      this.lastRemoteStatus = status.status
      this.lastError = undefined
      this.enabled = this.readEnabledSafely()
      this.emitStatus()
    } catch (error) {
      this.log.warn('刷新 PC 采集端状态失败', { error: errorMessage(error) })
    }
  }

  private async probeStatusWithRefresh(): Promise<SensorStatusResult> {
    const first = await probeStatus(
      this.baseUrl,
      this.token,
      STATUS_PROBE_TIMEOUT_MS,
      this.fetchFn,
    )
    if (!first.ok && first.unauthorized) {
      const agent = this.tryReadAgent()
      if (agent !== undefined) {
        this.token = agent.agent_token
        if (agent.instance_id.length > 0) this.instanceId = agent.instance_id
        return probeStatus(this.baseUrl, this.token, STATUS_PROBE_TIMEOUT_MS, this.fetchFn)
      }
    }
    return first
  }

  private handleProbeFailure(health: SensorHealthResult, status: SensorStatusResult): void {
    if (this.stopping || this.disposed) return
    if (this.state !== 'running' && this.state !== 'external') return

    let reason: string
    if (!health.ok) {
      reason = health.error
    } else if (!status.ok) {
      reason = status.error
    } else {
      return
    }

    this.state = 'crashed'
    this.adopted = false
    this.lastError = `采集端已失联：${reason}`
    this.lastHealth = null
    this.lastRemoteStatus = null
    this.clearStatusTimer()
    this.childGeneration += 1
    this.killChild()
    this.log.error('PC 采集端失联', { error: reason })
    this.emitStatus()
    this.scheduleRestart()
  }

  private handleCrash(reason: string): void {
    if (this.stopping || this.disposed) return
    this.lastError = reason
    this.state = 'crashed'
    this.log.error('PC 采集端异常', { error: reason })
    this.emitStatus()
    this.scheduleRestart()
  }

  private scheduleRestart(): void {
    if (this.restartTimer !== null || this.stopping || this.disposed) return
    const attempt = this.restartAttempts + 1
    if (!shouldRestart(attempt, this.stopping || this.disposed)) {
      this.lastError = `采集端连续退出 ${String(MAX_RESTART_ATTEMPTS)} 次，已停止自动重启`
      this.state = 'crashed'
      this.emitStatus()
      return
    }

    this.restartAttempts = attempt
    const delayMs = backoffDelayMs(attempt)
    this.log.warn('计划重启 PC 采集端', { attempt, delayMs })
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      void this.runStart(false)
    }, delayMs)
    this.restartTimer.unref?.()
  }

  private killChild(): void {
    const child = this.child
    this.child = null
    if (child === null || child.killed) return
    try {
      child.kill()
    } catch (error) {
      if (!(error instanceof Error)) throw error
      this.log.warn('结束 PC 采集端进程失败', { error: error.message })
    }
  }

  async applyConfig(
    patch: SensorConfigPatch,
    getServerUrl?: () => string,
  ): Promise<SensorConfigView> {
    const serverUrlProvider = getServerUrl ?? this.options.getServerUrl
    const fallbackServerUrl = serverUrlProvider?.() ?? ''
    const transport = this.options.getTransport?.()
    const serverUrl = normalizeOrigin(
      transport === undefined
        ? fallbackServerUrl
        : resolveTransportServerUrl(transport, fallbackServerUrl),
    )
    const tls = this.resolveSensorTls()
    const caFile =
      tls.sslCaFile !== undefined
        ? tls.sslCaFile
        : existsSync(this.paths.caBundlePath)
          ? this.paths.caBundlePath
          : ''
    const existing = this.tryReadCollection()
    const built = buildSensorCollectionConfig(existing, patch, {
      serverUrl,
      sslCaFile: caFile,
      ...(tls.sslVerify !== undefined ? { sslVerify: tls.sslVerify } : {}),
    })

    writeCollectionConfig(this.paths.collectionConfigPath, built.collectionConfig)
    this.enabled = built.collectionConfig.enabled === true

    if (this.state !== 'running' && this.state !== 'external') {
      await this.start()
    }
    if (this.state !== 'running' && this.state !== 'external') {
      if (this.state === 'runtime-missing') {
        throw new SensorRuntimeMissingError(
          this.lastError ?? '缺少内置 PC 采集端运行时',
        )
      }
      throw new Error(this.lastError ?? '采集端未运行，无法保存配置')
    }

    let response = await this.postConfig(built.apiPatch)
    if (response.status === 401) {
      const agent = this.tryReadAgent()
      if (agent !== undefined) {
        this.token = agent.agent_token
        response = await this.postConfig(built.apiPatch)
      }
    }
    if (!response.ok) {
      throw new Error(`保存采集端配置失败：HTTP ${String(response.status)}`)
    }

    const agent = this.tryReadAgent() ?? { ...DEFAULT_AGENT_CONFIG }
    const updated = this.tryReadCollection() ?? built.collectionConfig
    if (this.lastRemoteStatus !== null) {
      this.lastRemoteStatus = { ...this.lastRemoteStatus, enabled: this.enabled }
    }
    this.emitStatus()
    return buildSensorConfigView(agent, updated)
  }

  async applyNetworkConfig(transport: TransportConfig): Promise<SensorConfigView> {
    const fallbackServerUrl = normalizeOrigin(this.options.getServerUrl?.() ?? '')
    const tls = this.resolveSensorTls()
    const existing = this.tryReadCollection()
    const built = buildSensorNetworkConfig(existing, {
      transport,
      fallbackServerUrl,
      ...(tls.sslCaFile !== undefined ? { sslCaFile: tls.sslCaFile } : {}),
      ...(tls.sslVerify !== undefined ? { sslVerify: tls.sslVerify } : {}),
    })
    writeCollectionConfig(this.paths.collectionConfigPath, built)

    if (this.state !== 'running' && this.state !== 'external') {
      await this.start()
    }
    if (this.state !== 'running' && this.state !== 'external') {
      if (this.state === 'runtime-missing') {
        throw new SensorRuntimeMissingError(this.lastError ?? '缺少内置 PC 采集端运行时')
      }
      throw new Error(this.lastError ?? '采集端未运行，无法保存网络配置')
    }

    const patch: Record<string, unknown> = {
      endpoint_candidates: built.endpoint_candidates ?? [],
      server_url: built.server_url ?? '',
    }
    if (tls.sslCaFile !== undefined) patch['ssl_ca_file'] = built.ssl_ca_file ?? ''
    if (tls.sslVerify !== undefined) patch['ssl_verify'] = built.ssl_verify !== false
    let response = await this.postConfig(patch)
    if (response.status === 401) {
      const agent = this.tryReadAgent()
      if (agent !== undefined) {
        this.token = agent.agent_token
        response = await this.postConfig(patch)
      }
    }
    if (!response.ok) {
      throw new Error(`保存采集端网络配置失败：HTTP ${String(response.status)}`)
    }

    const agent = this.tryReadAgent() ?? { ...DEFAULT_AGENT_CONFIG }
    const updated = this.tryReadCollection() ?? built
    this.emitStatus()
    return buildSensorConfigView(agent, updated)
  }

  private resolveSensorTls(): { sslCaFile?: string; sslVerify?: boolean } {
    const policy = this.options.getTlsPolicy?.()
    if (policy === undefined) return {}
    if (policy.mode === 'insecure') return { sslCaFile: '', sslVerify: false }

    if (policy.mode === 'pinned' && policy.caPemPath !== undefined) {
      if (existsSync(policy.caPemPath)) {
        return { sslCaFile: policy.caPemPath, sslVerify: true }
      }
    }
    if (policy.mode === 'pinned' && existsSync(this.paths.caBundlePath)) {
      return { sslCaFile: this.paths.caBundlePath, sslVerify: true }
    }
    return { sslCaFile: '', sslVerify: true }
  }

  private async postConfig(patch: Record<string, unknown>): Promise<Response> {
    try {
      return await this.fetchFn(buildConfigUrl(this.baseUrl), {
        method: 'POST',
        headers: {
          Authorization: buildAuthorizationHeader(this.token),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(patch),
        signal: AbortSignal.timeout(CONFIG_POST_TIMEOUT_MS),
      })
    } catch (error) {
      throw new Error(`保存采集端配置失败：${errorMessage(error)}`)
    }
  }

  async getConfigView(): Promise<SensorConfigView> {
    const agent = this.tryReadAgent() ?? { ...DEFAULT_AGENT_CONFIG }
    const localCollection = this.tryReadCollection()
    if (localCollection !== undefined) {
      return buildSensorConfigView(agent, localCollection)
    }

    if (this.state === 'running' || this.state === 'external') {
      const remote = await this.fetchRemoteConfig()
      if (remote !== undefined) {
        return buildSensorConfigView(agent, remote)
      }
    }

    return buildSensorConfigView(agent, { ...DEFAULT_COLLECTION_CONFIG })
  }

  private async fetchRemoteConfig(): Promise<SensorCollectionConfig | undefined> {
    const request = async (): Promise<Response> =>
      this.fetchFn(buildConfigUrl(this.baseUrl), {
        method: 'GET',
        headers: { Authorization: buildAuthorizationHeader(this.token) },
        signal: AbortSignal.timeout(STATUS_PROBE_TIMEOUT_MS),
      })
    try {
      let response = await request()
      if (response.status === 401) {
        const agent = this.tryReadAgent()
        if (agent === undefined) return undefined
        this.token = agent.agent_token
        response = await request()
      }
      if (!response.ok) return undefined
      const body: unknown = await response.json()
      if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined
      const collection: SensorCollectionConfig = { ...DEFAULT_COLLECTION_CONFIG }
      for (const [key, value] of Object.entries(body)) {
        collection[key] = value
      }
      return collection
    } catch (error) {
      if (!(error instanceof Error)) throw error
      this.log.warn('读取采集端远端配置失败', { error: error.message })
      return undefined
    }
  }

  async getStatus(): Promise<SensorStatus> {
    const enabled = this.readEnabledSafely()
    this.enabled = enabled
    const local = this.localStatus(enabled)

    if (this.state !== 'running' && this.state !== 'external') {
      return buildSensorStatus(local)
    }

    try {
      const health = await probeHealth(this.baseUrl, HEALTH_PROBE_TIMEOUT_MS, this.fetchFn)
      const status = await this.probeStatusWithRefresh()
      if (!health.ok || !status.ok) {
        this.handleProbeFailure(health, status)
        return buildSensorStatus(this.localStatus(this.readEnabledSafely()))
      }
      this.lastHealth = health.body
      this.lastRemoteStatus = status.status
      this.lastError = undefined
      this.enabled = this.readEnabledSafely()
      return buildSensorStatus(this.localStatus(this.enabled), health.body, status.status)
    } catch (error) {
      if (!(error instanceof Error)) throw error
      this.log.warn('读取 PC 采集端状态失败', { error: error.message })
      return buildSensorStatus({ ...local, lastError: this.lastError ?? error.message })
    }
  }

  private localStatus(enabled: boolean): SensorStatusLocalState {
    return {
      state: this.state,
      port: this.port,
      enabled,
      panelUrl: buildPanelUrl(this.baseUrl),
      logPath: this.paths.logPath,
      instanceId: this.instanceId,
      pid: this.child?.pid,
      lastError: this.lastError,
    }
  }

  private emitStatus(): void {
    const callback = this.options.onStatus
    if (callback === undefined) return
    const useRemote = this.state === 'running' || this.state === 'external'
    const status = buildSensorStatus(
      this.localStatus(this.enabled),
      useRemote ? this.lastHealth : null,
      useRemote ? this.lastRemoteStatus : null,
    )
    callback(status)
  }

  async stop(): Promise<void> {
    this.stopping = true
    this.childGeneration += 1
    this.clearTimers()
    const wasUsable = this.state === 'running' || this.state === 'external'
    if (this.state !== 'stopped') {
      this.state = 'stopping'
      this.emitStatus()
    }

    let stillRunning = false
    if (wasUsable && this.token.length > 0) {
      try {
        await this.fetchFn(buildShutdownUrl(this.baseUrl), {
          method: 'POST',
          headers: { Authorization: buildAuthorizationHeader(this.token) },
          signal: AbortSignal.timeout(SENSOR_SHUTDOWN_TIMEOUT_MS),
        })
      } catch (error) {
        if (!(error instanceof Error)) throw error
        this.log.warn('请求关闭 PC 采集端失败', { error: error.message })
      }
      stillRunning = await this.waitForHealthDown(SENSOR_SHUTDOWN_TIMEOUT_MS)
    }

    if (!this.adopted && this.child !== null && (!wasUsable || stillRunning)) {
      this.killChild()
    }

    this.child = null
    this.adopted = false
    this.lastHealth = null
    this.lastRemoteStatus = null
    this.lastError = undefined
    this.state = 'stopped'
    this.stopping = false
    this.log.info('PC 采集端已停止')
    this.emitStatus()
  }

  private async waitForHealthDown(timeoutMs: number): Promise<boolean> {
    const deadline = this.now() + timeoutMs
    while (this.now() < deadline) {
      const health = await probeHealth(this.baseUrl, SHUTDOWN_PROBE_TIMEOUT_MS, this.fetchFn)
      if (!health.ok) return false
      await delay(100)
    }
    return true
  }

  resetLocalState(): void {
    this.clearTimers()
    if (this.child !== null) {
      this.childGeneration += 1
      this.killChild()
    }
    this.token = ''
    this.instanceId = undefined
    this.enabled = false
    this.adopted = false
    this.lastHealth = null
    this.lastRemoteStatus = null
    this.lastError = undefined
    this.restartAttempts = 0
    this.stopping = false
    this.port = this.preferredPort
    this.baseUrl = `http://127.0.0.1:${String(this.preferredPort)}`
    this.state = 'stopped'
    this.log.info('PC 采集端本地状态已重置')
    this.emitStatus()
  }

  async restart(): Promise<void> {
    await this.stop()
    await this.start()
  }

  dispose(): void {
    this.disposed = true
    this.clearTimers()
  }

  private clearTimers(): void {
    this.clearStatusTimer()
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
  }

  private clearStatusTimer(): void {
    if (this.statusTimer !== null) {
      clearInterval(this.statusTimer)
      this.statusTimer = null
    }
  }

  private tryReadAgent(): SensorAgentConfig | undefined {
    try {
      return readAgentConfig(this.paths.agentConfigPath)
    } catch (error) {
      if (isMissingOrCorrupt(error)) return undefined
      throw error
    }
  }

  private tryReadCollection(): SensorCollectionConfig | undefined {
    try {
      return readCollectionConfig(this.paths.collectionConfigPath)
    } catch (error) {
      if (isMissingOrCorrupt(error)) return undefined
      throw error
    }
  }

  private readEnabledSafely(): boolean {
    try {
      return readCollectionConfig(this.paths.collectionConfigPath).enabled === true
    } catch (error) {
      if (!isMissingOrCorrupt(error)) {
        if (error instanceof Error) {
          this.log.warn('读取 PC 采集端配置失败', { error: error.message })
        } else {
          throw error
        }
      }
      return this.enabled
    }
  }

  private parsePort(baseUrl: string): number {
    try {
      const parsed = new URL(baseUrl)
      return normalizePort(Number(parsed.port), this.preferredPort)
    } catch (error) {
      if (error instanceof TypeError) return this.preferredPort
      throw error
    }
  }
}
