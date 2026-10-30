/**
 * Responsive layout composable - detects PC/mobile viewport
 */
import { ref, onMounted, onUnmounted } from 'vue'

export function useLayout() {
  const isPC = ref(window.innerWidth >= 768)
  const isMobile = ref(window.innerWidth < 768)

  function updateLayout() {
    isPC.value = window.innerWidth >= 768
    isMobile.value = window.innerWidth < 768
  }

  onMounted(() => {
    window.addEventListener('resize', updateLayout)
    updateLayout() // recalculate on mount
  })

  onUnmounted(() => {
    window.removeEventListener('resize', updateLayout)
  })

  return { isPC, isMobile }
}
