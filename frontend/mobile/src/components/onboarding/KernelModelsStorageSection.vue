<template>
  <section class="onboarding-section" data-onboarding-storage>
    <h4 class="onboarding-section__title">模型存储位置</h4>

    <p
      v-if="storageLoading && !storage"
      class="onboarding-hint"
      data-onboarding-storage-loading
    >
      <AppIcon name="CircleNotch" :size="14" />
      <span>正在读取模型目录与磁盘空间…</span>
    </p>

    <template v-else-if="storage">
      <p class="onboarding-hint" data-onboarding-storage-root>
        当前模型根：<code class="storage-path">{{ storage.models_root }}</code>
        <span data-onboarding-storage-free>
          · 可用 {{ formatBytes(storage.free_bytes) }}
        </span>
        <span data-onboarding-storage-writable>
          · {{ storage.writable ? '可写' : '不可写' }}
        </span>
      </p>
      <p class="onboarding-hint" data-onboarding-storage-data-root>
        数据根：<code class="storage-path">{{ storage.data_root }}</code>
      </p>
      <p
        v-if="storage.source.models_root === 'env'"
        class="onboarding-alert onboarding-alert--warning"
        data-onboarding-storage-env-override
      >
        <AppIcon name="Warning" :size="14" />
        <span>
          环境变量 AXEUH_MODELS_DIR 正在覆盖配置，界面保存的目录在移除该变量前不会生效。
        </span>
      </p>
      <p
        v-if="storage.system_disk"
        class="onboarding-alert onboarding-alert--warning"
        data-onboarding-storage-system-disk
      >
        <AppIcon name="Warning" :size="14" />
        <span>
          模型根位于系统盘{{ storage.system_drive ? `（${storage.system_drive}）` : '' }}，系统盘空间紧张时会影响系统稳定性；建议改到独立数据盘。
        </span>
      </p>
      <p
        v-for="(warning, index) in additionalWarnings"
        :key="`${index}-${warning}`"
        class="onboarding-alert onboarding-alert--warning"
        data-onboarding-storage-warning
      >
        <AppIcon name="Warning" :size="14" />
        <span>{{ warning }}</span>
      </p>
      <div
        v-if="storage.legacy.exists && storage.legacy.suggested_root"
        class="storage-legacy"
        data-onboarding-storage-legacy
      >
        <p class="onboarding-hint">
          检测到旧模型缓存：{{ legacySummary }}。可临时把模型根切到
          <code class="storage-path">{{ storage.legacy.suggested_root }}</code>
          复用旧缓存；不会迁移或删除任何文件。
        </p>
        <button
          class="onboarding-button storage-legacy__button"
          type="button"
          data-onboarding-storage-use-legacy
          :disabled="saveBlocked"
          @click="handleUseLegacyCache"
        >
          <AppIcon name="Database" :size="14" />
          <span>使用旧缓存（临时）</span>
        </button>
      </div>
    </template>

    <FormField
      field-id="onboarding-models-dir"
      label="模型根目录"
      hint="必须填写绝对路径；保存后新的模型下载与内核启动会立即使用该目录。不会创建目录，也不会迁移旧缓存。"
    >
      <template #default="{ fieldId, describedBy }">
        <input
          :id="fieldId"
          v-model="modelsDir"
          class="onboarding-input"
          type="text"
          spellcheck="false"
          autocomplete="off"
          placeholder="/opt/kinship-models"
          :aria-describedby="describedBy"
          data-onboarding-storage-input
        />
      </template>
    </FormField>

    <div class="onboarding-panel__actions">
      <button
        class="onboarding-button onboarding-button--primary"
        type="button"
        data-onboarding-storage-save
        :disabled="saveBlocked || !modelsDir.trim()"
        @click="handleStorageSave()"
      >
        <AppIcon name="Check" :size="14" />
        <span>{{ saving ? '保存中…' : '保存目录' }}</span>
      </button>
    </div>

    <p
      v-if="storageError"
      class="onboarding-alert onboarding-alert--error"
      data-onboarding-storage-error
      role="alert"
    >
      <AppIcon name="WarningCircle" :size="14" />
      <span>{{ storageError }}</span>
    </p>
    <p
      v-if="storageNotice"
      class="onboarding-alert onboarding-alert--success"
      data-onboarding-storage-notice
    >
      <AppIcon name="CheckCircle" :size="14" />
      <span>{{ storageNotice }}</span>
    </p>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import FormField from '@/components/settings/form/FormField.vue'
import { useOnboarding } from '@/composables/useOnboarding'
import { formatBytes } from '@/components/onboarding/onboardingStatus'

const props = withDefaults(
  defineProps<{
    currentPassword?: string
    disabled?: boolean
  }>(),
  {
    currentPassword: '',
    disabled: false,
  },
)

const emit = defineEmits<{
  saved: []
}>()

const {
  error: onboardingError,
  loadStorage,
  saveStorage,
  storage,
  storageLoading,
} = useOnboarding()

const modelsDir = ref('')
const saving = ref(false)
const storageError = ref('')
const storageNotice = ref('')

const saveBlocked = computed(() => saving.value || props.disabled)

const legacySummary = computed(() => {
  const legacy = storage.value?.legacy
  if (!legacy) return ''
  const labels: string[] = []
  if (legacy.modelscope) labels.push('ModelScope')
  if (legacy.huggingface) labels.push('HuggingFace')
  if (legacy.axeuh_kernel) labels.push('内核模型')
  return labels.join('、')
})

const additionalWarnings = computed(() =>
  (storage.value?.warnings ?? []).filter(
    (warning) =>
      !warning.includes('系统盘') && !warning.includes('AXEUH_MODELS_DIR'),
  ),
)

onMounted(async () => {
  await loadStorage()
  if (!modelsDir.value && storage.value) {
    modelsDir.value = storage.value.models_root
  }
})

function requirePassword(): boolean {
  if (props.currentPassword) return true
  storageError.value = '请输入当前管理员密码后再保存目录。'
  return false
}

function storageFailureMessage(): string {
  const apiError = onboardingError.value
  if (!apiError) return '保存模型根目录失败，请稍后重试。'
  if (apiError.status === 403) {
    return `保存失败：密码或权限校验未通过。${apiError.message}`
  }
  if (apiError.status === 409) {
    return `保存失败：${apiError.message}`
  }
  return apiError.message
}

function describeError(value: unknown, fallback: string): string {
  if (value instanceof Error && value.message.trim()) return value.message
  return fallback
}

async function handleStorageSave(
  mode: 'manual' | 'legacy' = 'manual',
): Promise<void> {
  if (saveBlocked.value) return
  storageError.value = ''
  storageNotice.value = ''
  const target = modelsDir.value.trim()
  if (!target) {
    storageError.value = '请输入模型根目录的绝对路径。'
    return
  }
  if (!requirePassword()) return

  saving.value = true
  try {
    const saved = await saveStorage(
      target,
      undefined,
      props.currentPassword || undefined,
    )
    if (!saved) {
      storageError.value = storageFailureMessage()
      return
    }
    modelsDir.value = saved.models_root
    if (saved.source.models_root === 'env') {
      storageNotice.value =
        `配置已保存为 ${target}，但环境变量 AXEUH_MODELS_DIR 仍覆盖实际模型根 ${saved.models_root}。`
    } else if (mode === 'legacy') {
      storageNotice.value =
        `已把模型根临时切换到旧缓存目录：${saved.models_root}。不会迁移或删除任何文件。`
    } else {
      storageNotice.value =
        `已保存模型根：${saved.models_root}。新的模型下载与内核启动将使用该目录。`
    }
    await loadStorage()
    emit('saved')
  } catch (error) {
    storageError.value = describeError(
      error,
      '保存模型根目录失败，请稍后重试。',
    )
  } finally {
    saving.value = false
  }
}

async function handleUseLegacyCache(): Promise<void> {
  const root = storage.value?.legacy.suggested_root
  if (!root) {
    storageError.value = '未找到可复用的旧缓存目录。'
    return
  }
  if (!requirePassword()) return
  modelsDir.value = root
  await handleStorageSave('legacy')
}
</script>

<style scoped>
.storage-path {
  overflow-wrap: anywhere;
  font-size: 11.5px;
}

.storage-legacy {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-2);
}

.storage-legacy__button {
  flex: none;
}
</style>
