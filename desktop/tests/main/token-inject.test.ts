// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  SPA_TOKEN_REFRESH_EVENT,
  buildTokenInjectionScript,
} from '../../src/main/shell/token-inject'

describe('buildTokenInjectionScript', () => {
  it('writes the SPA localStorage token and dispatches the refresh event', () => {
    const script = buildTokenInjectionScript('backend-token')

    expect(script).toContain("window.localStorage.setItem('mobile_token', token)")
    expect(script).toContain(
      `window.dispatchEvent(new CustomEvent('${SPA_TOKEN_REFRESH_EVENT}', { detail: token }))`,
    )
  })

  it('embeds hostile token characters through JSON.stringify', () => {
    const token = `a'b"c\\d\ne`

    const script = buildTokenInjectionScript(token)

    expect(script).toContain(`const token = ${JSON.stringify(token)}`)
  })
})
