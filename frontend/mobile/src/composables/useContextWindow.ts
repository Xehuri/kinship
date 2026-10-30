/**
 * 上下文窗口加载器
 *
 * 只有 enabled 为 true 时才请求; 窗口大小只接受有限正整数,
 * 后端返回 null 时保持 null, 绝不按模型名猜测。
 */

import { readonly, ref, watch, type ComputedRef, type Ref } from 'vue'
import { fetchContextWindow } from '@/api/model'

type EnabledRef = Ref<boolean> | ComputedRef<boolean>

function isValidWindow(value: number | null): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value > 0
}

export function useContextWindow(enabled: EnabledRef) {
  const contextWindow = ref<number | null>(null)
  const model = ref<string | null>(null)
  const provider = ref<string | null>(null)
  const loading = ref(false)

  let requestId = 0

  async function refresh(): Promise<void> {
    if (!enabled.value) return

    const id = ++requestId
    loading.value = true
    try {
      const info = await fetchContextWindow()
      if (id !== requestId || !enabled.value) return

      if (!info) {
        contextWindow.value = null
        model.value = null
        provider.value = null
        return
      }

      contextWindow.value = isValidWindow(info.contextWindow) ? info.contextWindow : null
      model.value = info.model
      provider.value = info.provider
    } catch {
      if (id !== requestId) return
      contextWindow.value = null
      model.value = null
      provider.value = null
    } finally {
      if (id === requestId) loading.value = false
    }
  }

  watch(
    enabled,
    (on) => {
      if (on) {
        void refresh()
        return
      }
      requestId += 1
      loading.value = false
    },
    { immediate: true },
  )

  return {
    contextWindow: readonly(contextWindow),
    model: readonly(model),
    provider: readonly(provider),
    loading: readonly(loading),
    refresh,
  }
}
