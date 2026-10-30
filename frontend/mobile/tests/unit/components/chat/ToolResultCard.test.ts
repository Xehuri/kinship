import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import ToolResultCard from '@/components/chat/ToolResultCard.vue'
import { makeResult, makeTool } from './chatFixtures'

describe('ToolResultCard variants', () => {
  it('renders a terminal IN/OUT card with a shell prefix', () => {
    const wrapper = mount(ToolResultCard, {
      props: {
        step: makeTool('bash', {
          arguments: { command: 'npm run test' },
          result: makeResult('全部通过'),
        }),
      },
    })
    const card = wrapper.get('[data-testid="tool-result-card"]')

    expect(card.attributes('data-card-kind')).toBe('terminal')
    expect(wrapper.get('[data-testid="tool-args"]').text()).toBe('$ {"command":"npm run test"}')
    expect(card.text()).toContain('全部通过')
  })

  it('adds the terminal prompt exactly once', () => {
    const wrapper = mount(ToolResultCard, {
      props: {
        step: makeTool('bash', {
          arguments: '$ echo hello',
          result: makeResult('hello'),
        }),
      },
    })

    expect(wrapper.get('[data-testid="tool-args"]').text()).toBe('$ echo hello')
  })

  it('renders the full formatted arguments instead of a short summary', () => {
    const argumentsValue = {
      filePath: '/demo/health.json',
      offset: 120,
      limit: 200,
      note: 'n'.repeat(400),
    }
    const wrapper = mount(ToolResultCard, {
      props: {
        step: makeTool('read', {
          arguments: argumentsValue,
          result: makeResult('结果正文'),
        }),
      },
    })

    expect(wrapper.get('[data-testid="tool-args"]').text()).toBe(
      JSON.stringify(argumentsValue),
    )
  })

  it('redacts secrets in the full argument view', () => {
    const wrapper = mount(ToolResultCard, {
      props: {
        step: makeTool('read', {
          arguments: { path: '/demo/health.json', token: 'super-secret-token' },
          result: makeResult('结果正文'),
        }),
      },
    })
    const args = wrapper.get('[data-testid="tool-args"]').text()

    expect(args).toContain('[redacted]')
    expect(args).not.toContain('super-secret-token')
  })

  it('renders read, search, web and subagent cards', () => {
    const cases = [
      ['read', { path: '/demo/health.json' }, 'read'],
      ['grep', { query: '静息心率' }, 'search'],
      ['web_fetch', { url: 'https://example.com/demo' }, 'web'],
      ['task', { title: '整理文件' }, 'subagent'],
    ] as const

    for (const [name, args, kind] of cases) {
      const wrapper = mount(ToolResultCard, {
        props: {
          step: makeTool(name, {
            arguments: args,
            result: makeResult('结果正文'),
          }),
        },
      })
      const card = wrapper.get('[data-testid="tool-result-card"]')

      expect(card.attributes('data-card-kind')).toBe(kind)
      expect(card.text()).toContain('结果正文')
      wrapper.unmount()
    }
  })

  it('renders a diff card with add, remove, hunk and context lines', () => {
    const wrapper = mount(ToolResultCard, {
      props: {
        step: makeTool('edit', {
          arguments: { path: '/demo/app.ts' },
          result: makeResult('@@ -1,2 +1,2 @@\n-const a = 1\n+const a = 2\n const b = 3'),
        }),
      },
    })

    expect(wrapper.findAll('.tool-result-card__diff-line--add')).toHaveLength(1)
    expect(wrapper.findAll('.tool-result-card__diff-line--remove')).toHaveLength(1)
    expect(wrapper.findAll('.tool-result-card__diff-line--hunk')).toHaveLength(1)
    expect(wrapper.findAll('.tool-result-card__diff-line--context')).toHaveLength(1)
  })

  it('renders an image card without exposing base64 data', () => {
    const base64 = `data:image/png;base64,${'A'.repeat(400)}`
    const wrapper = mount(ToolResultCard, {
      props: {
        step: makeTool('image', {
          arguments: { path: '/demo/shot.png' },
          result: makeResult(base64),
        }),
      },
    })

    expect(wrapper.get('[data-testid="tool-result-card"]').attributes('data-card-kind')).toBe('image')
    expect(wrapper.text()).toContain('图片数据已省略（不渲染 base64）')
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.html()).not.toContain(base64)
  })

  it('uses the generic card for unregistered tools', () => {
    const wrapper = mount(ToolResultCard, {
      props: {
        step: makeTool('unknown_tool', {
          arguments: { status: 'waiting_user' },
          result: makeResult('{"ok":true}'),
        }),
      },
    })

    expect(wrapper.get('[data-testid="tool-result-card"]').attributes('data-card-kind')).toBe('generic')
    expect(wrapper.text()).toContain('{"ok":true}')
  })
})

describe('ToolResultCard tones and safety', () => {
  it('marks error results as danger and stopped results as warning', () => {
    const failed = mount(ToolResultCard, {
      props: {
        step: makeTool('bash', {
          status: 'error',
          result: makeResult('命令失败', { isError: true }),
        }),
      },
    })
    expect(failed.get('[data-testid="tool-result-card"]').attributes('data-tone')).toBe('error')

    const stopped = mount(ToolResultCard, {
      props: {
        step: makeTool('bash', {
          status: 'abandoned',
          result: makeResult(''),
        }),
      },
    })
    expect(stopped.get('[data-testid="tool-result-card"]').attributes('data-tone')).toBe('warning')
  })

  it('renders result text as text, never as HTML', () => {
    const payload = '<img src=x onerror=alert(1)>'
    const wrapper = mount(ToolResultCard, {
      props: {
        step: makeTool('bash', { result: makeResult(payload) }),
      },
    })

    expect(wrapper.text()).toContain(payload)
    expect(wrapper.find('img').exists()).toBe(false)
  })

  it('offers the full-output action only for long or truncated results', async () => {
    const short = mount(ToolResultCard, {
      props: { step: makeTool('bash', { result: makeResult('short') }) },
    })
    expect(short.find('[data-testid="tool-result-card__focus"]').exists()).toBe(false)

    const wrapper = mount(ToolResultCard, {
      props: {
        step: makeTool('bash', {
          result: makeResult('A'.repeat(1500), { totalChars: 1500 }),
        }),
      },
    })
    await wrapper.get('[data-testid="tool-result-card__focus"]').trigger('click')
    expect(wrapper.emitted('open-focus')).toHaveLength(1)
  })
})
