<template>
  <Teleport to="body">
    <Transition name="auth-overlay">
      <div v-if="visible" class="setup-overlay auth-overlay" tabindex="-1" ref="overlayRef">
        <!-- 初始化卡片 (不可跳过: 无关闭按钮/无跳过链接) -->
        <div class="setup-card auth-card">
          <!-- 标题 -->
          <h2 class="setup-title auth-title">
            <i class="fas fa-user-shield"></i>
            首次初始化
          </h2>
          <p class="setup-subtitle auth-subtitle">请设置管理员账号, 完成后即可开始使用</p>

          <!-- 表单 -->
          <form class="setup-form auth-form" @submit.prevent="handleSetup">
            <!-- 用户名输入 -->
            <div class="setup-field auth-field">
              <label class="setup-label auth-label" for="setup-username">用户名</label>
              <div class="setup-input-wrap auth-input-wrap">
                <i class="fas fa-user setup-input-icon auth-input-icon"></i>
                <input
                  id="setup-username"
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
            <div class="setup-field auth-field">
              <label class="setup-label auth-label" for="setup-password">密码</label>
              <div class="setup-input-wrap auth-input-wrap has-toggle">
                <i class="fas fa-lock setup-input-icon auth-input-icon"></i>
                <input
                  id="setup-password"
                  v-model="password"
                  :type="showPassword ? 'text' : 'password'"
                  placeholder="至少 6 位"
                  autocomplete="new-password"
                  :disabled="loading"
                />
                <button
                  type="button"
                  class="setup-eye auth-eye"
                  @click="showPassword = !showPassword"
                  :aria-label="showPassword ? '隐藏密码' : '显示密码'"
                >
                  <i :class="showPassword ? 'fas fa-eye-slash' : 'fas fa-eye'"></i>
                </button>
              </div>
            </div>

            <!-- 确认密码输入 -->
            <div class="setup-field auth-field">
              <label class="setup-label auth-label" for="setup-confirm">确认密码</label>
              <div class="setup-input-wrap auth-input-wrap has-toggle">
                <i class="fas fa-lock setup-input-icon auth-input-icon"></i>
                <input
                  id="setup-confirm"
                  v-model="confirmPassword"
                  :type="showConfirm ? 'text' : 'password'"
                  placeholder="再次输入密码"
                  autocomplete="new-password"
                  :disabled="loading"
                />
                <button
                  type="button"
                  class="setup-eye auth-eye"
                  @click="showConfirm = !showConfirm"
                  :aria-label="showConfirm ? '隐藏密码' : '显示密码'"
                >
                  <i :class="showConfirm ? 'fas fa-eye-slash' : 'fas fa-eye'"></i>
                </button>
              </div>
            </div>

            <!-- 引导令牌输入 (选填) -->
            <!--
              后端 /auth/setup-status 会返回 require_token, 但前端当前未透出该标记,
              故此处始终展示并标注"选填": 仅当服务器开启 auth.setup_require_token 时必填,
              留空时保持原有的两参数 setup() 调用, 不附带任何请求头。
            -->
            <div class="setup-field auth-field">
              <label class="setup-label auth-label" for="setup-token">引导令牌（选填）</label>
              <div class="setup-input-wrap auth-input-wrap">
                <i class="fas fa-key setup-input-icon auth-input-icon"></i>
                <input
                  id="setup-token"
                  v-model="setupToken"
                  type="text"
                  placeholder="服务器开启令牌校验时填写, 否则留空"
                  autocomplete="off"
                  :disabled="loading"
                />
              </div>
            </div>

            <!-- 错误信息 -->
            <Transition name="error-slide">
              <div v-if="errorMsg" class="setup-error auth-error">
                <i class="fas fa-circle-exclamation"></i>
                {{ errorMsg }}
              </div>
            </Transition>

            <!-- 提交按钮 -->
            <button
              type="submit"
              class="setup-btn auth-btn"
              :disabled="loading || !username.trim() || !password || !confirmPassword"
            >
              <i v-if="loading" class="fas fa-spinner fa-spin"></i>
              <span>{{ loading ? '初始化中...' : '创建管理员账号' }}</span>
            </button>
            <p class="setup-hint auth-hint">此步骤为首次使用必填, 请妥善保管账号密码</p>
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
  'setup-success': [token: string]
}>()

const { setup } = useApi()

// 表单状态
const username = ref('')
const password = ref('')
const confirmPassword = ref('')
const setupToken = ref('')
const showPassword = ref(false)
const showConfirm = ref(false)
const loading = ref(false)
const errorMsg = ref('')

// DOM 引用
const overlayRef = ref<HTMLElement | null>(null)
const usernameRef = ref<HTMLInputElement | null>(null)

/**
 * 客户端校验
 * @returns 错误信息, 校验通过返回空字符串
 */
function validate(): string {
  if (!username.value.trim()) return '请输入用户名'
  if (password.value.length < 6) return '密码至少 6 位'
  if (password.value !== confirmPassword.value) return '两次输入的密码不一致'
  return ''
}

/**
 * 处理初始化提交
 * 调用 useApi().setup(), 成功后 emit setup-success 事件
 */
async function handleSetup(): Promise<void> {
  if (loading.value) return

  const err = validate()
  if (err) {
    errorMsg.value = err
    return
  }

  loading.value = true
  errorMsg.value = ''

  try {
    const token = setupToken.value.trim()
    // 令牌为空: 严格保持原有的两参数调用 (后端未开启校验时无需令牌)
    const result = token
      ? await setup(username.value.trim(), password.value, token)
      : await setup(username.value.trim(), password.value)

    if (result === null) {
      errorMsg.value = '网络错误, 请检查连接后重试'
      return
    }

    if (result.success && result.token) {
      // 初始化成功: 通知父组件
      emit('setup-success', result.token)
      // 重置表单
      username.value = ''
      password.value = ''
      confirmPassword.value = ''
      setupToken.value = ''
      errorMsg.value = ''
    } else {
      // 失败: 显示后端返回的错误信息
      errorMsg.value = result.message || '初始化失败, 请重试'
    }
  } catch {
    errorMsg.value = '初始化请求失败, 请稍后重试'
  } finally {
    loading.value = false
  }
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
watch([username, password, confirmPassword, setupToken], () => {
  if (errorMsg.value) errorMsg.value = ''
})
</script>
