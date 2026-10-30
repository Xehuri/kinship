<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import {
  ArrowDown,
  ArrowUp,
  BadgeCheck,
  ChevronDown,
  CircleAlert,
  CircleDashed,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  ShieldCheck,
  Trash2,
} from 'lucide-vue-next'
import type {
  CertInfo,
  NetworkApplyResult,
  NetworkConfig,
  NetworkLayer,
  NetworkLayerStatus,
  NetworkLayerTlsMode,
  NetworkLayerType,
} from '../../../shared/types'
import { validateServerUrlInput } from '../../../shared/validation'
import { certificateCaPem } from '../lib/cert'
import { formatLatency } from '../lib/format'
import { parseHostPort } from '../lib/server-security'
import { useDesktopApi } from '../composables/useDesktopApi'
import { useToast } from '../composables/useToast'
import CertificateSummary from './CertificateSummary.vue'
import ToggleSwitch from './ToggleSwitch.vue'

const props = withDefaults(
  defineProps<{
    network: NetworkConfig
    statuses?: readonly NetworkLayerStatus[]
    activeLayerId?: string
    autoSeed?: boolean
    disabled?: boolean
    compact?: boolean
  }>(),
  {
    statuses: () => [],
    activeLayerId: undefined,
    autoSeed: false,
    disabled: false,
    compact: false,
  },
)

const emit = defineEmits<{
  (event: 'applied', result: NetworkApplyResult): void
}>()

const api = useDesktopApi()
const toast = useToast()

const layers = ref<NetworkLayer[]>([])
const expanded = ref<Record<string, boolean>>({})
const insecureAck = ref<Record<string, boolean>>({})
const certs = ref<Record<string, CertInfo>>({})
const inspectErrors = ref<Record<string, string>>({})
const issues = ref<Record<string, string>>({})
const actionError = ref<string | null>(null)
const syncWarning = ref<string | null>(null)
const lastResult = ref<NetworkApplyResult | null>(null)
const busy = reactive({
  saving: false,
  probing: false,
  selectingId: '',
  inspectingId: '',
  trustingId: '',
})

const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/
const TLS_OPTIONS: readonly { value: NetworkLayerTlsMode; label: string }[] = [
  { value: 'system', label: '系统校验' },
  { value: 'pinned', label: '固定证书' },
  { value: 'insecure', label: '跳过校验' },
]
const TYPE_LABEL: Record<NetworkLayerType, string> = {
  direct: '直连',
  frp: 'FRP',
  p2p: 'P2P',
}
const STATE_LABEL: Record<NetworkLayerStatus['state'], string> = {
  healthy: '可用',
  unhealthy: '不可用',
  skipped: '已跳过',
  untested: '未检测',
}

function cloneLayer(layer: NetworkLayer): NetworkLayer {
  return { ...layer }
}

function normalizeFingerprint(value: string): string {
  return value.replace(/[\s:]/g, '').toLowerCase()
}

function isLoopback(host: string): boolean {
  const normalized = host.replace(/^\[/, '').replace(/\]$/, '').toLowerCase()
  return (
    normalized === 'localhost' ||
    normalized === '::1' ||
    normalized === '0:0:0:0:0:0:0:1' ||
    normalized.startsWith('127.')
  )
}

function uniqueId(): string {
  const used = new Set(layers.value.map((layer) => layer.id))
  const base = `layer-${Date.now().toString(36)}`
  let candidate = base
  let suffix = 2
  while (used.has(candidate)) {
    candidate = `${base}-${String(suffix)}`
    suffix += 1
  }
  return candidate
}

function uniqueName(base: string): string {
  const used = new Set(layers.value.map((layer) => layer.name.trim()))
  if (!used.has(base)) return base
  for (let index = 2; ; index += 1) {
    const candidate = `${base} ${String(index)}`
    if (!used.has(candidate)) return candidate
  }
}

function buildNetwork(): NetworkConfig {
  const sanitized = layers.value.map((layer) => {
    const next: NetworkLayer = {
      id: layer.id,
      type: layer.type,
      name: layer.name.trim(),
      address: layer.address.trim(),
      enabled: layer.enabled,
      tlsMode: layer.tlsMode,
    }
    if (layer.tlsMode === 'pinned' && layer.fingerprint256 !== undefined) {
      next.fingerprint256 = normalizeFingerprint(layer.fingerprint256)
    }
    if (layer.tlsMode === 'pinned' && layer.caPemPath !== undefined) {
      next.caPemPath = layer.caPemPath
    }
    return next
  })
  const active = resolvedActiveId.value
  return active !== undefined && sanitized.some((layer) => layer.id === active && layer.enabled)
    ? { layers: sanitized, activeLayerId: active }
    : { layers: sanitized }
}

function comparable(layersValue: readonly NetworkLayer[]): string {
  return JSON.stringify(
    layersValue
      .filter((layer) => layer.type !== 'p2p')
      .map((layer) => ({
        id: layer.id,
        type: layer.type,
        name: layer.name.trim(),
        address: layer.address.trim(),
        enabled: layer.enabled,
        tlsMode: layer.tlsMode,
        ...(layer.tlsMode === 'pinned' && layer.fingerprint256 !== undefined
          ? { fingerprint256: normalizeFingerprint(layer.fingerprint256) }
          : {}),
      })),
  )
}

const baselineSignature = ref(comparable(props.network.layers))
const dirty = computed(() => comparable(layers.value) !== baselineSignature.value)
const activeStatus = computed(() => {
  const id = resolvedActiveId.value
  if (id === undefined) return undefined
  const layer = layers.value.find((entry) => entry.id === id)
  return layer === undefined ? undefined : statusFor(layer)
})
const activeLayer = computed(() =>
  resolvedActiveId.value === undefined
    ? undefined
    : layers.value.find((layer) => layer.id === resolvedActiveId.value),
)
const resolvedActiveId = computed(
  () => lastResult.value?.activeLayerId ?? props.activeLayerId,
)

function statusFor(layer: NetworkLayer): NetworkLayerStatus {
  const candidates = lastResult.value?.statuses ?? props.statuses
  const match = candidates.find(
    (status) =>
      status.id === layer.id &&
      status.address === layer.address.trim() &&
      status.tlsMode === layer.tlsMode,
  )
  if (match !== undefined) {
    return layer.enabled ? match : { ...match, state: 'skipped', code: 'DISABLED' }
  }
  return {
    id: layer.id,
    type: layer.type,
    name: layer.name,
    address: layer.address,
    enabled: layer.enabled,
    tlsMode: layer.tlsMode,
    state: layer.enabled ? 'untested' : 'skipped',
    ...(layer.enabled ? {} : { code: 'DISABLED' }),
  }
}

function statusTone(status: NetworkLayerStatus): string {
  if (status.state === 'healthy') return 'ok'
  if (status.state === 'unhealthy') return 'danger'
  if (status.state === 'skipped') return 'neutral'
  return 'pending'
}

function layerSummary(layer: NetworkLayer): string {
  if (layer.address.trim().length > 0) return layer.address.trim()
  return '尚未填写地址'
}

function applyIncoming(network: NetworkConfig): void {
  baselineSignature.value = comparable(network.layers)
  layers.value = network.layers
    .filter((layer) => layer.type !== 'p2p')
    .map(cloneLayer)
  const acknowledgement: Record<string, boolean> = {}
  for (const layer of layers.value) {
    if (layer.tlsMode === 'insecure') acknowledgement[layer.id] = true
  }
  insecureAck.value = acknowledgement
  expanded.value = {}
  certs.value = {}
  inspectErrors.value = {}
  issues.value = {}
  if (layers.value.length === 0 && props.autoSeed) addLayer('direct')
}

const autoSeededOnly = computed(
  () =>
    layers.value.length === 1 &&
    layers.value[0]?.address === '' &&
    props.network.layers.length > 0,
)

watch(
  () => props.network,
  (value) => {
    const incoming = comparable(value.layers)
    if (incoming === comparable(layers.value)) {
      applyIncoming(value)
      return
    }
    if (dirty.value && !autoSeededOnly.value) return
    applyIncoming(value)
  },
  { deep: true, immediate: true },
)

function addLayer(type: 'direct' | 'frp'): void {
  if (props.disabled) return
  const layer: NetworkLayer = {
    id: uniqueId(),
    type,
    name: uniqueName(type === 'frp' ? 'FRP 层' : '直连层'),
    address: '',
    enabled: true,
    tlsMode: 'system',
  }
  layers.value.push(layer)
  expanded.value = { ...expanded.value, [layer.id]: true }
  actionError.value = null
}

function removeLayer(index: number): void {
  const layer = layers.value[index]
  if (layer === undefined || props.disabled) return
  layers.value.splice(index, 1)
  delete expanded.value[layer.id]
  delete insecureAck.value[layer.id]
  delete certs.value[layer.id]
  delete inspectErrors.value[layer.id]
  delete issues.value[layer.id]
  actionError.value = null
}

function moveLayer(index: number, delta: number): void {
  const target = index + delta
  if (props.disabled) return
  if (index < 0 || index >= layers.value.length) return
  if (target < 0 || target >= layers.value.length) return
  const [layer] = layers.value.splice(index, 1)
  if (layer === undefined) return
  layers.value.splice(target, 0, layer)
}

function toggleExpanded(layer: NetworkLayer): void {
  expanded.value = { ...expanded.value, [layer.id]: !expanded.value[layer.id] }
}

function changeEnabled(layer: NetworkLayer, value: boolean): void {
  layer.enabled = value
  actionError.value = null
}

function changeTlsMode(layer: NetworkLayer, mode: NetworkLayerTlsMode): void {
  if (layer.tlsMode === mode) return
  layer.tlsMode = mode
  delete layer.fingerprint256
  delete layer.caPemPath
  delete certs.value[layer.id]
  delete inspectErrors.value[layer.id]
  insecureAck.value = { ...insecureAck.value, [layer.id]: false }
  actionError.value = null
}

function onAddressInput(layer: NetworkLayer): void {
  delete layer.fingerprint256
  delete layer.caPemPath
  delete certs.value[layer.id]
  delete inspectErrors.value[layer.id]
  delete issues.value[layer.id]
}

function validateAll(): boolean {
  actionError.value = null
  const found: Record<string, string> = {}
  if (layers.value.length === 0) {
    actionError.value = '至少添加一个网络层'
    return false
  }
  const names = new Set<string>()
  for (const layer of layers.value) {
    const name = layer.name.trim()
    if (name.length === 0) {
      found[layer.id] = '请填写网络层名称'
    } else if (name.length > 64) {
      found[layer.id] = '网络层名称不能超过 64 个字符'
    } else if (names.has(name)) {
      found[layer.id] = `网络层名称重复：${name}`
    }
    names.add(name)

    const validation = validateServerUrlInput(layer.address)
    if (!validation.ok) {
      found[layer.id] = found[layer.id] ?? validation.message
    } else if (validation.url.startsWith('http:')) {
      const host = new URL(validation.url).hostname
      if (!isLoopback(host)) {
        found[layer.id] = found[layer.id] ?? '仅 localhost 允许使用 http://'
      }
    }

    if (layer.tlsMode === 'pinned') {
      const fingerprint = normalizeFingerprint(layer.fingerprint256 ?? '')
      if (!FINGERPRINT_PATTERN.test(fingerprint)) {
        found[layer.id] = found[layer.id] ?? '固定证书需要 64 位 SHA-256 指纹'
      }
    }
    if (layer.tlsMode === 'insecure' && insecureAck.value[layer.id] !== true) {
      found[layer.id] = found[layer.id] ?? '请先确认跳过证书校验的风险'
    }
  }
  issues.value = found
  const first = layers.value.find((layer) => found[layer.id] !== undefined)
  if (first !== undefined) {
    expanded.value = { ...expanded.value, [first.id]: true }
    actionError.value = found[first.id] ?? '网络层配置不完整'
    return false
  }
  return true
}

async function handleResult(
  result: NetworkApplyResult,
  successMessage: string,
): Promise<NetworkApplyResult> {
  lastResult.value = result
  emit('applied', result)
  if (result.error !== undefined && result.error.length > 0) {
    actionError.value = result.error
    syncWarning.value = null
    toast.error(result.error)
    return result
  }
  actionError.value = null
  if (result.sensorSynced === false) {
    syncWarning.value = result.sensorError ?? 'PC 采集端未运行，配置将在下次启动时同步'
    toast.warning('网络配置已保存，但同步到 PC 采集端失败')
    return result
  }
  syncWarning.value = null
  toast.success(successMessage)
  return result
}

async function save(): Promise<NetworkApplyResult | null> {
  if (props.disabled || busy.saving) return null
  if (!validateAll()) {
    toast.error(actionError.value ?? '网络层配置不完整')
    return null
  }
  busy.saving = true
  actionError.value = null
  syncWarning.value = null
  const response = await api.saveNetworkLayers(buildNetwork())
  busy.saving = false
  if (!response.ok) {
    actionError.value = response.error || '网络配置保存失败'
    toast.error(actionError.value)
    return null
  }
  return handleResult(response.data, '网络配置已保存并完成探测')
}

async function probe(): Promise<NetworkApplyResult | null> {
  if (props.disabled || busy.probing) return null
  busy.probing = true
  actionError.value = null
  syncWarning.value = null
  const response = await api.probeNetwork()
  busy.probing = false
  if (!response.ok) {
    actionError.value = response.error || '网络探测失败'
    toast.error(actionError.value)
    return null
  }
  return handleResult(response.data, '网络探测完成')
}

async function selectLayer(layer: NetworkLayer): Promise<void> {
  if (props.disabled || busy.selectingId.length > 0) return
  busy.selectingId = layer.id
  actionError.value = null
  const response = await api.selectNetworkLayer(layer.id)
  busy.selectingId = ''
  if (!response.ok) {
    actionError.value = response.error || '切换网络层失败'
    toast.error(actionError.value)
    return
  }
  await handleResult(response.data, `已切换到 ${layer.name}`)
}

async function inspectCertificate(layer: NetworkLayer): Promise<void> {
  delete inspectErrors.value[layer.id]
  delete certs.value[layer.id]
  const target = parseHostPort(layer.address.trim())
  if (target === null) {
    inspectErrors.value = {
      ...inspectErrors.value,
      [layer.id]: '请先填写有效的服务器地址',
    }
    return
  }
  busy.inspectingId = layer.id
  const response = await api.inspectCertificate(target)
  busy.inspectingId = ''
  if (!response.ok) {
    inspectErrors.value = {
      ...inspectErrors.value,
      [layer.id]: response.error || '无法检查证书',
    }
    return
  }
  certs.value = { ...certs.value, [layer.id]: response.data }
  if (response.data.error !== undefined) {
    inspectErrors.value = {
      ...inspectErrors.value,
      [layer.id]: response.data.error,
    }
  }
}

async function trustCertificate(layer: NetworkLayer): Promise<void> {
  const cert = certs.value[layer.id]
  const caPem = certificateCaPem(cert)
  if (cert === undefined || caPem === undefined) return
  busy.trustingId = layer.id
  delete inspectErrors.value[layer.id]
  const response = await api.trustCertificate({
    host: cert.host,
    port: cert.port,
    caPem,
  })
  busy.trustingId = ''
  if (!response.ok) {
    inspectErrors.value = {
      ...inspectErrors.value,
      [layer.id]: response.error || '证书信任失败',
    }
    toast.error(response.error || '证书信任失败')
    return
  }
  const trusted = response.data ?? cert
  layer.tlsMode = 'pinned'
  layer.fingerprint256 = normalizeFingerprint(trusted.fingerprint256)
  certs.value = { ...certs.value, [layer.id]: trusted }
  insecureAck.value = { ...insecureAck.value, [layer.id]: false }
  expanded.value = { ...expanded.value, [layer.id]: true }
  delete issues.value[layer.id]
  toast.success('证书已信任，指纹已填入')
}

function certFor(layer: NetworkLayer): CertInfo | undefined {
  return certs.value[layer.id]
}

function inspectErrorFor(layer: NetworkLayer): string | undefined {
  return inspectErrors.value[layer.id]
}

function issueFor(layer: NetworkLayer): string | undefined {
  return issues.value[layer.id]
}

function caPemAvailable(layer: NetworkLayer): boolean {
  return certificateCaPem(certs.value[layer.id]) !== undefined
}

defineExpose({
  save,
  probe,
  validateAll,
  getNetwork: buildNetwork,
  getActiveAddress: (): string | undefined => activeLayer.value?.address.trim() || undefined,
  isDirty: (): boolean => dirty.value,
})
</script>

<template>
  <section class="network-editor" :class="{ 'network-editor--compact': compact }" data-test="network-editor">
    <div class="network-editor__active" data-test="network-active">
      <span class="status-dot" :class="[`status-dot--${activeLayer ? statusTone(statusFor(activeLayer)) : 'neutral'}`]" aria-hidden="true" />
      <div class="network-editor__active-text">
        <span class="network-editor__active-label">当前连接</span>
        <strong v-if="activeLayer" class="mono">{{ activeLayer.address }}</strong>
        <strong v-else>未选择网络层</strong>
      </div>
      <span v-if="activeLayer" class="badge" :class="{ 'badge--ok': activeStatus?.state === 'healthy' }">
        {{ activeLayer.name }} · {{ activeStatus ? STATE_LABEL[activeStatus.state] : '未检测' }}
      </span>
      <span v-else class="badge badge--warn">需要至少一个可用层</span>
    </div>

    <div class="network-editor__toolbar">
      <div class="inline-actions">
        <button
          type="button"
          class="btn btn--sm"
          data-test="network-add-direct"
          :disabled="disabled"
          @click="addLayer('direct')"
        >
          <Plus :size="14" :stroke-width="2" />
          添加直连层
        </button>
        <button
          type="button"
          class="btn btn--sm"
          data-test="network-add-frp"
          :disabled="disabled"
          @click="addLayer('frp')"
        >
          <Plus :size="14" :stroke-width="2" />
          添加 FRP 层
        </button>
        <button
          type="button"
          class="btn btn--sm"
          data-test="network-add-p2p"
          disabled
          title="P2P 传输尚未接入，后续统一做"
        >
          <Plus :size="14" :stroke-width="2" />
          P2P（未接入）
        </button>
      </div>
      <span class="network-editor__hint">按顺序探测，第一个健康的层同时用于网页与 PC 采集端。</span>
    </div>

    <div v-if="layers.length === 0" class="network-empty" data-test="network-empty">
      <CircleDashed :size="18" :stroke-width="1.8" />
      <div>
        <strong>还没有网络层</strong>
        <p>添加直连或 FRP 层。桌面端会从第一个健康层加载网页，并同步给 PC 采集端。</p>
      </div>
    </div>

    <ol v-else class="layer-list">
      <li
        v-for="(layer, index) in layers"
        :key="layer.id"
        class="layer"
        :class="{ 'is-active': layer.id === resolvedActiveId, 'is-disabled': !layer.enabled }"
        :data-test="`network-layer-${index}`"
      >
        <div class="layer__head">
          <div class="layer__order" aria-hidden="true">{{ index + 1 }}</div>
          <div class="layer__identity">
            <div class="layer__title-row">
              <strong>{{ layer.name || '未命名网络层' }}</strong>
              <span class="badge">{{ TYPE_LABEL[layer.type] }}</span>
              <span v-if="layer.id === resolvedActiveId" class="badge badge--accent" data-test="network-layer-current">
                当前
              </span>
              <span v-if="dirty" class="layer__dirty">待保存</span>
            </div>
            <p class="layer__summary mono">{{ layerSummary(layer) }}</p>
          </div>
          <div class="layer__status" :data-tone="statusTone(statusFor(layer))" :data-test="`network-layer-status-${index}`">
            <span class="status-dot" :class="`status-dot--${statusTone(statusFor(layer))}`" aria-hidden="true" />
            <span>{{ STATE_LABEL[statusFor(layer).state] }}</span>
            <span v-if="statusFor(layer).latencyMs !== undefined" class="layer__latency mono">
              {{ formatLatency(statusFor(layer).latencyMs) }}
            </span>
          </div>
          <div class="layer__controls">
            <button
              type="button"
              class="icon-btn"
              :data-test="`network-layer-up-${index}`"
              :disabled="index === 0 || disabled"
              :aria-label="`上移 ${layer.name}`"
              @click="moveLayer(index, -1)"
            >
              <ArrowUp :size="14" :stroke-width="2" />
            </button>
            <button
              type="button"
              class="icon-btn"
              :data-test="`network-layer-down-${index}`"
              :disabled="index === layers.length - 1 || disabled"
              :aria-label="`下移 ${layer.name}`"
              @click="moveLayer(index, 1)"
            >
              <ArrowDown :size="14" :stroke-width="2" />
            </button>
            <button
              type="button"
              class="icon-btn"
              :data-test="`network-layer-expand-${index}`"
              :aria-expanded="expanded[layer.id] === true"
              :aria-label="`编辑 ${layer.name}`"
              @click="toggleExpanded(layer)"
            >
              <ChevronDown
                :size="15"
                :stroke-width="2"
                :class="{ 'icon-flip': expanded[layer.id] === true }"
              />
            </button>
            <button
              type="button"
              class="icon-btn icon-btn--danger"
              :data-test="`network-layer-remove-${index}`"
              :disabled="disabled"
              :aria-label="`删除 ${layer.name}`"
              @click="removeLayer(index)"
            >
              <Trash2 :size="14" :stroke-width="2" />
            </button>
            <ToggleSwitch
              :model-value="layer.enabled"
              :label="`${layer.enabled ? '停用' : '启用'} ${layer.name}`"
              :test-id="`network-layer-enabled-${index}`"
              :disabled="disabled"
              @update:model-value="changeEnabled(layer, $event)"
            />
          </div>
        </div>

        <p
          v-if="statusFor(layer).error"
          class="layer__status-error"
          :data-test="`network-layer-error-${index}`"
        >
          <CircleAlert :size="13" :stroke-width="2" />
          {{ statusFor(layer).error }}
        </p>

        <div v-if="expanded[layer.id] === true" class="layer__editor">
          <div class="layer__grid">
            <div class="field">
              <label class="field__label" :for="`layer-name-${layer.id}`">名称</label>
              <input
                :id="`layer-name-${layer.id}`"
                v-model="layer.name"
                class="input"
                :data-test="`network-layer-name-${index}`"
                maxlength="64"
                autocomplete="off"
                spellcheck="false"
              />
            </div>
            <div class="field">
              <label class="field__label" :for="`layer-address-${layer.id}`">地址</label>
              <input
                :id="`layer-address-${layer.id}`"
                v-model="layer.address"
                class="input mono"
                :class="{ 'input--invalid': issueFor(layer) !== undefined }"
                :data-test="`network-layer-address-${index}`"
                type="text"
                inputmode="url"
                placeholder="https://host:port"
                autocomplete="off"
                spellcheck="false"
                @input="onAddressInput(layer)"
              />
            </div>
            <div class="field">
              <label class="field__label" :for="`layer-tls-${layer.id}`">证书校验</label>
              <select
                :id="`layer-tls-${layer.id}`"
                class="input"
                :data-test="`network-layer-tls-${index}`"
                :value="layer.tlsMode"
                @change="changeTlsMode(layer, ($event.target as HTMLSelectElement).value as NetworkLayerTlsMode)"
              >
                <option v-for="option in TLS_OPTIONS" :key="option.value" :value="option.value">
                  {{ option.label }}
                </option>
              </select>
            </div>
          </div>

          <div v-if="layer.tlsMode === 'pinned'" class="layer__tls-panel">
            <div class="layer__tls-head">
              <div>
                <strong>固定证书指纹</strong>
                <p>只信任该主机上这一张叶子证书。可手动填写 64 位 SHA-256，或先检查再信任。</p>
              </div>
              <button
                type="button"
                class="btn btn--sm"
                :data-test="`network-layer-inspect-${index}`"
                :disabled="busy.inspectingId.length > 0 || disabled"
                @click="inspectCertificate(layer)"
              >
                <LoaderCircle
                  v-if="busy.inspectingId === layer.id"
                  class="spinner"
                  :size="14"
                  :stroke-width="2"
                />
                <ShieldCheck v-else :size="14" :stroke-width="2" />
                {{ busy.inspectingId === layer.id ? '检查中…' : '检查并信任证书' }}
              </button>
            </div>

            <div class="field">
              <label class="field__label" :for="`layer-fingerprint-${layer.id}`">SHA-256 指纹</label>
              <input
                :id="`layer-fingerprint-${layer.id}`"
                :value="layer.fingerprint256 ?? ''"
                class="input mono"
                :data-test="`network-layer-fingerprint-${index}`"
                placeholder="64 位十六进制，例如 3a5f…"
                autocomplete="off"
                spellcheck="false"
                @input="layer.fingerprint256 = ($event.target as HTMLInputElement).value"
              />
            </div>

            <div v-if="certFor(layer)" class="layer__cert">
              <CertificateSummary :cert="certFor(layer) as CertInfo" />
              <div
                v-if="certFor(layer)?.error"
                class="notice notice--danger"
                role="alert"
                :data-test="`network-layer-cert-invalid-${index}`"
              >
                <CircleAlert :size="15" :stroke-width="2" />
                <div>
                  <strong>证书无效，不能信任</strong>
                  {{ certFor(layer)?.error }}
                </div>
              </div>
              <template v-else-if="caPemAvailable(layer)">
                <button
                  type="button"
                  class="btn btn--sm btn--primary"
                  :data-test="`network-layer-trust-${index}`"
                  :disabled="busy.trustingId.length > 0 || disabled"
                  @click="trustCertificate(layer)"
                >
                  <LoaderCircle
                    v-if="busy.trustingId === layer.id"
                    class="spinner"
                    :size="14"
                    :stroke-width="2"
                  />
                  <BadgeCheck v-else :size="14" :stroke-width="2" />
                  {{ busy.trustingId === layer.id ? '信任中…' : '信任此证书并固定指纹' }}
                </button>
              </template>
              <div v-else class="notice notice--warning" :data-test="`network-layer-trust-unavailable-${index}`">
                <CircleAlert :size="15" :stroke-width="2" />
                <div>当前接口未返回根证书内容，请手动填写指纹。</div>
              </div>
            </div>

            <p v-if="inspectErrorFor(layer)" class="field__error" role="alert">
              <CircleAlert :size="13" :stroke-width="2" />
              {{ inspectErrorFor(layer) }}
            </p>
            <p v-if="layer.fingerprint256" class="fingerprint">
              <span>已固定</span>
              <code class="mono">{{ normalizeFingerprint(layer.fingerprint256) }}</code>
            </p>
          </div>

          <div v-if="layer.tlsMode === 'insecure'" class="layer__insecure">
            <p class="layer__insecure-note">
              <CircleAlert :size="14" :stroke-width="2" />
              跳过证书校验仅对这一层生效，不会全局关闭 Chromium 的验证。
            </p>
            <label class="check-row">
              <input
                v-model="insecureAck[layer.id]"
                type="checkbox"
                :data-test="`network-layer-insecure-ack-${index}`"
              />
              我了解跳过证书校验的风险，并确认只在这个网络层使用
            </label>
          </div>

          <p v-if="issueFor(layer)" class="field__error" role="alert" :data-test="`network-layer-issue-${index}`">
            <CircleAlert :size="13" :stroke-width="2" />
            {{ issueFor(layer) }}
          </p>

          <div class="layer__actions">
            <button
              type="button"
              class="link-btn"
              :data-test="`network-layer-select-${index}`"
              :disabled="!layer.enabled || busy.selectingId.length > 0 || disabled"
              @click="selectLayer(layer)"
            >
              <LoaderCircle
                v-if="busy.selectingId === layer.id"
                class="spinner"
                :size="13"
                :stroke-width="2"
              />
              {{ layer.id === resolvedActiveId ? '重新探测此层' : '设为当前层' }}
            </button>
            <span class="layer__meta">{{ TYPE_LABEL[layer.type] }} · {{ layer.enabled ? '已启用' : '已停用' }}</span>
          </div>
        </div>

        <button
          v-if="expanded[layer.id] !== true"
          type="button"
          class="layer__edit-hint"
          :data-test="`network-layer-edit-${index}`"
          @click="toggleExpanded(layer)"
        >
          <Pencil :size="13" :stroke-width="2" />
          编辑名称、地址与证书
        </button>
      </li>
    </ol>

    <div class="p2p-row" data-test="network-p2p-placeholder">
      <CircleDashed :size="17" :stroke-width="1.8" aria-hidden="true" />
      <div>
        <strong>P2P（未接入，后续统一做）</strong>
        <p>协议类型已预留，当前版本不保存、不探测，也不会启用 P2P 传输。</p>
      </div>
      <span class="badge">占位</span>
    </div>

    <div v-if="actionError" class="notice notice--danger" role="alert" data-test="network-error">
      <CircleAlert :size="16" :stroke-width="2" />
      <div>{{ actionError }}</div>
    </div>

    <div v-if="syncWarning" class="notice notice--warning" role="status" data-test="network-sync-warning">
      <CircleAlert :size="16" :stroke-width="2" />
      <div>
        <strong>采集端未同步</strong>
        {{ syncWarning }}
        <p class="network-editor__hint">配置已写入本机，PC 采集端下次启动时会读取。</p>
      </div>
    </div>

    <div class="network-editor__actions">
      <button
        type="button"
        class="btn btn--primary"
        data-test="network-save"
        :disabled="busy.saving || disabled"
        @click="save"
      >
        <LoaderCircle v-if="busy.saving" class="spinner" :size="15" :stroke-width="2" />
        <Save v-else :size="15" :stroke-width="2" />
        {{ busy.saving ? '保存并探测…' : '保存并探测' }}
      </button>
      <button
        type="button"
        class="btn"
        data-test="network-probe"
        :disabled="busy.probing || dirty || disabled"
        :title="dirty ? '先保存修改后再探测' : '按当前保存的配置重新探测'"
        @click="probe"
      >
        <LoaderCircle v-if="busy.probing" class="spinner" :size="15" :stroke-width="2" />
        <RefreshCw v-else :size="15" :stroke-width="2" />
        {{ busy.probing ? '探测中…' : '重新探测' }}
      </button>
      <span v-if="dirty" class="badge badge--warn" data-test="network-dirty">有未保存的修改</span>
    </div>
  </section>
</template>

<style scoped>
.network-editor {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  min-width: 0;
}

.network-editor__active {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface-sunken);
}

.network-editor__active-text {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.network-editor__active-label {
  color: var(--text-faint);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.network-editor__active-text strong {
  overflow: hidden;
  font-size: var(--text-sm);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.network-editor__toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}

.network-editor__hint {
  margin: 0;
  color: var(--text-muted);
  font-size: var(--text-xs);
  line-height: 1.6;
}

.network-empty {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: var(--space-4);
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius-sm);
  color: var(--text-muted);
}

.network-empty strong {
  display: block;
  color: var(--text);
  font-size: var(--text-sm);
}

.network-empty p {
  margin: 3px 0 0;
  font-size: var(--text-xs);
  line-height: 1.65;
}

.layer-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.layer {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
  overflow: hidden;
}

.layer.is-active {
  border-color: var(--border-strong);
}

.layer.is-disabled {
  opacity: 0.72;
}

.layer__head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
  padding: 10px 12px;
}

.layer__order {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  flex: none;
  border: 1px solid var(--border);
  border-radius: 50%;
  color: var(--text-faint);
  font-family: var(--font-mono);
  font-size: 11px;
}

.layer__identity {
  flex: 1;
  min-width: 0;
}

.layer__title-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 7px;
  min-width: 0;
}

.layer__title-row strong {
  overflow: hidden;
  font-size: var(--text-sm);
  font-weight: 620;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.layer__dirty {
  color: var(--warning-ink);
  font-size: 10px;
  font-weight: 600;
}

.layer__summary {
  margin: 1px 0 0;
  overflow: hidden;
  color: var(--text-faint);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.layer__status {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 6px;
  color: var(--text-muted);
  font-size: var(--text-xs);
  white-space: nowrap;
}

.layer__status[data-tone='ok'] {
  color: var(--success-ink);
}

.layer__status[data-tone='danger'] {
  color: var(--danger-ink);
}

.layer__latency {
  color: var(--text-faint);
  font-size: 10px;
}

.layer__controls {
  display: flex;
  flex: none;
  align-items: center;
  gap: 3px;
}

.icon-btn {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}

.icon-btn:hover:not(:disabled) {
  border-color: var(--border);
  background: var(--surface-sunken);
  color: var(--text);
}

.icon-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.icon-btn:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 1px;
}

.icon-btn--danger:hover:not(:disabled) {
  color: var(--danger-ink);
}

.icon-flip {
  transform: rotate(180deg);
}

.layer__status-error {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 0;
  padding: 0 12px 8px 51px;
  color: var(--danger-ink);
  font-size: var(--text-xs);
  line-height: 1.55;
  overflow-wrap: anywhere;
}

.layer__editor {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: 12px;
  border-top: 1px solid var(--border);
  background: var(--surface-sunken);
}

.layer__grid {
  display: grid;
  grid-template-columns: minmax(120px, 0.8fr) minmax(0, 1.6fr) minmax(120px, 0.7fr);
  gap: var(--space-3);
}

.layer__tls-panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-xs);
  background: var(--surface);
}

.layer__tls-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
}

.layer__tls-head strong {
  display: block;
  font-size: var(--text-sm);
  font-weight: 620;
}

.layer__tls-head p {
  margin: 2px 0 0;
  color: var(--text-muted);
  font-size: var(--text-xs);
  line-height: 1.6;
}

.layer__cert {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.fingerprint {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 7px;
  margin: 0;
  color: var(--text-faint);
  font-size: var(--text-xs);
}

.fingerprint code {
  padding: 2px 6px;
  border: 1px solid var(--border);
  border-radius: var(--radius-xs);
  background: var(--surface-sunken);
  color: var(--text-muted);
  font-size: 10.5px;
  overflow-wrap: anywhere;
}

.layer__insecure {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: 10px 12px;
  border: 1px solid var(--warning-border);
  border-radius: var(--radius-xs);
  background: var(--warning-surface);
}

.layer__insecure-note {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  margin: 0;
  color: var(--warning-ink);
  font-size: var(--text-xs);
  line-height: 1.55;
}

.layer__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.layer__actions .link-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  background: none;
  border: 0;
}

.layer__actions .link-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.layer__meta {
  color: var(--text-faint);
  font-family: var(--font-mono);
  font-size: 10.5px;
}

.layer__edit-hint {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 7px 12px 8px 51px;
  border: 0;
  border-top: 1px solid var(--border);
  background: transparent;
  color: var(--text-muted);
  font-size: var(--text-xs);
  text-align: left;
  cursor: pointer;
}

.layer__edit-hint:hover {
  color: var(--text);
  background: var(--surface-sunken);
}

.layer__edit-hint:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: -2px;
}

.p2p-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  border: 1px dashed var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-muted);
}

.p2p-row strong {
  display: block;
  color: var(--text-muted);
  font-size: var(--text-xs);
  font-weight: 600;
}

.p2p-row p {
  margin: 2px 0 0;
  font-size: var(--text-xs);
  line-height: 1.55;
}

.p2p-row > div {
  flex: 1;
}

.network-editor__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}

.network-editor--compact .layer__head {
  padding: 8px 10px;
}

@media (max-width: 760px) {
  .layer__head {
    flex-wrap: wrap;
  }

  .layer__identity {
    flex-basis: calc(100% - 140px);
  }

  .layer__status {
    order: 4;
  }

  .layer__controls {
    margin-left: auto;
  }

  .layer__grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .layer__status-error,
  .layer__edit-hint {
    padding-left: 12px;
  }

  .layer__tls-head {
    flex-direction: column;
  }
}
</style>
