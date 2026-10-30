<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CircleAlert,
  CircleCheck,
  LoaderCircle,
  MonitorCog,
  TriangleAlert,
  Wifi,
} from 'lucide-vue-next'
import type { NetworkApplyResult, NetworkStateView } from '../../../shared/types'
import { useBootstrap } from '../composables/useBootstrap'
import { useDesktopApi } from '../composables/useDesktopApi'
import { useToast } from '../composables/useToast'
import AppMark from '../components/AppMark.vue'
import NetworkLayersEditor from '../components/NetworkLayersEditor.vue'
import SensorConfigFields from '../components/SensorConfigFields.vue'
import {
  buildSensorPatch,
  createEmptySensorConfigView,
  createSensorForm,
  validateSensorForm,
} from '../lib/sensor-form'

const route = useRoute()
const api = useDesktopApi()
const toast = useToast()
const { bootstrap, error: bootstrapError, reload } = useBootstrap()

const step = ref<1 | 2>(1)
const saving = ref(false)
const enteringMain = ref(false)
const finished = ref(false)
const saveError = ref<string | null>(null)
const runtimeWarning = ref<string | null>(null)
const sensorBusy = ref<'panel' | 'restart' | null>(null)
const networkState = ref<NetworkStateView>({ config: { layers: [] }, statuses: [] })
const activeAddress = ref('')
const networkSaved = ref(false)
const networkEditor = ref<InstanceType<typeof NetworkLayersEditor> | null>(null)

const sensorForm = reactive(createSensorForm(createEmptySensorConfigView()))
let sensorInitialized = false
let bootstrapSeen = false
let networkLoaded = false

const showConfiguredBanner = computed(
  () => route.name === 'setup' && bootstrap.value !== null && !bootstrap.value.firstRun,
)
const sensorServerUrl = computed(() => activeAddress.value)

watch(
  bootstrap,
  (value) => {
    if (!value) return
    if (!sensorInitialized) {
      Object.assign(sensorForm, createSensorForm(value.sensorConfig))
      sensorInitialized = true
    }
    if (bootstrapSeen) return
    bootstrapSeen = true
    const ownNetwork = {
      layers: value.config.network.layers.map((layer) => ({ ...layer })),
      ...(value.config.network.activeLayerId !== undefined
        ? { activeLayerId: value.config.network.activeLayerId }
        : {}),
    }
    networkState.value = {
      config: ownNetwork,
      statuses: ownNetwork.layers.map((layer) => ({
        id: layer.id,
        type: layer.type,
        name: layer.name,
        address: layer.address,
        enabled: layer.enabled,
        tlsMode: layer.tlsMode,
        state: layer.enabled ? 'untested' : 'skipped',
      })),
      ...(value.config.network.activeLayerId !== undefined
        ? { activeLayerId: value.config.network.activeLayerId }
        : {}),
    }
    if (value.config.server.url.length > 0) activeAddress.value = value.config.server.url
    void loadNetworkState()
  },
  { immediate: true },
)

async function loadNetworkState(): Promise<void> {
  if (networkLoaded) return
  networkLoaded = true
  const response = await api.getNetworkLayers()
  if (!response.ok) return
  networkState.value = response.data
  if (response.data.activeAddress !== undefined) {
    activeAddress.value = response.data.activeAddress
  }
}

function onNetworkApplied(result: NetworkApplyResult): void {
  networkState.value = {
    config: result.config,
    statuses: result.statuses,
    ...(result.activeLayerId !== undefined ? { activeLayerId: result.activeLayerId } : {}),
    ...(result.activeAddress !== undefined ? { activeAddress: result.activeAddress } : {}),
    ...(result.activeTlsMode !== undefined ? { activeTlsMode: result.activeTlsMode } : {}),
  }
  if (result.activeAddress !== undefined) activeAddress.value = result.activeAddress
}

async function goNext(): Promise<void> {
  if (saving.value) return
  saveError.value = null
  saving.value = true
  const result = await networkEditor.value?.save()
  saving.value = false

  if (result === null || result === undefined) {
    networkSaved.value = false
    if (networkEditor.value === null) saveError.value = '网络层尚未保存，请重试。'
    return
  }
  if (
    result.error !== undefined ||
    result.activeLayerId === undefined ||
    result.activeAddress === undefined
  ) {
    networkSaved.value = false
    return
  }
  networkSaved.value = true
  activeAddress.value = result.activeAddress
  saveError.value = null
  step.value = 2
}

function goBack(): void {
  if (saving.value || finished.value) return
  step.value = 1
}

async function openPanel(): Promise<void> {
  sensorBusy.value = 'panel'
  const response = await api.openSensorPanel()
  sensorBusy.value = null
  if (response.ok) {
    toast.success('已打开采集端面板')
  } else {
    toast.error(response.error)
  }
}

async function restartSensor(): Promise<void> {
  sensorBusy.value = 'restart'
  const response = await api.restartSensor()
  sensorBusy.value = null
  if (response.ok) {
    toast.success('已请求重启采集端')
  } else {
    toast.error(response.error)
  }
}

async function finishSetup(): Promise<void> {
  saveError.value = null
  runtimeWarning.value = null
  if (!networkSaved.value || activeAddress.value.length === 0) {
    step.value = 1
    saveError.value = '请先保存至少一个可用的网络层'
    return
  }

  const sensorValidation = validateSensorForm(sensorForm, activeAddress.value)
  if (!sensorValidation.ok) {
    saveError.value = sensorValidation.message ?? '采集端配置不完整'
    return
  }

  saving.value = true
  const sensorResponse = await api.saveSensorConfig(
    buildSensorPatch(sensorForm, activeAddress.value),
  )
  saving.value = false

  if (!sensorResponse.ok) {
    if (sensorResponse.code === 'RUNTIME_MISSING') {
      runtimeWarning.value = sensorResponse.error || '缺少内置 PC 采集端运行时'
      finished.value = true
      toast.warning('网络层已保存；PC 采集端运行时缺失')
      return
    }
    saveError.value = sensorResponse.error || '采集端配置保存失败'
    toast.error(saveError.value)
    return
  }

  finished.value = true
  toast.success('配置已保存')
}

async function enterMain(): Promise<void> {
  if (enteringMain.value) return
  enteringMain.value = true
  saveError.value = null
  const response = await api.showMain()
  enteringMain.value = false
  if (!response.ok) {
    saveError.value = response.error || '无法打开主界面'
    toast.error(saveError.value)
    return
  }
  toast.success('主界面已打开')
}
</script>

<template>
  <main class="setup-page">
    <section class="setup-card" aria-labelledby="setup-title">
      <header class="setup-head">
        <div class="setup-brand">
          <AppMark :size="34" />
          <span class="setup-head__tag">本地设置</span>
        </div>
        <span class="setup-head__meta mono">KINSHIP DESKTOP</span>
      </header>

      <ol class="progress" aria-label="设置进度">
        <li class="progress__step" :class="{ 'is-active': step === 1, 'is-done': step === 2 || finished }">
          <span class="progress__index" aria-hidden="true">
            <Check v-if="step === 2 || finished" :size="13" :stroke-width="2.6" />
            <template v-else>1</template>
          </span>
          <span class="progress__labels">
            <strong>网络层</strong>
            <small>直连或 FRP，按顺序探测</small>
          </span>
        </li>
        <li class="progress__line" :class="{ 'is-done': step === 2 || finished }" aria-hidden="true" />
        <li class="progress__step" :class="{ 'is-active': step === 2 && !finished, 'is-done': finished }">
          <span class="progress__index" aria-hidden="true">
            <Check v-if="finished" :size="13" :stroke-width="2.6" />
            <template v-else>2</template>
          </span>
          <span class="progress__labels">
            <strong>PC 采集端</strong>
            <small>认证与采集范围</small>
          </span>
        </li>
      </ol>

      <div v-if="showConfiguredBanner" class="notice notice--accent setup-banner">
        <Check :size="15" :stroke-width="2" />
        <div>
          <strong>已配置</strong>
          此设备已完成初始化。继续操作会更新现有设置。
        </div>
      </div>

      <div v-if="bootstrapError" class="notice notice--warning setup-banner" role="alert">
        <TriangleAlert :size="15" :stroke-width="2" />
        <div>
          <strong>无法读取已有配置</strong>
          {{ bootstrapError }}。本次将使用默认值。
          <button type="button" class="link-btn" @click="reload">重试</button>
        </div>
      </div>

      <div class="setup-body">
        <div v-if="finished" class="setup-success" data-test="setup-success">
          <span class="setup-success__icon" aria-hidden="true">
            <CircleCheck :size="22" :stroke-width="2" />
          </span>
          <div>
            <h2 id="setup-title">配置已保存</h2>
            <p>网络层与 PC 采集端设置已写入本机。你可以进入主界面，或稍后在设置中继续调整。</p>
            <p class="mono setup-success__url">{{ activeAddress }}</p>
          </div>
        </div>

        <div
          v-if="finished && runtimeWarning"
          class="notice notice--warning runtime-warning"
          role="status"
          data-test="runtime-warning"
        >
          <TriangleAlert :size="15" :stroke-width="2" />
          <div>
            <strong>PC 采集端暂不可用</strong>
            {{ runtimeWarning }}
            <p class="runtime-warning__hint">
              可先进入主界面；安装 PC 采集端运行时后重启桌面端即可。
            </p>
          </div>
        </div>

        <template v-else>
          <div v-if="step === 1" key="network" class="step-panel" data-test="setup-network-step">
            <header class="step-heading">
              <p class="eyebrow">步骤 01</p>
              <h1 id="setup-title">配置网络层</h1>
              <p>
                按顺序添加直连或 FRP 地址。第一个健康的层会同时作为网页来源与 PC 采集端的上报地址。
              </p>
            </header>

            <NetworkLayersEditor
              ref="networkEditor"
              :network="networkState.config"
              :statuses="networkState.statuses"
              :active-layer-id="networkState.activeLayerId"
              auto-seed
              @applied="onNetworkApplied"
            />
          </div>

          <div v-else key="sensor" class="step-panel" data-test="setup-sensor-step">
            <header class="step-heading">
              <p class="eyebrow">步骤 02</p>
              <h1 id="setup-title">配置 PC 采集端</h1>
              <p>采集端会记录前台窗口、空闲与锁屏状态，并通过当前网络层上报。</p>
              <p class="step-heading__meta mono">当前网络层 {{ activeAddress }}</p>
            </header>

            <SensorConfigFields :form="sensorForm" :server-url="sensorServerUrl">
              <template #actions>
                <button
                  type="button"
                  class="btn btn--sm"
                  data-test="open-panel-setup"
                  :disabled="sensorBusy !== null"
                  @click="openPanel"
                >
                  <LoaderCircle v-if="sensorBusy === 'panel'" class="spinner" :size="14" :stroke-width="2" />
                  <MonitorCog v-else :size="14" :stroke-width="2" />
                  打开采集端面板
                </button>
                <button
                  type="button"
                  class="btn btn--sm"
                  data-test="restart-sensor-setup"
                  :disabled="sensorBusy !== null"
                  @click="restartSensor"
                >
                  <LoaderCircle v-if="sensorBusy === 'restart'" class="spinner" :size="14" :stroke-width="2" />
                  <Wifi v-else :size="14" :stroke-width="2" />
                  重启采集端
                </button>
              </template>
            </SensorConfigFields>
          </div>
        </template>

        <div v-if="saveError" class="notice notice--danger" role="alert" data-test="setup-save-error">
          <CircleAlert :size="15" :stroke-width="2" />
          <div>
            <strong>保存失败</strong>
            {{ saveError }}
          </div>
        </div>
      </div>

      <footer class="setup-foot">
        <div class="setup-foot__left">
          <button
            v-if="step === 2 && !finished"
            type="button"
            class="btn btn--ghost"
            data-test="back-step"
            :disabled="saving"
            @click="goBack"
          >
            <ArrowLeft :size="15" :stroke-width="2" />
            上一步
          </button>
        </div>

        <div class="setup-foot__right">
          <span class="setup-count">{{ finished ? '已完成' : `第 ${step} / 2 步` }}</span>

          <button
            v-if="step === 1 && !finished"
            type="button"
            class="btn btn--primary"
            data-test="next-step"
            :disabled="saving"
            @click="goNext"
          >
            <LoaderCircle v-if="saving" class="spinner" :size="15" :stroke-width="2" />
            <template v-else>
              下一步
              <ArrowRight :size="15" :stroke-width="2" />
            </template>
          </button>

          <button
            v-else-if="!finished"
            type="button"
            class="btn btn--primary"
            data-test="finish-setup"
            :disabled="saving"
            @click="finishSetup"
          >
            <LoaderCircle v-if="saving" class="spinner" :size="15" :stroke-width="2" />
            <Check v-else :size="15" :stroke-width="2.4" />
            {{ saving ? '保存中…' : '完成设置' }}
          </button>

          <button
            v-else
            type="button"
            class="btn btn--primary"
            data-test="enter-main"
            :disabled="enteringMain"
            @click="enterMain"
          >
            <LoaderCircle v-if="enteringMain" class="spinner" :size="15" :stroke-width="2" />
            <template v-else>
              进入主界面
              <ArrowRight :size="15" :stroke-width="2" />
            </template>
          </button>
        </div>
      </footer>
    </section>
  </main>
</template>

<style scoped>
.setup-page {
  display: grid;
  place-items: center;
  min-height: 100vh;
  padding: var(--space-5);
  overflow-y: auto;
}

.setup-card {
  display: flex;
  flex-direction: column;
  width: min(880px, 100%);
  max-height: calc(100vh - var(--space-8));
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--surface);
}

.setup-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-5) var(--space-6) var(--space-3);
}

.setup-brand {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.setup-head__tag {
  padding: 3px 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-xs);
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 500;
}

.setup-head__meta {
  color: var(--text-faint);
  font-size: 10px;
  letter-spacing: 0.14em;
}

.progress {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  margin: 0;
  padding: var(--space-3) var(--space-6) var(--space-4);
  list-style: none;
  border-bottom: 1px solid var(--border);
}

.progress__step {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.progress__index {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  flex: none;
  border: 1px solid var(--border);
  border-radius: 50%;
  background: var(--bg);
  color: var(--text-faint);
  font-family: var(--font-mono);
  font-size: 11px;
}

.progress__step.is-active .progress__index {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--accent-contrast);
}

.progress__step.is-done .progress__index {
  border-color: var(--success-border);
  background: var(--success-surface);
  color: var(--success-ink);
}

.progress__labels strong {
  display: block;
  font-size: var(--text-sm);
  font-weight: 600;
  white-space: nowrap;
}

.progress__labels small {
  display: block;
  color: var(--text-faint);
  font-size: 10.5px;
  white-space: nowrap;
}

.progress__line {
  flex: 1;
  min-width: 20px;
  height: 1px;
  background: var(--border);
}

.progress__line.is-done {
  background: var(--accent);
}

.setup-banner {
  margin: var(--space-3) var(--space-6) 0;
}

.setup-body {
  flex: 1;
  min-height: 0;
  padding: var(--space-5) var(--space-6) var(--space-6);
  overflow-y: auto;
}

.step-panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.step-heading h1 {
  margin: 3px 0 0;
  font-family: var(--font-display);
  font-size: var(--text-xl);
  font-weight: 600;
  letter-spacing: -0.01em;
}

.step-heading > p:not(.eyebrow) {
  max-width: 64ch;
  margin: 6px 0 0;
  color: var(--text-muted);
  font-size: var(--text-md);
  line-height: 1.7;
}

.step-heading__meta {
  margin-top: 6px;
  color: var(--text-faint);
  font-size: 11px;
  overflow-wrap: anywhere;
}

.setup-success {
  display: flex;
  align-items: flex-start;
  gap: var(--space-4);
}

.setup-success__icon {
  display: grid;
  place-items: center;
  width: 42px;
  height: 42px;
  flex: none;
  border: 1px solid var(--success-border);
  border-radius: var(--radius-sm);
  background: var(--success-surface);
  color: var(--success-ink);
}

.setup-success h2 {
  margin: 0;
  font-family: var(--font-display);
  font-size: var(--text-xl);
  font-weight: 600;
}

.setup-success p {
  margin: 5px 0 0;
  color: var(--text-muted);
  font-size: var(--text-md);
  line-height: 1.65;
}

.setup-success__url {
  color: var(--text);
  font-size: var(--text-sm);
  word-break: break-all;
}

.runtime-warning {
  margin-top: var(--space-4);
}

.runtime-warning__hint {
  margin: 5px 0 0;
  color: var(--text-muted);
  font-size: var(--text-xs);
  line-height: 1.65;
}

.setup-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-3) var(--space-6);
  border-top: 1px solid var(--border);
  background: var(--bg);
}

.setup-foot__left,
.setup-foot__right {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.setup-count {
  color: var(--text-faint);
  font-size: var(--text-xs);
  font-variant-numeric: tabular-nums;
}

@media (max-width: 720px) {
  .setup-page {
    padding: var(--space-2);
  }

  .setup-card {
    max-height: calc(100vh - var(--space-4));
  }

  .setup-head,
  .progress,
  .setup-body,
  .setup-foot {
    padding-left: var(--space-4);
    padding-right: var(--space-4);
  }

  .setup-banner {
    margin-left: var(--space-4);
    margin-right: var(--space-4);
  }

  .progress__labels small {
    display: none;
  }

  .setup-foot {
    flex-wrap: wrap;
  }
}
</style>
