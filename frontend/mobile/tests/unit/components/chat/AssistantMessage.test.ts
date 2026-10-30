import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import AssistantMessage from '@/components/chat/AssistantMessage.vue'
import MarkdownContent from '@/components/chat/MarkdownContent.vue'

function setClipboard(value: unknown): void {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value,
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  setClipboard(undefined)
})

describe('AssistantMessage', () => {
  it('renders assistant prose through production MarkdownContent', () => {
    const wrapper = mount(AssistantMessage, { props: { text: '**今天**状态平稳。' } })
    const prose = wrapper.get('[data-testid="assistant-prose"]')
    const markdown = wrapper.findComponent(MarkdownContent)

    expect(prose.exists()).toBe(true)
    expect(markdown.exists()).toBe(true)
    expect(markdown.props('content')).toBe('**今天**状态平稳。')
    expect(markdown.props('streaming')).toBe(false)
  })

  it('passes live streaming through to MarkdownContent', () => {
    const wrapper = mount(AssistantMessage, { props: { text: '正在生成', live: true } })

    expect(wrapper.findComponent(MarkdownContent).props('streaming')).toBe(true)
  })

  it('renders nothing for an empty non-live reply', () => {
    const empty = mount(AssistantMessage, { props: { text: '   ' } })
    expect(empty.find('[data-testid="assistant-message"]').exists()).toBe(false)
    expect(empty.find('[data-testid="assistant-empty"]').exists()).toBe(false)

    const live = mount(AssistantMessage, { props: { text: '', live: true } })
    expect(live.find('[data-testid="assistant-empty"]').exists()).toBe(false)
    expect(live.find('[data-testid="assistant-prose"]').exists()).toBe(false)
  })

  it('copies the reply when a clipboard is available', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    setClipboard({ writeText })
    const wrapper = mount(AssistantMessage, { props: { text: '复制这段回复' } })

    await wrapper.get('[data-testid="assistant-copy"]').trigger('click')
    await Promise.resolve()

    expect(writeText).toHaveBeenCalledWith('复制这段回复')
    expect(wrapper.get('[data-testid="assistant-copy"]').text()).toContain('已复制')
    wrapper.unmount()
  })

  it('omits the copy action without a clipboard', () => {
    setClipboard(undefined)
    const wrapper = mount(AssistantMessage, { props: { text: '没有复制按钮' } })

    expect(wrapper.find('[data-testid="assistant-copy"]').exists()).toBe(false)
  })
})
