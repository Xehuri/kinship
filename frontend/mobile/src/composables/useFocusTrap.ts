import { nextTick, type Ref } from 'vue'

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'summary',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

export interface FocusTrapOptions {
  onEscape?: () => void
}

export interface FocusTrapApi {
  activate: () => void
  deactivate: () => void
}

/**
 * Focus containment for dialogs and sheets.
 * Tab cycles within the container; Escape is forwarded to the caller.
 * Deactivation always returns focus to the element that opened the dialog.
 */
export function useFocusTrap(container: Ref<HTMLElement | null>, options: FocusTrapOptions = {}): FocusTrapApi {
  let active = false
  let previouslyFocused: HTMLElement | null = null

  const getFocusable = (): HTMLElement[] => {
    const root = container.value
    if (!root) {
      return []
    }
    return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
      (element) => element.getAttribute('aria-hidden') !== 'true',
    )
  }

  const onKeydown = (event: KeyboardEvent) => {
    if (!active) {
      return
    }

    if (event.key === 'Escape') {
      options.onEscape?.()
      return
    }

    if (event.key !== 'Tab') {
      return
    }

    const root = container.value
    const focusable = getFocusable()

    if (!root) {
      return
    }

    if (focusable.length === 0) {
      event.preventDefault()
      root.focus()
      return
    }

    const first = focusable[0]
    const last = focusable[focusable.length - 1]

    if (!first || !last) {
      return
    }

    const current = document.activeElement

    if (event.shiftKey) {
      if (current === first || !(current instanceof Node) || !root.contains(current)) {
        event.preventDefault()
        last.focus()
      }
      return
    }

    if (current === last || !(current instanceof Node) || !root.contains(current)) {
      event.preventDefault()
      first.focus()
    }
  }

  const focusInitial = () => {
    const [first] = getFocusable()
    if (first) {
      first.focus()
    } else {
      container.value?.focus()
    }
  }

  const activate = () => {
    if (active) {
      return
    }

    active = true
    previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    document.addEventListener('keydown', onKeydown, true)

    if (container.value) {
      focusInitial()
    } else {
      void nextTick(focusInitial)
    }
  }

  const deactivate = () => {
    if (!active) {
      return
    }

    active = false
    document.removeEventListener('keydown', onKeydown, true)

    if (previouslyFocused?.isConnected) {
      previouslyFocused.focus()
    }
    previouslyFocused = null
  }

  return { activate, deactivate }
}
