<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue'
import type { Component } from 'vue'
import {
  ArrowLeft,
  CircleAlert,
  Info,
  Link2,
  LoaderCircle,
  LogOut,
  MonitorCog,
  Network,
  Rocket,
  ShieldAlert,
  TriangleAlert,
} from 'lucide-vue-next'
import type {
  NetworkApplyResult,
  NetworkLayer,
  NetworkStateView,
  SensorConfigView,
  WindowPreferences,
} from '../../../shared/types'
import { useBootstrap } from '../composables/useBootstrap'
import { useDesktopApi } from '../composables/useDesktopApi'
import { useSensorStatus } from '../composables/useSensorStatus'
import { useToast } from '../composables/useToast'
import AppMark from '../components/AppMark.vue'
import LogViewerPanel from '../components/LogViewerPanel.vue'
import NetworkLayersEditor from '../components/NetworkLayersEditor.vue'
import ResetConfirmDialog from '../components/ResetConfirmDialog.vue'
import SensorConfigFields from '../components/SensorConfigFields.vue'
import SensorHealthStrip from '../components/SensorHealthStrip.vue'
import SensorStatusCard from '../components/SensorStatusCard.vue'
import ToggleSwitch from '../components/ToggleSwitch.vue'
import { chromiumVersion, hostOf, platformLabel } from '../lib/format'
import { buildSensorHealth, type LoginTestView } from '../lib/sensor-health'
import { sensorStateMeta } from '../lib/sensor-status'
import {
  buildSensorPatch,
  createEmptySensorConfigView,
  createSensorForm,
  validateSensorForm,
} from '../lib/sensor-form'

type SectionId = 'network' | 'sensor' | 'startup' | 'about' | 'reset'

interface NavItem {
  id: SectionId
  label: string
  icon: Component
}

const NAV_ITEMS: NavItem[] = [
  { id: 'network', label: '网络', icon: Network },
  { id: 'sensor', label: 'PC 采集端', icon: MonitorCog },
  { id: 'startup', label: '启动与行为', icon: Rocket },
  { id: 'about', label: '关于', icon: Info },
  { id: 'reset', label: '重置', icon: ShieldAlert },
]

const NAV_ACTIVATION_OFFSET = 120
const NAV_UNLOCK_DELAY_MS = 150

const api = useDesktopApi()
const toast = useToast()
const { bootstrap, error: bootstrapError, reload } = useBootstrap()
const {
  status,
  loading: sensorStatusLoading,
  error: sensorStatusError,
  refresh: refreshSensorStatus,
} = useSensorStatus()

const activeSection = ref<SectionId>('network')
let navLocked = false
let navUnlockTimer: ReturnType<typeof setTimeout> | null = null
const networkState = ref<NetworkStateView>({ config: { layers: [] }, statuses: [] })
const networkFallbackError = ref<string | null>(null)
const networkLoaded = ref(false)
const windowPrefs = ref<WindowPreferences>({ minimizeToTray: true, openAtLogin: false })
const windowPrefsSaving = ref<keyof WindowPreferences | null>(null)
const windowPrefsError = ref<string | null>(null)
const loginConfirm = ref(false)
const clearingLogin = ref(false)
const panelBusy = ref(false)
const restartBusy = ref(false)
const logsBusy = ref(false)
const backBusy = ref(false)
const loginTestBusy = ref(false)
const loginTestResult = ref<LoginTestView | null>(null)
const logViewerOpen = ref(false)
const resetDialogOpen = ref(false)
const savedSensorView = ref<SensorConfigView | null>(null)
const sensorRuntimeWarning = ref<string | null>(null)
const saveAllBusy = ref(false)

const sensorForm = reactive(createSensorForm(createEmptySensorConfigView()))
let bootstrapSeen = false

watch(
  bootstrap,
  (value) => {
    if (!value) return
    savedSensorView.value = value.sensorConfig
    Object.assign(sensorForm, createSensorForm(value.sensorConfig))
    windowPrefs.value = {
      minimizeToTray: value.config.window.minimizeToTray,
      openAtLogin: value.config.window.openAtLogin,
    }
    if (bootstrapSeen) return
    bootstrapSeen = true
    networkState.value = fallbackNetworkState(value.config.network, value.config.server.url)
    void refreshNetworkState()
    void refreshWindowPreferences()
  },
  { immediate: true },
)

function fallbackNetworkState(
  source: {
    readonly layers: readonly Readonly<NetworkLayer>[]
    readonly activeLayerId?: string
  },
  serverUrl: string,
): NetworkStateView {
  const network = {
    layers: source.layers.map((layer) => ({ ...layer })),
    ...(source.activeLayerId !== undefined ? { activeLayerId: source.activeLayerId } : {}),
  }
  const activeLayerId =
    network.activeLayerId ??
    network.layers.find((layer) => layer.address === serverUrl)?.id
  const view: NetworkStateView = {
    config: network,
    statuses: network.layers.map((layer) => ({
      id: layer.id,
      type: layer.type,
      name: layer.name,
      address: layer.address,
      enabled: layer.enabled,
      tlsMode: layer.tlsMode,
      state: layer.enabled ? 'untested' : 'skipped',
    })),
  }
  const active = network.layers.find((layer) => layer.id === activeLayerId && layer.enabled)
  if (active !== undefined) {
    view.activeLayerId = active.id
    view.activeAddress = active.address
    view.activeTlsMode = active.tlsMode
  }
  return view
}

async function refreshNetworkState(): Promise<void> {
  if (networkLoaded.value) return
  networkLoaded.value = true
  const response = await api.getNetworkLayers()
  if (response.ok) {
    networkState.value = response.data
    networkFallbackError.value = null
    return
  }
  networkFallbackError.value =
    response.code === 'API_UNAVAILABLE'
      ? '当前桌面端未提供网络检测接口，状态将在重启后刷新。'
      : response.error
}

async function refreshWindowPreferences(): Promise<void> {
  const response = await api.getWindowPreferences()
  if (response.ok) windowPrefs.value = response.data
}

function onNetworkApplied(result: NetworkApplyResult): void {
  networkFallbackError.value = null
  networkState.value = {
    config: result.config,
    statuses: result.statuses,
    ...(result.activeLayerId !== undefined ? { activeLayerId: result.activeLayerId } : {}),
    ...(result.activeAddress !== undefined ? { activeAddress: result.activeAddress } : {}),
    ...(result.activeTlsMode !== undefined ? { activeTlsMode: result.activeTlsMode } : {}),
  }
  void refreshSensorStatus()
}

const activeAddress = computed(
  () => networkState.value.activeAddress ?? bootstrap.value?.config.server.url ?? '',
)
const activeLayer = computed(() => {
  const id = networkState.value.activeLayerId
  if (id === undefined) return undefined
  return networkState.value.config.layers.find((layer) => layer.id === id)
})
const activeStatus = computed(() => {
  const id = networkState.value.activeLayerId
  return id === undefined
    ? undefined
    : networkState.value.statuses.find((entry) => entry.id === id)
})
const activeLayerName = computed(() => activeLayer.value?.name ?? '未选择网络层')
const serverHost = computed(() => (activeAddress.value.length > 0 ? hostOf(activeAddress.value) : '未配置'))
const activeConnectionDetail = computed(() =>
  activeLayerName.value === serverHost.value ? '当前网络层' : serverHost.value,
)
const activeConnectionTone = computed(() => {
  if (activeLayer.value === undefined) return 'danger'
  if (activeStatus.value?.state === 'healthy') return 'ok'
  if (activeStatus.value?.state === 'unhealthy') return 'danger'
  return 'neutral'
})
const statusMeta = computed(() => sensorStateMeta(status.value?.state))
const sensorHealth = computed(() =>
  buildSensorHealth(status.value, sensorStatusError.value, sensorStatusLoading.value),
)
const appVersion = computed(() => bootstrap.value?.appVersion ?? '未知')
const electronVersion = computed(() => bootstrap.value?.electronVersion ?? '未知')
const platform = computed(() => platformLabel(bootstrap.value?.platform ?? ''))
const chromium = chromiumVersion()

function jumpTo(id: SectionId): void {
  activeSection.value = id
  navLocked = true
  if (navUnlockTimer !== null) {
    clearTimeout(navUnlockTimer)
    navUnlockTimer = null
  }
  void nextTick(() => {
    const element = document.getElementById(`section-${id}`)
    if (element && typeof element.scrollIntoView === 'function') {
      element.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  })
}

function releaseNavLockSoon(): void {
  if (navUnlockTimer !== null) clearTimeout(navUnlockTimer)
  navUnlockTimer = setTimeout(() => {
    navLocked = false
    navUnlockTimer = null
  }, NAV_UNLOCK_DELAY_MS)
}

function onSettingsScroll(event: Event): void {
  const container = event.currentTarget
  if (!(container instanceof HTMLElement)) return
  if (navLocked) {
    releaseNavLockSoon()
    return
  }
  const containerTop = container.getBoundingClientRect().top
  if (container.scrollTop + container.clientHeight >= container.scrollHeight - 2) {
    activeSection.value = NAV_ITEMS[NAV_ITEMS.length - 1]?.id ?? 'network'
    return
  }
  const activationLine = containerTop + NAV_ACTIVATION_OFFSET
  let current: SectionId = 'network'
  for (const item of NAV_ITEMS) {
    const section = document.getElementById(`section-${item.id}`)
    if (!section) continue
    if (section.getBoundingClientRect().top <= activationLine) current = item.id
  }
  activeSection.value = current
}

onBeforeUnmount(() => {
  if (navUnlockTimer !== null) {
    clearTimeout(navUnlockTimer)
    navUnlockTimer = null
  }
})

async function updateWindowPreference(
  key: keyof WindowPreferences,
  value: boolean,
): Promise<void> {
  if (windowPrefsSaving.value !== null) return
  const previous = { ...windowPrefs.value }
  const next = { ...previous, [key]: value }
  windowPrefs.value = next
  windowPrefsSaving.value = key
  windowPrefsError.value = null
  const response = await api.saveWindowPreferences(next)
  windowPrefsSaving.value = null
  if (!response.ok) {
    windowPrefs.value = previous
    windowPrefsError.value = response.error || '启动设置保存失败'
    toast.error(windowPrefsError.value)
    return
  }
  windowPrefs.value = response.data
  toast.success('启动与行为已保存')
}

async function saveAll(): Promise<void> {
  sensorRuntimeWarning.value = null
  const address = activeAddress.value
  if (address.length === 0) {
    toast.error('请先在网络设置中保存一个可用的网络层')
    jumpTo('network')
    return
  }
  const validation = validateSensorForm(sensorForm, address)
  if (!validation.ok) {
    toast.error(validation.message ?? '采集端配置不完整')
    return
  }

  saveAllBusy.value = true
  const response = await api.saveSensorConfig(buildSensorPatch(sensorForm, address))
  saveAllBusy.value = false

  if (!response.ok) {
    if (response.code === 'RUNTIME_MISSING') {
      sensorRuntimeWarning.value = response.error || '缺少内置 PC 采集端运行时'
      toast.warning('网络配置已保存；PC 采集端运行时缺失')
      await refreshSensorStatus()
      return
    }
    toast.error(response.error || '采集端配置保存失败')
    return
  }

  savedSensorView.value = response.data
  windowPrefsError.value = null
  toast.success('更改已保存')
  await refreshSensorStatus()
}

function discardChanges(): void {
  const view = savedSensorView.value ?? bootstrap.value?.sensorConfig ?? createEmptySensorConfigView()
  Object.assign(sensorForm, createSensorForm(view))
  sensorRuntimeWarning.value = null
  loginConfirm.value = false
  toast.info('已还原为已保存的配置')
}

function requestClearLogin(): void {
  loginConfirm.value = true
}

async function confirmClearLogin(): Promise<void> {
  clearingLogin.value = true
  const response = await api.clearLogin()
  clearingLogin.value = false
  if (!response.ok) {
    toast.error(response.error || '清除登录状态失败')
    return
  }
  loginConfirm.value = false
  toast.success('已清除当前服务器的网页登录状态')
}

async function openPanel(): Promise<void> {
  panelBusy.value = true
  const response = await api.openSensorPanel()
  panelBusy.value = false
  if (response.ok) toast.success('已打开采集端面板')
  else toast.error(response.error)
}

async function restartSensor(): Promise<void> {
  restartBusy.value = true
  loginTestResult.value = null
  const response = await api.restartSensor()
  restartBusy.value = false
  if (response.ok) {
    toast.success('已请求重启采集端')
    await refreshSensorStatus()
  } else {
    toast.error(response.error)
  }
}

async function testSensorLogin(): Promise<void> {
  if (loginTestBusy.value) return
  loginTestBusy.value = true
  loginTestResult.value = null
  const response = await api.testSensorLogin()
  loginTestBusy.value = false

  if (!response.ok) {
    loginTestResult.value = {
      success: false,
      message:
        response.code === 'API_UNAVAILABLE'
          ? '当前桌面端不支持测试登录，请更新或重启桌面端后重试。'
          : response.error || '测试登录失败',
    }
    return
  }
  loginTestResult.value = {
    success: response.data.success && response.data.loggedIn,
    message: response.data.message,
    authError: response.data.authError,
  }
  await refreshSensorStatus()
}

function openLogViewer(): void {
  logViewerOpen.value = true
}

function openResetDialog(): void {
  resetDialogOpen.value = true
}

async function openLogsFolder(): Promise<void> {
  logsBusy.value = true
  const response = await api.openLogs()
  logsBusy.value = false
  if (!response.ok) toast.error(response.error)
}

async function backToMain(): Promise<void> {
  if (backBusy.value) return
  backBusy.value = true
  const response = await api.showMain()
  backBusy.value = false
  if (!response.ok) toast.error(response.error)
}
</script>

<template>
  <main class="settings-page">
    <aside class="rail">
      <div class="rail__brand">
        <AppMark :size="32" />
      </div>

      <button
        type="button"
        class="rail__back"
        data-test="back-to-main-rail"
        aria-label="返回主界面"
        :disabled="backBusy"
        @click="backToMain"
      >
        <LoaderCircle v-if="backBusy" class="spinner" :size="15" :stroke-width="2" />
        <ArrowLeft v-else :size="15" :stroke-width="2" />
        <span>返回主界面</span>
      </button>

      <nav class="rail__nav" aria-label="设置分类">
        <button
          v-for="item in NAV_ITEMS"
          :key="item.id"
          type="button"
          class="rail__item"
          :class="{ 'is-active': activeSection === item.id }"
          :data-test="`nav-${item.id}`"
          :title="item.label"
          :aria-label="item.label"
          :aria-current="activeSection === item.id ? 'page' : undefined"
          @click="jumpTo(item.id)"
        >
          <component :is="item.icon" :size="16" :stroke-width="1.9" />
          <span>{{ item.label }}</span>
        </button>
      </nav>

      <button
        type="button"
        class="rail__status"
        title="查看 PC 采集端状态"
        aria-label="查看 PC 采集端状态"
        @click="jumpTo('sensor')"
      >
        <span
          class="status-dot"
          :class="`status-dot--${statusMeta.tone}`"
          aria-hidden="true"
        />
        <span class="rail__status-text">
          <small>PC 采集端</small>
          <strong>{{ statusMeta.label }}</strong>
        </span>
      </button>
    </aside>

    <div class="settings-main">
      <header class="settings-head">
        <div class="settings-head__inner">
          <div class="settings-head__title">
            <p class="eyebrow">KINSHIP DESKTOP</p>
            <h1>桌面设置</h1>
            <p>管理网络层、PC 采集端与启动行为。配置只保存在本机。</p>
          </div>
          <div class="settings-head__actions">
            <span class="server-chip" :title="activeAddress || '尚未配置网络层'" data-test="active-connection">
              <span
                class="status-dot"
                :class="`status-dot--${activeConnectionTone}`"
                aria-hidden="true"
              />
              <Link2 :size="13" :stroke-width="2" aria-hidden="true" />
              <span class="server-chip__text">
                <strong>{{ activeLayerName }}</strong>
                <span class="mono">{{ activeConnectionDetail }}</span>
              </span>
            </span>
            <button
              type="button"
              class="btn btn--sm"
              data-test="back-to-main"
              :disabled="backBusy"
              @click="backToMain"
            >
              <LoaderCircle v-if="backBusy" class="spinner" :size="14" :stroke-width="2" />
              <ArrowLeft v-else :size="14" :stroke-width="2" />
              返回主界面
            </button>
          </div>
        </div>
      </header>

      <div class="settings-scroll" @scroll.passive="onSettingsScroll">
        <div class="settings-content">
          <SensorHealthStrip
            :health="sensorHealth"
            :login-busy="loginTestBusy"
            :restart-busy="restartBusy"
            @show-details="jumpTo('sensor')"
            @test-login="testSensorLogin"
            @open-logs="openLogViewer"
            @restart="restartSensor"
          />

          <div v-if="bootstrapError" class="notice notice--warning" role="alert">
            <TriangleAlert :size="15" :stroke-width="2" />
            <div>
              <strong>无法读取桌面配置</strong>
              {{ bootstrapError }}
              <button type="button" class="link-btn" @click="reload">重试</button>
            </div>
          </div>

          <section id="section-network" class="settings-section" aria-labelledby="network-title">
            <div class="section-heading">
              <h2 id="network-title">网络</h2>
              <p>有序网络层，第一个健康的层同时用于网页与 PC 采集端。</p>
            </div>

            <div class="settings-panel">
              <div v-if="networkFallbackError" class="notice notice--warning" role="status" data-test="network-fallback-warning">
                <TriangleAlert :size="15" :stroke-width="2" />
                <div>{{ networkFallbackError }}</div>
              </div>

              <NetworkLayersEditor
                :network="networkState.config"
                :statuses="networkState.statuses"
                :active-layer-id="networkState.activeLayerId"
                @applied="onNetworkApplied"
              />

              <div class="divider" />

              <div class="setting-row">
                <div>
                  <strong class="setting-row__title">网页登录状态</strong>
                  <p class="setting-row__desc">
                    仅清除内嵌 Web 应用在 <span class="mono">{{ serverHost }}</span> 这个源上的登录令牌，不影响 PC 采集端凭据。
                  </p>
                </div>
                <button
                  v-if="!loginConfirm"
                  type="button"
                  class="btn btn--sm"
                  data-test="clear-login"
                  @click="requestClearLogin"
                >
                  <LogOut :size="14" :stroke-width="2" />
                  清除网页登录状态
                </button>
              </div>

              <div v-if="loginConfirm" class="confirm-strip">
                <div>
                  <strong>确认清除该服务器的网页登录状态？</strong>
                  <p>下次打开主界面时需要重新登录，本机桌面设置不会被删除。</p>
                </div>
                <div class="inline-actions">
                  <button type="button" class="btn btn--sm" @click="loginConfirm = false">
                    取消
                  </button>
                  <button
                    type="button"
                    class="btn btn--sm btn--danger"
                    data-test="confirm-clear-login"
                    :disabled="clearingLogin"
                    @click="confirmClearLogin"
                  >
                    <LoaderCircle v-if="clearingLogin" class="spinner" :size="14" :stroke-width="2" />
                    确认清除
                  </button>
                </div>
              </div>
            </div>
          </section>

          <section id="section-sensor" class="settings-section" aria-labelledby="sensor-title">
            <div class="section-heading">
              <h2 id="sensor-title">PC 采集端</h2>
              <p>采集前台窗口、空闲与锁屏状态，并通过当前网络层上报。</p>
            </div>

            <div class="settings-panel">
              <SensorStatusCard
                :status="status"
                :status-error="sensorStatusError"
                :server-url="activeAddress"
                :login-busy="loginTestBusy"
                :login-result="loginTestResult"
                :panel-busy="panelBusy"
                :restart-busy="restartBusy"
                :logs-busy="logsBusy"
                @test-login="testSensorLogin"
                @open-panel="openPanel"
                @restart="restartSensor"
                @open-logs="openLogViewer"
                @open-log-folder="openLogsFolder"
              />

              <div
                v-if="sensorRuntimeWarning"
                class="notice notice--warning"
                role="status"
                data-test="sensor-runtime-warning"
              >
                <TriangleAlert :size="15" :stroke-width="2" />
                <div>
                  <strong>PC 采集端运行时缺失</strong>
                  {{ sensorRuntimeWarning }}
                  <p class="setting-row__desc">网络配置已保存。安装或修复内置运行时后重启桌面端即可。</p>
                </div>
              </div>

              <div class="divider" />

              <SensorConfigFields :form="sensorForm" :server-url="activeAddress" />
            </div>
          </section>

          <section id="section-startup" class="settings-section" aria-labelledby="startup-title">
            <div class="section-heading">
              <h2 id="startup-title">启动与行为</h2>
              <p>修改立即保存。关闭窗口时保留后台采集，或跟随 Windows 登录自动启动。</p>
            </div>

            <div class="settings-panel">
              <div class="switch-row">
                <div class="switch-row__text">
                  <strong>关闭窗口时最小化到托盘</strong>
                  <small>保持桌面端与 PC 采集端在后台运行。关闭后关闭窗口会销毁主窗口，托盘存在时应用仍不退出。</small>
                </div>
                <ToggleSwitch
                  :model-value="windowPrefs.minimizeToTray"
                  label="关闭窗口时最小化到托盘"
                  test-id="startup-minimize-to-tray"
                  :disabled="windowPrefsSaving !== null"
                  @update:model-value="updateWindowPreference('minimizeToTray', $event)"
                />
              </div>
              <div class="switch-row">
                <div class="switch-row__text">
                  <strong>登录 Windows 时自动启动</strong>
                  <small>登录系统后自动打开桌面端并启动采集端。</small>
                </div>
                <ToggleSwitch
                  :model-value="windowPrefs.openAtLogin"
                  label="登录 Windows 时自动启动"
                  test-id="startup-open-at-login"
                  :disabled="windowPrefsSaving !== null"
                  @update:model-value="updateWindowPreference('openAtLogin', $event)"
                />
              </div>
              <div v-if="windowPrefsError" class="notice notice--danger" role="alert" data-test="startup-error">
                <CircleAlert :size="15" :stroke-width="2" />
                <div>{{ windowPrefsError }}</div>
              </div>
            </div>
          </section>

          <section id="section-about" class="settings-section" aria-labelledby="about-title">
            <div class="section-heading">
              <h2 id="about-title">关于</h2>
              <p>Kinship Desktop 的版本与运行环境信息。</p>
            </div>

            <div class="settings-panel">
              <dl class="kv about-grid">
                <dt>应用</dt>
                <dd>Kinship Desktop</dd>
                <dt>版本</dt>
                <dd class="mono">{{ appVersion }}</dd>
                <dt>Electron</dt>
                <dd class="mono">{{ electronVersion }}</dd>
                <dt>Chromium</dt>
                <dd class="mono">{{ chromium }}</dd>
                <dt>运行平台</dt>
                <dd>{{ platform }}</dd>
                <dt>许可</dt>
                <dd>Apache 2.0</dd>
              </dl>
              <p class="about-note">
                本设置界面运行在本地，不加载远程资源。Web 主界面由服务器提供，并在独立主窗口中打开。
              </p>
            </div>
          </section>

          <section id="section-reset" class="settings-section" aria-labelledby="reset-title">
            <div class="section-heading">
              <h2 id="reset-title">重置</h2>
              <p>清除本机保存的桌面参数，并回到首次启动设置。</p>
            </div>

            <div class="settings-panel" data-test="reset-section">
              <div class="reset-zone">
                <span class="reset-zone__emblem" aria-hidden="true">
                  <ShieldAlert :size="17" :stroke-width="2" />
                </span>
                <div>
                  <strong class="reset-zone__title">重置所有参数</strong>
                  <p class="reset-zone__desc">
                    删除桌面端与 PC 采集端的本机配置，桌面端会回到首次启动设置。
                  </p>
                </div>
              </div>

              <div class="reset-zone__panel">
                <p class="reset-zone__label">将被清除</p>
                <ul class="reset-zone__list">
                  <li>网络层与当前连接</li>
                  <li>证书信任与 CA 证书</li>
                  <li>PC 采集端账号与访问令牌</li>
                  <li>采集参数</li>
                  <li>窗口与启动设置</li>
                  <li>网页登录状态</li>
                </ul>
              </div>

              <p class="reset-zone__keep">
                运行日志会保留，不会被删除。重置完成后需要重新配置网络层与 PC 采集端。
              </p>

              <div class="reset-zone__actions">
                <button
                  type="button"
                  class="btn btn--danger"
                  data-test="reset-all"
                  @click="openResetDialog"
                >
                  <ShieldAlert :size="15" :stroke-width="2" />
                  重置所有参数
                </button>
                <span class="reset-zone__warning">此操作不可撤销</span>
              </div>
            </div>
          </section>
        </div>
      </div>

      <footer class="settings-foot">
        <p class="settings-foot__note">
          PC 采集端设置在保存后写入本机。网络层与启动行为修改后立即保存。
        </p>
        <div class="inline-actions">
          <button type="button" class="btn btn--ghost" data-test="discard" @click="discardChanges">
            还原采集端
          </button>
          <button
            type="button"
            class="btn btn--primary"
            data-test="save-all"
            :disabled="saveAllBusy"
            @click="saveAll"
          >
            <LoaderCircle v-if="saveAllBusy" class="spinner" :size="15" :stroke-width="2" />
            {{ saveAllBusy ? '保存中…' : '保存采集端设置' }}
          </button>
        </div>
      </footer>
    </div>

    <LogViewerPanel
      :open="logViewerOpen"
      @close="logViewerOpen = false"
      @open-folder="openLogsFolder"
    />

    <ResetConfirmDialog :open="resetDialogOpen" @close="resetDialogOpen = false" />
  </main>
</template>

<style scoped>
.settings-page {
  display: grid;
  grid-template-columns: var(--rail-width) minmax(0, 1fr);
  height: 100vh;
  overflow: hidden;
  background: var(--bg);
}

.rail {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
  height: 100vh;
  padding: var(--space-5) var(--space-3) var(--space-4);
  border-right: 1px solid var(--border);
  background: var(--surface);
}

.rail__brand {
  padding: 0 var(--space-2);
}

.rail__back {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 34px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--ink);
  font-size: var(--text-sm);
  font-weight: 500;
  text-align: left;
  cursor: pointer;
}

.rail__back:hover:not(:disabled) {
  background: var(--inset);
}

.rail__back:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.rail__back:focus-visible,
.rail__item:focus-visible,
.rail__status:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 1px;
}

.rail__nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.rail__item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 36px;
  padding: 0 10px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-muted);
  font-size: var(--text-sm);
  font-weight: 500;
  text-align: left;
  cursor: pointer;
}

.rail__item svg {
  color: var(--text-faint);
}

.rail__item:hover {
  background: var(--inset);
  color: var(--ink);
}

.rail__item.is-active {
  background: var(--inset);
  color: var(--ink);
}

.rail__item.is-active svg {
  color: var(--accent);
}

.rail__status {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  margin-top: auto;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg);
  text-align: left;
  cursor: pointer;
}

.rail__status:hover {
  border-color: var(--border-strong);
}

.rail__status-text {
  min-width: 0;
}

.rail__status-text small {
  display: block;
  color: var(--text-faint);
  font-size: 9px;
  font-weight: 500;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.rail__status-text strong {
  display: block;
  margin-top: 1px;
  color: var(--ink);
  font-size: var(--text-sm);
  font-weight: 500;
}

.settings-main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  height: 100vh;
  overflow: hidden;
}

.settings-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  scroll-behavior: smooth;
}

.settings-content {
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
  width: min(var(--content-max), 100%);
  margin: 0 auto;
  padding: var(--space-4) var(--space-6) var(--space-8);
}

.settings-head {
  flex: none;
  width: 100%;
  border-bottom: 1px solid var(--border);
  background: var(--bg);
}

.settings-head__inner {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-5);
  width: min(var(--content-max), 100%);
  margin: 0 auto;
  padding: var(--space-6) var(--space-6) var(--space-3);
}

.settings-head h1 {
  margin: 3px 0 0;
  font-family: var(--font-display);
  font-size: var(--text-2xl);
  font-weight: 600;
  letter-spacing: -0.01em;
}

.settings-head__title {
  min-width: 0;
}

.settings-head__title > p:last-child {
  max-width: 62ch;
  margin: 5px 0 0;
  color: var(--text-muted);
  font-size: var(--text-md);
  line-height: 1.65;
}

.settings-head__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2);
}

.server-chip {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  max-width: 280px;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
  color: var(--text-muted);
  font-size: var(--text-xs);
}

.server-chip__text {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 0;
  line-height: 1.35;
}

.server-chip__text strong {
  overflow: hidden;
  color: var(--ink);
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.server-chip__text span {
  overflow: hidden;
  color: var(--text-faint);
  font-size: 10.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.settings-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  scroll-margin-top: 96px;
}

.section-heading {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px var(--space-3);
}

.section-heading h2 {
  margin: 0;
  font-family: var(--font-display);
  font-size: var(--text-lg);
  font-weight: 600;
  letter-spacing: 0;
}

.section-heading p {
  margin: 0;
  color: var(--text-muted);
  font-size: var(--text-sm);
  line-height: 1.5;
}

.settings-panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  min-width: 0;
  padding-top: var(--space-3);
  border-top: 1px solid var(--border);
}

.setting-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-5);
}

.setting-row__title {
  display: block;
  color: var(--ink);
  font-size: var(--text-sm);
  font-weight: 500;
}

.setting-row__desc {
  margin: 3px 0 0;
  color: var(--text-muted);
  font-size: var(--text-xs);
  line-height: 1.65;
}

.confirm-strip {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-3);
  border: 1px solid var(--danger-border);
  border-radius: var(--radius-sm);
  background: var(--danger-surface);
}

.confirm-strip strong {
  display: block;
  color: var(--danger-ink);
  font-size: var(--text-sm);
  font-weight: 500;
}

.confirm-strip p {
  margin: 3px 0 0;
  color: var(--text-muted);
  font-size: var(--text-xs);
  line-height: 1.6;
}

.about-grid {
  grid-template-columns: 106px minmax(0, 1fr);
}

.about-note {
  margin: 0;
  padding-top: var(--space-3);
  border-top: 1px solid var(--border);
  color: var(--text-muted);
  font-size: var(--text-xs);
  line-height: 1.7;
}

.reset-zone {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
}

.reset-zone__emblem {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  flex: none;
  border: 1px solid var(--danger-border);
  border-radius: var(--radius-sm);
  background: var(--danger-surface);
  color: var(--danger-ink);
}

.reset-zone__title {
  display: block;
  color: var(--danger-ink);
  font-size: var(--text-md);
  font-weight: 500;
}

.reset-zone__desc {
  max-width: 62ch;
  margin: 3px 0 0;
  color: var(--text-muted);
  font-size: var(--text-xs);
  line-height: 1.65;
}

.reset-zone__panel {
  padding: var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
}

.reset-zone__label {
  margin: 0;
  color: var(--text-faint);
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.reset-zone__list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px var(--space-4);
  margin: var(--space-2) 0 0;
  padding: 0;
  list-style: none;
  color: var(--text-muted);
  font-size: var(--text-xs);
  line-height: 1.55;
}

.reset-zone__list li {
  position: relative;
  padding-left: 13px;
}

.reset-zone__list li::before {
  position: absolute;
  top: 0.55em;
  left: 2px;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--danger);
  content: '';
}

.reset-zone__keep {
  margin: 0;
  color: var(--text-muted);
  font-size: var(--text-xs);
  line-height: 1.65;
}

.reset-zone__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
}

.reset-zone__warning {
  color: var(--danger-ink);
  font-size: var(--text-xs);
  font-weight: 500;
}

.settings-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-5);
  padding: var(--space-3) var(--space-5);
  border-top: 1px solid var(--border);
  background: var(--bg);
}

.settings-foot__note {
  margin: 0;
  color: var(--text-faint);
  font-size: var(--text-xs);
}

@media (max-width: 1180px) {
  .settings-page {
    grid-template-columns: var(--rail-width-compact) minmax(0, 1fr);
  }

  .rail {
    align-items: center;
    padding: var(--space-5) 8px var(--space-3);
  }

  .rail__brand {
    padding: 0;
  }

  .rail :deep(.app-mark__text) {
    display: none;
  }

  .rail__item,
  .rail__back {
    justify-content: center;
    width: 40px;
    padding: 0;
  }

  .rail__item span,
  .rail__back span,
  .rail__status-text {
    display: none;
  }

  .rail__status {
    justify-content: center;
    width: 40px;
    padding: 10px 0;
  }

  .settings-head__inner {
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-5) var(--space-4) var(--space-3);
  }

  .settings-head__actions {
    width: 100%;
    justify-content: flex-start;
  }

  .settings-content {
    padding: var(--space-4) var(--space-4) var(--space-7);
  }
}

@media (max-width: 640px) {
  .settings-foot {
    flex-wrap: wrap;
    padding: var(--space-3) var(--space-4);
  }

  .setting-row,
  .confirm-strip {
    flex-direction: column;
    align-items: stretch;
  }

  .reset-zone__list {
    grid-template-columns: minmax(0, 1fr);
  }

  .about-grid {
    grid-template-columns: 88px minmax(0, 1fr);
  }
}
</style>
