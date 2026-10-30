<template>
  <SettingsSection v-if="isPC" title="设备" description="Windows PC 状态采集器">
    <button
      class="settings-row"
      type="button"
      data-setting-row="pc-sensor"
      @click="handleDownload"
    >
      <span class="settings-row__icon">
        <AppIcon name="DesktopTower" :size="18" />
      </span>
      <span class="settings-row__text">
        <span class="settings-row__title">PC 采集端</span>
        <span class="settings-row__hint">采集前台窗口、空闲与锁屏状态并上报后端</span>
      </span>
      <span class="settings-row__value">{{ valueText }}</span>
      <span class="settings-row__chevron">
        <AppIcon name="Download" :size="14" />
      </span>
    </button>

    <p v-if="errorMessage" class="settings-message settings-message--error pc-sensor-message" role="alert">
      <AppIcon name="WarningCircle" :size="14" />
      <span>{{ errorMessage }}</span>
    </p>
  </SettingsSection>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import SettingsSection from './SettingsSection.vue'
import { useLayout } from '@/composables/useLayout'
import { downloadPcSensor, fetchPcSensorInfo } from '@/api/downloads'

const { isPC } = useLayout()

const sizeText = ref('')
const downloading = ref(false)
const errorMessage = ref('')
let infoLoaded = false

const valueText = computed(() => (downloading.value ? '下载中…' : sizeText.value))

async function loadInfo(): Promise<void> {
  if (!isPC.value || infoLoaded) return
  infoLoaded = true
  const info = await fetchPcSensorInfo()
  if (!info) return
  sizeText.value = info.exists ? info.size_text : '未构建'
}

async function handleDownload(): Promise<void> {
  if (downloading.value) return
  errorMessage.value = ''
  downloading.value = true
  try {
    const ok = await downloadPcSensor()
    if (!ok) {
      errorMessage.value = '下载失败：请确认登录状态有效'
    }
  } finally {
    downloading.value = false
  }
}

onMounted(loadInfo)
</script>
