<template>
  <SettingsSection
    title="系统配置"
    description="运行载体、配置版本与在线编辑"
  >
    <p
      v-if="loading && !snapshot"
      class="settings-message settings-message--note"
      data-system-config-loading
    >
      <AppIcon name="CircleNotch" :size="14" />
      <span>正在读取配置…</span>
    </p>

    <p
      v-if="error"
      class="settings-message settings-message--error"
      data-system-config-error
      role="alert"
    >
      <AppIcon name="WarningCircle" :size="14" />
      <span>{{ error.message }}</span>
    </p>

    <template v-if="isLoggedIn && snapshot">
      <div class="settings-row" data-setting-row="system-config-provider">
        <span class="settings-row__icon">
          <AppIcon name="Gear" :size="18" />
        </span>
        <span class="settings-row__text">
          <span class="settings-row__title">配置载体</span>
          <span class="settings-row__hint">{{ snapshot.provider.location || snapshot.provider.detail || '未提供存储位置' }}</span>
        </span>
        <span class="settings-row__value">
          {{ snapshot.provider.kind || '未知' }} · {{ snapshot.provider.writable ? '可写' : '只读' }}
        </span>
      </div>

      <div class="settings-row" data-setting-row="system-config-revision">
        <span class="settings-row__icon">
          <AppIcon name="GitBranch" :size="18" />
        </span>
        <span class="settings-row__text">
          <span class="settings-row__title">配置版本</span>
          <span class="settings-row__hint">每次保存后版本递增，用于冲突检测</span>
        </span>
        <span
          class="settings-row__value"
          data-system-config-revision
          :title="snapshot.revision"
        >{{ shortRevision }}</span>
      </div>

      <div class="settings-row" data-setting-row="system-config-degraded">
        <span class="settings-row__icon">
          <AppIcon name="Warning" :size="18" />
        </span>
        <span class="settings-row__text">
          <span class="settings-row__title">降级项</span>
          <span class="settings-row__hint">启动时无法满足的配置项</span>
        </span>
        <span class="settings-row__value">{{ snapshot.degraded.length }}</span>
      </div>

      <div class="settings-row" data-setting-row="system-config-failures">
        <span class="settings-row__icon">
          <AppIcon name="XCircle" :size="18" />
        </span>
        <span class="settings-row__text">
          <span class="settings-row__title">应用失败</span>
          <span class="settings-row__hint">最近一次保存未生效的字段</span>
        </span>
        <span
          class="settings-row__value"
          :class="{ 'settings-row__value--danger': applyFailureCount > 0 }"
        >
          {{ applyFailureCount }}
        </span>
      </div>

      <p
        v-if="!snapshot.provider.writable"
        class="settings-message settings-message--note"
        data-system-config-readonly
      >
        <AppIcon name="WarningCircle" :size="14" />
        <span>当前载体只读（{{ snapshot.provider.kind }}），配置文件只能由部署端修改。</span>
      </p>
    </template>

    <div v-if="isLoggedIn" class="system-config-card__actions">
      <button
        class="settings-button settings-button--primary"
        type="button"
        data-action="edit-config"
        :disabled="!canEdit"
        @click="editorOpen = true"
      >
        <AppIcon name="Gear" :size="14" />
        <span>编辑配置</span>
      </button>
      <button
        class="settings-button"
        type="button"
        data-action="open-onboarding"
        @click="emit('open-onboarding')"
      >
        <AppIcon name="Wrench" :size="14" />
        <span>配置向导（测试模式）</span>
      </button>
    </div>
  </SettingsSection>

  <SystemConfigEditor :open="editorOpen" @close="editorOpen = false" />
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import SettingsSection from './SettingsSection.vue'
import SystemConfigEditor from './SystemConfigEditor.vue'
import { useApi } from '@/composables/useApi'
import { useSystemConfig } from '@/composables/useSystemConfig'
import './system-config.css'

const emit = defineEmits<{
  'open-onboarding': []
}>()

const { isLoggedIn } = useApi()
const { snapshot, loading, error, load } = useSystemConfig()
const editorOpen = ref(false)

const applyFailureCount = computed(
  () => Object.keys(snapshot.value?.apply_failures ?? {}).length,
)

const shortRevision = computed(() => {
  const revision = snapshot.value?.revision ?? ''
  return revision.length > 18 ? `${revision.slice(0, 18)}…` : revision
})

const canEdit = computed(
  () =>
    isLoggedIn.value &&
    snapshot.value !== null &&
    snapshot.value.provider.writable,
)

onMounted(() => {
  void load()
})
</script>
