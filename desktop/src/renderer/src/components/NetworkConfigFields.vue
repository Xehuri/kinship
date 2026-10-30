<script setup lang="ts">
import { computed } from 'vue'
import { CircleCheck, Plus, Trash2 } from 'lucide-vue-next'
import type { NetworkFormState } from '../lib/network-form'
import {
  addEndpoint,
  removeEndpoint,
  selectMode,
  selectedEndpoint,
  selectedEndpointUrl,
} from '../lib/network-form'

const props = defineProps<{
  form: NetworkFormState
}>()

const current = computed(() => selectedEndpoint(props.form))
const currentUrl = computed(() => selectedEndpointUrl(props.form))

function setMode(mode: 'auto' | 'frp'): void {
  selectMode(props.form, mode)
}

function addCandidate(): void {
  addEndpoint(props.form)
}

function removeCandidate(index: number): void {
  removeEndpoint(props.form, index)
}

function selectCandidate(index: number): void {
  props.form.currentEndpointIndex = index
}
</script>

<template>
  <div class="network-form">
    <div class="field">
      <span class="field__label">传输模式</span>
      <div class="segmented" role="radiogroup" aria-label="传输模式">
        <button
          type="button"
          role="radio"
          data-test="network-mode-auto"
          :aria-checked="form.mode === 'auto'"
          @click="setMode('auto')"
        >
          自动
        </button>
        <button
          type="button"
          role="radio"
          data-test="network-mode-frp"
          :aria-checked="form.mode === 'frp'"
          @click="setMode('frp')"
        >
          FRP
        </button>
      </div>
      <p class="field__hint">
        自动模式按优先级排列候选；FRP 模式会默认选中名称或地址包含 frp 的端点。桌面端不做网络探测，实际探测与回退由 PC 采集端按优先级完成。
      </p>
    </div>

    <div class="field">
      <div class="row-between">
        <span class="field__label">端点候选</span>
        <button
          type="button"
          class="btn btn--sm"
          data-test="network-add-endpoint"
          @click="addCandidate"
        >
          <Plus :size="14" :stroke-width="2" />
          添加端点
        </button>
      </div>
      <p class="field__hint">
        优先级数字越小越先尝试。未配置候选时，PC 采集端直接使用服务器地址。
      </p>

      <p v-if="form.endpointCandidates.length === 0" class="network-empty">
        尚未配置候选端点。
      </p>

      <div v-else class="network-list">
        <div
          v-for="(candidate, index) in form.endpointCandidates"
          :key="index"
          class="network-row"
          :class="{ 'is-selected': form.currentEndpointIndex === index }"
        >
          <button
            type="button"
            role="radio"
            class="network-select"
            :aria-checked="form.currentEndpointIndex === index"
            :aria-label="`选择端点 ${candidate.name || index + 1}`"
            :data-test="`network-endpoint-select-${index}`"
            @click="selectCandidate(index)"
          >
            <CircleCheck
              v-if="form.currentEndpointIndex === index"
              :size="15"
              :stroke-width="2.2"
            />
          </button>

          <input
            v-model="candidate.name"
            class="input network-name"
            :data-test="`network-endpoint-name-${index}`"
            maxlength="64"
            aria-label="端点名称"
            placeholder="ipv6"
            autocomplete="off"
            spellcheck="false"
          />
          <input
            v-model="candidate.url"
            class="input mono network-url"
            :data-test="`network-endpoint-url-${index}`"
            aria-label="端点地址"
            placeholder="https://your-server.example:8443"
            inputmode="url"
            autocomplete="off"
            spellcheck="false"
          />
          <input
            v-model.number="candidate.priority"
            class="input network-priority"
            :data-test="`network-endpoint-priority-${index}`"
            type="number"
            min="0"
            max="10000"
            step="1"
            aria-label="优先级"
            placeholder="50"
          />
          <button
            type="button"
            class="network-remove"
            :data-test="`network-endpoint-remove-${index}`"
            :aria-label="`删除端点 ${candidate.name || index + 1}`"
            @click="removeCandidate(index)"
          >
            <Trash2 :size="15" :stroke-width="2" />
          </button>
        </div>
      </div>

      <p class="network-current" data-test="network-current-endpoint">
        <template v-if="current">
          当前端点：<strong>{{ current.name || '未命名端点' }}</strong>
          <span v-if="currentUrl.length > 0" class="mono"> · {{ currentUrl }}</span>
        </template>
        <template v-else>当前端点：未选择，由 PC 采集端按优先级自动探测。</template>
      </p>
    </div>
  </div>
</template>

<style scoped>
.network-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}

.network-empty {
  margin: 0;
  padding: var(--space-4);
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  font-size: var(--text-sm);
  text-align: center;
}

.network-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.network-row {
  display: grid;
  grid-template-columns: 30px minmax(0, 0.9fr) minmax(0, 1.7fr) 88px 34px;
  gap: var(--space-2);
  align-items: center;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface-sunken);
  transition:
    border-color var(--motion-fast) var(--ease),
    background var(--motion-fast) var(--ease);
}

.network-row.is-selected {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 7%, var(--surface-sunken));
}

.network-select {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 1px solid var(--border-strong);
  border-radius: 50%;
  background: transparent;
  color: var(--accent-ink);
  cursor: pointer;
  transition:
    border-color var(--motion-fast) var(--ease),
    background var(--motion-fast) var(--ease);
}

.network-select:hover {
  border-color: var(--accent);
}

.network-select[aria-checked='true'] {
  border-color: var(--accent);
  background: var(--focus-soft);
}

.network-select:focus-visible,
.network-remove:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}

.network-remove {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--text-faint);
  cursor: pointer;
  transition:
    border-color var(--motion-fast) var(--ease),
    color var(--motion-fast) var(--ease),
    background var(--motion-fast) var(--ease);
}

.network-remove:hover {
  border-color: var(--danger-border);
  background: var(--danger-surface);
  color: var(--danger-ink);
}

.network-current {
  margin: 0;
  color: var(--text-muted);
  font-size: var(--text-xs);
  line-height: 1.65;
}

.network-current strong {
  color: var(--text);
  font-weight: 620;
}

@media (max-width: 760px) {
  .network-row {
    grid-template-columns: 30px minmax(0, 1fr) 34px;
  }

  .network-name,
  .network-url,
  .network-priority {
    grid-column: 2 / 3;
  }

  .network-remove {
    grid-column: 3 / 4;
    grid-row: 1;
  }

  .network-select {
    grid-row: 1;
  }
}
</style>
