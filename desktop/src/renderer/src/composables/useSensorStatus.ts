import { onBeforeUnmount, onMounted, readonly, ref } from 'vue'
import type { SensorStatus } from '../../../shared/types'
import { useDesktopApi } from './useDesktopApi'

export function useSensorStatus() {
  const api = useDesktopApi()
  const status = ref<SensorStatus | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)
  let unsubscribe: (() => void) | null = null
  let disposed = false

  async function refresh(): Promise<void> {
    loading.value = true
    const result = await api.getSensorStatus()
    if (disposed) return
    if (result.ok) {
      status.value = result.data
      error.value = null
    } else {
      error.value = result.error || '无法读取采集端状态'
    }
    loading.value = false
  }

  onMounted(() => {
    void refresh()
    unsubscribe = api.onStatusChanged((next) => {
      status.value = next
      error.value = null
    })
  })

  onBeforeUnmount(() => {
    disposed = true
    unsubscribe?.()
    unsubscribe = null
  })

  return {
    status: readonly(status),
    loading: readonly(loading),
    error: readonly(error),
    refresh,
  }
}
