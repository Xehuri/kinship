/// <reference types="vitest/globals" />

/**
 * api/configDraft 测试
 *
 * 锁定引导页安全连接面板依赖的草稿契约：
 *   - POST /api/config/draft 只写草稿，返回 pending 差异；
 *   - GET /api/config/pending 透传 strategy / requires_restart；
 *   - 403/409/网络错误统一转 result union，界面可展示后端 message；
 *   - 密码只走请求体 / X-Config-Password 头。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const client = vi.hoisted(() => ({
  apiGetVerbose: vi.fn(),
  apiPostVerbose: vi.fn(),
}))

vi.mock('@/api/client', () => ({
  apiGetVerbose: client.apiGetVerbose,
  apiPostVerbose: client.apiPostVerbose,
}))

import { fetchConfigPending, stageConfigDraft } from '@/api/configDraft'

describe('stageConfigDraft', () => {
  beforeEach(() => {
    client.apiPostVerbose.mockReset()
  })

  it('posts changes with the password and returns the staged diff', async () => {
    client.apiPostVerbose.mockResolvedValue({
      status: 200,
      ok: true,
      data: {
        ok: true,
        revision: 'mem-0',
        staged_revision: 'draft-abc',
        changes: {
          'ssl.enabled': { from: false, to: true },
          'ssl.cert': { from: '', to: '/srv/certs/cert.pem' },
          'ssl.key': { from: '', to: '/srv/certs/key.pem' },
        },
        count: 3,
      },
    })

    const result = await stageConfigDraft(
      {
        'ssl.enabled': true,
        'ssl.cert': '/srv/certs/cert.pem',
        'ssl.key': '/srv/certs/key.pem',
      },
      { currentPassword: 'pw-123' },
    )

    expect(client.apiPostVerbose).toHaveBeenCalledWith('/api/config/draft', {
      changes: {
        'ssl.enabled': true,
        'ssl.cert': '/srv/certs/cert.pem',
        'ssl.key': '/srv/certs/key.pem',
      },
      current_password: 'pw-123',
    })
    expect(result).toEqual({
      ok: true,
      count: 3,
      changes: expect.objectContaining({
        'ssl.enabled': { from: false, to: true },
        'ssl.cert': { from: '', to: '/srv/certs/cert.pem' },
        'ssl.key': { from: '', to: '/srv/certs/key.pem' },
      }),
      stagedRevision: 'draft-abc',
    })
  })

  it('maps 403 password failures to a readable forbidden result', async () => {
    client.apiPostVerbose.mockResolvedValue({
      status: 403,
      ok: false,
      data: { code: 'password_required', message: '修改配置需要验证密码' },
    })

    const result = await stageConfigDraft(
      { 'ssl.enabled': true },
      { currentPassword: 'wrong' },
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('forbidden')
    expect(result.code).toBe('password_required')
    expect(result.message).toBe('修改配置需要验证密码')
  })

  it('maps 409 validation failures and keeps schema errors', async () => {
    client.apiPostVerbose.mockResolvedValue({
      status: 409,
      ok: false,
      data: {
        code: 'validation_failed',
        message: '配置草稿校验失败：1 项问题',
        errors: [
          {
            path: 'ssl.cert',
            code: 'cross_field',
            message: 'ssl.cert 指向的文件不存在',
            severity: 'error',
          },
        ],
      },
    })

    const result = await stageConfigDraft({
      'ssl.enabled': true,
      'ssl.cert': '/missing/cert.pem',
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('conflict')
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].path).toBe('ssl.cert')
  })

  it('maps network failures to status 0 without throwing', async () => {
    client.apiPostVerbose.mockResolvedValue({
      status: 0,
      ok: false,
      data: null,
    })

    const result = await stageConfigDraft({ 'ssl.enabled': true })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('network')
    expect(result.status).toBe(0)
    expect(result.message).toBe('写入配置草稿失败')
  })
})

describe('fetchConfigPending', () => {
  beforeEach(() => {
    client.apiGetVerbose.mockReset()
  })

  it('sends the config password header and normalizes the ssl group', async () => {
    client.apiGetVerbose.mockResolvedValue({
      status: 200,
      ok: true,
      data: {
        revision: 'mem-0',
        staged_revision: 'draft-abc',
        changes: [
          {
            path: 'ssl.enabled',
            from: false,
            to: true,
            strategy: 'deployment',
            requires_restart: true,
          },
          {
            path: 'ssl.cert',
            from: '',
            to: '/srv/certs/cert.pem',
            strategy: 'deployment',
            requires_restart: true,
          },
        ],
        count: 2,
      },
    })

    const result = await fetchConfigPending({ currentPassword: 'pw-123' })

    expect(client.apiGetVerbose).toHaveBeenCalledWith(
      '/api/config/pending',
      false,
      { 'X-Config-Password': 'pw-123' },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.pending.stagedRevision).toBe('draft-abc')
    expect(result.pending.changes).toEqual([
      {
        path: 'ssl.enabled',
        from: false,
        to: true,
        strategy: 'deployment',
        requires_restart: true,
      },
      {
        path: 'ssl.cert',
        from: '',
        to: '/srv/certs/cert.pem',
        strategy: 'deployment',
        requires_restart: true,
      },
    ])
  })

  it('rejects malformed payloads instead of pretending an empty draft', async () => {
    client.apiGetVerbose.mockResolvedValue({
      status: 200,
      ok: true,
      data: { revision: 'mem-0' },
    })

    const result = await fetchConfigPending()

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('unavailable')
    expect(result.message).toBe('待应用配置响应格式无效')
  })
})
