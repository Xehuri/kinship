// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { X509Certificate } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { CertInfo } from '../../src/shared/types'
import {
  assertCertificateTrustable,
  buildServerTestError,
  classifyCertificate,
  trustPolicyAcceptsLeaf,
} from '../../src/main/ipc/server-tools'

let directory = ''
let leaf: CertInfo

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'axeuh-server-tools-'))
  const keyPath = join(directory, 'key.pem')
  const certPath = join(directory, 'cert.pem')
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
      '2',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ],
    { stdio: ['ignore', 'ignore', 'ignore'] },
  )

  const pem = readFileSync(certPath, 'utf8')
  const certificate = new X509Certificate(pem)
  leaf = {
    host: 'localhost',
    port: 8443,
    subject: certificate.subject,
    issuer: certificate.issuer,
    validFrom: new Date(certificate.validFrom).toISOString(),
    validTo: new Date(certificate.validTo).toISOString(),
    fingerprint256: certificate.fingerprint256.replace(/:/g, '').toLowerCase(),
    selfSigned: certificate.subject === certificate.issuer,
    caPem: pem,
  }
})

afterAll(() => {
  rmSync(directory, { recursive: true, force: true })
})

describe('classifyCertificate', () => {
  it('accepts a self-signed certificate whose SAN matches the host', () => {
    expect(classifyCertificate('localhost', leaf)).toBeNull()
    expect(classifyCertificate('127.0.0.1', leaf)).toBeNull()
  })

  it('rejects a host that is not present in the SAN list', () => {
    expect(classifyCertificate('example.com', leaf)).toEqual({
      code: 'CERT_INVALID',
      message: '证书主机名与服务器地址不匹配',
    })
  })

  it('rejects an expired certificate', () => {
    expect(classifyCertificate('localhost', { ...leaf, validTo: '2000-01-01T00:00:00.000Z' })).toEqual({
      code: 'CERT_INVALID',
      message: '证书已过期或尚未生效',
    })
  })

  it('rejects an unparseable certificate payload', () => {
    expect(classifyCertificate('localhost', { ...leaf, caPem: 'not a pem' })).toEqual({
      code: 'CERT_INVALID',
      message: '无法解析服务器证书',
    })
  })
})

describe('assertCertificateTrustable', () => {
  it('returns null for a valid localhost certificate', () => {
    expect(assertCertificateTrustable('localhost', leaf)).toBeNull()
    expect(assertCertificateTrustable('127.0.0.1', leaf)).toBeNull()
  })

  it('rejects a hostname mismatch', () => {
    expect(assertCertificateTrustable('example.com', leaf)).toEqual({
      code: 'CERT_INVALID',
      message: '证书主机名与服务器地址不匹配',
    })
  })

  it('rejects an expired certificate', () => {
    expect(
      assertCertificateTrustable('localhost', {
        ...leaf,
        validTo: '2000-01-01T00:00:00.000Z',
      }),
    ).toEqual({
      code: 'CERT_INVALID',
      message: '证书已过期或尚未生效',
    })
  })

  it('rejects a certificate that is not yet valid', () => {
    expect(
      assertCertificateTrustable('localhost', {
        ...leaf,
        validFrom: '2999-01-01T00:00:00.000Z',
      }),
    ).toEqual({
      code: 'CERT_INVALID',
      message: '证书已过期或尚未生效',
    })
  })
})

describe('buildServerTestError', () => {
  it('returns the renderer-facing nested failure shape', () => {
    expect(buildServerTestError('CERT_UNTRUSTED', '服务器证书不受系统信任', leaf)).toEqual({
      ok: true,
      data: {
        ok: false,
        error: '服务器证书不受系统信任',
        code: 'CERT_UNTRUSTED',
        cert: leaf,
      },
    })
  })

  it('omits cert when none is supplied', () => {
    expect(buildServerTestError('UNREACHABLE', '无法连接')).toEqual({
      ok: true,
      data: { ok: false, error: '无法连接', code: 'UNREACHABLE' },
    })
  })
})

describe('trustPolicyAcceptsLeaf', () => {
  it('accepts only the pinned host and fingerprint', () => {
    const policy = {
      host: 'localhost',
      allowUntrustedCa: true,
      pin: { host: 'localhost', fingerprint256: leaf.fingerprint256 },
    }
    expect(trustPolicyAcceptsLeaf(policy, 'localhost', leaf)).toBe(true)
    expect(trustPolicyAcceptsLeaf({ ...policy, allowUntrustedCa: false }, 'localhost', leaf)).toBe(
      false,
    )
    expect(trustPolicyAcceptsLeaf(policy, '127.0.0.1', leaf)).toBe(false)
    expect(
      trustPolicyAcceptsLeaf(
        { ...policy, pin: { host: 'localhost', fingerprint256: 'cd'.repeat(32) } },
        'localhost',
        leaf,
      ),
    ).toBe(false)
  })
})
