import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import UserMessage from '@/components/chat/UserMessage.vue'

describe('UserMessage', () => {
  it('renders a right-aligned bubble with pre-wrap text and no QQ marker', () => {
    const wrapper = mount(UserMessage, { props: { text: '第一行\n第二行' } })

    expect(wrapper.classes()).toContain('user-message')
    expect(wrapper.get('.user-message__text').text()).toBe('第一行\n第二行')
    expect(wrapper.find('[data-testid="qq-inbound-badge"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('QQ')
  })

  it('renders attachments only when TurnAttachment entries exist', () => {
    const empty = mount(UserMessage, { props: { text: '没有附件' } })
    expect(empty.findAll('.user-message__attachment')).toHaveLength(0)

    const withFiles = mount(UserMessage, {
      props: {
        text: '带附件',
        attachments: [{ id: 'a1', name: 'health.json', kind: 'file' }],
      },
    })
    const attachment = withFiles.get('.user-message__attachment')
    expect(attachment.text()).toContain('health.json')
    expect(attachment.attributes('data-kind')).toBe('file')
  })

  it('renders only the provided text, never HTML', () => {
    const payload = '<img src=x onerror=alert(1)>'
    const wrapper = mount(UserMessage, { props: { text: payload } })

    expect(wrapper.text()).toContain(payload)
    expect(wrapper.find('img').exists()).toBe(false)
  })
})
