<script setup lang="ts">
import { computed } from 'vue'
import type { Component } from 'vue'
import {
  Circle,
  CircleAlert,
  CircleCheck,
  FolderOpen,
  LoaderCircle,
  MonitorCog,
  RotateCcw,
  ScrollText,
  TriangleAlert,
  Wifi,
} from 'lucide-vue-next'
import type { SensorStatus } from '../../../shared/types'
import { formatCount, formatDateTime } from '../lib/format'
import {
  authErrorTitle,
  loginTestDetail,
  sensorConnectionView,
  type LoginTestView,
} from '../lib/sensor-health'
import { sensorStateMeta } from '../lib/sensor-status'
import StatusBadge from './StatusBadge.vue'

const props = withDefaults(
  defineProps<{
    status: SensorStatus | null
    statusError?: string | null
    serverUrl: string
    loginBusy?: boolean
    loginResult?: LoginTestView | null
    panelBusy?: boolean
    restartBusy?: boolean
    logsBusy?: boolean
  }>(),
  {
    statusError: null,
    loginBusy: false,
    loginResult: null,
    panelBusy: false,
    restartBusy: false,
    logsBusy: false,
  },
)

const emit = defineEmits<{
  (event: 'test-login'): void
  (event: 'open-panel'): void
  (event: 'restart'): void
  (event: 'open-logs'): void
  (event: 'open-log-folder'): void
}>()

const meta = computed(() => sensorStateMeta(props.status?.state))
const connection = computed(() => sensorConnectionView(props.status))
const isLive = computed(
  () => props.status?.state === 'running' || props.status?.state === 'external',
)

const connectionIcon = computed<Component>(() => {
  if (connection.value.tone === 'ok') return CircleCheck
  if (connection.value.tone === 'danger') return CircleAlert
  if (connection.value.tone === 'warn') return TriangleAlert
  return Circle
})

const queueLabel = computed(() =>
  props.status && isLive.value ? `${formatCount(props.status.queueSize)} 条` : '—',
)
const lastEventLabel = computed(() =>
  props.status?.lastEventAt ? formatDateTime(props.status.lastEventAt) : '暂无',
)
const portLabel = computed(() =>
  props.status?.port ? String(props.status.port) : '—',
)
const authTitle = computed(() => authErrorTitle(props.status?.authError))
const loginResultDetail = computed(() =>
  props.loginResult ? loginTestDetail(props.loginResult) : '',
)
</script>

<template>
  <div class="sensor-status" data-test="sensor-status-card">
    <div class="sensor-status__head">
      <StatusBadge :state="status?.state" :live="status?.state === 'running'" />
      <p class="sensor-status__desc">{{ meta.description }}</p>
    </div>

    <dl class="sensor-status__facts">
      <div class="sensor-fact">
        <dt>服务器连接</dt>
        <dd class="sensor-fact__value" :data-tone="connection.tone">
          <component :is="connectionIcon" :size="14" :stroke-width="2" aria-hidden="true" />
          {{ connection.label }}
        </dd>
      </div>
      <div class="sensor-fact">
        <dt>待上传队列</dt>
        <dd>{{ queueLabel }}</dd>
      </div>
      <div class="sensor-fact">
        <dt>最后事件</dt>
        <dd>{{ lastEventLabel }}</dd>
      </div>
      <div class="sensor-fact">
        <dt>本机端口</dt>
        <dd class="mono">{{ portLabel }}</dd>
      </div>
      <div class="sensor-fact sensor-fact--wide">
        <dt>上报服务器</dt>
        <dd class="mono">{{ serverUrl || '未配置' }}</dd>
      </div>
    </dl>

    <div v-if="statusError" class="notice notice--danger" role="alert" data-test="sensor-status-error">
      <CircleAlert :size="16" :stroke-width="2" />
      <div>
        <strong>无法读取采集端状态</strong>
        {{ statusError }}
      </div>
    </div>

    <div
      v-if="status?.authError"
      class="notice notice--danger"
      role="alert"
      data-test="sensor-auth-alert"
    >
      <CircleAlert :size="16" :stroke-width="2" />
      <div>
        <strong>{{ authTitle }}</strong>
        <p v-if="authTitle !== status.authError" class="sensor-status__alert-body">
          {{ status.authError }}
        </p>
        <p class="sensor-status__alert-hint">
          采集端正在运行，但未能登录服务器。检查账号密码或访问令牌后点击“测试登录”。
        </p>
      </div>
    </div>

    <div
      v-if="status?.lastError && !status?.authError"
      class="notice notice--danger"
      role="alert"
      data-test="sensor-last-error"
    >
      <CircleAlert :size="16" :stroke-width="2" />
      <div>
        <strong>采集端报告错误</strong>
        {{ status.lastError }}
      </div>
    </div>

    <div
      v-if="loginResult"
      class="sensor-login"
      :class="loginResult.success ? 'sensor-login--ok' : 'sensor-login--danger'"
      :role="loginResult.success ? 'status' : 'alert'"
      data-test="login-test-result"
      :data-state="loginResult.success ? 'ok' : 'danger'"
    >
      <CircleCheck
        v-if="loginResult.success"
        :size="16"
        :stroke-width="2"
        aria-hidden="true"
      />
      <CircleAlert v-else :size="16" :stroke-width="2" aria-hidden="true" />
      <div>
        <strong>{{ loginResult.success ? '登录成功' : '登录失败' }}</strong>
        <p v-if="loginResultDetail" class="sensor-login__detail">{{ loginResultDetail }}</p>
      </div>
    </div>

    <div class="sensor-status__actions">
      <button
        type="button"
        class="btn btn--sm"
        data-test="test-login"
        :disabled="loginBusy"
        @click="emit('test-login')"
      >
        <LoaderCircle v-if="loginBusy" class="spinner" :size="14" :stroke-width="2" />
        <Wifi v-else :size="14" :stroke-width="2" />
        {{ loginBusy ? '测试中…' : '测试登录' }}
      </button>
      <button
        type="button"
        class="btn btn--sm"
        data-test="open-panel"
        :disabled="panelBusy"
        @click="emit('open-panel')"
      >
        <LoaderCircle v-if="panelBusy" class="spinner" :size="14" :stroke-width="2" />
        <MonitorCog v-else :size="14" :stroke-width="2" />
        打开采集端面板
      </button>
      <button
        type="button"
        class="btn btn--sm"
        data-test="restart-sensor"
        :disabled="restartBusy"
        @click="emit('restart')"
      >
        <LoaderCircle v-if="restartBusy" class="spinner" :size="14" :stroke-width="2" />
        <RotateCcw v-else :size="14" :stroke-width="2" />
        重启采集端
      </button>
      <button
        type="button"
        class="btn btn--sm btn--ghost"
        data-test="open-logs-settings"
        @click="emit('open-logs')"
      >
        <ScrollText :size="14" :stroke-width="2" />
        查看日志
      </button>
      <button
        type="button"
        class="btn btn--sm btn--ghost"
        data-test="open-log-folder"
        :disabled="logsBusy"
        @click="emit('open-log-folder')"
      >
        <LoaderCircle v-if="logsBusy" class="spinner" :size="14" :stroke-width="2" />
        <FolderOpen v-else :size="14" :stroke-width="2" />
        打开日志文件夹
      </button>
    </div>
  </div>
</template>

<style scoped>
.sensor-status {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.sensor-status__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
}

.sensor-status__desc {
  margin: 0;
  color: var(--text-muted);
  font-size: var(--text-xs);
  line-height: 1.6;
}

.sensor-status__facts {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-4) var(--space-6);
  margin: 0;
  padding: var(--space-4) 0;
  border-top: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
}

.sensor-fact {
  min-width: 0;
}

.sensor-fact--wide {
  grid-column: 1 / -1;
}

.sensor-fact dt {
  color: var(--text-faint);
  font-size: var(--text-xs);
  font-weight: 600;
  letter-spacing: 0.02em;
}

.sensor-fact dd {
  margin: 3px 0 0;
  color: var(--text);
  font-size: var(--text-sm);
  font-weight: 620;
  overflow-wrap: anywhere;
}

.sensor-fact__value {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.sensor-fact__value[data-tone='ok'] {
  color: var(--success-ink);
}

.sensor-fact__value[data-tone='warn'] {
  color: var(--warning-ink);
}

.sensor-fact__value[data-tone='danger'] {
  color: var(--danger-ink);
}

.sensor-fact__value[data-tone='neutral'] {
  color: var(--text-muted);
}

.sensor-status__alert-body {
  margin: 4px 0 0;
  color: var(--danger-ink);
  font-size: var(--text-sm);
  font-weight: 600;
}

.sensor-status__alert-hint {
  margin: 5px 0 0;
  color: var(--text-muted);
  font-size: var(--text-xs);
  line-height: 1.6;
}

.sensor-login {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--surface-sunken);
  font-size: var(--text-sm);
  line-height: 1.6;
}

.sensor-login > svg {
  margin-top: 1px;
}

.sensor-login strong {
  font-weight: 650;
}

.sensor-login__detail {
  margin: 3px 0 0;
  color: var(--text-muted);
  font-size: var(--text-xs);
  overflow-wrap: anywhere;
}

.sensor-login--ok {
  border-color: var(--success-border);
  background: var(--success-surface);
  color: var(--success-ink);
}

.sensor-login--ok strong {
  color: var(--success-ink);
}

.sensor-login--danger {
  border-color: var(--danger-border);
  background: var(--danger-surface);
  color: var(--danger-ink);
}

.sensor-login--danger strong {
  color: var(--danger-ink);
}

.sensor-status__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}

@media (max-width: 640px) {
  .sensor-status__facts {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
