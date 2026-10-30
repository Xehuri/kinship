<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Component } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  ChevronRight,
  CircleAlert,
  FolderOpen,
  Link2,
  LoaderCircle,
  MonitorX,
  PackageX,
  Power,
  RotateCcw,
  ServerOff,
  Settings,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  TriangleAlert,
  WifiOff,
} from 'lucide-vue-next'
import { useDesktopApi } from '../composables/useDesktopApi'
import { useToast } from '../composables/useToast'
import AppMark from '../components/AppMark.vue'
import { readErrorContext } from '../lib/error-context'
import type { ErrorCode } from '../lib/error-context'
import { formatDateTime } from '../lib/format'

interface ErrorViewMeta {
  title: string
  description: string
  icon: Component
  tone: 'danger' | 'warning' | 'neutral'
}

const ERROR_VIEWS: Record<ErrorCode, ErrorViewMeta> = {
  UNREACHABLE: {
    title: '无法连接服务器',
    description: '桌面端无法访问配置的服务器地址。请检查地址、网络连接或服务器防火墙设置。',
    icon: WifiOff,
    tone: 'danger',
  },
  CERT_UNTRUSTED: {
    title: '证书不受信任',
    description: '服务器使用了系统不信任的证书。只有确认指纹与服务器一致后，才会固定并信任这一张证书。',
    icon: ShieldAlert,
    tone: 'warning',
  },
  CERT_INVALID: {
    title: '证书无效',
    description: '证书与主机名不匹配或已经过期。出于安全考虑，桌面端不会绕过此错误。',
    icon: ShieldX,
    tone: 'danger',
  },
  SENSOR_CONFLICT: {
    title: 'PC 采集端端口冲突',
    description: '另一个采集端实例可能正在使用所需端口。关闭重复实例后重试，或查看日志确认占用来源。',
    icon: MonitorX,
    tone: 'warning',
  },
  RUNTIME_MISSING: {
    title: '缺少 PC 采集端运行时',
    description: '未找到内置的采集端运行时文件，安装包可能不完整。请重新安装桌面端或查看日志。',
    icon: PackageX,
    tone: 'danger',
  },
  UNKNOWN: {
    title: '桌面端启动失败',
    description: '发生了未预期的错误。你可以重试，或打开设置检查服务器与采集端配置。',
    icon: CircleAlert,
    tone: 'neutral',
  },
}

const route = useRoute()
const router = useRouter()
const api = useDesktopApi()
const toast = useToast()

const context = computed(() => readErrorContext(route.query))
const view = computed(() => ERROR_VIEWS[context.value.code])
const portNumber = computed(() => {
  const port = Number.parseInt(context.value.port, 10)
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null
})
const hasCertDetails = computed(
  () => context.value.host.length > 0 && context.value.fingerprint.length > 0,
)
const showTrust = computed(
  () => context.value.code === 'CERT_UNTRUSTED' && hasCertDetails.value,
)
const canTrustNow = computed(
  () => hasCertDetails.value && portNumber.value !== null && context.value.caPem.length > 0,
)
const showLogs = computed(
  () =>
    context.value.code === 'SENSOR_CONFLICT' ||
    context.value.code === 'RUNTIME_MISSING',
)
const showQuit = computed(
  () =>
    context.value.code === 'CERT_INVALID' ||
    context.value.code === 'RUNTIME_MISSING' ||
    context.value.code === 'UNKNOWN',
)
const targetLine = computed(() => {
  if (context.value.url.length > 0) return context.value.url
  if (context.value.host.length > 0) {
    return context.value.port.length > 0
      ? `${context.value.host}:${context.value.port}`
      : context.value.host
  }
  return ''
})

const retrying = ref(false)
const recovered = ref(false)
const actionError = ref<string | null>(null)
const confirmingTrust = ref(false)
const trusting = ref(false)
const trustError = ref<string | null>(null)

async function retry(): Promise<void> {
  retrying.value = true
  actionError.value = null
  const response = await api.retryServer()
  retrying.value = false

  if (response.ok && response.data.ok) {
    recovered.value = true
    confirmingTrust.value = false
    toast.success('连接已恢复')
    return
  }

  actionError.value = response.ok
    ? response.data.error || '连接仍然失败'
    : response.error || '重试失败'
  toast.error(actionError.value)
}

async function openSettings(): Promise<void> {
  const response = await api.openAppSettings()
  if (!response.ok) {
    await router.push('/settings')
  }
}

async function quit(): Promise<void> {
  const response = await api.quit()
  if (!response.ok) toast.error(response.error)
}

async function openLogs(): Promise<void> {
  const response = await api.openLogs()
  if (!response.ok) toast.error(response.error)
}

async function confirmTrust(): Promise<void> {
  if (!canTrustNow.value || portNumber.value === null) return

  trusting.value = true
  trustError.value = null
  const response = await api.trustCertificate({
    host: context.value.host,
    port: portNumber.value,
    caPem: context.value.caPem,
  })
  trusting.value = false

  if (!response.ok) {
    trustError.value = response.error || '证书信任失败'
    return
  }

  toast.success('证书已信任')
  await retry()
}
</script>

<template>
  <main class="error-page">
    <section class="error-card card" aria-labelledby="error-title">
      <header class="error-head">
        <AppMark :size="34" />
        <span class="error-head__tag">连接诊断</span>
      </header>

      <div class="error-body">
        <div class="error-hero">
          <span class="error-icon" :class="`error-icon--${view.tone}`" aria-hidden="true">
            <component :is="view.icon" :size="26" :stroke-width="1.9" />
          </span>
          <div class="error-hero__text">
            <p class="eyebrow">启动检查</p>
            <h1 id="error-title">{{ view.title }}</h1>
            <p>{{ view.description }}</p>
          </div>
        </div>

        <div v-if="targetLine" class="error-target">
          <Link2 :size="14" :stroke-width="2" aria-hidden="true" />
          <span class="mono">{{ targetLine }}</span>
        </div>

        <div v-if="recovered" class="notice notice--success" data-test="recovered">
          <ShieldCheck :size="17" :stroke-width="2" />
          <div>
            <strong>连接已恢复</strong>
            服务器现在可以访问。你可以打开设置继续调整，或返回使用桌面端。
          </div>
        </div>

        <div v-else-if="actionError" class="notice notice--danger" role="alert">
          <CircleAlert :size="17" :stroke-width="2" />
          <div>
            <strong>重试失败</strong>
            {{ actionError }}
          </div>
        </div>

        <section v-if="confirmingTrust" class="trust-confirm" data-test="trust-confirm">
          <header class="trust-confirm__head">
            <ShieldAlert :size="18" :stroke-width="2" aria-hidden="true" />
            <div>
              <strong>确认信任此证书</strong>
              <p>只接受与下方指纹完全一致的证书。</p>
            </div>
          </header>

          <dl class="kv">
            <dt>主机</dt>
            <dd class="mono">{{ context.host }}:{{ context.port }}</dd>
            <dt>主题</dt>
            <dd>{{ context.subject || '未提供' }}</dd>
            <dt>有效期</dt>
            <dd>
              {{ formatDateTime(context.validFrom) }} 至 {{ formatDateTime(context.validTo) }}
            </dd>
            <dt>SHA-256 指纹</dt>
            <dd class="mono-block">{{ context.fingerprint }}</dd>
          </dl>

          <p class="trust-confirm__warning">
            只会信任该主机的这一张证书。主机名不匹配、证书过期等错误永远不会被绕过。
          </p>

          <div v-if="!context.caPem" class="notice notice--warning">
            <TriangleAlert :size="16" :stroke-width="2" />
            <div>
              <strong>当前接口未提供根证书内容，无法自动信任。</strong>
              请在设置中检查证书，或联系服务器管理员提供根证书。
            </div>
          </div>

          <div class="inline-actions">
            <button
              type="button"
              class="btn btn--primary"
              data-test="confirm-trust"
              :disabled="trusting || !canTrustNow"
              @click="confirmTrust"
            >
              <LoaderCircle v-if="trusting" class="spinner" :size="15" :stroke-width="2" />
              <ShieldCheck v-else :size="15" :stroke-width="2" />
              {{ trusting ? '信任中…' : '确认信任并重试' }}
            </button>
            <button
              type="button"
              class="btn btn--ghost"
              data-test="cancel-trust"
              :disabled="trusting"
              @click="confirmingTrust = false"
            >
              取消
            </button>
          </div>

          <p v-if="trustError" class="field__error" role="alert">{{ trustError }}</p>
        </section>

        <div class="error-actions">
          <button
            v-if="showTrust && !confirmingTrust"
            type="button"
            class="btn btn--primary"
            data-test="trust-retry"
            @click="confirmingTrust = true"
          >
            <ShieldCheck :size="15" :stroke-width="2" />
            信任并重试
          </button>

          <button
            type="button"
            class="btn"
            :class="{ 'btn--primary': !showTrust }"
            data-test="retry"
            :disabled="retrying"
            @click="retry"
          >
            <LoaderCircle v-if="retrying" class="spinner" :size="15" :stroke-width="2" />
            <RotateCcw v-else :size="15" :stroke-width="2" />
            {{ retrying ? '重试中…' : '重试' }}
          </button>

          <button type="button" class="btn" data-test="open-settings" @click="openSettings">
            <Settings :size="15" :stroke-width="2" />
            打开设置
          </button>

          <button
            v-if="showLogs"
            type="button"
            class="btn"
            data-test="open-logs"
            @click="openLogs"
          >
            <FolderOpen :size="15" :stroke-width="2" />
            打开日志
          </button>

          <button
            v-if="showQuit"
            type="button"
            class="btn btn--ghost"
            data-test="quit"
            @click="quit"
          >
            <Power :size="15" :stroke-width="2" />
            退出
          </button>
        </div>

        <div v-if="context.code === 'CERT_INVALID'" class="notice notice--danger" role="alert">
          <ServerOff :size="16" :stroke-width="2" />
          <div>
            <strong>已阻止自动绕过</strong>
            桌面端不会为无效证书提供继续选项。请更换有效证书，或改用正确的主机地址。
          </div>
        </div>

        <details class="tech-details" data-test="tech-details">
          <summary>
            <ChevronRight :size="14" :stroke-width="2" />
            技术详情
          </summary>
          <div class="tech-details__body">
            <dl class="kv">
              <dt>错误代码</dt>
              <dd class="mono">{{ context.code }}</dd>
              <template v-if="context.message">
                <dt>错误信息</dt>
                <dd>{{ context.message }}</dd>
              </template>
              <template v-if="context.url">
                <dt>服务器</dt>
                <dd class="mono-block">{{ context.url }}</dd>
              </template>
              <template v-if="context.host">
                <dt>主机</dt>
                <dd class="mono">{{ context.host }}</dd>
              </template>
              <template v-if="context.port">
                <dt>端口</dt>
                <dd class="mono">{{ context.port }}</dd>
              </template>
              <template v-if="context.subject">
                <dt>证书主题</dt>
                <dd>{{ context.subject }}</dd>
              </template>
              <template v-if="context.issuer">
                <dt>颁发者</dt>
                <dd>{{ context.issuer }}</dd>
              </template>
              <template v-if="context.validFrom || context.validTo">
                <dt>有效期</dt>
                <dd>
                  {{ formatDateTime(context.validFrom) }} 至 {{ formatDateTime(context.validTo) }}
                </dd>
              </template>
              <template v-if="context.fingerprint">
                <dt>SHA-256 指纹</dt>
                <dd class="mono-block">{{ context.fingerprint }}</dd>
              </template>
            </dl>
          </div>
        </details>
      </div>
    </section>
  </main>
</template>

<style scoped>
.error-page {
  display: grid;
  place-items: center;
  height: 100vh;
  padding: var(--space-6);
  overflow-y: auto;
}

.error-card {
  display: flex;
  flex-direction: column;
  width: min(620px, 100%);
  max-height: calc(100vh - var(--space-9));
  overflow: hidden;
}

.error-head {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-5) var(--space-6) var(--space-2);
}

.error-head__tag {
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  color: var(--text-muted);
  font-size: var(--text-xs);
  font-weight: 620;
}

.error-body {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
  padding: var(--space-5) var(--space-6) var(--space-6);
  overflow-y: auto;
}

.error-hero {
  display: flex;
  align-items: flex-start;
  gap: var(--space-4);
}

.error-icon {
  display: grid;
  place-items: center;
  width: 54px;
  height: 54px;
  flex: none;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--surface-sunken);
  color: var(--text-muted);
}

.error-icon--danger {
  border-color: var(--danger-border);
  background: var(--danger-surface);
  color: var(--danger);
}

.error-icon--warning {
  border-color: var(--warning-border);
  background: var(--warning-surface);
  color: var(--warning);
}

.error-icon--neutral {
  border-color: color-mix(in srgb, var(--accent) 28%, transparent);
  background: var(--focus-soft);
  color: var(--accent-ink);
}

.error-hero__text h1 {
  margin: 4px 0 0;
  font-size: var(--text-xl);
  font-weight: 690;
  letter-spacing: -0.02em;
}

.error-hero__text > p:last-child {
  margin: 6px 0 0;
  color: var(--text-muted);
  font-size: var(--text-md);
  line-height: 1.7;
}

.error-target {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 11px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface-sunken);
  color: var(--text-muted);
  font-size: var(--text-xs);
  word-break: break-all;
}

.trust-confirm {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
  border: 1px solid var(--warning-border);
  border-radius: var(--radius-md);
  background: var(--warning-surface);
}

.trust-confirm__head {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  color: var(--warning-ink);
}

.trust-confirm__head strong {
  display: block;
  color: var(--text);
  font-size: var(--text-sm);
  font-weight: 650;
}

.trust-confirm__head p {
  margin: 2px 0 0;
  color: var(--text-muted);
  font-size: var(--text-xs);
}

.trust-confirm__warning {
  margin: 0;
  color: var(--warning-ink);
  font-size: var(--text-xs);
  line-height: 1.65;
}

.error-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

@media (max-width: 680px) {
  .error-page {
    padding: var(--space-3);
  }

  .error-card {
    max-height: calc(100vh - var(--space-6));
  }

  .error-head,
  .error-body {
    padding-left: var(--space-5);
    padding-right: var(--space-5);
  }

  .error-hero {
    flex-direction: column;
  }
}
</style>
