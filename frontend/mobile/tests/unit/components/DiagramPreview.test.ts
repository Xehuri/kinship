/// <reference types="vitest/globals" />

import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import DiagramPreview from '@/components/chat/DiagramPreview.vue'

describe('DiagramPreview', () => {
  describe('circuitjs 模式', () => {
    it('渲染 iframe 且 src 含 circuitjs.html + ctz=', async () => {
      const wrapper = mount(DiagramPreview, {
        props: { type: 'circuitjs', circuitCtz: 'abc' },
      })
      // 源码内 iframe 通过 window.setTimeout(..., 500) 延迟挂载 (给 GWT 初始化时间), 需等待其出现
      await vi.waitFor(() => {
        expect(wrapper.find('.diagram-circuit-frame').exists()).toBe(true)
      })
      const iframe = wrapper.find('.diagram-circuit-frame')
      const src = iframe.attributes('src') || ''
      expect(src).toContain('/circuitjs1/circuitjs.html')
      expect(src).toContain('ctz=abc')
      wrapper.unmount()
    })

    it('不渲染 SVG 内容容器', () => {
      const wrapper = mount(DiagramPreview, {
        props: { type: 'circuitjs', circuitCtz: 'abc' },
      })
      expect(wrapper.find('.diagram-content').exists()).toBe(false)
      expect(wrapper.find('.diagram-svg-wrap').exists()).toBe(false)
    })

    it('无下载按钮', () => {
      const wrapper = mount(DiagramPreview, {
        props: { type: 'circuitjs', circuitCtz: 'abc' },
      })
      expect(wrapper.find('.diagram-btn[title="下载 PNG"]').exists()).toBe(false)
    })

    it('无缩放百分比徽章', () => {
      const wrapper = mount(DiagramPreview, {
        props: { type: 'circuitjs', circuitCtz: 'abc' },
      })
      expect(wrapper.find('.diagram-zoom-badge').exists()).toBe(false)
    })

    it('仍保留关闭按钮', () => {
      const wrapper = mount(DiagramPreview, {
        props: { type: 'circuitjs', circuitCtz: 'abc' },
      })
      expect(wrapper.find('.diagram-close-btn').exists()).toBe(true)
    })
  })

  describe('svg 模式', () => {
    it('仍渲染 svg 内容', () => {
      const wrapper = mount(DiagramPreview, {
        props: { type: 'svg', svg: '<svg viewBox="0 0 10 10"></svg>' },
      })
      expect(wrapper.find('.diagram-content').exists()).toBe(true)
      expect(wrapper.find('.diagram-svg-wrap svg').exists()).toBe(true)
    })

    it('保留下载按钮', () => {
      const wrapper = mount(DiagramPreview, {
        props: { type: 'svg', svg: '<svg viewBox="0 0 10 10"></svg>' },
      })
      expect(wrapper.find('.diagram-btn[title="下载 PNG"]').exists()).toBe(true)
    })

    it('不渲染 circuitjs iframe', () => {
      const wrapper = mount(DiagramPreview, {
        props: { type: 'svg', svg: '<svg viewBox="0 0 10 10"></svg>' },
      })
      expect(wrapper.find('.diagram-circuit-frame').exists()).toBe(false)
    })
  })

  describe('默认 (无 type, 兼容旧调用)', () => {
    it('按 svg 模式渲染', () => {
      const wrapper = mount(DiagramPreview, {
        props: { svg: '<svg viewBox="0 0 10 10"></svg>' },
      })
      expect(wrapper.find('.diagram-content').exists()).toBe(true)
      expect(wrapper.find('.diagram-svg-wrap svg').exists()).toBe(true)
    })
  })
})
