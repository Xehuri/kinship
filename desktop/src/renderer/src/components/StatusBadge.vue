<script setup lang="ts">
import { computed } from 'vue'
import type { SensorState } from '../../../shared/types'
import { sensorStateMeta } from '../lib/sensor-status'

const props = withDefaults(
  defineProps<{
    state?: SensorState | null
    live?: boolean
  }>(),
  {
    state: null,
    live: false,
  },
)

const meta = computed(() => sensorStateMeta(props.state))
</script>

<template>
  <span class="badge" :class="`badge--${meta.tone}`">
    <span
      class="status-dot"
      :class="[`status-dot--${meta.tone}`, { 'status-dot--live': live && meta.tone === 'ok' }]"
      aria-hidden="true"
    />
    {{ meta.label }}
  </span>
</template>
