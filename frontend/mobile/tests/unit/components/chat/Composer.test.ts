import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import Composer from '@/components/chat/Composer.vue'
import AppIcon from '@/components/common/AppIcon.vue'

const mounted: Array<ReturnType<typeof mount>> = []

function mountComposer() {
  const wrapper = mount(Composer, { attachTo: document.body })
  mounted.push(wrapper)
  return wrapper
}

afterEach(() => {
  while (mounted.length > 0) {
    mounted.pop()?.unmount()
  }
  vi.restoreAllMocks()
})

describe('Composer', () => {
  it('sends on Enter and clears the input', async () => {
    const wrapper = mountComposer()
    const input = wrapper.get('[data-testid="composer-input"]')

    await input.setValue('你好')
    await input.trigger('keydown', { key: 'Enter' })

    expect(wrapper.emitted('send')).toEqual([['你好', []]])
    expect((input.element as HTMLTextAreaElement).value).toBe('')
  })

  it('keeps Shift+Enter as a newline', async () => {
    const wrapper = mountComposer()
    const input = wrapper.get('[data-testid="composer-input"]')

    await input.setValue('第一行')
    await input.trigger('keydown', { key: 'Enter', shiftKey: true })

    expect(wrapper.emitted('send')).toBeUndefined()
  })

  it('does not send while an IME composition is active', async () => {
    const wrapper = mountComposer()
    const input = wrapper.get('[data-testid="composer-input"]')

    await input.setValue('中文输入')
    await input.trigger('keydown', { key: 'Enter', isComposing: true })

    expect(wrapper.emitted('send')).toBeUndefined()
  })

  it('sends with the send button and blocks empty sends', async () => {
    const wrapper = mountComposer()
    const input = wrapper.get('[data-testid="composer-input"]')
    const send = wrapper.get('[data-testid="composer-send"]')

    expect(send.attributes('disabled')).toBeDefined()

    const sendIcon = send.getComponent(AppIcon)
    expect(sendIcon.props('name')).toBe('ArrowUp')
    expect(sendIcon.props('weight')).toBe('bold')
    expect(sendIcon.props('size')).toBe(18)

    await input.setValue('按钮发送')
    expect(send.attributes('disabled')).toBeUndefined()
    await send.trigger('click')

    expect(wrapper.emitted('send')).toEqual([['按钮发送', []]])
  })

  it('adds a pasted image as a file and sends it without text', async () => {
    const createObjectURL = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValue('blob:paste')
    const wrapper = mountComposer()
    const input = wrapper.get('[data-testid="composer-input"]')
    const file = new File(['image-bytes'], 'pasted.png', { type: 'image/png' })

    const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
    Object.defineProperty(event, 'clipboardData', {
      value: {
        items: [
          {
            type: 'image/png',
            getAsFile: () => file,
          },
        ],
      },
    })
    input.element.dispatchEvent(event)
    await flushPromises()

    expect(wrapper.text()).toContain('粘贴图片_')
    expect(createObjectURL).toHaveBeenCalled()

    await wrapper.get('[data-testid="composer-send"]').trigger('click')

    const emitted = wrapper.emitted('send')
    expect(emitted).toHaveLength(1)
    const files = emitted?.[0]?.[1] as File[]
    expect(files).toHaveLength(1)
    expect(files[0]?.name.startsWith('粘贴图片_')).toBe(true)
  })

  it('revokes object URLs when a selected file is removed', async () => {
    const createObjectURL = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValue('blob:file')
    const revokeObjectURL = vi
      .spyOn(URL, 'revokeObjectURL')
      .mockImplementation(() => {})
    const wrapper = mountComposer()
    const fileInput = wrapper.get('input[type="file"]')
    const file = new File(['bytes'], 'photo.png', { type: 'image/png' })

    Object.defineProperty(fileInput.element, 'files', {
      value: [file],
      configurable: true,
    })
    await fileInput.trigger('change')
    await flushPromises()

    expect(wrapper.text()).toContain('photo.png')
    expect(createObjectURL).toHaveBeenCalledWith(file)

    await wrapper.get('.ax-composer__file-remove').trigger('click')

    expect(revokeObjectURL).toHaveBeenCalledWith('blob:file')
    expect(wrapper.text()).not.toContain('photo.png')
  })
})
