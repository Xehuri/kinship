<script setup lang="ts">
import { computed } from 'vue'
import type { Component } from 'vue'
import {
  CircleAlert,
  CircleCheck,
  LoaderCircle,
  RotateCcw,
  ScrollText,
  TriangleAlert,
  Wifi,
} from 'lucide-vue-next'
import type { SensorHealthView } from '../lib/sensor-health'

const props = withDefaults(
  defineProps<{
    health: SensorHealthView
    loginBusy?: boolean
    restartBusy?: boolean
  }>(),
  {
    loginBusy: false,
    restartBusy: false,
  },
)

const emit = defineEmits<{
  (event: 'show-details'): void
  (event: 'test-login'): void
  (event: 'open-logs'): void
  (event: 'restart'): void
}>()

const icon = computed<Component>(() => {
  if (props.health.tone === 'ok') return CircleCheck
  if (props.health.tone === 'warn') return TriangleAlert
  if (props.health.tone === 'danger') return CircleAlert
  return Wifi
})

const dotTone = computed(() => (props.health.tone === 'neutral' ? 'accent' : props.health.tone))
</script>

<template>
  <div
    class="health-strip"
    :data-tone="health.tone"
    :role="health.tone === 'danger' ? 'alert' : 'status'"
    aria-live="polite"
    data-test="health-strip"
  >
    <span class="health-strip__mark" aria-hidden="true">
      <component :is="icon" :size="19" :stroke-width="2" />
    </span>

    <div class="health-strip__body">
      <p class="health-strip__eyebrow">PC 采集端 · 连接状态</p>
      <p class="health-strip__title">
        <strong>{{ health.title }}</strong>
        <span
          v-if="health.live"
          class="status-dot"
          :class="[
            `status-dot--${dotTone}`,
            { 'status-dot--live': health.tone === 'ok' },
          ]"
          aria-hidden="true"
        />
      </p>
      <p class="health-strip__detail">{{ health.detail }}</p>
    </div>

    <div class="health-strip__actions">
      <button type="button" class="link-btn" data-test="health-details" @click="emit('show-details')">
        查看详情
      </button>
      <button
        v-if="health.canTestLogin"
        type="button"
        class="btn btn--sm"
        data-test="health-test-login"
        :disabled="loginBusy"
        @click="emit('test-login')"
      >
        <LoaderCircle v-if="loginBusy" class="spinner" :size="14" :stroke-width="2" />
        <Wifi v-else :size="14" :stroke-width="2" />
        {{ loginBusy ? '测试中…' : '测试登录' }}
      </button>
      <button
        v-else-if="health.canRestart"
        type="button"
        class="btn btn--sm"
        data-test="health-restart"
        :disabled="restartBusy"
        @click="emit('restart')"
      >
        <LoaderCircle v-if="restartBusy" class="spinner" :size="14" :stroke-width="2" />
        <RotateCcw v-else :size="14" :stroke-width="2" />
        {{ restartBusy ? '重启中…' : '重启采集端' }}
      </button>
      <button
        type="button"
        class="btn btn--sm btn--ghost"
        data-test="health-open-logs"
        @click="emit('open-logs')"
      >
        <ScrollText :size="14" :stroke-width="2" />
        查看日志
      </button>
    </div>
  </div>
</template>

<style scoped>
.health-strip {
  --health-tint: var(--text-faint);
  --health-ink: var(--text-muted);
  --health-border: var(--border);

  position: sticky;
  top: var(--space-4);
  z-index: 30;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: 10px 12px;
  border: 1px solid var(--health-border);
  border-radius: var(--radius-sm);
  background: var(--surface);
}

.health-strip[data-tone='ok'] {
  --health-tint: var(--success);
  --health-ink: var(--success-ink);
  --health-border: var(--success-border);
}

.health-strip[data-tone='warn'] {
  --health-tint: var(--warning);
  --health-ink: var(--warning-ink);
  --health-border: var(--warning-border);
}

.health-strip[data-tone='danger'] {
  --health-tint: var(--danger);
  --health-ink: var(--danger-ink);
  --health-border: var(--danger-border);
}

.health-strip__mark {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  flex: none;
  border: 1px solid var(--health-border);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--health-tint) 10%, var(--surface));
  color: var(--health-ink);
}

.health-strip__body {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.health-strip__eyebrow {
  margin: 0;
  color: var(--text-faint);
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.health-strip__title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  min-width: 0;
}

.health-strip__title strong {
  overflow: hidden;
  color: var(--health-ink);
  font-size: var(--text-base);
  font-weight: 500;
  letter-spacing: -0.01em;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.health-strip[data-tone='neutral'] .health-strip__title strong {
  color: var(--text);
}

.health-strip__detail {
  margin: 0;
  overflow: hidden;
  color: var(--text-muted);
  font-size: var(--text-xs);
  line-height: 1.5;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.health-strip[data-tone='danger'] .health-strip__detail {
  color: var(--danger-ink);
  white-space: normal;
  overflow-wrap: anywhere;
}

.health-strip[data-tone='warn'] .health-strip__detail {
  white-space: normal;
  overflow-wrap: anywhere;
}

.health-strip__actions {
  display: flex;
  flex: none;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}

@media (max-width: 760px) {
  .health-strip {
    flex-wrap: wrap;
    align-items: flex-start;
  }

  .health-strip__body {
    flex-basis: calc(100% - 56px);
  }

  .health-strip__actions {
    width: 100%;
    justify-content: flex-end;
  }

  .health-strip__detail {
    white-space: normal;
  }
}
</style>
