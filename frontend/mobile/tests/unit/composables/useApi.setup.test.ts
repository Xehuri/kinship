/// <reference types="vitest/globals" />

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// 被测模块: 首次初始化 + 凭据修改 API
import {
  useApi,
  getSetupStatus,
  setup,
  changeCredentials,
} from '@/composables/useApi'
// apiPostVerbose 为核心新增 helper, 一并覆盖
import { apiPostVerbose } from '@/api/client'

/** 构造一个最小可用的 fetch Response mock */
function mockResponse(status: number, body: unknown) {
  return {
    status,
    ok: status >= 200 && status < 300,
    // apiGet 会读取 content-type 判断响应类型
    headers: { get: () => 'application/json' },
    json: async () => body,
  }
}

describe('useApi 首次初始化 / 凭据修改', () => {
  beforeEach(() => {
    localStorage.clear()
    // 重置模块级 token 与登录状态
    useApi().logout()
    vi.restoreAllMocks()
  })

  afterEach(() => {
    localStorage.clear()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  // ==================== apiPostVerbose ====================

  describe('apiPostVerbose', () => {
    it('4xx 也解析 JSON 响应体并返回 status/ok/data', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          mockResponse(409, { success: false, message: '系统已初始化' }),
        ),
      )

      const r = await apiPostVerbose('/auth/setup', { username: 'a', password: 'b' })

      expect(r.status).toBe(409)
      expect(r.ok).toBe(false)
      expect(r.data).toEqual({ success: false, message: '系统已初始化' })
    })

    it('网络异常返回 status=0 / ok=false / data=null', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))

      const r = await apiPostVerbose('/auth/setup', {})

      expect(r.status).toBe(0)
      expect(r.ok).toBe(false)
      expect(r.data).toBeNull()
    })
  })

  // ==================== getSetupStatus ====================

  describe('getSetupStatus', () => {
    it('needs_setup=true 返回 true', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(mockResponse(200, { needs_setup: true })),
      )

      expect(await getSetupStatus()).toBe(true)
    })

    it('needs_setup=false 返回 false', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(mockResponse(200, { needs_setup: false })),
      )

      expect(await getSetupStatus()).toBe(false)
    })

    it('请求失败返回 null', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')))

      expect(await getSetupStatus()).toBeNull()
    })

    it('响应结构异常返回 null', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse(200, {})))

      expect(await getSetupStatus()).toBeNull()
    })
  })

  // ==================== setup ====================

  describe('setup', () => {
    it('成功后持久化 token + 凭据 + isLoggedIn', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        mockResponse(200, {
          success: true,
          token: 'setup-token-abc',
          user_id: 'u1',
          display_name: '管理员',
          message: '初始化成功',
        }),
      )
      vi.stubGlobal('fetch', mockFetch)

      const api = useApi()
      const res = await api.setup('admin', 'secret123')

      expect(res?.success).toBe(true)
      expect(res?.token).toBe('setup-token-abc')
      expect(localStorage.getItem('mobile_token')).toBe('setup-token-abc')
      // FE-H1: 不持久化明文密码
      expect(localStorage.getItem('mobile_credentials')).toBeNull()
      expect(api.isLoggedIn.value).toBe(true)
      expect(mockFetch).toHaveBeenCalledWith(
        '/auth/setup',
        expect.objectContaining({ method: 'POST' }),
      )
    })

    it('失败 (409 已初始化) 不持久化任何状态', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          mockResponse(409, { success: false, message: '系统已初始化' }),
        ),
      )

      const api = useApi()
      const res = await api.setup('admin', 'secret123')

      expect(res?.success).toBe(false)
      expect(localStorage.getItem('mobile_token')).toBeNull()
      expect(localStorage.getItem('mobile_credentials')).toBeNull()
      expect(api.isLoggedIn.value).toBe(false)
    })
  })

  // ==================== changeCredentials ====================

  describe('changeCredentials', () => {
    it('成功后返回 success 且不持久化任何密码', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(mockResponse(200, { success: true, message: '已更新' })),
      )

      const res = await changeCredentials('oldpass', 'newuser', 'newpass')

      expect(res.success).toBe(true)
      expect(res.message).toBe('已更新')
      // FE-H1: 不缓存用户名/密码
      expect(localStorage.getItem('mobile_credentials')).toBeNull()
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)!
        expect(localStorage.getItem(key) || '').not.toContain('newpass')
        expect(localStorage.getItem(key) || '').not.toContain('oldpass')
      }
    })

    it('返回新 token 时同步更新 token', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          mockResponse(200, { success: true, token: 'rotated-token', message: '已更新' }),
        ),
      )

      const res = await changeCredentials('oldpass', 'newuser', 'newpass')

      expect(res.token).toBe('rotated-token')
      expect(localStorage.getItem('mobile_token')).toBe('rotated-token')
    })

    it('仅改用户名时也不写入密码', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(mockResponse(200, { success: true, message: '已更新' })),
      )

      await changeCredentials('oldpass', 'renamed')

      expect(localStorage.getItem('mobile_credentials')).toBeNull()
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)!
        expect(localStorage.getItem(key) || '').not.toContain('oldpass')
      }
    })

    it('失败时返回后端 message 且不写入密码', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          mockResponse(400, { success: false, message: '旧密码错误' }),
        ),
      )

      const res = await changeCredentials('wrong', 'newuser', 'newpass')

      expect(res.success).toBe(false)
      expect(res.message).toBe('旧密码错误')
      expect(localStorage.getItem('mobile_credentials')).toBeNull()
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)!
        expect(localStorage.getItem(key) || '').not.toContain('newpass')
      }
    })
  })
})
