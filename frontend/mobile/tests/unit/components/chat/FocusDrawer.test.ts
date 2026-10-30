import { afterEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import FocusDrawer from '@/components/chat/FocusDrawer.vue'

const mounted: Array<ReturnType<typeof mount>> = []

function mountDrawer(props: Record<string, unknown> = {}) {
  const wrapper = mount(FocusDrawer, {
    attachTo: document.body,
    props: {
      visible: true,
      title: 'read 输出',
      content: '第一行\n第二行',
      bytes: 2048,
      truncated: true,
      ...props,
    },
    global: { stubs: { teleport: true } },
  })
  mounted.push(wrapper)
  return wrapper
}

afterEach(() => {
  while (mounted.length > 0) {
    mounted.pop()?.unmount()
  }
  document.documentElement.classList.remove('chat-overlay-lock')
})

describe('FocusDrawer', () => {
  it('renders the title, metadata and full content', () => {
    const wrapper = mountDrawer()

    expect(wrapper.get('.ax-focus__title').text()).toBe('read 输出')
    expect(wrapper.get('.ax-focus__meta').text()).toContain('2.0 KB')
    expect(wrapper.get('.ax-focus__meta').text()).toContain('已截断')
    expect(wrapper.get('.ax-focus__content').text()).toContain('第一行')
    expect(wrapper.get('.ax-focus__content').text()).toContain('第二行')
  })

  it('closes through the close button and the backdrop', async () => {
    const wrapper = mountDrawer()

    await wrapper.get('[aria-label="关闭完整输出"]').trigger('click')
    await wrapper.get('.ax-focus').trigger('click')

    expect(wrapper.emitted('close')).toHaveLength(2)
  })

  it('closes on Escape and releases the scroll lock', async () => {
    const wrapper = mountDrawer()
    expect(document.documentElement.classList.contains('chat-overlay-lock')).toBe(true)

    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    )
    expect(wrapper.emitted('close')).toHaveLength(1)

    await wrapper.setProps({ visible: false })
    expect(document.documentElement.classList.contains('chat-overlay-lock')).toBe(false)
  })

  it('focuses the first control on open and returns focus to the opener on close', async () => {
    const opener = document.createElement('button')
    opener.type = 'button'
    opener.textContent = 'open'
    document.body.appendChild(opener)
    opener.focus()

    const wrapper = mountDrawer({ visible: false })
    await wrapper.setProps({ visible: true })
    await nextTick()

    expect(document.activeElement).toBe(wrapper.get('[aria-label="关闭完整输出"]').element)

    await wrapper.setProps({ visible: false })
    expect(document.activeElement).toBe(opener)

    opener.remove()
  })

  it('shows an empty note when the content is blank', () => {
    const wrapper = mountDrawer({ content: '', bytes: 0, truncated: false })

    expect(wrapper.get('.ax-focus__empty').text()).toBe('没有可显示的正文。')
    expect(wrapper.get('.ax-focus__meta').text()).toBe('完整正文')
  })
})
