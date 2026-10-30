/// <reference types="vitest/globals" />

import { describe, expect, it } from 'vitest'
import { currentPhoneAccessUrl, phoneAccessUrl } from '@/components/onboarding/onboardingAccess'

describe('onboardingAccess', () => {
  it('基于当前 origin 生成 /mobile/ 访问地址', () => {
    expect(phoneAccessUrl('https://health.example.com:8443')).toBe(
      'https://health.example.com:8443/mobile/',
    )
  })

  it('去掉 origin 末尾斜杠, 不重复拼接', () => {
    expect(phoneAccessUrl('http://127.0.0.1:18768/')).toBe(
      'http://127.0.0.1:18768/mobile/',
    )
    expect(phoneAccessUrl('http://127.0.0.1:18768///')).toBe(
      'http://127.0.0.1:18768/mobile/',
    )
  })

  it('origin 不可用时退化为相对路径', () => {
    expect(phoneAccessUrl('')).toBe('/mobile/')
    expect(phoneAccessUrl('null')).toBe('/mobile/')
    expect(phoneAccessUrl('   ')).toBe('/mobile/')
  })

  it('currentPhoneAccessUrl 读取 window.location.origin', () => {
    expect(currentPhoneAccessUrl()).toBe(
      `${window.location.origin.replace(/\/+$/, '')}/mobile/`,
    )
  })
})
