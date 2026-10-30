/// <reference types="vitest/globals" />

import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import WsLogDrawer from '@/components/notifications/WsLogDrawer.vue'
import { resetWsLog, useWsLog } from '@/composables/useWsLog'

function mountDrawer() {
  return mount(WsLogDrawer, {
    global: { stubs: { teleport: true } },
  })
}

describe('WsLogDrawer', () => {
  beforeEach(() => {
    resetWsLog()
    document.documentElement.classList.remove('ws-log-scroll-lock')
  })

  it('renders nothing until opened from the shared state', async () => {
    const wrapper = mountDrawer()

    expect(wrapper.find('[data-testid="ws-log-drawer"]').exists()).toBe(false)

    useWsLog().open()
    await nextTick()

    expect(wrapper.find('[data-testid="ws-log-drawer"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('暂无日志')

    wrapper.unmount()
  })

  it('renders captured websocket entries', async () => {
    const { handler, open } = useWsLog()
    handler('first message')
    handler({ type: 'ping' })
    open()

    const wrapper = mountDrawer()
    await nextTick()

    const items = wrapper.findAll('.ws-log-drawer__item')
    expect(items).toHaveLength(2)
    expect(items[0].text()).toContain('first message')
    expect(items[1].text()).toContain('{"type":"ping"}')

    wrapper.unmount()
  })

  it('closes via the close button and Escape', async () => {
    const log = useWsLog()
    log.open()
    const wrapper = mountDrawer()
    await nextTick()

    await wrapper.get('[aria-label="关闭 WS 日志"]').trigger('click')
    await nextTick()
    expect(log.visible.value).toBe(false)
    expect(wrapper.find('[data-testid="ws-log-drawer"]').exists()).toBe(false)

    log.open()
    await nextTick()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await nextTick()
    expect(log.visible.value).toBe(false)

    wrapper.unmount()
  })

  it('clears entries and disables the clear button when empty', async () => {
    const { handler, open } = useWsLog()
    handler('to be cleared')
    open()

    const wrapper = mountDrawer()
    await nextTick()

    const clearButton = wrapper.get('button.ws-log-drawer__action')
    expect(clearButton.attributes('disabled')).toBeUndefined()
    await clearButton.trigger('click')
    await nextTick()

    expect(wrapper.text()).toContain('暂无日志')
    expect(wrapper.get('button.ws-log-drawer__action').attributes('disabled')).toBeDefined()

    wrapper.unmount()
  })

  it('locks background scroll while open and releases it on unmount', async () => {
    useWsLog().open()
    const wrapper = mountDrawer()
    await nextTick()

    expect(document.documentElement.classList.contains('ws-log-scroll-lock')).toBe(true)

    wrapper.unmount()
    expect(document.documentElement.classList.contains('ws-log-scroll-lock')).toBe(false)
  })
})
