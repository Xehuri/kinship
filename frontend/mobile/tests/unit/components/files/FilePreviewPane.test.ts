/// <reference types="vitest/globals" />

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { FilePreviewKind } from '@/types/files'

const mockApi = vi.hoisted(() => ({
  fetchFileContentVerbose: vi.fn(),
  getFileRawUrl: vi.fn(),
}))

vi.mock('@/api/files', () => ({
  fetchFileContentVerbose: mockApi.fetchFileContentVerbose,
  getFileRawUrl: mockApi.getFileRawUrl,
}))

import FilePreviewPane from '@/components/files/FilePreviewPane.vue'

const stubs = {
  ImagePreview: {
    name: 'ImagePreview',
    props: ['src', 'alt'],
    template: '<div class="image-stub" />',
  },
  AudioPreview: {
    name: 'AudioPreview',
    props: ['path'],
    template: '<div class="audio-stub" />',
  },
  MarkdownContent: {
    name: 'MarkdownContent',
    props: ['content'],
    template: '<div class="markdown-stub" />',
  },
  CodeSurface: {
    name: 'CodeSurface',
    props: ['code', 'language', 'name'],
    template: '<div class="code-surface-stub" />',
  },
}

function mountPane(kind: FilePreviewKind, name: string, path = `docs/${name}`) {
  return mount(FilePreviewPane, {
    props: { kind, name, path },
    global: { stubs },
  })
}

function okContent(content: string | object) {
  return { status: 200, ok: true, data: content }
}

describe('FilePreviewPane', () => {
  beforeEach(() => {
    mockApi.fetchFileContentVerbose.mockReset()
    mockApi.getFileRawUrl.mockReset()
  })

  it('renders raw markdown through MarkdownContent and loads only its own path', async () => {
    mockApi.fetchFileContentVerbose.mockResolvedValue(okContent('# 标题\n\n正文'))

    const wrapper = mountPane('md', 'readme.md')
    await flushPromises()

    expect(mockApi.fetchFileContentVerbose).toHaveBeenCalledWith('docs/readme.md')
    const markdown = wrapper.findComponent({ name: 'MarkdownContent' })
    expect(markdown.exists()).toBe(true)
    expect(markdown.props('content')).toBe('# 标题\n\n正文')
  })

  it('dispatches code files to CodeSurface with a language id', async () => {
    mockApi.fetchFileContentVerbose.mockResolvedValue(okContent('print("hi")'))

    const wrapper = mountPane('code', 'script.py')
    await flushPromises()

    const code = wrapper.findComponent({ name: 'CodeSurface' })
    expect(code.exists()).toBe(true)
    expect(code.props('language')).toBe('python')
    expect(code.props('code')).toBe('print("hi")')
    expect(code.props('name')).toBe('script.py')
  })

  it('dispatches plain text files to CodeSurface as text', async () => {
    mockApi.fetchFileContentVerbose.mockResolvedValue(okContent('line one\nline two'))

    const wrapper = mountPane('text', 'notes.txt')
    await flushPromises()

    const code = wrapper.findComponent({ name: 'CodeSurface' })
    expect(code.props('language')).toBe('text')
    expect(code.props('code')).toBe('line one\nline two')
  })

  it('pretty-prints JSON before handing it to CodeSurface', async () => {
    mockApi.fetchFileContentVerbose.mockResolvedValue(
      okContent({ content: '{"b":2,"a":1}' }),
    )

    const wrapper = mountPane('json', 'health.json')
    await flushPromises()

    const code = wrapper.findComponent({ name: 'CodeSurface' })
    expect(code.props('language')).toBe('json')
    expect(code.props('code')).toContain('"b": 2')
    expect(code.props('code')).toContain('\n')
  })

  it('keeps JSONL object lines raw for CodeSurface', async () => {
    mockApi.fetchFileContentVerbose.mockResolvedValue(
      okContent({ objects: [{ t: 1, type: 'voice' }, { t: 2, type: 'screen' }] }),
    )

    const wrapper = mountPane('jsonl', 'perception.jsonl')
    await flushPromises()

    const code = wrapper.findComponent({ name: 'CodeSurface' })
    expect(code.props('code')).toBe('{"t":1,"type":"voice"}\n{"t":2,"type":"screen"}')
  })

  it('dispatches images without requesting file content', async () => {
    const wrapper = mountPane('image', 'photo.png')
    await flushPromises()

    expect(mockApi.fetchFileContentVerbose).not.toHaveBeenCalled()
    const image = wrapper.findComponent({ name: 'ImagePreview' })
    expect(image.exists()).toBe(true)
    expect(image.props('src')).toBe('docs/photo.png')
  })

  it('dispatches audio to the audio preview', async () => {
    const wrapper = mountPane('audio', 'voice.wav')
    await flushPromises()

    expect(mockApi.fetchFileContentVerbose).not.toHaveBeenCalled()
    expect(wrapper.findComponent({ name: 'AudioPreview' }).props('path')).toBe(
      'docs/voice.wav',
    )
  })

  it('shows an unsupported state for unknown file types', async () => {
    const wrapper = mountPane('unsupported', 'archive.zip')
    await flushPromises()

    expect(mockApi.fetchFileContentVerbose).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('无法预览此文件')
  })

  it.each([
    [404, false, '文件不存在（HTTP 404）'],
    [403, false, '无权限读取（HTTP 403）'],
    [401, false, '登录已失效'],
    [500, false, '服务端错误（HTTP 500）'],
    [0, false, '网络连接失败'],
    [200, true, '无法读取文件内容'],
  ] as const)(
    'maps a %s response to a status-specific error',
    async (status, ok, message) => {
      mockApi.fetchFileContentVerbose.mockResolvedValue({
        status,
        ok,
        data: status === 200 ? null : null,
      })

      const wrapper = mountPane('md', 'broken.md')
      await flushPromises()

      expect(wrapper.find('[role="alert"]').exists()).toBe(true)
      expect(wrapper.text()).toContain(message)
    },
  )

  it('shows a 200 response with unreadable payload as a generic error', async () => {
    mockApi.fetchFileContentVerbose.mockResolvedValue(okContent({}))

    const wrapper = mountPane('md', 'broken.md')
    await flushPromises()

    expect(wrapper.text()).toContain('无法读取文件内容')
  })

  it('retries the content request after a failure', async () => {
    mockApi.fetchFileContentVerbose
      .mockResolvedValueOnce({ status: 404, ok: false, data: null })
      .mockResolvedValueOnce(okContent('# 恢复'))

    const wrapper = mountPane('md', 'broken.md')
    await flushPromises()

    expect(wrapper.text()).toContain('文件不存在（HTTP 404）')
    expect(mockApi.fetchFileContentVerbose).toHaveBeenCalledTimes(1)

    await wrapper.find('.ax-state__action').trigger('click')
    await flushPromises()

    expect(mockApi.fetchFileContentVerbose).toHaveBeenCalledTimes(2)
    expect(wrapper.findComponent({ name: 'MarkdownContent' }).props('content')).toContain(
      '恢复',
    )
  })

  it('emits close from the header action', async () => {
    mockApi.fetchFileContentVerbose.mockResolvedValue(okContent('text'))

    const wrapper = mountPane('text', 'a.txt')
    await flushPromises()

    await wrapper.find('[aria-label="关闭预览"]').trigger('click')

    expect(wrapper.emitted('close')).toHaveLength(1)
  })
})
