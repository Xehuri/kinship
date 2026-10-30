<template>
  <Teleport to="body">
    <Transition name="settings-fade">
      <div
        v-if="open"
        ref="overlayRef"
        class="system-config-overlay"
        data-system-config-editor
      >
        <header class="system-config-overlay__header">
          <span class="system-config-overlay__title">
            <AppIcon name="Gear" :size="16" />
            <span>系统配置</span>
          </span>
          <span class="system-config-overlay__header-actions">
            <span v-if="snapshot" class="system-config-overlay__revision">
              版本 {{ snapshot.revision }}
            </span>
            <button
              class="system-config-overlay__close"
              type="button"
              aria-label="关闭系统配置编辑器"
              data-config-close
              @click="emit('close')"
            >
              <AppIcon name="X" :size="18" />
            </button>
          </span>
        </header>

        <div class="system-config-overlay__body">
          <p
            v-if="!snapshot || !schema"
            class="system-config-message system-config-message--note"
            data-config-loading
          >
            <span class="system-config-message__icon">
              <AppIcon name="Info" :size="14" />
            </span>
            <span>配置尚未加载，请关闭后重试。</span>
          </p>

          <template v-else>
            <section class="system-config-provider" data-config-provider>
              <div class="system-config-provider__item" data-provider-kind>
                <span class="system-config-provider__label">载体类型</span>
                <span class="system-config-provider__value">{{ snapshot.provider.kind || '未知' }}</span>
              </div>
              <div class="system-config-provider__item" data-provider-location>
                <span class="system-config-provider__label">存储位置</span>
                <span class="system-config-provider__value">{{ snapshot.provider.location || '未知' }}</span>
              </div>
              <div class="system-config-provider__item" data-provider-writable>
                <span class="system-config-provider__label">写入权限</span>
                <span class="system-config-provider__value">
                  {{ snapshot.provider.writable ? '可写' : '只读' }}
                </span>
              </div>
              <div class="system-config-provider__item" data-provider-revision>
                <span class="system-config-provider__label">配置版本</span>
                <span class="system-config-provider__value">{{ snapshot.revision }}</span>
              </div>
              <div class="system-config-provider__item" data-provider-degraded>
                <span class="system-config-provider__label">
                  降级项 {{ snapshot.degraded.length }}
                </span>
                <ul v-if="snapshot.degraded.length > 0" class="system-config-provider__list">
                  <li
                    v-for="item in snapshot.degraded"
                    :key="item"
                    class="system-config-provider__list-item"
                  >
                    {{ item }}
                  </li>
                </ul>
                <span v-else class="system-config-provider__value">无</span>
              </div>
              <div class="system-config-provider__item" data-provider-failures>
                <span class="system-config-provider__label">
                  应用失败 {{ snapshotFailedEntries.length }}
                </span>
                <ul v-if="snapshotFailedEntries.length > 0" class="system-config-provider__list">
                  <li
                    v-for="[path, message] in snapshotFailedEntries"
                    :key="path"
                    class="system-config-provider__list-item"
                  >
                    {{ path }}：{{ message }}
                  </li>
                </ul>
                <span v-else class="system-config-provider__value">无</span>
              </div>
            </section>

            <p
              v-if="!snapshot.provider.writable"
              class="system-config-message system-config-message--warning"
              data-readonly-warning
              role="alert"
            >
              <span class="system-config-message__icon">
                <AppIcon name="WarningCircle" :size="14" />
              </span>
              <span>当前载体只读（{{ snapshot.provider.kind }}），在线编辑与保存已禁用。</span>
            </p>

            <div class="system-config-toolbar">
              <label class="system-config-search">
                <AppIcon name="MagnifyingGlass" :size="15" />
                <input
                  v-model="search"
                  class="system-config-search__input"
                  data-config-search
                  type="search"
                  placeholder="搜索配置项、路径或说明"
                  aria-label="搜索配置项"
                />
              </label>
              <span class="system-config-toolbar__count">{{ visibleCount }} 项</span>
            </div>

            <p
              v-if="searchActive && visibleCount === 0"
              class="system-config-message system-config-message--note"
              data-search-empty
            >
              没有匹配的配置项。
            </p>

            <details
              v-for="group in coreGroups"
              :key="`core-${group.category.id}`"
              class="system-config-group"
              :data-category="group.category.id"
              data-config-group
              :open="searchActive ? true : undefined"
            >
              <summary class="system-config-group__head">
                <span class="system-config-group__heading">
                  <h3 class="system-config-group__title">{{ group.category.title }}</h3>
                  <span class="system-config-group__count">{{ group.fields.length }}</span>
                  <span class="system-config-group__chevron">
                    <AppIcon name="CaretDown" :size="14" />
                  </span>
                </span>
                <span v-if="group.category.description" class="system-config-group__desc">
                  {{ group.category.description }}
                </span>
              </summary>
              <div class="system-config-group__body">
                <SystemConfigField
                  v-for="field in group.fields"
                  :key="field.path"
                  :field="field"
                  :model-value="displayValue(field)"
                  :disabled="!snapshot.provider.writable"
                  :error="fieldError(field.path)"
                  @update:model-value="handleFieldUpdate(field, $event)"
                  @clear="handleFieldClear(field)"
                />
              </div>
            </details>

            <section v-if="advancedFieldCount > 0" class="system-config-advanced">
              <button
                class="system-config-advanced__toggle"
                type="button"
                data-config-advanced-toggle
                :aria-expanded="advancedVisible ? 'true' : 'false'"
                @click="advancedOpen = !advancedOpen"
              >
                <AppIcon name="SlidersHorizontal" :size="15" />
                <span>高级配置</span>
                <span class="system-config-advanced__count">{{ advancedFieldCount }}</span>
                <span
                  class="system-config-advanced__chevron"
                  :class="{ 'system-config-advanced__chevron--open': advancedVisible }"
                >
                  <AppIcon name="CaretDown" :size="14" />
                </span>
              </button>

              <div v-if="advancedVisible" class="system-config-advanced__body" data-advanced-body>
                <details
                  v-for="group in advancedGroups"
                  :key="`advanced-${group.category.id}`"
                  class="system-config-group"
                  :data-category="group.category.id"
                  data-config-group
                  :open="searchActive ? true : undefined"
                >
                  <summary class="system-config-group__head">
                    <span class="system-config-group__heading">
                      <h3 class="system-config-group__title">{{ group.category.title }}</h3>
                      <span class="system-config-group__count">{{ group.fields.length }}</span>
                      <span class="system-config-group__chevron">
                        <AppIcon name="CaretDown" :size="14" />
                      </span>
                    </span>
                    <span v-if="group.category.description" class="system-config-group__desc">
                      {{ group.category.description }}
                    </span>
                  </summary>
                  <div class="system-config-group__body">
                    <SystemConfigField
                      v-for="field in group.fields"
                      :key="field.path"
                      :field="field"
                      :model-value="displayValue(field)"
                      :disabled="!snapshot.provider.writable"
                      :error="fieldError(field.path)"
                      @update:model-value="handleFieldUpdate(field, $event)"
                      @clear="handleFieldClear(field)"
                    />
                  </div>
                </details>
              </div>
            </section>

            <form class="system-config-savebar" data-config-save-form @submit.prevent="handleSave">
              <div class="system-config-savebar__row">
                <label class="system-config-password" for="system-config-password">
                  <span class="system-config-password__label">当前密码</span>
                  <input
                    id="system-config-password"
                    v-model="password"
                    class="system-config-field__input"
                    data-config-password
                    type="password"
                    autocomplete="current-password"
                    placeholder="保存前验证当前账户密码"
                    :disabled="saving || !snapshot.provider.writable"
                  />
                </label>
                <div class="system-config-savebar__actions">
                  <button
                    class="system-config-button system-config-button--primary"
                    type="submit"
                    data-config-save
                    :disabled="!canSave"
                  >
                    {{ saving ? '保存中…' : `保存配置${dirtyCount > 0 ? `（${dirtyCount}）` : ''}` }}
                  </button>
                  <button
                    class="system-config-button"
                    type="button"
                    data-config-cancel
                    @click="emit('close')"
                  >
                    取消
                  </button>
                </div>
              </div>
              <p class="system-config-hint">只提交本次修改的字段；密钥留空表示不修改。</p>

              <div
                v-if="revisionConflict"
                class="system-config-conflict"
                data-config-conflict
                role="alert"
              >
                <span>
                  {{ revisionConflict.message || '配置版本已被其他会话更新，请重新加载后再试。' }}
                </span>
                <button
                  class="system-config-button"
                  type="button"
                  data-config-reload
                  @click="handleReload"
                >
                  重新加载
                </button>
              </div>

              <p
                v-if="error"
                class="system-config-message system-config-message--error"
                data-config-error
                role="alert"
              >
                {{ error.message }}
              </p>

              <p
                v-if="formError"
                class="system-config-message system-config-message--error"
                data-config-form-error
                role="alert"
              >
                {{ formError }}
              </p>

              <div v-if="result" class="system-config-result" data-config-result>
                <p class="system-config-result__summary">
                  已写入 {{ result.changed.length }} 个字段；热应用
                  {{ result.applied.length }} 个分组，失败 {{ failedEntries.length }} 组，降级
                  {{ result.degraded.length }} 项。
                </p>
                <ul v-if="failedEntries.length > 0" class="system-config-result__failed">
                  <li v-for="[path, message] in failedEntries" :key="path">
                    {{ path }}：{{ message }}
                  </li>
                </ul>
                <p v-if="result.degraded.length > 0" class="system-config-result__degraded">
                  降级：{{ result.degraded.join('、') }}
                </p>
                <p class="system-config-result__revision">配置版本 {{ result.revision }}</p>
              </div>
            </form>
          </template>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import SystemConfigField from './SystemConfigField.vue'
import { useSystemConfig } from '@/composables/useSystemConfig'
import type {
  ConfigCategory,
  ConfigField,
  SaveConfigResult,
} from '@/api/system'
import './system-config.css'

const props = withDefaults(
  defineProps<{
    open: boolean
  }>(),
  {
    open: false,
  },
)

const emit = defineEmits<{
  close: []
}>()

const { snapshot, schema, saving, error, revisionConflict, save, reload } = useSystemConfig()

// ==================== Local editor state ====================

const overlayRef = ref<HTMLElement | null>(null)
const search = ref('')
const advancedOpen = ref(false)
const overrides = ref<Record<string, unknown>>({})
const clearedKeys = ref<string[]>([])
const password = ref('')
const formError = ref('')
const result = ref<SaveConfigResult | null>(null)

function resetLocal(): void {
  search.value = ''
  advancedOpen.value = false
  overrides.value = {}
  clearedKeys.value = []
  password.value = ''
  formError.value = ''
  result.value = null
}

watch(
  () => props.open,
  async (open) => {
    if (!open) return
    resetLocal()
    await nextTick()
    overlayRef.value?.querySelector<HTMLElement>('[data-config-search]')?.focus()
  },
)

// ==================== Path helpers ====================

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readPath(source: Record<string, unknown>, path: string): unknown {
  if (Object.prototype.hasOwnProperty.call(source, path)) return source[path]
  let current: unknown = source
  for (const segment of path.split('.')) {
    if (!isRecord(current)) return undefined
    current = current[segment]
  }
  return current
}

function originalValue(field: ConfigField): unknown {
  const value = readPath(snapshot.value?.config ?? {}, field.path)
  return value === undefined ? field.default : value
}

function valuesEqual(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right)
  } catch {
    return false
  }
}

function displayValue(field: ConfigField): unknown {
  if (clearedKeys.value.includes(field.path)) return ''
  if (Object.prototype.hasOwnProperty.call(overrides.value, field.path)) {
    return overrides.value[field.path]
  }
  return originalValue(field)
}

function handleFieldUpdate(field: ConfigField, value: unknown): void {
  const next = { ...overrides.value }
  if (valuesEqual(value, originalValue(field))) {
    delete next[field.path]
  } else {
    next[field.path] = value
  }
  overrides.value = next
  clearedKeys.value = clearedKeys.value.filter((path) => path !== field.path)
  formError.value = ''
}

function handleFieldClear(field: ConfigField): void {
  const next = { ...overrides.value }
  delete next[field.path]
  overrides.value = next
  if (!clearedKeys.value.includes(field.path)) {
    clearedKeys.value = [...clearedKeys.value, field.path]
  }
  formError.value = ''
}

const dirtyCount = computed(
  () => Object.keys(overrides.value).length + clearedKeys.value.length,
)

// ==================== Schema grouping ====================

interface FieldGroup {
  category: ConfigCategory
  fields: ConfigField[]
}

const categoryMap = computed(
  () => new Map((schema.value?.categories ?? []).map((category) => [category.id, category])),
)

const categoryOrder = computed(
  () =>
    new Map((schema.value?.categories ?? []).map((category, index) => [category.id, index])),
)

const searchActive = computed(() => search.value.trim().length > 0)

const visibleFields = computed<ConfigField[]>(() => {
  const fields = schema.value?.fields ?? []
  const query = search.value.trim().toLowerCase()
  return fields.filter((field) => {
    if (field.apply_strategy === 'none' || field.deprecated) return false
    if (!query) return true
    return [field.path, field.title, field.help].join(' ').toLowerCase().includes(query)
  })
})

const coreFields = computed(() => visibleFields.value.filter((field) => field.core))
const advancedFields = computed(() => visibleFields.value.filter((field) => !field.core))
const advancedFieldCount = computed(() => advancedFields.value.length)
const advancedVisible = computed(() => advancedOpen.value || searchActive.value)
const visibleCount = computed(() => visibleFields.value.length)

function groupByCategory(fields: ConfigField[]): FieldGroup[] {
  const groups = new Map<string, ConfigField[]>()
  for (const field of fields) {
    const list = groups.get(field.category) ?? []
    list.push(field)
    groups.set(field.category, list)
  }
  return Array.from(groups.entries())
    .map(([id, list]) => ({
      category: categoryMap.value.get(id) ?? {
        id,
        title: id,
        description: '',
        advanced: false,
      },
      fields: list,
    }))
    .sort(
      (left, right) =>
        (categoryOrder.value.get(left.category.id) ?? Number.MAX_SAFE_INTEGER) -
        (categoryOrder.value.get(right.category.id) ?? Number.MAX_SAFE_INTEGER),
    )
}

const coreGroups = computed(() => groupByCategory(coreFields.value))
const advancedGroups = computed(() => groupByCategory(advancedFields.value))

// ==================== Errors and results ====================

const snapshotFailedEntries = computed<Array<[string, string]>>(() =>
  Object.entries(snapshot.value?.apply_failures ?? {}),
)

const failedEntries = computed<Array<[string, string]>>(() =>
  Object.entries(result.value?.failed ?? {}),
)

function fieldError(path: string): string {
  const found = error.value?.errors.find((item) => item.path === path)
  return found?.message ?? ''
}

const canSave = computed(
  () => snapshot.value?.provider.writable === true && !saving.value,
)

// ==================== Actions ====================

async function handleSave(): Promise<void> {
  if (saving.value) return

  formError.value = ''
  result.value = null

  const current = snapshot.value
  if (!current) {
    formError.value = '配置尚未加载，无法保存。'
    return
  }
  if (!current.provider.writable) {
    formError.value = '当前载体只读，无法保存配置。'
    return
  }
  if (!password.value.trim()) {
    formError.value = '请输入当前密码'
    return
  }

  const changes = { ...overrides.value }
  const clearKeys = [...clearedKeys.value]
  if (Object.keys(changes).length === 0 && clearKeys.length === 0) {
    formError.value = '没有需要保存的修改。'
    return
  }

  const saved = await save({
    currentPassword: password.value,
    changes,
    clearKeys,
  })
  if (!saved) return

  result.value = saved
  password.value = ''
  overrides.value = {}
  clearedKeys.value = []
}

async function handleReload(): Promise<void> {
  formError.value = ''
  result.value = null
  overrides.value = {}
  clearedKeys.value = []
  password.value = ''
  await reload()
}

// ==================== Keyboard handling ====================

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

function trapFocus(event: KeyboardEvent): void {
  const root = overlayRef.value
  if (!root) return

  const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
  if (items.length === 0) return

  const first = items[0]
  const last = items[items.length - 1]
  const active = document.activeElement

  if (event.shiftKey) {
    if (active === first || !root.contains(active)) {
      event.preventDefault()
      last.focus()
    }
    return
  }
  if (active === last || !root.contains(active)) {
    event.preventDefault()
    first.focus()
  }
}

function handleDocumentKeydown(event: KeyboardEvent): void {
  if (!props.open) return
  if (event.key === 'Escape') {
    event.preventDefault()
    emit('close')
    return
  }
  if (event.key === 'Tab') trapFocus(event)
}

onMounted(() => {
  document.addEventListener('keydown', handleDocumentKeydown)
})

onBeforeUnmount(() => {
  document.removeEventListener('keydown', handleDocumentKeydown)
})
</script>
