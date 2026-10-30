// @vitest-environment jsdom
/// <reference types="vitest/globals" />

import { describe, it, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'

// mock mermaid (happy-dom 下依赖链太重, 手动渲染慢)
vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({ svg: '<svg></svg>' }),
  },
}))

// mock DiagramPreview: 简化断言 props
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

import MarkdownContent from '@/components/chat/MarkdownContent.vue'

const CIRCUIT_CONTENT = '```circuitjs\n$ 1 5.0E-6 10 50 5.0 50\nr 1 2 1000\ng 2\n```'
const CIRCUIT_CONTENT_2 = '```circuitjs\n$ 1 5.0E-6 10 50 5.0 50\nr 1 2 2000\ng 2\n```'

async function mountWithCircuit(content: string = CIRCUIT_CONTENT) {
  const wrapper = mount(MarkdownContent, { props: { content } })
  await nextTick()
  // 源码内 CircuitJS iframe 通过 window.setTimeout(..., 500) 延迟挂载, 需等待其出现
  await vi.waitFor(() => {
    expect(wrapper.find('.circuitjs-block iframe').exists()).toBe(true)
  })
  return wrapper
}

describe('MarkdownContent - CircuitJS', () => {
  it('渲染 circuitjs 块时挂载内嵌 iframe (查看模式参数)', async () => {
    const wrapper = await mountWithCircuit()
    const block = wrapper.find('.circuitjs-block')
    expect(block.exists()).toBe(true)
    const iframe = wrapper.find('.circuitjs-block iframe')
    expect(iframe.exists()).toBe(true)
    const src = iframe.attributes('src') || ''
    expect(src).toContain('/circuitjs1/circuitjs.html')
    expect(src).toContain('hideMenu=true&hideSidebar=true&editable=false&ctz=')
  })

  it('挂载右上角放大按钮', async () => {
    const wrapper = await mountWithCircuit()
    expect(wrapper.find('.circuitjs-expand-btn').exists()).toBe(true)
  })

  it('点击放大按钮后打开电路仿真全屏预览 (type=circuitjs)', async () => {
    const wrapper = await mountWithCircuit()
    await wrapper.find('.circuitjs-expand-btn').trigger('click')
    await nextTick()
    const preview = wrapper.findComponent({ name: 'MockDiagramPreview' })
    expect(preview.exists()).toBe(true)
    expect(preview.props('type')).toBe('circuitjs')
    expect(preview.props('circuitCtz')).toBeTruthy()
  })

  it('点击仿真器 iframe 本身不打开全屏 (仅放大按钮触发)', async () => {
    const wrapper = await mountWithCircuit()
    // iframe 内部点击不会冒泡到父文档, 事件委托只应响应 .circuitjs-expand-btn
    await wrapper.find('.circuitjs-block iframe').trigger('click')
    await nextTick()
    expect(wrapper.findComponent({ name: 'MockDiagramPreview' }).exists()).toBe(false)
  })

  it('点击 SVG 图块仍打开 svg 预览', async () => {
    const wrapper = mount(MarkdownContent, {
      props: { content: '```svg\n<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="3" /></svg>\n```' },
    })
    await flushPromises()
    await nextTick()
    const svgEl = wrapper.find('.svg-diagram svg')
    await svgEl.trigger('click')
    await nextTick()
    const preview = wrapper.findComponent({ name: 'MockDiagramPreview' })
    expect(preview.exists()).toBe(true)
    expect(preview.props('type')).toBe('svg')
  })

  it('已挂载块在 data-ctz 变化时更新 iframe src', async () => {
    const wrapper = await mountWithCircuit(CIRCUIT_CONTENT)
    const src1 = wrapper.find('.circuitjs-block iframe').attributes('src') || ''
    await wrapper.setProps({ content: CIRCUIT_CONTENT_2 })
    // 内容变化后 v-html 重建 DOM, 新的 circuitjs 块再次延迟 500ms 挂载
    await vi.waitFor(() => {
      const src2 = wrapper.find('.circuitjs-block iframe').attributes('src') || ''
      expect(src2).not.toBe(src1)
    })
    // 且只挂载了一个 iframe (未重复创建)
    expect(wrapper.findAll('.circuitjs-block iframe').length).toBe(1)
  })
})
