<template>
  <section ref="rootRef" class="onboarding-panel" data-onboarding-panel="finish">
    <header class="onboarding-panel__head">
      <h3 class="onboarding-panel__title">完成</h3>
      <p class="onboarding-panel__desc">
        将执行环境预检、启动服务并验证各子系统，通过后完成初始化。
      </p>
    </header>

    <StepWhy step-id="finish" :detected="detected" />

    <p
      v-if="errorText"
      class="onboarding-alert onboarding-alert--error"
      data-onboarding-finish-error
      role="alert"
    >
      <AppIcon name="WarningCircle" :size="14" />
      <span>{{ errorText }}</span>
    </p>

    <section
      v-if="groups.blocking.length > 0"
      class="onboarding-section"
      data-onboarding-finish-blocking
    >
      <h4 class="onboarding-section__title">需要先处理</h4>
      <ul class="finish-groups">
        <li
          v-for="item in groups.blocking"
          :key="`${item.layer}:${item.id}`"
          class="finish-groups__item"
          :data-group-id="item.id"
        >
          <strong>{{ item.title || item.id }}</strong>
          <span>{{ item.message }}</span>
          <small v-if="item.fix">{{ item.fix }}</small>
        </li>
      </ul>
    </section>

    <section
      v-if="groups.soft.length > 0 && !closing"
      class="onboarding-section"
      data-onboarding-finish-soft
    >
      <h4 class="onboarding-section__title">可降级完成</h4>
      <ul class="finish-groups">
        <li
          v-for="item in groups.soft"
          :key="`${item.layer}:${item.id}`"
          class="finish-groups__item"
          :data-group-id="item.id"
        >
          <strong>{{ item.title || item.id }}</strong>
          <span>{{ item.message }}</span>
          <small v-if="item.fix">{{ item.fix }}</small>
        </li>
      </ul>
    </section>

    <label
      v-if="groups.soft.length > 0 && !closing"
      class="onboarding-checkbox onboarding-checkbox--ack"
      data-onboarding-finish-ack-wrap
    >
      <input
        v-model="acknowledged"
        type="checkbox"
        data-onboarding-finish-ack
      />
      <span>我了解以上提醒，仍要以降级模式完成初始化。</span>
    </label>

    <section
      v-if="closing"
      class="onboarding-section finish-closing"
      data-onboarding-finish-closing
    >
      <h4 class="onboarding-section__title">{{ closing.title }}</h4>
      <p class="finish-closing__message">{{ closing.message }}</p>
      <div class="onboarding-panel__actions finish-closing__actions">
        <button
          class="onboarding-button onboarding-button--primary"
          type="button"
          data-onboarding-finish-enter
          @click="emit('completed')"
        >
          <span>{{ closing.enter_label || '进入主界面' }}</span>
          <AppIcon name="ArrowRight" :size="14" />
        </button>
      </div>
      <div v-if="closing.enabled.length > 0" class="finish-closing__block">
        <span class="finish-closing__label">已启用</span>
        <ul class="onboarding-list">
          <li v-for="item in closing.enabled" :key="item.id">{{ item.label }}</li>
        </ul>
      </div>
      <div v-if="closing.skipped.length > 0" class="finish-closing__block">
        <span class="finish-closing__label">已跳过</span>
        <ul class="onboarding-list">
          <li v-for="item in closing.skipped" :key="item.id">{{ item.label }}</li>
        </ul>
      </div>
      <div v-if="closing.degraded.length > 0" class="finish-closing__block">
        <span class="finish-closing__label">降级项</span>
        <ul class="onboarding-list">
          <li v-for="item in closing.degraded" :key="item.id">{{ item.message }}</li>
        </ul>
      </div>
    </section>

    <LongTaskProgress
      v-if="!closing"
      :active="busy"
      label="正在应用配置并做最后校验"
    />

    <div v-if="!closing" class="onboarding-panel__actions">
      <button
        class="onboarding-button onboarding-button--primary"
        type="button"
        data-onboarding-finish
        :data-busy="busy ? 'true' : undefined"
        :disabled="!canSubmit"
        @click="handleFinish"
      >
        <AppIcon
          :name="busy ? 'CircleNotch' : 'Check'"
          :size="14"
          :class="busy ? 'onboarding-spinner' : undefined"
        />
        <span>{{ busy ? '正在校验并完成…' : '开始校验并完成' }}</span>
      </button>
      <button
        class="onboarding-button"
        type="button"
        data-onboarding-finish-close
        :disabled="busy"
        @click="emit('close')"
      >
        <span>关闭</span>
      </button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import LongTaskProgress from '@/components/onboarding/LongTaskProgress.vue'
import StepWhy, {
  type StepWhyDetectedItem,
} from '@/components/onboarding/StepWhy.vue'
import { useOnboarding } from '@/composables/useOnboarding'

const props = withDefaults(
  defineProps<{
    currentPassword?: string
  }>(),
  {
    currentPassword: '',
  },
)

const emit = defineEmits<{
  completed: []
  close: []
}>()

const {
  finishGroups,
  finishClosing,
  finishError,
  loadFinish,
  runFinish,
  refresh,
} = useOnboarding()

const rootRef = ref<HTMLElement | null>(null)
const acknowledged = ref(false)
const busy = ref(false)
const localError = ref('')

const groups = computed(
  () => finishGroups.value ?? { blocking: [], soft: [] },
)
const closing = computed(() => finishClosing.value)
const errorText = computed(
  () => localError.value || finishError.value?.message || '',
)
const detected = computed<StepWhyDetectedItem[]>(() => {
  const value = finishGroups.value
  if (!value) return []
  return [
    { label: '需要先处理', value: `${value.blocking.length} 项` },
    { label: '可降级完成', value: `${value.soft.length} 项` },
  ]
})
const canSubmit = computed(
  () =>
    !busy.value &&
    groups.value.blocking.length === 0 &&
    (groups.value.soft.length === 0 || acknowledged.value),
)

onMounted(() => {
  void loadFinish()
})

watch(closing, async (value) => {
  if (!value) return
  await nextTick()
  const button = rootRef.value?.querySelector<HTMLElement>(
    '[data-onboarding-finish-enter]',
  )
  if (button && typeof button.scrollIntoView === 'function') {
    button.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }
})

async function handleFinish(): Promise<void> {
  if (!canSubmit.value) return
  busy.value = true
  localError.value = ''
  try {
    const result = await runFinish(
      acknowledged.value,
      props.currentPassword.trim() || undefined,
    )
    if (!result) {
      acknowledged.value = false
      localError.value =
        finishError.value?.message || '初始化校验未通过，请处理后重试。'
      return
    }
    await refresh()
  } finally {
    busy.value = false
  }
}
</script>

<style scoped>
.finish-groups {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.finish-groups__item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--space-2);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
  background: var(--surface);
  font-size: 12px;
  line-height: 1.5;
}

.finish-groups__item strong {
  color: var(--ink);
  font-weight: 600;
}

.finish-groups__item span,
.finish-groups__item small {
  color: var(--muted);
}

.finish-closing__message {
  margin: 0;
  color: var(--muted);
  font-size: 12.5px;
  line-height: 1.6;
}

.finish-closing__actions {
  margin-block: var(--space-3) var(--space-1);
}

.finish-closing__block {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin-block-start: var(--space-3);
}

.finish-closing__label {
  color: var(--ink);
  font-size: 12px;
  font-weight: 600;
}
</style>
