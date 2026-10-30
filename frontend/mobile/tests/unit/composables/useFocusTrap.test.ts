import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { useFocusTrap, type FocusTrapApi } from '@/composables/useFocusTrap'

const disposers: Array<() => void> = []

afterEach(() => {
  while (disposers.length > 0) {
    disposers.pop()?.()
  }
})

function mountTrap(onEscape: () => void = () => {}): FocusTrapApi {
  let trap: FocusTrapApi | null = null

  const Harness = defineComponent({
    setup() {
      const container = ref<HTMLElement | null>(null)
      trap = useFocusTrap(container, { onEscape })

      return () =>
        h('div', { ref: container, tabindex: -1, class: 'trap-root' }, [
          h('button', { id: 'first', type: 'button' }, 'first'),
          h('button', { id: 'last', type: 'button' }, 'last'),
        ])
    },
  })

  const wrapper = mount(Harness, { attachTo: document.body })

  if (!trap) {
    throw new Error('focus trap was not created')
  }

  const api: FocusTrapApi = trap
  disposers.push(() => {
    api.deactivate()
    wrapper.unmount()
  })

  return api
}

function focusButton(id: string): void {
  const button = document.getElementById(id)
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`missing button #${id}`)
  }
  button.focus()
}

function press(key: string, shiftKey = false): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }))
}

describe('useFocusTrap', () => {
  it('activate focuses the first focusable element', () => {
    const trap = mountTrap()

    trap.activate()

    expect(document.activeElement).toBe(document.getElementById('first'))
  })

  it('wraps Tab from the last element to the first', () => {
    const trap = mountTrap()
    trap.activate()
    focusButton('last')

    press('Tab')

    expect(document.activeElement).toBe(document.getElementById('first'))
  })

  it('wraps Shift+Tab from the first element to the last', () => {
    const trap = mountTrap()
    trap.activate()
    focusButton('first')

    press('Tab', true)

    expect(document.activeElement).toBe(document.getElementById('last'))
  })

  it('calls onEscape when Escape is pressed', () => {
    const onEscape = vi.fn()
    const trap = mountTrap(onEscape)
    trap.activate()

    press('Escape')

    expect(onEscape).toHaveBeenCalledTimes(1)
  })

  it('deactivate restores focus to the opener', () => {
    const opener = document.createElement('button')
    opener.type = 'button'
    document.body.appendChild(opener)
    opener.focus()

    const trap = mountTrap()
    trap.activate()
    expect(document.activeElement).toBe(document.getElementById('first'))

    trap.deactivate()

    expect(document.activeElement).toBe(opener)
    opener.remove()
  })
})
