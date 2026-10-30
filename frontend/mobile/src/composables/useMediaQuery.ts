import { getCurrentScope, onScopeDispose, ref, type Ref } from 'vue'

/**
 * Reactive matchMedia wrapper. The listener is removed when the owning
 * component or effect scope is disposed. Outside a scope the ref simply
 * stops updating; callers that need manual teardown should close the scope.
 */
export function useMediaQuery(query: string): Ref<boolean> {
  const matches = ref(false)

  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return matches
  }

  const media = window.matchMedia(query)
  matches.value = media.matches

  const onChange = (event: MediaQueryListEvent) => {
    matches.value = event.matches
  }

  if (typeof media.addEventListener === 'function') {
    media.addEventListener('change', onChange)
  } else {
    media.addListener(onChange)
  }

  const dispose = () => {
    if (typeof media.removeEventListener === 'function') {
      media.removeEventListener('change', onChange)
    } else {
      media.removeListener(onChange)
    }
  }

  if (getCurrentScope()) {
    onScopeDispose(dispose)
  }

  return matches
}
