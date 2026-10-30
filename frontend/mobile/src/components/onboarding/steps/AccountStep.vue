<template>
  <section class="onboarding-panel" data-onboarding-panel="account">
    <header class="onboarding-panel__head">
      <h3 class="onboarding-panel__title">管理员账号</h3>
      <p class="onboarding-panel__desc">
        创建首个管理员账号，作为后续登录与配置写入的凭据。
      </p>
    </header>

    <StepWhy step-id="account" :detected="detected" />

    <template v-if="needsSetup">
      <form class="onboarding-account__form" data-onboarding-account-form @submit.prevent="handleSubmit">
        <FormField
          field-id="onboarding-setup-token"
          label="引导令牌"
          :required="setupTokenRequired"
          hint="可在服务器的 backend/config/.setup_token 找到；若设置了 AXEUH_AUTH_STATE_DIR，则读取该目录下的 .setup_token。仅本步骤需要。"
        >
          <template #default="{ fieldId, describedBy, invalid }">
            <input
              :id="fieldId"
              v-model="setupToken"
              class="onboarding-input"
              type="password"
              autocomplete="off"
              placeholder="输入引导令牌"
              :aria-describedby="describedBy"
              :aria-invalid="invalid ? 'true' : undefined"
              data-onboarding-setup-token
            />
          </template>
        </FormField>

        <FormField field-id="onboarding-account-username" label="用户名">
          <template #default="{ fieldId, describedBy }">
            <input
              :id="fieldId"
              v-model="username"
              class="onboarding-input"
              type="text"
              autocomplete="username"
              placeholder="输入管理员用户名"
              :aria-describedby="describedBy"
              data-onboarding-account-username
            />
          </template>
        </FormField>

        <FormField field-id="onboarding-account-password" label="密码" hint="至少 6 位。">
          <template #default="{ fieldId, describedBy }">
            <input
              :id="fieldId"
              v-model="password"
              class="onboarding-input"
              type="password"
              autocomplete="new-password"
              placeholder="输入管理员密码"
              :aria-describedby="describedBy"
              data-onboarding-account-password
            />
          </template>
        </FormField>

        <FormField field-id="onboarding-account-confirm" label="确认密码">
          <template #default="{ fieldId, describedBy }">
            <input
              :id="fieldId"
              v-model="confirm"
              class="onboarding-input"
              type="password"
              autocomplete="new-password"
              placeholder="再次输入管理员密码"
              :aria-describedby="describedBy"
              data-onboarding-account-confirm
            />
          </template>
        </FormField>

        <p
          v-if="error"
          class="onboarding-alert onboarding-alert--error"
          data-onboarding-account-error
          role="alert"
        >
          <AppIcon name="WarningCircle" :size="14" />
          <span>{{ error }}</span>
        </p>

        <div class="onboarding-panel__actions">
          <button
            class="onboarding-button onboarding-button--primary"
            type="submit"
            data-onboarding-account-submit
            :data-busy="busy ? 'true' : undefined"
            :disabled="busy"
          >
            <AppIcon
              :name="busy ? 'CircleNotch' : 'User'"
              :size="14"
              :class="busy ? 'onboarding-spinner' : undefined"
            />
            <span>{{ busy ? '创建中…' : '创建管理员' }}</span>
          </button>
        </div>
      </form>
    </template>

    <template v-else>
      <p class="onboarding-alert onboarding-alert--success" data-onboarding-account-exists>
        <AppIcon name="CheckCircle" :size="14" />
        <span>管理员已配置，无需重复创建。</span>
      </p>
      <div class="onboarding-panel__actions">
        <button
          class="onboarding-button"
          type="button"
          data-onboarding-account-continue
          @click="emit('created', { existing: true })"
        >
          <span>下一步</span>
          <AppIcon name="ArrowRight" :size="14" />
        </button>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import FormField from '@/components/settings/form/FormField.vue'
import StepWhy, {
  type StepWhyDetectedItem,
} from '@/components/onboarding/StepWhy.vue'
import { useApi } from '@/composables/useApi'

const props = withDefaults(
  defineProps<{
    needsSetup: boolean
    setupTokenRequired?: boolean
  }>(),
  {
    setupTokenRequired: false,
  },
)

const emit = defineEmits<{
  created: [payload: { username?: string; password?: string; existing?: boolean }]
  next: []
}>()

const api = useApi()

const detected = computed<StepWhyDetectedItem[]>(() => [
  {
    label: '管理员账号',
    value: props.needsSetup ? '待创建' : '已存在',
  },
])

const setupToken = ref('')
const username = ref('')
const password = ref('')
const confirm = ref('')
const error = ref('')
const busy = ref(false)

function clearSecrets(): void {
  setupToken.value = ''
  password.value = ''
  confirm.value = ''
}

async function handleSubmit(): Promise<void> {
  if (busy.value) return
  error.value = ''

  const token = setupToken.value.trim()
  if (props.setupTokenRequired && !token) {
    error.value = '请输入引导令牌（X-Setup-Token）'
    return
  }

  const name = username.value.trim()
  if (!name) {
    error.value = '请输入用户名'
    return
  }
  if (password.value.length < 6) {
    error.value = '密码至少 6 位'
    return
  }
  if (password.value !== confirm.value) {
    error.value = '两次输入的密码不一致'
    return
  }

  busy.value = true
  try {
    const result = await api.setup(name, password.value, token || undefined)
    if (!result) {
      error.value = '网络错误，请检查连接后重试。'
      return
    }
    if (!result.success || !result.token) {
      error.value = result.message || '创建管理员失败，请重试。'
      return
    }

    const createdPassword = password.value
    username.value = ''
    clearSecrets()
    emit('created', { username: name, password: createdPassword })
  } finally {
    busy.value = false
  }
}
</script>
