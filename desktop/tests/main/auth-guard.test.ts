// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import {
  installAuthFailureGuard,
  isSameOriginUnauthorized,
} from '../../src/main/shell/auth-guard'

describe('isSameOriginUnauthorized', () => {
  it('matches only 401 responses on the active origin', () => {
    expect(
      isSameOriginUnauthorized('https://home.example/api/state', 'https://home.example', 401),
    ).toBe(true)
    expect(
      isSameOriginUnauthorized('https://home.example/api/state', 'https://home.example', 403),
    ).toBe(false)
    expect(
      isSameOriginUnauthorized('https://evil.example/api/state', 'https://home.example', 401),
    ).toBe(false)
    expect(isSameOriginUnauthorized('https://home.example.evil/x', 'https://home.example', 401)).toBe(
      false,
    )
    expect(isSameOriginUnauthorized('https://home.example/api', null, 401)).toBe(false)
  })
})

describe('installAuthFailureGuard', () => {
  it('invokes the handler for same-origin 401 responses only', async () => {
    let listener:
      | ((details: { url: string; statusCode: number }) => void)
      | undefined
    const session = {
      webRequest: {
        onCompleted: vi.fn((_filter: unknown, handler: typeof listener) => {
          listener = handler
        }),
      },
    }
    const onUnauthorized = vi.fn()

    installAuthFailureGuard(session, {
      getOrigin: () => 'https://home.example',
      onUnauthorized,
    })

    expect(session.webRequest.onCompleted).toHaveBeenCalledTimes(1)
    listener?.({ url: 'https://home.example/api/state', statusCode: 401 })
    expect(onUnauthorized).toHaveBeenCalledWith('https://home.example/api/state')

    listener?.({ url: 'https://home.example/api/state', statusCode: 200 })
    listener?.({ url: 'https://other.example/api/state', statusCode: 401 })
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
  })
})
