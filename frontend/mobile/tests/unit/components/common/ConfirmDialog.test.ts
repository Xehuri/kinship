import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'

const mounted: Array<ReturnType<typeof mount>> = []

function mountDialog(props: Record<string, unknown> = {}) {
  const wrapper = mount(ConfirmDialog, {
    attachTo: document.body,
    props: {
      visible: true,
      title: '压缩会话',
      message: '确认压缩当前会话？压缩后模型侧上下文会合并为摘要，原始历史仍完整保留。',
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
})

describe('ConfirmDialog', () => {
  it('renders an alertdialog with the title and message while visible', async () => {
    const wrapper = mountDialog()
    await flushPromises()

    const dialog = wrapper.get('[data-testid="confirm-dialog"]')
    expect(dialog.attributes('role')).toBe('alertdialog')
    expect(dialog.attributes('aria-modal')).toBe('true')
    expect(dialog.attributes('aria-labelledby')).toBeTruthy()
    expect(dialog.attributes('aria-describedby')).toBeTruthy()
    expect(wrapper.get('.ax-confirm__title').text()).toBe('压缩会话')
    expect(wrapper.get('.ax-confirm__message').text()).toContain('原始历史仍完整保留')
    expect(wrapper.get('[data-testid="confirm-dialog-cancel"]').text()).toBe('取消')
    expect(wrapper.get('[data-testid="confirm-dialog-confirm"]').text()).toBe('确认')
  })

  it('emits confirm and cancel from the buttons', async () => {
    const wrapper = mountDialog()
    await flushPromises()

    await wrapper.get('[data-testid="confirm-dialog-confirm"]').trigger('click')
    await wrapper.get('[data-testid="confirm-dialog-cancel"]').trigger('click')

    expect(wrapper.emitted('confirm')).toHaveLength(1)
    expect(wrapper.emitted('cancel')).toHaveLength(1)
  })

  it('cancels on Escape', async () => {
    const wrapper = mountDialog()
    await flushPromises()

    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    )

    expect(wrapper.emitted('cancel')).toHaveLength(1)
  })

  it('cancels on a backdrop click but not on a panel click', async () => {
    const wrapper = mountDialog()
    await flushPromises()

    await wrapper.get('[data-testid="confirm-dialog"]').trigger('click')
    expect(wrapper.emitted('cancel')).toBeUndefined()

    await wrapper.get('.ax-confirm').trigger('click')
    expect(wrapper.emitted('cancel')).toHaveLength(1)
  })

  it('is not rendered when not visible', () => {
    const wrapper = mountDialog({ visible: false })

    expect(wrapper.find('[data-testid="confirm-dialog"]').exists()).toBe(false)
  })

  it('focuses the cancel button on open and returns focus on close', async () => {
    const opener = document.createElement('button')
    opener.type = 'button'
    opener.textContent = 'open'
    document.body.appendChild(opener)
    opener.focus()

    const wrapper = mountDialog({ visible: false })
    await wrapper.setProps({ visible: true })
    await nextTick()
    await flushPromises()

    expect(document.activeElement).toBe(
      wrapper.get('[data-testid="confirm-dialog-cancel"]').element,
    )

    await wrapper.setProps({ visible: false })
    expect(document.activeElement).toBe(opener)

    opener.remove()
  })
})
