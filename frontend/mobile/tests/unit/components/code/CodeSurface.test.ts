/// <reference types="vitest/globals" />

import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import CodeSurface from '@/components/code/CodeSurface.vue'

describe('CodeSurface', () => {
  it('renders code through text interpolation instead of injecting HTML', () => {
    const raw = '<script>alert("xss")</script>'
    const wrapper = mount(CodeSurface, {
      props: { code: raw, language: 'html', name: 'demo.html' },
    })

    expect(wrapper.find('script').exists()).toBe(false)
    expect(wrapper.find('.code-surface__code').element.innerHTML).toContain('&lt;script&gt;')
    expect(wrapper.find('.code-surface__code').element.textContent).toBe(raw)
  })

  it('does not create elements for markup inside the code', () => {
    const wrapper = mount(CodeSurface, {
      props: { code: '<img src=x onerror=alert(1)>' },
    })

    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.find('.code-surface__code').text()).toBe('<img src=x onerror=alert(1)>')
  })

  it('renders one gutter number per line', () => {
    const wrapper = mount(CodeSurface, {
      props: { code: 'alpha\nbeta' },
    })

    const numbers = wrapper.findAll('.code-surface__ln')
    expect(numbers.map((item) => item.text())).toEqual(['1', '2'])
    expect(wrapper.find('.code-surface__count').text()).toBe('2 行')
  })

  it('hides the gutter when lineNumbers is false', () => {
    const wrapper = mount(CodeSurface, {
      props: { code: 'alpha\nbeta', lineNumbers: false },
    })

    expect(wrapper.find('.code-surface__gutter').exists()).toBe(false)
    expect(wrapper.find('.code-surface__code').text()).toBe('alpha\nbeta')
  })

  it('keeps indentation and tabs exactly', () => {
    const raw = '  indented\n\tTabbed\n'
    const wrapper = mount(CodeSurface, {
      props: { code: raw, lineNumbers: false },
    })

    expect(wrapper.find('.code-surface__code').element.textContent).toBe(raw)
  })

  it('renders an empty state for empty content', () => {
    const wrapper = mount(CodeSurface, { props: { code: '' } })

    expect(wrapper.find('.code-surface__empty').text()).toBe('文件内容为空')
    expect(wrapper.find('.code-surface__pre').exists()).toBe(false)
    expect(wrapper.find('.code-surface__gutter').exists()).toBe(false)
    expect(wrapper.find('.code-surface__count').text()).toBe('0 行')
  })

  it('exposes language and name in the header and data attribute', () => {
    const wrapper = mount(CodeSurface, {
      props: { code: 'print(1)', language: 'Python', name: 'script.py' },
    })

    expect(wrapper.attributes('data-language')).toBe('python')
    expect(wrapper.find('.code-surface__lang').text()).toBe('python')
    expect(wrapper.find('.code-surface__name').text()).toBe('script.py')
  })

  it('falls back to the text language when none is supplied', () => {
    const wrapper = mount(CodeSurface, { props: { code: 'plain' } })

    expect(wrapper.attributes('data-language')).toBe('text')
    expect(wrapper.find('.code-surface__lang').text()).toBe('text')
    expect(wrapper.find('.code-surface__name').exists()).toBe(false)
  })

  it('pretty-prints valid JSON and numbers the formatted lines', () => {
    const wrapper = mount(CodeSurface, {
      props: { code: '{"b":2,"a":1}', language: 'json' },
    })

    expect(wrapper.find('.code-surface__code').text()).toContain('"b": 2')
    expect(wrapper.findAll('.code-surface__ln')).toHaveLength(4)
  })

  it('leaves invalid JSON untouched', () => {
    const wrapper = mount(CodeSurface, {
      props: { code: '{broken', language: 'json' },
    })

    expect(wrapper.find('.code-surface__code').text()).toBe('{broken')
  })
})
