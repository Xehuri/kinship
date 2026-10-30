<template>
  <SettingsSection title="关于" description="版本与运行环境">
    <div class="settings-about">
      <p class="settings-about__name">
        Kinship
      </p>
      <p class="settings-about__line">
        知己 · 小贺
      </p>
    </div>

    <div class="settings-row" data-setting-row="about-assistant">
      <span class="settings-row__icon">
        <AppIcon name="Robot" :size="18" />
      </span>
      <span class="settings-row__text">
        <span class="settings-row__title">AI 助手</span>
        <span class="settings-row__hint">Loom 承载的生产助手</span>
      </span>
      <span class="settings-row__value">小贺</span>
    </div>

    <div class="settings-row" data-setting-row="about-version">
      <span class="settings-row__icon">
        <AppIcon name="Info" :size="18" />
      </span>
      <span class="settings-row__text">
        <span class="settings-row__title">版本</span>
      </span>
      <span class="settings-row__value">{{ APP_VERSION }}</span>
    </div>

    <div class="settings-row" data-setting-row="about-runtime">
      <span class="settings-row__icon">
        <AppIcon name="Monitor" :size="18" />
      </span>
      <span class="settings-row__text">
        <span class="settings-row__title">运行环境</span>
        <span class="settings-row__hint">{{ runtimeText }}</span>
      </span>
    </div>

    <button
      class="settings-row"
      type="button"
      data-setting-row="system-settings"
      @click="openSystemSettings"
    >
      <span class="settings-row__icon">
        <AppIcon name="Gear" :size="18" />
      </span>
      <span class="settings-row__text">
        <span class="settings-row__title">系统设置</span>
        <span class="settings-row__hint">打开 Android 或桌面客户端系统设置</span>
      </span>
      <span class="settings-row__chevron">
        <AppIcon name="ArrowSquareOut" :size="14" />
      </span>
    </button>

    <p class="settings-footer">
      Kinship · 小贺
    </p>
  </SettingsSection>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import SettingsSection from './SettingsSection.vue'
import { useLayout } from '@/composables/useLayout'

const APP_VERSION = 'v1.0.0'

const { isPC } = useLayout()

const runtimeText = computed(() => {
  const platform = isPC.value ? '桌面浏览器' : '移动 WebView'
  return `${platform} · ${window.location.origin}`
})

function openSystemSettings(): void {
  window.location.href = 'axeuh://open-settings'
}
</script>
