<template>
  <section class="onboarding-panel" data-onboarding-panel="clients">
    <header class="onboarding-panel__head">
      <h3 class="onboarding-panel__title">客户端</h3>
      <p class="onboarding-panel__desc">
        安装 Android App 与 Windows 桌面端，然后用下方连接地址登录。
      </p>
    </header>

    <StepWhy step-id="clients" :detected="detected" />

    <p v-if="loading" class="onboarding-alert" data-client-loading>
      <AppIcon name="CircleNotch" :size="14" class="onboarding-spinner" />
      <span>正在读取客户端目录…</span>
    </p>

    <p v-else-if="loadError" class="onboarding-alert onboarding-alert--error" data-client-error role="alert">
      <AppIcon name="WarningCircle" :size="14" />
      <span>{{ loadError }}</span>
      <button class="client-link-button" type="button" data-client-retry @click="loadCatalog">重新读取</button>
    </p>

    <template v-else-if="catalog">
      <div class="client-grid">
        <article class="client-card" data-client-card="android">
          <header class="client-card__head">
            <span class="client-card__icon">
              <AppIcon name="DeviceMobile" :size="20" />
            </span>
            <div class="client-card__title">
              <h4>Android 客户端</h4>
              <p>
                {{ entryHeadline(catalog.android) }}
                <span v-if="catalog.android.debug" class="client-badge" data-client-debug="android">Debug 构建</span>
              </p>
            </div>
          </header>

          <dl class="onboarding-kv">
            <div class="onboarding-kv__row">
              <dt>版本</dt>
              <dd data-client-version="android">{{ catalog.android.version || '未知' }}</dd>
            </div>
            <div class="onboarding-kv__row">
              <dt>类型</dt>
              <dd data-client-label="android">{{ catalog.android.label || '—' }}</dd>
            </div>
            <div class="onboarding-kv__row">
              <dt>文件</dt>
              <dd data-client-filename="android">{{ entryFilename(catalog.android) }}</dd>
            </div>
            <div class="onboarding-kv__row">
              <dt>大小</dt>
              <dd data-client-size="android">{{ formatSize(catalog.android.size) }}</dd>
            </div>
            <div class="onboarding-kv__row">
              <dt>SHA-256</dt>
              <dd>
                <code class="onboarding-code" data-client-sha="android">{{ catalog.android.sha256 || '—' }}</code>
              </dd>
            </div>
          </dl>

          <div v-if="catalog.android.action === 'download'" class="client-card__actions">
            <button
              class="onboarding-button onboarding-button--primary"
              type="button"
              data-client-download="android"
              :data-busy="busy === 'android' ? 'true' : undefined"
              :disabled="busy === 'android'"
              @click="handleDownload('android')"
            >
              <AppIcon
                :name="busy === 'android' ? 'CircleNotch' : 'Download'"
                :size="14"
                :class="busy === 'android' ? 'onboarding-spinner' : undefined"
              />
              <span>{{ busy === 'android' ? '准备下载…' : '下载 Android 安装包' }}</span>
            </button>
            <a
              v-if="lastLinks.android"
              class="client-fallback"
              :href="lastLinks.android"
              :download="downloadFilename(catalog.android, 'Kinship-Android.apk')"
              data-client-last-download="android"
            >下载没有开始？使用此链接</a>
          </div>
          <div v-else-if="catalog.android.action === 'external'" class="client-card__actions">
            <a
              v-if="externalPageUrl(catalog.android)"
              class="onboarding-button onboarding-button--primary client-action-link"
              :href="externalPageUrl(catalog.android)"
              target="_blank"
              rel="noopener noreferrer"
              data-client-external="android"
            >
              <AppIcon name="ArrowSquareOut" :size="14" />
              <span>前往 GitHub Releases</span>
            </a>
            <p class="onboarding-hint" data-client-external-hint="android">
              {{ externalHint(catalog.android) }}
            </p>
          </div>
          <div v-else class="client-card__actions">
            <a
              v-if="externalPageUrl(catalog.android)"
              class="onboarding-button client-action-link"
              :href="externalPageUrl(catalog.android)"
              target="_blank"
              rel="noopener noreferrer"
              data-client-page="android"
            >
              <AppIcon name="ArrowSquareOut" :size="14" />
              <span>打开 GitHub Releases</span>
            </a>
            <p class="client-unavailable" data-client-unavailable="android">
              <AppIcon name="Info" :size="14" />
              <span>{{ unavailableHint(catalog.android) }}</span>
            </p>
          </div>
        </article>

        <article class="client-card" data-client-card="desktop">
          <header class="client-card__head">
            <span class="client-card__icon">
              <AppIcon name="Monitor" :size="20" />
            </span>
            <div class="client-card__title">
              <h4>Windows 桌面端</h4>
              <p>
                {{ entryHeadline(catalog.desktop) }}
                <span v-if="catalog.desktop.debug" class="client-badge" data-client-debug="desktop">Debug 构建</span>
              </p>
            </div>
          </header>

          <dl class="onboarding-kv">
            <div class="onboarding-kv__row">
              <dt>版本</dt>
              <dd data-client-version="desktop">{{ catalog.desktop.version || '未知' }}</dd>
            </div>
            <div class="onboarding-kv__row">
              <dt>类型</dt>
              <dd data-client-label="desktop">{{ catalog.desktop.label || '—' }}</dd>
            </div>
            <div class="onboarding-kv__row">
              <dt>文件</dt>
              <dd data-client-filename="desktop">{{ entryFilename(catalog.desktop) }}</dd>
            </div>
            <div class="onboarding-kv__row">
              <dt>大小</dt>
              <dd data-client-size="desktop">{{ formatSize(catalog.desktop.size) }}</dd>
            </div>
            <div class="onboarding-kv__row">
              <dt>SHA-256</dt>
              <dd>
                <code class="onboarding-code" data-client-sha="desktop">{{ catalog.desktop.sha256 || '—' }}</code>
              </dd>
            </div>
          </dl>

          <div v-if="catalog.desktop.action === 'download'" class="client-card__actions">
            <button
              class="onboarding-button onboarding-button--primary"
              type="button"
              data-client-download="desktop"
              :data-busy="busy === 'desktop' ? 'true' : undefined"
              :disabled="busy === 'desktop'"
              @click="handleDownload('desktop')"
            >
              <AppIcon
                :name="busy === 'desktop' ? 'CircleNotch' : 'Download'"
                :size="14"
                :class="busy === 'desktop' ? 'onboarding-spinner' : undefined"
              />
              <span>{{ busy === 'desktop' ? '准备下载…' : '下载 Windows 安装包' }}</span>
            </button>
            <a
              v-if="lastLinks.desktop"
              class="client-fallback"
              :href="lastLinks.desktop"
              :download="downloadFilename(catalog.desktop, 'Kinship-Desktop-Setup.exe')"
              data-client-last-download="desktop"
            >下载没有开始？使用此链接</a>
          </div>
          <div v-else-if="catalog.desktop.action === 'external'" class="client-card__actions">
            <a
              v-if="externalPageUrl(catalog.desktop)"
              class="onboarding-button onboarding-button--primary client-action-link"
              :href="externalPageUrl(catalog.desktop)"
              target="_blank"
              rel="noopener noreferrer"
              data-client-external="desktop"
            >
              <AppIcon name="ArrowSquareOut" :size="14" />
              <span>前往 GitHub Releases</span>
            </a>
            <p class="onboarding-hint" data-client-external-hint="desktop">
              {{ externalHint(catalog.desktop) }}
            </p>
          </div>
          <div v-else class="client-card__actions">
            <a
              v-if="externalPageUrl(catalog.desktop)"
              class="onboarding-button client-action-link"
              :href="externalPageUrl(catalog.desktop)"
              target="_blank"
              rel="noopener noreferrer"
              data-client-page="desktop"
            >
              <AppIcon name="ArrowSquareOut" :size="14" />
              <span>打开 GitHub Releases</span>
            </a>
            <p class="client-unavailable" data-client-unavailable="desktop">
              <AppIcon name="Info" :size="14" />
              <span>{{ unavailableHint(catalog.desktop) }}</span>
            </p>
          </div>
        </article>
      </div>

      <p v-if="downloadError" class="onboarding-alert onboarding-alert--error" data-client-download-error role="alert">
        <AppIcon name="WarningCircle" :size="14" />
        <span>{{ downloadError }}</span>
      </p>

      <section class="onboarding-section" data-client-connection>
        <h4 class="onboarding-section__title">连接地址</h4>
        <dl class="onboarding-kv">
          <div class="onboarding-kv__row">
            <dt>服务器</dt>
            <dd><code class="onboarding-code">{{ catalog.connection.host || '未检测到' }}</code></dd>
          </div>
          <div v-for="item in connectionUrls" :key="item.url" class="onboarding-kv__row">
            <dt>{{ item.label }}</dt>
            <dd><code class="onboarding-code" data-client-connection-url>{{ item.url }}</code></dd>
          </div>
        </dl>
        <p v-if="connectionUrls.length === 0" class="onboarding-hint">
          未启用到外部的 HTTPS/HTTP 端口；请在配置中启用后重新读取。
        </p>
        <p v-else class="onboarding-hint">
          Android 端使用 HTTPS 地址；桌面端首次启动时填写同一地址。
        </p>
      </section>

      <div class="onboarding-panel__actions">
        <button
          class="onboarding-button onboarding-button--primary"
          type="button"
          data-onboarding-clients-continue
          :data-busy="recording ? 'true' : undefined"
          :disabled="recording"
          @click="handleContinue"
        >
          <AppIcon
            v-if="recording"
            name="CircleNotch"
            :size="14"
            class="onboarding-spinner"
          />
          <span>{{ recording ? '记录中…' : '已了解，继续' }}</span>
          <AppIcon name="ArrowRight" :size="14" />
        </button>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import StepWhy, {
  type StepWhyDetectedItem,
} from '@/components/onboarding/StepWhy.vue'
import {
  createOtaTicket,
  getClientCatalog,
  type ClientCatalog,
  type ClientEntry,
} from '@/api/system'
import { fetchWsTicket } from '@/api/ticket'
import { useOnboarding } from '@/composables/useOnboarding'

type ClientKind = 'android' | 'desktop'

const emit = defineEmits<{
  next: []
}>()

const {
  error: onboardingError,
  recordStep,
  refresh,
} = useOnboarding()

const catalog = ref<ClientCatalog | null>(null)
const loading = ref(false)
const loadError = ref('')
const downloadError = ref('')
const busy = ref<ClientKind | ''>('')
const recording = ref(false)
const lastLinks = ref<Record<ClientKind, string>>({ android: '', desktop: '' })

const detected = computed<StepWhyDetectedItem[]>(() => {
  const value = catalog.value
  if (!value) return []
  const available = [value.android, value.desktop].filter(
    (entry) => entry.available,
  ).length
  return [
    {
      label: '连接主机',
      value: value.connection.host || '未检测到',
    },
    { label: '安装包', value: `${available} / 2 可用` },
  ]
})

const connectionUrls = computed<Array<{ label: string; url: string }>>(() => {
  const connection = catalog.value?.connection
  if (!connection || !connection.host) return []
  const urls: Array<{ label: string; url: string }> = []
  if (connection.https.enabled) {
    urls.push({
      label: 'HTTPS',
      url: buildAddress('https', connection.host, connection.https.port),
    })
  }
  if (connection.http.enabled) {
    urls.push({
      label: 'HTTP',
      url: buildAddress('http', connection.host, connection.http.port),
    })
  }
  return urls
})

function buildAddress(scheme: string, host: string, port: number): string {
  const bracketed = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  return port > 0 ? `${scheme}://${bracketed}:${port}` : `${scheme}://${bracketed}`
}

function formatSize(size: number | null): string {
  if (size === null || size <= 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = size
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${index === 0 ? value : value.toFixed(1)} ${units[index]}`
}

function entryHeadline(entry: ClientEntry): string {
  if (entry.action === 'external') return 'GitHub 发行页'
  if (entry.label) return entry.label
  if (entry.action === 'download') return '安装包已就绪'
  return '未找到可下载安装包'
}

function entryFilename(entry: ClientEntry): string {
  return entry.expected_filename || entry.download_filename || entry.filename || '—'
}

function downloadFilename(entry: ClientEntry, fallback: string): string {
  return entry.download_filename || entry.filename || fallback
}

function externalPageUrl(entry: ClientEntry): string {
  const candidate = entry.page_url || entry.url
  if (!candidate) return ''
  return /^https?:\/\//i.test(candidate) ? candidate : ''
}

function externalHint(entry: ClientEntry): string {
  if (!externalPageUrl(entry)) {
    return '安装包未在本机或发行清单中提供，且没有可打开的发行页。请先构建本地安装包。'
  }
  return '安装包未在本机或发行清单中提供，请在 GitHub Releases 中下载最新版本。'
}

function unavailableHint(entry: ClientEntry): string {
  if (externalPageUrl(entry)) {
    return '未在本机、配置地址或发行清单中找到安装包。可前往 GitHub Releases 查看最新资产，或先构建本地安装包。'
  }
  return '未找到可下载的安装包，服务端也没有可用的发行页。请先构建本地安装包或配置下载地址。'
}

function errorMessage(value: unknown): string {
  if (value instanceof Error && value.message) return value.message
  return '请求失败，请稍后重试。'
}

async function loadCatalog(): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    catalog.value = await getClientCatalog()
  } catch (error) {
    loadError.value = errorMessage(error)
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void loadCatalog()
})

function entryFor(kind: ClientKind): ClientEntry | null {
  return catalog.value?.[kind] ?? null
}

async function resolveDownloadUrl(entry: ClientEntry): Promise<string> {
  if (entry.url && /^https?:\/\//i.test(entry.url)) return entry.url
  const base = entry.url || (entry.kind === 'android' ? '/api/ota/download' : '/api/clients/desktop/download')
  try {
    const ticket = await createOtaTicket()
    if (entry.kind === 'android') return ticket.url || `${base}?ticket=${encodeURIComponent(ticket.ticket)}`
    return `${base}?ticket=${encodeURIComponent(ticket.ticket)}`
  } catch (error) {
    if (entry.kind !== 'desktop') throw error
    const ticket = await fetchWsTicket()
    if (!ticket) throw new Error('获取下载票据失败。')
    return `${base}?ticket=${encodeURIComponent(ticket)}`
  }
}

function triggerDownload(url: string, filename: string): void {
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.rel = 'noopener'
  document.body.appendChild(link)
  link.click()
  link.remove()
}

async function handleDownload(kind: ClientKind): Promise<void> {
  const entry = entryFor(kind)
  if (!entry || entry.action !== 'download' || !entry.available || busy.value) return
  busy.value = kind
  downloadError.value = ''
  try {
    const url = await resolveDownloadUrl(entry)
    lastLinks.value = { ...lastLinks.value, [kind]: url }
    triggerDownload(url, downloadFilename(entry, `Kinship-${kind}`))
  } catch (error) {
    downloadError.value = errorMessage(error)
  } finally {
    busy.value = ''
  }
}

async function handleContinue(): Promise<void> {
  if (recording.value) return
  recording.value = true
  downloadError.value = ''
  try {
    const recorded = await recordStep('clients', 'completed', {
      android_available: catalog.value?.android.available ?? false,
      desktop_available: catalog.value?.desktop.available ?? false,
      host: catalog.value?.connection.host ?? '',
    })
    if (!recorded) {
      downloadError.value = onboardingError.value?.message || '记录客户端步骤失败，请稍后重试。'
      return
    }
    await refresh()
    emit('next')
  } finally {
    recording.value = false
  }
}
</script>

<style scoped>
.client-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: var(--space-3);
}

.client-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-3);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
  background: var(--surface);
}

.client-card__head {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
}

.client-card__icon {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  inline-size: 34px;
  block-size: 34px;
  border-radius: var(--radius-sm);
  background: var(--accent-soft);
  color: var(--accent);
}

.client-card__title {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-inline-size: 0;
}

.client-card__title h4 {
  margin: 0;
  color: var(--ink);
  font-size: 13.5px;
  font-weight: 600;
  line-height: 1.4;
}

.client-card__title p {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  margin: 0;
  color: var(--muted);
  font-size: 11.5px;
  line-height: 1.5;
}

.client-badge {
  padding: 1px var(--space-2);
  border: 1px solid color-mix(in srgb, var(--warning) 42%, var(--hairline));
  border-radius: 999px;
  background: color-mix(in srgb, var(--warning) 12%, var(--surface));
  color: var(--warning);
  font-size: 10px;
  font-weight: 600;
  line-height: 1.6;
}

.client-card__actions {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  align-items: flex-start;
}

.client-fallback {
  color: var(--muted);
  font-size: 11.5px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.client-fallback:hover {
  color: var(--accent);
}

.client-action-link {
  text-decoration: none;
}

.client-unavailable {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  inline-size: 100%;
  box-sizing: border-box;
  margin: 0;
  padding: var(--space-2) var(--space-3);
  border: 1px dashed var(--hairline);
  border-radius: var(--radius-sm);
  color: var(--muted);
  font-size: 12px;
  line-height: 1.5;
}

.client-link-button {
  margin-inline-start: auto;
  padding: 0;
  border: 0;
  background: none;
  color: var(--accent);
  font: inherit;
  font-size: 12px;
  text-decoration: underline;
  cursor: pointer;
}
</style>
