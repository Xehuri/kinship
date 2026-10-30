<template>
  <div class="mi-health">
    <div class="mi-row">
      <span class="mi-icon">
        <AppIcon name="Heartbeat" :size="20" />
      </span>
      <span class="mi-title">小米健康</span>
      <span class="mi-value">{{ phaseText }}</span>
      <button
        class="mi-switch"
        :class="{ on: status?.enabled }"
        :disabled="toggling"
        role="switch"
        :aria-checked="!!status?.enabled"
        aria-label="自动拉取开关"
        @click="toggleEnabled"
      >
        <span class="mi-switch-knob" />
      </button>
    </div>

    <div v-if="status" class="mi-meta">
      <span>{{ status.userid ? '账号 ' + maskUser(status.userid) : '未绑定账号' }}</span>
      <span v-if="status.last_success">上次成功 {{ formatTs(status.last_success) }}</span>
      <span v-else>尚未成功同步</span>
      <span v-if="status.latest_cloud_shard">本地分片 {{ status.latest_cloud_shard }}</span>
    </div>

    <div v-if="status?.last_error" class="mi-error">
      <AppIcon name="WarningCircle" :size="14" />
      {{ status.last_error }}
    </div>

    <div v-if="notice" class="mi-notice" :class="{ error: noticeIsError }">
      {{ notice }}
    </div>

    <div class="mi-actions">
      <button
        v-if="needsLogin"
        class="mi-btn primary"
        :disabled="qrLoading"
        @click="openQr"
      >
        {{ qrLoading ? '正在获取二维码...' : '扫码登录' }}
      </button>
      <button class="mi-btn" :disabled="syncing" @click="syncNow">
        {{ syncing ? '同步中...' : '立即同步' }}
      </button>
      <button class="mi-btn ghost" :disabled="loading" @click="loadStatus(true)">
        刷新状态
      </button>
    </div>

    <Teleport to="body">
      <div v-if="qrVisible" class="mi-qr-mask" @click.self="closeQr">
        <div class="mi-qr-panel">
          <div class="mi-qr-head">
            <span>扫码登录小米健康</span>
            <button class="mi-qr-close" aria-label="关闭" @click="closeQr">
              <AppIcon name="X" :size="18" />
            </button>
          </div>
          <div class="mi-qr-body">
            <img
              v-if="qrImage"
              :src="qrImage"
              alt="小米健康登录二维码"
              class="mi-qr-img"
            />
            <p class="mi-qr-tip">
              用手机相机、微信扫一扫，或小米运动健康 App 扫描二维码；在打开的页面登录小米账号并确认。
            </p>
            <a
              v-if="qrLoginUrl"
              :href="qrLoginUrl"
              target="_blank"
              rel="noopener"
              class="mi-qr-link"
            >
              在浏览器打开登录页
            </a>
            <p v-if="qrState === 'success'" class="mi-qr-ok">登录成功，正在拉取数据...</p>
            <p v-else-if="qrExpired" class="mi-qr-warn">二维码已过期，请重新打开。</p>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import {
  fetchHealthCloudStatus,
  pollHealthCloudQr,
  requestHealthCloudQr,
  setHealthCloudEnabled,
  syncHealthCloud,
  type HealthCloudStatus,
} from '@/api/healthCloud'

const status = ref<HealthCloudStatus | null>(null)
const loading = ref(false)
const toggling = ref(false)
const syncing = ref(false)
const qrLoading = ref(false)
const qrVisible = ref(false)
const qrImage = ref('')
const qrLoginUrl = ref('')
const qrLp = ref('')
const qrExpired = ref(false)
const qrState = ref<'waiting' | 'success'>('waiting')
const notice = ref('')
const noticeIsError = ref(false)

let pollTimer: ReturnType<typeof setInterval> | null = null
let expireTimer: ReturnType<typeof setTimeout> | null = null
let qrPolling = false

const PHASE_TEXT: Record<string, string> = {
  disabled: '未启用',
  unconfigured: '未登录',
  auth_expired: '凭据已失效',
  error: '同步异常',
  ok: '正常',
  syncing: '同步中',
}

const phaseText = computed(() =>
  status.value ? PHASE_TEXT[status.value.phase] || status.value.phase : '加载中',
)
const needsLogin = computed(
  () =>
    !status.value ||
    status.value.phase === 'unconfigured' ||
    status.value.phase === 'auth_expired',
)

function maskUser(id: string) {
  if (id.length <= 4) return id
  return id.slice(0, 3) + '***' + id.slice(-2)
}

function formatTs(ts: number): string {
  const d = new Date(ts * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function setNotice(text: string, isError = false) {
  notice.value = text
  noticeIsError.value = isError
}

async function loadStatus(probe = false) {
  loading.value = true
  const data = await fetchHealthCloudStatus(probe)
  loading.value = false
  if (data) status.value = data
}

async function toggleEnabled() {
  if (!status.value || toggling.value) return
  toggling.value = true
  const next = !status.value.enabled
  const data = await setHealthCloudEnabled(next)
  toggling.value = false
  if (data) {
    status.value = data
    setNotice(next ? '自动拉取已开启' : '自动拉取已关闭')
  } else {
    setNotice('开关切换失败，请重试', true)
  }
}

async function syncNow() {
  if (syncing.value) return
  syncing.value = true
  setNotice('')
  const result = await syncHealthCloud()
  syncing.value = false
  if (result?.ok) {
    setNotice(`同步完成，写入 ${result.written} 个批次`)
    await loadStatus()
    return
  }
  await loadStatus(true)
  if (status.value?.phase === 'auth_expired') {
    setNotice('凭据已失效，请重新扫码登录', true)
  } else if (status.value?.phase === 'unconfigured') {
    setNotice('尚未登录小米健康，请先扫码登录', true)
  } else {
    setNotice(status.value?.last_error || '同步失败，请稍后重试', true)
  }
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  if (expireTimer) {
    clearTimeout(expireTimer)
    expireTimer = null
  }
}

function closeQr() {
  stopPolling()
  qrVisible.value = false
  qrImage.value = ''
  qrLoginUrl.value = ''
  qrLp.value = ''
  qrExpired.value = false
  qrState.value = 'waiting'
}

async function openQr() {
  if (qrLoading.value) return
  qrLoading.value = true
  setNotice('')
  const data = await requestHealthCloudQr()
  qrLoading.value = false
  if (!data) {
    setNotice('二维码获取失败，请稍后重试', true)
    return
  }
  qrImage.value = 'data:image/png;base64,' + data.qr_base64
  qrLoginUrl.value = data.login_url || ''
  qrLp.value = data.lp
  qrExpired.value = false
  qrState.value = 'waiting'
  qrVisible.value = true
  expireTimer = setTimeout(() => {
    qrExpired.value = true
    stopPolling()
  }, Math.max(30, data.expires_in) * 1000)
  pollTimer = setInterval(pollQr, 2000)
}

async function pollQr() {
  if (qrPolling || !qrLp.value || qrExpired.value) return
  qrPolling = true
  try {
    const result = await pollHealthCloudQr(qrLp.value)
    if (!result) return
    if (result.state === 'success') {
      qrState.value = 'success'
      stopPolling()
      await loadStatus()
      setTimeout(() => {
        closeQr()
        setNotice('登录成功，已开始同步')
      }, 1200)
    }
  } finally {
    qrPolling = false
  }
}

onMounted(() => {
  loadStatus()
})

onBeforeUnmount(() => {
  stopPolling()
})
</script>

<style scoped>
.mi-health {
  padding: 0;
}

.mi-row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 44px;
}

.mi-icon {
  display: inline-flex;
  color: var(--muted);
}

.mi-title {
  flex: 1;
  font-size: 15px;
  color: var(--ink);
}

.mi-value {
  font-size: 13px;
  color: var(--muted);
}

.mi-switch {
  position: relative;
  width: 46px;
  height: 26px;
  border: none;
  border-radius: 13px;
  background: var(--inset);
  transition: background 0.2s ease;
  cursor: pointer;
  padding: 0;
}

.mi-switch.on {
  background: var(--accent);
}

.mi-switch:disabled {
  opacity: 0.5;
}

.mi-switch-knob {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--ink);
  box-shadow: 0 1px 3px color-mix(in srgb, var(--ink) 22%, transparent);
  transition: transform 0.2s ease;
}

.mi-switch.on .mi-switch-knob {
  transform: translateX(20px);
}

.mi-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--muted);
}

.mi-error,
.mi-notice {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--muted);
}

.mi-error {
  color: var(--danger);
}

.mi-notice.error {
  color: var(--danger);
}

.mi-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 12px 0 0;
  padding-top: 12px;
  border-top: 1px solid var(--hairline);
}

.mi-btn {
  border: 1px solid var(--hairline);
  border-radius: 8px;
  background: transparent;
  color: var(--ink);
  font-size: 13px;
  padding: 7px 12px;
  cursor: pointer;
}

.mi-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.mi-btn.primary {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--accent-ink);
}

.mi-btn.ghost {
  border-color: transparent;
  color: var(--muted);
}

.mi-qr-mask {
  position: fixed;
  inset: 0;
  z-index: 3000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--overlay-bg);
  padding: 24px;
}

.mi-qr-panel {
  width: min(340px, 100%);
  border-radius: 16px;
  background: var(--surface-raised);
  color: var(--ink);
  box-shadow: 0 18px 48px color-mix(in srgb, var(--ink) 28%, transparent);
  overflow: hidden;
}

.mi-qr-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  font-size: 15px;
  font-weight: 600;
  border-bottom: 1px solid var(--hairline);
}

.mi-qr-close {
  border: none;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  padding: 4px;
}

.mi-qr-body {
  padding: 18px 16px 22px;
  text-align: center;
}

.mi-qr-img {
  width: 220px;
  height: 220px;
  border-radius: 8px;
  background: var(--surface-raised);
  object-fit: contain;
}

.mi-qr-tip {
  margin: 14px 0 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--muted);
}

.mi-qr-ok {
  margin: 10px 0 0;
  font-size: 13px;
  color: var(--success);
}

.mi-qr-warn {
  margin: 10px 0 0;
  font-size: 13px;
  color: var(--danger);
}

.mi-qr-link {
  display: inline-block;
  margin-top: 10px;
  font-size: 13px;
  color: var(--accent);
  text-decoration: none;
}
</style>
