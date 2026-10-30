<template>
  <section class="onboarding-panel" data-onboarding-panel="xiaomi">
    <header class="onboarding-panel__head">
      <h3 class="onboarding-panel__title">小米健康云</h3>
      <p class="onboarding-panel__desc">
        可选。启用后可从小米健康云拉取心率、睡眠与步数数据。扫码登录后凭据只保存在服务端，本次引导不会写入浏览器存储。
      </p>
    </header>

    <StepWhy step-id="xiaomi" :detected="detected" />

    <p v-if="loading && !status" class="onboarding-alert" data-onboarding-xiaomi-loading>
      <AppIcon name="CircleNotch" :size="14" class="onboarding-spinner" />
      <span>正在读取小米健康云状态…</span>
    </p>

    <label class="step-toggle" data-onboarding-xiaomi-toggle-label>
      <input
        v-model="enabled"
        class="step-toggle__input"
        type="checkbox"
        role="switch"
        :disabled="busy"
        data-onboarding-xiaomi-toggle
      />
      <span class="step-toggle__track" aria-hidden="true">
        <span class="step-toggle__thumb" />
      </span>
      <span class="step-toggle__text">
        <strong>启用小米健康云</strong>
        <span>关闭后不会写入小米账号，也不影响其他功能。</span>
      </span>
    </label>

    <template v-if="enabled">
      <dl class="onboarding-kv" data-onboarding-xiaomi-summary>
        <div class="onboarding-kv__row">
          <dt>登录状态</dt>
          <dd>
            <span
              data-onboarding-xiaomi-phase
              :data-phase="status?.phase || 'unknown'"
            >{{ phaseText }}</span>
          </dd>
        </div>
        <div class="onboarding-kv__row">
          <dt>小米账号</dt>
          <dd data-onboarding-xiaomi-account>{{ accountText }}</dd>
        </div>
      </dl>

      <p
        v-if="status?.last_error"
        class="onboarding-alert onboarding-alert--warning"
        data-onboarding-xiaomi-last-error
      >
        <AppIcon name="Warning" :size="14" />
        <span>{{ status.last_error }}</span>
      </p>

      <p
        v-if="qrNotice"
        class="onboarding-alert onboarding-alert--success"
        data-onboarding-xiaomi-qr-success
      >
        <AppIcon name="CheckCircle" :size="14" />
        <span>{{ qrNotice }}</span>
      </p>

      <div class="onboarding-inline-action">
        <button
          class="onboarding-button"
          type="button"
          data-onboarding-xiaomi-qr-open
          :data-busy="qrBusy ? 'true' : undefined"
          :disabled="busy || qrBusy"
          @click="handleQrLogin"
        >
          <AppIcon
            :name="qrBusy ? 'CircleNotch' : 'DeviceMobile'"
            :size="14"
            :class="qrBusy ? 'onboarding-spinner' : undefined"
          />
          <span>{{ qrBusy ? '正在获取二维码…' : '扫码登录' }}</span>
        </button>
      </div>
    </template>

    <p
      v-if="localError"
      class="onboarding-alert onboarding-alert--error"
      data-onboarding-xiaomi-error
      role="alert"
    >
      <AppIcon name="WarningCircle" :size="14" />
      <span>{{ localError }}</span>
    </p>
    <p
      v-else-if="onboardingError"
      class="onboarding-alert onboarding-alert--error"
      data-onboarding-xiaomi-error
      role="alert"
    >
      <AppIcon name="WarningCircle" :size="14" />
      <span>{{ onboardingError.message }}</span>
    </p>

    <div class="onboarding-panel__actions">
      <button
        class="onboarding-button onboarding-button--primary"
        type="button"
        data-onboarding-xiaomi-save
        :data-busy="busy ? 'true' : undefined"
        :disabled="busy"
        @click="handleSave"
      >
        <AppIcon
          v-if="busy"
          name="CircleNotch"
          :size="14"
          class="onboarding-spinner"
        />
        <span>{{ busy ? '保存中…' : '保存并继续' }}</span>
        <AppIcon name="ArrowRight" :size="14" />
      </button>
    </div>

    <div
      v-if="qrVisible"
      class="xiaomi-qr"
      role="dialog"
      aria-modal="true"
      aria-labelledby="onboarding-xiaomi-qr-title"
      data-onboarding-xiaomi-qr-modal
      @click.self="closeQrModal"
    >
      <div class="xiaomi-qr__panel">
        <header class="xiaomi-qr__head">
          <h4 id="onboarding-xiaomi-qr-title" class="xiaomi-qr__title">扫码登录小米健康云</h4>
          <button
            class="xiaomi-qr__close"
            type="button"
            aria-label="关闭扫码登录"
            data-onboarding-xiaomi-qr-close
            @click="closeQrModal"
          >
            <AppIcon name="X" :size="16" />
          </button>
        </header>
        <div class="xiaomi-qr__body">
          <img
            v-if="qrImage && !qrExpired"
            class="xiaomi-qr__image"
            :src="qrImage"
            alt="小米健康云登录二维码"
            data-onboarding-xiaomi-qr-image
          />
          <p
            v-if="qrExpired"
            class="onboarding-alert onboarding-alert--warning"
            data-onboarding-xiaomi-qr-expired
          >
            <AppIcon name="Clock" :size="14" />
            <span>二维码已过期，请重新获取。</span>
          </p>
          <p v-else class="onboarding-hint" data-onboarding-xiaomi-qr-status>
            {{ qrPolling ? '正在检查扫码状态…' : '请使用小米健康 App 扫码，每 2 秒自动检查一次。' }}
          </p>
          <div class="xiaomi-qr__actions">
            <button
              class="onboarding-button"
              type="button"
              data-onboarding-xiaomi-qr-retry
              :disabled="qrBusy"
              @click="handleQrLogin"
            >
              <span>重新获取二维码</span>
            </button>
            <button
              class="onboarding-button"
              type="button"
              data-onboarding-xiaomi-qr-dismiss
              @click="closeQrModal"
            >
              <span>关闭</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import StepWhy, {
  type StepWhyDetectedItem,
} from '@/components/onboarding/StepWhy.vue'
import { useOnboarding } from '@/composables/useOnboarding'
import type { XiaomiQrResult } from '@/api/system'

const props = withDefaults(
  defineProps<{
    currentPassword?: string
  }>(),
  {
    currentPassword: '',
  },
)

const emit = defineEmits<{
  next: []
}>()

const {
  xiaomi: status,
  error: onboardingError,
  loadXiaomi,
  configureXiaomi,
  requestXiaomiQr,
  pollXiaomiQr,
  recordStep,
  refresh,
} = useOnboarding()

const QR_POLL_INTERVAL_MS = 2000

const PHASE_TEXT: Record<string, string> = {
  disabled: '未启用',
  unconfigured: '未登录',
  auth_expired: '登录已过期',
  error: '同步异常',
  ok: '已登录',
  syncing: '同步中',
}

const enabled = ref(false)
const loading = ref(false)
const busy = ref(false)
const localError = ref('')
const hydrated = ref(false)

const qrVisible = ref(false)
const qrBusy = ref(false)
const qrPolling = ref(false)
const qrExpired = ref(false)
const qrSession = ref<XiaomiQrResult | null>(null)
const qrConfigured = ref(false)
const qrUserIdMasked = ref('')
const qrNotice = ref('')

let pollTimer: ReturnType<typeof setInterval> | null = null
let expireTimer: ReturnType<typeof setTimeout> | null = null
let disposed = false

const isConfigured = computed(
  () => qrConfigured.value || status.value?.configured === true,
)

const phaseText = computed(() => {
  if (qrConfigured.value) return '已登录'
  const current = status.value
  if (!current) return '读取中'
  return PHASE_TEXT[current.phase] ?? (current.phase || '未登录')
})

const accountText = computed(() => {
  if (qrUserIdMasked.value) return qrUserIdMasked.value
  const current = status.value
  if (current?.userid_masked) return current.userid_masked
  if (current?.userid_configured) return '已绑定'
  return '未登录'
})

const qrImage = computed(() => {
  const raw = qrSession.value?.qr_base64 ?? ''
  if (!raw) return ''
  return raw.startsWith('data:') ? raw : `data:image/png;base64,${raw}`
})

const detected = computed<StepWhyDetectedItem[]>(() => {
  if (!status.value) return []
  return [
    { label: '登录状态', value: phaseText.value },
    { label: '小米账号', value: accountText.value },
  ]
})

function syncFromStatus(): void {
  const current = status.value
  if (!current || hydrated.value) return
  enabled.value = current.enabled
  hydrated.value = true
}

watch(status, syncFromStatus, { immediate: true })

watch(enabled, (value) => {
  if (!value) {
    closeQrModal()
    qrNotice.value = ''
  }
})

onMounted(() => {
  void loadStatus()
})

onBeforeUnmount(() => {
  disposed = true
  stopTimers()
})

async function loadStatus(): Promise<void> {
  loading.value = true
  try {
    await loadXiaomi()
  } finally {
    loading.value = false
  }
}

function errorText(fallback: string): string {
  return onboardingError.value?.message || fallback
}

function stopTimers(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  if (expireTimer) {
    clearTimeout(expireTimer)
    expireTimer = null
  }
}

function closeQrModal(): void {
  stopTimers()
  qrVisible.value = false
  qrBusy.value = false
  qrPolling.value = false
  qrExpired.value = false
  qrSession.value = null
}

async function handleQrLogin(): Promise<void> {
  if (qrBusy.value) return
  localError.value = ''
  qrNotice.value = ''
  qrBusy.value = true
  qrExpired.value = false
  stopTimers()
  try {
    const result = await requestXiaomiQr(undefined, props.currentPassword)
    if (disposed) return
    if (!result) {
      qrSession.value = null
      qrVisible.value = false
      localError.value = errorText('二维码申请失败，请稍后重试。')
      return
    }
    if (!enabled.value) return
    qrSession.value = result
    qrVisible.value = true
    if (result.expires_in > 0) {
      expireTimer = setTimeout(() => {
        markExpired()
      }, result.expires_in * 1000)
    }
    pollTimer = setInterval(() => {
      void pollQr()
    }, QR_POLL_INTERVAL_MS)
  } finally {
    qrBusy.value = false
  }
}

async function pollQr(): Promise<void> {
  const session = qrSession.value
  if (!session || qrPolling.value || qrExpired.value || !qrVisible.value) return
  qrPolling.value = true
  try {
    const result = await pollXiaomiQr(
      session.lp,
      undefined,
      props.currentPassword,
    )
    if (disposed) return
    if (!result) {
      stopTimers()
      qrVisible.value = false
      qrSession.value = null
      localError.value = errorText('扫码状态查询失败，请重试。')
      return
    }
    if (result.state === 'success') {
      qrConfigured.value = true
      qrUserIdMasked.value = result.userid_masked ?? ''
      qrNotice.value = '扫码登录成功，已绑定小米账号。'
      closeQrModal()
    }
  } finally {
    qrPolling.value = false
  }
}

function markExpired(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  qrExpired.value = true
}

async function handleSave(): Promise<void> {
  if (busy.value) return
  localError.value = ''
  if (enabled.value && !isConfigured.value) {
    localError.value = '请先扫码登录，或关闭小米健康云'
    return
  }
  busy.value = true
  try {
    const saved = await configureXiaomi({
      enabled: enabled.value,
      current_password: props.currentPassword,
    })
    if (!saved) {
      localError.value = errorText('保存小米健康云配置失败，请稍后重试。')
      return
    }
    const data = enabled.value
      ? { enabled: true, configured: true }
      : { enabled: false }
    const recorded = await recordStep('xiaomi', 'completed', data)
    if (!recorded) {
      localError.value = errorText('记录小米健康云步骤失败，请稍后重试。')
      return
    }
    await refresh()
    emit('next')
  } finally {
    busy.value = false
  }
}
</script>

<style scoped>
.step-toggle {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-3);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
  background: var(--surface);
  cursor: pointer;
}

.step-toggle__input {
  position: absolute;
  inline-size: 1px;
  block-size: 1px;
  margin: -1px;
  padding: 0;
  border: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

.step-toggle__track {
  position: relative;
  flex: none;
  inline-size: 40px;
  block-size: 22px;
  margin-block-start: 1px;
  border-radius: 999px;
  background: var(--inset);
  transition: background var(--motion-fast) ease;
}

.step-toggle__thumb {
  position: absolute;
  inset-block-start: 3px;
  inset-inline-start: 3px;
  inline-size: 16px;
  block-size: 16px;
  border-radius: 50%;
  background: var(--surface-raised);
  box-shadow: 0 1px 2px color-mix(in srgb, var(--ink) 24%, transparent);
  transition: transform var(--motion-fast) ease;
}

.step-toggle__input:checked + .step-toggle__track {
  background: var(--accent);
}

.step-toggle__input:checked + .step-toggle__track .step-toggle__thumb {
  transform: translateX(18px);
}

.step-toggle__input:focus-visible + .step-toggle__track {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.step-toggle__input:disabled + .step-toggle__track {
  opacity: 0.6;
}

.step-toggle__text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-inline-size: 0;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.5;
}

.step-toggle__text strong {
  color: var(--ink);
  font-size: 12.5px;
  font-weight: 600;
}

.xiaomi-qr {
  position: fixed;
  inset: 0;
  z-index: var(--z-toast);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-4);
  background: var(--overlay-bg);
}

.xiaomi-qr__panel {
  inline-size: min(360px, 100%);
  border: 1px solid var(--hairline);
  border-radius: var(--radius);
  background: var(--surface-raised);
  box-shadow: 0 18px 48px color-mix(in srgb, var(--ink) 28%, transparent);
  overflow: hidden;
}

.xiaomi-qr__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border-block-end: 1px solid var(--hairline);
}

.xiaomi-qr__title {
  margin: 0;
  color: var(--ink);
  font-size: 14px;
  font-weight: 600;
  line-height: 1.4;
}

.xiaomi-qr__close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  inline-size: 32px;
  block-size: 32px;
  padding: 0;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}

.xiaomi-qr__close:hover {
  background: var(--inset);
  color: var(--ink);
}

.xiaomi-qr__body {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-4);
  text-align: center;
}

.xiaomi-qr__image {
  inline-size: 212px;
  block-size: 212px;
  border-radius: var(--radius-sm);
  background: var(--surface);
  object-fit: contain;
}

.xiaomi-qr__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: var(--space-2);
}
</style>
