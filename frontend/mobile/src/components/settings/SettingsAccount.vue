<template>
  <SettingsSection title="账户" description="登录状态与访问凭据">
    <button
      v-if="!isLoggedIn"
      class="settings-row"
      data-setting-row="login"
      type="button"
      @click="handleLogin"
    >
      <span class="settings-row__icon">
        <AppIcon name="User" :size="18" />
      </span>
      <span class="settings-row__text">
        <span class="settings-row__title">登录</span>
        <span class="settings-row__hint">使用账号密码登录后同步会话与数据</span>
      </span>
      <span class="settings-row__value">未登录</span>
      <span class="settings-row__chevron">
        <AppIcon name="CaretRight" :size="14" />
      </span>
    </button>

    <div v-else class="settings-row" data-setting-row="account-status">
      <span class="settings-row__icon">
        <AppIcon name="User" :size="18" />
      </span>
      <span class="settings-row__text">
        <span class="settings-row__title">已登录</span>
        <span class="settings-row__hint">当前设备持有有效访问凭证</span>
      </span>
      <span class="settings-row__check">
        <AppIcon name="Check" :size="16" />
      </span>
    </div>

    <button
      v-if="isLoggedIn"
      class="settings-row"
      data-setting-row="logout"
      type="button"
      @click="handleLogout"
    >
      <span class="settings-row__icon">
        <AppIcon name="ArrowSquareOut" :size="18" />
      </span>
      <span class="settings-row__text">
        <span class="settings-row__title settings-row__value--danger">退出登录</span>
        <span class="settings-row__hint">清除本机访问凭证并断开实时连接</span>
      </span>
    </button>

    <template v-if="isLoggedIn">
      <button
        class="settings-row"
        data-setting-row="credentials"
        type="button"
        :aria-expanded="showCredentialForm"
        @click="toggleCredentialForm"
      >
        <span class="settings-row__icon">
          <AppIcon name="Wrench" :size="18" />
        </span>
        <span class="settings-row__text">
          <span class="settings-row__title">修改用户名和密码</span>
          <span class="settings-row__hint">修改密码后其他设备需重新登录</span>
        </span>
        <span
          class="settings-row__chevron"
          :class="{ 'settings-row__chevron--open': showCredentialForm }"
        >
          <AppIcon name="CaretDown" :size="14" />
        </span>
      </button>

      <Transition name="settings-expand">
        <form
          v-if="showCredentialForm"
          class="settings-form"
          data-setting-form="credentials"
          @submit.prevent="handleChangeCredentials"
        >
          <div class="settings-form__field">
            <label class="settings-form__label" for="cred-old-password">原密码</label>
            <input
              id="cred-old-password"
              v-model="oldPassword"
              class="settings-input cred-old-password"
              type="password"
              placeholder="输入当前密码"
              autocomplete="current-password"
              :disabled="loading"
            />
          </div>
          <div class="settings-form__field">
            <label class="settings-form__label" for="cred-new-username">新用户名（可选）</label>
            <input
              id="cred-new-username"
              v-model="newUsername"
              class="settings-input cred-new-username"
              type="text"
              placeholder="留空则不修改"
              autocomplete="username"
              :disabled="loading"
            />
          </div>
          <div class="settings-form__field">
            <label class="settings-form__label" for="cred-new-password">新密码（可选）</label>
            <input
              id="cred-new-password"
              v-model="newPassword"
              class="settings-input cred-new-password"
              type="password"
              placeholder="留空则不修改，至少 6 位"
              autocomplete="new-password"
              :disabled="loading"
            />
          </div>
          <div class="settings-form__field">
            <label class="settings-form__label" for="cred-confirm-password">确认新密码</label>
            <input
              id="cred-confirm-password"
              v-model="confirmPassword"
              class="settings-input cred-confirm-password"
              type="password"
              placeholder="再次输入新密码"
              autocomplete="new-password"
              :disabled="loading"
            />
          </div>

          <p v-if="errorMessage" class="settings-message settings-message--error" role="alert">
            <AppIcon name="WarningCircle" :size="14" />
            <span>{{ errorMessage }}</span>
          </p>
          <p v-else-if="successMessage" class="settings-message settings-message--success">
            <AppIcon name="CheckCircle" :size="14" />
            <span>{{ successMessage }}</span>
          </p>
          <p
            v-if="successMessage && passwordChanged"
            class="settings-message settings-message--note"
          >
            <AppIcon name="Info" :size="14" />
            <span>其他设备（如手机 App）的登录已失效，需使用新密码重新登录</span>
          </p>

          <div class="settings-form__actions">
            <button
              class="settings-button settings-button--primary cred-submit-btn"
              type="submit"
              :disabled="loading"
            >
              {{ loading ? '提交中…' : '确认修改' }}
            </button>
          </div>
        </form>
      </Transition>
    </template>
  </SettingsSection>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import AppIcon from '@/components/common/AppIcon.vue'
import SettingsSection from './SettingsSection.vue'
import { useApi } from '@/composables/useApi'

const router = useRouter()
const api = useApi()

const isLoggedIn = computed(() => api.isLoggedIn.value)

const showCredentialForm = ref(false)
const oldPassword = ref('')
const newUsername = ref('')
const newPassword = ref('')
const confirmPassword = ref('')
const loading = ref(false)
const errorMessage = ref('')
const successMessage = ref('')
const passwordChanged = ref(false)

function handleLogin(): void {
  void router.push('/chat')
}

function handleLogout(): void {
  if (!window.confirm('确定要退出登录吗？')) return
  api.logout()
  void router.push('/chat')
}

function toggleCredentialForm(): void {
  showCredentialForm.value = !showCredentialForm.value
  if (!showCredentialForm.value) return
  oldPassword.value = ''
  newUsername.value = ''
  newPassword.value = ''
  confirmPassword.value = ''
  errorMessage.value = ''
  successMessage.value = ''
  passwordChanged.value = false
}

/**
 * 提交凭据修改。校验与原设置页保持一致:
 * 原密码必填; 新密码填写时至少 6 位且两次一致; 至少填写一项新值。
 */
async function handleChangeCredentials(): Promise<void> {
  if (loading.value) return

  errorMessage.value = ''
  successMessage.value = ''
  passwordChanged.value = false

  const currentPassword = oldPassword.value
  const nextUsername = newUsername.value.trim()
  const nextPassword = newPassword.value
  const confirmation = confirmPassword.value

  if (!currentPassword) {
    errorMessage.value = '请输入原密码'
    return
  }
  if (!nextUsername && !nextPassword) {
    errorMessage.value = '请至少填写新用户名或新密码'
    return
  }
  if (nextPassword) {
    if (nextPassword.length < 6) {
      errorMessage.value = '新密码至少 6 位'
      return
    }
    if (nextPassword !== confirmation) {
      errorMessage.value = '两次输入的新密码不一致'
      return
    }
  }

  loading.value = true
  try {
    const result = await api.changeCredentials(
      currentPassword,
      nextUsername || undefined,
      nextPassword || undefined,
    )
    if (result.success) {
      successMessage.value = result.message || '修改成功'
      passwordChanged.value = !!nextPassword
      oldPassword.value = ''
      newUsername.value = ''
      newPassword.value = ''
      confirmPassword.value = ''
    } else {
      errorMessage.value = result.message || '修改失败'
    }
  } catch {
    errorMessage.value = '修改请求失败，请稍后重试'
  } finally {
    loading.value = false
  }
}
</script>
