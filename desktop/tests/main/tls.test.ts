// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createServer, type Server } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  TlsError,
  fetchCertificateChain,
  installCertificateVerifyProc,
  isAuthorityInvalid,
  isCertificateTimeValid,
  isIpAddress,
  normalizeFingerprint,
  shouldAcceptCertificate,
  writeCaBundle,
  type CertificateChainResult,
  type TrustDecisionInput,
  type TrustPolicy,
} from '../../src/main/lib/tls'

const PIN_FINGERPRINT = 'ab'.repeat(32)
const TRUSTED_PIN: NonNullable<TrustPolicy['pin']> = {
  host: 'localhost',
  fingerprint256: PIN_FINGERPRINT,
}
const TRUSTED_POLICY: TrustPolicy = {
  host: 'localhost',
  allowUntrustedCa: true,
  pin: TRUSTED_PIN,
}

let server: Server | null = null
let workDir = ''
let certPath = ''
let keyPath = ''
let port = 0
let chainResult: CertificateChainResult

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'axeuh-desktop-tls-'))
  keyPath = join(workDir, 'key.pem')
  certPath = join(workDir, 'cert.pem')

  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ],
    { stdio: 'ignore' },
  )

  const httpsServer = createServer(
    { key: readFileSync(keyPath), cert: readFileSync(certPath) },
    (_request, response) => {
      response.end('ok')
    },
  )
  server = httpsServer

  await new Promise<void>((resolve, reject) => {
    httpsServer.once('error', reject)
    httpsServer.listen(0, resolve)
  })

  const address = httpsServer.address()
  if (address === null || typeof address === 'string') {
    throw new Error('HTTPS 测试服务器未监听 TCP 端口')
  }
  port = address.port
  chainResult = await fetchCertificateChain({ host: 'localhost', port })
})

afterAll(async () => {
  if (server !== null) {
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      })
    })
  }
  if (workDir.length > 0) rmSync(workDir, { recursive: true, force: true })
})

function captureError(run: () => void): unknown {
  try {
    run()
  } catch (error) {
    return error
  }
  throw new Error('预期函数抛出错误')
}

function input(overrides: Partial<TrustDecisionInput> = {}): TrustDecisionInput {
  return {
    hostname: 'localhost',
    errorCode: -202,
    certificate: { fingerprint256: PIN_FINGERPRINT },
    ...overrides,
  }
}

describe('fetchCertificateChain', () => {
  it('returns the leaf first and exposes the full chain as PEM', () => {
    expect(chainResult.chain.length).toBeGreaterThan(0)
    expect(chainResult.chain[0].selfSigned).toBe(true)
    expect(chainResult.chain[0].subject).toContain('CN=localhost')
    expect(chainResult.leaf.subject).toContain('CN=localhost')
    expect(chainResult.chainPem).toContain('-----BEGIN CERTIFICATE-----')
    expect(chainResult.leaf.caPem).toBe(chainResult.chainPem)
    expect(chainResult.leaf.host).toBe('localhost')
    expect(chainResult.leaf.port).toBe(port)
  })

  it('matches the openssl SHA-256 fingerprint', () => {
    const output = execFileSync(
      'openssl',
      ['x509', '-in', certPath, '-noout', '-fingerprint', '-sha256'],
      { encoding: 'utf8' },
    )
    const expected = normalizeFingerprint(output.slice(output.indexOf('=') + 1))

    expect(expected).toHaveLength(64)
    expect(chainResult.leaf.fingerprint256).toBe(expected)
    expect(chainResult.chain[0].fingerprint256).toBe(expected)
  })
})

describe('normalizeFingerprint', () => {
  it('lowercases hex and strips separators', () => {
    const formatted = 'AB:CD'.repeat(16)
    expect(normalizeFingerprint(formatted)).toBe('abcd'.repeat(16))
    expect(normalizeFingerprint('AB CD '.repeat(16))).toBe('abcd'.repeat(16))
  })

  it('decodes the sha256/base64 form Electron exposes', () => {
    expect(
      normalizeFingerprint('sha256/tVQqUMABJF8FghDs/ABRVsod6x5dWno16b+DVr+IjmY='),
    ).toBe('b5542a50c001245f058210ecfc005156ca1deb1e5d5a7a35e9bf8356bf888e66')
  })

  it('returns an empty string for invalid input', () => {
    expect(normalizeFingerprint('')).toBe('')
    expect(normalizeFingerprint('zz'.repeat(32))).toBe('')
    expect(normalizeFingerprint('ab'.repeat(31))).toBe('')
    expect(normalizeFingerprint('ab'.repeat(33))).toBe('')
  })
})

describe('isAuthorityInvalid', () => {
  it.each([
    { name: 'error code -202', errorCode: -202, verificationResult: undefined, expected: true },
    {
      name: 'ERR_CERT_AUTHORITY_INVALID',
      errorCode: -3,
      verificationResult: 'ERR_CERT_AUTHORITY_INVALID',
      expected: true,
    },
    {
      name: 'hostname mismatch',
      errorCode: -200,
      verificationResult: 'ERR_CERT_COMMON_NAME_INVALID',
      expected: false,
    },
    {
      name: 'expired certificate',
      errorCode: -201,
      verificationResult: 'ERR_CERT_DATE_INVALID',
      expected: false,
    },
    {
      name: 'revoked certificate',
      errorCode: -203,
      verificationResult: 'ERR_CERT_REVOKED',
      expected: false,
    },
    { name: 'other failure', errorCode: -3, verificationResult: 'ERR_FAILED', expected: false },
    { name: 'valid certificate', errorCode: 0, verificationResult: 'OK', expected: false },
  ])('returns $expected for $name', ({ errorCode, verificationResult, expected }) => {
    expect(isAuthorityInvalid(errorCode, verificationResult)).toBe(expected)
  })
})

describe('isIpAddress', () => {
  it.each([
    ['127.0.0.1', true],
    ['::1', true],
    ['[::1]', true],
    ['localhost', false],
    ['example.com', false],
    ['256.0.0.1', false],
  ])('%s -> %s', (host, expected) => {
    expect(isIpAddress(host)).toBe(expected)
  })
})

describe('isCertificateTimeValid', () => {
  const NOW = 1_700_000_000

  it.each([
    { name: 'unknown bounds', validStart: undefined, validExpiry: undefined, now: NOW, expected: true },
    { name: 'now inside the window', validStart: NOW - 60, validExpiry: NOW + 60, now: NOW, expected: true },
    { name: 'now exactly at the start', validStart: NOW, validExpiry: NOW + 60, now: NOW, expected: true },
    { name: 'now exactly at the expiry', validStart: NOW - 60, validExpiry: NOW, now: NOW, expected: true },
    { name: 'now before the start', validStart: NOW + 1, validExpiry: NOW + 60, now: NOW, expected: false },
    { name: 'now after the expiry', validStart: NOW - 60, validExpiry: NOW - 1, now: NOW, expected: false },
    { name: 'only the start is known and passed', validStart: NOW - 60, validExpiry: undefined, now: NOW, expected: true },
    { name: 'only the expiry is known and passed', validStart: undefined, validExpiry: NOW - 1, now: NOW, expected: false },
    { name: 'non-finite start', validStart: Number.NaN, validExpiry: NOW + 60, now: NOW, expected: false },
    { name: 'non-finite expiry', validStart: NOW - 60, validExpiry: Number.POSITIVE_INFINITY, now: NOW, expected: false },
    { name: 'non-finite now', validStart: NOW - 60, validExpiry: NOW + 60, now: Number.NaN, expected: false },
  ])('returns $expected for $name', ({ validStart, validExpiry, now, expected }) => {
    expect(isCertificateTimeValid(validStart, validExpiry, now)).toBe(expected)
  })
})

describe('shouldAcceptCertificate', () => {
  it('defers for another hostname', () => {
    expect(shouldAcceptCertificate(input({ hostname: 'other.example' }), TRUSTED_POLICY)).toBe(
      'defer',
    )
  })

  it('defers for a valid certificate', () => {
    expect(shouldAcceptCertificate(input({ errorCode: 0 }), TRUSTED_POLICY)).toBe('defer')
  })

  it('accepts any certificate error for the active host in insecure mode', () => {
    const policy: TrustPolicy = { host: 'localhost', allowUntrustedCa: false, insecure: true }
    expect(
      shouldAcceptCertificate(
        input({ errorCode: -200, verificationResult: 'ERR_CERT_COMMON_NAME_INVALID' }),
        policy,
      ),
    ).toBe('accept')
    expect(
      shouldAcceptCertificate(input({ errorCode: -202 }), policy),
    ).toBe('accept')
  })

  it('never accepts insecure mode for a non-active origin', () => {
    const policy: TrustPolicy = { host: 'localhost', allowUntrustedCa: false, insecure: true }
    expect(shouldAcceptCertificate(input({ hostname: 'other.example' }), policy)).toBe('defer')
    expect(
      shouldAcceptCertificate(
        input({ hostname: 'other.example', errorCode: -202 }),
        policy,
      ),
    ).toBe('defer')
  })

  it('keeps insecure mode scoped to certificate errors on a literal IPv6 host', () => {
    const policy: TrustPolicy = { host: 'fd00::1', allowUntrustedCa: false, insecure: true }
    expect(
      shouldAcceptCertificate(input({ hostname: '[fd00::1]', errorCode: -202 }), policy),
    ).toBe('accept')
    expect(
      shouldAcceptCertificate(input({ hostname: '[fd00::2]', errorCode: -202 }), policy),
    ).toBe('defer')
  })

  it('defers when the user has not allowed untrusted CAs', () => {
    const policy: TrustPolicy = { host: 'localhost', allowUntrustedCa: false, pin: TRUSTED_PIN }
    expect(shouldAcceptCertificate(input(), policy)).toBe('defer')
  })

  it('defers for an untrusted CA before the user pins a certificate', () => {
    const policy: TrustPolicy = { host: 'localhost', allowUntrustedCa: true }
    expect(shouldAcceptCertificate(input(), policy)).toBe('defer')
  })

  it('accepts a pinned authority-invalid certificate for the exact host', () => {
    expect(shouldAcceptCertificate(input(), TRUSTED_POLICY)).toBe('accept')
  })

  it('accepts when authority-invalid is reported through verificationResult', () => {
    const decision = shouldAcceptCertificate(
      input({ errorCode: -3, verificationResult: 'ERR_CERT_AUTHORITY_INVALID' }),
      TRUSTED_POLICY,
    )
    expect(decision).toBe('accept')
  })

  it('rejects a hostname mismatch even with a matching pin', () => {
    const decision = shouldAcceptCertificate(
      input({ errorCode: -200, verificationResult: 'ERR_CERT_COMMON_NAME_INVALID' }),
      TRUSTED_POLICY,
    )
    expect(decision).toBe('reject')
  })

  it('rejects an expired certificate even with a matching pin', () => {
    const decision = shouldAcceptCertificate(
      input({ errorCode: -201, verificationResult: 'ERR_CERT_DATE_INVALID' }),
      TRUSTED_POLICY,
    )
    expect(decision).toBe('reject')
  })

  it('rejects a fingerprint mismatch', () => {
    const decision = shouldAcceptCertificate(
      input({ certificate: { fingerprint256: 'cd'.repeat(32) } }),
      TRUSTED_POLICY,
    )
    expect(decision).toBe('reject')
  })

  it('rejects a pinned certificate outside its validity window', () => {
    const nowSeconds = Math.floor(Date.now() / 1000)
    const decision = shouldAcceptCertificate(
      input({
        certificate: {
          fingerprint256: PIN_FINGERPRINT,
          validStart: nowSeconds - 7200,
          validExpiry: nowSeconds - 3600,
        },
      }),
      TRUSTED_POLICY,
    )
    expect(decision).toBe('reject')
  })

  it('rejects a pinned certificate that is not yet valid', () => {
    const nowSeconds = Math.floor(Date.now() / 1000)
    const decision = shouldAcceptCertificate(
      input({
        certificate: {
          fingerprint256: PIN_FINGERPRINT,
          validStart: nowSeconds + 3600,
          validExpiry: nowSeconds + 7200,
        },
      }),
      TRUSTED_POLICY,
    )
    expect(decision).toBe('reject')
  })

  it('rejects a pinned certificate with non-finite validity bounds', () => {
    const decision = shouldAcceptCertificate(
      input({
        certificate: {
          fingerprint256: PIN_FINGERPRINT,
          validStart: Number.NaN,
          validExpiry: Number.NaN,
        },
      }),
      TRUSTED_POLICY,
    )
    expect(decision).toBe('reject')
  })

  it('accepts a pinned certificate inside its validity window', () => {
    const nowSeconds = Math.floor(Date.now() / 1000)
    const decision = shouldAcceptCertificate(
      input({
        certificate: {
          fingerprint256: PIN_FINGERPRINT,
          validStart: nowSeconds - 3600,
          validExpiry: nowSeconds + 3600,
        },
      }),
      TRUSTED_POLICY,
    )
    expect(decision).toBe('accept')
  })

  it('rejects when the pin is for another host', () => {
    const policy: TrustPolicy = {
      host: 'localhost',
      allowUntrustedCa: true,
      pin: { host: 'other.example', fingerprint256: PIN_FINGERPRINT },
    }
    expect(shouldAcceptCertificate(input(), policy)).toBe('reject')
  })
})

describe('writeCaBundle', () => {
  let caDir = ''

  beforeAll(() => {
    caDir = mkdtempSync(join(tmpdir(), 'axeuh-desktop-ca-'))
  })

  afterAll(() => {
    if (caDir.length > 0) rmSync(caDir, { recursive: true, force: true })
  })

  it('writes PEM with mode 0600 and a trailing newline', () => {
    const target = join(caDir, 'nested', 'server-ca.pem')
    writeCaBundle(target, chainResult.chainPem)

    const content = readFileSync(target, 'utf8')
    expect(content).toContain('-----BEGIN CERTIFICATE-----')
    expect(content.endsWith('\n')).toBe(true)
    expect(statSync(target).mode & 0o777).toBe(0o600)
  })

  it('rejects non-PEM input', () => {
    const error = captureError(() => writeCaBundle(join(caDir, 'invalid.pem'), 'not a certificate'))

    expect(error).toBeInstanceOf(TlsError)
    expect(error).toMatchObject({ code: 'INVALID_CA_BUNDLE' })
  })

  it('rejects a bundle that contains more than certificates', () => {
    const privateKey = readFileSync(keyPath, 'utf8')
    const error = captureError(() => writeCaBundle(join(caDir, 'private.pem'), privateKey))

    expect(error).toBeInstanceOf(TlsError)
    expect(error).toMatchObject({ code: 'INVALID_CA_BUNDLE' })
  })
})

interface FakeVerifyRequest {
  hostname: string
  errorCode: number
  verificationResult: string
  certificate: {
    fingerprint256?: string
    fingerprint?: string
    validStart?: number
    validExpiry?: number
  }
}

type VerifyProc = (
  request: Electron.Request,
  callback: (verificationResult: number) => void,
) => void

function createCapturingSession(): {
  session: Pick<Electron.Session, 'setCertificateVerifyProc'>
  run: (request: FakeVerifyRequest, callback: (verificationResult: number) => void) => void
} {
  let captured: VerifyProc | null = null
  const session: Pick<Electron.Session, 'setCertificateVerifyProc'> = {
    setCertificateVerifyProc(proc): void {
      captured = proc
    },
  }

  return {
    session,
    run(request, callback): void {
      if (captured === null) throw new Error('证书校验回调未安装')
      captured(request as Electron.Request, callback)
    },
  }
}

function verifyRequest(
  errorCode: number,
  fingerprint256 = PIN_FINGERPRINT,
  verificationResult = errorCode === 0 ? 'OK' : 'ERR_CERT_AUTHORITY_INVALID',
): FakeVerifyRequest {
  return {
    hostname: 'localhost',
    errorCode,
    verificationResult,
    certificate: { fingerprint256 },
  }
}

describe('installCertificateVerifyProc', () => {
  it('accepts the pinned authority-invalid certificate', () => {
    const fake = createCapturingSession()
    installCertificateVerifyProc(fake.session, () => TRUSTED_POLICY)

    let result: number | undefined
    fake.run(verifyRequest(-202), (value) => {
      result = value
    })

    expect(result).toBe(0)
  })

  it('accepts the SHA-256 field Electron actually exposes', () => {
    const fake = createCapturingSession()
    installCertificateVerifyProc(fake.session, () => TRUSTED_POLICY)

    let result: number | undefined
    fake.run(
      {
        hostname: 'localhost',
        errorCode: -202,
        verificationResult: 'ERR_CERT_AUTHORITY_INVALID',
        certificate: { fingerprint: PIN_FINGERPRINT.toUpperCase() },
      },
      (value) => {
        result = value
      },
    )

    expect(result).toBe(0)
  })

  it('rejects a certificate for another error class', () => {
    const fake = createCapturingSession()
    installCertificateVerifyProc(fake.session, () => TRUSTED_POLICY)

    let result: number | undefined
    fake.run(
      verifyRequest(-200, PIN_FINGERPRINT, 'ERR_CERT_COMMON_NAME_INVALID'),
      (value) => {
        result = value
      },
    )

    expect(result).toBe(-2)
  })

  it('rejects a pinned certificate whose validity window has expired', () => {
    const fake = createCapturingSession()
    installCertificateVerifyProc(fake.session, () => TRUSTED_POLICY)
    const nowSeconds = Math.floor(Date.now() / 1000)

    let result: number | undefined
    fake.run(
      {
        ...verifyRequest(-202),
        certificate: {
          fingerprint256: PIN_FINGERPRINT,
          validStart: nowSeconds - 7200,
          validExpiry: nowSeconds - 3600,
        },
      },
      (value) => {
        result = value
      },
    )

    expect(result).toBe(-2)
  })

  it('defers to Chromium when no pin is configured', () => {
    const fake = createCapturingSession()
    installCertificateVerifyProc(fake.session, () => ({
      host: 'localhost',
      allowUntrustedCa: true,
    }))

    let result: number | undefined
    fake.run(verifyRequest(-202), (value) => {
      result = value
    })

    expect(result).toBe(-3)
  })
})
