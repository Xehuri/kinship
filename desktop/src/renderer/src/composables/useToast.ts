import { ref } from 'vue'

export type ToastKind = 'success' | 'error' | 'info' | 'warning'

export interface ToastItem {
  id: number
  kind: ToastKind
  message: string
}

const items = ref<ToastItem[]>([])
const timers = new Map<number, ReturnType<typeof setTimeout>>()
let sequence = 0

function dismiss(id: number): void {
  const timer = timers.get(id)
  if (timer !== undefined) {
    clearTimeout(timer)
    timers.delete(id)
  }
  items.value = items.value.filter((item) => item.id !== id)
}

function clear(): void {
  for (const timer of timers.values()) clearTimeout(timer)
  timers.clear()
  items.value = []
}

function push(message: string, kind: ToastKind = 'info', duration = 4200): number {
  const id = ++sequence
  items.value = [...items.value, { id, kind, message }]
  const timer = setTimeout(() => dismiss(id), duration)
  timers.set(id, timer)
  return id
}

export function useToast() {
  return {
    toasts: items,
    push,
    success: (message: string) => push(message, 'success', 3600),
    error: (message: string) => push(message, 'error', 5200),
    warning: (message: string) => push(message, 'warning', 5200),
    info: (message: string) => push(message, 'info', 4200),
    dismiss,
    clear,
  }
}
