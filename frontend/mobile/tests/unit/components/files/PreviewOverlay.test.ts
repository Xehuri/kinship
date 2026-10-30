/// <reference types="vitest/globals" />

import { describe, expect, it, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import PreviewOverlay from '@/components/files/PreviewOverlay.vue'

const stubs = {
  FilePreviewPane: {
    name: 'FilePreviewPane',
    props: ['path', 'name', 'kind'],
    emits: ['close'],
    template: `
      <div class="pane-stub" :data-kind="kind">
        <button class="pane-close" type="button" @click="$emit('close')">close</button>
      </div>
    `,
  },
}

function mountOverlay(visible = true) {
  return mount(PreviewOverlay, {
    props: { visible, path: 'docs/a.md', name: 'a.md', kind: 'md' },
    global: { stubs },
    attachTo: document.body,
  })
}

describe('PreviewOverlay', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('renders the mobile preview drawer with the file-preview testid', () => {
    const wrapper = mountOverlay()

    const drawer = document.querySelector('[data-testid="file-preview"]')
    expect(drawer).not.toBeNull()
    expect(drawer?.getAttribute('role')).toBe('dialog')
    expect(document.querySelector('.pane-stub')?.getAttribute('data-kind')).toBe('md')

    wrapper.unmount()
  })

  it('does not render while hidden', () => {
    const wrapper = mountOverlay(false)

    expect(document.querySelector('[data-testid="file-preview"]')).toBeNull()

    wrapper.unmount()
  })

  it('closes when the pane emits close', async () => {
    const wrapper = mountOverlay()
    const close = document.querySelector<HTMLButtonElement>('.pane-close')
    close?.click()
    await wrapper.vm.$nextTick()

    expect(wrapper.emitted('close')).toHaveLength(1)

    wrapper.unmount()
  })

  it('closes on Escape while visible', async () => {
    const wrapper = mountOverlay()

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await wrapper.vm.$nextTick()

    expect(wrapper.emitted('close')).toHaveLength(1)

    wrapper.unmount()
  })
})
