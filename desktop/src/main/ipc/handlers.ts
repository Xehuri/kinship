import { X509Certificate } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import { DEFAULT_SENSOR_PORT, HEALTH_TIMEOUT_MS, LOG_DIRECTORY_NAME, LOG_FILENAME } from '../../shared/constants'
import { IPC } from '../../shared/ipc'
import { selectableLayers } from '../../shared/network'
import type {
  Bootstrap,
  CertInfo,
  DesktopConfig,
  IpcResult,
  NetworkConfig,
  SensorConfigPatch,
  SensorConfigView,
  SensorStatus,
  ServerTestResult,
  TransportConfig,
} from '../../shared/types'
import {
  isRecord,
  normalizeSensorPatch,
  validateNetworkConfig,
  validateSensorConfigPatch,
  validateServerUrlInput,
  validateTransportConfig,
  validateWindowPreferences,
} from '../../shared/validation'
import {
  normalizeLogSources,
  normalizeLogStreamLines,
  type LogStreamService,
} from '../lib/log-stream'
import type { AppController } from '../app-controller'
import { logger } from '../lib/logger'
import { readLogTail } from '../lib/log-tail'
import { resetSensorConfigFiles } from '../lib/sensor-reset'
import type { SensorPaths } from '../lib/sensor-paths'
import { SensorRuntimeMissingError } from '../lib/sensor-supervisor'
import type { SensorSupervisor } from '../lib/sensor-supervisor'
import {
  fetchCertificateChain,
  normalizeFingerprint,
  writeCaBundle,
} from '../lib/tls'
import { openSensorWindow } from '../windows/sensor-window'
import { guardSettingsSender } from './sender-guard'
import {
  assertCertificateTrustable,
  buildServerTestError,
  classifyCertificate,
  firstCertificatePem,
  normalizeHost,
  trustPolicyAcceptsLeaf,
} from './server-tools'

export interface RegisterIpcHandlersOptions {
  readonly controller: AppController
  readonly supervisor: SensorSupervisor
  readonly paths: SensorPaths
  readonly getLastStatus: () => SensorStatus
  readonly setLastStatus: (status: SensorStatus) => void
  readonly broadcastStatus?: (status: SensorStatus) => void
  readonly onServerChanged?: () => void
  readonly resetAuthState?: () => void
  readonly logStream?: LogStreamService
}

interface HostPort {
  readonly host: string
  readonly port: number
}

const CERT_FETCH_TIMEOUT_MS = 8_000
const MOBILE_TIMEOUT_MS = HEALTH_TIMEOUT_MS

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return '未知错误'
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return '连接超时'
  const message = error.message.trim()
  return message.length > 0 ? message.slice(0, 180) : '未知错误'
}

function resolveHostPort(raw: string): HostPort | null {
  try {
    const parsed = new URL(raw)
    const fallback = parsed.protocol === 'https:' ? 443 : 80
    const port = parsed.port.length > 0 ? Number.parseInt(parsed.port, 10) : fallback
    const host = normalizeHost(parsed.hostname)
    if (host.length === 0) return null
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null
    return { host, port }
  } catch {
    return null
  }
}

function readTarget(value: unknown): HostPort | null {
  if (!isRecord(value)) return null
  const host = value['host']
  const port = value['port']
  const normalizedHost = typeof host === 'string' ? normalizeHost(host) : ''
  if (normalizedHost.length === 0) return null
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    return null
  }
  return { host: normalizedHost, port }
}

function readServerPayload(value: unknown): DesktopConfig['server'] | null {
  if (!isRecord(value)) return null
  const rawUrl = value['url']
  if (typeof rawUrl !== 'string') return null

  let url = ''
  if (rawUrl.trim().length > 0) {
    const validation = validateServerUrlInput(rawUrl)
    if (!validation.ok) return null
    url = validation.url
  }

  const server: DesktopConfig['server'] = {
    url,
    allowUntrustedCa: value['allowUntrustedCa'] === true,
  }

  const rawPin = value['tlsPin']
  if (
    isRecord(rawPin) &&
    typeof rawPin['host'] === 'string' &&
    typeof rawPin['fingerprint256'] === 'string'
  ) {
    const pin: NonNullable<DesktopConfig['server']['tlsPin']> = {
      host: rawPin['host'],
      fingerprint256: rawPin['fingerprint256'],
    }
    if (typeof rawPin['caPemPath'] === 'string') pin.caPemPath = rawPin['caPemPath']
    server.tlsPin = pin
  }

  return server
}

function readTransportPayload(value: unknown): TransportConfig | null {
  const result = validateTransportConfig(value)
  return result.ok ? result.transport : null
}

function sanitizeLayerCaPaths(network: NetworkConfig, paths: SensorPaths): NetworkConfig {
  const allowed = resolve(paths.caBundlePath)
  return {
    ...network,
    layers: network.layers.map((layer) => {
      const copy = { ...layer }
      if (copy.caPemPath !== undefined && resolve(copy.caPemPath) !== allowed) {
        delete copy.caPemPath
      }
      return copy
    }),
  }
}

function certificatePemFingerprint(caPem: string): string | null {
  const block = firstCertificatePem(caPem)
  if (block === undefined) return null
  try {
    const certificate = new X509Certificate(block)
    return normalizeFingerprint(certificate.fingerprint256)
  } catch {
    return null
  }
}

async function testServerUrl(
  controller: AppController,
  raw: string,
): Promise<IpcResult<ServerTestResult>> {
  const validation = validateServerUrlInput(raw)
  if (!validation.ok) {
    return { ok: false, error: validation.message, code: 'INVALID_URL' }
  }

  const target = resolveHostPort(validation.url)
  if (target === null) {
    return { ok: false, error: '服务器地址格式不正确', code: 'INVALID_URL' }
  }

  const isHttps = validation.url.startsWith('https:')
  let chain: Awaited<ReturnType<typeof fetchCertificateChain>> | null = null

  if (isHttps) {
    try {
      chain = await fetchCertificateChain({
        host: target.host,
        port: target.port,
        timeoutMs: CERT_FETCH_TIMEOUT_MS,
      })
    } catch (error) {
      logger.debug('连接测试预检未取到证书', { error: describeError(error) })
    }

    if (chain !== null) {
      const leaf: CertInfo = { ...chain.leaf, caPem: chain.chainPem }
      const invalid = classifyCertificate(target.host, leaf)
      if (invalid !== null) {
        return buildServerTestError(invalid.code, invalid.message, leaf)
      }
      const policy = controller.getTrustPolicy()
      const accepted = trustPolicyAcceptsLeaf(policy, target.host, leaf)
      if (!accepted && (leaf.selfSigned || policy.pin !== undefined)) {
        return buildServerTestError('CERT_UNTRUSTED', '服务器证书不受系统信任', leaf)
      }
    }
  }

  const startedAt = Date.now()
  let healthResponse: Response
  try {
    healthResponse = await controller.getMainSession().fetch(`${validation.url}/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    })
  } catch (error) {
    return classifyConnectionFailure(validation.url, target, error, chain)
  }

  const latencyMs = Date.now() - startedAt
  let mobile = false
  try {
    const mobileResponse = await controller.getMainSession().fetch(`${validation.url}/mobile/`, {
      method: 'HEAD',
      signal: AbortSignal.timeout(MOBILE_TIMEOUT_MS),
    })
    mobile = mobileResponse.ok
  } catch (error) {
    logger.debug('移动端接口探测失败', { error: describeError(error) })
  }

  return {
    ok: true,
    data: { ok: true, latencyMs, health: healthResponse.ok, mobile },
  }
}

async function classifyConnectionFailure(
  url: string,
  target: HostPort,
  error: unknown,
  existingChain: Awaited<ReturnType<typeof fetchCertificateChain>> | null,
): Promise<IpcResult<ServerTestResult>> {
  let protocol: string
  try {
    protocol = new URL(url).protocol
  } catch {
    return buildServerTestError('UNREACHABLE', `无法连接到服务器：${describeError(error)}`)
  }

  if (protocol !== 'https:') {
    return buildServerTestError('UNREACHABLE', `无法连接到服务器：${describeError(error)}`)
  }

  let chain = existingChain
  if (chain === null) {
    try {
      chain = await fetchCertificateChain({
        host: target.host,
        port: target.port,
        timeoutMs: CERT_FETCH_TIMEOUT_MS,
      })
    } catch (chainError) {
      return buildServerTestError('UNREACHABLE', `无法连接到服务器：${describeError(chainError)}`)
    }
  }

  const leaf: CertInfo = { ...chain.leaf, caPem: chain.chainPem }
  const invalid = classifyCertificate(target.host, leaf)
  if (invalid !== null) {
    return buildServerTestError(invalid.code, invalid.message, leaf)
  }
  return buildServerTestError('CERT_UNTRUSTED', '服务器证书不受系统信任', leaf)
}

function defaultSensorConfig(controller: AppController): SensorConfigView {
  return {
    enabled: false,
    serverUrl: controller.getServerUrl(),
    agentId: 'default-agent',
    agentName: '',
    username: '',
    hasStoredPassword: false,
    rememberPassword: false,
    hasBackendToken: false,
    idleThreshold: 300,
    windowEnabled: true,
    idleEnabled: true,
    screenEnabled: true,
    sslVerify: true,
    sslCaFile: '',
  }
}

function defaultSensorStatus(paths: SensorPaths): SensorStatus {
  return {
    state: 'stopped',
    enabled: false,
    running: false,
    port: DEFAULT_SENSOR_PORT,
    panelUrl: '',
    logPath: paths.logPath,
  }
}

async function bootstrapResult(
  options: RegisterIpcHandlersOptions,
): Promise<IpcResult<Bootstrap>> {
  const { controller, supervisor, paths } = options

  let sensorConfig: SensorConfigView
  try {
    sensorConfig = await supervisor.getConfigView()
  } catch (error) {
    logger.warn('读取采集端配置失败，使用默认值', { error: describeError(error) })
    sensorConfig = defaultSensorConfig(controller)
  }

  let sensorStatus: SensorStatus
  try {
    sensorStatus = await supervisor.getStatus()
    options.setLastStatus(sensorStatus)
  } catch (error) {
    logger.warn('读取采集端状态失败，使用默认值', { error: describeError(error) })
    sensorStatus = options.getLastStatus() ?? defaultSensorStatus(paths)
  }

  return {
    ok: true,
    data: {
      appVersion: controller.getAppVersion(),
      electronVersion: process.versions.electron ?? '',
      platform: process.platform,
      firstRun: controller.getServerUrl().length === 0,
      config: controller.getConfig(),
      sensorConfig,
      sensorStatus,
    },
  }
}

function guarded<T>(
  controller: AppController,
  channel: string,
  handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<IpcResult<T>>,
): (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<IpcResult<T>> {
  return async (event, ...args) => {
    const denied = guardSettingsSender<T>(event, controller)
    if (denied !== null) {
      logger.warn('已拒绝非设置界面的 IPC 调用', { channel, senderId: event.sender.id })
      return denied
    }
    try {
      return await handler(event, ...args)
    } catch (error) {
      logger.error('IPC 调用失败', { channel, error: describeError(error) })
      return { ok: false, error: describeError(error), code: 'HANDLER_ERROR' }
    }
  }
}

export function registerIpcHandlers(options: RegisterIpcHandlersOptions): void {
  const { controller, supervisor, paths } = options

  const register = <T>(
    channel: string,
    handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<IpcResult<T>>,
  ): void => {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, guarded(controller, channel, handler))
  }

  register(IPC.BOOTSTRAP_GET, async () => bootstrapResult(options))

  register(IPC.SERVER_TEST, async (_event, ...args) => {
    const url = typeof args[0] === 'string' ? args[0] : ''
    return testServerUrl(controller, url)
  })

  register(IPC.SERVER_SAVE, async (_event, ...args) => {
    const server = readServerPayload(args[0])
    if (server === null) {
      return { ok: false, error: '服务器配置无效', code: 'INVALID_INPUT' }
    }

    const saved = await controller.applyServerConfig(server)
    options.onServerChanged?.()
    if (saved.url.length > 0) {
      try {
        await supervisor.applyConfig({})
      } catch (error) {
        logger.warn('同步 PC 采集端服务器地址失败', { error: describeError(error) })
      }
    }
    return { ok: true, data: saved }
  })

  register(IPC.SERVER_RETRY, async () => {
    if (selectableLayers(controller.getNetworkState().config).length > 0) {
      const outcome = await controller.probeNetwork({ reason: 'probe', reloadWindow: true })
      if (outcome.selectedLayerId !== undefined) {
        return { ok: true, data: { ok: true, health: true } }
      }
      return {
        ok: true,
        data: {
          ok: false,
          error: outcome.error ?? '所有网络层均不可用',
          code: outcome.code ?? 'NO_HEALTHY_LAYER',
        },
      }
    }

    const result = await testServerUrl(controller, controller.getServerUrl())
    if (result.ok && result.data.ok) {
      controller.reloadMain()
      controller.showMain()
    }
    return result
  })

  register(IPC.NETWORK_CONFIG_GET, async () => ({
    ok: true,
    data: controller.getTransport(),
  }))

  register(IPC.NETWORK_CONFIG_SAVE, async (_event, ...args) => {
    const payload = readTransportPayload(args[0])
    if (payload === null) {
      return { ok: false, error: '网络配置无效', code: 'INVALID_INPUT' }
    }

    const transport = controller.applyTransportConfig(payload)
    let sensorSynced = true
    let sensorError: string | undefined
    try {
      await supervisor.applyNetworkConfig(transport)
    } catch (error) {
      sensorSynced = false
      sensorError = describeError(error)
      logger.warn('同步 PC 采集端网络配置失败', { error: sensorError })
    }

    const data = sensorError === undefined
      ? { transport, sensorSynced }
      : { transport, sensorSynced, sensorError }
    return { ok: true, data }
  })

  register(IPC.NETWORK_LAYERS_GET, async () => ({
    ok: true,
    data: controller.getNetworkState(),
  }))

  register(IPC.NETWORK_LAYERS_SAVE, async (_event, ...args) => {
    const validation = validateNetworkConfig(args[0])
    if (!validation.ok) {
      return { ok: false, error: validation.message, code: validation.code }
    }
    const sanitized = sanitizeLayerCaPaths(validation.network, paths)
    return { ok: true, data: await controller.saveNetworkLayers(sanitized) }
  })

  register(IPC.NETWORK_PROBE, async () => {
    const outcome = await controller.probeNetwork({ reason: 'probe', reloadWindow: true })
    const result = controller.getNetworkApplyResult()
    if (outcome.selectedLayerId === undefined) {
      return {
        ok: true,
        data: {
          ...result,
          error: outcome.error ?? '所有网络层均不可用',
          code: outcome.code ?? 'NO_HEALTHY_LAYER',
        },
      }
    }
    return { ok: true, data: result }
  })

  register(IPC.NETWORK_LAYER_SELECT, async (_event, ...args) => {
    const layerId = typeof args[0] === 'string' ? args[0].trim() : ''
    if (layerId.length === 0) {
      return { ok: false, error: '网络层 ID 无效', code: 'INVALID_INPUT' }
    }
    return { ok: true, data: await controller.selectNetworkLayer(layerId) }
  })

  register(IPC.WINDOW_PREFS_GET, async () => ({
    ok: true,
    data: controller.getWindowPreferences(),
  }))

  register(IPC.WINDOW_PREFS_SAVE, async (_event, ...args) => {
    const validation = validateWindowPreferences(args[0])
    if (!validation.ok) {
      return { ok: false, error: validation.message, code: 'INVALID_INPUT' }
    }
    return { ok: true, data: controller.saveWindowPreferences(validation.preferences) }
  })

  register(IPC.CERT_INSPECT, async (_event, ...args) => {
    const target = readTarget(args[0])
    if (target === null) {
      return { ok: false, error: '证书检查参数无效', code: 'INVALID_INPUT' }
    }

    let chain
    try {
      chain = await fetchCertificateChain({
        host: target.host,
        port: target.port,
        timeoutMs: CERT_FETCH_TIMEOUT_MS,
      })
    } catch (error) {
      return { ok: false, error: describeError(error), code: 'TLS_FETCH_FAILED' }
    }

    const leaf: CertInfo = { ...chain.leaf, caPem: chain.chainPem }
    const invalid = classifyCertificate(target.host, leaf)
    return {
      ok: true,
      data: invalid === null ? leaf : { ...leaf, error: invalid.message },
    }
  })

  register(IPC.CERT_TRUST, async (_event, ...args) => {
    const target = readTarget(args[0])
    const record = isRecord(args[0]) ? args[0] : null
    const caPem = record !== null && typeof record['caPem'] === 'string' ? record['caPem'] : ''
    if (target === null) {
      return { ok: false, error: '证书信任参数无效', code: 'INVALID_INPUT' }
    }

    let chain
    try {
      chain = await fetchCertificateChain({
        host: target.host,
        port: target.port,
        timeoutMs: CERT_FETCH_TIMEOUT_MS,
      })
    } catch (error) {
      return { ok: false, error: describeError(error), code: 'TLS_FETCH_FAILED' }
    }

    const leaf: CertInfo = { ...chain.leaf, caPem: chain.chainPem }
    const invalid = assertCertificateTrustable(target.host, leaf)
    if (invalid !== null) {
      return { ok: false, error: invalid.message, code: invalid.code }
    }

    const submitted = certificatePemFingerprint(caPem)
    const actual = normalizeFingerprint(chain.leaf.fingerprint256)
    if (submitted !== null && submitted !== actual) {
      return { ok: false, error: '证书已变化，请重新检查', code: 'CERT_CHANGED' }
    }

    writeCaBundle(paths.caBundlePath, chain.chainPem)

    const currentServer = controller.getConfig().server
    const currentTarget = resolveHostPort(currentServer.url)
    if (
      currentServer.url.length > 0 &&
      currentTarget !== null &&
      normalizeHost(currentTarget.host) === normalizeHost(target.host)
    ) {
      await controller.applyServerConfig({
        ...currentServer,
        allowUntrustedCa: true,
        tlsPin: {
          host: target.host,
          fingerprint256: chain.leaf.fingerprint256,
          caPemPath: paths.caBundlePath,
        },
      })
    }

    try {
      await supervisor.applyConfig({ sslVerify: true })
    } catch (error) {
      logger.warn('同步采集端证书配置失败', { error: describeError(error) })
    }

    return { ok: true, data: { ...chain.leaf, caPem: chain.chainPem } }
  })

  register(IPC.LOGIN_CLEAR, async () => {
    await controller.clearMainSession()
    return { ok: true, data: undefined }
  })

  register(IPC.APP_RESET_ALL, async () => {
    let failure: unknown
    options.logStream?.stop()

    try {
      await supervisor.stop()
    } catch (error) {
      logger.warn('重置时停止 PC 采集端失败', { error: describeError(error) })
    }

    try {
      supervisor.resetLocalState()
    } catch (error) {
      failure ??= error
      logger.error('重置 PC 采集端本地状态失败', { error: describeError(error) })
    }

    try {
      resetSensorConfigFiles(paths)
    } catch (error) {
      failure ??= error
      logger.error('删除 PC 采集端配置失败', { error: describeError(error) })
    }

    try {
      options.resetAuthState?.()
    } catch (error) {
      logger.warn('重置 Token 注入状态失败', { error: describeError(error) })
    }

    try {
      await controller.resetAll()
    } catch (error) {
      failure ??= error
      logger.error('重置桌面配置失败', { error: describeError(error) })
    }

    try {
      const status = await supervisor.getStatus()
      options.setLastStatus(status)
      options.broadcastStatus?.(status)
    } catch (error) {
      logger.warn('重置后读取 PC 采集端状态失败', { error: describeError(error) })
    }

    if (failure !== undefined) {
      return { ok: false, error: describeError(failure), code: 'RESET_FAILED' }
    }

    logger.info('已重置全部桌面参数')
    return { ok: true, data: undefined }
  })

  register(IPC.SENSOR_CONFIG_GET, async () => ({
    ok: true,
    data: await supervisor.getConfigView(),
  }))

  register(IPC.SENSOR_CONFIG_SAVE, async (_event, ...args) => {
    if (!isRecord(args[0])) {
      return { ok: false, error: '采集端配置无效', code: 'INVALID_INPUT' }
    }
    const patch: SensorConfigPatch = normalizeSensorPatch(args[0])
    const validation = validateSensorConfigPatch(patch)
    if (!validation.ok) {
      return { ok: false, error: validation.message, code: 'INVALID_INPUT' }
    }
    try {
      return { ok: true, data: await supervisor.applyConfig(patch) }
    } catch (error) {
      if (error instanceof SensorRuntimeMissingError) {
        return { ok: false, error: error.message, code: 'RUNTIME_MISSING' }
      }
      throw error
    }
  })

  register(IPC.SENSOR_STATUS_GET, async () => {
    const status = await supervisor.getStatus()
    options.setLastStatus(status)
    return { ok: true, data: status }
  })

  register(IPC.SENSOR_START, async () => {
    await supervisor.start()
    const status = await supervisor.getStatus()
    options.setLastStatus(status)
    return { ok: true, data: status }
  })

  register(IPC.SENSOR_STOP, async () => {
    await supervisor.stop()
    const status = await supervisor.getStatus()
    options.setLastStatus(status)
    return { ok: true, data: status }
  })

  register(IPC.SENSOR_RESTART, async () => {
    await supervisor.restart()
    const status = await supervisor.getStatus()
    options.setLastStatus(status)
    return { ok: true, data: status }
  })

  register(IPC.SENSOR_TEST_LOGIN, async () => {
    const result = await supervisor.testLogin()
    options.setLastStatus(result.status)
    options.broadcastStatus?.(result.status)
    return { ok: true, data: result }
  })

  register(IPC.SENSOR_PANEL_OPEN, async () => {
    await supervisor.start()
    const status = await supervisor.getStatus()
    options.setLastStatus(status)
    if (status.state === 'runtime-missing' || status.state === 'conflict') {
      return {
        ok: false,
        error: status.lastError ?? 'PC 采集端不可用',
        code: 'SENSOR_UNAVAILABLE',
      }
    }
    openSensorWindow({
      baseUrl: supervisor.getBaseUrl(),
      parent: controller.getMainWindow() ?? undefined,
    })
    return { ok: true, data: undefined }
  })

  register(IPC.LOGS_OPEN, async () => {
    const userData = controller.getUserDataDir()
    const targets = [join(userData, 'logs'), join(userData, 'pc-sensor')]
    for (const target of targets) {
      mkdirSync(target, { recursive: true })
      try {
        const failure = await shell.openPath(target)
        if (failure.length > 0) {
          logger.warn('打开日志目录失败', { path: target, error: failure.slice(0, 180) })
        }
      } catch (error) {
        logger.warn('打开日志目录失败', { path: target, error: describeError(error) })
      }
    }
    return { ok: true, data: undefined }
  })

  register(IPC.LOGS_READ, async (_event, ...args) => {
    const userData = controller.getUserDataDir()
    const desktop = readLogTail(
      join(userData, LOG_DIRECTORY_NAME, LOG_FILENAME),
      args[0],
    )
    const sensor = readLogTail(paths.logPath, args[0])
    return { ok: true, data: { desktop, sensor } }
  })

  register(IPC.LOGS_STREAM_START, async (event, ...args) => {
    if (options.logStream === undefined) {
      return { ok: false, error: '日志流不可用', code: 'LOG_STREAM_UNAVAILABLE' }
    }
    const payload = isRecord(args[0]) ? args[0] : {}
    const sources = normalizeLogSources(payload['sources'])
    if (sources === null) {
      return { ok: false, error: '日志来源无效', code: 'INVALID_INPUT' }
    }
    options.logStream.start(event.sender, {
      lines: normalizeLogStreamLines(payload['lines']),
      sources,
    })
    return { ok: true, data: undefined }
  })

  register(IPC.LOGS_STREAM_STOP, async () => {
    options.logStream?.stop()
    return { ok: true, data: undefined }
  })

  register(IPC.APP_OPEN_SETTINGS, async () => {
    await controller.openControl('settings')
    return { ok: true, data: undefined }
  })

  register(IPC.APP_SHOW_MAIN, async () => {
    if (controller.getServerUrl().length === 0) {
      return { ok: false, error: '请先配置服务器地址', code: 'SERVER_NOT_CONFIGURED' }
    }
    controller.showMain()
    controller.focus()
    return { ok: true, data: undefined }
  })

  register(IPC.APP_QUIT, async () => {
    controller.quit()
    return { ok: true, data: undefined }
  })
}
