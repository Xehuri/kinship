/// <reference types="vitest/globals" />

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { resetWsLog, useWsLog } from '@/composables/useWsLog'

vi.mock('@/components/settings/DebugPanel.vue', () => ({
  default: { name: 'DebugPanel', template: '<div class="debug-panel-mock" />' },
}))

import SettingsDebug from '@/components/settings/SettingsDebug.vue'

function mountDebug() {
  return mount(SettingsDebug, {
    global: { stubs: { teleport: true } },
  })
}

describe('SettingsDebug', () => {
  beforeEach(() => {
    resetWsLog()
  })

  it('renders a WS log row that opens the shared drawer', async () => {
    const wrapper = mountDebug()
    const row = wrapper.get('[data-setting-row="ws-log"]')

    expect(row.text()).toContain('WS 日志')
    expect(useWsLog().visible.value).toBe(false)

    await row.trigger('click')

    expect(useWsLog().visible.value).toBe(true)
    wrapper.unmount()
  })

  it('keeps the realtime debug row pointing at the WS log row', () => {
    const wrapper = mountDebug()
    const row = wrapper.get('[data-setting-row="realtime-debug"]')

    expect(row.text()).toContain('实时连接调试日志')
    expect(row.text()).toContain('WS 日志')
    wrapper.unmount()
  })

  it('still opens the debug panel overlay', async () => {
    const wrapper = mountDebug()

    expect(wrapper.find('.settings-debug-overlay').exists()).toBe(false)
    await wrapper.get('[data-setting-row="debug-panel"]').trigger('click')

    expect(wrapper.find('.settings-debug-overlay').exists()).toBe(true)
    expect(wrapper.find('.debug-panel-mock').exists()).toBe(true)
    wrapper.unmount()
  })
})
