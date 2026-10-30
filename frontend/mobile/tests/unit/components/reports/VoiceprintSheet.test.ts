/// <reference types="vitest/globals" />

import { afterEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import VoiceprintSheet from '@/components/reports/VoiceprintSheet.vue'

function sheetElement(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('[data-testid="voiceprint-sheet"]')
}

describe('VoiceprintSheet', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    document.body.style.overflow = ''
  })

  it('renders nothing until it becomes visible', async () => {
    const wrapper = mount(VoiceprintSheet, {
      props: { visible: false },
      slots: { default: '<p data-testid="sheet-slot">声纹列表</p>' },
    })
    await nextTick()

    expect(sheetElement()).toBeNull()

    wrapper.unmount()
  })

  it('renders the slot inside an accessible dialog when visible', async () => {
    const wrapper = mount(VoiceprintSheet, {
      props: { visible: false },
      slots: { default: '<p data-testid="sheet-slot">声纹列表</p>' },
    })

    await wrapper.setProps({ visible: true })
    await nextTick()

    const sheet = sheetElement()
    expect(sheet).not.toBeNull()
    expect(sheet!.querySelector('[role="dialog"]')?.getAttribute('aria-modal')).toBe('true')
    expect(sheet!.querySelector('[data-testid="sheet-slot"]')?.textContent).toBe('声纹列表')

    wrapper.unmount()
  })

  it('closes on the close button and on Escape', async () => {
    const wrapper = mount(VoiceprintSheet, {
      props: { visible: true },
    })
    await nextTick()

    const closeButton = sheetElement()!.querySelector<HTMLButtonElement>('button[aria-label="关闭声纹记录"]')
    expect(closeButton).not.toBeNull()
    closeButton!.click()
    expect(wrapper.emitted('close')).toHaveLength(1)

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(wrapper.emitted('close')).toHaveLength(2)

    wrapper.unmount()
  })

  it('locks and restores body and shell scroll with the sheet visibility', async () => {
    document.body.style.overflow = 'auto'
    const shellBody = document.createElement('div')
    shellBody.className = 'ax-shell__body'
    shellBody.style.overflow = 'auto'
    document.body.appendChild(shellBody)

    const wrapper = mount(VoiceprintSheet, {
      props: { visible: false },
    })
    await nextTick()
    expect(document.body.style.overflow).toBe('auto')
    expect(shellBody.style.overflow).toBe('auto')

    await wrapper.setProps({ visible: true })
    await nextTick()
    expect(document.body.style.overflow).toBe('hidden')
    expect(shellBody.style.overflow).toBe('hidden')

    await wrapper.setProps({ visible: false })
    await nextTick()
    expect(document.body.style.overflow).toBe('auto')
    expect(shellBody.style.overflow).toBe('auto')

    wrapper.unmount()
  })
})
