<template>
  <div class="ax-audio-preview">
    <div v-if="loading" class="ax-audio-preview__state" aria-busy="true">
      <span class="skeleton ax-audio-preview__line" />
      <span class="ax-audio-preview__label">正在准备音频...</span>
    </div>
    <div v-else-if="error" class="ax-audio-preview__state">
      <span class="ax-audio-preview__label ax-audio-preview__label--error">音频加载失败</span>
      <button class="ax-state__action" type="button" @click="loadAudio">重试</button>
    </div>
    <audio v-else controls :src="audioSrc" class="ax-audio-preview__player">
      您的浏览器不支持音频播放
    </audio>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { getFileRawUrl } from '@/api/files'

const props = defineProps<{
  path: string
}>()

const audioSrc = ref('')
const loading = ref(false)
const error = ref(false)

async function loadAudio(): Promise<void> {
  if (!props.path) {
    audioSrc.value = ''
    return
  }

  loading.value = true
  error.value = false
  try {
    audioSrc.value = await getFileRawUrl(props.path)
    error.value = audioSrc.value.length === 0
  } catch {
    audioSrc.value = ''
    error.value = true
  } finally {
    loading.value = false
  }
}

watch(() => props.path, loadAudio, { immediate: true })
</script>

<style scoped>
.ax-audio-preview {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-6) var(--space-4);
}

.ax-audio-preview__state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
  inline-size: 100%;
}

.ax-audio-preview__line {
  inline-size: min(100%, 320px);
  block-size: 12px;
}

.ax-audio-preview__label {
  color: var(--muted);
  font-size: 13px;
}

.ax-audio-preview__label--error {
  color: var(--danger);
}

.ax-audio-preview__player {
  inline-size: 100%;
  max-inline-size: 480px;
}

.ax-audio-preview .ax-state__action {
  background: transparent;
  padding-block: 0;
  font: inherit;
  cursor: pointer;
}
</style>
