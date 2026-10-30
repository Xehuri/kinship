import { onMounted, readonly, ref } from 'vue'
import type { Bootstrap } from '../../../shared/types'
import { useDesktopApi } from './useDesktopApi'

export function useBootstrap() {
  const api = useDesktopApi()
  const bootstrap = ref<Bootstrap | null>(null)
  const loading = ref(true)
  const error = ref<string | null>(null)
  let requestId = 0

  async function reload(): Promise<void> {
    const current = ++requestId
    loading.value = true
    error.value = null

    const result = await api.getBootstrap()
    if (current !== requestId) return

    if (result.ok) {
      bootstrap.value = result.data
    } else {
      error.value = result.error || '无法读取桌面配置'
    }
    loading.value = false
  }

  onMounted(() => {
    void reload()
  })

  return {
    bootstrap: readonly(bootstrap),
    loading: readonly(loading),
    error: readonly(error),
    reload,
  }
}
