<template>
  <Teleport to="body">
    <Transition name="auth-overlay">
      <div
        v-if="visible"
        class="login-overlay auth-overlay"
        @keydown.escape="handleEscape"
        tabindex="-1"
        ref="overlayRef"
      >
        <!-- 关闭按钮 (加载中隐藏) -->
        <button
          v-if="!loading"
          class="login-close"
          @click="handleClose"
          aria-label="关闭登录"
        >
          <i class="fas fa-times"></i>
        </button>

        <!-- 登录卡片 -->
        <div class="login-card auth-card">
          <!-- 标题 -->
          <h2 class="login-title auth-title">
            <i class="fas fa-right-to-bracket"></i>
            登录
          </h2>
          <p class="login-subtitle auth-subtitle">请登录后使用 Kinship</p>

          <!-- 表单 -->
          <form class="login-form auth-form" @submit.prevent="handleLogin">
            <!-- 用户名输入 -->
            <div class="login-field auth-field">
              <label class="login-label auth-label" for="login-username">用户名</label>
              <div class="login-input-wrap auth-input-wrap">
                <i class="fas fa-user login-input-icon auth-input-icon"></i>
                <input
                  id="login-username"
                  ref="usernameRef"
                  v-model="username"
                  type="text"
                  placeholder="输入用户名"
                  autocomplete="username"
                  :disabled="loading"
                />
              </div>
            </div>

            <!-- 密码输入 -->
            <div class="login-field auth-field">
              <label class="login-label auth-label" for="login-password">密码</label>
              <div class="login-input-wrap auth-input-wrap has-toggle">
                <i class="fas fa-lock login-input-icon auth-input-icon"></i>
                <input
                  id="login-password"
                  v-model="password"
                  :type="showPassword ? 'text' : 'password'"
                  placeholder="输入密码"
                  autocomplete="current-password"
                  :disabled="loading"
                />
                <button
                  type="button"
                  class="login-eye auth-eye"
                  @click="showPassword = !showPassword"
                  :aria-label="showPassword ? '隐藏密码' : '显示密码'"
                >
                  <i :class="showPassword ? 'fas fa-eye-slash' : 'fas fa-eye'"></i>
                </button>
              </div>
            </div>

            <!-- 错误信息 -->
            <Transition name="error-slide">
              <div v-if="errorMsg" class="login-error auth-error">
                <i class="fas fa-circle-exclamation"></i>
                {{ errorMsg }}
              </div>
            </Transition>

            <!-- 登录按钮 -->
            <button
              type="submit"
              class="login-btn auth-btn"
              :disabled="loading || !username.trim() || !password.trim()"
            >
              <i v-if="loading" class="fas fa-spinner fa-spin"></i>
              <span>{{ loading ? '登录中...' : '登录' }}</span>
            </button>
            <p class="login-hint auth-hint">提示：在电脑上登录后，复制 URL 中的 token 参数即可</p>

            <!-- 忽略按钮 -->
            <button type="button" class="login-skip" @click="handleClose">
              暂时忽略
            </button>
          </form>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'
import { useApi } from '@/composables/useApi'

const props = defineProps<{
  visible: boolean
}>()

const emit = defineEmits<{
  close: []
  'login-success': [token: string]
}>()

const { login } = useApi()

// 表单状态
const username = ref('')
const password = ref('')
const showPassword = ref(false)
const loading = ref(false)
const errorMsg = ref('')

// DOM 引用
const overlayRef = ref<HTMLElement | null>(null)
const usernameRef = ref<HTMLInputElement | null>(null)

/**
 * 处理登录提交
 * 调用 useApi().login(), 成功后 emit login-success 事件
 */
async function handleLogin(): Promise<void> {
  const u = username.value.trim()
  const p = password.value.trim()
  if (!u || !p || loading.value) return

  loading.value = true
  errorMsg.value = ''

  try {
    const result = await login(u, password.value)

    if (result === null) {
      errorMsg.value = '网络错误, 请检查连接后重试'
      return
    }

    if (result.success && result.token) {
      // 登录成功: 通知父组件
      emit('login-success', result.token)
      // 重置表单
      username.value = ''
      password.value = ''
      errorMsg.value = ''
    } else {
      // 登录失败: 显示服务器返回的错误信息
      errorMsg.value = result.message || '用户名或密码错误'
    }
  } catch {
    errorMsg.value = '登录请求失败, 请稍后重试'
  } finally {
    loading.value = false
  }
}

/** ESC 键关闭 (加载中不可关闭) */
function handleEscape(): void {
  if (!loading.value) {
    handleClose()
  }
}

/** 关闭按钮 */
function handleClose(): void {
  if (loading.value) return
  errorMsg.value = ''
  emit('close')
}

/**
 * 监听 visible 变化
 * 打开时自动聚焦用户名输入框并清空错误信息
 */
watch(() => props.visible, async (newVal) => {
  if (newVal) {
    errorMsg.value = ''
    await nextTick()
    usernameRef.value?.focus()
  }
})

// 输入时清除错误信息
watch(username, () => {
  if (errorMsg.value) errorMsg.value = ''
})
watch(password, () => {
  if (errorMsg.value) errorMsg.value = ''
})
</script>

<style scoped>
/* 关闭按钮 (仅登录覆盖层独有) */
.login-close {
  position: absolute;
  /* 顶部让出 --app-top-inset, 避免关闭按钮被手机状态栏遮挡 / 重合 */
  top: calc(14px + var(--app-top-inset, 0px));
  right: 20px;
  z-index: 10;
  background: transparent;
  border: none;
  color: var(--text3);
  font-size: 22px;
  cursor: pointer;
  padding: 6px 10px;
  border-radius: 6px;
  transition: background 0.15s, color 0.15s;
}

.login-close:hover {
  background: var(--surface2);
  color: var(--text);
}

/* 忽略按钮 (仅登录覆盖层独有) */
.login-skip {
  display: block;
  margin: 12px auto 0;
  background: transparent;
  border: none;
  color: var(--text3);
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
  padding: 6px 14px;
  border-radius: 8px;
  transition: color 0.15s, background 0.15s;
}

.login-skip:hover {
  color: var(--text2);
  background: var(--surface2);
}
</style>
