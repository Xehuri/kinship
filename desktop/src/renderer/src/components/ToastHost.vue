<script setup lang="ts">
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from 'lucide-vue-next'
import { useToast } from '../composables/useToast'

const { toasts, dismiss } = useToast()
</script>

<template>
  <div class="toast-host" aria-live="polite" aria-atomic="false">
    <div
      v-for="toast in toasts"
      :key="toast.id"
      class="toast"
      :class="`toast--${toast.kind}`"
      :role="toast.kind === 'error' ? 'alert' : 'status'"
    >
      <CircleCheck
        v-if="toast.kind === 'success'"
        :size="17"
        :stroke-width="2"
        aria-hidden="true"
      />
      <CircleAlert
        v-else-if="toast.kind === 'error'"
        :size="17"
        :stroke-width="2"
        aria-hidden="true"
      />
      <TriangleAlert
        v-else-if="toast.kind === 'warning'"
        :size="17"
        :stroke-width="2"
        aria-hidden="true"
      />
      <Info v-else :size="17" :stroke-width="2" aria-hidden="true" />
      <span class="toast__body">{{ toast.message }}</span>
      <button
        type="button"
        class="toast__close"
        aria-label="关闭提示"
        @click="dismiss(toast.id)"
      >
        <X :size="14" :stroke-width="2" />
      </button>
    </div>
  </div>
</template>
