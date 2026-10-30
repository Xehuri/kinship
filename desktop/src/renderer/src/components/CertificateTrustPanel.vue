<script setup lang="ts">
import { computed } from 'vue'
import { LoaderCircle, ShieldAlert, ShieldCheck, TriangleAlert } from 'lucide-vue-next'
import type { CertInfo } from '../../../shared/types'
import CertificateSummary from './CertificateSummary.vue'

const props = withDefaults(
  defineProps<{
    cert: CertInfo
    caPemAvailable: boolean
    busy?: boolean
    error?: string | null
    acknowledged?: boolean
    title?: string
    description?: string
    trustable?: boolean
  }>(),
  {
    busy: false,
    error: null,
    acknowledged: false,
    title: '证书不受系统信任',
    description: '确认下方信息与你的服务器一致后，再决定是否信任。',
    trustable: true,
  },
)

const canTrust = computed(() => props.trustable && !props.cert.error)

const emit = defineEmits<{
  (event: 'trust'): void
  (event: 'update:acknowledged', value: boolean): void
}>()

function onAcknowledge(event: Event): void {
  const target = event.target
  if (!(target instanceof HTMLInputElement)) return
  emit('update:acknowledged', target.checked)
}
</script>

<template>
  <section class="trust-panel" aria-live="polite">
    <header class="trust-panel__head">
      <span class="trust-panel__icon" aria-hidden="true">
        <ShieldAlert :size="17" :stroke-width="2" />
      </span>
      <div>
        <strong>{{ title }}</strong>
        <p>{{ description }}</p>
      </div>
    </header>

    <CertificateSummary :cert="cert" />

    <p class="trust-panel__warning">
      只会信任该主机的这一张证书。主机名不匹配、证书过期等错误不会被绕过。
    </p>

    <button
      v-if="canTrust && caPemAvailable"
      type="button"
      data-test="trust-cert"
      class="btn btn--primary"
      :disabled="busy"
      @click="emit('trust')"
    >
      <LoaderCircle v-if="busy" class="spinner" :size="15" :stroke-width="2" />
      <ShieldCheck v-else :size="15" :stroke-width="2" />
      信任此证书并继续
    </button>

    <template v-else-if="canTrust">
      <div class="notice notice--warning" data-test="trust-unavailable">
        <TriangleAlert :size="16" :stroke-width="2" />
        <div>
          <strong>当前接口未提供根证书内容，无法自动信任。</strong>
          你可以继续，但不会跳过证书校验。请先确认服务器地址与证书信息无误。
        </div>
      </div>
      <label class="check-row" data-test="trust-ack">
        <input
          type="checkbox"
          :checked="acknowledged"
          @change="onAcknowledge"
        />
        我了解该风险，仍然继续
      </label>
    </template>

    <p v-if="error" class="field__error" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
.trust-panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
  border: 1px solid var(--warning-border);
  border-radius: var(--radius-md);
  background: var(--warning-surface);
}

.trust-panel__head {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}

.trust-panel__head strong {
  display: block;
  color: var(--text);
  font-size: var(--text-sm);
  font-weight: 650;
}

.trust-panel__head p {
  margin: 2px 0 0;
  color: var(--text-muted);
  font-size: var(--text-xs);
  line-height: 1.6;
}

.trust-panel__icon {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  flex: none;
  border-radius: var(--radius-sm);
  background: var(--warning-surface);
  color: var(--warning-ink);
}

.trust-panel__warning {
  margin: 0;
  color: var(--warning-ink);
  font-size: var(--text-xs);
  line-height: 1.65;
}

.trust-panel .btn {
  align-self: flex-start;
}
</style>
