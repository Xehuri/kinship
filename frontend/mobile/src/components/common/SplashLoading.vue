<template>
  <Transition name="splash">
    <div v-if="visible" class="splash-overlay">
      <div class="splash-spinner"></div>
      <div class="splash-text">{{ text }}</div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
defineProps<{
  visible: boolean
  text?: string
}>()
</script>

<style scoped>
.splash-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: var(--bg);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  z-index: 9999;
}

.splash-spinner {
  width: 40px;
  height: 40px;
  border: 3px solid rgba(108, 92, 231, 0.2);
  border-top-color: #6c5ce7;
  border-radius: 50%;
  animation: splashSpin 0.8s linear infinite;
  margin-bottom: 20px;
}

@keyframes splashSpin {
  to { transform: rotate(360deg); }
}

.splash-text {
  font-size: 14px;
  color: #9898b0;
  font-family: 'Noto Sans SC', sans-serif;
}

/* Transition */
.splash-enter-active,
.splash-leave-active {
  transition: opacity 0.3s ease-out;
}

.splash-enter-from,
.splash-leave-to {
  opacity: 0;
}
</style>
