<template>
  <details class="tls-panel" data-onboarding-security>
    <summary class="tls-panel__summary" data-onboarding-security-toggle>
      <AppIcon name="Lock" :size="14" />
      <span class="tls-panel__title">安全连接（可选）</span>
      <AppIcon name="CaretDown" :size="12" class="tls-panel__chevron" />
    </summary>

    <div class="tls-panel__body">
      <p class="onboarding-hint">
        默认保持 HTTP。需要 HTTPS 时可生成自签证书，或填写已有证书与私钥路径。这里只写入配置草稿，不会自动重启。
      </p>

      <div class="tls-options" role="radiogroup" aria-label="安全连接方式">
        <label
          v-for="option in OPTIONS"
          :key="option.value"
          class="tls-option"
          :data-selected="mode === option.value ? 'true' : undefined"
        >
          <input
            v-model="mode"
            type="radio"
            name="onboarding-security-mode"
            :value="option.value"
            :disabled="busy"
            :data-onboarding-security-choice="option.value"
          />
          <span class="tls-option__body">
            <strong>{{ option.label }}</strong>
            <span>{{ option.description }}</span>
          </span>
        </label>
      </div>

      <p class="onboarding-hint tls-note" data-onboarding-security-note>
        端口仍是 8768，协议变 https；浏览器首次会警告；手机 App 需在设置里选 INSECURE。
      </p>

      <p v-if="mode === 'keep'" class="onboarding-hint" data-onboarding-security-keep>
        保持当前设置，不写入任何 SSL 配置。新安装默认不启用 HTTPS。
      </p>

      <div v-else-if="mode === 'generate'" class="tls-action" data-onboarding-security-generate>
        <button
          class="onboarding-button onboarding-button--primary"
          type="button"
          data-onboarding-security-generate-action
          :disabled="busy"
          @click="handleGenerate"
        >
          <AppIcon name="Plugs" :size="14" />
          <span>{{ running ? '正在生成并写入…' : '生成自签证书并写入配置草稿' }}</span>
        </button>
        <p class="onboarding-hint">
          证书生成到 backend/config/certs/，只写入 ssl.enabled、ssl.cert 与 ssl.key 三项草稿。
        </p>
      </div>

      <form
        v-else
        class="tls-upload"
        data-onboarding-security-upload
        @submit.prevent="handleUpload"
      >
        <FormField
          field-id="onboarding-security-cert"
          label="证书文件路径"
          hint="服务器上 PEM 证书的绝对路径；本步骤不上传文件本身。"
        >
          <template #default="{ fieldId, describedBy }">
            <input
              :id="fieldId"
              v-model="certPath"
              class="onboarding-input"
              type="text"
              autocomplete="off"
              placeholder="/etc/ssl/certs/server.crt"
              :aria-describedby="describedBy"
              data-onboarding-security-cert
            />
          </template>
        </FormField>
        <FormField
          field-id="onboarding-security-key"
          label="私钥文件路径"
          hint="与证书匹配的 PEM 私钥绝对路径；不会读取或回显文件内容。"
        >
          <template #default="{ fieldId, describedBy }">
            <input
              :id="fieldId"
              v-model="keyPath"
              class="onboarding-input"
              type="text"
              autocomplete="off"
              placeholder="/etc/ssl/private/server.key"
              :aria-describedby="describedBy"
              data-onboarding-security-key
            />
          </template>
        </FormField>
        <button
          class="onboarding-button onboarding-button--primary"
          type="submit"
          data-onboarding-security-upload-action
          :disabled="busy"
        >
          <AppIcon name="UploadSimple" :size="14" />
          <span>{{ running ? '正在写入…' : '写入配置草稿' }}</span>
        </button>
      </form>

      <p
        v-if="localError"
        class="onboarding-alert onboarding-alert--error"
        data-onboarding-security-error
        role="alert"
      >
        <AppIcon name="WarningCircle" :size="14" />
        <span>{{ localError }}</span>
      </p>

      <div
        v-if="stagedPaths.length > 0"
        class="onboarding-alert onboarding-alert--success"
        data-onboarding-security-pending
        role="status"
        aria-live="polite"
      >
        <AppIcon name="CheckCircle" :size="14" />
        <span>
          已写入配置草稿：{{ stagedPaths.join('、') }}。
          <strong v-if="restartRequired" data-onboarding-security-restart>
            稍后重启后生效（本步骤不会自动重启）。
          </strong>
          <strong v-else data-onboarding-security-hot-applied>
            该变更无需重启，将在完成后统一应用。
          </strong>
        </span>
      </div>

      <p v-if="generated" class="onboarding-hint" data-onboarding-security-generated>
        已生成证书：<code class="onboarding-code">{{ generated.cert }}</code>
        ；私钥：<code class="onboarding-code">{{ generated.key }}</code>。
      </p>
    </div>
  </details>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import FormField from '@/components/settings/form/FormField.vue'
import { useOnboarding } from '@/composables/useOnboarding'
import {
  fetchConfigPending,
  stageConfigDraft,
  type ConfigPendingChange,
} from '@/api/configDraft'

const props = withDefaults(
  defineProps<{
    currentPassword?: string
  }>(),
  {
    currentPassword: '',
  },
)

type SecurityMode = 'keep' | 'generate' | 'upload'

const OPTIONS: { value: SecurityMode; label: string; description: string }[] = [
  {
    value: 'keep',
    label: '保持 HTTP',
    description: '沿用当前 ssl.enabled 值，不写入任何配置（新安装默认为 false）。',
  },
  {
    value: 'generate',
    label: '生成自签证书',
    description: '生成 localhost / 127.0.0.1 自签证书，并把证书、私钥路径写入配置草稿。',
  },
  {
    value: 'upload',
    label: '上传证书',
    description: '已有证书时填写服务器上的证书与私钥路径，只写入这两个路径配置。',
  },
]

/**
 * TLS 切换按部署级变更处理：面板只写草稿，统一显示“稍后重启”。
 * 即使后端 pending 当前把 ssl.* 判为 hot（requires_restart=false），引导页也
 * 不在用户完成引导前热切协议，避免当前 HTTP 会话中断。
 */
const SSL_RESTART_REQUIRED = true

const { action, error: onboardingError } = useOnboarding()

const mode = ref<SecurityMode>('keep')
const running = ref(false)
const localError = ref('')
const generated = ref<{ cert: string; key: string } | null>(null)
const stagedPaths = ref<string[]>([])
const pendingChanges = ref<ConfigPendingChange[]>([])
const certPath = ref('')
const keyPath = ref('')

const busy = computed(() => running.value)
const restartRequired = computed(
  () =>
    SSL_RESTART_REQUIRED ||
    pendingChanges.value.some((change) => change.requires_restart),
)

function displayError(fallback: string): string {
  return onboardingError.value?.message || fallback
}

function requirePassword(): boolean {
  if (props.currentPassword.trim()) return true
  localError.value = '需要当前管理员密码才能写入配置。请先完成账号解锁。'
  return false
}

async function trackPending(): Promise<void> {
  const result = await fetchConfigPending({
    currentPassword: props.currentPassword,
  })
  if (result.ok) {
    pendingChanges.value = result.pending.changes
    const paths = result.pending.changes.map((change) => change.path)
    if (paths.length > 0) stagedPaths.value = paths
    return
  }
  pendingChanges.value = []
}

async function stageSslChanges(changes: Record<string, unknown>): Promise<void> {
  const result = await stageConfigDraft(changes, {
    currentPassword: props.currentPassword,
  })
  if (!result.ok) {
    localError.value = result.message
    return
  }
  stagedPaths.value = Object.keys(result.changes)
  await trackPending()
}

async function handleGenerate(): Promise<void> {
  if (busy.value) return
  localError.value = ''
  stagedPaths.value = []
  pendingChanges.value = []
  generated.value = null
  if (!requirePassword()) return

  running.value = true
  try {
    const result = await action(
      'generate_self_signed_cert',
      false,
      undefined,
      props.currentPassword,
    )
    if (!result || result.ok !== true) {
      localError.value = displayError('生成自签证书失败，请检查服务器是否安装 openssl。')
      return
    }
    const cert = typeof result.result.cert === 'string' ? result.result.cert : ''
    const key = typeof result.result.key === 'string' ? result.result.key : ''
    if (!cert || !key) {
      localError.value = '证书生成结果缺少 cert/key 路径，未写入配置。'
      return
    }
    generated.value = { cert, key }
    await stageSslChanges({
      'ssl.enabled': true,
      'ssl.cert': cert,
      'ssl.key': key,
    })
  } finally {
    running.value = false
  }
}

async function handleUpload(): Promise<void> {
  if (busy.value) return
  localError.value = ''
  stagedPaths.value = []
  pendingChanges.value = []
  const cert = certPath.value.trim()
  const key = keyPath.value.trim()
  if (!cert || !key) {
    localError.value = '请填写证书与私钥路径。'
    return
  }
  if (cert === key) {
    localError.value = '证书与私钥不能指向同一个文件。'
    return
  }
  if (!requirePassword()) return

  running.value = true
  try {
    await stageSslChanges({
      'ssl.enabled': true,
      'ssl.cert': cert,
      'ssl.key': key,
    })
  } finally {
    running.value = false
  }
}
</script>

<style scoped>
.tls-panel {
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
  background: var(--surface);
}

.tls-panel__summary {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-block-size: var(--tap);
  padding: var(--space-2) var(--space-3);
  color: var(--ink);
  font-size: 12.5px;
  font-weight: 600;
  line-height: 1.4;
  cursor: pointer;
  list-style: none;
}

.tls-panel__summary::-webkit-details-marker {
  display: none;
}

.tls-panel__summary:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.tls-panel__title {
  min-inline-size: 0;
}

.tls-panel__chevron {
  flex: none;
  margin-inline-start: auto;
  color: var(--muted);
  transition: transform var(--motion-fast) ease;
}

.tls-panel[open] .tls-panel__chevron {
  transform: rotate(180deg);
}

.tls-panel__body {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-3);
  border-block-start: 1px solid var(--hairline);
}

.tls-options {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.tls-option {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-3);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
  background: var(--bg);
  cursor: pointer;
}

.tls-option[data-selected='true'] {
  border-color: color-mix(in srgb, var(--accent) 38%, var(--hairline));
  background: var(--accent-soft);
}

.tls-option input {
  flex: none;
  inline-size: 16px;
  block-size: 16px;
  margin-block-start: 2px;
  accent-color: var(--accent);
}

.tls-option__body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-inline-size: 0;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.5;
}

.tls-option__body strong {
  color: var(--ink);
  font-size: 12.5px;
  font-weight: 600;
}

.tls-note {
  padding-inline-start: var(--space-2);
  border-inline-start: 2px solid var(--hairline);
}

.tls-action,
.tls-upload {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.tls-action .onboarding-button,
.tls-upload .onboarding-button {
  align-self: flex-start;
}
</style>
