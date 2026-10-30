// @vitest-environment jsdom
/// <reference types="vitest/globals" />

/**
 * MarkdownContent 流式渲染 (D4 决策) 单元测试
 *
 * 验证: streaming=true 时走纯文本路径, 完全不调用 renderMarkdown;
 * 流式结束后再一次性解析 Markdown (每个 token 不再触发全量重解析)。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'

// mock mermaid (happy-dom/jsdom 下依赖链太重)
vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({ svg: '<svg></svg>' }),
  },
}))

vi.mock('@/components/chat/DiagramPreview.vue', () => ({
  default: {
    name: 'MockDiagramPreview',
    props: {
      type: { type: String, default: undefined },
      svg: { type: String, default: undefined },
      circuitCtz: { type: String, default: undefined },
    },
    emits: ['close'],
    template: '<div class="diagram-preview-mock" />',
  },
}))

// 用 spy 包裹真实 renderMarkdown, 以断言调用次数
vi.mock('@/utils/markdown', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/markdown')>()
  return { ...actual, renderMarkdown: vi.fn(actual.renderMarkdown) }
})

import MarkdownContent from '@/components/chat/MarkdownContent.vue'
import { renderMarkdown } from '@/utils/markdown'

const renderSpy = vi.mocked(renderMarkdown)

describe('MarkdownContent - 流式纯文本 (D4)', () => {
  beforeEach(() => {
    renderSpy.mockClear()
  })

  it('streaming=true 时不解析 Markdown, 直接渲染纯文本', async () => {
    const wrapper = mount(MarkdownContent, {
      props: { content: '# 标题\n**粗体**', streaming: true },
    })
    await nextTick()
    expect(renderSpy).not.toHaveBeenCalled()
    expect(wrapper.find('.md-content').exists()).toBe(false)
    expect(wrapper.find('.md-plain').text()).toBe('# 标题\n**粗体**')
  })

  it('streaming=false 时解析 Markdown 并渲染为 HTML', async () => {
    const wrapper = mount(MarkdownContent, {
      props: { content: '**粗体**', streaming: false },
    })
    await nextTick()
    expect(renderSpy).toHaveBeenCalledTimes(1)
    expect(wrapper.find('.md-content').exists()).toBe(true)
    expect(wrapper.find('.md-content strong').exists()).toBe(true)
  })

  it('流式结束后只解析一次 Markdown (不逐 token 重解析)', async () => {
    const wrapper = mount(MarkdownContent, {
      props: { content: 'hello', streaming: true },
    })
    await nextTick()
    expect(renderSpy).not.toHaveBeenCalled()

    // 流式结束: 切换为最终内容
    await wrapper.setProps({ content: 'hello world', streaming: false })
    await nextTick()
    expect(renderSpy).toHaveBeenCalledTimes(1)
    expect(wrapper.find('.md-plain').exists()).toBe(false)
    expect(wrapper.find('.md-content').exists()).toBe(true)
  })
})
