<script setup lang="ts">
import { computed } from 'vue'
import type { CertInfo } from '../../../shared/types'
import { formatDateTime } from '../lib/format'

const props = defineProps<{
  cert: CertInfo
}>()

const validity = computed(() => {
  const from = formatDateTime(props.cert.validFrom)
  const to = formatDateTime(props.cert.validTo)
  return `${from} 至 ${to}`
})
</script>

<template>
  <dl class="kv certificate-summary">
    <dt>主机</dt>
    <dd class="mono">{{ cert.host }}:{{ cert.port }}</dd>

    <dt>主题</dt>
    <dd>{{ cert.subject || '未提供' }}</dd>

    <dt>颁发者</dt>
    <dd>{{ cert.issuer || '未提供' }}</dd>

    <dt>有效期</dt>
    <dd>{{ validity }}</dd>

    <dt>SHA-256 指纹</dt>
    <dd class="mono-block">{{ cert.fingerprint256 || '未提供' }}</dd>

    <template v-if="cert.selfSigned">
      <dt>类型</dt>
      <dd><span class="badge badge--warn">自签名证书</span></dd>
    </template>

    <template v-if="cert.error">
      <dt>证书问题</dt>
      <dd class="text-muted">{{ cert.error }}</dd>
    </template>
  </dl>
</template>

<style scoped>
.certificate-summary {
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--surface-sunken);
}
</style>
